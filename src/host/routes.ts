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
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { countAuthCookies } from '../core/auth-cookies.ts'
import type { ApiShape, ImportScope, ModelPrice, RoutingMode } from '../core/types.ts'

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
  /** 线路二选一：official（内置官网）或 relay（中转站）。 */
  endpointSource?: 'official' | 'relay'
  /** 上游协议；缺省 = 按地址自动判断。 */
  api?: ApiShape
  hasKey: boolean
  apiKeyMasked: string
  enabledModels: string[]
  modelTags: Record<string, string[]>
  modelPricing: Record<string, ModelPrice>
}

/** 面板路由需要的数据面。 */
export interface PanelApi {
  /** 取一次快照；计量需要读盘时可以是异步的。
   *  `seen` 是本次请求携带的网页会话信息（目前只有 dsh-auth Cookie 数量）：
   *  宿主自己收得到 Cookie 头，因此体检不需要碰被 Chromium 独占的 Cookies 文件。 */
  snapshot(seen?: { authCookies: number }): unknown | Promise<unknown>
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
  /** 从 DSH 现有 profile 抓取已经配好的上游（URL / 密钥 / 模型清单）。
   *  scope 为空 = 整份导入；带了就只导入地址/编号对上的那一家。 */
  importHarness?(scope?: ImportScope): Promise<{ ok: boolean, imported: string[], error?: string }>
  /** 反向同步：把管家里的这家厂家写回 DSH 的系统模型设置。 */
  syncHarness?(vendorId: string): Promise<{ ok: boolean, file?: string, models?: number, error?: string }>
  /** 显式删除一家厂家；保存永远不删东西。 */
  deleteVendor?(vendorId: string): Promise<{ ok: boolean, error?: string }>
}

/** 面板路由的可选资源目录。 */
export interface PanelRouteOptions {
  /** 内置头像目录（assets/avatars）；缺省时 avatar 端点返回 404。 */
  avatarDirectory?: string
}

/** 内置头像 id 的合法字符（防止路径穿越）。 */
const AVATAR_ID = /^[a-z0-9._-]+$/

/** 建全部面板路由。 */
export function makePanelRoutes(api: PanelApi, options: PanelRouteOptions = {}): StewardRoute[] {
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
        const cookieHeader = req.headers.cookie
        const seen = cookieHeader === undefined ? undefined : { authCookies: countAuthCookies(cookieHeader) }
        writeJson(res, 200, { ok: true, snapshot: await api.snapshot(seen) })
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
        // 四个模式都要认：白嫖（free）是一等模式，漏掉它面板就永远切不过去。
        if (mode !== 'frugal' && mode !== 'balanced' && mode !== 'max_power' && mode !== 'free') {
          writeJson(res, 400, { ok: false, error: 'mode must be frugal | balanced | max_power | free' })
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
        // 允许只给 vendorId：宿主会用这家厂商已保存的线路与密钥回落，
        // 免得用户为了拉一次模型把内置的官网地址原样再敲一遍。
        if (vendorId === '' && (baseUrl === '' || apiKey === '')) {
          writeJson(res, 400, { ok: false, error: 'vendorId, or baseUrl and apiKey, are required' })
          return
        }
        try {
          // 走 api.discover 而不是直接调 discoverUpstreamModels：只有前者知道
          // 「这家已保存的线路和密钥」，面板留空时靠它回落。绕过它就会拿空 key
          // 去打上游，用户看到的是莫名其妙的 401。
          const data = await api.discover(vendorId, baseUrl, apiKey)
          writeJson(res, 200, { ok: true, data })
        } catch (error) {
          writeJson(res, 502, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: API_PREFIX + '/delete-vendor',
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
        if (api.deleteVendor === undefined) {
          writeJson(res, 503, { ok: false, error: 'delete is not available' })
          return
        }
        const text = await readBody(req, 8 * 1024)
        if (text === undefined) {
          writeJson(res, 413, { ok: false, error: 'body too large' })
          return
        }
        let body: { vendorId?: unknown }
        try {
          body = JSON.parse(text) as typeof body
        } catch {
          writeJson(res, 400, { ok: false, error: 'body must be JSON' })
          return
        }
        const vendorId = typeof body.vendorId === 'string' ? body.vendorId : ''
        if (vendorId === '') {
          writeJson(res, 400, { ok: false, error: 'vendorId is required' })
          return
        }
        try {
          writeJson(res, 200, await api.deleteVendor(vendorId))
        } catch (error) {
          writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: API_PREFIX + '/sync-harness',
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
        if (api.syncHarness === undefined) {
          writeJson(res, 503, { ok: false, error: 'sync is not available' })
          return
        }
        const text = await readBody(req, 8 * 1024)
        if (text === undefined) {
          writeJson(res, 413, { ok: false, error: 'body too large' })
          return
        }
        let body: { vendorId?: unknown }
        try {
          body = JSON.parse(text) as typeof body
        } catch {
          writeJson(res, 400, { ok: false, error: 'body must be JSON' })
          return
        }
        const vendorId = typeof body.vendorId === 'string' ? body.vendorId : ''
        if (vendorId === '') {
          writeJson(res, 400, { ok: false, error: 'vendorId is required' })
          return
        }
        try {
          writeJson(res, 200, await api.syncHarness(vendorId))
        } catch (error) {
          writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: API_PREFIX + '/import-harness',
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
        if (api.importHarness === undefined) {
          writeJson(res, 503, { ok: false, error: 'import is not available' })
          return
        }
        // body 可选：不传就是整份导入；传了就按这家（id / 地址）只导入对上的那一条。
        const text = await readBody(req, 8 * 1024)
        let scope: ImportScope | undefined
        if (text !== undefined && text.trim() !== '') {
          let body: { vendorId?: unknown, baseUrl?: unknown }
          try {
            body = JSON.parse(text) as typeof body
          } catch {
            writeJson(res, 400, { ok: false, error: 'body must be JSON' })
            return
          }
          const vendorId = typeof body.vendorId === 'string' ? body.vendorId.trim() : ''
          const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : ''
          if (vendorId !== '' || baseUrl !== '') scope = { vendorId, baseUrl }
        }
        try {
          writeJson(res, 200, await api.importHarness(scope))
        } catch (error) {
          writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
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
        // 四个模式都要认：漏掉 'free' 的话，在「白嫖」下保存一次厂家配置
        // 就会把模式悄悄改回 frugal，用户下次发请求才发现路由变了。
        const mode: RoutingMode = body.mode === 'balanced' || body.mode === 'max_power' || body.mode === 'free'
          ? body.mode
          : 'frugal'
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
      path: API_PREFIX + '/avatar',
      handler: async (req, res) => {
        if (!guard(res)) return
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { ok: false, error: 'forbidden: loopback only' })
          return
        }
        if (req.method !== 'GET') {
          writeJson(res, 405, { ok: false, error: 'use GET' })
          return
        }
        const directory = options.avatarDirectory
        const id = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('id') ?? ''
        if (directory === undefined || !AVATAR_ID.test(id)) {
          writeJson(res, 404, { ok: false, error: 'avatar not found' })
          return
        }
        try {
          const body = await readFile(join(directory, id + '.png'))
          res.writeHead(200, {
            'content-type': 'image/png',
            'cache-control': 'public, max-age=86400',
            'x-content-type-options': 'nosniff',
          })
          res.end(body)
        } catch {
          writeJson(res, 404, { ok: false, error: 'avatar not found' })
        }
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
