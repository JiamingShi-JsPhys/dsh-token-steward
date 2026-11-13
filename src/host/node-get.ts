/**
 * 用 Node 自己的 http/https 发一个 GET，而不是全局 fetch。
 *
 * 为什么不用 fetch：宿主跑在 Electron 主进程里，那里的 `fetch` 走的是 Chromium
 * 的网络栈（系统代理、PAC、缓存都在里面）。实测同一个地址、同一个 Bearer，
 * Node 里 200，主进程里 401——上游看到的是另一条链路。拉取模型只是一次 GET +
 * 一个 JSON，没必要借道 Chromium，用 Node 的网络栈行为可预期，也和测试一致。
 *
 * 不做流式：调用方要的是一份 JSON 清单。重定向最多跟三跳。
 */
import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'

/** 一次 GET 的结果：状态码 + 正文（原样字符串，解析交给调用方）。 */
export interface NodeGetResult {
  status: number
  body: string
}

/** 响应体上限：模型清单不该有 4 MiB，超过直接判失败而不是把内存吃满。 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

/** 跨主机重定向时必须丢掉的请求头（不能把钥匙交给别人）。 */
const SENSITIVE_HEADERS = new Set(['authorization', 'x-api-key', 'cookie', 'proxy-authorization'])

/**
 * GET 一个 JSON 地址。
 * @param url - 完整地址（http / https）
 * @param headers - 请求头；空值的项会被跳过
 * @param timeoutMs - 整体超时
 * @throws Error：连接失败、协议不支持、超时、响应过大
 */
export async function nodeGet(url: string, headers: Record<string, string>, timeoutMs: number): Promise<NodeGetResult> {
  let target = url
  let carried: Record<string, string> = { ...headers }
  let previousHost = hostOf(target)
  for (let hop = 0; hop < 4; hop += 1) {
    const result = await once(target, carried, timeoutMs)
    if (result.status < 300 || result.status >= 400 || result.location === undefined) {
      return { status: result.status, body: result.body }
    }
    const next = new URL(result.location, target).toString()
    const nextHost = hostOf(next)
    // 跳到了别的主机：钥匙、Cookie 一律不带过去。哪怕上游是善意重定向，
    // 把 Bearer 交给第三方也是泄漏。
    if (nextHost !== previousHost) {
      carried = Object.fromEntries(
        Object.entries(carried).filter(([name]) => !SENSITIVE_HEADERS.has(name.toLowerCase())),
      )
    }
    // 顺带拒绝 https → http 的降级：那等于把剩下的头（和查询参数）明文发出去。
    if (previousHost !== nextHost && new URL(target).protocol === 'https:' && new URL(next).protocol === 'http:') {
      throw new Error('refusing an https to http redirect')
    }
    previousHost = nextHost
    target = next
  }
  throw new Error('too many redirects')
}

/** URL 的 host（小写）；解析失败返回空串。 */
function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return ''
  }
}

function once(url: string, headers: Record<string, string>, timeoutMs: number): Promise<NodeGetResult & { location?: string }> {
  return new Promise((resolve, reject) => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      reject(new Error('invalid url'))
      return
    }
    const send = parsed.protocol === 'https:' ? httpsRequest : parsed.protocol === 'http:' ? httpRequest : undefined
    if (send === undefined) {
      reject(new Error('unsupported protocol ' + parsed.protocol))
      return
    }
    const clean: Record<string, string> = {}
    for (const [name, value] of Object.entries(headers)) {
      if (value !== '') clean[name] = value
    }
    const req = send(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port === '' ? undefined : Number(parsed.port),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: { accept: 'application/json', ...clean },
      },
      (res) => {
        const chunks: Buffer[] = []
        let total = 0
        res.on('data', (chunk: Buffer) => {
          total += chunk.length
          if (total > MAX_RESPONSE_BYTES) {
            // 不能只停止收集：连接还在流，要继续读掉或直接销毁。
            req.destroy(new Error('response exceeded ' + String(MAX_RESPONSE_BYTES) + ' bytes'))
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => {
          const location = res.headers.location
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            ...(typeof location === 'string' ? { location } : {}),
          })
        })
        res.on('error', reject)
      },
    )
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('request timed out after ' + String(timeoutMs) + 'ms'))
    })
    req.on('error', (error: Error) => { reject(error) })
    req.end()
  })
}
