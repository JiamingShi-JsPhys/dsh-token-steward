/**
 * client 侧的两块纯逻辑：HTTP 客户端与状态仓库。
 *
 * 组件不便于在无 React 的环境里测，但「乱序响应被丢弃」「面板关掉就不轮询」
 * 「模式切换失败要回滚」这些行为恰恰是界面里最难肉眼发现的部分，因此在这里钉死。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PANEL_API_BASE, createPanelClient, type FetchLike } from '../src/client/api.ts'
import { CLOSED_POLL_MS, OPEN_POLL_MS, createPanelStore } from '../src/client/store.ts'
import type { MatrixSnapshot } from '../src/core/types.ts'

function snapshot(overrides: Partial<MatrixSnapshot> = {}): MatrixSnapshot {
  return {
    revision: overrides.revision ?? 1,
    mode: overrides.mode ?? 'frugal',
    updatedAt: overrides.updatedAt ?? 1_000,
    usageAvailable: overrides.usageAvailable ?? true,
    models: overrides.models ?? [],
    agents: overrides.agents ?? [],
    recent: overrides.recent ?? [],
    totals: overrides.totals ?? {
      todayTokens: 0, todayCost: null, cacheHitRate: null, degradedRequests: 0, unpricedModels: 0,
    },
    savings: overrides.savings ?? { tokens: 0, cost: null, cacheHits: 0, cacheBackend: 'off' },
    pool: overrides.pool ?? { status: 'ok', source: 'model_pool.yaml' },
  }
}

/** 一个可编程的假 fetch。 */
function fakeFetch(handler: (path: string, init?: Record<string, unknown>) => { status?: number, body: unknown }): { impl: FetchLike, calls: Array<{ path: string, init?: Record<string, unknown> }> } {
  const calls: Array<{ path: string, init?: Record<string, unknown> }> = []
  return {
    calls,
    impl: async (path, init) => {
      calls.push({ path, ...(init === undefined ? {} : { init }) })
      const result = handler(path, init)
      return new Response(JSON.stringify(result.body), {
        status: result.status ?? 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  }
}

/* ────────────────────────── HTTP 客户端 ────────────────────────── */

test('客户端只用同源相对路径', async () => {
  const fake = fakeFetch(() => ({ body: { ok: true, snapshot: snapshot() } }))
  await createPanelClient(fake.impl).snapshot()
  assert.equal(fake.calls[0]?.path, PANEL_API_BASE + '/snapshot')
  assert.equal(fake.calls[0]?.path.startsWith('/'), false, '绝对路径会跑出 GUI 的前缀')
})

test('snapshot 解出快照本体', async () => {
  const fake = fakeFetch(() => ({ body: { ok: true, snapshot: snapshot({ revision: 7 }) } }))
  assert.equal((await createPanelClient(fake.impl).snapshot()).revision, 7)
})

test('非 2xx 时抛出带状态码的错误', async () => {
  const fake = fakeFetch(() => ({ status: 403, body: { ok: false } }))
  await assert.rejects(() => createPanelClient(fake.impl).snapshot(), /403/)
})

test('setMode 用 POST 并带上模式', async () => {
  const fake = fakeFetch(() => ({ body: { ok: true, mode: 'max_power' } }))
  assert.equal(await createPanelClient(fake.impl).setMode('max_power'), true)
  assert.equal(fake.calls[0]?.init?.method, 'POST')
  assert.equal(fake.calls[0]?.init?.body, JSON.stringify({ mode: 'max_power' }))
})

test('reload 用 POST 并回报结果', async () => {
  const fake = fakeFetch(() => ({ body: { ok: false, status: 'rejected', error: 'bad yaml' } }))
  const result = await createPanelClient(fake.impl).reload()
  assert.equal(result.ok, false)
  assert.equal(result.error, 'bad yaml')
})

/* ────────────────────────── 状态仓库 ────────────────────────── */

/** 一个可编程的客户端替身。 */
function fakeClient(): {
  client: Parameters<typeof createPanelStore>[0]
  calls: { snapshot: number, setMode: string[], reload: number }
  next: { snapshot?: () => Promise<MatrixSnapshot>, setMode?: () => Promise<boolean>, reload?: () => Promise<{ ok: boolean, status: string, error?: string }> }
} {
  const calls = { snapshot: 0, setMode: [] as string[], reload: 0 }
  const next: {
    snapshot?: () => Promise<MatrixSnapshot>
    setMode?: () => Promise<boolean>
    reload?: () => Promise<{ ok: boolean, status: string, error?: string }>
  } = {}
  return {
    calls,
    next,
    client: {
      async snapshot() {
        calls.snapshot += 1
        return next.snapshot === undefined ? snapshot() : await next.snapshot()
      },
      async setMode(mode) {
        calls.setMode.push(mode)
        return next.setMode === undefined ? true : await next.setMode()
      },
      async reload() {
        calls.reload += 1
        return next.reload === undefined ? { ok: true, status: 'ok' } : await next.reload()
      },
      async gateway() {
        return undefined
      },
      async vendors() {
        return { mode: 'frugal' as const, vendors: [], catalog: [] }
      },
      async saveVendors() {
        return { ok: true }
      },
      async discoverModels() {
        return { data: [] }
      },
      async importHarness() {
        return { ok: true, imported: [] }
      },
      async syncHarness() {
        return { ok: true }
      },
      async deleteVendor() {
        return { ok: true }
      },
    },
  }
}

test('仓库初始没有快照也没有错误', () => {
  const store = createPanelStore(fakeClient().client)
  assert.equal(store.getState().snapshot, undefined)
  assert.equal(store.getState().error, undefined)
  assert.equal(store.getState().open, false)
})

test('refresh 成功后写入快照并清掉错误', async () => {
  const fake = fakeClient()
  const store = createPanelStore(fake.client)
  fake.next.snapshot = () => Promise.reject(new Error('boom'))
  await store.refresh()
  assert.ok((store.getState().error ?? '').includes('boom'))

  fake.next.snapshot = async () => snapshot({ revision: 2 })
  await store.refresh()
  assert.equal(store.getState().snapshot?.revision, 2)
  assert.equal(store.getState().error, undefined)
})

test('refresh 失败时保留上一份快照', async () => {
  const fake = fakeClient()
  const store = createPanelStore(fake.client)
  fake.next.snapshot = async () => snapshot({ revision: 5 })
  await store.refresh()
  fake.next.snapshot = () => Promise.reject(new Error('network'))
  await store.refresh()
  assert.equal(store.getState().snapshot?.revision, 5)
  assert.ok((store.getState().error ?? '').includes('network'))
})

test('迟到的旧 revision 响应被丢弃，界面不倒退', async () => {
  const fake = fakeClient()
  const store = createPanelStore(fake.client)

  // 先让一个慢请求挂着
  let releaseSlow: (value: MatrixSnapshot) => void = () => {}
  fake.next.snapshot = () => new Promise((resolve) => { releaseSlow = resolve })
  const slow = store.refresh()

  // 再发一个快请求并先完成
  fake.next.snapshot = async () => snapshot({ revision: 9 })
  await store.refresh()
  assert.equal(store.getState().snapshot?.revision, 9)

  // 慢请求现在才回来，带着更旧的 revision
  releaseSlow(snapshot({ revision: 3 }))
  await slow
  assert.equal(store.getState().snapshot?.revision, 9, '旧响应必须被丢弃')
})

test('setMode 先乐观更新，成功后用服务端快照覆盖', async () => {
  const fake = fakeClient()
  const store = createPanelStore(fake.client)
  fake.next.snapshot = async () => snapshot({ revision: 1, mode: 'frugal' })
  await store.refresh()

  fake.next.setMode = async () => true
  fake.next.snapshot = async () => snapshot({ revision: 2, mode: 'max_power' })
  await store.setMode('max_power')

  assert.deepEqual(fake.calls.setMode, ['max_power'])
  assert.equal(store.getState().snapshot?.mode, 'max_power')
  assert.equal(store.getState().snapshot?.revision, 2)
})

test('setMode 被拒绝时回滚并报错', async () => {
  const fake = fakeClient()
  const store = createPanelStore(fake.client)
  fake.next.snapshot = async () => snapshot({ revision: 1, mode: 'frugal' })
  await store.refresh()

  fake.next.setMode = async () => false
  await store.setMode('balanced')

  assert.equal(store.getState().snapshot?.mode, 'frugal', '被拒绝时必须回滚')
  assert.ok((store.getState().error ?? '').includes('拒绝'))
})

test('setMode 抛错时也回滚', async () => {
  const fake = fakeClient()
  const store = createPanelStore(fake.client)
  fake.next.snapshot = async () => snapshot({ revision: 1, mode: 'frugal' })
  await store.refresh()

  fake.next.setMode = () => Promise.reject(new Error('offline'))
  await store.setMode('max_power')
  assert.equal(store.getState().snapshot?.mode, 'frugal')
  assert.ok((store.getState().error ?? '').includes('offline'))
})

test('reload 失败时把错误显示出来', async () => {
  const fake = fakeClient()
  const store = createPanelStore(fake.client)
  fake.next.reload = async () => ({ ok: false, status: 'rejected', error: 'providers: expected a list' })
  await store.reload()
  assert.ok((store.getState().error ?? '').includes('providers: expected a list'))
})

test('轮询节奏：面板关闭时为 0，展开时为 5 秒', () => {
  assert.equal(CLOSED_POLL_MS, 0)
  assert.equal(OPEN_POLL_MS, 5_000)
})

test('setOpen 展开时立刻刷一次', async () => {
  const fake = fakeClient()
  const store = createPanelStore(fake.client)
  const before = fake.calls.snapshot
  store.setOpen(true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(fake.calls.snapshot > before, '展开面板应当立刻拉一次数据')
  store.stop()
})

test('setOpen 关闭时不刷新', async () => {
  const fake = fakeClient()
  const store = createPanelStore(fake.client)
  store.setOpen(true)
  await new Promise((resolve) => setImmediate(resolve))
  const afterOpen = fake.calls.snapshot
  store.setOpen(false)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fake.calls.snapshot, afterOpen, '收起面板不该再发请求')
  store.stop()
})

test('订阅者在状态变化时被通知，取消订阅后不再收到', async () => {
  const fake = fakeClient()
  const store = createPanelStore(fake.client)
  let count = 0
  const unsubscribe = store.subscribe(() => { count += 1 })
  await store.refresh()
  assert.ok(count > 0)
  const before = count
  unsubscribe()
  await store.refresh()
  assert.equal(count, before)
})

test('stop 之后不再轮询', async () => {
  const fake = fakeClient()
  const store = createPanelStore(fake.client)
  store.setOpen(true)
  await new Promise((resolve) => setImmediate(resolve))
  store.stop()
  const after = fake.calls.snapshot
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(fake.calls.snapshot, after)
})
test('客户端 gateway 端点透传接线参数', async () => {
  const fake = fakeFetch(() => ({ body: { ok: true, gateway: { baseUrl: 'http://127.0.0.1:1/v1', token: 't', modelIds: [], port: 1 } } }))
  const info = await createPanelClient(fake.impl).gateway()
  assert.equal(info?.token, 't')
})

test('网关未启动时 gateway() 返回 undefined 而不是抛错', async () => {
  const fake = fakeFetch(() => ({ status: 503, body: { ok: false } }))
  assert.equal(await createPanelClient(fake.impl).gateway(), undefined)
})

test('刷新拿到快照后会顺手取一次网关参数', async () => {
  const fake = fakeClient()
  const store = createPanelStore({
    ...fake.client,
    async gateway() {
      return { baseUrl: 'http://127.0.0.1:9/v1', token: 'tok', modelIds: [], port: 9 }
    },
  })
  await store.refresh()
  assert.equal(store.getState().gateway?.token, 'tok')
})
