/**
 * 三个调度模式的打分器。
 *
 * 打分只回答「在已经通过硬过滤的候选里，谁更该先上」；它不做能力过滤、
 * 不看网络、不读时钟（now 由 context 带入）。新增一种模式 = 新增一个 Scorer，
 * 过滤与降级逻辑一律不动。
 *
 * 每个打分器都同时产出 reasons，面板直接展示，而不是事后编解释。
 */
import type { ModelEntry, ModelHealth, RoutingMode, RouteIntent, ScoreContext, ScoreResult, Scorer } from './types.ts'

/** 成本档位 → 分值。差距足够大，任何次级因子都无法翻转档位顺序。 */
export const COST_TIER_SCORE: Record<ModelEntry['cost_level'], number> = {
  free: 1000,
  low: 800,
  medium: 400,
  high: 100,
}

/** 延迟未知时的中性分（效率模式用）。 */
const NEUTRAL_LATENCY_SCORE = 300

/** 延迟 0ms 的满分；每 10ms 扣 1 分，6000ms 归零。 */
const LATENCY_FULL_MS = 0
const LATENCY_ZERO_MS = 6000

/** 效率模式：fast 标签的固定加成。 */
const FAST_BONUS = 600

/** 效率模式：每个进行中请求的扣分（天然把并发摊开）。 */
const INFLIGHT_PENALTY = 200

/**
 * 效率模式：同一 burst 批次内已派给该模型的次数扣分。
 * 大到足以盖过任何能力与延迟差——「先用还没被派的模型」是这个模式的定义，
 * 不是倾向。
 */
const BURST_PENALTY = 10_000

/** frugal 模式：每个进行中请求的扣分，远小于成本档位差。 */
const FRUGAL_INFLIGHT_PENALTY = 5

/** max_power 模式：质量分的放大系数。 */
const QUALITY_WEIGHT = 10

/** max_power 模式：每个能力标签的加成（标签越全越顶配）。 */
const CAPABILITY_WEIGHT = 5

/** max_power 模式：上下文窗口的归一化上限与权重。 */
const CONTEXT_WINDOW_UNIT = 100_000
const CONTEXT_WINDOW_CAP = 20

/** 把延迟换成 0..600 的分数；未知延迟取中性值。 */
function latencyScore(health: ModelHealth): number {
  if (health.ewmaLatencyMs === undefined) return NEUTRAL_LATENCY_SCORE
  const span = LATENCY_ZERO_MS - LATENCY_FULL_MS
  const raw = (LATENCY_ZERO_MS - health.ewmaLatencyMs) / span
  return Math.max(0, Math.min(1, raw)) * (LATENCY_ZERO_MS / 10)
}

/** 保留两位小数，既稳定又可读（浮点噪声会让「同分」判定变得不可测）。 */
function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * 极致便宜：成本档位是绝对主序；同档位里先要快的，再要空闲的，
 * 最后用质量分兜底——「够用就好」不等于「故意挑最差的」。
 */
export const frugalScorer: Scorer = (model, _intent, health, context): ScoreResult => {
  const tier = COST_TIER_SCORE[model.cost_level]
  const latency = latencyScore(health) * 0.1
  const spread = health.inFlight * FRUGAL_INFLIGHT_PENALTY
  const quality = model.quality_rank * 0.01
  return {
    score: round2(tier + latency - spread + quality),
    reasons: [
      'cost:' + model.cost_level,
      health.ewmaLatencyMs === undefined ? 'latency:unknown' : 'latency:' + Math.round(health.ewmaLatencyMs) + 'ms',
      'inflight:' + String(health.inFlight) + '/' + String(model.max_concurrency),
    ],
  }
}

/**
 * 效率优先：fast 标签 + 实测延迟为主，burst 内已派次数与在飞请求数把
 * 并发摊开——四个子代理同时开工时自然落到四个不同模型，而不是一起撞 429。
 */
export const efficiencyScorer: Scorer = (model, _intent, health, context): ScoreResult => {
  const fast = model.capabilities.includes('fast') ? FAST_BONUS : 0
  const latency = latencyScore(health)
  const spread = health.inFlight * INFLIGHT_PENALTY
  const burst = context.burstLoad * BURST_PENALTY
  const quality = model.quality_rank * 0.5
  return {
    score: round2(fast + latency - spread - burst + quality),
    reasons: [
      ...(fast > 0 ? ['tag:fast'] : []),
      health.ewmaLatencyMs === undefined ? 'latency:unknown' : 'latency:' + Math.round(health.ewmaLatencyMs) + 'ms',
      'burst:' + String(context.burstLoad),
      'inflight:' + String(health.inFlight) + '/' + String(model.max_concurrency),
    ],
  }
}

/**
 * 最强火力：质量分是主序，能力标签数量次之，上下文窗口再次之；
 * 延迟只作为同分时的微调，绝不让「快但弱」翻到前面。
 */
export const maxPowerScorer: Scorer = (model, _intent, health, _context): ScoreResult => {
  const quality = model.quality_rank * QUALITY_WEIGHT
  const caps = model.capabilities.length * CAPABILITY_WEIGHT
  const window = Math.min(model.context_window / CONTEXT_WINDOW_UNIT, CONTEXT_WINDOW_CAP)
  const latency = health.ewmaLatencyMs === undefined ? 0 : -(health.ewmaLatencyMs / 1000)
  return {
    score: round2(quality + caps + window + latency),
    reasons: [
      'quality:' + String(model.quality_rank),
      'caps:' + String(model.capabilities.length),
      'window:' + String(model.context_window),
    ],
  }
}

/** 模式 → 打分器。 */
export const SCORERS: Record<RoutingMode, Scorer> = {
  frugal: frugalScorer,
  efficiency: efficiencyScorer,
  max_power: maxPowerScorer,
}

/** 按模式取打分器；未知模式回退 frugal（配置层已经保证合法，这里只是防御）。 */
export function scorerFor(mode: RoutingMode): Scorer {
  return SCORERS[mode] ?? frugalScorer
}

/** 便捷入口：给一个模型打分。 */
export function scoreModel(
  mode: RoutingMode,
  model: ModelEntry,
  intent: RouteIntent,
  health: ModelHealth,
  context: ScoreContext,
): ScoreResult {
  return scorerFor(mode)(model, intent, health, context)
}
