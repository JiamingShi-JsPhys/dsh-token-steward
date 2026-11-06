/**
 * 面板的状态仓库。
 *
 * 用 useSyncExternalStore 的形状（subscribe / getSnapshot），因此组件只读快照，
 * 不持有自己的状态副本。三条纪律：
 *  - revision 单调：乱序响应被丢弃，界面不会倒退；
 *  - 不可见时停轮询：面板关掉、页面切到后台，都不再发请求；
 *  - 错误是一等状态：失败不清空上一份快照，只挂一条错误行。
 */
import type { ImportScope, MatrixSnapshot, RoutingMode } from '../core/types.ts'
import type { CatalogVendor, DiscoveredModel, PanelClient, VendorView } from './api.ts'

/** 面板打开时的轮询间隔。 */
export const OPEN_POLL_MS = 5_000

/** 面板关闭时完全不轮询（球上只保留最后一次快照）。 */
export const CLOSED_POLL_MS = 0

/** 仓库状态。 */
export interface PanelState {
  /** 最近一次成功拿到的快照；从未成功时为 undefined。 */
  snapshot: MatrixSnapshot | undefined
  /** 最近一次错误的可读消息。 */
  error: string | undefined
  /** 是否正在请求。 */
  loading: boolean
  /** 面板是否展开。 */
  open: boolean
  /** 网关接线参数；未启动时 undefined。 */
  gateway: import('./api.ts').GatewayInfo | undefined
  /** 厂家配置（设置页用）；未拉取时 undefined。 */
  vendors: { mode: RoutingMode, vendors: VendorView[], catalog: CatalogVendor[] } | undefined
}

/** 仓库。 */
export interface PanelStore {
  subscribe(listener: () => void): () => void
  getState(): PanelState
  /** 拉一次快照；失败只记录错误。 */
  refresh(): Promise<void>
  /** 切换模式；先在本地乐观更新，失败回滚并报错。 */
  setMode(mode: RoutingMode): Promise<void>
  /** 重新读配置文件。 */
  reload(): Promise<void>
  /** 拉一次厂家配置（设置页打开时调用）。 */
  refreshVendors(): Promise<void>
  /** 重取网关接线参数（端口与令牌随网关重启变化）。 */
  refreshGateway(): Promise<void>
  /** 设置页的「刷新」：重读配置 + 网关参数 + 厂家列表。 */
  refreshAll(): Promise<void>
  /** 整表保存厂家配置；apiKey 空串 = 保留已存明文。 */
  saveVendors(mode: RoutingMode, vendors: unknown): Promise<void>
  /** 探测上游模型列表；失败抛错给调用方展示。 */
  discoverModels(params: { vendor?: string, baseUrl?: string, apiKey?: string }): Promise<DiscoveredModel[]>
  /** 从 DSH 现有 profile 抓取已配好的上游；成功后刷新厂家列表。
   *  带 scope 时只抓地址对上的那一家（面板上「我待在哪家就拉哪家」）。 */
  importHarness(scope?: ImportScope): Promise<{ ok: boolean, imported: string[], error?: string }>
  /** 反向同步：把这家厂家写回 DSH 的系统模型设置。 */
  syncHarness(vendorId: string): Promise<{ ok: boolean, file?: string, models?: number, error?: string }>
  /** 显式删除一家厂家，成功后刷新列表。 */
  deleteVendor(vendorId: string): Promise<{ ok: boolean, error?: string }>
  /** 展开 / 收起面板；展开时会立刻刷新一次。 */
  setOpen(open: boolean): void
  /** 页面可见性变化。 */
  setVisible(visible: boolean): void
  /** 开始 / 停止轮询。 */
  start(): void
  stop(): void
}

/** 建一个仓库。 */
export function createPanelStore(client: PanelClient): PanelStore {
  let state: PanelState = { snapshot: undefined, error: undefined, loading: false, open: false, gateway: undefined, vendors: undefined }
  const listeners = new Set<() => void>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let visible = true
  let disposed = false
  /** 请求序号：只有最新一次的响应会被采纳。 */
  let seq = 0

  function emit(): void {
    for (const listener of listeners) listener()
  }

  function set(patch: Partial<PanelState>): void {
    state = { ...state, ...patch }
    emit()
  }

  async function refresh(): Promise<void> {
    const mine = seq + 1
    seq = mine
    set({ loading: true })
    try {
      const snapshot = await client.snapshot()
      if (mine !== seq || disposed) return
      // revision 倒退说明这是更早请求的迟到响应：丢弃。
      if (state.snapshot !== undefined && snapshot.revision < state.snapshot.revision) {
        set({ loading: false })
        return
      }
      set({ snapshot, error: undefined, loading: false })
      // 网关参数只在配置可能变过时重取：它随网关重启而变化，不随每次轮询。
      if (state.gateway === undefined) {
        const gateway = await client.gateway()
        if (gateway !== undefined && mine === seq) set({ gateway })
      }
    } catch (error) {
      if (mine !== seq || disposed) return
      set({ error: messageOf(error), loading: false })
    }
  }

  async function setMode(mode: RoutingMode): Promise<void> {
    const previous = state.snapshot
    if (previous !== undefined) set({ snapshot: { ...previous, mode } })
    try {
      const accepted = await client.setMode(mode)
      if (!accepted) {
        if (previous !== undefined) set({ snapshot: previous })
        set({ error: '模式切换被拒绝' })
        return
      }
      await refresh()
    } catch (error) {
      if (previous !== undefined) set({ snapshot: previous })
      set({ error: messageOf(error) })
    }
  }

  async function reload(): Promise<void> {
    try {
      const result = await client.reload()
      const failure = result.ok ? undefined : '配置被拒绝：' + (result.error ?? result.status)
      set({ error: failure })
      // 重载成功/失败说的是「配置文件」，刷新说的是「连接」——后者成功不能擦掉前者。
      const carried = failure
      await refresh()
      if (carried !== undefined && state.error === undefined) set({ error: carried })
    } catch (error) {
      set({ error: messageOf(error) })
    }
  }

  function schedule(): void {
    if (timer !== undefined) clearTimeout(timer)
    // 面板没展开或页面不可见时完全停轮询：常驻的球只显示最后一次快照。
    const interval = state.open && visible ? OPEN_POLL_MS : CLOSED_POLL_MS
    if (interval === 0 || disposed) return
    timer = setTimeout(() => {
      timer = undefined
      void refresh().then(schedule, schedule)
    }, interval)
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref()
    }
  }

  function setOpen(open: boolean): void {
    if (state.open === open) return
    set({ open })
    if (open) void refresh().then(schedule, schedule)
    else schedule()
  }

  function setVisible(next: boolean): void {
    if (visible === next) return
    visible = next
    if (next && state.open) void refresh().then(schedule, schedule)
    schedule()
  }

  async function refreshVendors(): Promise<void> {
    try {
      const vendors = await client.vendors()
      set({ vendors })
    } catch (error) {
      set({ error: messageOf(error) })
    }
  }

  /**
   * 重取网关接线参数。
   *
   * 端口与本地令牌是网关每次启动重新生成的：DSH 重启过之后，面板上缓存的
   * 旧值就是错的，照着它去配 profile 只会得到 401。所以这件事必须能手动
   * 触发，而不是「第一次取到就一直用」。
   */
  async function refreshGateway(): Promise<void> {
    try {
      const gateway = await client.gateway()
      set({ gateway })
    } catch {
      // 网关没起是正常状态，显示「—」即可，不要把它当成错误横幅。
      set({ gateway: undefined })
    }
  }

  /** 设置页的「刷新」：配置、网关、厂家三样一起重取。 */
  async function refreshAll(): Promise<void> {
    await Promise.all([reload(), refreshGateway(), refreshVendors()])
  }

  /**
   * 保存 / 导入 / 删除之后同时重取厂家列表与快照。
   *
   * 只刷厂家列表是不够的：白嫖页与模型卡片读的是快照（路由引擎里真正入池的
   * 型号），悬浮面板没展开时快照根本不轮询——用户刚把价目改成 0、卡片上也挂了
   * 「白嫖可用」，切到白嫖页却一个都没有，就是一例。
   */
  async function refreshAfterMutation(): Promise<void> {
    await Promise.all([refreshVendors(), refresh()])
  }

  async function importHarness(scope?: ImportScope): Promise<{ ok: boolean, imported: string[], error?: string }> {
    const result = await client.importHarness(scope)
    if (result.ok) await refreshAfterMutation()
    return result
  }

  async function deleteVendor(vendorId: string): Promise<{ ok: boolean, error?: string }> {
    const result = await client.deleteVendor(vendorId)
    if (result.ok) await refreshAfterMutation()
    return result
  }

  async function syncHarness(vendorId: string): Promise<{ ok: boolean, file?: string, models?: number, error?: string }> {
    const result = await client.syncHarness(vendorId)
    return result
  }

  async function discoverModels(params: { vendor?: string, baseUrl?: string, apiKey?: string }): Promise<DiscoveredModel[]> {
    const body = await client.discoverModels(params)
    return body.data
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getState: () => state,
    refresh,
    setMode,
    reload,
    refreshVendors,
    refreshGateway,
    refreshAll,
    discoverModels,
    importHarness,
    syncHarness,
    deleteVendor,
    async saveVendors(mode, vendors) {
      try {
        await client.saveVendors(mode, vendors)
        await refreshAfterMutation()
      } catch (error) {
        set({ error: messageOf(error) })
      }
    },
    setOpen,
    setVisible,
    start() {
      disposed = false
      void refresh().then(schedule, schedule)
    },
    stop() {
      disposed = true
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      listeners.clear()
    },
  }
}

/** 从 unknown 里取可读消息。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
