/**
 * Anthropic Messages API（`POST /v1/messages`）兼容层。
 *
 * 为什么放在宿主最边上：管家对客户端永远只说一种话——OpenAI 的
 * `/chat/completions`。要接的这家上游说的是 Anthropic 的 `/messages`
 * （官方端点就是），于是进出各翻一次：
 *
 *   客户端 → OpenAI 请求 → **本层翻译** → Anthropic 请求 → 上游
 *   上游 → Anthropic 响应/SSE → **本层翻译** → OpenAI 响应/SSE → 客户端
 *
 * 这样网关、路由、计量、缓存全都不用知道第二套协议：`relay` 拿到的仍然是
 * OpenAI 形状的字节，`usageFromBody` / `lastUsageFromSse` 照常读得到 usage。
 *
 * 只翻译认识的字段。Anthropic 对未知字段直接 400，所以出站体是白名单拼出来的，
 * 不做「原样透传」。
 */
import type { ProviderEntry } from '../core/types.ts'

/** Anthropic 要求带版本头；2023-06-01 是长期稳定的那个。 */
export const ANTHROPIC_VERSION = '2023-06-01'

/** 请求没写 max_tokens 时的兜底：Anthropic 的 max_tokens 是必填项。 */
const DEFAULT_MAX_TOKENS = 8_192

/**
 * 单次输出上限的天花板。
 *
 * DSH 的 profile 里写的是 `defaultMaxTokens: 65536`，Anthropic 官方不吃这一套：
 * 不带 beta 头时多数模型的上限是 32k，超过就直接 400 `max_tokens: 65536 > 32000`。
 * 网关替它压到 32k——少一点输出总比整轮请求失败好。
 */
const MAX_OUTPUT_TOKENS = 32_000

/** 上游端点 → `/messages`（用户可能填了 `…/v1`，也可能只填到域名）。 */
export function anthropicUrl(providerEntry: ProviderEntry): string {
  const base = providerEntry.endpoint.replace(/\/+$/, '')
  return /\/v\d+$/.test(base) ? base + '/messages' : base + '/v1/messages'
}

/** Anthropic 用 `x-api-key`，不是 `Authorization: Bearer`。 */
export function anthropicHeaders(providerEntry: ProviderEntry, secret: string): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'text/event-stream, application/json',
    'anthropic-version': ANTHROPIC_VERSION,
  }
  for (const [name, value] of Object.entries(providerEntry.headers)) {
    headers[name.toLowerCase()] = value
  }
  if (secret !== '') headers['x-api-key'] = secret
  return headers
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 把 OpenAI 的 content（字符串或部件数组）压成纯文本。 */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    if (typeof part === 'string') parts.push(part)
    else if (isRecord(part) && typeof part.text === 'string') parts.push(part.text)
  }
  return parts.join('')
}

/** OpenAI 的图片部件 → Anthropic 的 image 块；不认识的部件丢掉。 */
function imageBlock(part: Record<string, unknown>): Record<string, unknown> | undefined {
  const image = isRecord(part.image_url) ? part.image_url : undefined
  const url = image !== undefined && typeof image.url === 'string' ? image.url : undefined
  if (url === undefined) return undefined
  const dataUrl = /^data:([^;,]+);base64,(.*)$/s.exec(url)
  if (dataUrl !== null) {
    return {
      type: 'image',
      source: { type: 'base64', media_type: dataUrl[1], data: dataUrl[2] },
    }
  }
  return { type: 'image', source: { type: 'url', url } }
}

/** 一条 OpenAI 消息的 content → Anthropic 的 content 块数组。 */
function toAnthropicParts(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === 'string') {
    return content === '' ? [] : [{ type: 'text', text: content }]
  }
  if (!Array.isArray(content)) return []
  const parts: Array<Record<string, unknown>> = []
  for (const part of content) {
    if (typeof part === 'string') {
      if (part !== '') parts.push({ type: 'text', text: part })
      continue
    }
    if (!isRecord(part)) continue
    if (part.type === 'image_url' || part.type === 'input_image') {
      const block = imageBlock(part)
      if (block !== undefined) parts.push(block)
      continue
    }
    if (typeof part.text === 'string' && part.text !== '') {
      parts.push({ type: 'text', text: part.text })
    }
  }
  return parts
}

/** OpenAI 的 tools → Anthropic 的 tools。 */
function toAnthropicTools(body: Record<string, unknown>): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(body.tools)) return undefined
  const tools: Array<Record<string, unknown>> = []
  for (const entry of body.tools) {
    if (!isRecord(entry)) continue
    const fn = isRecord(entry.function) ? entry.function : entry
    const name = typeof fn.name === 'string' ? fn.name : ''
    if (name === '') continue
    tools.push({
      name,
      ...(typeof fn.description === 'string' && fn.description !== '' ? { description: fn.description } : {}),
      input_schema: isRecord(fn.parameters) ? fn.parameters : { type: 'object', properties: {} },
    })
  }
  return tools.length > 0 ? tools : undefined
}

/** OpenAI 的 tool_choice → Anthropic 的 tool_choice。 */
function toAnthropicToolChoice(value: unknown, hasTools: boolean): Record<string, unknown> | undefined {
  if (!hasTools) return undefined
  if (value === 'auto') return { type: 'auto' }
  if (value === 'required' || value === 'any') return { type: 'any' }
  if (value === 'none') return { type: 'none' }
  if (isRecord(value)) {
    const fn = isRecord(value.function) ? value.function : value
    if (typeof fn.name === 'string' && fn.name !== '') return { type: 'tool', name: fn.name }
  }
  return undefined
}

/**
 * OpenAI 请求体 → Anthropic 请求体。
 * @param body - 已经过 `rewriteBody` / `clampOutputToWindow` 的客户端请求。
 * @param upstreamModel - 上游真实模型 id（已写进 body.model，这里只做兜底）。
 */
export function toAnthropicBody(body: Record<string, unknown>, upstreamModel: string): Record<string, unknown> {
  const system: string[] = []
  const messages: Array<Record<string, unknown>> = []

  const push = (role: 'user' | 'assistant', content: Array<Record<string, unknown>>): void => {
    if (content.length === 0) return
    const previous = messages[messages.length - 1]
    // Anthropic 要求 user / assistant 交替：同角色相邻就并成一条。
    if (previous !== undefined && previous.role === role && Array.isArray(previous.content)) {
      previous.content = [...(previous.content as Array<Record<string, unknown>>), ...content]
      return
    }
    messages.push({ role, content })
  }

  const raw = Array.isArray(body.messages) ? body.messages : []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const role = item.role
    if (role === 'system' || role === 'developer') {
      const text = textOf(item.content)
      if (text !== '') system.push(text)
      continue
    }
    if (role === 'tool' || role === 'function') {
      const id = typeof item.tool_call_id === 'string' ? item.tool_call_id : ''
      if (id === '') continue
      push('user', [{ type: 'tool_result', tool_use_id: id, content: textOf(item.content) }])
      continue
    }
    if (role === 'assistant') {
      const parts = toAnthropicParts(item.content)
      if (Array.isArray(item.tool_calls)) {
        for (const call of item.tool_calls) {
          if (!isRecord(call)) continue
          const fn = isRecord(call.function) ? call.function : {}
          const name = typeof fn.name === 'string' ? fn.name : ''
          if (name === '') continue
          const args = typeof fn.arguments === 'string' ? fn.arguments : ''
          parts.push({
            type: 'tool_use',
            id: typeof call.id === 'string' ? call.id : 'toolu_' + name,
            name,
            input: parseJsonObject(args),
          })
        }
      }
      push('assistant', parts)
      continue
    }
    push('user', toAnthropicParts(item.content))
  }

  // Anthropic 的对话必须从 user 开始；历史里若以助手开场，丢掉那一截
  // （它没有对应的提问，模型也接不上）。
  while (messages.length > 0 && messages[0]?.role !== 'user') messages.shift()

  const maxTokens = typeof body.max_tokens === 'number'
    ? body.max_tokens
    : typeof body.max_completion_tokens === 'number' ? body.max_completion_tokens : DEFAULT_MAX_TOKENS

  const tools = toAnthropicTools(body)
  const toolChoice = toAnthropicToolChoice(body.tool_choice, tools !== undefined)

  const temperature = typeof body.temperature === 'number'
    ? Math.min(1, Math.max(0, body.temperature))
    : undefined

  const stop = Array.isArray(body.stop)
    ? body.stop.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
    : typeof body.stop === 'string' && body.stop !== '' ? [body.stop] : undefined

  return {
    model: typeof body.model === 'string' ? body.model : upstreamModel,
    max_tokens: Math.max(1, Math.min(MAX_OUTPUT_TOKENS, Math.floor(maxTokens))),
    messages,
    ...(system.length > 0 ? { system: system.join('\n\n') } : {}),
    ...(temperature === undefined ? {} : { temperature }),
    ...(typeof body.top_p === 'number' ? { top_p: body.top_p } : {}),
    ...(stop === undefined ? {} : { stop_sequences: stop }),
    ...(body.stream === true ? { stream: true } : {}),
    ...(tools === undefined ? {} : { tools }),
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
    ...(typeof body.user === 'string' && body.user !== '' ? { metadata: { user_id: body.user } } : {}),
  }
}

/** 助手发来的 arguments 是 JSON 字符串；解析不了就当空对象（Anthropic 要对象）。 */
function parseJsonObject(text: string): Record<string, unknown> {
  if (text === '') return {}
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** Anthropic 的 stop_reason → OpenAI 的 finish_reason。 */
function finishReasonOf(reason: unknown): string {
  switch (reason) {
    case 'max_tokens': return 'length'
    case 'tool_use': return 'tool_calls'
    case 'refusal': return 'content_filter'
    default: return 'stop'
  }
}

/** Anthropic 的 usage → OpenAI 的 usage（缓存的读写在 OpenAI 里都算 prompt）。 */
export function usageToOpenAI(usage: unknown): Record<string, unknown> | undefined {
  if (!isRecord(usage)) return undefined
  const input = numberOrZero(usage.input_tokens)
  const cacheRead = numberOrZero(usage.cache_read_input_tokens)
  const cacheWrite = numberOrZero(usage.cache_creation_input_tokens)
  const output = numberOrZero(usage.output_tokens)
  const prompt = input + cacheRead + cacheWrite
  return {
    prompt_tokens: prompt,
    completion_tokens: output,
    total_tokens: prompt + output,
    ...(cacheRead > 0 ? { prompt_tokens_details: { cached_tokens: cacheRead } } : {}),
    ...(cacheWrite > 0 ? { cache_write_tokens: cacheWrite } : {}),
  }
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * 流式 usage 的合并。
 *
 * Anthropic 的 `message_start` 带 input_tokens、`message_delta` 只带 output_tokens，
 * 后一帧**不是**前一帧的完整替代——直接覆盖会把输入侧的账抹成 0。
 */
export function mergeUsage(
  previous: Record<string, unknown> | undefined,
  next: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (previous === undefined) return next
  if (next === undefined) return previous
  const prompt = Math.max(numberOrZero(previous.prompt_tokens), numberOrZero(next.prompt_tokens))
  const completion = Math.max(numberOrZero(previous.completion_tokens), numberOrZero(next.completion_tokens))
  const cached = Math.max(cachedOf(previous), cachedOf(next))
  const written = Math.max(numberOrZero(previous.cache_write_tokens), numberOrZero(next.cache_write_tokens))
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    ...(cached > 0 ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
    ...(written > 0 ? { cache_write_tokens: written } : {}),
  }
}

/** 取 `prompt_tokens_details.cached_tokens`。 */
function cachedOf(usage: Record<string, unknown>): number {
  const details = usage.prompt_tokens_details
  return typeof details === 'object' && details !== null
    ? numberOrZero((details as Record<string, unknown>).cached_tokens)
    : 0
}

/** Anthropic 的非流式响应 → OpenAI 的 `chat.completion`。 */
export function anthropicToOpenAI(value: unknown, fallbackModel: string): Record<string, unknown> {
  if (!isRecord(value)) return { error: { message: 'unexpected anthropic response' } }
  const blocks = Array.isArray(value.content) ? value.content : []
  const texts: string[] = []
  const toolCalls: Array<Record<string, unknown>> = []
  for (const block of blocks) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
    if (block.type === 'tool_use') {
      toolCalls.push({
        id: typeof block.id === 'string' ? block.id : 'toolu_' + String(toolCalls.length),
        type: 'function',
        function: {
          name: typeof block.name === 'string' ? block.name : '',
          arguments: JSON.stringify(isRecord(block.input) ? block.input : {}),
        },
      })
    }
  }
  const usage = usageToOpenAI(value.usage)
  return {
    id: typeof value.id === 'string' ? value.id : 'chatcmpl-' + String(Date.now()),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: typeof value.model === 'string' ? value.model : fallbackModel,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: texts.length > 0 ? texts.join('') : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: finishReasonOf(value.stop_reason),
    }],
    ...(usage === undefined ? {} : { usage }),
  }
}

/** SSE 帧：`event: x\ndata: {...}`。只取 data，event 名与 data.type 重复。 */
function parseFrame(frame: string): Record<string, unknown> | undefined {
  const data: string[] = []
  for (const line of frame.split('\n')) {
    if (!line.startsWith('data:')) continue
    data.push(line.slice(5).trim())
  }
  const payload = data.join('')
  if (payload === '' || payload === '[DONE]') return undefined
  try {
    const parsed: unknown = JSON.parse(payload)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Anthropic SSE → OpenAI `chat.completion.chunk` SSE。
 *
 * 返回一个 TransformStream：网关的 `relay` 原样把它写回客户端，
 * 末尾带 usage 的那一帧让 `lastUsageFromSse` 照样记得上账。
 */
export function createAnthropicStream(model: string): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const id = 'chatcmpl-' + String(Date.now())
  const created = Math.floor(Date.now() / 1000)
  let buffer = ''
  let started = false
  let finished = false
  let stopReason: unknown
  let usage: Record<string, unknown> | undefined
  /** Anthropic 的 content block 下标 → OpenAI tool_calls 下标（只给 tool_use 分配）。 */
  const toolIndexByBlock = new Map<number, number>()

  const emit = (delta: Record<string, unknown>, finishReason: string | null = null): Uint8Array => encoder.encode(
    'data: ' + JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    }) + '\n\n',
  )

  const ensureStarted = (): Uint8Array[] => {
    if (started) return []
    started = true
    return [emit({ role: 'assistant', content: '' })]
  }

  const handle = (event: Record<string, unknown>): Uint8Array[] => {
    const out: Uint8Array[] = []
    const type = event.type
    if (type === 'message_start') {
      const message = isRecord(event.message) ? event.message : {}
      usage = usageToOpenAI(message.usage)
      out.push(...ensureStarted())
      return out
    }
    if (type === 'content_block_start') {
      const block = isRecord(event.content_block) ? event.content_block : {}
      const index = typeof event.index === 'number' ? event.index : 0
      out.push(...ensureStarted())
      if (block.type === 'tool_use') {
        const toolIndex = toolIndexByBlock.size
        toolIndexByBlock.set(index, toolIndex)
        out.push(emit({
          tool_calls: [{
            index: toolIndex,
            id: typeof block.id === 'string' ? block.id : 'toolu_' + String(toolIndex),
            type: 'function',
            function: { name: typeof block.name === 'string' ? block.name : '', arguments: '' },
          }],
        }))
      }
      return out
    }
    if (type === 'content_block_delta') {
      const delta = isRecord(event.delta) ? event.delta : {}
      const index = typeof event.index === 'number' ? event.index : 0
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        out.push(emit({ content: delta.text }))
      } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        out.push(emit({ reasoning_content: delta.thinking }))
      } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        const toolIndex = toolIndexByBlock.get(index)
        if (toolIndex !== undefined) {
          out.push(emit({ tool_calls: [{ index: toolIndex, function: { arguments: delta.partial_json } }] }))
        }
      }
      return out
    }
    if (type === 'message_delta') {
      const delta = isRecord(event.delta) ? event.delta : {}
      if (delta.stop_reason !== undefined) stopReason = delta.stop_reason
      // message_delta 只带 output_tokens：合并而不是覆盖，输入侧不能丢。
      usage = mergeUsage(usage, usageToOpenAI(event.usage))
      return out
    }
    if (type === 'message_stop') {
      out.push(...ensureStarted())
      out.push(emit({}, finishReasonOf(stopReason)))
      finished = true
      out.push(encoder.encode('data: ' + JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [],
        ...(usage === undefined ? {} : { usage }),
      }) + '\n\n'))
      out.push(encoder.encode('data: [DONE]\n\n'))
      return out
    }
    if (type === 'error') {
      const error = isRecord(event.error) ? event.error : {}
      out.push(encoder.encode('data: ' + JSON.stringify({
        error: { message: typeof error.message === 'string' ? error.message : 'anthropic stream error', type: 'upstream_error' },
      }) + '\n\n'))
      return out
    }
    // ping 与未知事件：忽略。
    return out
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      for (;;) {
        const split = buffer.indexOf('\n\n')
        if (split < 0) break
        const frame = buffer.slice(0, split)
        buffer = buffer.slice(split + 2)
        const event = parseFrame(frame)
        if (event === undefined) continue
        for (const bytes of handle(event)) controller.enqueue(bytes)
      }
    },
    flush(controller) {
      // 上游没发 message_stop 就断了：补一帧收尾，客户端不会挂在半截流上。
      if (finished) return
      const event = parseFrame(buffer)
      if (event !== undefined) for (const bytes of handle(event)) controller.enqueue(bytes)
      if (finished) return
      controller.enqueue(emit({}, finishReasonOf(stopReason)))
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
    },
  })
}
