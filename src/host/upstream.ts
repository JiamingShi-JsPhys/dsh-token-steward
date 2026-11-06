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
    const response = await context.fetchImpl(upstreamUrl(found.provider), {
      method: 'POST',
      headers: buildHeaders(found.provider, secret),
      body: JSON.stringify(rewriteBody(context.body, found.model.id)),
      signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
    })

    if (response.ok) return { ok: true, response, committed: false, status: response.status }

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
