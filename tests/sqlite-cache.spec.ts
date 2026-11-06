/**
 * 本地响应缓存：SQLite 持久化、TTL、今日节省与内存降级。
 *
 * 这些断言回答的是「重启之后还省不省」：读写往返、过期清空、跨进程保留、
 * 以及老宿主没有 node:sqlite 时的内存降级。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryCache, createResponseCache, localDayKey, type CachedResponse } from '../src/host/sqlite-cache.ts'

const POLICY = { exact_match: true, max_entries: 4, ttl_ms: 60_000 }

function entry(overrides: Partial<CachedResponse> = {}): CachedResponse {
  return {
    body: new TextEncoder().encode('{"ok":true}'),
    contentType: 'application/json',
    provider: 'p',
    model: 'm',
    inputTokens: 100,
    outputTokens: 20,
    savedCost: { currency: 'USD', amount: 0.5 },
    ...overrides,
  }
}

async function withDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'steward-cache-'))
  try {
    return await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('SQLite：写入后原样读回，字节与元数据都一致', async () => {
  await withDirectory(async (directory) => {
    const cache = await createResponseCache({ directory, policy: POLICY })
    try {
      await cache.put('k1', entry(), 1_000)
      const hit = await cache.get('k1', 2_000)
      assert.ok(hit !== undefined)
      assert.equal(new TextDecoder().decode(hit.body), '{"ok":true}')
      assert.equal(hit.provider, 'p')
      assert.equal(hit.model, 'm')
      assert.equal(hit.inputTokens, 100)
      assert.deepEqual(hit.savedCost, { currency: 'USD', amount: 0.5 })
    } finally {
      await cache.close()
    }
  })
})

test('SQLite：TTL 过期后按未命中处理，并清掉条目', async () => {
  await withDirectory(async (directory) => {
    const cache = await createResponseCache({ directory, policy: POLICY })
    try {
      await cache.put('k1', entry(), 1_000)
      assert.equal(await cache.get('k1', 1_000 + POLICY.ttl_ms), undefined)
      const stats = await cache.stats(2_000)
      assert.equal(stats.size, 0)
    } finally {
      await cache.close()
    }
  })
})

test('SQLite：命中累计今日节省（token + 金额 + 次数）', async () => {
  await withDirectory(async (directory) => {
    const cache = await createResponseCache({ directory, policy: POLICY })
    try {
      const now = Date.UTC(2026, 10, 6, 12, 0, 0)
      await cache.put('k1', entry(), now)
      await cache.get('k1', now + 1_000)
      await cache.get('k1', now + 2_000)
      const stats = await cache.stats(now + 3_000)
      assert.equal(stats.cacheHitsToday, 2)
      assert.equal(stats.savedTokens, 240, '每次 120 token，两次 240')
      assert.deepEqual(stats.savedCost, { currency: 'USD', amount: 1 })
      assert.equal(stats.backend, 'sqlite')
      assert.match(localDayKey(now), /^\d{4}-\d{2}-\d{2}$/)
    } finally {
      await cache.close()
    }
  })
})

test('SQLite：关闭重开后条目仍在（重启不丢）', async () => {
  await withDirectory(async (directory) => {
    const first = await createResponseCache({ directory, policy: POLICY })
    const backend = first.backend()
    // 用真实时钟写入：构造函数会清掉「早于 TTL」的条目，固定历史时间会被误删。
    const now = Date.now()
    await first.put('persisted', entry(), now)
    await first.close()
    if (backend !== 'sqlite') return

    const second = await createResponseCache({ directory, policy: POLICY })
    try {
      const hit = await second.get('persisted', now + 1_000)
      assert.ok(hit !== undefined, 'SQLite 后端必须跨进程保留')
    } finally {
      await second.close()
    }
  })
})

test('SQLite：容量上限触发逐出，最旧的最先走', async () => {
  await withDirectory(async (directory) => {
    const cache = await createResponseCache({ directory, policy: { ...POLICY, max_entries: 2 } })
    try {
      await cache.put('a', entry(), 1_000)
      await cache.put('b', entry(), 2_000)
      await cache.put('c', entry(), 3_000)
      const stats = await cache.stats(3_000)
      assert.equal(stats.size, 2)
      assert.equal(await cache.get('a', 3_100), undefined, '最旧的 a 被逐出')
      assert.ok(await cache.get('c', 3_100) !== undefined)
    } finally {
      await cache.close()
    }
  })
})

test('内存降级：没有 SQLite 时行为一致（读写 / 统计 / 过期）', async () => {
  const cache = createMemoryCache(POLICY)
  const now = Date.UTC(2026, 10, 6, 12, 0, 0)
  await cache.put('k', entry(), now)
  const hit = await cache.get('k', now + 1_000)
  assert.ok(hit !== undefined)
  const stats = await cache.stats(now + 1_000)
  assert.equal(stats.backend, 'memory')
  assert.equal(stats.cacheHitsToday, 1)
  assert.equal(stats.savedTokens, 120)
  assert.equal(await cache.get('k', now + POLICY.ttl_ms + 1), undefined)
  await cache.close()
})

test('localDayKey 用本地日，不是 UTC 日', () => {
  const local = new Date(2026, 10, 6, 23, 30, 0).getTime()
  assert.equal(localDayKey(local), '2026-11-06')
})
