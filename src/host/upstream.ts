/**
 * 网关请求转发：把一次路由决策变成一次真实的上游调用，并在失败时降级。
 *
 * 这里唯一有副作用的模块，因此它被刻意写得很薄：
 *  - 选谁、该不该换人 → 全部由 core/router 决定；
 *  - 失败怎么归类 → 全部由 core/classify 决定；
 *  - 本文件只负责「拿决策 → 发请求 → 回报结果 → 需要时再来一次」。
 *
 * 一条关键纪律：**首字节一旦写给客户端，就不能再降级**。重发会让上游
 * 产生第二份副作用（工具调用、写文件），而客户端只看到半截流。
 */
import type { AttemptResult, ErrorKind, PoolConfig, ProviderEntry, ModelEntry, RouteDecision, TokenUsage } from '../core/types.ts'
import { classifyFailure, errorMessageOf } from '../core/classify.ts'
import { estimateInputTokens } from '../core/intent.ts'
import { anthropicHeaders, anthropicToOpenAI, anthropicUrl, createAnthropicStream, toAnthropicBody } from './anthropic.ts'

/** fetch 的最小形状；测试注入假实现，生产用全局 fetch。 */
export type FetchLike = (input: string, init: Record<string, unknown>) => Promise<Response>

/** 一次上游尝试的产物。 */
export interface UpstreamAttempt {
  ok: boolean
  /** 成功时的响应（body 尚未消费）。 */
  response?: Response
  /** 失败时的分类。 */
  errorKind?: ErrorKind
  /** 失败时可供客户端展示的消息。 */
  message?: string
  /** HTTP 状态码（如有）。 */
  status?: number
  /** 上游报的 usage（非流式时直接可读；流式由调用方在收尾时解析）。 */
  usage?: TokenUsage
  /** 已向客户端写过首字节。 */
  committed: boolean
}

/** 一次转发的上下文。 */
export interface DispatchContext {
  /** 本次请求的稳定 id。 */
  requestId: string
  /** 客户端原始请求体。 */
  body: Record<string, unknown>
  /** 客户端是否要求流式。 */
  stream: boolean
  /** 取消信号。 */
  signal?: AbortSignal
  /** provider → 已展开的凭据明文；缺失表示该 provider 不可用。 */
  secrets: Map<string, string>
  /**
   * 这个会话上一轮真正服务的 provider（来自路由引擎的粘性表）。
   * 为空表示新会话或上一轮没成功——此时没有「上一家的私有格式」要清。
   */
  previousProvider?: string
  /** 额外注入的 header（来自 provider 配置）。 */
  fetchImpl: FetchLike
  /** 当前毫秒。 */
  now(): number
}

/** 从配置里按 key 找 provider 与 model。 */
export function findRoute(config: PoolConfig, provider: string, model: string): { provider: ProviderEntry; model: ModelEntry } | undefined {
  for (const entry of config.providers) {
    if (entry.provider_name !== provider) continue
    for (const candidate of entry.models) {
      if (candidate.id === model) return { provider: entry, model: candidate }
    }
  }
  return undefined
}

/** 把 provider 配置里的 header 展开成对象（值可以是 {{secret}} 占位）。 */
export function buildHeaders(providerEntry: ProviderEntry, secret: string): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'text/event-stream, application/json',
  }
  for (const [name, value] of Object.entries(providerEntry.headers)) {
    headers[name.toLowerCase()] = value
  }
  if (secret !== '') headers.authorization = 'Bearer ' + secret
  return headers
}

/** 把请求体里的 model 换成上游真实 id，其余字段原样透传。 */
export function rewriteBody(body: Record<string, unknown>, upstreamModel: string): Record<string, unknown> {
  const next: Record<string, unknown> = { ...body, model: upstreamModel }
  // 网关照常请求 usage，即使客户端没要：计量需要它，且不影响客户端看到的流。
  if (next.stream === true) {
    const existing = typeof next.stream_options === 'object' && next.stream_options !== null
      ? next.stream_options as Record<string, unknown>
      : {}
    next.stream_options = { ...existing, include_usage: true }
  }
  return next
}

/**
 * 把出站 max_tokens 压进这个模型的剩余窗口。
 *
 * 客户端（含 DSH 自己）会按「模型很大」要一个 64k 的输出上限；上游窗口 128k、
 * 这一轮输入 67k 时，64k 的输出就超了，Agnes 这类上游直接 400
 * （`max_tokens 不能超过 65536` / context_length_exceeded）。
 * 路由器已经保证输入放得下，这里把输出砍到「窗口 - 输入」，请求就能跑完。
 */
export function clampOutputToWindow(body: Record<string, unknown>, contextWindow: number): Record<string, unknown> {
  if (!(contextWindow > 0)) return body
  const room = contextWindow - estimateInputTokens(body)
  if (room <= 0) return body
  for (const field of ['max_tokens', 'max_completion_tokens'] as const) {
    const value = body[field]
    if (typeof value === 'number' && Number.isFinite(value) && value > room) {
      body[field] = Math.floor(room)
    }
  }
  return body
}

/* ─────────────────────── 换模型时的上下文继续 ─────────────────────── */

/**
 * 各家在助手消息上回写的「思考痕迹」字段。同一家厂商自己认得，
 * 换一家严格些的上游就会 400，或者把上一家模型的思考过程当正文喂进去。
 */
const REASONING_FIELDS = ['reasoning_content', 'reasoning', 'reasoning_details'] as const

/** content 部件里的思考块（Anthropic 形状中转站会带）。 */
const THINKING_PART_TYPES = new Set(['thinking', 'redacted_thinking'])

/**
 * 跨厂商请求归一化：切换模型时保住上下文、去掉不属于新厂商的东西。
 *
 * 先说清楚能保住什么、保不住什么：
 *  - **消息日志由客户端原样带着走**（DSH 的会话层不会因为换模型丢历史），
 *    所以语义上下文不会丢——新模型看到的是同一条完整对话。
 *  - 换模型真正丢的是上游的**前缀缓存**（KV 复用），以及「上一家的私有字段」。
 *    前者靠路由的会话粘性（同一会话优先沿用上次成功的模型）来少丢；
 *    后者在这里清掉：
 *      · 助手消息上的 reasoning_content / reasoning / reasoning_details；
 *      · content 部件里的 thinking / redacted_thinking 块；
 *      · content 部件与消息上的 cache_control（属于上一家的缓存协议）。
 *
 * 只在**目标厂商 ≠ 上一轮服务的厂商**时动手；同一厂商内换模型保持原样，
 * 那是它自己的格式，剥掉反而丢信息。没有历史（previousProvider 为空）时不动。
 */
export function normalizeCrossProviderBody(
  body: Record<string, unknown>,
  targetProvider: string,
  previousProvider?: string,
): Record<string, unknown> {
  if (previousProvider === undefined || previousProvider === targetProvider) return body
  const messages = body.messages
  if (!Array.isArray(messages)) return body
  let changed = false
  const nextMessages = messages.map((message) => {
    const normalized = normalizeMessage(message)
    if (normalized.changed) changed = true
    return normalized.message
  })
  return changed ? { ...body, messages: nextMessages } : body
}

/** 清掉一条消息里跨厂商无意义的字段。 */
function normalizeMessage(message: unknown): { message: unknown; changed: boolean } {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return { message, changed: false }
  }
  const record = message as Record<string, unknown>
  let next: Record<string, unknown> | undefined
  const clone = (): Record<string, unknown> => (next ??= { ...record })
  let changed = false

  if (record.role === 'assistant') {
    for (const field of REASONING_FIELDS) {
      if (field in record) {
        delete clone()[field]
        changed = true
      }
    }
  }
  if ('cache_control' in record) {
    delete clone().cache_control
    changed = true
  }
  if (Array.isArray(record.content)) {
    const parts: unknown[] = []
    let partsChanged = false
    for (const part of record.content) {
      const stripped = normalizePart(part)
      if (stripped.changed) partsChanged = true
      if (stripped.part !== null) parts.push(stripped.part)
    }
    if (partsChanged) {
      // 只剩思考块的消息会变成空数组；OpenAI 形状用 null 表示「没有正文」。
      clone().content = parts.length === 0 ? null : parts
      changed = true
    }
  }

  return { message: changed ? clone() : message, changed }
}

/** 清掉一个 content 部件里的思考块与缓存标记；思考块本身返回 null 表示丢弃。 */
function normalizePart(part: unknown): { part: unknown; changed: boolean } {
  if (typeof part !== 'object' || part === null) return { part, changed: false }
  const record = part as Record<string, unknown>
  const type = typeof record.type === 'string' ? record.type : ''
  if (THINKING_PART_TYPES.has(type)) return { part: null, changed: true }
  if (!('cache_control' in record)) return { part, changed: false }
  const next = { ...record }
  delete next.cache_control
  return { part: next, changed: true }
}

/** 上游 URL：endpoint 已经是 …/v1，拼上 /chat/completions。 */
export function upstreamUrl(providerEntry: ProviderEntry): string {
  const base = providerEntry.endpoint.replace(/\/+$/, '')
  return base + '/chat/completions'
}

/** 从非流式响应体里读 usage。 */
export function usageFromBody(body: unknown): TokenUsage | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const usage = (body as { usage?: unknown }).usage
  if (typeof usage !== 'object' || usage === null) return undefined
  const record = usage as Record<string, unknown>
  const prompt = numberOrZero(record.prompt_tokens)
  const completion = numberOrZero(record.completion_tokens)
  const details = typeof record.prompt_tokens_details === 'object' && record.prompt_tokens_details !== null
    ? record.prompt_tokens_details as Record<string, unknown>
    : {}
  const completionDetails = typeof record.completion_tokens_details === 'object' && record.completion_tokens_details !== null
    ? record.completion_tokens_details as Record<string, unknown>
    : {}
  return {
    input: prompt,
    output: completion,
    cacheRead: numberOrZero(details.cached_tokens) || numberOrZero(record.prompt_cache_hit_tokens),
    cacheWrite: numberOrZero(details.cache_write_tokens),
    reasoning: numberOrZero(completionDetails.reasoning_tokens),
  }
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * 执行一次上游尝试。
 * @param context - 转发上下文（含 fetch 实现与凭据）。
 * @param config - 矩阵配置（用来解析 provider 与 model）。
 * @param provider - provider 名。
 * @param model - 模型 id。
 * @returns 尝试结果；不抛错（除取消失败外的一切都变成分类结果）。
 */
export async function attemptOnce(
  context: DispatchContext,
  config: PoolConfig,
  provider: string,
  model: string,
): Promise<UpstreamAttempt> {
  const found = findRoute(config, provider, model)
  if (found === undefined) {
    return { ok: false, errorKind: 'bad-request', message: 'unknown route ' + provider + '/' + model, committed: false }
  }
  const secret = context.secrets.get(provider)
  if (secret === undefined) {
    return { ok: false, errorKind: 'auth', message: 'no credential for provider ' + provider, committed: false }
  }

  const timeoutMs = found.provider.timeout_ms ?? config.defaults.timeout_ms
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, timeoutMs)
  const signals: AbortSignal[] = [controller.signal]
  if (context.signal !== undefined) signals.push(context.signal)

  try {
    const outbound = normalizeCrossProviderBody(
      rewriteBody(context.body, found.model.id),
      found.provider.provider_name,
      context.previousProvider,
    )
    // Anthropic 形状的上游：请求体与 header 换一套，地址换成 /v1/messages。
    const anthropic = found.provider.api === 'anthropic-messages'
    const payload = clampOutputToWindow(outbound, found.model.context_window)
    const response = await context.fetchImpl(anthropic ? anthropicUrl(found.provider) : upstreamUrl(found.provider), {
      method: 'POST',
      headers: anthropic ? anthropicHeaders(found.provider, secret) : buildHeaders(found.provider, secret),
      body: JSON.stringify(anthropic ? toAnthropicBody(payload, found.model.id) : payload),
      signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
    })

    if (response.ok) {
      // 客户端只认 OpenAI 形状：响应在交给 relay 之前翻回来，计量与缓存都不用改。
      const translated = anthropic
        ? await translateAnthropicResponse(response, context.stream, found.model.id)
        : response
      return { ok: true, response: translated, committed: false, status: translated.status }
    }

    // 失败：读一次错误体（有界），分类后交给上层决定换谁。
    const text = await readBounded(response)
    const errorKind = classifyFailure({ status: response.status, body: text })
    return {
      ok: false,
      errorKind,
      status: response.status,
      message: errorMessageOf(text, 'upstream ' + String(response.status)),
      committed: false,
    }
  } catch (error) {
    const aborted = controller.signal.aborted || context.signal?.aborted === true
    const errorKind = classifyFailure({
      message: messageOf(error),
      ...(aborted ? { aborted: context.signal?.aborted === true } : {}),
    })
    return { ok: false, errorKind, message: messageOf(error), committed: false }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Anthropic 响应 → OpenAI 形状。
 *
 * 流式直接套一个 TransformStream；非流式读完 JSON 再翻。
 * 翻不动时原样返回——让分类器按上游的原始错误去判，别在这里吞掉。
 */
async function translateAnthropicResponse(response: Response, stream: boolean, model: string): Promise<Response> {
  if (stream && response.body !== null) {
    return new Response(response.body.pipeThrough(createAnthropicStream(model)), {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    })
  }
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return new Response(text, { status: response.status, headers: { 'content-type': 'application/json' } })
  }
  return new Response(JSON.stringify(anthropicToOpenAI(parsed, model)), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** 有界读取响应体（错误体不该是无底洞）。 */
async function readBounded(response: Response, limit = 64 * 1024): Promise<string> {
  try {
    const text = await response.text()
    return text.length > limit ? text.slice(0, limit) : text
  } catch {
    return ''
  }
}

/** 一次转发的最终结果。 */
export interface DispatchOutcome {
  ok: boolean
  /** 成功时的响应；失败时不存在。 */
  response?: Response | undefined
  /** 最终服务的 provider/model。 */
  provider: string
  model: string
  /** 失败尝试的历史。 */
  degradedFrom: Array<{ provider: string; model: string; errorKind: ErrorKind }>
  /** 全部失败时的错误消息。 */
  message?: string | undefined
  /** 全部失败时的错误类别。 */
  errorKind?: ErrorKind | undefined
  /** 每次尝试的结果，供 router.report 逐条回报。 */
  attempts: Array<{ provider: string; model: string; result: AttemptResult }>
}

/**
 * 按决策执行转发，失败时依次降级。
 * @param context - 转发上下文。
 * @param config - 矩阵配置。
 * @param decision - 路由决策（首选 + 有序降级链）。
 * @param onSettled - 每次尝试结束后的回调（回报给 router）。
 * @returns 最终结果。
 */
export async function dispatch(
  context: DispatchContext,
  config: PoolConfig,
  decision: RouteDecision,
  onSettled: (attempt: AttemptResult) => void,
): Promise<DispatchOutcome> {
  const candidates = [decision.chosen, ...decision.fallbacks]
  const degradedFrom: DispatchOutcome['degradedFrom'] = []
  const attempts: DispatchOutcome['attempts'] = []
  let lastKind: ErrorKind | undefined
  let lastMessage = ''

  for (const [index, candidate] of candidates.entries()) {
    const started = context.now()
    const attempt = await attemptOnce(context, config, candidate.provider, candidate.model)
    const latencyMs = Math.max(0, context.now() - started)

    const result: AttemptResult = {
      requestId: context.requestId,
      provider: candidate.provider,
      model: candidate.model,
      ok: attempt.ok,
      latencyMs,
      committed: attempt.committed,
      ...(attempt.status === undefined ? {} : { httpStatus: attempt.status }),
      ...(attempt.errorKind === undefined ? {} : { errorKind: attempt.errorKind }),
      ...(attempt.usage === undefined ? {} : { usage: attempt.usage }),
    }
    // 最后一次尝试没有后继，标 final 让 router 收口成失败事件。
    if (!attempt.ok && index === candidates.length - 1) result.final = true
    attempts.push({ provider: candidate.provider, model: candidate.model, result })
    onSettled(result)

    if (attempt.ok) {
      return {
        ok: true,
        response: attempt.response,
        provider: candidate.provider,
        model: candidate.model,
        degradedFrom,
        attempts,
      }
    }

    lastKind = attempt.errorKind
    lastMessage = attempt.message ?? ''
    degradedFrom.push({
      provider: candidate.provider,
      model: candidate.model,
      errorKind: attempt.errorKind ?? 'server',
    })
  }

  return {
    ok: false,
    provider: candidates[0]?.provider ?? '',
    model: candidates[0]?.model ?? '',
    degradedFrom,
    message: lastMessage,
    errorKind: lastKind,
    attempts,
  }
}

/** 从 unknown 里取可读消息。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
