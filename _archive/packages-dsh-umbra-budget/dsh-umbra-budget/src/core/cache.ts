/**
 * Generic LRU + TTL cache — the storage behind `routing.cache.exact_match`
 * (local exact-response cache for trivial calls). Pure and fully testable.
 *
 * @module core/cache
 */
export interface CacheStatsView {
  readonly hits: number
  readonly misses: number
  readonly size: number
  readonly evictions: number
}

interface Slot<V> {
  value: V
  createdAt: number
  lastUsedAt: number
}

export class LruTtlCache<V> {
  private readonly maxEntries: number
  private readonly ttlMs: number
  private readonly slots = new Map<string, Slot<V>>()
  private hits = 0
  private misses = 0
  private evictions = 0

  constructor(options: { maxEntries?: number; ttlMs?: number } = {}) {
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 500))
    this.ttlMs = Math.max(1_000, Math.floor(options.ttlMs ?? 3_600_000))
  }

  /** TTL-checked, LRU-touching read. */
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
    slot.lastUsedAt = now
    // refresh LRU position
    this.slots.delete(key)
    this.slots.set(key, slot)
    this.hits += 1
    return slot.value
  }

  put(key: string, value: V, now: number): void {
    if (this.slots.has(key)) this.slots.delete(key)
    while (this.slots.size >= this.maxEntries) {
      const oldest = this.slots.keys().next()
      if (oldest.done === true) break
      this.slots.delete(oldest.value)
      this.evictions += 1
    }
    this.slots.set(key, { value, createdAt: now, lastUsedAt: now })
  }

  get size(): number {
    return this.slots.size
  }

  stats(): CacheStatsView {
    return { hits: this.hits, misses: this.misses, size: this.slots.size, evictions: this.evictions }
  }
}
