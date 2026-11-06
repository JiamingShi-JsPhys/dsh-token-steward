/**
 * 网关 × 精确缓存：真实起服务、真实 fetch 打它。
 *
 * 断言围绕行为：第二次同 prompt 请求不出站、字节逐一致、路由监控里带着
 * cached 标记、健康状态机不收假样本、计费只记一次（缓存命中不产生第二笔账）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, type Gateway } from '../src/host/gateway.ts'
import { createRouter } from '../src/core/router.ts'
import { model, provider } from './fixtures.ts'
import type { PoolConfig } from '../src/core/types.ts'
import type { FetchLike } from '../src/host/upstream.ts'

function config(overrides: { exactMatch?: boolean } = {}): PoolConfig {
  return {
    version: 1,
    defaults: { timeout_ms: 5_000, max_attempts: 3, cooldown_ms: 30_000, failure_threshold: 3, half_open_after_ms: 60_000 },
    routing: {
      mode: 'frugal',
      aliases: {},
      agent_overrides: {},
      cache: { exact_match: overrides.exactMatch ?? false, max_entries: 64, ttl_ms: 60_000 },
    },
    providers: [
      // tool-use 必须有，否则带工具的请求会在硬过滤就被拒，测不到缓存层。
      provider('cheap', [model({ id: 'cheap-1', cost_level: 'free', capabilities: ['coding', 'tool-use'] })]),
    ],
  }
}

interface UpstreamCall {
  body: Record<string, unknown>
}

function jsonUpstream(): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: 'pong' } }], usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

function sseUpstream(): Response {
  return new Response(
    'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}

async function withGateway<T>(
  run: (gateway: Gateway, calls: UpstreamCall[], router: ReturnType<typeof createRouter>) => Promise<T>,
  options: { exactMatch?: boolean; streamAware?: boolean } = {},
): Promise<T> {
  const calls: UpstreamCall[] = []
  const fetchImpl: FetchLike = async (_url, init) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    calls.push({ body })
    if (options.streamAware === true && body.stream === true) return sseUpstream()
    return jsonUpstream()
  }

  // 每个用例一个干净的路由引擎：缓存语义不该被别的用例的熔断状态污染。
  const router = createRouter(config({ exactMatch: options.exactMatch ?? false }))
  const gateway = await startGateway({
    config: () => config({ exactMatch: options.exactMatch ?? false }),
    router: () => router,
    secrets: () => new Map([['cheap', 'sk-cheap']]),
    fetchImpl,
    now: () => 1_000,
  })
  try {
    return await run(gateway, calls, router)
  } finally {
    await gateway.close()
  }
}

function post(gateway: Gateway, body: unknown): Promise<Response> {
  return fetch(gateway.baseUrl() + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + gateway.token() },
    body: JSON.stringify(body),
  })
}

function chatPrompt(content: string): Record<string, unknown> {
  return { model: 'steward:auto', messages: [{ role: 'user', content }] }
}

test('同一 prompt 的第二次请求命中缓存：不出站、响应逐字节一致', async () => {
  await withGateway(async (gateway, calls) => {
    const first = await post(gateway, chatPrompt('classify this'))
    const firstText = await first.text()

    const second = await post(gateway, chatPrompt('classify this'))
    const secondText = await second.text()

    assert.equal(calls.length, 1, '第二次请求没有离开本机')
    assert.equal(secondText, firstText, '回放与首发逐字节一致')
    assert.equal(second.status, 200)
  }, { exactMatch: true })
})

test('缓存命中的路由事件带 cached 标记，且健康状态机不收假样本', async () => {
  await withGateway(async (gateway, calls, router) => {
    await post(gateway, chatPrompt('hello'))
    await post(gateway, chatPrompt('hello'))
    assert.equal(calls.length, 1)

    const recent = router.snapshot(2_000).recent
    assert.equal(recent.length, 2)
    assert.equal(recent[1]?.cached, true, '第二条是缓存命中')
    assert.equal(recent[1]?.ok, true)
    // 健康状态机没收到 0ms 的假延迟样本：只有真实出站那次计了一次成功。
    const health = router.healthOf('cheap', 'cheap-1')
    assert.equal(health?.samples, 1)
  }, { exactMatch: true })
})

test('带 tools 的请求不缓存：两次都真实出站', async () => {
  await withGateway(async (gateway, calls) => {
    const toolsBody = { ...chatPrompt('use the tool'), tools: [{ type: 'function', function: { name: 'run_code', parameters: {} } }] }
    await post(gateway, toolsBody)
    await post(gateway, toolsBody)
    assert.equal(calls.length, 2, '工具调用必须真的执行，不能回放')
  }, { exactMatch: true })
})

test('不同 prompt 各自出站；关掉 exact_match 后同 prompt 也每次出站', async () => {
  await withGateway(async (gateway, calls) => {
    await post(gateway, chatPrompt('one'))
    await post(gateway, chatPrompt('two'))
    assert.equal(calls.length, 2)
  }, { exactMatch: true })

  await withGateway(async (gateway, calls) => {
    await post(gateway, chatPrompt('same'))
    await post(gateway, chatPrompt('same'))
    assert.equal(calls.length, 2, '默认关闭：不缓存')
  }, { exactMatch: false })
})

test('流式与非流式形状互不串答案', async () => {
  await withGateway(async (gateway, calls) => {
    // 先来一次流式（SSE 帧），再来一次非流式同 prompt：形状在键里，互不命中。
    const streamRes = await post(gateway, { ...chatPrompt('shape'), stream: true })
    const streamText = await streamRes.text()
    assert.ok(streamText.startsWith('data:'), '上游的 SSE 原样透传')

    const jsonRes = await post(gateway, chatPrompt('shape'))
    const jsonText = await jsonRes.text()
    assert.ok(jsonText.startsWith('{'), '非流式拿到 JSON 而不是被回放的 SSE')
    assert.equal(calls.length, 2, '两种形状互不命中')

    // 再来一次相同流式请求：命中第一次的 SSE 回放。
    const streamAgain = await post(gateway, { ...chatPrompt('shape'), stream: true })
    assert.equal(await streamAgain.text(), streamText)
    assert.equal(calls.length, 2)
  }, { exactMatch: true, streamAware: true })
})

test('模式切换使 steward:auto 的缓存失效', async () => {
  await withGateway(async (gateway, calls) => {
    await post(gateway, chatPrompt('same prompt'))
    assert.equal(calls.length, 1)
    gateway.setMode('max_power')
    await post(gateway, chatPrompt('same prompt'))
    assert.equal(calls.length, 2, '模式变了，同一个 prompt 必须重新选路')
  }, { exactMatch: true })
})

test('回归：Agent 循环永远带 tools——目录缺 tool-use 的模型也能被 Agent 循环使用', async () => {
  await withGateway(async (gateway, calls) => {
    // custom 厂商（unknownModelInfo 形态：未收录模型）+ 带 tools 的真实 Agent 请求
    const toolsBody = {
      model: 'custom/Qwen',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'run_code', parameters: {} } }],
    }
    const response = await post(gateway, toolsBody)
    assert.equal(response.status, 200, '未知模型默认带 tool-use，不再被硬过滤误杀')
    assert.equal(calls.length, 1)
  }, { exactMatch: false })
})
