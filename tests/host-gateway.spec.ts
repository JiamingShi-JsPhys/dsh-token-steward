/**
 * 网关：真实起一个 loopback HTTP 服务，用真实 fetch 打它。
 *
 * 这是整个插件里唯一真的绑定端口的地方，因此断言围绕行为而不是内部实现：
 * 谁该 401、谁该 400、降级后谁被调用、流式是否原样透传。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, generateToken, publishedModelIds, lastUsageFromSse, type Gateway } from '../src/host/gateway.ts'
import { createRouter } from '../src/core/router.ts'
import { createRouteLedgerStore } from '../src/host/ledger-store.ts'
import { localDateKey } from '../src/core/ledger-doc.ts'
import { model, provider } from './fixtures.ts'
import { DEFAULT_CACHE } from '../src/core/pool-schema.ts'
import { mkdtemp, rm } from 'node:fs/promises'
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
  options: { responses?: Array<() => Promise<Response>>, ledger?: boolean } = {},
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

test('publishedModelIds 总是含 4 个虚拟 id，并跳过 offline 模型', () => {
  const ids = publishedModelIds(config())
  for (const virtual of ['steward:auto', 'steward:frugal', 'steward:balanced', 'steward:max_power']) {
    assert.ok(ids.includes(virtual), virtual)
  }
  assert.ok(ids.includes('cheap-1'))
  const withOffline = config()
  withOffline.providers[0]!.models[0]!.availability = 'offline'
  assert.equal(publishedModelIds(withOffline).includes('cheap-1'), false)
})

test('publishedModelIds 在没有配置时仍然给出 4 个虚拟 id', () => {
  assert.deepEqual(publishedModelIds(undefined), ['steward:auto', 'steward:frugal', 'steward:balanced', 'steward:max_power'])
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
