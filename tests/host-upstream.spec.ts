/**
 * 凭据与上游转发。
 *
 * 这里断言的三件事都在生产里咬过人：明文泄漏、降级重发造成重复副作用、
 * 上游错误体被原样回传给浏览器。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { credentialKind, maskSecret, resolveCredential, type CredentialSources } from '../src/host/credentials.ts'
import { estimateInputTokens } from '../src/core/intent.ts'
import { refusalMessage } from '../src/host/gateway.ts'
import {
  attemptOnce,
  buildHeaders,
  dispatch,
  findRoute,
  normalizeCrossProviderBody,
  rewriteBody,
  clampOutputToWindow,
  upstreamUrl,
  usageFromBody,
  type DispatchContext,
  type FetchLike,
} from '../src/host/upstream.ts'
import { model, provider } from './fixtures.ts'
import { DEFAULT_CACHE } from '../src/core/pool-schema.ts'
import type { PoolConfig, RouteDecision } from '../src/core/types.ts'

function sources(env: Record<string, string>, files: Record<string, string> = {}): CredentialSources {
  return {
    env: (name) => env[name],
    readFile: async (path) => {
      const text = files[path]
      if (text === undefined) throw new Error('ENOENT')
      return text
    },
  }
}

/* ────────────────────────── 凭据 ────────────────────────── */

test('凭据：识别四种写法', () => {
  assert.equal(credentialKind('env:KEY'), 'env')
  assert.equal(credentialKind('file:/tmp/key'), 'file')
  assert.equal(credentialKind('literal:abc'), 'literal')
  assert.equal(credentialKind('${KEY}'), 'env')
  assert.equal(credentialKind('plain'), 'unknown')
})

test('凭据：env:NAME 从环境取', async () => {
  const result = await resolveCredential('env:KEY', sources({ KEY: 'secret-1' }))
  assert.deepEqual(result, { ok: true, secret: 'secret-1' })
})

test('凭据：花括号写法等价于 env:NAME', async () => {
  const result = await resolveCredential('${KEY}', sources({ KEY: 'secret-2' }))
  assert.deepEqual(result, { ok: true, secret: 'secret-2' })
})

test('凭据：环境变量缺失时失败，且原因里不含明文', async () => {
  const result = await resolveCredential('env:MISSING', sources({}))
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.ok(result.reason.includes('MISSING'))
})

test('凭据：文件取首行并去掉首尾空白', async () => {
  const result = await resolveCredential('file:/tmp/key', sources({}, { '/tmp/key': '  abc123  \nsecond-line' }))
  assert.deepEqual(result, { ok: true, secret: 'abc123' })
})

test('凭据：文件读不到时失败', async () => {
  assert.equal((await resolveCredential('file:/tmp/nope', sources({}))).ok, false)
})

test('凭据：空文件失败', async () => {
  assert.equal((await resolveCredential('file:/tmp/empty', sources({}, { '/tmp/empty': '   ' }))).ok, false)
})

test('凭据：literal 直接取，空值失败', async () => {
  assert.deepEqual(await resolveCredential('literal:abc', sources({})), { ok: true, secret: 'abc' })
  assert.equal((await resolveCredential('literal:', sources({}))).ok, false)
})

test('凭据：无法识别的引用被拒绝', async () => {
  assert.equal((await resolveCredential('plain-key', sources({}))).ok, false)
})

test('打码：短串全掩，长串留头尾', () => {
  assert.equal(maskSecret('abc'), '***')
  assert.equal(maskSecret('abcdef'), '******')
  // 13 字符：留前 3 与后 2，中间 8 个星
  assert.equal(maskSecret('sk-1234567890'), 'sk-********90')
  assert.equal(maskSecret('sk-1234567890').length, 13, '掩码必须与原长一致，否则泄露长度之外的额外信息')
})

/* ────────────────────────── 请求改写 ────────────────────────── */

function config(): PoolConfig {
  return {
    version: 1,
    defaults: { timeout_ms: 5_000, max_attempts: 3, cooldown_ms: 30_000, failure_threshold: 3, half_open_after_ms: 60_000 },
    routing: { mode: 'frugal', aliases: {}, agent_overrides: {}, cache: { ...DEFAULT_CACHE } },
    providers: [
      provider('alpha', [model({ id: 'a1', cost_level: 'free' }), model({ id: 'a2', cost_level: 'low' })]),
      provider('beta', [model({ id: 'b1', cost_level: 'high' })]),
    ],
  }
}

test('findRoute 找得到与找不到', () => {
  assert.equal(findRoute(config(), 'alpha', 'a2')?.model.id, 'a2')
  assert.equal(findRoute(config(), 'alpha', 'zz'), undefined)
  assert.equal(findRoute(config(), 'zz', 'a1'), undefined)
})

test('upstreamUrl 拼上 /chat/completions 并去掉重复斜杠', () => {
  assert.equal(upstreamUrl(provider('p', [])), 'https://p.example/v1/chat/completions')
  assert.equal(upstreamUrl({ ...provider('p', []), endpoint: 'https://p.example/v1/' }), 'https://p.example/v1/chat/completions')
})

test('buildHeaders 带上 bearer 与配置里的 header', () => {
  const entry = { ...provider('p', []), headers: { 'x-extra': 'v' } }
  const headers = buildHeaders(entry, 'secret')
  assert.equal(headers.authorization, 'Bearer secret')
  assert.equal(headers['x-extra'], 'v')
  assert.equal(headers['content-type'], 'application/json')
})

test('buildHeaders 在没有凭据时不带 authorization', () => {
  assert.equal(buildHeaders(provider('p', []), '').authorization, undefined)
})

test('rewriteBody 把 model 换成上游真实 id，其余原样', () => {
  const next = rewriteBody({ model: 'steward:auto', messages: [{ role: 'user', content: 'hi' }], temperature: 0.2 }, 'a1')
  assert.equal(next.model, 'a1')
  assert.equal(next.temperature, 0.2)
  assert.deepEqual(next.messages, [{ role: 'user', content: 'hi' }])
})

test('rewriteBody 在流式时强制带上 include_usage，但不覆盖其它 stream_options', () => {
  const next = rewriteBody({ model: 'x', stream: true, stream_options: { foo: 1 } }, 'a1')
  assert.deepEqual(next.stream_options, { foo: 1, include_usage: true })
})

test('rewriteBody 在非流式时不加 stream_options', () => {
  assert.equal(rewriteBody({ model: 'x' }, 'a1').stream_options, undefined)
})

test('usageFromBody 读出五个桶', () => {
  assert.deepEqual(usageFromBody({
    usage: {
      prompt_tokens: 100,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 5 },
      completion_tokens_details: { reasoning_tokens: 3 },
    },
  }), { input: 100, output: 20, cacheRead: 40, cacheWrite: 5, reasoning: 3 })
})

test('usageFromBody 兼容 DeepSeek 的 prompt_cache_hit_tokens', () => {
  assert.equal(usageFromBody({ usage: { prompt_tokens: 10, completion_tokens: 1, prompt_cache_hit_tokens: 7 } })?.cacheRead, 7)
})

test('usageFromBody 对缺失/畸形返回 undefined 或零', () => {
  assert.equal(usageFromBody({}), undefined)
  assert.equal(usageFromBody(null), undefined)
  assert.deepEqual(usageFromBody({ usage: {} }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 })
})

/* ────────────────────────── 转发与降级 ────────────────────────── */

function fakeFetch(responses: Array<() => Promise<Response>>): { impl: FetchLike; calls: Array<{ url: string; body: Record<string, unknown> }> } {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  let index = 0
  return {
    calls,
    impl: async (url, init) => {
      calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> })
      const next = responses[index]
      index += 1
      if (next === undefined) throw new Error('unexpected extra call')
      return next()
    },
  }
}

function okStream(): Response {
  return new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n', {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function failure(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function context(fetchImpl: FetchLike, secrets: Array<[string, string]>): DispatchContext {
  let clock = 1_000
  return {
    requestId: 'r1',
    body: { model: 'steward:auto', messages: [{ role: 'user', content: 'hi' }], stream: true },
    stream: true,
    secrets: new Map(secrets),
    fetchImpl,
    now: () => { clock += 50; return clock },
  }
}

function decision(chosen: [string, string], fallbacks: Array<[string, string]> = []): RouteDecision {
  return {
    requestId: 'r1',
    mode: 'frugal',
    chosen: { provider: chosen[0], model: chosen[1], score: 100, reasons: [] },
    fallbacks: fallbacks.map(([p, m]) => ({ provider: p, model: m, score: 90, reasons: [] })),
    decidedAt: 1_000,
    notes: [],
  }
}

test('转发：首选成功即返回，不发第二次请求', async () => {
  const fake = fakeFetch([async () => okStream()])
  const settled: string[] = []
  const outcome = await dispatch(
    context(fake.impl, [['alpha', 'sk-a'], ['beta', 'sk-b']]),
    config(),
    decision(['alpha', 'a1'], [['beta', 'b1']]),
    (result) => settled.push(result.provider + '/' + result.model),
  )
  assert.equal(outcome.ok, true)
  assert.equal(outcome.provider, 'alpha')
  assert.equal(fake.calls.length, 1)
  assert.deepEqual(settled, ['alpha/a1'])
  assert.equal(fake.calls[0]?.body.model, 'a1', '上游必须收到真实模型 id')
})

test('转发：首选 429 后自动降级到下一个候选', async () => {
  const fake = fakeFetch([async () => failure(429, 'rate limit exceeded'), async () => okStream()])
  const settled: boolean[] = []
  const outcome = await dispatch(
    context(fake.impl, [['alpha', 'sk-a'], ['beta', 'sk-b']]),
    config(),
    decision(['alpha', 'a1'], [['beta', 'b1']]),
    (result) => settled.push(result.ok),
  )
  assert.equal(outcome.ok, true)
  assert.equal(outcome.provider, 'beta')
  assert.equal(outcome.degradedFrom.length, 1)
  assert.equal(outcome.degradedFrom[0]?.errorKind, 'rate-limit')
  assert.deepEqual(settled, [false, true])
})

test('转发：全部失败时返回最后一次的错误，并把最后一发标为 final', async () => {
  const fake = fakeFetch([async () => failure(500, 'boom'), async () => failure(503, 'still boom')])
  const results: Array<{ final?: boolean; errorKind?: string }> = []
  const outcome = await dispatch(
    context(fake.impl, [['alpha', 'sk-a'], ['beta', 'sk-b']]),
    config(),
    decision(['alpha', 'a1'], [['beta', 'b1']]),
    (result) => results.push({
      ...(result.final === undefined ? {} : { final: result.final }),
      ...(result.errorKind === undefined ? {} : { errorKind: result.errorKind }),
    }),
  )
  assert.equal(outcome.ok, false)
  assert.equal(outcome.errorKind, 'server')
  assert.equal(outcome.degradedFrom.length, 2)
  assert.equal(results[0]?.final, undefined)
  assert.equal(results[1]?.final, true)
})

test('转发：缺凭据的 provider 直接以 auth 失败，不发请求', async () => {
  const fake = fakeFetch([async () => okStream()])
  const outcome = await dispatch(
    context(fake.impl, [['beta', 'sk-b']]),
    config(),
    decision(['alpha', 'a1'], [['beta', 'b1']]),
    () => {},
  )
  assert.equal(outcome.ok, true)
  assert.equal(outcome.provider, 'beta')
  assert.equal(fake.calls.length, 1)
  assert.equal(outcome.degradedFrom[0]?.errorKind, 'auth')
})

test('转发：上游 URL 指向 provider 自己的 endpoint', async () => {
  const fake = fakeFetch([async () => okStream()])
  await dispatch(context(fake.impl, [['alpha', 'sk-a']]), config(), decision(['alpha', 'a1']), () => {})
  assert.equal(fake.calls[0]?.url, 'https://alpha.example/v1/chat/completions')
})

test('转发：header 带上 bearer 与 provider 自定义 header', async () => {
  const custom: PoolConfig = {
    ...config(),
    providers: [{ ...provider('alpha', [model({ id: 'a1' })]), headers: { 'x-api-version': '2' } }],
  }
  let seen: Record<string, unknown> = {}
  const impl: FetchLike = async (_url, init) => {
    seen = init.headers as Record<string, unknown>
    return okStream()
  }
  await dispatch(context(impl, [['alpha', 'sk-a']]), custom, decision(['alpha', 'a1']), () => {})
  assert.equal(seen.authorization, 'Bearer sk-a')
  assert.equal(seen['x-api-version'], '2')
})

test('转发：连接层异常被归类为 transport 并继续降级', async () => {
  const fake = fakeFetch([async () => { throw new Error('fetch failed: ECONNRESET') }, async () => okStream()])
  const outcome = await dispatch(
    context(fake.impl, [['alpha', 'sk-a'], ['beta', 'sk-b']]),
    config(),
    decision(['alpha', 'a1'], [['beta', 'b1']]),
    () => {},
  )
  assert.equal(outcome.ok, true)
  assert.equal(outcome.degradedFrom[0]?.errorKind, 'transport')
})

test('转发：attemptOnce 单独调用时也返回分类结果', async () => {
  const fake = fakeFetch([async () => failure(401, 'invalid api key')])
  const attempt = await attemptOnce(context(fake.impl, [['alpha', 'sk-a']]), config(), 'alpha', 'a1')
  assert.equal(attempt.ok, false)
  assert.equal(attempt.errorKind, 'auth')
  assert.equal(attempt.status, 401)
})

test('转发：未知路由直接以 bad-request 失败，不发请求', async () => {
  const fake = fakeFetch([])
  const attempt = await attemptOnce(context(fake.impl, [['alpha', 'sk-a']]), config(), 'alpha', 'ghost')
  assert.equal(attempt.ok, false)
  assert.equal(attempt.errorKind, 'bad-request')
  assert.equal(fake.calls.length, 0)
})

test('转发：错误体里的消息被带上但被截断', async () => {
  const fake = fakeFetch([async () => failure(500, 'x'.repeat(2_000))])
  const attempt = await attemptOnce(context(fake.impl, [['alpha', 'sk-a']]), config(), 'alpha', 'a1')
  assert.equal(attempt.ok, false)
  assert.equal(attempt.message?.length, 500)
})

test('clampOutputToWindow：把 64k 的输出上限压进模型的剩余窗口', () => {
  // 窗口 128k、输入约 100k → 只剩 28k 左右给输出，64k 必须被压下来。
  const body = { model: 'x', max_tokens: 65_536, messages: [{ role: 'user', content: 'x'.repeat(400_000) }] }
  const input = estimateInputTokens(body)
  clampOutputToWindow(body, 128_000)
  assert.equal(body.max_tokens, 128_000 - input)
  assert.ok(body.max_tokens < 65_536)
})

test('clampOutputToWindow：窗口够大就不动，没写 max_tokens 也不凭空加', () => {
  const roomy = clampOutputToWindow({ max_completion_tokens: 8_192, messages: [{ role: 'user', content: 'hi' }] }, 1_000_000)
  assert.equal(roomy.max_completion_tokens, 8_192)
  const none = clampOutputToWindow({ messages: [{ role: 'user', content: 'hi' }] }, 128_000)
  assert.equal('max_tokens' in none, false)
})

test('免费档的拒绝原因要带上「下一步该干什么」', () => {
  const rejected = [{ provider: 'agnes', model: 'agnes-3.0-flash', reason: 'not-free' }]
  const free = refusalMessage('free', rejected)
  assert.ok(free.includes('agnes/agnes-3.0-flash: not-free'))
  assert.ok(free.includes('免费档只跑零成本模型'))
  // 别的模式不加这段：它们本来就可以用付费模型。
  assert.equal(refusalMessage('max_power', rejected), 'agnes/agnes-3.0-flash: not-free')
  // 不是「全都不免费」时也别乱贴提示。
  const mixed = refusalMessage('free', [{ provider: 'p', model: 'm', reason: 'missing-capability:vision' }])
  assert.equal(mixed.includes('免费档'), false)
})

/* ─────────────────── 换模型时的上下文继续（1.1.0） ─────────────────── */

/** 一条带着上一家厂商私有字段的助手消息。 */
function historyWithProviderFields(): Record<string, unknown> {
  return {
    model: 'x',
    messages: [
      { role: 'system', content: 'sys' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '先读文件' },
          { type: 'text', text: '看过了', cache_control: { type: 'ephemeral' } },
        ],
        reasoning_content: '旧的思考过程',
        reasoning_details: [{ type: 'reasoning.text', text: '旧的思考' }],
        cache_control: { type: 'ephemeral' },
      },
      { role: 'user', content: '继续' },
    ],
  }
}

test('跨厂商归一化：换了一家才剥掉上一家的思考痕迹与缓存标记', () => {
  const original = historyWithProviderFields()
  const next = normalizeCrossProviderBody(original, 'strong', 'cheap')
  const messages = next.messages as Array<Record<string, unknown>>
  const assistant = messages[1] as Record<string, unknown>

  assert.equal('reasoning_content' in assistant, false)
  assert.equal('reasoning_details' in assistant, false)
  assert.equal('cache_control' in assistant, false)
  assert.deepEqual(assistant.content, [{ type: 'text', text: '看过了' }])
  // 用户消息与系统提示原样保留。
  assert.deepEqual(messages[2], { role: 'user', content: '继续' })
  assert.deepEqual(messages[0], { role: 'system', content: 'sys' })
  // 绝不原地改写客户端那份请求体：降级链上还有别的候选要用它。
  const originalAssistant = (original.messages as Array<Record<string, unknown>>)[1] as Record<string, unknown>
  assert.equal(originalAssistant.reasoning_content, '旧的思考过程')
})

test('跨厂商归一化：同一厂商内换模型不动，没有历史也不动', () => {
  const body = historyWithProviderFields()
  assert.equal(normalizeCrossProviderBody(body, 'cheap', 'cheap'), body)
  assert.equal(normalizeCrossProviderBody(body, 'cheap', undefined), body)
})

test('跨厂商归一化：只剩思考块的消息 content 变成 null', () => {
  const body = {
    messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: '嗯' }] }],
  }
  const next = normalizeCrossProviderBody(body, 'b', 'a')
  const assistant = (next.messages as Array<Record<string, unknown>>)[0] as Record<string, unknown>
  assert.equal(assistant.content, null)
})

test('attemptOnce 的出站体：换厂商时已经归一化，同厂商时保持原样', async () => {
  const config: PoolConfig = {
    version: 1,
    defaults: { timeout_ms: 5_000, max_attempts: 1, cooldown_ms: 1_000, failure_threshold: 3, half_open_after_ms: 1_000 },
    routing: { mode: 'frugal', aliases: {}, agent_overrides: {}, cache: { ...DEFAULT_CACHE } },
    providers: [
      provider('a', [model({ id: 'a-1' })]),
      provider('b', [model({ id: 'b-1' })]),
    ],
  }
  const sent: Array<Record<string, unknown>> = []
  const fetchImpl: FetchLike = async (_url, init) => {
    sent.push(JSON.parse(String(init.body)) as Record<string, unknown>)
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const base: DispatchContext = {
    requestId: 'r1',
    body: historyWithProviderFields(),
    stream: false,
    secrets: new Map([['a', 'sk-a'], ['b', 'sk-b']]),
    fetchImpl,
    now: () => 1_000,
  }

  await attemptOnce({ ...base, previousProvider: 'a' }, config, 'b', 'b-1')
  await attemptOnce({ ...base, previousProvider: 'a' }, config, 'a', 'a-1')

  const crossed = (sent[0]?.messages as Array<Record<string, unknown>>)[1] as Record<string, unknown>
  const same = (sent[1]?.messages as Array<Record<string, unknown>>)[1] as Record<string, unknown>
  assert.equal('reasoning_content' in crossed, false)
  assert.equal(same.reasoning_content, '旧的思考过程')
})
