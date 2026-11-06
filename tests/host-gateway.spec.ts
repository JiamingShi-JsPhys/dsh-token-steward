/**
 * 网关：真实起一个 loopback HTTP 服务，用真实 fetch 打它。
 *
 * 这是整个插件里唯一真的绑定端口的地方，因此断言围绕行为而不是内部实现：
 * 谁该 401、谁该 400、降级后谁被调用、流式是否原样透传。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, generateToken, looksLikeLocalToken, publishedModelIds, resolveStartupToken, lastUsageFromSse, type Gateway } from '../src/host/gateway.ts'
import { createRouter } from '../src/core/router.ts'
import { createRouteLedgerStore } from '../src/host/ledger-store.ts'
import { localDateKey } from '../src/core/ledger-doc.ts'
import { model, provider } from './fixtures.ts'
import { DEFAULT_CACHE } from '../src/core/pool-schema.ts'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PoolConfig } from '../src/core/types.ts'
import type { FetchLike } from '../src/host/upstream.ts'

function config(): PoolConfig {
  return {
    version: 1,
    defaults: { timeout_ms: 5_000, max_attempts: 3, cooldown_ms: 30_000, failure_threshold: 3, half_open_after_ms: 60_000 },
    routing: { mode: 'frugal', aliases: {}, agent_overrides: {}, cache: { ...DEFAULT_CACHE } },
    providers: [
      provider('cheap', [model({ id: 'cheap-1', cost_level: 'free', capabilities: ['coding'] })]),
      provider('strong', [model({ id: 'strong-1', cost_level: 'high', quality_rank: 99, capabilities: ['coding', 'reasoning'] })]),
    ],
  }
}

/** 一次上游调用的记录。 */
interface UpstreamCall {
  url: string
  body: Record<string, unknown>
}

/** 起一个网关，测试结束自动关。 */
async function withGateway<T>(
  run: (gateway: Gateway, calls: UpstreamCall[]) => Promise<T>,
  options: { responses?: Array<() => Promise<Response>>, ledger?: boolean, onMode?: (mode: string) => void } = {},
): Promise<T> {
  const calls: UpstreamCall[] = []
  let index = 0
  const responses = options.responses ?? [async () => jsonResponse()]
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> })
    const next = responses[index]
    index += 1
    if (next === undefined) throw new Error('unexpected extra upstream call')
    return next()
  }

  const dir = options.ledger === true ? await mkdtemp(join(tmpdir(), 'steward-gw-')) : undefined
  const ledger = dir === undefined ? undefined : createRouteLedgerStore(dir)
  if (ledger !== undefined) await ledger.load()

  const gateway = await startGateway({
    config: () => config(),
    router: () => sharedRouter,
    secrets: () => new Map([['cheap', 'sk-cheap'], ['strong', 'sk-strong']]),
    fetchImpl,
    now: () => 1_000,
    ...(options.onMode === undefined ? {} : { onMode: options.onMode }),
    ...(ledger === undefined ? {} : { ledger }),
  })
  try {
    return await run(gateway, calls)
  } finally {
    await gateway.close()
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }
}

/** 每个用例一个干净的路由引擎。 */
let sharedRouter = createRouter(config())

function jsonResponse(body: unknown = { ok: true }): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

function sseResponse(): Response {
  return new Response(
    'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":2}}\n\ndata: [DONE]\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}

/** 带令牌的请求。 */
function post(gateway: Gateway, body: unknown, token = gateway.token()): Promise<Response> {
  return fetch(gateway.baseUrl() + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify(body),
  })
}

test('令牌是随机且足够长', () => {
  const a = generateToken()
  const b = generateToken()
  assert.notEqual(a, b)
  assert.ok(a.length >= 40)
})

test('启动令牌：继承的环境变量优先于持久化令牌', () => {
  // DSH 的 llm-pi-ai 可能在插件之前就把 apiKeyEnv 读走了；网关必须对齐它。
  const inherited = 'A'.repeat(43)
  assert.equal(resolveStartupToken('B'.repeat(43), inherited), inherited)
})

test('启动令牌：继承值不合法时回落持久化，都没有才生成', () => {
  const persisted = 'C'.repeat(43)
  assert.equal(resolveStartupToken(persisted, 'not-a-token'), persisted)
  assert.equal(resolveStartupToken(persisted, undefined), persisted)
  const generated = resolveStartupToken(undefined, undefined)
  assert.ok(looksLikeLocalToken(generated))
  assert.notEqual(generated, resolveStartupToken(undefined, undefined))
})

test('网关采用继承的 STEWARD_LOCAL_TOKEN：与 DSH 手里的钥匙对齐', async () => {
  sharedRouter = createRouter(config())
  const dir = await mkdtemp(join(tmpdir(), 'steward-token-'))
  const statePath = join(dir, 'gateway.json')
  const persisted = 'P'.repeat(43)
  const inherited = 'Q'.repeat(43)
  await writeFile(statePath, JSON.stringify({ token: persisted }), 'utf8')
  const gateway = await startGateway({
    config: () => config(),
    router: () => sharedRouter,
    secrets: () => new Map(),
    fetchImpl: async () => jsonResponse(),
    statePath,
    env: { STEWARD_LOCAL_TOKEN: inherited },
  })
  try {
    assert.equal(gateway.token(), inherited)
    const aligned = await fetch(gateway.baseUrl() + '/models', {
      headers: { authorization: 'Bearer ' + inherited },
    })
    assert.equal(aligned.status, 200)
    // 漂移窗口：旧持久化令牌也先接着，DSH 拿着它发来的那一个请求同样能过；
    // 下次启动两边一致后，这个窗口自然关闭（见下一个用例）。
    const driftWindow = await fetch(gateway.baseUrl() + '/models', {
      headers: { authorization: 'Bearer ' + persisted },
    })
    assert.equal(driftWindow.status, 200)
  } finally {
    await gateway.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('没有继承令牌时只认持久化那一把，别的合法令牌照样 401', async () => {
  sharedRouter = createRouter(config())
  const dir = await mkdtemp(join(tmpdir(), 'steward-token-'))
  const statePath = join(dir, 'gateway.json')
  const persisted = 'R'.repeat(43)
  await writeFile(statePath, JSON.stringify({ token: persisted }), 'utf8')
  const gateway = await startGateway({
    config: () => config(),
    router: () => sharedRouter,
    secrets: () => new Map(),
    fetchImpl: async () => jsonResponse(),
    statePath,
    env: {},
  })
  try {
    assert.equal(gateway.token(), persisted)
    const good = await fetch(gateway.baseUrl() + '/models', {
      headers: { authorization: 'Bearer ' + persisted },
    })
    assert.equal(good.status, 200)
    const other = await fetch(gateway.baseUrl() + '/models', {
      headers: { authorization: 'Bearer ' + 'S'.repeat(43) },
    })
    assert.equal(other.status, 401)
  } finally {
    await gateway.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('publishedModelIds 总是含 6 个虚拟 id，并跳过 offline 模型', () => {
  const ids = publishedModelIds(config())
  for (const virtual of ['steward:auto', 'steward:frugal', 'steward:balanced', 'steward:max_power', 'steward:free', 'steward:subagent']) {
    assert.ok(ids.includes(virtual), virtual)
  }
  assert.ok(ids.includes('cheap-1'))
  const withOffline = config()
  withOffline.providers[0]!.models[0]!.availability = 'offline'
  assert.equal(publishedModelIds(withOffline).includes('cheap-1'), false)
})

test('publishedModelIds 在没有配置时仍然给出 6 个虚拟 id', () => {
  assert.deepEqual(publishedModelIds(undefined), [
    'steward:auto', 'steward:frugal', 'steward:balanced', 'steward:max_power', 'steward:free', 'steward:subagent',
  ])
})

test('GET /v1/models 返回全量清单', async () => {
  sharedRouter = createRouter(config())
  await withGateway(async (gateway) => {
    const response = await fetch(gateway.baseUrl() + '/models', {
      headers: { authorization: 'Bearer ' + gateway.token() },
    })
    assert.equal(response.status, 200)
    const body = await response.json() as { object: string, data: Array<{ id: string }> }
    assert.equal(body.object, 'list')
    assert.ok(body.data.some((entry) => entry.id === 'steward:auto'))
    assert.ok(body.data.some((entry) => entry.id === 'cheap-1'))
  })
})

test('没有令牌时 /v1/models 与 /v1/chat/completions 都是 401', async () => {
  sharedRouter = createRouter(config())
  await withGateway(async (gateway) => {
    const models = await fetch(gateway.baseUrl() + '/models')
    assert.equal(models.status, 401)
    const completions = await post(gateway, { model: 'steward:auto', messages: [] }, 'wrong-token')
    assert.equal(completions.status, 401)
    const body = await completions.json() as { error: { code: string } }
    assert.equal(body.error.code, 'unauthorized')
  })
})

test('/health 不需要令牌', async () => {
  sharedRouter = createRouter(config())
  await withGateway(async (gateway) => {
    const response = await fetch(gateway.baseUrl() + '/health')
    assert.equal(response.status, 200)
  })
})

test('未知路径是 404', async () => {
  sharedRouter = createRouter(config())
  await withGateway(async (gateway) => {
    const response = await fetch(gateway.baseUrl() + '/nope', {
      headers: { authorization: 'Bearer ' + gateway.token() },
    })
    assert.equal(response.status, 404)
  })
})

test('一批请求都被路由到最便宜的模型，上游收到真实 id', async () => {
  sharedRouter = createRouter(config())
  await withGateway(async (gateway, calls) => {
    const response = await post(gateway, { model: 'steward:auto', messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(response.status, 200)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.body.model, 'cheap-1')
  })
})

test('steward:max_power 把模式切到最强火力并选中质量分最高的模型', async () => {
  sharedRouter = createRouter(config())
  await withGateway(async (gateway, calls) => {
    const response = await post(gateway, { model: 'steward:max_power', messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(response.status, 200)
    assert.equal(calls[0]?.body.model, 'strong-1')
    assert.equal(sharedRouter.getMode(), 'max_power')
  })
})

test('composer 里选的模型会同步默认模式：中文模型名同样触发 onMode', async () => {
  sharedRouter = createRouter(config())
  const seen: string[] = []
  await withGateway(async (gateway) => {
    // 中文写法（管家·最强火力）与 steward:max_power 是同一条路由。
    const response = await post(gateway, { model: '管家·最强火力', messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(response.status, 200)
    assert.deepEqual(seen, ['max_power'])
    assert.equal(sharedRouter.getMode(), 'max_power')
  }, { onMode: (mode) => { seen.push(mode) } })
})

test('steward:pin/<provider>/<model> 直通到指定模型', async () => {
  sharedRouter = createRouter(config())
  await withGateway(async (gateway, calls) => {
    const response = await post(gateway, { model: 'steward:pin/strong/strong-1', messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(response.status, 200)
    assert.equal(calls[0]?.body.model, 'strong-1')
  })
})

test('直接点名真实模型 id 时直通到它', async () => {
  sharedRouter = createRouter(config())
  await withGateway(async (gateway, calls) => {
    const response = await post(gateway, { model: 'strong-1', messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(response.status, 200)
    assert.equal(calls[0]?.body.model, 'strong-1')
  })
})

test('上游 429 时自动降级，客户端仍拿到 200', async () => {
  sharedRouter = createRouter(config())
  await withGateway(async (gateway, calls) => {
    const response = await post(gateway, { model: 'steward:auto', messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(response.status, 200)
    assert.equal(calls.length, 2)
    assert.equal(calls[0]?.body.model, 'cheap-1')
    assert.equal(calls[1]?.body.model, 'strong-1')
  }, {
    responses: [
      async () => new Response(JSON.stringify({ error: { message: 'rate limit' } }), { status: 429 }),
      async () => jsonResponse(),
    ],
  })
})

test('全部候选失败时返回 502 且带可读消息', async () => {
  sharedRouter = createRouter(config())
  await withGateway(async (gateway) => {
    const response = await post(gateway, { model: 'steward:auto', messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(response.status, 502)
    const body = await response.json() as { error: { code: string, message: string } }
    assert.equal(body.error.code, 'upstream-failed')
    assert.ok(body.error.message.length > 0)
  }, {
    responses: [
      async () => new Response('{"error":{"message":"boom"}}', { status: 500 }),
      async () => new Response('{"error":{"message":"boom2"}}', { status: 500 }),
    ],
  })
})

test('请求体不是 JSON 时 400', async () => {
  sharedRouter = createRouter(config())
  await withGateway(async (gateway) => {
    const response = await fetch(gateway.baseUrl() + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + gateway.token() },
      body: 'not json',
    })
    assert.equal(response.status, 400)
  })
})

test('缺 model 字段时 400', async () => {
  sharedRouter = createRouter(config())
  await withGateway(async (gateway) => {
    const response = await post(gateway, { messages: [] })
    assert.equal(response.status, 400)
  })
})

test('没有可用模型时 400 且列出淘汰原因', async () => {
  sharedRouter = createRouter(config())
  await withGateway(async (gateway) => {
    const response = await post(gateway, {
      model: 'steward:auto',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }],
    })
    assert.equal(response.status, 400)
    const body = await response.json() as { error: { code: string, message: string } }
    assert.equal(body.error.code, 'no-capable-model')
    assert.ok(body.error.message.includes('vision'))
  })
})

test('流式请求原样透传 SSE 帧', async () => {
  sharedRouter = createRouter(config())
  await withGateway(async (gateway) => {
    const response = await post(gateway, { model: 'steward:auto', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(response.status, 200)
    const text = await response.text()
    assert.ok(text.includes('[DONE]'))
    assert.ok(text.includes('"content":"hi"'))
  }, { responses: [async () => sseResponse()] })
})

test('流式时给上游补上 include_usage', async () => {
  sharedRouter = createRouter(config())
  await withGateway(async (gateway, calls) => {
    await post(gateway, { model: 'steward:auto', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    assert.deepEqual(seenStreamOptions(calls[0]), { include_usage: true })
  }, { responses: [async () => sseResponse()] })
})

function seenStreamOptions(call: UpstreamCall | undefined): unknown {
  return call?.body.stream_options
}

test('lastUsageFromSse 从末尾取 usage，跳过半截帧', () => {
  const usage = lastUsageFromSse(
    'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1}}\n\ndata: {"broken\n\ndata: [DONE]\n\n',
  )
  assert.equal(usage?.input, 5)
  assert.equal(lastUsageFromSse('data: [DONE]\n\n'), undefined)
  assert.equal(lastUsageFromSse(''), undefined)
})

test('配置未加载时返回 503 pool-rejected', async () => {
  const router = createRouter(config())
  const gateway = await startGateway({
    config: () => undefined,
    router: () => router,
    secrets: () => new Map(),
    fetchImpl: async () => jsonResponse(),
    now: () => 1_000,
  })
  try {
    const response = await post(gateway, { model: 'steward:auto', messages: [] })
    assert.equal(response.status, 503)
    const body = await response.json() as { error: { code: string } }
    assert.equal(body.error.code, 'pool-rejected')
  } finally {
    await gateway.close()
  }
})

test('close 是幂等的', async () => {
  sharedRouter = createRouter(config())
  const gateway = await startGateway({
    config: () => config(),
    router: () => sharedRouter,
    secrets: () => new Map([['cheap', 'sk']]),
    fetchImpl: async () => jsonResponse(),
    now: () => 1_000,
  })
  await gateway.close()
  await gateway.close()
  assert.ok(gateway.port() > 0)
})
/* ─────────────────── 两个真实缺陷的回归断言 ─────────────────── */

test('回归：usage 记在真实 provider/model 名下，不是幽灵键', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'steward-usage-key-'))
  const ledger = createRouteLedgerStore(dir)
  await ledger.load()
  sharedRouter = createRouter(config())

  const gateway = await startGateway({
    config: () => config(),
    router: () => sharedRouter,
    secrets: () => new Map([['cheap', 'sk'], ['strong', 'sk']]),
    ledger,
    now: () => 1_000,
    fetchImpl: async () => new Response(
      JSON.stringify({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 8 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  })
  try {
    const response = await post(gateway, { model: 'steward:auto', messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(response.status, 200)
    await response.text()

    const keys = Object.keys(ledger.day(localDateKey(Date.now()))?.models ?? {})
    assert.deepEqual(keys, ['cheap/cheap-1'], '用量必须记在被选中的真实模型名下')
    const stat = ledger.day(localDateKey(Date.now()))?.models['cheap/cheap-1']
    assert.equal(stat?.usage.input, 40)
    assert.equal(stat?.usage.output, 8)
  } finally {
    await gateway.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('回归：流式 usage 也记在真实模型名下', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'steward-usage-stream-'))
  const ledger = createRouteLedgerStore(dir)
  await ledger.load()
  sharedRouter = createRouter(config())

  const gateway = await startGateway({
    config: () => config(),
    router: () => sharedRouter,
    secrets: () => new Map([['cheap', 'sk'], ['strong', 'sk']]),
    ledger,
    now: () => 1_000,
    fetchImpl: async () => sseResponse(),
  })
  try {
    const response = await post(gateway, { model: 'steward:auto', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(response.status, 200)
    await response.text()

    const stat = ledger.day(localDateKey(Date.now()))?.models['cheap/cheap-1']
    assert.ok(stat !== undefined, '流式用量也必须落在真实模型名下')
    assert.equal(stat.usage.input, 9)
    assert.equal(stat.usage.output, 2)
  } finally {
    await gateway.close()
    await rm(dir, { recursive: true, force: true })
  }
})

/* ───────────── 虚拟 id 的自述与会话上下文继续（1.1.0） ───────────── */

test('GET /v1/models 给虚拟 id 配上名字与擅长说明', async () => {
  sharedRouter = createRouter(config())
  await withGateway(async (gateway) => {
    const response = await fetch(gateway.baseUrl() + '/models', {
      headers: { authorization: 'Bearer ' + gateway.token() },
    })
    const body = await response.json() as {
      data: Array<{ id: string, name?: string, strengths?: string, strength_tags?: string[] }>
    }
    const subagent = body.data.find((entry) => entry.id === 'steward:subagent')
    assert.ok(subagent !== undefined, '子代理档位必须出现在发布清单里')
    assert.equal(subagent.name, '管家·子代理')
    assert.ok((subagent.strengths ?? '').includes('子代理'))
    assert.ok(subagent.strength_tags?.includes('subagent'))
  })
})

test('同一会话换厂商：上下文保留，上一家的思考字段被清掉', async () => {
  sharedRouter = createRouter(config())
  await withGateway(async (gateway, calls) => {
    const messages = [
      { role: 'user', content: '先看看仓库' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '先读文件' },
          { type: 'text', text: '看过了', cache_control: { type: 'ephemeral' } },
        ],
        reasoning_content: '旧的思考',
        reasoning_details: [{ type: 'reasoning.text' }],
        cache_control: { type: 'ephemeral' },
      },
      { role: 'user', content: '继续' },
    ]

    // 第 1 轮：没有「上一家」，请求原样透传。
    const first = await post(gateway, { model: 'steward:frugal', user: 'sess-1', messages })
    assert.equal(first.status, 200)
    assert.equal(calls[0]?.body.model, 'cheap-1')
    const firstAssistant = (calls[0]?.body.messages as Array<Record<string, unknown>>)[1] as Record<string, unknown>
    assert.equal(firstAssistant.reasoning_content, '旧的思考')

    // 第 2 轮：切到最强火力（换了一家厂商），历史里上一家的私有字段要清掉，
    // 但消息本身（也就是上下文）不能少。
    const second = await post(gateway, { model: 'steward:max_power', user: 'sess-1', messages })
    assert.equal(second.status, 200)
    assert.equal(calls[1]?.body.model, 'strong-1')
    const secondMessages = calls[1]?.body.messages as Array<Record<string, unknown>>
    assert.equal(secondMessages.length, messages.length)
    const secondAssistant = secondMessages[1] as Record<string, unknown>
    assert.equal('reasoning_content' in secondAssistant, false)
    assert.equal('reasoning_details' in secondAssistant, false)
    assert.equal('cache_control' in secondAssistant, false)
    assert.deepEqual(secondAssistant.content, [{ type: 'text', text: '看过了' }])
  }, {
    responses: [async () => jsonResponse(), async () => jsonResponse()],
  })
})
