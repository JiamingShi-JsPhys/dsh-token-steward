/**
 * 面板 API 的入口闸门。
 *
 * 钉住 1.2.0 修掉的两类真实攻击：
 *  - **DNS rebinding**：攻击者域名解析到 127.0.0.1，`remoteAddress` 是回环，
 *    但 `Host` 还是攻击者域名 → 必须拒绝，否则 `/gateway` 会交出网关令牌。
 *  - **CSRF**：任意网页用 `text/plain` 发一个「简单请求」，body 仍是 JSON，
 *    旧代码照单全收 → 必须要求 `application/json`（跨源要预检，预检过不了）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage } from 'node:http'
import { isLoopbackRequest, panelRequestRejection } from '../src/host/routes.ts'

interface RequestShape {
  remoteAddress?: string | null | undefined
  method?: string
  headers?: Record<string, string | undefined>
}

function request(shape: RequestShape = {}): IncomingMessage {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(shape.headers ?? {})) {
    if (value !== undefined) headers[name.toLowerCase()] = value
  }
  return {
    method: shape.method ?? 'GET',
    // 只有「没写这个键」才用回环默认值；显式 undefined / null 要原样保留，供负例使用。
    socket: { remoteAddress: 'remoteAddress' in shape ? shape.remoteAddress : '127.0.0.1' },
    headers,
  } as unknown as IncomingMessage
}

test('回环判定保持原样（非回环一律出局）', () => {
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']) {
    assert.equal(isLoopbackRequest(request({ remoteAddress: address })), true, address)
  }
  for (const address of ['192.168.1.9', '10.0.0.2', undefined, null, '']) {
    assert.equal(isLoopbackRequest(request({ remoteAddress: address })), false, String(address))
  }
})

test('DNS rebinding：Host 是外域名就拒绝，哪怕连接来自 127.0.0.1', () => {
  const rebound = request({ headers: { host: 'evil.example:51741' } })
  assert.equal(panelRequestRejection(rebound), 'forbidden: host must be a loopback name')
  // 反过来：正常的回环 Host 放行。
  for (const host of ['127.0.0.1:51741', 'localhost:51741', '[::1]:51741', '127.0.0.1']) {
    assert.equal(panelRequestRejection(request({ headers: { host } })), undefined, host)
  }
  // 缺 Host（HTTP/1.0 之类）也拒绝，不靠兜底。
  assert.equal(panelRequestRejection(request()), 'forbidden: missing host header')
})

test('Origin 必须与 Host 同源', () => {
  const host = '127.0.0.1:51741'
  assert.equal(panelRequestRejection(request({ headers: { host, origin: 'http://127.0.0.1:51741' } })), undefined)
  assert.equal(panelRequestRejection(request({ headers: { host, origin: 'http://EVIL.example' } })), 'forbidden: origin mismatch')
  // `Origin: null`（沙箱 iframe / file://）同样不放行。
  assert.equal(panelRequestRejection(request({ headers: { host, origin: 'null' } })), 'forbidden: origin mismatch')
})

test('Sec-Fetch-Site 跨站就拒绝', () => {
  const host = '127.0.0.1:51741'
  assert.equal(panelRequestRejection(request({ headers: { host, 'sec-fetch-site': 'cross-site' } })), 'forbidden: cross-site request')
  assert.equal(panelRequestRejection(request({ headers: { host, 'sec-fetch-site': 'same-site' } })), 'forbidden: cross-site request')
  assert.equal(panelRequestRejection(request({ headers: { host, 'sec-fetch-site': 'same-origin' } })), undefined)
  assert.equal(panelRequestRejection(request({ headers: { host, 'sec-fetch-site': 'none' } })), undefined)
})

test('写操作必须是 application/json：text/plain 的「简单请求」出局', () => {
  const host = '127.0.0.1:51741'
  const csrf = request({
    headers: { host, 'content-type': 'text/plain' },
    method: 'POST',
  })
  assert.equal(panelRequestRejection(csrf), 'forbidden: panel writes must be application/json')
  // 表单编码也是浏览器的简单请求，同样不行。
  assert.equal(
    panelRequestRejection(request({ headers: { host, 'content-type': 'application/x-www-form-urlencoded' }, method: 'POST' })),
    'forbidden: panel writes must be application/json',
  )
  // 正常的 JSON 请求（面板客户端就是这么发的）放行。
  assert.equal(
    panelRequestRejection(request({ headers: { host, 'content-type': 'application/json; charset=utf-8' }, method: 'POST' })),
    undefined,
  )
  // GET 不受 Content-Type 约束（没有请求体）。
  assert.equal(panelRequestRejection(request({ headers: { host }, method: 'GET' })), undefined)
})

test('非回环地址先于其它检查被拒', () => {
  const lan = request({ remoteAddress: '192.168.1.9', headers: { host: '127.0.0.1:51741' } })
  assert.equal(panelRequestRejection(lan), 'forbidden: loopback only')
})
