/**
 * 本地精确响应缓存：键派生、LRU/TTL 语义、护栏。
 *
 * 缓存错的代价是「同一个 prompt 拿到别人的答案」，因此这里的断言围着
 * 「什么绝对不能进缓存」转：带 tools 的、过大的、空消息的。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LruTtlCache, cacheKeyOf, worthRecording, MAX_CACHED_PROMPT_CHARS } from '../src/core/response-cache.ts'

function chatBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'steward:auto',
    messages: [{ role: 'user', content: 'classify this sentence' }],
    ...overrides,
  }
}

test('相同 prompt 派生出相同键；采样参数参与键', () => {
  const a = cacheKeyOf(chatBody(), 'steward:auto', 'frugal')
  const b = cacheKeyOf(chatBody(), 'steward:auto', 'frugal')
  assert.equal(a, b)
  assert.ok(a !== undefined && a.length === 64)

  const hotter = cacheKeyOf(chatBody({ temperature: 0.9 }), 'steward:auto', 'frugal')
  assert.notEqual(a, hotter, 'temperature 变了就是不同的请求')

  const more = cacheKeyOf(chatBody({ messages: [{ role: 'user', content: 'different' }] }), 'steward:auto', 'frugal')
  assert.notEqual(a, more)
})

test('键隔离：换模式、换虚拟 id、换流式形状互不串答案', () => {
  const auto = cacheKeyOf(chatBody(), 'steward:auto', 'frugal')
  const autoMax = cacheKeyOf(chatBody(), 'steward:auto', 'max_power')
  const pinned = cacheKeyOf(chatBody(), 'steward:pin/cheap/cheap-1', 'frugal')
  const streaming = cacheKeyOf(chatBody({ stream: true }), 'steward:auto', 'frugal')

  assert.notEqual(auto, autoMax, '同一 prompt 在不同模式下不是同一个答案')
  assert.notEqual(auto, pinned)
  assert.notEqual(auto, streaming)
})

test('带 tools 的请求绝不缓存（工具调用有副作用）', () => {
  assert.equal(cacheKeyOf(chatBody({ tools: [{ type: 'function', function: { name: 'run' } }] }), 'steward:auto', 'frugal'), undefined)
})

test('不可缓存形态：空消息、超长 prompt、不可序列化', () => {
  assert.equal(cacheKeyOf(chatBody({ messages: [] }), 'steward:auto', 'frugal'), undefined)
  assert.equal(cacheKeyOf(chatBody({ messages: [{ role: 'user', content: 'x'.repeat(MAX_CACHED_PROMPT_CHARS + 1) }] }), 'steward:auto', 'frugal'), undefined)
  const circular: Record<string, unknown> = {}
  circular.self = circular
  assert.equal(cacheKeyOf(chatBody({ messages: [circular] }), 'steward:auto', 'frugal'), undefined)
})

test('LRU：容量逐出最旧条目；TTL 过期即失效并清位', () => {
  const cache = new LruTtlCache<string>({ maxEntries: 2, ttlMs: 1_000 })
  cache.put('a', 'A', 0)
  cache.put('b', 'B', 1)
  assert.equal(cache.get('a', 2), 'A', '触碰 a，让 b 变成 LRU')
  cache.put('c', 'C', 3)
  assert.equal(cache.get('b', 4), undefined, 'b 被逐出')
  assert.equal(cache.get('a', 4), 'A')
  assert.equal(cache.stats().evictions, 1)

  assert.equal(cache.get('a', 1_500), undefined, 'TTL 过期（惰性清除：访问时淘汰）')
  assert.equal(cache.get('c', 1_600), undefined, 'c 同样过期')
  assert.equal(cache.size, 0)
})

test('命中/未命中计数如实', () => {
  const cache = new LruTtlCache<string>()
  cache.put('k', 'v', 0)
  void cache.get('k', 1)
  void cache.get('nope', 2)
  const stats = cache.stats()
  assert.equal(stats.hits, 1)
  assert.equal(stats.misses, 1)
  assert.equal(stats.size, 1)
})

test('worthRecording：响应失控（超长）时放弃记录', () => {
  assert.equal(worthRecording([new TextEncoder().encode('ok')]), true)
  assert.equal(worthRecording([new Uint8Array(MAX_CACHED_PROMPT_CHARS + 1)]), false)
})
