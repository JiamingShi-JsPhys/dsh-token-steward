/**
 * 面板的 HTTP 面。
 *
 * 四个端点，全部同源、全部只读（除了两个写入动作），全部拒绝非回环请求：
 *  - GET  api/umbra-budget/snapshot   面板主数据（MatrixSnapshot）
 *  - POST api/umbra-budget/mode       切换全局模式
 *  - POST api/umbra-budget/reload     重新读一次 model_pool.yaml
 *  - GET  api/umbra-budget/gateway    网关接线参数（含本地令牌，回环专用）
 *
 * 令牌会出现在这里的响应里，因此这些路由**必须**只服务回环地址。这不是
 * 可选项：网关的令牌等价于「谁都可以往你的模型矩阵里发请求」。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { RoutingMode } from '../core/types.ts'

/** 面板路由前缀。 */
export const API_PREFIX = '/api/umbra-budget'

/** 一个最小的 HTTP 路由描述（形状与 dsh-host-webserver 的 WebRoute 一致）。 */
export interface UmbraRoute {
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
}

/** 建全部面板路由。 */
export function makePanelRoutes(api: PanelApi): UmbraRoute[] {
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
        if (mode !== 'frugal' && mode !== 'efficiency' && mode !== 'max_power') {
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
