/**
 * scorers.ts：三种模式的排序意图（六维评分版）。
 *
 * 每条断言回答一个产品问题：便宜模式会不会偷偷挑贵的、balanced 能不能把
 * 并发摊开、火力模式会不会被「快但弱」的模型翻盘、六维主键是否真的在选路。
 *
 * 两条数据轨道都有覆盖：
 *  - legacy 轨道（fixtures 的 cost_level + quality_rank，无六维）；
 *  - 六维轨道（dimensions + costPer1k + tier，来自厂商目录合成）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SCORERS, scoreModel, scorerFor, dimensionReading, costScoreOf, FRUGAL_FLOOR } from '../src/core/scorers.ts'
import { createHealth } from '../src/core/health.ts'
import { intent, model } from './fixtures.ts'
import type { ModelEntry, RoutingMode, ScoreContext } from '../src/core/types.ts'

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

/** 一张带六维评分的模型卡（目录合成的形态）。 */
function scoredModel(overrides: Partial<ModelEntry> & Pick<ModelEntry, 'id'>): ModelEntry {
  const dim = (value: number) => ({ score: value, grade: value >= 70 ? 'SS' : value >= 50 ? 'A' : 'C' })
  return model({
    ...overrides,
    dimensions: overrides.dimensions ?? {
      reasoning: dim(overrides.quality_rank ?? 50),
      longContext: dim(50),
      coding: dim(overrides.quality_rank ?? 50),
      agentic: dim(50),
      proWork: dim(50),
      factuality: dim(50),
    },
  })
}

test('每个模式都有打分器，未知模式回退到 frugal', () => {
  assert.ok(SCORERS.frugal)
  assert.ok(SCORERS.balanced)
  assert.ok(SCORERS.max_power)
  assert.equal(scorerFor('frugal'), SCORERS.frugal)
  assert.equal(scorerFor('nonsense' as RoutingMode), SCORERS.frugal)
})

// ── frugal：成本是绝对主序 ────────────────────────────────────────────

test('frugal：成本严格主导，便宜的永远排在贵的后面', () => {
  // 质量分全部取在「够用线」之上，让成本单独决定次序（够用线另有专测）。
  const free = score('frugal', model({ id: 'a', cost_level: 'free', quality_rank: 40 }))
  const low = score('frugal', model({ id: 'b', cost_level: 'low', quality_rank: 99 }))
  const medium = score('frugal', model({ id: 'c', cost_level: 'medium', quality_rank: 99 }))
  const high = score('frugal', model({ id: 'd', cost_level: 'high', quality_rank: 100 }))
  assert.ok(free.score > low.score, 'free 必须高于 low')
  assert.ok(low.score > medium.score, 'low 必须高于 medium')
  assert.ok(medium.score > high.score, 'medium 必须高于 high')
})

test('frugal：同档位下质量分只做微调，不会盖过一个档位差', () => {
  const worse = score('frugal', model({ id: 'a', cost_level: 'free', quality_rank: 40 }))
  const better = score('frugal', model({ id: 'b', cost_level: 'free', quality_rank: 100 }))
  assert.ok(better.score > worse.score)
  // 档位内质量贡献最多 1000 分，而 free→low 的档位差是 25_000。
  assert.ok(better.score - worse.score <= 1_000)
  const lowBest = score('frugal', model({ id: 'c', cost_level: 'low', quality_rank: 100 }))
  assert.ok(worse.score > lowBest.score, '免费档最差的也排在低价档最好的前面')
})

test('frugal：主维度低于够用线的模型沉底，但不出局', () => {
  const dumbAndFree = score('frugal', model({ id: 'a', cost_level: 'free', quality_rank: 10 }))
  const priceyAndAble = score('frugal', model({ id: 'b', cost_level: 'high', quality_rank: 60 }))
  assert.ok(priceyAndAble.score > dumbAndFree.score, '够用线以下是「不能胜任」，不是「更便宜」')
  assert.ok(dumbAndFree.reasons.some((reason) => reason.startsWith('below-floor:')))
  // 沉底 ≠ 出局：降级链里仍然存在，只是排到最后。
  assert.equal(FRUGAL_FLOOR, 30)
})

test('frugal：六维成本（costPer1k）参与排序，未定价取中性', () => {
  const cheap = score('frugal', scoredModel({ id: 'a', cost_level: 'medium', costPer1kOutput: 0.001, quality_rank: 50 }))
  const pricey = score('frugal', scoredModel({ id: 'b', cost_level: 'medium', costPer1kOutput: 0.08, quality_rank: 50 }))
  assert.ok(cheap.score > pricey.score, '每千 token 便宜的一方胜出')
  const unpriced = costScoreOf(model({ id: 'c', cost_level: 'medium' }))
  assert.equal(unpriced.per1k, null)
  assert.equal(unpriced.score, 50, '未定价 = 中性分，绝不冒充 0 或 100')
})

test('frugal：同档位时在飞的请求少的优先', () => {
  const idle = score('frugal', model({ id: 'a', cost_level: 'low' }), {})
  const busyHealth = createHealth(0)
  busyHealth.inFlight = 3
  const busy = scoreModel('frugal', model({ id: 'b', cost_level: 'low' }), intent(), busyHealth, CONTEXT)
  assert.ok(idle.score > busy.score)
})

test('frugal：reasons 说明为什么选它', () => {
  const result = score('frugal', model({ id: 'a', cost_level: 'free' }))
  assert.ok(result.reasons.includes('cost:free'))
  assert.ok(result.reasons.some((reason) => reason.startsWith('dim reasoning:')))
  assert.ok(result.reasons.some((reason) => reason.startsWith('inflight:')))
})

// ── balanced：质量 × 成本 的混合 + 决定性的并发打散 ────────────────────

test('balanced：质量与成本按 0.65/0.35 混合，不是被成本档位牵着走', () => {
  // 中等成本的中强模型胜过免费的弱模型（成本拉不平质量差）。
  const midStrong = score('balanced', model({ id: 'a', cost_level: 'medium', quality_rank: 75 }))
  const freeWeak = score('balanced', model({ id: 'b', cost_level: 'free', quality_rank: 30 }))
  assert.ok(midStrong.score > freeWeak.score, '0.65×75+0.35×50 > 0.65×30+0.35×100')
  // 但「贵得多且只强一点」会被成本拉回来。
  const pricey = score('balanced', model({ id: 'c', cost_level: 'high', quality_rank: 60 }))
  const cheapDecent = score('balanced', model({ id: 'd', cost_level: 'free', quality_rank: 55 }))
  assert.ok(cheapDecent.score > pricey.score, '0.65×55+0.35×100 > 0.65×60+0.35×20')
})

test('balanced：六维主维度参与混合——coding 请求看 scores.coding', () => {
  const coder = scoredModel({ id: 'a', cost_level: 'medium', quality_rank: 90 })
  // 六维轨道：主维度分数来自 scores.coding，面板 reasons 里能看到来源。
  const higherCoding = score('balanced', coder)
  const reading = dimensionReading(coder, intent())
  assert.equal(reading.source, 'six-dim')
  assert.equal(reading.score, 90)
  assert.ok(higherCoding.score > 0)
})

test('balanced：同一 burst 里已被派过的模型让位，四个并发自然摊到四个模型', () => {
  const entry = model({ id: 'a', capabilities: ['coding', 'fast'] })
  const first = score('balanced', entry, { burstLoad: 0 })
  const second = score('balanced', entry, { burstLoad: 1 })
  const third = score('balanced', entry, { burstLoad: 2 })
  assert.ok(first.score > second.score)
  assert.ok(second.score > third.score)
  assert.ok(second.reasons.includes('burst:1'))
})

test('balanced：burst 扣分是决定性的——次选模型反超已派的首选', () => {
  const context = (burstLoad: number): ScoreContext => ({ ...CONTEXT, burstLoad })
  const top = model({ id: 'top', capabilities: ['coding', 'fast'], quality_rank: 95, cost_level: 'medium' })
  const next = model({ id: 'next', capabilities: ['coding', 'fast'], quality_rank: 40, cost_level: 'high' })
  const topFresh = scoreModel('balanced', top, intent(), createHealth(0), context(0))
  const nextFresh = scoreModel('balanced', next, intent(), createHealth(0), context(0))
  assert.ok(topFresh.score > nextFresh.score, ' fresh 时质量决定')

  // 首选已被派过一次后，差距再大也必须让位（打散是这个模式的定义）。
  const topUsed = scoreModel('balanced', top, intent(), createHealth(0), context(1))
  assert.ok(nextFresh.score > topUsed.score)
})

test('balanced：在飞请求多的模型让位', () => {
  const busyHealth = createHealth(0)
  busyHealth.inFlight = 2
  const idle = score('balanced', model({ id: 'a', capabilities: ['coding', 'fast'] }))
  const busy = scoreModel('balanced', model({ id: 'b', capabilities: ['coding', 'fast'] }), intent(), busyHealth, CONTEXT)
  assert.ok(idle.score > busy.score)
})

// ── max_power：请求主维度的六维分数是绝对主序 ─────────────────────────

test('max_power：主维度分数是主序，贵的弱的都压不住', () => {
  const strong = score('max_power', model({ id: 'a', quality_rank: 95, cost_level: 'high' }))
  const weak = score('max_power', model({ id: 'b', quality_rank: 40, cost_level: 'free', capabilities: ['coding', 'fast'] }))
  assert.ok(strong.score > weak.score)
})

test('max_power：同主维度分数时 Tier 评级破平（评级是独立事实）', () => {
  const crowned = score('max_power', scoredModel({ id: 'a', quality_rank: 80, tier: 'SSS' }))
  const plain = score('max_power', scoredModel({ id: 'b', quality_rank: 80, tier: 'B' }))
  assert.ok(crowned.score > plain.score, 'SSS 必须排在 B 前面——哪怕六维分数完全相同')
})

test('max_power：同分同 Tier 时上下文窗口更大的优先', () => {
  const big = score('max_power', model({ id: 'a', quality_rank: 80, context_window: 2_000_000 }))
  const small = score('max_power', model({ id: 'b', quality_rank: 80, context_window: 32_000 }))
  assert.ok(big.score > small.score)
})

test('max_power：窗口加成有上限，2M 与 10M 不产生差距', () => {
  const two = score('max_power', model({ id: 'a', quality_rank: 80, context_window: 2_000_000 }))
  const ten = score('max_power', model({ id: 'b', quality_rank: 80, context_window: 10_000_000 }))
  assert.equal(two.score, ten.score)
})

test('max_power：延迟只做微调，不会让「快但弱」翻盘', () => {
  const strongHealth = healthWithLatency(4_000)
  const weakHealth = healthWithLatency(50)
  const strong = scoreModel('max_power', model({ id: 'a', quality_rank: 95 }), intent(), strongHealth, CONTEXT)
  const weak = scoreModel('max_power', model({ id: 'b', quality_rank: 60 }), intent(), weakHealth, CONTEXT)
  assert.ok(strong.score > weak.score)
})

test('dimensionReading：六维存在用六维，缺失回退 legacy quality_rank', () => {
  const entry = scoredModel({ id: 'a', quality_rank: 77 })
  assert.equal(dimensionReading(entry, intent()).source, 'six-dim')
  assert.equal(dimensionReading(entry, intent()).score, 77)
  const legacy = model({ id: 'b', quality_rank: 66 })
  const reading = dimensionReading(legacy, intent())
  assert.equal(reading.source, 'legacy')
  assert.equal(reading.score, 66)
  assert.equal(reading.grade, 'legacy')
})

// ── 三模式同场：不同的赢家 ────────────────────────────────────────────

test('三个模式对同一组模型给出不同的赢家，说明模式真的在起作用', () => {
  // 质量都取在够用线之上，让模式差异（而非 floor）决定赢家。
  const cheap = model({ id: 'cheap', cost_level: 'free', quality_rank: 40, capabilities: ['coding'] })
  const quick = model({ id: 'quick', cost_level: 'medium', quality_rank: 75, capabilities: ['coding', 'fast'] })
  const strong = model({ id: 'strong', cost_level: 'high', quality_rank: 85, capabilities: ['coding', 'reasoning'] })
  const health = createHealth(0)

  const winnerOf = (mode: RoutingMode): string =>
    [cheap, quick, strong]
      .map((entry) => ({ id: entry.id, score: scoreModel(mode, entry, intent(), health, CONTEXT).score }))
      .sort((a, b) => b.score - a.score)[0]?.id ?? ''

  assert.equal(winnerOf('frugal'), 'cheap', '极致便宜：免费的赢')
  assert.equal(winnerOf('balanced'), 'quick', '效率优先：性价比最好的赢')
  assert.equal(winnerOf('max_power'), 'strong', '最强火力：最强的赢')
})
