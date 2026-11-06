/**
 * 本地精确响应缓存（routing.cache.exact_match，默认关闭）。
 *
 * 语义与边界，一句话说清：**同一份 prompt 在 TTL 内重复出现时，直接回放
 * 上一次的响应字节，不出站、不计费。** 键覆盖 prompt 定义性字段与路由形态
 * （虚拟 id、生效模式、流式与否），因此换模式、换形状天然失效。
 *
 * 三条不缓存的硬规则（宁可少缓存，不可回放错答案）：
 *  1. 带 tools 的请求不缓存——工具调用有副作用，回放会让代理以为工具已执行；
 *  2. 序列化超过上限的 prompt 不缓存——内存护栏，也为命中率让路；
 *  3. messages 为空或不可序列化不缓存。
 */
import { createHash } from 'node:crypto'

/** 序列化 prompt 超过这个长度就放弃缓存（内存护栏）。 */
export const MAX_CACHED_PROMPT_CHARS = 64_000

/** 已记录的响应文本超过这个长度就停止记录（响应侧护栏）。 */
export const MAX_CACHED_RESPONSE_CHARS = 64_000

/** 缓存条目：原始字节 + 内容类型 + 实际服务的模型。 */
export interface CachedResponse {
  /** 原样回放的字节（流式即 SSE 帧序列，非流式即 JSON 文本）。 */
  chunks: Uint8Array[]
  contentType: string
  provider: string
  model: string
}

/** 命中/容量统计（面板与测试用）。 */
export interface CacheStatsView {
  hits: number
  misses: number
  size: number
  evictions: number
}

/** LRU + TTL 缓存。get 触碰新鲜度；put 在容量满时逐出最旧的条目。 */
export class LruTtlCache<V> {
  private readonly maxEntries: number
  private readonly ttlMs: number
  private readonly slots = new Map<string, { value: V; createdAt: number }>()
  private hits = 0
  private misses = 0
  private evictions = 0

  constructor(options: { maxEntries?: number; ttlMs?: number } = {}) {
    this.maxEntries = Math.max(1, Math.floor(options?.maxEntries ?? 500))
    this.ttlMs = Math.max(1_000, Math.floor(options?.ttlMs ?? 3_600_000))
  }

  /** 命中则刷新 LRU 位置；过期即清除并计一次 miss。 */
  get(key: string, now: number): V | undefined {
    const slot = this.slots.get(key)
    if (slot === undefined) {
      this.misses += 1
      return undefined
    }
    if (now - slot.createdAt >= this.ttlMs) {
      this.slots.delete(key)
      this.misses += 1
      return undefined
    }
    this.slots.delete(key)
    this.slots.set(key, slot)
    this.hits += 1
    return slot.value
  }

  put(key: string, value: V, now: number): void {
    this.slots.delete(key)
    while (this.slots.size >= this.maxEntries) {
      const oldest = this.slots.keys().next()
      if (oldest.done === true) break
      this.slots.delete(oldest.value)
      this.evictions += 1
    }
    this.slots.set(key, { value, createdAt: now })
  }

  get size(): number {
    return this.slots.size
  }

  stats(): CacheStatsView {
    return { hits: this.hits, misses: this.misses, size: this.slots.size, evictions: this.evictions }
  }
}

/**
 * 缓存键：覆盖 prompt 定义性字段与路由形态。
 * @returns undefined 表示这个请求不可缓存。
 */
export function cacheKeyOf(
  body: Record<string, unknown>,
  modelId: string,
  mode: string,
  now?: number,
): string | undefined {
  const messages = body.messages
  if (!Array.isArray(messages) || messages.length === 0) return undefined
  if (Array.isArray(body.tools) && body.tools.length > 0) return undefined
  const fingerprint = {
    // 路由形态：同一个 prompt 在不同模式/虚拟 id/流式形状下不是同一个答案。
    modelId,
    mode,
    stream: body.stream === true,
    // prompt 定义性字段。
    messages,
    system: body.system,
    temperature: body.temperature,
    top_p: body.top_p,
    max_tokens: body.max_tokens,
    max_completion_tokens: body.max_completion_tokens,
    n: body.n,
    stop: body.stop,
    response_format: body.response_format,
  }
  let serialized: string
  try {
    serialized = JSON.stringify(fingerprint)
  } catch {
    return undefined
  }
  if (serialized === undefined || serialized.length > MAX_CACHED_PROMPT_CHARS) return undefined
  void now
  return createHash('sha256').update(serialized).digest('hex')
}

/** 记录到一半发现响应失控（超长）就放弃整条记录。 */
export function worthRecording(chunks: readonly Uint8Array[]): boolean {
  let size = 0
  for (const chunk of chunks) size += chunk.byteLength
  return size <= MAX_CACHED_RESPONSE_CHARS
}
