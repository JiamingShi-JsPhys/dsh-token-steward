/**
 * 单模型健康状态机。
 *
 * 纯逻辑：不读时钟（now 由调用方带入）、不碰网络与磁盘、不持有定时器。
 * 冷却按失败次数指数退避，半开只用一次试探，成功即复位。
 *
 * 状态迁移：
 *   active --(连续失败 >= threshold)--> open --(half_open_after_ms)--> half-open
 *     ^                                                                    |
 *     +----------(试探成功)------------------------------------------------+
 *     +--(rate-limit)--> cooling --(resumeAt)--> active
 *   offline 由用户手动置位，不参与自动恢复。
 */
import type { AttemptResult, ErrorKind, HealthState, ModelEntry, ModelHealth } from './types.ts'

/** 一条全零的健康记录。 */
export function createHealth(now: number): ModelHealth {
  return {
    state: 'active',
    consecutiveFailures: 0,
    samples: 0,
    inFlight: 0,
    windowStartedAt: now,
    windowCalls: 0,
  }
}

/** EWMA 的平滑因子：新样本权重。 */
const EWMA_ALPHA = 0.3

/** rpm 滑窗宽度。 */
const RPM_WINDOW_MS = 60_000

/** 指数退避的层数上限，避免冷却时间无限膨胀。 */
const MAX_BACKOFF_EXPONENT = 4

/** 该错误是否应当立刻冷却（而不是累计失败次数）。 */
function isCooldownKind(kind: ErrorKind | undefined): boolean {
  return kind === 'rate-limit'
}

/** 该错误是否应当计入熔断（而不是用户取消或客户端问题）。 */
function isFuseKind(kind: ErrorKind | undefined): boolean {
  return kind === 'timeout' || kind === 'transport' || kind === 'server' || kind === 'empty'
}

/** 冷却时长：base * 2^(failures-1)，封顶 2^4 倍。 */
function cooldownFor(baseMs: number, failures: number): number {
  const exponent = Math.min(Math.max(failures - 1, 0), MAX_BACKOFF_EXPONENT)
  return baseMs * 2 ** exponent
}

/** 把已到期的 cooling / open 推进到当前时刻应有的状态。 */
export function advance(health: ModelHealth, now: number): void {
  if (health.state === 'offline') return
  if (health.resumeAt === undefined) return
  if (now < health.resumeAt) return
  health.resumeAt = undefined
  health.state = health.state === 'cooling' ? 'active' : 'half-open'
}

/** 模型是否可用于一次新请求；open 且未到期、或并发/rpm 满额即不可用。 */
export function isAvailable(model: ModelEntry, health: ModelHealth, now: number): boolean {
  return unavailableReason(model, health, now) === undefined
}

/** 该模型此刻不可用的原因；可用时返回 undefined。 */
export function unavailableReason(model: ModelEntry, health: ModelHealth, now: number): string | undefined {
  advance(health, now)
  if (health.state === 'offline') return 'offline'
  if (health.state === 'open') return 'circuit-open'
  if (health.state === 'cooling') return 'cooling'
  if (health.inFlight >= model.max_concurrency) return 'concurrency-full'
  if (model.rpm !== undefined && health.windowCalls >= model.rpm) return 'rpm-exhausted'
  return undefined
}

/** 一个请求被派出：占住一个并发位，并推进 rpm 滑窗。 */
export function beginAttempt(health: ModelHealth, now: number): void {
  if (now - health.windowStartedAt >= RPM_WINDOW_MS) {
    health.windowStartedAt = now
    health.windowCalls = 0
  }
  health.windowCalls += 1
  health.inFlight += 1
}

/** 一次尝试结束：释放并发位，并按结果推进状态机。 */
export function settleAttempt(
  health: ModelHealth,
  result: AttemptResult,
  now: number,
  defaults: { cooldown_ms: number; failure_threshold: number; half_open_after_ms: number },
): void {
  if (health.inFlight > 0) health.inFlight -= 1
  advance(health, now)

  // 客户端主动取消不是模型的错：既不熔断也不冷却。
  if (!result.ok && result.errorKind === 'aborted') {
    health.lastErrorKind = 'aborted'
    return
  }

  if (result.ok) {
    const latency = health.ewmaLatencyMs === undefined
      ? result.latencyMs
      : health.ewmaLatencyMs * (1 - EWMA_ALPHA) + result.latencyMs * EWMA_ALPHA
    health.ewmaLatencyMs = latency
    health.samples += 1
    health.consecutiveFailures = 0
    health.lastErrorKind = undefined
    health.resumeAt = undefined
    health.state = 'active'
    return
  }

  health.lastErrorKind = result.errorKind

  // 认证失败说明凭据坏了：直接熔断，等用户修好配置。
  if (result.errorKind === 'auth') {
    health.consecutiveFailures = Math.max(health.consecutiveFailures + 1, defaults.failure_threshold)
    health.state = 'open'
    health.resumeAt = now + defaults.half_open_after_ms
    return
  }

  // 400 一类是请求本身的问题：换下一个模型可能有用，但不该污染该模型的健康分。
  if (result.errorKind === 'bad-request' || result.errorKind === 'context-overflow') {
    return
  }

  if (isCooldownKind(result.errorKind)) {
    health.consecutiveFailures += 1
    health.state = 'cooling'
    health.resumeAt = now + cooldownFor(defaults.cooldown_ms, health.consecutiveFailures)
    return
  }

  if (isFuseKind(result.errorKind)) {
    health.consecutiveFailures += 1
    if (health.consecutiveFailures >= defaults.failure_threshold) {
      health.state = 'open'
      health.resumeAt = now + defaults.half_open_after_ms
    }
  }
}

/** 用户手动下线 / 上线；offline 不参与自动恢复。 */
export function setOffline(health: ModelHealth, offline: boolean, now: number): void {
  if (offline) {
    health.state = 'offline'
    health.resumeAt = undefined
    return
  }
  health.state = 'active'
  health.consecutiveFailures = 0
  health.resumeAt = undefined
  health.lastErrorKind = undefined
  health.windowStartedAt = now
  health.windowCalls = 0
}

/** 面板展示用的状态：把到期的 open 折算成 half-open，避免快照里挂着过期红点。 */
export function visibleState(health: ModelHealth, now: number): HealthState {
  advance(health, now)
  return health.state
}
