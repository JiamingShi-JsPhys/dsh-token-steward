/**
 * 三个调度模式的打分器（六维评分版）。
 *
 * 打分只回答「在已经通过硬过滤的候选里，谁更该先上」；它不做能力过滤、
 * 不看网络、不读时钟（now 由 context 带入）。新增一种模式 = 新增一个 Scorer，
 * 过滤与降级逻辑一律不动。
 *
 * 六维主键：每个请求带一个主维度（intent.dimension，由 intent.ts 推断），
 * 三个模式都以该维的评分为主序——例如 coding 任务在 max_power 下优先选
 * scores.coding.score 最高的模型。目录未收录的模型（无六维数据）回退到
 * legacy 的 quality_rank / cost_level，行为与旧配置完全兼容。
 *
 * 每个打分器都同时产出 reasons，面板直接展示，而不是事后编解释。
 */
import type { DimensionScore, ModelEntry, ModelHealth, RouteIntent, RoutingMode, ScoreContext, ScoreResult, Scorer } from './types.ts'

/** legacy 成本档位 → 每千 token 成本分（0..100，越高越便宜）。 */
export const COST_LEVEL_SCORE: Record<ModelEntry['cost_level'], number> = {
  free: 100,
  low: 75,
  medium: 50,
  high: 20,
}

/** 六维字母评级 → 序（max_power 的破平用；评级是独立事实，不做阈值推导）。 */
export const TIER_RANK: Record<string, number> = {
  SSS: 100, SS: 90, S: 80, 'A+': 72, A: 65, 'B+': 55, B: 50, 'C+': 40, C: 35, D: 20, NA: 0,
}

/** frugal 模式的「够用线」：主维度低于这个分的模型沉底，但不出局（仍是降级链候选）。 */
export const FRUGAL_FLOOR = 30

/** balanced 模式的混合权重：质量 0.65 + 成本 0.35。 */
export const BALANCED_QUALITY_WEIGHT = 0.65
export const BALANCED_COST_WEIGHT = 0.35

/** balanced 模式：每个在飞请求的扣分（把并发摊开）。 */
const INFLIGHT_PENALTY = 20

/**
 * balanced 模式：同一 burst 批次内已派次数的扣分——idea_swarm 打散仍然成立。
 * 大于 blend 的满分区（100×100）：同 burst 内已派过的模型必须让位给任何
 * 还没派过的合格候选，「先用没派过的」是这个模式的定义，不是倾向。
 */
const BURST_PENALTY = 20_000

/** frugal 模式：在飞扣分远小于成本差。 */
const FRUGAL_INFLIGHT_PENALTY = 5

/** 主维度分数 + 来源（六维 or legacy）。 */
export interface DimensionReading {
  score: number
  grade: string
  source: 'six-dim' | 'legacy'
}

/** 读一个模型在请求主维度上的分数；无六维数据时回退 quality_rank。 */
export function dimensionReading(model: ModelEntry, intent: RouteIntent): DimensionReading {
  const reading = model.dimensions?.[intent.dimension]
  if (reading !== undefined) return { score: reading.score, grade: reading.grade, source: 'six-dim' }
  return { score: model.quality_rank, grade: 'legacy', source: 'legacy' }
}

/**
 * 每千 token 成本分（0..100，越高越便宜）。
 * 优先 costPer1kOutput（目录/厂商覆盖）；回退 legacy pricing（每百万）与 cost_level。
 * null = 未定价 → 50（中性：frugal 不特殊偏爱，balanced 不特殊惩罚）。
 */
export function costScoreOf(model: ModelEntry): { per1k: number | null, score: number } {
  const per1k = model.costPer1kOutput
    ?? (model.pricing !== undefined ? model.pricing.output_per_mtok / 1000 : null)
  if (per1k === null || per1k === undefined || !Number.isFinite(per1k)) {
    return { per1k: null, score: COST_LEVEL_SCORE[model.cost_level] }
  }
  // $0.001/1k ≈ 99 分，$0.08/1k ≈ 4 分：对常见价差足够敏感。
  return { per1k, score: Math.max(0, Math.min(100, 100 - per1k * 1200)) }
}

/** 保留两位小数（浮点噪声会让「同分」判定不可测）。 */
function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * 极致便宜：成本是绝对主序，主维度分数只在同成本内破平；
 * 低于「够用线」的模型沉到所有合格候选之后（仍是降级链的一部分）。
 */
export const frugalScorer: Scorer = (model, intent, health, _context): ScoreResult => {
  const reading = dimensionReading(model, intent)
  const cost = costScoreOf(model)
  const spread = health.inFlight * FRUGAL_INFLIGHT_PENALTY
  const floorPenalty = reading.score < FRUGAL_FLOOR ? 1_000_000 : 0
  return {
    // cost.score 越高越便宜 → 直接作为主序；主维度分数只在同成本内破平。
    score: round2(cost.score * 1000 + reading.score * 10 - spread - floorPenalty),
    reasons: [
      cost.per1k === null ? 'cost:' + model.cost_level : 'cost:$' + cost.per1k.toFixed(4) + '/1k',
      'dim ' + intent.dimension + ':' + String(reading.score) + '(' + reading.grade + ')',
      'inflight:' + String(health.inFlight) + '/' + String(model.max_concurrency),
      ...(reading.score < FRUGAL_FLOOR ? ['below-floor:' + String(FRUGAL_FLOOR)] : []),
    ],
  }
}

/**
 * 效率优先（balanced）：质量与成本的加权混合为主序；
 * burst 内已派次数与在飞请求数把并发摊开——四个子代理同时开工时
 * 自然落到四个不同模型，而不是一起撞 429。
 */
export const balancedScorer: Scorer = (model, intent, health, context): ScoreResult => {
  const reading = dimensionReading(model, intent)
  const cost = costScoreOf(model)
  const blend = BALANCED_QUALITY_WEIGHT * reading.score + BALANCED_COST_WEIGHT * cost.score
  const spread = health.inFlight * INFLIGHT_PENALTY
  const burst = context.burstLoad * BURST_PENALTY
  return {
    score: round2(blend * 100 - spread - burst),
    reasons: [
      'dim ' + intent.dimension + ':' + String(reading.score) + '(' + reading.grade + ')',
      cost.per1k === null ? 'cost:' + model.cost_level : 'cost:$' + cost.per1k.toFixed(4) + '/1k',
      'burst:' + String(context.burstLoad),
      'inflight:' + String(health.inFlight) + '/' + String(model.max_concurrency),
    ],
  }
}

/**
 * 最强火力：请求主维度的六维分数是绝对主序，Tier 评级破平，
 * 上下文窗口再次之；延迟只作同分微调，绝不让「快但弱」翻盘。
 */
export const maxPowerScorer: Scorer = (model, intent, health, _context): ScoreResult => {
  const reading = dimensionReading(model, intent)
  const tierRank = TIER_RANK[model.tier ?? ''] ?? 0
  const window = Math.min(model.context_window / 100_000, 20)
  const latency = health.ewmaLatencyMs === undefined ? 0 : -(health.ewmaLatencyMs / 1000)
  return {
    score: round2(reading.score * 10 + tierRank + window + latency),
    reasons: [
      'dim ' + intent.dimension + ':' + String(reading.score) + '(' + reading.grade + ')',
      'tier:' + (model.tier ?? 'NA'),
      'window:' + String(model.context_window),
    ],
  }
}

/** 模式 → 打分器。 */
export const SCORERS: Record<RoutingMode, Scorer> = {
  frugal: frugalScorer,
  balanced: balancedScorer,
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

/** 旧导出名兼容（外部曾以 COST_TIER_SCORE 引用成本档位表）。 */
export const COST_TIER_SCORE = COST_LEVEL_SCORE
export type { DimensionScore }
