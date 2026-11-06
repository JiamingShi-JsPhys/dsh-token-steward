/**
 * scorers.ts：三种模式的排序意图。
 *
 * 每条断言回答一个产品问题：便宜模式会不会偷偷挑贵的、效率模式能不能把
 * 并发摊开、火力模式会不会被「快但弱」的模型翻盘。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SCORERS, scoreModel, scorerFor } from '../src/core/scorers.ts'
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

test('每个模式都有打分器，未知模式回退到 frugal', () => {
  assert.ok(SCORERS.frugal)
  assert.ok(SCORERS.efficiency)
  assert.ok(SCORERS.max_power)
  assert.equal(scorerFor('frugal'), SCORERS.frugal)
  assert.equal(scorerFor('nonsense' as RoutingMode), SCORERS.frugal)
})

test('frugal：成本档位严格主导，便宜的永远排在贵的后面', () => {
  const free = score('frugal', model({ id: 'a', cost_level: 'free', quality_rank: 1 }))
  const low = score('frugal', model({ id: 'b', cost_level: 'low', quality_rank: 99 }))
  const medium = score('frugal', model({ id: 'c', cost_level: 'medium', quality_rank: 99 }))
  const high = score('frugal', model({ id: 'd', cost_level: 'high', quality_rank: 100 }))
  assert.ok(free.score > low.score, 'free 必须高于 low')
  assert.ok(low.score > medium.score, 'low 必须高于 medium')
  assert.ok(medium.score > high.score, 'medium 必须高于 high')
})

test('frugal：同档位下质量分只做微调，不会盖过成本', () => {
  const worse = score('frugal', model({ id: 'a', cost_level: 'free', quality_rank: 1 }))
  const better = score('frugal', model({ id: 'b', cost_level: 'free', quality_rank: 100 }))
  assert.ok(better.score > worse.score)
  // 质量分最多贡献 1 分，远小于一个档位差（200）
  assert.ok(better.score - worse.score <= 1)
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
  assert.ok(result.reasons.some((reason) => reason.startsWith('inflight:')))
})

test('efficiency：fast 标签的模型明显靠前', () => {
  const fast = score('efficiency', model({ id: 'a', capabilities: ['coding', 'fast'], cost_level: 'high' }))
  const slow = score('efficiency', model({ id: 'b', capabilities: ['coding'], cost_level: 'free' }))
  assert.ok(fast.score > slow.score, '效率模式不该被成本档位牵着走')
  assert.ok(fast.reasons.includes('tag:fast'))
})

test('efficiency：已知延迟低的优先于未知延迟的', () => {
  const quick = scoreModel('efficiency', model({ id: 'a', capabilities: ['coding', 'fast'] }), intent(), healthWithLatency(120), CONTEXT)
  const unknown = score('efficiency', model({ id: 'b', capabilities: ['coding', 'fast'] }))
  assert.ok(quick.score > unknown.score)
})

test('efficiency：延迟越高分越低', () => {
  const quick = scoreModel('efficiency', model({ id: 'a' }), intent(), healthWithLatency(100), CONTEXT)
  const slow = scoreModel('efficiency', model({ id: 'b' }), intent(), healthWithLatency(3_000), CONTEXT)
  assert.ok(quick.score > slow.score)
})

test('efficiency：同一 burst 里已被派过的模型让位，四个并发自然摊到四个模型', () => {
  const entry = model({ id: 'a', capabilities: ['coding', 'fast'] })
  const first = score('efficiency', entry, { burstLoad: 0 })
  const second = score('efficiency', entry, { burstLoad: 1 })
  const third = score('efficiency', entry, { burstLoad: 2 })
  assert.ok(first.score > second.score)
  assert.ok(second.score > third.score)
  assert.ok(second.reasons.includes('burst:1'))
})

test('efficiency：burst 扣分足以让次选模型反超首选', () => {
  const context = (burstLoad: number): ScoreContext => ({ ...CONTEXT, burstLoad })
  const top = model({ id: 'top', capabilities: ['coding', 'fast'], quality_rank: 80 })
  const next = model({ id: 'next', capabilities: ['coding', 'fast'], quality_rank: 70 })
  const topFresh = scoreModel('efficiency', top, intent(), createHealth(0), context(0))
  const nextFresh = scoreModel('efficiency', next, intent(), createHealth(0), context(0))
  assert.ok(topFresh.score > nextFresh.score)

  // 首选已被派过一次后，次选应当反超
  const topUsed = scoreModel('efficiency', top, intent(), createHealth(0), context(1))
  assert.ok(nextFresh.score > topUsed.score)
})

test('efficiency：在飞请求多的模型让位', () => {
  const busyHealth = createHealth(0)
  busyHealth.inFlight = 2
  const idle = score('efficiency', model({ id: 'a', capabilities: ['coding', 'fast'] }))
  const busy = scoreModel('efficiency', model({ id: 'b', capabilities: ['coding', 'fast'] }), intent(), busyHealth, CONTEXT)
  assert.ok(idle.score > busy.score)
})

test('max_power：质量分是主序，贵的弱的都压不住', () => {
  const strong = score('max_power', model({ id: 'a', quality_rank: 95, cost_level: 'high' }))
  const weak = score('max_power', model({ id: 'b', quality_rank: 40, cost_level: 'free', capabilities: ['coding', 'fast'] }))
  assert.ok(strong.score > weak.score)
})

test('max_power：同质量分时能力标签更全的优先', () => {
  const omni = score('max_power', model({ id: 'a', quality_rank: 80, capabilities: ['coding', 'reasoning', 'vision', 'tool-use'] }))
  const narrow = score('max_power', model({ id: 'b', quality_rank: 80, capabilities: ['coding'] }))
  assert.ok(omni.score > narrow.score)
})

test('max_power：同质量同能力时上下文窗口更大的优先', () => {
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

test('三个模式对同一组模型给出不同的赢家，说明模式真的在起作用', () => {
  const cheap = model({ id: 'cheap', cost_level: 'free', quality_rank: 20, capabilities: ['coding'] })
  const quick = model({ id: 'quick', cost_level: 'high', quality_rank: 60, capabilities: ['coding', 'fast'] })
  const strong = model({ id: 'strong', cost_level: 'high', quality_rank: 99, capabilities: ['coding', 'reasoning'] })
  const health = createHealth(0)

  const frugalWinner = [cheap, quick, strong]
    .map((entry) => ({ id: entry.id, score: scoreModel('frugal', entry, intent(), health, CONTEXT).score }))
    .sort((a, b) => b.score - a.score)[0]
  const efficiencyWinner = [cheap, quick, strong]
    .map((entry) => ({ id: entry.id, score: scoreModel('efficiency', entry, intent(), health, CONTEXT).score }))
    .sort((a, b) => b.score - a.score)[0]
  const powerWinner = [cheap, quick, strong]
    .map((entry) => ({ id: entry.id, score: scoreModel('max_power', entry, intent(), health, CONTEXT).score }))
    .sort((a, b) => b.score - a.score)[0]

  assert.equal(frugalWinner?.id, 'cheap')
  assert.equal(efficiencyWinner?.id, 'quick')
  assert.equal(powerWinner?.id, 'strong')
})
