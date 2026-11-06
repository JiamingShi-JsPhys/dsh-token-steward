/**
 * 路由引擎：纯决策 + 纯内存状态。
 *
 * plan() 不读时钟、不碰网络与磁盘，now 由调用方带入，因此三模式的打分、
 * 硬过滤与降级链都能被单测钉死。report() 只更新健康状态机、路由事件环形
 * 缓冲与 agent 归因表，同样不产生任何 IO。
 *
 * 过滤 → 打分 → 排序 → 首选 + 降级链，是这里唯一的一条路径；
 * 模式差异全部收敛在 scorers.ts，本文件不含任何模式分支。
 */
import type {
  AgentRouteView,
  AttemptResult,
  ModelCardView,
  ModelEntry,
  ModelHealth,
  MatrixSnapshot,
  PlanResult,
  PoolConfig,
  ProviderEntry,
  RouteCandidate,
  RouteEventView,
  RouteIntent,
  RoutingMode,
  SnapshotInput,
  UsageFacts,
} from './types.ts'
import { beginAttempt, createHealth, settleAttempt, unavailableReason, visibleState } from './health.ts'
import { scoreModel } from './scorers.ts'

/** 路由事件的环形缓冲容量。 */
export const RECENT_EVENT_CAP = 40

/** agent 闲置多久后视为离线（面板置灰）。 */
export const AGENT_IDLE_MS = 90_000

/** burst 归因的记忆窗口：超过这个时间的批次不再影响打散。 */
export const BURST_WINDOW_MS = 5_000

/** 路由引擎的可调参数（全部来自 config.defaults，测试可覆盖）。 */
export interface RouterOptions {
  /** 一次请求最多尝试几个模型。 */
  maxAttempts: number
  cooldownMs: number
  failureThreshold: number
  halfOpenAfterMs: number
}

/** key 的稳定拼写：provider/model。 */
export function modelKey(provider: string, model: string): string {
  return provider + '/' + model
}

/** 一个矩阵模型连同它所属的 provider。 */
interface IndexedModel {
  provider: ProviderEntry
  model: ModelEntry
  key: string
}

/** 按 provider/model 建索引，顺序稳定（配置顺序）。 */
function indexModels(config: PoolConfig): IndexedModel[] {
  const out: IndexedModel[] = []
  for (const provider of config.providers) {
    for (const model of provider.models) {
      out.push({ provider, model, key: modelKey(provider.provider_name, model.id) })
    }
  }
  return out
}

/** 一个候选是否满足意图的硬要求；不满足时给出人话原因。 */
export function filterReason(model: ModelEntry, intent: RouteIntent): string | undefined {
  for (const tag of intent.requiredCapabilities) {
    if (!model.capabilities.includes(tag)) return 'missing-capability:' + tag
  }
  for (const modality of intent.requiredModalities) {
    if (!model.input_modalities.includes(modality)) return 'missing-modality:' + modality
  }
  if (intent.needsTools && !model.capabilities.includes('tool-use')) return 'missing-capability:tool-use'
  const needed = intent.estimatedInputTokens + intent.expectedOutputTokens
  if (model.context_window < needed) return 'window-too-small:' + String(model.context_window) + '<' + String(needed)
  if (model.availability === 'offline') return 'offline'
  return undefined
}

/** 排序：分数降序；同分用 provider/model 字典序破平，保证结果可复现。 */
function compareCandidates(left: RouteCandidate, right: RouteCandidate): number {
  if (right.score !== left.score) return right.score - left.score
  const leftKey = modelKey(left.provider, left.model)
  const rightKey = modelKey(right.provider, right.model)
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
}

/** 路由引擎。 */
export interface UmbraRouter {
  /**
   * 排一次路由。
   * @param intent - 从请求推断出的意图。
   * @param now - 当前毫秒。
   * @param requestId - 本次请求的稳定 id。
   * @param restrict - 可选：把候选限制在这些 key 内（虚拟 id 直通 / 别名钉子）。
   */
  plan(intent: RouteIntent, now: number, requestId: string, restrict?: string[]): PlanResult
  report(result: AttemptResult, now: number): void
  setMode(mode: RoutingMode): RoutingMode
  getMode(): RoutingMode
  noteAgent(agentId: string, provider: string, model: string, now: number): void
  /**
   * 登记一次本地缓存命中：路由监控里可见（cached 标记），但不动健康状态机——
   * 没有真实的上游尝试，就没有延迟样本，也没有熔断语义。
   */
  noteCacheHit(requestId: string, provider: string, model: string, now: number): void
  snapshot(now: number, input?: SnapshotInput): MatrixSnapshot
  /**
   * 为一次尝试占位（并发计数 + rpm 滑窗）。
   *
   * plan() 只为首选占位；降级链上的候选由网关在真正派发前调用这里。
   * @returns 该模型此刻是否真的可用。
   */
  acquire(provider: string, model: string, now: number): boolean
  /** 直接读某模型的健康记录（测试与面板用）。 */
  healthOf(provider: string, model: string): ModelHealth | undefined
  /** 配置里全部模型，顺序同配置。 */
  listModels(): IndexedModel[]
  options(): RouterOptions
}

/**
 * 建一个路由引擎。
 * @param config - 已校验的矩阵配置。
 * @param options - 可调参数；缺省取 config.defaults。
 * @param mode - 初始模式；缺省取 config.routing.mode。
 */
export function createRouter(config: PoolConfig, options?: Partial<RouterOptions>, mode?: RoutingMode): UmbraRouter {
  const resolved: RouterOptions = {
    maxAttempts: options?.maxAttempts ?? config.defaults.max_attempts,
    cooldownMs: options?.cooldownMs ?? config.defaults.cooldown_ms,
    failureThreshold: options?.failureThreshold ?? config.defaults.failure_threshold,
    halfOpenAfterMs: options?.halfOpenAfterMs ?? config.defaults.half_open_after_ms,
  }
  const models = indexModels(config)
  const healths = new Map<string, ModelHealth>()
  for (const entry of models) healths.set(entry.key, createHealth(0))

  let currentMode: RoutingMode = mode ?? config.routing.mode
  let revision = 0
  let degradedRequests = 0
  const recent: RouteEventView[] = []
  const agents = new Map<string, AgentRouteView>()
  const bursts = new Map<string, { at: number; counts: Map<string, number> }>()
  /** 每个请求的降级历史，report 收口时写进事件。 */
  const attempts = new Map<string, Array<{ provider: string; model: string; errorKind: RouteEventView['degradedFrom'][number]['errorKind'] }>>()
  const startedAt = new Map<string, number>()

  /** 取（必要时创建）一个模型的健康记录。 */
  function healthFor(key: string): ModelHealth {
    let health = healths.get(key)
    if (health === undefined) {
      health = createHealth(0)
      healths.set(key, health)
    }
    return health
  }

  /** 同一 burst 批次里该模型已被派过几次。 */
  function burstLoad(intent: RouteIntent, key: string, now: number): number {
    const entry = bursts.get(intent.burstKey)
    if (entry === undefined) return 0
    if (now - entry.at > BURST_WINDOW_MS) {
      bursts.delete(intent.burstKey)
      return 0
    }
    return entry.counts.get(key) ?? 0
  }

  /** 记录一次派发到 burst 表。 */
  function noteBurst(burstKey: string, key: string, now: number): void {
    let entry = bursts.get(burstKey)
    if (entry === undefined || now - entry.at > BURST_WINDOW_MS) {
      entry = { at: now, counts: new Map() }
      bursts.set(burstKey, entry)
    }
    entry.counts.set(key, (entry.counts.get(key) ?? 0) + 1)
  }

  /** 让同一个模型在同一次请求的降级链里只出现一次。 */
  function uniqueCandidates(list: RouteCandidate[]): RouteCandidate[] {
    const seen = new Set<string>()
    const out: RouteCandidate[] = []
    for (const candidate of list) {
      const key = modelKey(candidate.provider, candidate.model)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(candidate)
    }
    return out
  }

  function plan(intent: RouteIntent, now: number, requestId: string, restrict?: string[]): PlanResult {
    const rejected: Array<{ provider: string; model: string; reason: string }> = []
    const scored: RouteCandidate[] = []
    const notes: string[] = []
    const loads = new Map<string, number>()
    const allowed = restrict === undefined ? undefined : new Set(restrict)

    for (const entry of models) {
      const key = entry.key
      if (allowed !== undefined && !allowed.has(key)) continue
      const reason = filterReason(entry.model, intent)
      if (reason !== undefined) {
        rejected.push({ provider: entry.provider.provider_name, model: entry.model.id, reason })
        continue
      }
      const health = healthFor(key)
      const blocked = unavailableReason(entry.model, health, now)
      if (blocked !== undefined) {
        rejected.push({ provider: entry.provider.provider_name, model: entry.model.id, reason: blocked })
        continue
      }
      const load = burstLoad(intent, key, now)
      loads.set(key, load)
      const result = scoreModel(currentMode, entry.model, intent, health, {
        mode: currentMode,
        now,
        burstLoad: load,
      })
      scored.push({
        provider: entry.provider.provider_name,
        model: entry.model.id,
        score: result.score,
        reasons: result.reasons,
      })
    }

    if (intent.needsTools && !intent.requiredCapabilities.includes('tool-use')) {
      notes.push('tools-present → required tool-use')
    }
    if (intent.aliasName !== undefined) notes.push('alias:' + intent.aliasName)

    const ranked = uniqueCandidates(scored.sort(compareCandidates))

    if (ranked.length === 0) {
      const allCooling = rejected.length > 0 && rejected.every((r) =>
        r.reason === 'circuit-open' || r.reason === 'offline')
      return {
        ok: false,
        refusal: {
          requestId,
          mode: currentMode,
          code: allCooling ? 'all-models-cooling' : 'no-capable-model',
          rejected,
          decidedAt: now,
        },
      }
    }

    const limit = Math.max(1, resolved.maxAttempts)
    const chosen = ranked[0] as RouteCandidate
    const fallbacks = ranked.slice(1, limit)
    if (fallbacks.length === 0) {
      notes.push('no-fallback:candidates:' + String(ranked.length))
    } else if (fallbacks.length < limit - 1) {
      notes.push('candidates:' + String(ranked.length) + '<attempts:' + String(limit))
    }

    beginAttempt(healthFor(modelKey(chosen.provider, chosen.model)), now)
    noteBurst(intent.burstKey, modelKey(chosen.provider, chosen.model), now)
    attempts.set(requestId, [])
    startedAt.set(requestId, now)

    return {
      ok: true,
      decision: {
        requestId,
        mode: currentMode,
        chosen,
        fallbacks,
        decidedAt: now,
        notes,
      },
    }
  }

  function report(result: AttemptResult, now: number): void {
    const key = modelKey(result.provider, result.model)
    const health = healthFor(key)
    settleAttempt(health, result, now, {
      cooldown_ms: resolved.cooldownMs,
      failure_threshold: resolved.failureThreshold,
      half_open_after_ms: resolved.halfOpenAfterMs,
    })

    const history = attempts.get(result.requestId)
    if (history === undefined) return

    const isFinal = result.ok || result.committed || result.final === true
    if (!isFinal) {
      // 还要换下一个候选：把这次失败记进降级链，等收口时一起写进事件。
      history.push({
        provider: result.provider,
        model: result.model,
        errorKind: result.errorKind ?? 'server',
      })
      return
    }

    const started = startedAt.get(result.requestId) ?? now
    const degraded = history.slice()
    const event: RouteEventView = {
      at: now,
      requestId: result.requestId,
      mode: currentMode,
      provider: result.provider,
      model: result.model,
      degradedFrom: degraded,
      ok: result.ok,
      latencyMs: Math.max(0, now - started),
      committed: result.committed,
    }
    recent.push(event)
    if (recent.length > RECENT_EVENT_CAP) recent.splice(0, recent.length - RECENT_EVENT_CAP)
    if (degraded.length > 0) degradedRequests += 1

    attempts.delete(result.requestId)
    startedAt.delete(result.requestId)
  }

  function setMode(next: RoutingMode): RoutingMode {
    currentMode = next
    revision += 1
    return currentMode
  }

  function getMode(): RoutingMode {
    return currentMode
  }

  function noteCacheHit(requestId: string, provider: string, model: string, now: number): void {
    const event: RouteEventView = {
      at: now,
      requestId,
      mode: currentMode,
      provider,
      model,
      degradedFrom: [],
      ok: true,
      latencyMs: 0,
      committed: false,
      cached: true,
    }
    recent.push(event)
    if (recent.length > RECENT_EVENT_CAP) recent.splice(0, recent.length - RECENT_EVENT_CAP)
  }

  function noteAgent(agentId: string, provider: string, model: string, now: number): void {
    const existing = agents.get(agentId)
    agents.set(agentId, {
      agentId,
      provider,
      model,
      lastSeenAt: now,
      requests: (existing?.requests ?? 0) + 1,
    })
  }

  function snapshot(now: number, input?: SnapshotInput): MatrixSnapshot {
    const usage: UsageFacts = input?.usage ?? {}
    const cards: ModelCardView[] = []
    let todayTokens = 0
    let unpriced = 0
    const costs = new Map<string, number>()
    let cacheHits = 0
    let cacheKnown = 0

    for (const entry of models) {
      const health = healthFor(entry.key)
      settleNoop(health, now)
      const fact = usage[entry.key]
      const tokens = fact?.todayTokens ?? 0
      todayTokens += tokens
      if (fact?.todayCost != null) {
        const currency = fact.todayCost.currency
        costs.set(currency, (costs.get(currency) ?? 0) + fact.todayCost.amount)
      }
      if (entry.model.pricing === undefined) unpriced += 1
      if (fact?.cacheHitRate != null) {
        cacheKnown += 1
        cacheHits += fact.cacheHitRate
      }
      const card: ModelCardView = {
        provider: entry.provider.provider_name,
        model: entry.model.id,
        displayName: entry.model.display_name,
        capabilities: entry.model.capabilities.slice(),
        costLevel: entry.model.cost_level,
        contextWindow: entry.model.context_window,
        availability: entry.model.availability,
        health: visibleState(health, now),
        inFlight: health.inFlight,
        todayTokens: tokens,
        todayCost: fact?.todayCost ?? null,
        cacheHitRate: fact?.cacheHitRate ?? null,
      }
      if (health.resumeAt !== undefined) card.resumeAt = health.resumeAt
      if (health.ewmaLatencyMs !== undefined) card.latencyMs = Math.round(health.ewmaLatencyMs)
      cards.push(card)
    }

    const agentViews: AgentRouteView[] = []
    for (const view of agents.values()) agentViews.push({ ...view })
    agentViews.sort((left, right) => right.lastSeenAt - left.lastSeenAt)

    revision += 1
    return {
      revision,
      mode: currentMode,
      updatedAt: now,
      usageAvailable: input?.usageAvailable ?? Object.keys(usage).length > 0,
      models: cards,
      agents: agentViews,
      recent: recent.slice(),
      totals: {
        todayTokens,
        todayCost: singleCurrency(costs),
        cacheHitRate: cacheKnown === 0 ? null : cacheHits / cacheKnown,
        degradedRequests,
        unpricedModels: unpriced,
      },
      pool: input?.pool ?? { status: 'ok', source: 'model_pool.yaml' },
    }
  }

  return {
    plan,
    report,
    setMode,
    getMode,
    noteAgent,
    noteCacheHit,
    snapshot,
    acquire: (provider, model, now) => {
      const key = modelKey(provider, model)
      const health = healths.get(key)
      const entry = models.find((candidate) => candidate.key === key)
      if (health === undefined || entry === undefined) return false
      if (unavailableReason(entry.model, health, now) !== undefined) return false
      beginAttempt(health, now)
      return true
    },
    healthOf: (provider, model) => healths.get(modelKey(provider, model)),
    listModels: () => models,
    options: () => ({ ...resolved }),
  }
}

/** 快照只读，不该推进状态机；这里保留一个空实现，语义上明确「快照不改状态」。 */
function settleNoop(_health: ModelHealth, _now: number): void {
  // 状态推进由 visibleState 负责，此处刻意留空。
}

/** 只有单一币种时才给出总额；混币直接返回 null，绝不把两种货币相加。 */
function singleCurrency(costs: Map<string, number>): { currency: string; amount: number } | null {
  if (costs.size === 0) return null
  if (costs.size > 1) return null
  const [currency, amount] = [...costs.entries()][0] as [string, number]
  return { currency, amount: Math.round(amount * 1e6) / 1e6 }
}
