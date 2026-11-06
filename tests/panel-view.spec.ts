/**
 * panel-view.ts：面板视图模型。
 *
 * 断言的都是「用户会误解的那句话」：未定价时不能显示 0、计量不可用时不能
 * 显示空、全部下线时必须挂红条。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AGENT_IDLE_MS,
  agentRows,
  ballBadge,
  bannerOf,
  geekTags,
  windowTag,
  groupByCost,
  headline,
  modelCardFace,
  modeOptions,
  routeRows,
} from '../src/core/panel-view.ts'
import type { AgentRouteView, MatrixSnapshot, ModelCardView, RouteEventView } from '../src/core/types.ts'

function card(overrides: Partial<ModelCardView> = {}): ModelCardView {
  return {
    provider: overrides.provider ?? 'p1',
    model: overrides.model ?? 'm1',
    displayName: overrides.displayName ?? 'Model 1',
    capabilities: overrides.capabilities ?? ['coding'],
    costLevel: overrides.costLevel ?? 'low',
    contextWindow: overrides.contextWindow ?? 128_000,
    availability: overrides.availability ?? 'direct',
    health: overrides.health ?? 'active',
    inFlight: overrides.inFlight ?? 0,
    todayTokens: overrides.todayTokens ?? 0,
    todayCost: overrides.todayCost === undefined ? null : overrides.todayCost,
    cacheHitRate: overrides.cacheHitRate === undefined ? null : overrides.cacheHitRate,
    ...(overrides.resumeAt === undefined ? {} : { resumeAt: overrides.resumeAt }),
    ...(overrides.latencyMs === undefined ? {} : { latencyMs: overrides.latencyMs }),
    ...(overrides.tier === undefined ? {} : { tier: overrides.tier }),
    ...(overrides.dimensions === undefined ? {} : { dimensions: overrides.dimensions }),
    ...(overrides.imageInput === undefined ? {} : { imageInput: overrides.imageInput }),
    ...(overrides.imageOutput === undefined ? {} : { imageOutput: overrides.imageOutput }),
    ...(overrides.videoOutput === undefined ? {} : { videoOutput: overrides.videoOutput }),
    ...(overrides.chat === undefined ? {} : { chat: overrides.chat }),
  }
}

function snapshot(overrides: Partial<MatrixSnapshot> = {}): MatrixSnapshot {
  return {
    revision: overrides.revision ?? 1,
    mode: overrides.mode ?? 'frugal',
    updatedAt: overrides.updatedAt ?? 1_000,
    usageAvailable: overrides.usageAvailable ?? true,
    models: overrides.models ?? [card()],
    agents: overrides.agents ?? [],
    recent: overrides.recent ?? [],
    totals: overrides.totals ?? {
      todayTokens: 0,
      todayCost: null,
      cacheHitRate: null,
      degradedRequests: 0,
      unpricedModels: 0,
    },
    savings: overrides.savings ?? { tokens: 0, cost: null, cacheHits: 0, cacheBackend: 'off' },
    pool: overrides.pool ?? { status: 'ok', source: 'model_pool.yaml' },
    ...(overrides.authCookies === undefined ? {} : { authCookies: overrides.authCookies }),
  }
}

/* ────────────────────────── 数字卡 ────────────────────────── */

test('headline 在计量可用时显示真实数字', () => {
  const face = headline(snapshot({
    totals: { todayTokens: 12_400, todayCost: { currency: 'CNY', amount: 2.5 }, cacheHitRate: 0.25, degradedRequests: 3, unpricedModels: 0 },
  }))
  assert.equal(face.tokens, '12.4K')
  assert.equal(face.cost, '¥2.50')
  assert.equal(face.cache, '25.0%')
  assert.equal(face.degraded, '3')
  assert.equal(face.usageAvailable, true)
})

test('headline 在未定价时成本显示破折号并说明原因', () => {
  const face = headline(snapshot({
    totals: { todayTokens: 100, todayCost: null, cacheHitRate: null, degradedRequests: 0, unpricedModels: 2 },
  }))
  assert.equal(face.cost, '—')
  assert.equal(face.costNote, '2 个模型未定价')
})

test('headline 在计量不可用时全部显示破折号', () => {
  const face = headline(snapshot({ usageAvailable: false }))
  assert.equal(face.tokens, '—')
  assert.equal(face.cost, '—')
  assert.equal(face.cache, '—')
  assert.equal(face.costNote, '计量不可用')
})

test('headline 在没有未定价时不给 costNote', () => {
  const face = headline(snapshot({
    totals: { todayTokens: 1, todayCost: { currency: 'CNY', amount: 1 }, cacheHitRate: 0, degradedRequests: 0, unpricedModels: 0 },
  }))
  assert.equal(face.costNote, undefined)
})

/* ────────────────────────── 模式 ────────────────────────── */

test('modeOptions 固定四个选项且恰好一个 active', () => {
  const options = modeOptions(snapshot({ mode: 'balanced' }))
  assert.equal(options.length, 4)
  assert.equal(options.filter((option) => option.active).length, 1)
  assert.equal(options.find((option) => option.active)?.mode, 'balanced')
  assert.deepEqual(options.map((option) => option.mode), ['frugal', 'balanced', 'max_power', 'free'])
})

test('modeOptions 每个按钮都有解释文案', () => {
  for (const option of modeOptions(snapshot())) {
    assert.ok(option.hint.length > 0)
  }
})

/* ────────────────────────── 模型卡 ────────────────────────── */

test('modelCardFace 把未定价标出来', () => {
  const face = modelCardFace(card({ todayCost: null }), 0)
  assert.equal(face.costText, '—')
  assert.equal(face.unpriced, true)
})

test('modelCardFace 对有定价的模型显示金额', () => {
  const face = modelCardFace(card({ todayCost: { currency: 'CNY', amount: 1.234 } }), 0)
  assert.equal(face.costText, '¥1.23')
  assert.equal(face.unpriced, false)
})

test('modelCardFace 在冷却时给出剩余时间，到期后不给', () => {
  const cooling = card({ health: 'cooling', resumeAt: 30_000 })
  assert.equal(modelCardFace(cooling, 0).resumeIn, '30s')
  assert.equal(modelCardFace(cooling, 40_000).resumeIn, undefined)
})

test('modelCardFace 的档位与健康状态都有中文标签', () => {
  const face = modelCardFace(card({ costLevel: 'free', health: 'open' }), 0)
  assert.equal(face.costLevelLabel, '免费')
  assert.equal(face.healthLabel, '熔断')
})

test('groupByCost 按 free→low→medium→high 分组并跳过空组', () => {
  const groups = groupByCost([
    card({ model: 'a', costLevel: 'high' }),
    card({ model: 'b', costLevel: 'free' }),
    card({ model: 'c', costLevel: 'free' }),
  ])
  assert.deepEqual(groups.map((group) => group.costLevel), ['free', 'high'])
  assert.equal(groups[0]?.cards.length, 2)
  assert.equal(groups[0]?.label, '免费')
})

test('groupByCost 对空输入返回空数组', () => {
  assert.deepEqual(groupByCost([]), [])
})

/* ────────────────────────── 代理协作 ────────────────────────── */

function agent(overrides: Partial<AgentRouteView> = {}): AgentRouteView {
  return {
    agentId: overrides.agentId ?? 'a1',
    provider: overrides.provider ?? 'p1',
    model: overrides.model ?? 'm1',
    lastSeenAt: overrides.lastSeenAt ?? 0,
    requests: overrides.requests ?? 1,
  }
}

test('agentRows 把超过 90 秒没动静的标为 idle', () => {
  const rows = agentRows([agent({ lastSeenAt: 0 })], AGENT_IDLE_MS + 1)
  assert.equal(rows[0]?.idle, true)
})

test('agentRows 把活跃的排前面', () => {
  const rows = agentRows([
    agent({ agentId: 'idle', lastSeenAt: 0 }),
    agent({ agentId: 'busy', lastSeenAt: 100_000 }),
  ], 100_001)
  assert.equal(rows[0]?.agentId, 'busy')
  assert.equal(rows[1]?.idle, true)
})

test('agentRows 拼出可读的路由与次数', () => {
  const rows = agentRows([agent({ provider: 'premium', model: 'omni-pro', requests: 12, lastSeenAt: 1_000 })], 1_000)
  assert.equal(rows[0]?.routeText, 'premium / omni-pro')
  assert.equal(rows[0]?.requestsText, '12 次')
})

/* ────────────────────────── 路由监控 ────────────────────────── */

function routeEvent(overrides: Partial<RouteEventView> = {}): RouteEventView {
  return {
    at: overrides.at ?? 1_000,
    requestId: overrides.requestId ?? 'r1',
    mode: overrides.mode ?? 'frugal',
    provider: overrides.provider ?? 'p1',
    model: overrides.model ?? 'm1',
    degradedFrom: overrides.degradedFrom ?? [],
    ok: overrides.ok ?? true,
    latencyMs: overrides.latencyMs ?? 100,
    committed: overrides.committed ?? false,
  }
}

test('routeRows 新的在前，并按上限截断', () => {
  const events = Array.from({ length: 20 }, (_, index) => routeEvent({ requestId: 'r' + String(index) }))
  const rows = routeRows(events, 5)
  assert.equal(rows.length, 5)
  assert.equal(rows[0]?.requestId, 'r19')
})

test('routeRows 把降级链画成 a → b', () => {
  const rows = routeRows([routeEvent({
    provider: 'p2',
    model: 'm2',
    degradedFrom: [{ provider: 'p1', model: 'm1', errorKind: 'rate-limit' }],
  })])
  assert.equal(rows[0]?.routeText, 'p1/m1 → p2/m2')
  assert.equal(rows[0]?.degraded, true)
})

test('routeRows 对失败事件给出最后一个失败原因', () => {
  const rows = routeRows([routeEvent({
    ok: false,
    provider: 'p2',
    model: 'm2',
    degradedFrom: [{ provider: 'p1', model: 'm1', errorKind: 'timeout' }],
  })])
  assert.equal(rows[0]?.ok, false)
  assert.equal(rows[0]?.failureReason, 'timeout')
})

test('routeRows 对成功事件不给失败原因', () => {
  assert.equal(routeRows([routeEvent()])[0]?.failureReason, undefined)
})

/* ────────────────────────── 横幅与球 ────────────────────────── */

test('bannerOf 在配置被拒时挂红条', () => {
  const banner = bannerOf(snapshot({ pool: { status: 'rejected', source: 'x', error: 'providers: expected a list' } }))
  assert.equal(banner?.level, 'error')
  assert.ok((banner?.text ?? '').includes('providers: expected a list'))
})

test('bannerOf 在加载中挂黄条', () => {
  assert.equal(bannerOf(snapshot({ pool: { status: 'loading', source: 'x' } }))?.level, 'warn')
})

test('bannerOf 在计量不可用时挂黄条', () => {
  const banner = bannerOf(snapshot({ usageAvailable: false }))
  assert.equal(banner?.level, 'warn')
  assert.ok((banner?.text ?? '').includes('dsh-usage'))
})

test('会话 Cookie 到提醒线挂黄条，并给出清理命令', () => {
  const banner = bannerOf(snapshot({ authCookies: 40 }))
  assert.equal(banner?.level, 'warn')
  assert.ok((banner?.text ?? '').includes('repair:cookies'))
})

test('会话 Cookie 到危险线挂红条，并说清下次启动会失败', () => {
  const banner = bannerOf(snapshot({ authCookies: 55 }))
  assert.equal(banner?.level, 'error')
  assert.ok((banner?.text ?? '').includes('下次启动'))
})

test('会话 Cookie 数量正常时不出横幅', () => {
  assert.equal(bannerOf(snapshot({ authCookies: 3 })), undefined)
})

test('bannerOf 在全部模型下线时挂红条', () => {
  const banner = bannerOf(snapshot({
    models: [card({ health: 'offline' }), card({ health: 'offline' })],
  }))
  assert.equal(banner?.level, 'error')
})

test('bannerOf 在一切正常时不挂横幅', () => {
  assert.equal(bannerOf(snapshot()), undefined)
})

test('ballBadge 显示今日已省：优先金额，未定价时退回 token 数', () => {
  assert.equal(ballBadge(snapshot({
    savings: { tokens: 1_000, cost: { currency: 'USD', amount: 3 }, cacheHits: 2, cacheBackend: 'sqlite' },
  })), '$3.00')
  assert.equal(ballBadge(snapshot({
    savings: { tokens: 1_500, cost: null, cacheHits: 1, cacheBackend: 'memory' },
  })), '1.5K')
  assert.equal(ballBadge(snapshot({
    savings: { tokens: 0, cost: null, cacheHits: 0, cacheBackend: 'off' },
  })), '0')
})


/* ────────────────────────── 极客标签 ────────────────────────── */

test('geekTags：大写纯文字 + 方括号，形态是 [REASONING: SSS] / [VISION] / [200K]', () => {
  const tags = geekTags(card({
    tier: 'SSS',
    contextWindow: 200_000,
    capabilities: ['coding', 'reasoning', 'vision', 'tool-use'],
    dimensions: {
      reasoning: { score: 79, grade: 'SSS' },
      longContext: { score: 56, grade: 'SS' },
      coding: { score: 80, grade: 'SSS' },
      agentic: { score: 85, grade: 'SSS' },
      proWork: { score: 64, grade: 'S' },
      factuality: { score: 73, grade: 'SSS' },
    },
  }))
  assert.ok(tags.includes('[TIER: SSS]'))
  assert.ok(tags.includes('[REASONING: SSS]'))
  assert.ok(tags.includes('[CODING: SSS]'))
  assert.ok(tags.includes('[PRO-WORK: S]'))
  assert.ok(tags.includes('[VISION]'))
  assert.ok(tags.includes('[TOOL-USE]'))
  assert.ok(tags.includes('[200K]'))
  for (const tag of tags) {
    assert.match(tag, /^\[[A-Z0-9: .+-]+\]$/, '标签必须是大写纯文字方括号：' + tag)
  }
})

test('geekTags：没有 Emoji，也不输出小写裸词', () => {
  const tags = geekTags(card({ capabilities: ['coding', 'reasoning', 'long-context'] }))
  const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u
  for (const tag of tags) {
    assert.ok(!emoji.test(tag), '能力标签不允许 Emoji：' + tag)
    assert.equal(tag, tag.toUpperCase(), '能力标签必须大写：' + tag)
  }
  assert.ok(tags.includes('[LONG-CONTEXT]'))
})

test('windowTag：128K / 200K / 1M 的写法', () => {
  assert.equal(windowTag(128_000), '128K')
  assert.equal(windowTag(200_000), '200K')
  assert.equal(windowTag(1_000_000), '1M')
  assert.equal(windowTag(2_000_000), '2M')
  assert.equal(windowTag(0), '?')
})

test('geekTags：未评级（NA）不冒充事实，改印一枚 [UNRATED]', () => {
  const unknown = geekTags(card({
    tier: 'NA',
    dimensions: {
      reasoning: { score: 50, grade: 'NA' },
      longContext: { score: 50, grade: 'NA' },
      coding: { score: 50, grade: 'NA' },
      agentic: { score: 50, grade: 'NA' },
      proWork: { score: 50, grade: 'NA' },
      factuality: { score: 50, grade: 'NA' },
    },
  }))
  assert.ok(unknown.includes('[UNRATED]'))
  assert.ok(!unknown.some((tag) => tag.includes(': NA]')), '不允许出现 [X: NA]')
  assert.ok(!unknown.some((tag) => tag === '[TIER: NA]'))

  // 只有部分维度未知时：已知的照常印，不补 UNRATED。
  const partial = geekTags(card({
    tier: 'SSS',
    dimensions: {
      reasoning: { score: 79, grade: 'SSS' },
      longContext: { score: 50, grade: 'NA' },
      coding: { score: 80, grade: 'SSS' },
      agentic: { score: 85, grade: 'SSS' },
      proWork: { score: 64, grade: 'S' },
      factuality: { score: 73, grade: 'SSS' },
    },
  }))
  assert.ok(partial.includes('[REASONING: SSS]'))
  assert.ok(!partial.includes('[LONG-CONTEXT: NA]'))
  assert.ok(!partial.includes('[UNRATED]'))
})

test('geekTags：向量 / 重排模型挂 [NO-CHAT]，说明它不进对话路由', () => {
  assert.ok(geekTags(card({ chat: false })).includes('[NO-CHAT]'))
  assert.ok(!geekTags(card({})).includes('[NO-CHAT]'))
})

test('headline：上游没有缓存信息时，用本地缓存的真实命中次数兜底', () => {
  const snap = snapshot({
    totals: { todayTokens: 0, todayCost: null, cacheHitRate: null, degradedRequests: 0, unpricedModels: 0 },
    savings: { tokens: 78, cost: null, cacheHits: 2, cacheBackend: 'sqlite' },
  })
  assert.equal(headline(snap).cache, '2 次')
  // 一次都没命中且上游也没数字：仍然是破折号，不冒充 0。
  const empty = snapshot({
    totals: { todayTokens: 0, todayCost: null, cacheHitRate: null, degradedRequests: 0, unpricedModels: 0 },
    savings: { tokens: 0, cost: null, cacheHits: 0, cacheBackend: 'sqlite' },
  })
  assert.equal(headline(empty).cache, '—')
})
