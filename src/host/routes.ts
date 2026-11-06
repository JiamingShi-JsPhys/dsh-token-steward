/**
 * 面板的 HTTP 面。
 *
 * 四个端点，全部同源、全部只读（除了两个写入动作），全部拒绝非回环请求：
 *  - GET  api/token-steward/snapshot   面板主数据（MatrixSnapshot）
 *  - POST api/token-steward/mode       切换全局模式
 *  - POST api/token-steward/reload     重新读一次 model_pool.yaml
 *  - GET  api/token-steward/gateway    网关接线参数（含本地令牌，回环专用）
 *
 * 令牌会出现在这里的响应里，因此这些路由**必须**只服务回环地址。这不是
 * 可选项：网关的令牌等价于「谁都可以往你的模型矩阵里发请求」。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { RoutingMode } from '../core/types.ts'
import { discoverUpstreamModels } from './discovery.ts'

/** 面板路由前缀。 */
export const API_PREFIX = '/api/token-steward'

/** 一个最小的 HTTP 路由描述（形状与 dsh-host-webserver 的 WebRoute 一致）。 */
export interface StewardRoute {
  kind: 'exact'
  path: string
  handler(req: IncomingMessage, res: ServerResponse): void | Promise<void>
}

/** 判断请求是否来自本机。 */
export function isLoopbackRequest(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress
  if (typeof address !== 'string') return false
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1'
    || address === 'localhost'
}

/** 写 JSON。 */
export function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

/** 读请求体（有界）。 */
async function readBody(req: IncomingMessage, limit = 8 * 1024): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    total += buffer.length
    if (total > limit) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** 厂家配置的过线视图：密钥只有掩码，明文永不出宿主。 */
export interface VendorView {
  vendorId: string
  vendorName: string
  officialUrl: string
  customUrl: string
  hasKey: boolean
  apiKeyMasked: string
  enabledModels: string[]
}

/** 面板路由需要的数据面。 */
export interface PanelApi {
  /** 取一次快照；计量需要读盘时可以是异步的。 */
  snapshot(): unknown | Promise<unknown>
  /** 切换模式；返回是否被接受。 */
  setMode(mode: RoutingMode): boolean
  /** 重新读配置；返回结果说明。 */
  reload(): Promise<{ ok: boolean, status: string, error?: string }>
  /** 网关接线参数；未启动时为 undefined。 */
  gateway(): { baseUrl: string, token: string, modelIds: string[], port: number } | undefined
  /** 同源发现代理：宿主向真实上游探测模型列表（浏览器跨源被 CORS 拦，必须代理）。 */
  discover?(vendorId: string, baseUrl: string, apiKey: string): Promise<unknown>
  /** 当前厂家配置（密钥掩码）+ 持久化的全局模式；未实现时端点返回 503。 */
  getVendors?(): { mode: RoutingMode, vendors: VendorView[] }
  /** 整表保存厂家配置；apiKey 为空串表示「保留已存的明文」。 */
  saveVendors?(mode: RoutingMode, vendors: unknown): Promise<{ ok: boolean, error?: string }>
}

/** 建全部面板路由。 */
export function makePanelRoutes(api: PanelApi): StewardRoute[] {
  const guard = (res: ServerResponse): boolean => {
    // 只服务回环：这些端点会暴露本地令牌与全部模型清单。
    if (res.writableEnded) return false
    return true
  }

  return [
    {
      kind: 'exact',
      path: API_PREFIX + '/snapshot',
      handler: async (req, res) => {
        if (!guard(res)) return
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { ok: false, error: 'forbidden: loopback only' })
          return
        }
        writeJson(res, 200, { ok: true, snapshot: await api.snapshot() })
      },
    },
    {
      kind: 'exact',
      path: API_PREFIX + '/mode',
      handler: async (req, res) => {
        if (!guard(res)) return
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { ok: false, error: 'forbidden: loopback only' })
          return
        }
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: 'use POST' })
          return
        }
        const text = await readBody(req)
        if (text === undefined) {
          writeJson(res, 413, { ok: false, error: 'body too large' })
          return
        }
        let mode: unknown
        try {
          mode = (JSON.parse(text) as { mode?: unknown }).mode
        } catch {
          writeJson(res, 400, { ok: false, error: 'body must be JSON' })
          return
        }
        if (mode !== 'frugal' && mode !== 'balanced' && mode !== 'max_power') {
          writeJson(res, 400, { ok: false, error: 'mode must be frugal | efficiency | max_power' })
          return
        }
        const accepted = api.setMode(mode)
        writeJson(res, accepted ? 200 : 409, { ok: accepted, mode })
      },
    },
    {
      kind: 'exact',
      path: API_PREFIX + '/reload',
      handler: async (req, res) => {
        if (!guard(res)) return
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { ok: false, error: 'forbidden: loopback only' })
          return
        }
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: 'use POST' })
          return
        }
        const result = await api.reload()
        writeJson(res, 200, { ...result, ok: result.ok })
      },
    },
    {
      kind: 'exact',
      path: API_PREFIX + '/discover',
      handler: async (req, res) => {
        if (!guard(res)) return
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { ok: false, error: 'forbidden: loopback only' })
          return
        }
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: 'use POST' })
          return
        }
        if (api.discover === undefined) {
          writeJson(res, 503, { ok: false, error: 'discovery is not available' })
          return
        }
        const text = await readBody(req, 16 * 1024)
        if (text === undefined) {
          writeJson(res, 413, { ok: false, error: 'body too large' })
          return
        }
        let body: { vendorId?: unknown, baseUrl?: unknown, apiKey?: unknown }
        try {
          body = JSON.parse(text) as typeof body
        } catch {
          writeJson(res, 400, { ok: false, error: 'body must be JSON' })
          return
        }
        const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl : ''
        const apiKey = typeof body.apiKey === 'string' ? body.apiKey : ''
        const vendorId = typeof body.vendorId === 'string' ? body.vendorId : ''
        if (baseUrl === '' || apiKey === '') {
          writeJson(res, 400, { ok: false, error: 'baseUrl and apiKey are required' })
          return
        }
        try {
          const data = await discoverUpstreamModels(vendorId, baseUrl, apiKey)
          writeJson(res, 200, { ok: true, data })
        } catch (error) {
          writeJson(res, 502, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: API_PREFIX + '/vendors',
      handler: async (req, res) => {
        if (!guard(res)) return
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { ok: false, error: 'forbidden: loopback only' })
          return
        }
        if (req.method === 'GET') {
          if (api.getVendors === undefined) {
            writeJson(res, 503, { ok: false, error: 'vendor store is not available' })
            return
          }
          writeJson(res, 200, { ok: true, ...api.getVendors() })
          return
        }
        if (req.method !== 'PUT') {
          writeJson(res, 405, { ok: false, error: 'use GET or PUT' })
          return
        }
        const text = await readBody(req, 256 * 1024)
        if (text === undefined) {
          writeJson(res, 413, { ok: false, error: 'body too large' })
          return
        }
        let body: { mode?: unknown, vendors?: unknown }
        try {
          body = JSON.parse(text) as { mode?: unknown, vendors?: unknown }
        } catch {
          writeJson(res, 400, { ok: false, error: 'body must be JSON' })
          return
        }
        const mode = body.mode === 'balanced' || body.mode === 'max_power' ? body.mode : 'frugal'
        if (api.saveVendors === undefined) {
          writeJson(res, 503, { ok: false, error: 'vendor store is not available' })
          return
        }
        const result = await api.saveVendors(mode as RoutingMode, body.vendors)
        writeJson(res, result.ok ? 200 : 400, { ok: result.ok, ...(result.error !== undefined ? { error: result.error } : {}) })
      },
    },
    {
      kind: 'exact',
      path: API_PREFIX + '/gateway',
      handler: (req, res) => {
        if (!guard(res)) return
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { ok: false, error: 'forbidden: loopback only' })
          return
        }
        const info = api.gateway()
        if (info === undefined) {
          writeJson(res, 503, { ok: false, error: 'gateway is not running' })
          return
        }
        writeJson(res, 200, { ok: true, gateway: info })
      },
    },
  ]
}
