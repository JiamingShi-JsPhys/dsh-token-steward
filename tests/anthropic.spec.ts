/**
 * Anthropic Messages 兼容层：进出各翻一次，客户端永远只看到 OpenAI 形状。
 *
 * 这里钉住三件容易错的事：
 *  - 请求方向：system 抽出去、工具调用与工具结果能对上、Anthropic 要的必填项都在；
 *  - 响应方向：文本 / 工具调用 / stop_reason / usage 的换算；
 *  - 流式：Anthropic 的 SSE 事件能变成 chat.completion.chunk，并以 [DONE] 收尾。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  anthropicHeaders,
  anthropicToOpenAI,
  anthropicUrl,
  createAnthropicStream,
  toAnthropicBody,
  usageToOpenAI,
} from '../src/host/anthropic.ts'
import { apiShapeFor, synthesizePool } from '../src/core/vendors.ts'
import type { ProviderEntry, VendorConfig } from '../src/core/types.ts'

function provider(overrides: Partial<ProviderEntry> = {}): ProviderEntry {
  return {
    provider_name: 'anthropic',
    endpoint: 'https://api.anthropic.com/v1',
    api: 'anthropic-messages',
    api_key: 'literal:x',
    headers: {},
    models: [],
    ...overrides,
  }
}

function vendor(overrides: Partial<VendorConfig> = {}): VendorConfig {
  return {
    vendorId: 'anthropic',
    vendorName: 'Anthropic',
    officialUrl: 'https://api.anthropic.com/v1',
    customUrl: '',
    endpointSource: 'official',
    apiKey: 'sk-ant',
    enabledModels: ['claude-opus-5-5'],
    ...overrides,
  }
}

test('地址与 header：拼 /messages、用 x-api-key、带版本头', () => {
  assert.equal(anthropicUrl(provider()), 'https://api.anthropic.com/v1/messages')
  assert.equal(anthropicUrl(provider({ endpoint: 'https://relay.example.com' })), 'https://relay.example.com/v1/messages')
  const headers = anthropicHeaders(provider({ headers: { 'x-custom': '1' } }), 'sk-ant')
  assert.equal(headers['x-api-key'], 'sk-ant')
  assert.equal(headers['anthropic-version'], '2023-06-01')
  assert.equal(headers['x-custom'], '1')
  assert.equal(headers.authorization, undefined, 'Anthropic 不认 Bearer')
})

test('请求体：system 抽出去、max_tokens 必填、同角色合并', () => {
  const body = toAnthropicBody({
    model: 'claude-opus-5-5',
    messages: [
      { role: 'system', content: '你是管家' },
      { role: 'user', content: '你好' },
      { role: 'user', content: '再说一句' },
    ],
    temperature: 1.7,
  }, 'claude-opus-5-5')
  assert.equal(body.system, '你是管家')
  assert.equal(body.max_tokens, 8_192, '客户端没给时也要有')
  assert.equal(body.temperature, 1, 'temperature 压到 [0,1]')
  const messages = body.messages as Array<Record<string, unknown>>
  assert.equal(messages.length, 1, '两条 user 合成一条')
  assert.deepEqual(messages[0]!.content, [
    { type: 'text', text: '你好' },
    { type: 'text', text: '再说一句' },
  ])
})

test('请求体：输出上限压到 32k（DSH 按 64k 要会被 Anthropic 400 拒掉）', () => {
  const body = toAnthropicBody({
    model: 'claude-opus-5-5',
    max_tokens: 65_536,
    messages: [{ role: 'user', content: '写长一点' }],
  }, 'claude-opus-5-5')
  assert.equal(body.max_tokens, 32_000)
})

test('请求体：工具调用与工具结果各归各位', () => {
  const body = toAnthropicBody({
    model: 'claude-opus-5-5',
    messages: [
      { role: 'user', content: '查一下天气' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'weather', arguments: '{"city":"杭州"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '晴，22 度' },
    ],
    tools: [{ type: 'function', function: { name: 'weather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
    tool_choice: 'required',
  }, 'claude-opus-5-5')
  const messages = body.messages as Array<Record<string, unknown>>
  const assistant = messages.find((message) => message.role === 'assistant')!
  assert.deepEqual(assistant.content, [
    { type: 'tool_use', id: 'call_1', name: 'weather', input: { city: '杭州' } },
  ])
  const toolResult = (messages[messages.length - 1]!.content as Array<Record<string, unknown>>)[0]!
  assert.equal(toolResult.type, 'tool_result')
  assert.equal(toolResult.tool_use_id, 'call_1')
  assert.equal(toolResult.content, '晴，22 度')
  assert.deepEqual(body.tools, [
    { name: 'weather', description: '查天气', input_schema: { type: 'object', properties: { city: { type: 'string' } } } },
  ])
  assert.deepEqual(body.tool_choice, { type: 'any' })
})

test('请求体：data URL 图片换成 Anthropic 的 base64 source', () => {
  const body = toAnthropicBody({
    model: 'claude-opus-5-5',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '这是什么' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAB' } },
      ],
    }],
  }, 'claude-opus-5-5')
  const content = (body.messages as Array<Record<string, unknown>>)[0]!.content as Array<Record<string, unknown>>
  assert.deepEqual(content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAB' } })
})

test('请求体：历史以助手开场时丢掉那一截（Anthropic 要从 user 起）', () => {
  const body = toAnthropicBody({
    model: 'claude-opus-5-5',
    messages: [
      { role: 'assistant', content: '我先说一句' },
      { role: 'user', content: '继续' },
    ],
  }, 'claude-opus-5-5')
  const messages = body.messages as Array<Record<string, unknown>>
  assert.equal(messages.length, 1)
  assert.equal(messages[0]!.role, 'user')
})

test('响应：文本 / 工具调用 / stop_reason / usage 一起翻', () => {
  const openai = anthropicToOpenAI({
    id: 'msg_1',
    model: 'claude-opus-5-5',
    content: [
      { type: 'text', text: '好的' },
      { type: 'tool_use', id: 'toolu_1', name: 'weather', input: { city: '杭州' } },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90 },
  }, 'fallback')
  const choices = openai.choices as Array<Record<string, unknown>>
  const message = choices[0]!.message as Record<string, unknown>
  assert.equal(message.content, '好的')
  assert.deepEqual(message.tool_calls, [{
    id: 'toolu_1',
    type: 'function',
    function: { name: 'weather', arguments: '{"city":"杭州"}' },
  }])
  assert.equal(choices[0]!.finish_reason, 'tool_calls')
  assert.deepEqual(openai.usage, {
    prompt_tokens: 100,
    completion_tokens: 5,
    total_tokens: 105,
    prompt_tokens_details: { cached_tokens: 90 },
  })
})

test('usage：缓存的读写都算进 prompt（OpenAI 的口径）', () => {
  assert.deepEqual(usageToOpenAI({ input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }), {
    prompt_tokens: 8,
    completion_tokens: 2,
    total_tokens: 10,
    prompt_tokens_details: { cached_tokens: 3 },
    cache_write_tokens: 4,
  })
})

test('流式：Anthropic 事件 → chat.completion.chunk，并以 [DONE] 收尾', async () => {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const stream = createAnthropicStream('claude-opus-5-5')
  const writer = stream.writable.getWriter()
  const reader = stream.readable.getReader()

  // 先起读再写：TransformStream 有背压，只写不读会让 write() 一直挂着。
  const collected = (async () => {
    let text = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
    return text
  })()

  const frames = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":7,"output_tokens":0}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"好"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ]
  for (const frame of frames) await writer.write(encoder.encode(frame))
  await writer.close()

  const text = await collected

  const payloads = text.split('\n\n')
    .map((line) => line.replace(/^data: /, '').trim())
    .filter((line) => line !== '')
  assert.equal(payloads[payloads.length - 1], '[DONE]')

  const chunks = payloads.filter((line) => line !== '[DONE]').map((line) => JSON.parse(line) as Record<string, unknown>)
  const deltas = chunks.map((chunk) => ((chunk.choices as Array<Record<string, unknown>>)[0] ?? {}).delta)
  assert.deepEqual(deltas[0], { role: 'assistant', content: '' })
  const content = deltas
    .filter((delta): delta is Record<string, unknown> => typeof delta === 'object' && delta !== null)
    .map((delta) => delta.content)
    .filter((value) => typeof value === 'string')
    .join('')
  assert.equal(content, '你好')
  const finish = (chunks[chunks.length - 2]!.choices as Array<Record<string, unknown>>)[0]!
  assert.equal(finish.finish_reason, 'stop')
  assert.deepEqual(chunks[chunks.length - 1]!.usage, { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 })
})

test('协议判定：官方地址自动走 Anthropic，中转站与显式覆盖各按各的', () => {
  assert.equal(apiShapeFor(vendor()), 'anthropic-messages')
  assert.equal(apiShapeFor(vendor({ customUrl: 'https://relay.example.com/v1', endpointSource: 'relay' })), 'openai-completions')
  assert.equal(apiShapeFor(vendor({ api: 'openai-completions' })), 'openai-completions')
  assert.equal(apiShapeFor(vendor({ vendorId: 'deepseek', officialUrl: 'https://api.deepseek.com/v1', endpointSource: 'official' })), 'openai-completions')
})

test('池合成：api 形状跟着厂商配置进池', () => {
  const pool = synthesizePool([
    vendor(),
    vendor({ vendorId: 'openai', officialUrl: 'https://relay.example.com/v1', enabledModels: ['gpt-6-astra'] }),
  ], 'frugal', { exact_match: false, max_entries: 10, ttl_ms: 1_000 })
  assert.equal(pool.providers[0]!.api, 'anthropic-messages')
  assert.equal(pool.providers[1]!.api, 'openai-completions')
})
