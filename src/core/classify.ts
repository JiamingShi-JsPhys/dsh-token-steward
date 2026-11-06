/**
 * 上游失败 → ErrorKind 的分类。
 *
 * 纯函数：只看 HTTP 状态码、错误体与异常消息，不读时钟、不发请求。
 * 分类决定接下来的动作（冷却 / 熔断 / 换模型 / 不重试），因此这是整个
 * 容灾链路里最需要被单测钉死的一环。
 *
 * 判定顺序刻意是「状态码优先，文本兜底」：状态码是协议事实，文本是各家
 * 供应商的不同写法（DeepSeek、GLM、OpenRouter 各家措辞都不一样）。
 */
import type { ErrorKind } from './types.ts'

/** 一次失败的可分类事实。 */
export interface FailureFacts {
  /** HTTP 状态码；连接层失败时没有。 */
  status?: number
  /** 上游返回的错误体（已解析或纯文本，都可）。 */
  body?: unknown
  /** 传输层异常消息（ECONNRESET、ENOTFOUND 之类）。 */
  message?: string
  /** 是否由调用方主动取消。 */
  aborted?: boolean
}

/** 文本里出现这些片段就说明上下文塞不下。 */
const CONTEXT_OVERFLOW_PATTERNS = [
  'context length',
  'context_length',
  'maximum context',
  'too many tokens',
  'token limit',
  'reduce the length',
  'prompt is too long',
  'input is too long',
]

/** 文本里出现这些片段就说明是限流。 */
const RATE_LIMIT_PATTERNS = ['rate limit', 'rate_limit', 'too many requests', 'quota exceeded', 'overloaded']

/** 文本里出现这些片段就说明是凭据问题。 */
const AUTH_PATTERNS = ['invalid api key', 'incorrect api key', 'unauthorized', 'authentication', 'api key not valid', 'invalid_api_key']

/** 文本里出现这些片段就说明是传输层抖动。 */
const TRANSPORT_PATTERNS = ['econnreset', 'econnrefused', 'enotfound', 'etimedout', 'socket hang up', 'network', 'fetch failed', 'premature close']

/** 把错误体压成可搜索的小写文本。 */
export function bodyText(body: unknown): string {
  if (body === undefined || body === null) return ''
  if (typeof body === 'string') return body.toLowerCase()
  try {
    return JSON.stringify(body).toLowerCase()
  } catch {
    return ''
  }
}

/** 从错误体里取出人类可读的消息，用于向客户端回传。 */
export function errorMessageOf(body: unknown, fallback: string): string {
  if (typeof body === 'string' && body.trim() !== '') return body.slice(0, 500)
  if (typeof body === 'object' && body !== null) {
    const record = body as { error?: unknown, message?: unknown }
    const error = record.error
    if (typeof error === 'string' && error !== '') return error.slice(0, 500)
    if (typeof error === 'object' && error !== null) {
      const message = (error as { message?: unknown }).message
      if (typeof message === 'string' && message !== '') return message.slice(0, 500)
    }
    if (typeof record.message === 'string' && record.message !== '') return record.message.slice(0, 500)
  }
  return fallback
}

/**
 * 分类一次失败。
 * @param facts - 状态码、错误体、异常消息与取消标记。
 * @returns 错误类别；换模型有意义时调用方据此取下一个候选。
 */
export function classifyFailure(facts: FailureFacts): ErrorKind {
  if (facts.aborted === true) return 'aborted'

  const text = bodyText(facts.body) + ' ' + (facts.message ?? '').toLowerCase()
  const status = facts.status

  // 上下文超限优先于普通 400：它要求的是「换更大的窗口」，不是「请求写错了」。
  if (status === 413) return 'context-overflow'
  if (status === 400 && CONTEXT_OVERFLOW_PATTERNS.some((pattern) => text.includes(pattern))) {
    return 'context-overflow'
  }

  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate-limit'
  if (status === 408) return 'timeout'
  if (status !== undefined && status >= 500) return 'server'

  // 没有状态码（连接层失败）时只能靠文本。
  if (status === undefined) {
    if (TRANSPORT_PATTERNS.some((pattern) => text.includes(pattern))) return 'transport'
    if (AUTH_PATTERNS.some((pattern) => text.includes(pattern))) return 'auth'
    if (RATE_LIMIT_PATTERNS.some((pattern) => text.includes(pattern))) return 'rate-limit'
    if (text.includes('timeout')) return 'timeout'
  }

  if (status === 400 || status === 422) {
    // 400 里也可能藏着限流 / 上下文 / 凭据的真实原因，文本兜底。
    if (RATE_LIMIT_PATTERNS.some((pattern) => text.includes(pattern))) return 'rate-limit'
    if (AUTH_PATTERNS.some((pattern) => text.includes(pattern))) return 'auth'
    if (CONTEXT_OVERFLOW_PATTERNS.some((pattern) => text.includes(pattern))) return 'context-overflow'
    return 'bad-request'
  }

  return 'server'
}

/** 该错误换一个模型重试是否有意义。 */
export function worthRetrying(kind: ErrorKind): boolean {
  // 请求本身写错了，换模型也是错的；凭据坏了，换模型是唯一出路。
  return kind !== 'bad-request' && kind !== 'aborted'
}
