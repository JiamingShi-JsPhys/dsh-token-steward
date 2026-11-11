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
import { API_PREFIX, isLoopbackRequest, makePanelRoutes, writeJson, type PanelApi, type PanelRouteOptions } from '../src/host/routes.ts'
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
async function withRoutes<T>(api: PanelApi, run: (base: string) => Promise<T>, options: PanelRouteOptions = {}): Promise<T> {
  const routes = makePanelRoutes(api, options)
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

test('snapshot 把请求里的会话 Cookie 数量交给宿主（体检用）', async () => {
  let seen: { authCookies: number } | undefined
  await withRoutes(api({
    snapshot: (context) => {
      seen = context
      return { revision: 1 }
    },
  }), async (base) => {
    const cookie = ['theme=dark', 'dsh-auth-aaa=v1', 'dsh-auth-bbb=v1', 'dsh-auth-ccc=v1'].join('; ')
    const response = await fetch(base + API_PREFIX + '/snapshot', { headers: { cookie } })
    assert.equal(response.status, 200)
  })
  assert.deepEqual(seen, { authCookies: 3 }, '只数 dsh-auth-*，别的 Cookie 不算')
})

test('请求里没有 Cookie 头时不传体检信息', async () => {
  let seen: { authCookies: number } | null | undefined = null
  await withRoutes(api({
    snapshot: (context) => {
      seen = context
      return { revision: 1 }
    },
  }), async (base) => {
    await fetch(base + API_PREFIX + '/snapshot')
  })
  assert.equal(seen, undefined)
})

test('mode 四个合法值都认，免费档（free）不是例外', async () => {
  await withRoutes(api(), async (base) => {
    const ok = await fetch(base + API_PREFIX + '/mode', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'max_power' }),
    })
    assert.equal(ok.status, 200)
    const free = await fetch(base + API_PREFIX + '/mode', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'free' }),
    })
    assert.equal(free.status, 200)
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


test('avatar 端点同源提供内置头像，并拒绝路径穿越', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'steward-avatars-'))
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  await writeFile(join(directory, 'claude-opus-5-5.png'), png)
  try {
    await withRoutes(api(), async (base) => {
      const ok = await fetch(base + API_PREFIX + '/avatar?id=claude-opus-5-5')
      assert.equal(ok.status, 200)
      assert.equal(ok.headers.get('content-type'), 'image/png')
      assert.deepEqual(new Uint8Array(await ok.arrayBuffer()), png)

      const traversal = await fetch(base + API_PREFIX + '/avatar?id=' + encodeURIComponent('../secret'))
      assert.equal(traversal.status, 404)

      const missing = await fetch(base + API_PREFIX + '/avatar?id=none')
      assert.equal(missing.status, 404)
    }, { avatarDirectory: directory })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('discover 路由把请求交给 api.discover，而不是自己拿空 key 去打上游', async () => {
  // 只有 api.discover 知道「这家已保存的线路和密钥」。路由绕过它直接探测上游时，
  // 面板留空就会被当成无鉴权请求，用户看到的是一句莫名其妙的 401。
  const seen: Array<{ vendorId: string, baseUrl: string, apiKey: string }> = []
  await withRoutes(api({
    discover: async (vendorId, baseUrl, apiKey) => {
      seen.push({ vendorId, baseUrl, apiKey })
      return [{ id: 'm1', object: 'model', name: 'M1', tier: 'NA', inCatalog: false, owned_by: 'upstream' }]
    },
  }), async (base) => {
    const response = await fetch(base + API_PREFIX + '/discover', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vendorId: 'relay' }),
    })
    assert.equal(response.status, 200)
    const body = await response.json() as { ok: boolean, data: Array<{ id: string }> }
    assert.equal(body.ok, true)
    assert.equal(body.data[0]?.id, 'm1')
    // 留空照原样往下传：回落逻辑在 api.discover 里，路由不该自作主张。
    assert.deepEqual(seen, [{ vendorId: 'relay', baseUrl: '', apiKey: '' }])
  })
})


/* ────────────────────── 「只导入这一家」的两条约束 ────────────────────── */

test('import-harness 把面板给的范围原样转给宿主', async () => {
  const seen: Array<{ vendorId?: string, baseUrl?: string } | undefined> = []
  await withRoutes(api({
    importHarness: async (scope) => {
      seen.push(scope)
      return { ok: true, imported: ['westlake'] }
    },
  }), async (base) => {
    const response = await fetch(base + API_PREFIX + '/import-harness', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vendorId: 'custom', baseUrl: 'https://hpc-api.westlake.edu.cn/v1' }),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(seen, [{ vendorId: 'custom', baseUrl: 'https://hpc-api.westlake.edu.cn/v1' }])
  })
})

test('import-harness 不带 body 时不传范围（保留整份导入这条脚本通道）', async () => {
  const seen: Array<unknown> = []
  await withRoutes(api({
    importHarness: async (scope) => {
      seen.push(scope)
      return { ok: true, imported: [] }
    },
  }), async (base) => {
    const response = await fetch(base + API_PREFIX + '/import-harness', { method: 'POST' })
    assert.equal(response.status, 200)
    assert.deepEqual(seen, [undefined])
  })
})

test('保存厂家配置时 white-list 里漏掉 free，会把免费档悄悄改回 frugal', async () => {
  const seen: Array<{ mode: string }> = []
  await withRoutes(api({
    saveVendors: async (mode) => {
      seen.push({ mode })
      return { ok: true }
    },
  }), async (base) => {
    const response = await fetch(base + API_PREFIX + '/vendors', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'free', vendors: [] }),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(seen, [{ mode: 'free' }])
  })
})
