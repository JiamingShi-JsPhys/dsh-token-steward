/**
 * Local exact-response cache (`routing.cache.exact_match`, default OFF).
 *
 * Serves byte-identical repeats of trivial calls without leaving the process:
 * key = SHA-256 over the prompt-defining fields (system + messages + sampling
 * controls), value = the chunk sequence the consumer received. The ledger is
 * NOT charged on hits (nothing was billed); the route journal shows
 * 「精确缓存命中」 so the monitor stays honest.
 *
 * Host-only module (node:crypto); the router sees it through the facade below.
 *
 * @module host/response-cache
 */
import { createHash } from 'node:crypto'
import { LruTtlCache } from '../core/cache.ts'
import type { GenerateOptionsLike, StreamChunkLike } from './dsh-face.ts'

/** serialized prompt above this size is not worth caching */
const MAX_CACHED_PROMPT_CHARS = 64_000
/** accumulated chunk text above this size aborts recording (memory guard) */
const MAX_CACHED_RESPONSE_CHARS = 64_000

export interface CachedResponse {
  readonly chunks: readonly StreamChunkLike[]
  readonly modelId: string
}

export interface ResponseCacheFacade {
  lookup(key: string): CachedResponse | undefined
  remember(key: string, chunks: readonly StreamChunkLike[], modelId: string): void
  stats(): { hits: number; misses: number; size: number; evictions: number }
}

export class ResponseCache implements ResponseCacheFacade {
  private readonly cache: LruTtlCache<CachedResponse>

  constructor(maxEntries = 500, ttlMs = 3_600_000) {
    this.cache = new LruTtlCache<CachedResponse>({ maxEntries, ttlMs })
  }

  lookup(key: string): CachedResponse | undefined {
    return this.cache.get(key, Date.now())
  }

  remember(key: string, chunks: readonly StreamChunkLike[], modelId: string): void {
    this.cache.put(key, { chunks, modelId }, Date.now())
  }

  stats(): { hits: number; misses: number; size: number; evictions: number } {
    return this.cache.stats()
  }
}

/**
 * Cache key over the prompt-defining fields. Returns undefined when the call
 * is not safely cacheable (no messages, oversized, non-serializable payloads).
 */
export function cacheKeyOf(options: GenerateOptionsLike): string | undefined {
  if (!Array.isArray(options.messages) || options.messages.length === 0) return undefined
  const fingerprint = {
    system: options.system,
    messages: options.messages,
    reasoningEffort: options.reasoningEffort,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
  }
  let serialized: string
  try {
    serialized = JSON.stringify(fingerprint)
  } catch {
    return undefined
  }
  if (serialized === undefined || serialized.length > MAX_CACHED_PROMPT_CHARS) return undefined
  return createHash('sha256').update(serialized).digest('hex')
}

/** Whether recording should continue (memory guard for runaway responses). */
export function worthRecording(chunks: readonly StreamChunkLike[]): boolean {
  let size = 0
  for (const chunk of chunks) {
    if (chunk !== null && typeof chunk === 'object' && chunk.type === 'text-delta') {
      size += (chunk as { text?: string }).text?.length ?? 0
    }
    if (size > MAX_CACHED_RESPONSE_CHARS) return false
  }
  return true
}
