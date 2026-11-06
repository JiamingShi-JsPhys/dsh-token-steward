/**
 * router.ts：硬过滤、三模式选路、降级链、容灾与快照。
 *
 * 这些断言是网关的合同：网关只负责照 decision 发请求、照 result 回报，
 * 所有「该选谁」「该不该换人」的判断都在这里被钉死。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRouter, filterReason, modelKey } from '../src/core/router.ts'
import { canonicalModelId, parseVirtualModel } from '../src/core/intent.ts'
import { intent, matrix, model, provider } from './fixtures.ts'
import type { AttemptResult, PoolConfig } from '../src/core/types.ts'

function fail(providerName: string, modelId: string, errorKind: NonNullable<AttemptResult['errorKind']>, requestId = 'r1'): AttemptResult {
  return { requestId, provider: providerName, model: modelId, ok: false, errorKind, latencyMs: 100, committed: false }
}

function ok(providerName: string, modelId: string, requestId = 'r1'): AttemptResult {
  return { requestId, provider: providerName, model: modelId, ok: true, latencyMs: 120, committed: false }
}

/** 只取决策，断言失败时给出可读信息。 */
function decide(config: PoolConfig, options: Parameters<typeof createRouter>[1], route = intent()) {
  const router = createRouter(config, options)
  const result = router.plan(route, 1_000, 'r1')
  assert.ok(result.ok, 'expected a decision, got refusal: ' + JSON.stringify(result.ok ? {} : result.refusal))
  return { router, decision: result.decision }
}

test('modelKey 拼写稳定', () => {
  assert.equal(modelKey('p', 'm'), 'p/m')
})

test('filterReason：缺少能力标签即淘汰', () => {
  const entry = model({ id: 'm', capabilities: ['coding'] })
  assert.equal(filterReason(entry, intent({ requiredCapabilities: ['coding', 'vision'] })),
    'missing-capability:vision')
  assert.equal(filterReason(entry, intent({ requiredCapabilities: ['coding'] })), undefined)
})

test('filterReason：向量 / 重排模型永远不作对话候选', () => {
  const embedding = { ...model({ id: 'qwen-embedding-8b', capabilities: ['coding'] }), chat: false }
  assert.equal(filterReason(embedding, intent()), 'not-a-chat-model')
  // 其余模型不受影响。
  assert.equal(filterReason(model({ id: 'qwen' }), intent()), undefined)
})

test('filterReason：缺少输入模态即淘汰', () => {
  const entry = model({ id: 'm', input_modalities: ['text'] })
  assert.equal(filterReason(entry, intent({ requiredModalities: ['image'] })), 'missing-modality:image')
})

test('filterReason：带 tools 的请求隐式要求 tool-use', () => {
  const entry = model({ id: 'm', capabilities: ['coding'] })
  assert.equal(filterReason(entry, intent({ needsTools: true })), 'missing-capability:tool-use')
})

test('filterReason：窗口只按输入卡，max_tokens 要得再大也不淘汰', () => {
  const entry = model({ id: 'm', context_window: 32_000 })
  // 输入 30k 放得下：客户端张口要 8k 输出也照收——输出量由网关按剩余窗口压，
  // 拿「输入 + 期望输出」当硬门槛会把 DSH 这种动辄要 64k 的客户端全挡死。
  assert.equal(
    filterReason(entry, intent({ estimatedInputTokens: 30_000, expectedOutputTokens: 8_000 })),
    undefined,
  )
  // 输入本身就放不下：仍然淘汰。
  assert.equal(
    filterReason(entry, intent({ estimatedInputTokens: 40_000, expectedOutputTokens: 8_000 })),
    'window-too-small:32000<40256',
  )
})

test('filterReason：offline 模型直接淘汰', () => {
  const entry = model({ id: 'm', availability: 'offline' })
  assert.equal(filterReason(entry, intent()), 'offline')
})

test('frugal 模式选中最便宜的可用模型', () => {
  const { decision } = decide(matrix(), undefined)
  assert.equal(decision.chosen.provider, 'freebox')
  assert.equal(decision.chosen.model, 'free-slow')
  assert.equal(decision.mode, 'frugal')
})

test('frugal 模式在需要 vision 时被迫升级到全能模型', () => {
  const { decision } = decide(matrix(), undefined, intent({ requiredCapabilities: ['coding', 'vision'], requiredModalities: ['text', 'image'] }))
  assert.equal(decision.chosen.provider, 'premium')
  assert.equal(decision.chosen.model, 'omni-pro')
})

test('balanced 模式选中质量成本比最优的模型（0.65 质量 + 0.35 成本）', () => {
  const { router, decision } = decide(matrix(), undefined)
  router.setMode('balanced')
  const next = router.plan(intent(), 1_000, 'r2')
  assert.ok(next.ok)
  // blend：free-slow 54.5 / fast-mid 53.25 / omni-pro 72 —— 质量占优者胜。
  assert.equal(next.decision.chosen.provider, 'premium')
  assert.equal(next.decision.chosen.model, 'omni-pro')
  assert.equal(decision.mode, 'frugal')
})

test('max_power 模式选中质量分最高的模型', () => {
  const { router } = decide(matrix(), undefined)
  router.setMode('max_power')
  const next = router.plan(intent(), 1_000, 'r2')
  assert.ok(next.ok)
  assert.equal(next.decision.chosen.model, 'omni-pro')
})

test('降级链覆盖后续候选，且按分数排序', () => {
  const { decision } = decide(matrix(), { maxAttempts: 3 })
  assert.equal(decision.fallbacks.length, 2)
  const keys = decision.fallbacks.map((candidate) => modelKey(candidate.provider, candidate.model))
  assert.equal(keys[0], 'midbox/fast-mid')
  assert.equal(keys[1], 'premium/omni-pro')
})

test('maxAttempts=1 时不产生降级链，并注明候选不足', () => {
  const { decision } = decide(matrix(), { maxAttempts: 1 })
  assert.equal(decision.fallbacks.length, 0)
  assert.ok(decision.notes.some((note) => note.startsWith('no-fallback:')))
})

test('降级链不重复同一个模型', () => {
  const { decision } = decide(matrix(), { maxAttempts: 10 })
  const keys = [decision.chosen, ...decision.fallbacks].map((candidate) => modelKey(candidate.provider, candidate.model))
  assert.equal(new Set(keys).size, keys.length)
})

test('首选进入冷却后，同一模式的下一请求自动换人', () => {
  const router = createRouter(matrix(), { maxAttempts: 3 })
  const first = router.plan(intent(), 1_000, 'r1')
  assert.ok(first.ok)
  const chosen = first.decision.chosen
  router.report(fail(chosen.provider, chosen.model, 'rate-limit'), 1_100)

  const second = router.plan(intent(), 1_200, 'r2')
  assert.ok(second.ok)
  assert.notEqual(modelKey(second.decision.chosen.provider, second.decision.chosen.model),
    modelKey(chosen.provider, chosen.model))
})

test('冷却到期后原模型重新参与竞争', () => {
  const router = createRouter(matrix(), { maxAttempts: 3, cooldownMs: 1_000 })
  const first = router.plan(intent(), 1_000, 'r1')
  assert.ok(first.ok)
  const chosen = first.decision.chosen
  router.report(fail(chosen.provider, chosen.model, 'rate-limit'), 1_100)

  const later = router.plan(intent(), 60_000, 'r2')
  assert.ok(later.ok)
  assert.equal(later.decision.chosen.model, chosen.model)
})

test('所有模型都熔断时返回 all-models-cooling 而不是抛错', () => {
  const single: PoolConfig = {
    version: 1,
    defaults: matrix().defaults,
    routing: matrix().routing,
    providers: [provider('only', [model({ id: 'solo', cost_level: 'free' })])],
  }
  const router = createRouter(single, { failureThreshold: 1 })
  const first = router.plan(intent(), 1_000, 'r1')
  assert.ok(first.ok)
  router.report(fail('only', 'solo', 'server'), 1_100)

  const second = router.plan(intent(), 1_200, 'r2')
  assert.equal(second.ok, false)
  if (second.ok) return
  assert.equal(second.refusal.code, 'all-models-cooling')
  assert.equal(second.refusal.rejected[0]?.reason, 'circuit-open')
})

test('没有模型能满足能力要求时返回 no-capable-model 并列出原因', () => {
  const router = createRouter(matrix(), undefined)
  const result = router.plan(intent({ requiredCapabilities: ['coding', 'audio-transcription' as 'coding'] }), 1_000, 'r1')
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.refusal.code, 'no-capable-model')
  assert.equal(result.refusal.rejected.length, 4)
  assert.ok(result.refusal.rejected.every((entry) => entry.reason === 'missing-capability:audio-transcription'))
})

test('成功上报后写入一条路由事件', () => {
  const router = createRouter(matrix(), undefined)
  const planned = router.plan(intent(), 1_000, 'r1')
  assert.ok(planned.ok)
  const chosen = planned.decision.chosen
  router.report(ok(chosen.provider, chosen.model), 1_500)

  const snapshot = router.snapshot(2_000)
  assert.equal(snapshot.recent.length, 1)
  assert.equal(snapshot.recent[0]?.ok, true)
  assert.equal(snapshot.recent[0]?.degradedFrom.length, 0)
  assert.equal(snapshot.recent[0]?.latencyMs, 500)
  assert.equal(snapshot.totals.degradedRequests, 0)
})

test('降级一次后再成功：事件记录完整降级链，并计入降级请求数', () => {
  const router = createRouter(matrix(), undefined)
  const planned = router.plan(intent(), 1_000, 'r1')
  assert.ok(planned.ok)
  const chosen = planned.decision.chosen
  const fallback = planned.decision.fallbacks[0]
  assert.ok(fallback)

  router.report(fail(chosen.provider, chosen.model, 'rate-limit'), 1_100)
  assert.equal(router.snapshot(1_200).recent.length, 0, '未收口前不该产生事件')

  router.report(ok(fallback.provider, fallback.model), 1_400)
  const snapshot = router.snapshot(2_000)
  assert.equal(snapshot.recent.length, 1)
  assert.equal(snapshot.recent[0]?.provider, fallback.provider)
  assert.equal(snapshot.recent[0]?.degradedFrom.length, 1)
  assert.equal(snapshot.recent[0]?.degradedFrom[0]?.errorKind, 'rate-limit')
  assert.equal(snapshot.totals.degradedRequests, 1)
})

test('已提交首字节后失败：不可降级，直接收口为失败事件', () => {
  const router = createRouter(matrix(), undefined)
  const planned = router.plan(intent(), 1_000, 'r1')
  assert.ok(planned.ok)
  const chosen = planned.decision.chosen

  router.report({
    requestId: 'r1',
    provider: chosen.provider,
    model: chosen.model,
    ok: false,
    errorKind: 'transport',
    latencyMs: 5_000,
    committed: true,
  }, 6_000)

  const snapshot = router.snapshot(7_000)
  assert.equal(snapshot.recent.length, 1)
  assert.equal(snapshot.recent[0]?.ok, false)
  assert.equal(snapshot.recent[0]?.committed, true)
  assert.equal(snapshot.recent[0]?.degradedFrom.length, 0)
})

test('候选耗尽（final 标记）时收口为失败事件，且不含自身', () => {
  const router = createRouter(matrix(), { maxAttempts: 2 })
  const planned = router.plan(intent(), 1_000, 'r1')
  assert.ok(planned.ok)
  const chosen = planned.decision.chosen
  const fallback = planned.decision.fallbacks[0]
  assert.ok(fallback)

  router.report(fail(chosen.provider, chosen.model, 'timeout'), 1_100)
  router.report({
    requestId: 'r1',
    provider: fallback.provider,
    model: fallback.model,
    ok: false,
    errorKind: 'timeout',
    latencyMs: 900,
    committed: false,
    final: true,
  }, 2_100)

  const snapshot = router.snapshot(3_000)
  assert.equal(snapshot.recent.length, 1)
  assert.equal(snapshot.recent[0]?.ok, false)
  assert.equal(snapshot.recent[0]?.degradedFrom.length, 1)
})

test('未知 requestId 的上报不会凭空造出事件', () => {
  const router = createRouter(matrix(), undefined)
  router.report(ok('freebox', 'free-slow', 'ghost'), 1_000)
  assert.equal(router.snapshot(2_000).recent.length, 0)
})

test('路由事件环形缓冲有上限，最旧的先丢', () => {
  const router = createRouter(matrix(), undefined)
  for (let index = 0; index < 60; index += 1) {
    const id = 'r' + String(index)
    const planned = router.plan(intent(), 1_000 + index, id)
    assert.ok(planned.ok)
    const chosen = planned.decision.chosen
    router.report(ok(chosen.provider, chosen.model, id), 1_500 + index)
  }
  const snapshot = router.snapshot(5_000)
  assert.equal(snapshot.recent.length, 40)
  assert.equal(snapshot.recent[39]?.requestId, 'r59')
})

test('setMode 切换后 plan 立刻按新模式决策', () => {
  const router = createRouter(matrix(), undefined)
  assert.equal(router.getMode(), 'frugal')
  assert.equal(router.setMode('max_power'), 'max_power')
  assert.equal(router.getMode(), 'max_power')
  const planned = router.plan(intent(), 1_000, 'r1')
  assert.ok(planned.ok)
  assert.equal(planned.decision.chosen.model, 'omni-pro')
})

test('balanced 模式在 burst 内把四个并发摊到四个不同模型', () => {
  const config = matrix()
  // Balanced 先过 A 门槛：让四个候选都达标，测的才是打散本身。
  for (const provider of config.providers) {
    for (const model of provider.models) model.quality_rank = Math.max(model.quality_rank, 70)
  }
  const router = createRouter(config, { maxAttempts: 1 }, 'balanced')
  const picks: string[] = []
  for (let index = 0; index < 4; index += 1) {
    const planned = router.plan(intent({ burstKey: 'swarm-1' }), 1_000 + index, 'r' + String(index))
    assert.ok(planned.ok)
    picks.push(modelKey(planned.decision.chosen.provider, planned.decision.chosen.model))
  }
  assert.equal(new Set(picks).size, 4, 'same burst must spread across models, got ' + picks.join(', '))
})

test('burst 过了记忆窗口后重新从零开始计数', () => {
  const router = createRouter(matrix(), { maxAttempts: 1 }, 'balanced')
  const first = router.plan(intent({ burstKey: 'k' }), 1_000, 'r1')
  assert.ok(first.ok)
  const second = router.plan(intent({ burstKey: 'k' }), 1_000 + 10_000, 'r2')
  assert.ok(second.ok)
  assert.equal(modelKey(second.decision.chosen.provider, second.decision.chosen.model),
    modelKey(first.decision.chosen.provider, first.decision.chosen.model))
})

test('并发满额的模型被排除，原因写明 concurrency-full', () => {
  const config: PoolConfig = {
    version: 1,
    defaults: matrix().defaults,
    routing: matrix().routing,
    providers: [provider('only', [model({ id: 'solo', cost_level: 'free', max_concurrency: 1 })])],
  }
  const router = createRouter(config, undefined)
  const first = router.plan(intent(), 1_000, 'r1')
  assert.ok(first.ok)

  const second = router.plan(intent(), 1_100, 'r2')
  assert.equal(second.ok, false)
  if (second.ok) return
  assert.equal(second.refusal.rejected[0]?.reason, 'concurrency-full')
})

test('subagent 并发：同一模型并发满后自动溢出到下一个候选', () => {
  const config: PoolConfig = {
    version: 1,
    defaults: matrix().defaults,
    routing: matrix().routing,
    providers: [
      provider('a', [model({ id: 'a1', cost_level: 'free', max_concurrency: 1 })]),
      provider('b', [model({ id: 'b1', cost_level: 'low', max_concurrency: 1 })]),
    ],
  }
  const router = createRouter(config, undefined)
  const first = router.plan(intent(), 1_000, 'r1')
  const second = router.plan(intent(), 1_000, 'r2')
  assert.ok(first.ok)
  assert.ok(second.ok)
  assert.equal(first.decision.chosen.model, 'a1')
  assert.equal(second.decision.chosen.model, 'b1')
})

test('noteAgent 记录 agent 当前模型并可被快照读出', () => {
  const router = createRouter(matrix(), undefined)
  router.noteAgent('visual_agent', 'premium', 'omni-pro', 1_000)
  router.noteAgent('visual_agent', 'premium', 'omni-pro', 2_000)
  router.noteAgent('analysis_agent', 'midbox', 'fast-mid', 1_500)

  const snapshot = router.snapshot(3_000)
  assert.equal(snapshot.agents.length, 2)
  assert.equal(snapshot.agents[0]?.agentId, 'visual_agent')
  assert.equal(snapshot.agents[0]?.requests, 2)
  assert.equal(snapshot.agents[1]?.model, 'fast-mid')
})

test('快照区分「未定价」与「免费」：没有定价表的模型计入 unpricedModels', () => {
  const config: PoolConfig = {
    version: 1,
    defaults: matrix().defaults,
    routing: matrix().routing,
    providers: [provider('only', [
      model({ id: 'nopricing' }),
      model({ id: 'priced', pricing: { currency: 'CNY', input_per_mtok: 1, output_per_mtok: 2 } }),
    ])],
  }
  const router = createRouter(config, undefined)
  const snapshot = router.snapshot(1_000)
  assert.equal(snapshot.totals.unpricedModels, 1)
  assert.equal(snapshot.models[0]?.todayCost, null)
  assert.equal(snapshot.totals.todayCost, null)
})

test('快照按币种汇总成本，混币时不给总额', () => {
  const config: PoolConfig = {
    version: 1,
    defaults: matrix().defaults,
    routing: matrix().routing,
    providers: [
      provider('cny', [model({ id: 'c1', pricing: { currency: 'CNY', input_per_mtok: 1, output_per_mtok: 1 } })]),
      provider('usd', [model({ id: 'u1', pricing: { currency: 'USD', input_per_mtok: 1, output_per_mtok: 1 } })]),
    ],
  }
  const router = createRouter(config, undefined)
  const mixed = router.snapshot(1_000, {
    usage: {
      'cny/c1': { todayTokens: 100, todayCost: { currency: 'CNY', amount: 1.5 }, cacheHitRate: null },
      'usd/u1': { todayTokens: 200, todayCost: { currency: 'USD', amount: 2.5 }, cacheHitRate: null },
    },
  })
  assert.equal(mixed.totals.todayCost, null, '两种货币绝不相加')

  const single = router.snapshot(1_100, {
    usage: {
      'cny/c1': { todayTokens: 100, todayCost: { currency: 'CNY', amount: 1.5 }, cacheHitRate: 0.5 },
      'usd/u1': { todayTokens: 0, todayCost: null, cacheHitRate: null },
    },
  })
  assert.deepEqual(single.totals.todayCost, { currency: 'CNY', amount: 1.5 })
  assert.equal(single.totals.todayTokens, 100)
  assert.equal(single.totals.cacheHitRate, 0.5)
})

test('快照 usageAvailable 随计量来源切换', () => {
  const router = createRouter(matrix(), undefined)
  assert.equal(router.snapshot(1_000).usageAvailable, false)
  assert.equal(router.snapshot(1_100, { usageAvailable: false }).usageAvailable, false)
  assert.equal(router.snapshot(1_200, { usageAvailable: true }).usageAvailable, true)
})

test('快照 revision 单调递增', () => {
  const router = createRouter(matrix(), undefined)
  const first = router.snapshot(1_000).revision
  const second = router.snapshot(1_100).revision
  const third = router.snapshot(1_200).revision
  assert.ok(first < second && second < third)
})

test('快照如实反映 pool.status，rejected 时带上错误行', () => {
  const router = createRouter(matrix(), undefined)
  const snapshot = router.snapshot(1_000, { pool: { status: 'rejected', source: 'model_pool.yaml', error: 'bad yaml' } })
  assert.equal(snapshot.pool.status, 'rejected')
  assert.equal(snapshot.pool.error, 'bad yaml')
})

test('快照里的健康状态反映熔断结果', () => {
  const config: PoolConfig = {
    version: 1,
    defaults: matrix().defaults,
    routing: matrix().routing,
    providers: [provider('only', [model({ id: 'solo' })])],
  }
  const router = createRouter(config, { failureThreshold: 1 })
  router.plan(intent(), 1_000, 'r1')
  router.report(fail('only', 'solo', 'server'), 1_100)
  const snapshot = router.snapshot(1_200)
  assert.equal(snapshot.models[0]?.health, 'open')
  assert.ok((snapshot.models[0]?.resumeAt ?? 0) > 1_100)
})

test('healthOf 暴露单个模型的健康记录', () => {
  const router = createRouter(matrix(), undefined)
  router.plan(intent(), 1_000, 'r1')
  const health = router.healthOf('freebox', 'free-slow')
  assert.ok(health)
  assert.equal(health?.inFlight, 1)
  assert.equal(router.healthOf('nope', 'nope'), undefined)
})

test('listModels 保持配置顺序，options 回填缺省值', () => {
  const router = createRouter(matrix(), {})
  const models = router.listModels().map((entry: { key: string }) => entry.key)
  assert.deepEqual(models, ['freebox/free-slow', 'midbox/fast-mid', 'premium/omni-pro', 'huge/huge-window'])
  const options = router.options()
  assert.equal(options.maxAttempts, 3)
  assert.equal(options.cooldownMs, 30_000)
  assert.equal(options.failureThreshold, 3)
  assert.equal(options.halfOpenAfterMs, 60_000)
})

test('plan 不修改健康状态之外的东西：连续 plan 不产生事件也不改延迟', () => {
  const router = createRouter(matrix(), undefined)
  router.plan(intent(), 1_000, 'r1')
  router.plan(intent(), 1_100, 'r2')
  const health = router.healthOf('freebox', 'free-slow')
  assert.equal(health?.ewmaLatencyMs, undefined)
  assert.equal(router.snapshot(1_200).recent.length, 0)
})

test('同一模型 max_concurrency=2 时两个并发都能进去，第三个溢出', () => {
  const config: PoolConfig = {
    version: 1,
    defaults: matrix().defaults,
    routing: matrix().routing,
    providers: [
      provider('a', [model({ id: 'a1', cost_level: 'free', max_concurrency: 2 })]),
      provider('b', [model({ id: 'b1', cost_level: 'high', max_concurrency: 2 })]),
    ],
  }
  const router = createRouter(config, undefined)
  assert.equal(router.plan(intent(), 1_000, 'r1').ok, true)
  assert.equal(router.plan(intent(), 1_000, 'r2').ok, true)
  const third = router.plan(intent(), 1_000, 'r3')
  assert.ok(third.ok)
  if (!third.ok) return
  assert.equal(third.decision.chosen.model, 'b1')
})

/* ────────────────────────── 今日已省 ────────────────────────── */

test('快照记今日已省：缓存命中与降配选路分开累计，同币种合并', () => {
  const config: PoolConfig = {
    version: 1,
    defaults: matrix().defaults,
    routing: matrix().routing,
    providers: [
      provider('premium', [model({
        id: 'baseline',
        quality_rank: 100,
        pricing: { currency: 'USD', input_per_mtok: 10, output_per_mtok: 40 },
      })]),
      provider('cheap', [model({
        id: 'cheap',
        quality_rank: 50,
        pricing: { currency: 'USD', input_per_mtok: 1, output_per_mtok: 4 },
      })]),
    ],
  }
  const router = createRouter(config)
  router.noteCacheHit('r1', 'cheap', 'cheap', 1_000, { tokens: 1_000, cost: { currency: 'USD', amount: 0.5 } })
  router.noteUsage('cheap', 'cheap', {
    input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0, reasoning: 0,
  }, 2_000)
  const savings = router.snapshot(3_000).savings
  assert.equal(savings.tokens, 1_000 + 2_000_000)
  assert.deepEqual(savings.cost, { currency: 'USD', amount: 45.5 }, '缓存 0.5 + 降配 45')
  assert.equal(savings.cacheHits, 1)
})

test('节省混币时不给总额，绝不把 USD 与 CNY 相加', () => {
  const router = createRouter(matrix())
  router.noteCacheHit('r1', 'a', 'a', 1_000, { tokens: 10, cost: { currency: 'USD', amount: 1 } })
  router.noteCacheHit('r2', 'b', 'b', 1_100, { tokens: 10, cost: { currency: 'CNY', amount: 2 } })
  assert.equal(router.snapshot(2_000).savings.cost, null)
})

test('快照可用持久层的今日节省覆盖进程内累计，并报告缓存后端', () => {
  const router = createRouter(matrix())
  router.noteCacheHit('r1', 'a', 'a', 1_000, { tokens: 10, cost: { currency: 'USD', amount: 1 } })
  const snapshot = router.snapshot(2_000, {
    cacheBackend: 'sqlite',
    cacheSavings: { tokens: 9_000, cost: { currency: 'USD', amount: 7 }, cacheHits: 12 },
  })
  assert.equal(snapshot.savings.tokens, 9_000)
  assert.deepEqual(snapshot.savings.cost, { currency: 'USD', amount: 7 })
  assert.equal(snapshot.savings.cacheHits, 12)
  assert.equal(snapshot.savings.cacheBackend, 'sqlite')
})

test('友好的模型写法归一：Steward Auto → steward:auto', () => {
  // 模型选择界面写中文：配置里的 id 原样发给网关，这里必须认出同一条路由。
  assert.equal(canonicalModelId('管家·自动'), 'steward:auto')
  assert.equal(canonicalModelId('管家极致便宜'), 'steward:frugal')
  assert.equal(canonicalModelId('管家·效率优先'), 'steward:balanced')
  assert.equal(canonicalModelId('管家 · 最强火力'), 'steward:max_power')
  assert.equal(canonicalModelId('Steward Auto'), 'steward:auto')
  assert.equal(canonicalModelId('steward_auto'), 'steward:auto')
  assert.equal(canonicalModelId('STEWARD-MAX-POWER'), 'steward:max_power')
  // 不是虚拟 id 的原样返回，绝不误伤真实模型名。
  assert.equal(canonicalModelId('qwen3-embedding-8b'), 'qwen3-embedding-8b')
  const route = parseVirtualModel('Steward Auto')
  assert.equal(route.virtual, 'steward:auto')
  assert.equal(route.mode, undefined)
})

test('白嫖模式：付费模型直接不参与，不是「排后面」', () => {
  const config: PoolConfig = {
    ...matrix(),
    providers: [
      provider('relay', [
        model({ id: 'paid', cost_level: 'high', costPer1kOutput: 0.02, quality_rank: 99 }),
        model({ id: 'free-small', cost_level: 'free', costPer1kOutput: 0, quality_rank: 40 }),
      ]),
    ],
  }
  const router = createRouter(config, undefined, 'free')
  const result = router.plan(intent(), 1_000, 'r1')
  assert.ok(result.ok, 'expected a decision')
  // 质量再高，只要不是零成本就不许上——这个模式的承诺是绝不偷偷花钱。
  assert.equal(result.decision.chosen.provider, 'relay')
  assert.equal(result.decision.chosen.model, 'free-small')
})

test('白嫖模式：池子里没有零成本模型时如实拒绝，不退化成付费', () => {
  const config: PoolConfig = {
    ...matrix(),
    providers: [provider('relay', [model({ id: 'paid', costPer1kOutput: 0.02 })])],
  }
  const router = createRouter(config, undefined, 'free')
  const result = router.plan(intent(), 1_000, 'r1')
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.ok(result.refusal.rejected.some((entry) => entry.reason === 'not-free'), JSON.stringify(result.refusal))
  }
})

test('管家·白嫖 的中文写法能认出来，并且落到 free 模式', () => {
  assert.equal(canonicalModelId('管家·白嫖'), 'steward:free')
  const parsed = parseVirtualModel('管家·白嫖')
  assert.equal(parsed?.mode, 'free')
})
