/**
 * scorers.ts：三种模式的排序意图（终极整合版）。
 *
 * 每条断言回答一个产品问题：
 *  - Max Power 会不会被「单项很强」的模型骗走（必须是六维总和）；
 *  - Balanced 的 A/A+ 门槛是不是真的先于价格；
 *  - Frugal 会不会偷偷挑 A/S 级，或在 C/D 里被质量分带偏；
 *  - burst 打散是否仍然决定性。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SCORERS,
  scoreModel,
  scorerFor,
  dimensionReading,
  costScoreOf,
  meetsBalancedGate,
  isLowTier,
  totalDimensionScore,
} from '../src/core/scorers.ts'
import { createHealth } from '../src/core/health.ts'
import { intent, model } from './fixtures.ts'
import type { DimensionSet, ModelEntry, RoutingMode, ScoreContext } from '../src/core/types.ts'

const CONTEXT: ScoreContext = { mode: 'frugal', now: 1_000, burstLoad: 0 }

function score(mode: RoutingMode, entry: ModelEntry, context: Partial<ScoreContext> = {}) {
  return scoreModel(mode, entry, intent(), createHealth(0), { ...CONTEXT, ...context })
}

function healthWithLatency(latencyMs: number) {
  const health = createHealth(0)
  health.ewmaLatencyMs = latencyMs
  health.samples = 3
  return health
}

/** 六维：主维度 score/grade 显式，其余维度取 fallback。 */
function dims(reasoning: number, grade: string, others = 50): DimensionSet {
  const fill = (value: number) => ({ score: value, grade: value >= 70 ? 'SS' : value >= 50 ? 'A' : 'C' })
  return {
    reasoning: { score: reasoning, grade },
    longContext: fill(others),
    coding: fill(others),
    agentic: fill(others),
    proWork: fill(others),
    factuality: fill(others),
  }
}

/** 一张带六维 + 价格的模型卡（目录合成的形态）。 */
function scoredModel(overrides: Partial<ModelEntry> & Pick<ModelEntry, 'id'>): ModelEntry {
  return model({
    ...overrides,
    dimensions: overrides.dimensions ?? dims(overrides.quality_rank ?? 50, 'A'),
  })
}

test('每个模式都有打分器，未知模式回退到 frugal', () => {
  assert.ok(SCORERS.frugal)
  assert.ok(SCORERS.balanced)
  assert.ok(SCORERS.max_power)
  assert.equal(scorerFor('frugal'), SCORERS.frugal)
  assert.equal(scorerFor('nonsense' as RoutingMode), SCORERS.frugal)
})

// ── frugal：C/D 级里最便宜 ────────────────────────────────────────────

test('frugal：C/D 级之间，价格严格主导', () => {
  const cheap = score('frugal', scoredModel({ id: 'a', tier: 'D', costPer1kOutput: 0.0002, quality_rank: 30 }))
  const pricey = score('frugal', scoredModel({ id: 'b', tier: 'C+', costPer1kOutput: 0.02, quality_rank: 95 }))
  assert.ok(cheap.score > pricey.score, '同为低阶，便宜的一方必须赢——质量分只做同价破平')
  assert.ok(cheap.reasons.some((reason) => reason.startsWith('PRICE:')))
})

test('frugal：宁可选贵的 C/D，也不选便宜的 A/S（规格就是低阶优先）', () => {
  const cheapPremium = scoredModel({ id: 'a', tier: 'SSS', costPer1kOutput: 0.0001, quality_rank: 99 })
  const priceyLowTier = scoredModel({ id: 'b', tier: 'D', costPer1kOutput: 0.05, quality_rank: 20 })
  const lowTierScore = score('frugal', priceyLowTier)
  const premiumScore = score('frugal', cheapPremium)
  assert.ok(lowTierScore.score > premiumScore.score)
  assert.ok(premiumScore.reasons.includes('FALLBACK:tier-widened'), 'A/S 模型被标注为放宽后才用')
})

test('frugal：没有 C/D 候选时放宽到全体，最便宜的赢', () => {
  const cheapS = score('frugal', scoredModel({ id: 'a', tier: 'S', costPer1kOutput: 0.001, quality_rank: 70 }))
  const priceyA = score('frugal', scoredModel({ id: 'b', tier: 'A', costPer1kOutput: 0.03, quality_rank: 80 }))
  assert.ok(cheapS.score > priceyA.score)
  // 两者都带 FALLBACK 说明；罚分对所有人一样，价格仍然决定次序。
  assert.ok(cheapS.reasons.includes('FALLBACK:tier-widened'))
  assert.ok(priceyA.reasons.includes('FALLBACK:tier-widened'))
})

test('frugal：未定价取中性分， priced 的更便宜者优先', () => {
  const priced = score('frugal', scoredModel({ id: 'a', tier: 'D', costPer1kOutput: 0.001, quality_rank: 30 }))
  const unpriced = score('frugal', scoredModel({ id: 'b', tier: 'D', quality_rank: 30 }))
  assert.ok(priced.score > unpriced.score, '有价且便宜 > 未定价（中性 50）')
  assert.equal(costScoreOf(model({ id: 'c', cost_level: 'medium' })).per1k, null)
  assert.equal(costScoreOf(model({ id: 'c', cost_level: 'medium' })).score, 50, '未定价 = 中性，绝不冒充 0 或 100')
})

test('frugal：reasons 说明为什么选它', () => {
  const result = score('frugal', scoredModel({ id: 'a', tier: 'C', costPer1kOutput: 0.002, quality_rank: 40 }))
  assert.ok(result.reasons.some((reason) => reason.startsWith('PRICE:')))
  assert.ok(result.reasons.includes('TIER:C'))
  assert.ok(result.reasons.some((reason) => reason.startsWith('DIM:')))
})

// ── balanced：A/A+ 门槛先于价格 ──────────────────────────────────────

test('balanced：主维度 B+ 的高分模型，排在主维度 A 的低分模型之后', () => {
  const gated = scoredModel({ id: 'a', tier: 'A', costPer1kOutput: 0.02, dimensions: dims(60, 'A') })
  const ungated = scoredModel({ id: 'b', tier: 'B+', costPer1kOutput: 0.0001, dimensions: dims(90, 'B+') })
  assert.ok(meetsBalancedGate(gated, intent()))
  assert.ok(!meetsBalancedGate(ungated, intent()))
  assert.ok(score('balanced', gated).score > score('balanced', ungated).score)
  assert.ok(score('balanced', ungated).reasons.includes('GATE:BELOW'))
})

test('balanced：A/A+ 门槛内，成本适中者胜出', () => {
  const expensive = scoredModel({ id: 'a', tier: 'SSS', costPer1kOutput: 0.08, dimensions: dims(62, 'A') })
  const moderate = scoredModel({ id: 'b', tier: 'A', costPer1kOutput: 0.004, dimensions: dims(60, 'A') })
  assert.ok(score('balanced', moderate).score > score('balanced', expensive).score)
})

test('balanced：legacy 模型用 quality_rank ≥ 65 等价 A 门槛', () => {
  const legacy = model({ id: 'a', quality_rank: 66 })
  assert.ok(meetsBalancedGate(legacy, intent()))
  assert.ok(!meetsBalancedGate(model({ id: 'b', quality_rank: 64 }), intent()))
})

test('balanced：同一 burst 里已被派过的模型让位，四个并发自然摊到四个模型', () => {
  const entry = scoredModel({ id: 'a', capabilities: ['coding', 'fast'], tier: 'A', dimensions: dims(80, 'A') })
  const first = score('balanced', entry, { burstLoad: 0 })
  const second = score('balanced', entry, { burstLoad: 1 })
  const third = score('balanced', entry, { burstLoad: 2 })
  assert.ok(first.score > second.score)
  assert.ok(second.score > third.score)
  assert.ok(second.reasons.includes('BURST:1'))
})

test('balanced：burst 扣分是决定性的——次选模型反超已派的首选', () => {
  const context = (burstLoad: number): ScoreContext => ({ ...CONTEXT, burstLoad })
  const top = scoredModel({ id: 'top', tier: 'A', quality_rank: 95, dimensions: dims(95, 'A') })
  const next = scoredModel({ id: 'next', tier: 'C', quality_rank: 40, dimensions: dims(40, 'A') })
  const topFresh = scoreModel('balanced', top, intent(), createHealth(0), context(0))
  const nextFresh = scoreModel('balanced', next, intent(), createHealth(0), context(0))
  assert.ok(topFresh.score > nextFresh.score, 'fresh 时门槛 + 质量决定')

  // 首选已被派过一次后，差距再大也必须让位（打散是这个模式的定义）。
  const topUsed = scoreModel('balanced', top, intent(), createHealth(0), context(1))
  assert.ok(nextFresh.score > topUsed.score)
})

test('balanced：在飞请求多的模型让位', () => {
  const busyHealth = createHealth(0)
  busyHealth.inFlight = 2
  const idle = score('balanced', scoredModel({ id: 'a', capabilities: ['coding', 'fast'], tier: 'A', dimensions: dims(70, 'A') }))
  const busy = scoreModel(
    'balanced',
    scoredModel({ id: 'b', capabilities: ['coding', 'fast'], tier: 'A', dimensions: dims(70, 'A') }),
    intent(),
    busyHealth,
    CONTEXT,
  )
  assert.ok(idle.score > busy.score)
})

// ── max_power：六维总和是绝对主序 ────────────────────────────────────

test('max_power：六维总和决定胜负，单项爆表的模型不能翻盘', () => {
  const specialist = scoredModel({ id: 'a', tier: 'S', dimensions: dims(95, 'SSS', 20) })
  const allRound = scoredModel({ id: 'b', tier: 'SS', dimensions: dims(70, 'SS', 70) })
  assert.ok(totalDimensionScore(allRound) > totalDimensionScore(specialist))
  assert.ok(score('max_power', allRound).score > score('max_power', specialist).score)
  assert.ok(score('max_power', allRound).reasons.some((reason) => reason.startsWith('SUM:')))
})

test('max_power：同总和时 Tier 评级破平（评级是独立事实）', () => {
  const crowned = score('max_power', scoredModel({ id: 'a', tier: 'SSS', dimensions: dims(80, 'SS') }))
  const plain = score('max_power', scoredModel({ id: 'b', tier: 'B', dimensions: dims(80, 'SS') }))
  assert.ok(crowned.score > plain.score, '总和相同，SSS 必须排在 B 前面')
})

test('max_power：同分同 Tier 时上下文窗口更大的优先', () => {
  const big = score('max_power', scoredModel({ id: 'a', tier: 'A', dimensions: dims(80, 'A'), context_window: 2_000_000 }))
  const small = score('max_power', scoredModel({ id: 'b', tier: 'A', dimensions: dims(80, 'A'), context_window: 32_000 }))
  assert.ok(big.score > small.score)
})

test('max_power：窗口加成有上限，2M 与 10M 不产生差距', () => {
  const two = score('max_power', scoredModel({ id: 'a', tier: 'A', dimensions: dims(80, 'A'), context_window: 2_000_000 }))
  const ten = score('max_power', scoredModel({ id: 'b', tier: 'A', dimensions: dims(80, 'A'), context_window: 10_000_000 }))
  assert.equal(two.score, ten.score)
})

test('max_power：延迟只做微调，不会让「快但弱」翻盘', () => {
  const strongHealth = healthWithLatency(4_000)
  const weakHealth = healthWithLatency(50)
  const strong = scoreModel('max_power', scoredModel({ id: 'a', tier: 'SS', dimensions: dims(90, 'SS', 80) }), intent(), strongHealth, CONTEXT)
  const weak = scoreModel('max_power', scoredModel({ id: 'b', tier: 'C', dimensions: dims(60, 'B', 40) }), intent(), weakHealth, CONTEXT)
  assert.ok(strong.score > weak.score)
})

test('dimensionReading：六维存在用六维，缺失回退 legacy quality_rank', () => {
  const entry = scoredModel({ id: 'a', quality_rank: 77, dimensions: dims(77, 'SS') })
  assert.equal(dimensionReading(entry, intent()).source, 'six-dim')
  assert.equal(dimensionReading(entry, intent()).score, 77)
  const legacy = model({ id: 'b', quality_rank: 66 })
  const reading = dimensionReading(legacy, intent())
  assert.equal(reading.source, 'legacy')
  assert.equal(reading.score, 66)
  assert.equal(reading.grade, 'legacy')
})

test('isLowTier：C/C+/D 与未评级算低阶，A 及以上不算', () => {
  assert.ok(isLowTier(model({ id: 'a', tier: 'C' })))
  assert.ok(isLowTier(model({ id: 'b', tier: 'C+' })))
  assert.ok(isLowTier(model({ id: 'c', tier: 'D' })))
  assert.ok(isLowTier(model({ id: 'd' })))
  assert.ok(!isLowTier(model({ id: 'e', tier: 'A' })))
  assert.ok(!isLowTier(model({ id: 'f', tier: 'SSS' })))
})

// ── 三模式同场：不同的赢家 ────────────────────────────────────────────

test('三个模式对同一组模型给出不同的赢家，说明模式真的在起作用', () => {
  const lowTier = scoredModel({ id: 'low', tier: 'D', costPer1kOutput: 0.0001, dimensions: dims(35, 'C', 35) })
  const gatedMid = scoredModel({ id: 'mid', tier: 'A', costPer1kOutput: 0.004, dimensions: dims(70, 'A', 65) })
  const strongest = scoredModel({ id: 'strong', tier: 'SSS', costPer1kOutput: 0.05, dimensions: dims(90, 'SSS', 85) })
  const health = createHealth(0)

  const winnerOf = (mode: RoutingMode): string =>
    [lowTier, gatedMid, strongest]
      .map((entry) => ({ id: entry.id, score: scoreModel(mode, entry, intent(), health, CONTEXT).score }))
      .sort((a, b) => b.score - a.score)[0]?.id ?? ''

  assert.equal(winnerOf('frugal'), 'low', '极致便宜：C/D 里最便宜的赢')
  assert.equal(winnerOf('balanced'), 'mid', '效率优先：过 A 门槛里性价比最好的赢')
  assert.equal(winnerOf('max_power'), 'strong', '最强火力：六维总和最高的赢')
})
