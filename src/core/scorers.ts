/**
 * 三个调度模式的打分器（终极整合版）。
 *
 * 规格来自产品定义，三条互不相同的选路哲学：
 *
 *  - **Max Power**：无脑选六维**总和**最高（SSS/SS 排在最前）。
 *    不猜「这个任务需要哪一维」，就是整体最强。
 *  - **Balanced**：先过「任务对应维度 ≥ A/A+」的门槛，门槛内看
 *    质量 × 成本（0.6 / 0.4）；没有达标者时自然退化为「最能打的 + 成本破平」。
 *  - **Frugal**：在满足硬过滤的 **C/D 级**模型里选最便宜的；没有 C/D 才放宽。
 *
 * 打分只回答「已经通过硬过滤的候选里，谁先上」；不碰网络、不读时钟、
 * 不改变过滤与降级逻辑。每个打分器同时产出 `reasons`，面板直接展示。
 */
import type { DimensionScore, ModelEntry, ModelHealth, RouteIntent, RoutingMode, ScoreContext, ScoreResult, Scorer } from './types.ts'
import { outputPer1k } from './pricing.ts'

/** legacy 成本档位 → 每千 token 成本分（0..100，越高越便宜）。 */
export const COST_LEVEL_SCORE: Record<ModelEntry['cost_level'], number> = {
  free: 100,
  low: 75,
  medium: 50,
  high: 20,
}

/** Tier / 字母评级 → 序。评级是独立事实字段，不做阈值推导。 */
export const TIER_RANK: Record<string, number> = {
  SSS: 100, SS: 90, S: 80, 'A+': 72, A: 65, 'B+': 55, B: 50, 'C+': 40, C: 35, D: 20, NA: 0,
}

/** 评级序（六维的 grade 与 Tier 共用同一张表）。 */
export const GRADE_RANK = TIER_RANK

/** Balanced 的准入门槛：任务主维度必须达到 A。 */
export const BALANCED_MIN_GRADE_RANK = TIER_RANK.A ?? 65

/** Balanced 的质量 / 成本权重。 */
export const BALANCED_QUALITY_WEIGHT = 0.6
export const BALANCED_COST_WEIGHT = 0.4

/** Frugal 的「C/D 级」上界：序 ≤ C+（含未评级 NA）才算低阶模型。 */
export const FRUGAL_TIER_CEILING = TIER_RANK['C+'] ?? 40

/** balanced：每个在飞请求的扣分（把并发摊开）。 */
const INFLIGHT_PENALTY = 200

/** balanced：同 burst 已派次数的扣分（决定性打散）。 */
const BURST_PENALTY = 20_000

/** frugal：在飞扣分远小于价格差。 */
const FRUGAL_INFLIGHT_PENALTY = 5

/** max_power：同分时窗口最多加这么多（2M 与 10M 不产生差距）。 */
const WINDOW_BONUS_CAP = 20

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

/** 六维总和；没有六维数据时用 quality_rank × 6 近似（保持量纲一致）。 */
export function totalDimensionScore(model: ModelEntry): number {
  if (model.dimensions === undefined) return model.quality_rank * 6
  const values = Object.values(model.dimensions) as DimensionScore[]
  return values.reduce((sum, entry) => sum + entry.score, 0)
}

/** Tier 序；未评级为 0。 */
export function tierRankOf(tier: string | undefined): number {
  return TIER_RANK[tier ?? 'NA'] ?? 0
}

/** 评级序；未知评级为 0。 */
export function gradeRankOf(grade: string | undefined): number {
  return GRADE_RANK[grade ?? 'NA'] ?? 0
}

/** 该模型是否达到 Balanced 的 A 级门槛。 */
export function meetsBalancedGate(model: ModelEntry, intent: RouteIntent): boolean {
  const reading = dimensionReading(model, intent)
  if (reading.source === 'legacy') return reading.score >= BALANCED_MIN_GRADE_RANK
  return gradeRankOf(reading.grade) >= BALANCED_MIN_GRADE_RANK
}

/** 该模型是否属于 Frugal 偏好的 C/D 级（含未评级）。 */
export function isLowTier(model: ModelEntry): boolean {
  return tierRankOf(model.tier) <= FRUGAL_TIER_CEILING
}

/**
 * 每千 token 输出价与成本分（0..100，越高越便宜）。
 * 优先生效价目（目录估算/用户覆盖），回退 legacy cost_level。
 * null = 未定价 → 中性 50：frugal 不特殊偏爱，balanced 不特殊惩罚。
 */
export function costScoreOf(model: ModelEntry): { per1k: number | null, score: number } {
  const per1k = outputPer1k(model)
  if (per1k === null || !Number.isFinite(per1k)) {
    return { per1k: null, score: COST_LEVEL_SCORE[model.cost_level] }
  }
  // $0.001/1k ≈ 99 分，$0.08/1k ≈ 4 分：对常见价差足够敏感。
  return { per1k, score: Math.max(0, Math.min(100, 100 - per1k * 1200)) }
}

/** 保留两位小数（浮点噪声会让「同分」判定不可测）。 */
function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/** 价格的可读理由。 */
function priceReason(per1k: number | null, model: ModelEntry): string {
  return per1k === null ? 'PRICE:' + model.cost_level.toUpperCase() : 'PRICE:$' + per1k.toFixed(4) + '/1K'
}

/**
 * 极致便宜：C/D 级里最便宜，价格是绝对主序。
 * 低阶模型优先（-1e6 的罚分对 A/S 级生效），没有低阶候选时罚分对所有人一样，
 * 自然退化为「全体最便宜」——这就是「没有 C/D 才放宽」的实现。
 */
export const frugalScorer: Scorer = (model, intent, health, _context): ScoreResult => {
  const reading = dimensionReading(model, intent)
  const cost = costScoreOf(model)
  const lowTier = isLowTier(model)
  const spread = health.inFlight * FRUGAL_INFLIGHT_PENALTY
  return {
    // 低阶优先的罚分必须大于价格分的整个量程（100×10000），否则「便宜的 A/S」会翻盘。
    score: round2(cost.score * 10_000 + reading.score * 100 - spread - (lowTier ? 0 : 10_000_000)),
    reasons: [
      priceReason(cost.per1k, model),
      'TIER:' + (model.tier ?? 'NA'),
      'DIM:' + intent.dimension + ' ' + reading.grade,
      'INFLIGHT:' + String(health.inFlight) + '/' + String(model.max_concurrency),
      ...(lowTier ? [] : ['FALLBACK:tier-widened']),
    ],
  }
}

/**
 * 效率优先：任务主维度 ≥ A 才有资格；门槛内质量 0.6 + 成本 0.4。
 * burst 内已派次数与在飞请求把并发摊开——四个子代理同时开工时自然落到
 * 四个不同模型，而不是一起撞 429。
 */
export const balancedScorer: Scorer = (model, intent, health, context): ScoreResult => {
  const reading = dimensionReading(model, intent)
  const cost = costScoreOf(model)
  const gated = meetsBalancedGate(model, intent)
  const blend = BALANCED_QUALITY_WEIGHT * reading.score + BALANCED_COST_WEIGHT * cost.score
  const spread = health.inFlight * INFLIGHT_PENALTY
  const burst = context.burstLoad * BURST_PENALTY
  return {
    score: round2(blend * 100 + (gated ? 1_000_000 : 0) - spread - burst),
    reasons: [
      'DIM:' + intent.dimension + ' ' + reading.grade,
      priceReason(cost.per1k, model),
      'GATE:' + (gated ? 'A' : 'BELOW'),
      'BURST:' + String(context.burstLoad),
      'INFLIGHT:' + String(health.inFlight) + '/' + String(model.max_concurrency),
    ],
  }
}

/**
 * 最强火力：六维总和是绝对主序，Tier 破平，窗口再次之，
 * 延迟只作同分微调——绝不让「快但弱」翻盘。
 */
export const maxPowerScorer: Scorer = (model, _intent, health, _context): ScoreResult => {
  const total = totalDimensionScore(model)
  const tierRank = tierRankOf(model.tier)
  const window = Math.min(model.context_window / 100_000, WINDOW_BONUS_CAP) * 10
  const latency = health.ewmaLatencyMs === undefined ? 0 : -(health.ewmaLatencyMs / 1_000)
  return {
    score: round2(total * 100 + tierRank * 10 + window + latency),
    reasons: [
      'SUM:' + total.toFixed(1),
      'TIER:' + (model.tier ?? 'NA'),
      'WINDOW:' + String(model.context_window),
    ],
  }
}

/**
 * 零成本判定：有效价目（用户覆盖 / 目录估算）为 0 才算。
 * 未定价（null）不算免费——「不知道多少钱」和「不要钱」是两回事，
 * 白嫖模式不能把未定价的模型当成免费放进去。
 */
export function isFreeModel(model: ModelEntry): boolean {
  const { per1k } = costScoreOf(model)
  if (per1k !== null) return per1k === 0
  return model.cost_level === 'free'
}

/**
 * 白嫖：候选在路由层已经被硬过滤成零成本，价格不再是变量，
 * 所以在剩下的免费模型里按质量挑（六维总和 + Tier + 窗口）。
 */
export const freeScorer: Scorer = (model, intent, health, context): ScoreResult => {
  const result = maxPowerScorer(model, intent, health, context)
  return { score: result.score, reasons: [...result.reasons, 'FREE:0'] }
}

/** 模式 → 打分器。 */
export const SCORERS: Record<RoutingMode, Scorer> = {
  frugal: frugalScorer,
  balanced: balancedScorer,
  max_power: maxPowerScorer,
  free: freeScorer,
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
