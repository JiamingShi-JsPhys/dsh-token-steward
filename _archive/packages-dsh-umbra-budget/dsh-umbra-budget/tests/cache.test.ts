/**
 * Exact-response cache tests: LRU/TTL semantics, key derivation, recording guard.
 * @module tests/cache.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { LruTtlCache } from '../src/core/cache.ts'
import { cacheKeyOf, worthRecording } from '../src/host/response-cache.ts'
import type { GenerateOptionsLike, StreamChunkLike } from '../src/host/dsh-face.ts'

test('LRU: newest entries survive, oldest are evicted at capacity', () => {
  const cache = new LruTtlCache<string>({ maxEntries: 2, ttlMs: 60_000 })
  cache.put('a', 'A', 0)
  cache.put('b', 'B', 1)
  cache.get('a', 2) // touch a → b becomes LRU
  cache.put('c', 'C', 3)
  assert.equal(cache.get('a', 4), 'A')
  assert.equal(cache.get('b', 4), undefined, 'b was evicted')
  assert.equal(cache.get('c', 4), 'C')
  assert.equal(cache.stats().evictions, 1)
})

test('TTL: expired entries miss and are dropped', () => {
  const cache = new LruTtlCache<string>({ maxEntries: 10, ttlMs: 1_000 })
  cache.put('k', 'v', 0)
  assert.equal(cache.get('k', 500), 'v')
  assert.equal(cache.get('k', 1_500), undefined, 'expired')
  assert.equal(cache.size, 0)
  assert.equal(cache.stats().misses, 1)
})

test('hit/miss counters track reads', () => {
  const cache = new LruTtlCache<string>()
  cache.put('k', 'v', 0)
  void cache.get('k', 1)
  void cache.get('nope', 2)
  const stats = cache.stats()
  assert.equal(stats.hits, 1)
  assert.equal(stats.misses, 1)
})

test('cacheKeyOf: stable for identical prompts, sensitive to sampling controls', () => {
  const options: GenerateOptionsLike = {
    system: 'be terse',
    messages: [{ role: 'user', content: 'classify this' }],
    temperature: 0.2,
  }
  const again: GenerateOptionsLike = JSON.parse(JSON.stringify(options)) as GenerateOptionsLike
  assert.equal(cacheKeyOf(options), cacheKeyOf(again))

  const hotter = { ...options, temperature: 0.9 }
  assert.notEqual(cacheKeyOf(options), cacheKeyOf(hotter))

  const extra = { ...options, messages: [{ role: 'user', content: 'classify this' }, { role: 'user', content: 'and this' }] }
  assert.notEqual(cacheKeyOf(options), cacheKeyOf(extra))
})

test('cacheKeyOf: refuses non-cacheable prompts', () => {
  assert.equal(cacheKeyOf({ messages: [] }), undefined, 'no messages')
  assert.equal(cacheKeyOf({}), undefined)
  const circular: Record<string, unknown> = {}
  circular.self = circular
  assert.equal(cacheKeyOf({ messages: [circular] }), undefined, 'non-serializable')
  assert.equal(cacheKeyOf({ messages: [{ role: 'user', content: 'x'.repeat(70_000) }] }), undefined, 'oversized')
})

test('worthRecording: aborts on runaway responses', () => {
  const small: StreamChunkLike[] = [{ type: 'text-delta', text: 'ok' }]
  assert.equal(worthRecording(small), true)
  const huge: StreamChunkLike[] = [{ type: 'text-delta', text: 'x'.repeat(70_000) }]
  assert.equal(worthRecording(huge), false)
})
