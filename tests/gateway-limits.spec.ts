/**
 * 网关的两道限速（DeepSec L3「missing_rate_limiting」对应项）。
 *
 *  - 失败认证：每个回环地址 20 次/分钟后 429。令牌是 256 bit 猜不出来，
 *    这层挡的是「拿错钥匙的进程每秒重试几千次」——日志噪音与无谓 CPU。
 *  - 模型发现：全局 60 次/分钟。每次探测都带着密钥出站，不设上限等于
 *    给拿到令牌的一方一个出站代理。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startGateway } from '../src/host/gateway.ts'
import { createRouter } from '../src/core/router.ts'
import { synthesizePool } from '../src/core/vendors.ts'
import type { PoolConfig, VendorConfig } from '../src/core/types.ts'
import type { FetchLike } from '../src/host/upstream.ts'

const CACHE = { exact_match: false, max_entries: 10, ttl_ms: 1_000 }

function vendor(overrides: Partial<VendorConfig> = {}): VendorConfig {
  return {
    vendorId: 'deepseek',
    vendorName: 'DeepSeek',
    officialUrl: 'https://api.deepseek.com/v1',
    customUrl: '',
    endpointSource: 'official',
    apiKey: 'sk-test-1234',
    enabledModels: ['deepseek-v4-1-flash-1017'],
    ...overrides,
  }
}

const pool: PoolConfig = synthesizePool([vendor()], 'frugal', CACHE)

/** 一个只回模型清单的假上游。 */
const fetchImpl: FetchLike = async () => new Response(
  JSON.stringify({ data: [{ id: 'deepseek-v4-1-flash-1017' }] }),
  { status: 200, headers: { 'content-type': 'application/json' } },
)

test('失败认证：20 次之后 429，期间正确令牌也被挡住', async () => {
  const gateway = await startGateway({
    config: () => pool,
    router: () => createRouter(pool),
    vendors: () => [vendor()],
    secrets: () => new Map([['deepseek', 'sk-test-1234']]),
  })
  try {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await fetch(gateway.baseUrl() + '/models', {
        headers: { authorization: 'Bearer wrong-' + String(attempt) },
      })
      assert.equal(response.status, 401, '第 ' + String(attempt + 1) + ' 次仍应是 401')
    }
    const throttled = await fetch(gateway.baseUrl() + '/models', {
      headers: { authorization: 'Bearer wrong-again' },
    })
    assert.equal(throttled.status, 429)
    assert.equal(throttled.headers.get('retry-after'), '60')
    // 限速只针对**失败**认证：拿对钥匙的客户端不该被一起锁死，
    // 成功一次就把计数清零（下一项测试钉住这一点）。
    const good = await fetch(gateway.baseUrl() + '/models', {
      headers: { authorization: 'Bearer ' + gateway.token() },
    })
    assert.equal(good.status, 200)
  } finally {
    await gateway.close()
  }
})

test('认证成功后失败计数清零', async () => {
  const gateway = await startGateway({
    config: () => pool,
    router: () => createRouter(pool),
    vendors: () => [vendor()],
    secrets: () => new Map([['deepseek', 'sk-test-1234']]),
  })
  try {
    for (let attempt = 0; attempt < 19; attempt += 1) {
      await fetch(gateway.baseUrl() + '/models', { headers: { authorization: 'Bearer nope' } })
    }
    const ok = await fetch(gateway.baseUrl() + '/models', {
      headers: { authorization: 'Bearer ' + gateway.token() },
    })
    assert.equal(ok.status, 200)
    // 清零之后再错 19 次也不该被限速。
    for (let attempt = 0; attempt < 19; attempt += 1) {
      const response = await fetch(gateway.baseUrl() + '/models', { headers: { authorization: 'Bearer nope' } })
      assert.equal(response.status, 401)
    }
  } finally {
    await gateway.close()
  }
})

test('模型发现：每分钟 60 次上限', async () => {
  const gateway = await startGateway({
    config: () => pool,
    router: () => createRouter(pool),
    vendors: () => [vendor()],
    secrets: () => new Map([['deepseek', 'sk-test-1234']]),
    fetchImpl,
    now: () => 1_000,
  })
  try {
    const call = () => fetch(gateway.baseUrl() + '/models?vendor=deepseek', {
      headers: { authorization: 'Bearer ' + gateway.token() },
    })
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const response = await call()
      assert.equal(response.status, 200, '第 ' + String(attempt + 1) + ' 次应放行')
    }
    const blocked = await call()
    assert.equal(blocked.status, 429)
  } finally {
    await gateway.close()
  }
})
