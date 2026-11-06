/**
 * node-get：宿主出站 GET 的底层实现。
 *
 * 为什么单独测：主进程里的全局 fetch 走 Chromium 网络栈，实测同一个地址、同一个
 * Bearer，Node 200 而主进程 401。拉取模型改用 Node 的 http/https 后，行为要能被
 * 这一层钉住——状态码、请求头、重定向都别再随运行时变。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { nodeGet } from '../src/host/node-get.ts'

async function withServer(handler: Parameters<typeof createServer>[1], run: (base: string) => Promise<void>): Promise<void> {
  const server: Server = createServer(handler)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  try {
    await run('http://127.0.0.1:' + String(port))
  } finally {
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  }
}

test('node-get：拿到状态码与正文，请求头原样带上', async () => {
  let seen = ''
  await withServer((req, res) => {
    seen = String(req.headers.authorization ?? '')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'a' }] }))
  }, async (base) => {
    const result = await nodeGet(base + '/v1/models', { authorization: 'Bearer sk-test' }, 5_000)
    assert.equal(result.status, 200)
    assert.deepEqual(JSON.parse(result.body), { data: [{ id: 'a' }] })
    assert.equal(seen, 'Bearer sk-test')
  })
})

test('node-get：空值的头不发送（空 key 不该发一个假 Bearer）', async () => {
  let seen: string | undefined = 'unset'
  await withServer((req, res) => {
    seen = req.headers.authorization === undefined ? undefined : String(req.headers.authorization)
    res.writeHead(401)
    res.end('')
  }, async (base) => {
    const result = await nodeGet(base + '/models', { authorization: '' }, 5_000)
    assert.equal(result.status, 401)
    assert.equal(seen, undefined)
  })
})

test('node-get：跟一次重定向', async () => {
  await withServer((req, res) => {
    if (req.url === '/old') {
      res.writeHead(302, { location: '/new' })
      res.end('')
      return
    }
    res.writeHead(200)
    res.end('moved')
  }, async (base) => {
    const result = await nodeGet(base + '/old', {}, 5_000)
    assert.equal(result.status, 200)
    assert.equal(result.body, 'moved')
  })
})
