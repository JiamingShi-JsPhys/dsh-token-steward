/**
 * 计量桥与面板路由。
 *
 * 两条断言最重要：
 *  - cost 为 0 不等于免费（dsh-usage 对非官方路由一律写 0，那是「不知道」）；
 *  - 会暴露令牌的端点只服务回环。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  emptyProjection,
  factOf,
  projectLedger,
  readUsageProjection,
  totalOf,
} from '../src/host/usage-bridge.ts'
import { API_PREFIX, isLoopbackRequest, makePanelRoutes, writeJson, type PanelApi } from '../src/host/routes.ts'
import { localDateKey } from '../src/core/ledger-doc.ts'

/* ────────────────────────── 计量桥 ────────────────────────── */

test('totalOf 把五个桶相加', () => {
  assert.equal(totalOf({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, reasoningTokens: 5 }), 15)
})

test('totalOf 对缺失/负数按 0 处理', () => {
  assert.equal(totalOf({ inputTokens: -5, outputTokens: 'x' }), 0)
})

test('cost 为 0 时是「未定价」而不是「免费」', () => {
  const fact = factOf({ inputTokens: 100, outputTokens: 10, cost: 0 })
  assert.equal(fact.todayCost, null, 'cost 0 必须是 null（未知），不能是 0 元')
})

test('cost 大于 0 时带上币种与金额', () => {
  const fact = factOf({ inputTokens: 100, cost: 1.25 })
  assert.deepEqual(fact.todayCost, { currency: 'CNY', amount: 1.25 })
})

test('缓存命中率 = cacheRead / (input + cacheRead)', () => {
  const fact = factOf({ inputTokens: 75, cacheReadTokens: 25 })
  assert.equal(fact.cacheHitRate, 0.25)
})

test('没有输入也没有缓存时命中率是 null（未知），不是 0', () => {
  assert.equal(factOf({ outputTokens: 10 }).cacheHitRate, null)
})

test('projectLedger 投影今天的每模型事实', () => {
  const projection = projectLedger({
    version: 1,
    days: {
      '2026-11-06': {
        'deepseek-official': { 'deepseek-flash': { inputTokens: 100, outputTokens: 20, cost: 2.5 } },
        agnes: { 'agnes-3.0-flash': { inputTokens: 50, outputTokens: 5, cost: 0 } },
      },
    },
  }, '2026-11-06')
  assert.equal(projection.available, true)
  assert.equal(projection.facts['deepseek-official/deepseek-flash']?.todayTokens, 120)
  assert.deepEqual(projection.facts['deepseek-official/deepseek-flash']?.todayCost, { currency: 'CNY', amount: 2.5 })
  assert.equal(projection.facts['agnes/agnes-3.0-flash']?.todayCost, null)
})

test('projectLedger 对「今天还没有用量」返回可用但空的事实', () => {
  const projection = projectLedger({ version: 1, days: {} }, '2026-11-06')
  assert.equal(projection.available, true)
  assert.deepEqual(projection.facts, {})
})

test('projectLedger 对坏结构返回不可用并带原因', () => {
  assert.equal(projectLedger([], '2026-11-06').available, false)
  assert.equal(projectLedger({}, '2026-11-06').available, false)
  assert.ok((projectLedger(null, '2026-11-06').error ?? '').length > 0)
})

test('projectLedger 跳过畸形行而不是整份失败', () => {
  const projection = projectLedger({
    days: { '2026-11-06': { p1: { m1: { inputTokens: 10 }, broken: 'x' }, junk: 5 } },
  }, '2026-11-06')
  assert.equal(Object.keys(projection.facts).length, 1)
  assert.equal(projection.facts['p1/m1']?.todayTokens, 10)
})

test('emptyProjection 明确标出不可用', () => {
  const projection = emptyProjection('2026-11-06')
  assert.equal(projection.available, false)
  assert.deepEqual(projection.facts, {})
})

test('readUsageProjection：文件不存在时不可用并说明可能是没装 dsh-usage', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'steward-usage-'))
  const projection = await readUsageProjection(dir, new Date(2026, 10, 6).getTime())
  assert.equal(projection.available, false)
  assert.ok((projection.error ?? '').includes('dsh-usage'))
  await rm(dir, { recursive: true, force: true })
})

test('readUsageProjection：真实台账被正确读成今天的事实', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'steward-usage-'))
  const now = new Date(2026, 10, 6, 12, 0, 0).getTime()
  const dateKey = localDateKey(now)
  await mkdir(join(dir, 'dsh-usage'), { recursive: true })
  await writeFile(join(dir, 'dsh-usage', 'usage-ledger.json'), JSON.stringify({
    version: 1,
    days: { [dateKey]: { 'p1': { 'm1': { inputTokens: 42, cost: 1 } } } },
  }))
  const projection = await readUsageProjection(dir, now)
  assert.equal(projection.available, true)
  assert.equal(projection.facts['p1/m1']?.todayTokens, 42)
  await rm(dir, { recursive: true, force: true })
})

test('readUsageProjection：损坏的 JSON 不可用但给出原因', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'steward-usage-'))
  await mkdir(join(dir, 'dsh-usage'), { recursive: true })
  await writeFile(join(dir, 'dsh-usage', 'usage-ledger.json'), 'not json')
  const projection = await readUsageProjection(dir, Date.now())
  assert.equal(projection.available, false)
  assert.ok((projection.error ?? '').includes('not valid JSON'))
  await rm(dir, { recursive: true, force: true })
})

/* ────────────────────────── 面板路由 ────────────────────────── */

/** 用一个真 HTTP 服务承载路由，这样测的是真实请求路径而不是函数调用。 */
async function withRoutes<T>(api: PanelApi, run: (base: string) => Promise<T>): Promise<T> {
  const routes = makePanelRoutes(api)
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const route = routes.find((entry) => entry.path === path)
    if (route === undefined) {
      writeJson(res, 404, { ok: false })
      return
    }
    void Promise.resolve(route.handler(req, res))
  })
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : 0)
    })
  })
  try {
    return await run('http://127.0.0.1:' + String(port))
  } finally {
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  }
}

function api(overrides: Partial<PanelApi> = {}): PanelApi {
  return {
    snapshot: () => ({ revision: 1, mode: 'frugal' }),
    setMode: () => true,
    reload: async () => ({ ok: true, status: 'ok' }),
    gateway: () => ({ baseUrl: 'http://127.0.0.1:1/v1', token: 'tok', modelIds: ['steward:auto'], port: 1 }),
    ...overrides,
  }
}

test('snapshot 返回 200 与快照', async () => {
  await withRoutes(api(), async (base) => {
    const response = await fetch(base + API_PREFIX + '/snapshot')
    assert.equal(response.status, 200)
    const body = await response.json() as { ok: boolean, snapshot: { revision: number } }
    assert.equal(body.ok, true)
    assert.equal(body.snapshot.revision, 1)
  })
})

test('mode 只接受三个合法值', async () => {
  await withRoutes(api(), async (base) => {
    const ok = await fetch(base + API_PREFIX + '/mode', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'max_power' }),
    })
    assert.equal(ok.status, 200)
    const bad = await fetch(base + API_PREFIX + '/mode', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'turbo' }),
    })
    assert.equal(bad.status, 400)
  })
})

test('mode 拒绝非 POST', async () => {
  await withRoutes(api(), async (base) => {
    const response = await fetch(base + API_PREFIX + '/mode')
    assert.equal(response.status, 405)
  })
})

test('mode 被拒绝时返回 409', async () => {
  await withRoutes(api({ setMode: () => false }), async (base) => {
    const response = await fetch(base + API_PREFIX + '/mode', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'frugal' }),
    })
    assert.equal(response.status, 409)
  })
})

test('mode 的非 JSON 体是 400', async () => {
  await withRoutes(api(), async (base) => {
    const response = await fetch(base + API_PREFIX + '/mode', { method: 'POST', body: 'x' })
    assert.equal(response.status, 400)
  })
})

test('reload 触发一次重读并回报结果', async () => {
  let called = 0
  await withRoutes(api({ reload: async () => { called += 1; return { ok: false, status: 'rejected', error: 'bad yaml' } } }), async (base) => {
    const response = await fetch(base + API_PREFIX + '/reload', { method: 'POST' })
    assert.equal(response.status, 200)
    const body = await response.json() as { ok: boolean, status: string, error: string }
    assert.equal(body.ok, false)
    assert.equal(body.status, 'rejected')
    assert.equal(body.error, 'bad yaml')
    assert.equal(called, 1)
  })
})

test('gateway 端点暴露接线参数', async () => {
  await withRoutes(api(), async (base) => {
    const response = await fetch(base + API_PREFIX + '/gateway')
    assert.equal(response.status, 200)
    const body = await response.json() as { gateway: { token: string } }
    assert.equal(body.gateway.token, 'tok')
  })
})

test('网关未启动时 gateway 端点答 503', async () => {
  await withRoutes(api({ gateway: () => undefined }), async (base) => {
    const response = await fetch(base + API_PREFIX + '/gateway')
    assert.equal(response.status, 503)
  })
})

test('isLoopbackRequest 认得出本机地址', () => {
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '127.0.0.1' } } as never), true)
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '::1' } } as never), true)
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '::ffff:127.0.0.1' } } as never), true)
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '192.168.1.9' } } as never), false)
  assert.equal(isLoopbackRequest({ socket: {} } as never), false)
})
