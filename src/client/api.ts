/**
 * 面板的 HTTP 客户端。
 *
 * 只用同源相对路径：宿主把 GUI 挂在可能带前缀的位置，绝对路径会跑出这个前缀。
 * 每次调用都带超时——一个卡住的 host 不该把面板也拖住。
 */
import type { MatrixSnapshot, RoutingMode } from '../core/types.ts'

/** 单次调用预算：与 dsh-usage 面板保持一致。 */
export const PANEL_FETCH_TIMEOUT_MS = 10_000

/** 网关接线参数（设置页展示与复制用）。 */
export interface GatewayInfo {
  baseUrl: string
  token: string
  modelIds: string[]
  port: number
}

/** 厂家配置的过线视图（密钥只有掩码）。 */
export interface VendorView {
  vendorId: string
  vendorName: string
  officialUrl: string
  customUrl: string
  hasKey: boolean
  apiKeyMasked: string
  enabledModels: string[]
}

/** 厂家 Tab 的目录条目（来自静态模板，随 GET /vendors 一起下发）。 */
export interface CatalogVendor {
  vendorId: string
  vendorName: string
  officialUrl: string
  models: Array<{ id: string, name: string, tier: string }>
}

/** 拉取到的上游模型（/v1/models 发现端点的行）。 */
export interface DiscoveredModel {
  id: string
  name: string
  tier: string
  inCatalog: boolean
}

/** 面板 API 的形状（测试注入替身）。 */
export interface PanelClient {
  snapshot(): Promise<MatrixSnapshot>
  setMode(mode: RoutingMode): Promise<boolean>
  reload(): Promise<{ ok: boolean, status: string, error?: string }>
  /** 网关接线参数；未启动时 undefined。 */
  gateway(): Promise<GatewayInfo | undefined>
  /** 厂家配置（密钥掩码）+ 持久化模式。 */
  vendors(): Promise<{ mode: RoutingMode, vendors: VendorView[], catalog: CatalogVendor[] }>
  /** 整表保存；apiKey 空串 = 保留已存明文。 */
  saveVendors(mode: RoutingMode, vendors: unknown): Promise<{ ok: boolean, error?: string }>
  /** 探测上游真实模型列表（走网关的发现端点）。 */
  discoverModels(gateway: GatewayInfo, params: { vendor?: string, baseUrl?: string, apiKey?: string }): Promise<{ data: DiscoveredModel[] }>
}

/** fetch 的最小形状。 */
export type FetchLike = (input: string, init?: Record<string, unknown>) => Promise<Response>

/** 相对路径前缀：与 host/routes.ts 的 API_PREFIX 一致。 */
export const PANEL_API_BASE = 'api/token-steward'

/** 建一个面板客户端。 */
export function createPanelClient(fetchImpl?: FetchLike): PanelClient {
  const doFetch: FetchLike = fetchImpl ?? ((input, init) => fetch(input, init as RequestInit))

  async function call<T>(path: string, init?: Record<string, unknown>): Promise<T> {
    const response = await doFetch(PANEL_API_BASE + path, {
      ...init,
      signal: AbortSignal.timeout(PANEL_FETCH_TIMEOUT_MS),
    })
    if (!response.ok) {
      throw new Error('panel ' + path + ' failed: ' + String(response.status))
    }
    return await response.json() as T
  }

  return {
    async snapshot() {
      const body = await call<{ ok: boolean, snapshot: MatrixSnapshot }>('/snapshot')
      return body.snapshot
    },
    async vendors() {
      const body = await call<{ ok: boolean, mode: RoutingMode, vendors: VendorView[], catalog: CatalogVendor[] }>('/vendors')
      return { mode: body.mode, vendors: body.vendors, catalog: body.catalog }
    },
    async saveVendors(mode, vendors) {
      const body = await call<{ ok: boolean, error?: string }>('/vendors', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode, vendors }),
      })
      if (!body.ok) throw new Error(body.error ?? 'save failed')
      return body
    },
    async discoverModels(gateway, params) {
      const search = new URLSearchParams()
      if (params.vendor !== undefined) search.set('vendor', params.vendor)
      if (params.baseUrl !== undefined && params.baseUrl !== '') search.set('base_url', params.baseUrl)
      if (params.apiKey !== undefined && params.apiKey !== '') search.set('api_key', params.apiKey)
      const response = await doFetch(gateway.baseUrl + '/models?' + search.toString(), {
        headers: { authorization: 'Bearer ' + gateway.token },
        signal: AbortSignal.timeout(PANEL_FETCH_TIMEOUT_MS),
      })
      if (!response.ok) {
        const detail = await response.json().catch(() => undefined) as { error?: { message?: string } } | undefined
        throw new Error(detail?.error?.message ?? 'discovery failed: ' + String(response.status))
      }
      return await response.json() as { data: DiscoveredModel[] }
    },
    async setMode(mode) {
      const body = await call<{ ok: boolean, mode: RoutingMode }>('/mode', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode }),
      })
      return body.ok
    },
    async reload() {
      return await call<{ ok: boolean, status: string, error?: string }>('/reload', { method: 'POST' })
    },
    async gateway() {
      try {
        const body = await call<{ ok: boolean, gateway?: GatewayInfo }>('/gateway')
        return body.gateway
      } catch {
        // 网关未启动是正常状态，设置页显示破折号即可，不需要把错误抛到界面上。
        return undefined
      }
    },
  }
}
