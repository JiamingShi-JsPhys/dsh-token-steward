
import { apply } from '../src/index.ts'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'steward-e2e-'))
process.env.DSH_HOME = home
process.env.CHEAP_KEY = 'sk-cheap'
await mkdir(join(home, 'token-steward'), { recursive: true })
const poolPath = join(home, 'token-steward', 'model_pool.yaml')
await writeFile(poolPath, [
  'version: 1',
  'routing:',
  '  mode: frugal',
  'providers:',
  '  - provider_name: cheap',
  '    endpoint: https://cheap.example/v1',
  '    api: openai-completions',
  '    api_key: env:CHEAP_KEY',
  '    models:',
  '      - id: cheap-1',
  '        capabilities: [coding]',
  '        cost_level: free',
  '        context_window: 128000',
  '        availability: direct',
  '        quality_rank: 40',
  '        pricing: { currency: CNY, input_per_mtok: 0, output_per_mtok: 1 }',
].join('\n'))

const routes = []
const logs = []
const ctx = {
  logger: () => ({ info: (...a) => logs.push('info ' + a.join(' ')), warn: (...a) => logs.push('warn ' + a.join(' ')), error: (...a) => logs.push('error ' + a.join(' ')) }),
  webServer: { register(route) { routes.push(route); return () => {} } },
  effect(fn) { this._teardown = fn() },
}
await apply(ctx, {})

console.log('routes:', routes.map(r => r.path))
console.log('logs:'); for (const l of logs) console.log('  ', l)

const statePath = join(home, 'token-steward', 'gateway.json')
const state = JSON.parse(await (await import('node:fs/promises')).readFile(statePath, 'utf8'))
console.log('gateway state:', { port: state.port, baseUrl: state.baseUrl, modelIds: state.modelIds, tokenLen: state.token.length })

// 打网关的 /v1/models
const models = await fetch(state.baseUrl + '/models', { headers: { authorization: 'Bearer ' + state.token } })
console.log('GET /v1/models ->', models.status, JSON.stringify(await models.json()))

// 打面板 snapshot 路由（真 HTTP）
const { createServer } = await import('node:http')
const { writeJson } = await import('../src/host/routes.ts')
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname
  const route = routes.find(r => r.path === path)
  if (!route) { writeJson(res, 404, {}); return }
  void Promise.resolve(route.handler(req, res))
})
const port = await new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)))
const snap = await fetch('http://127.0.0.1:' + port + '/api/token-steward/snapshot')
const snapBody = await snap.json()
console.log('GET /api/token-steward/snapshot ->', snap.status)
console.log('  mode:', snapBody.snapshot.mode, '| models:', snapBody.snapshot.models.length, '| pool:', snapBody.snapshot.pool.status)
console.log('  card:', JSON.stringify(snapBody.snapshot.models[0]))

const modeRes = await fetch('http://127.0.0.1:' + port + '/api/token-steward/mode', { method: 'POST', body: JSON.stringify({ mode: 'max_power' }) })
console.log('POST /mode ->', modeRes.status, JSON.stringify(await modeRes.json()))
const persisted = await (await import('node:fs/promises')).readFile(poolPath, 'utf8')
console.log('persisted mode line:', persisted.split('\n').find(l => l.includes('mode:')))

const gw = await fetch('http://127.0.0.1:' + port + '/api/token-steward/gateway')
const gwBody = await gw.json()
console.log('GET /gateway ->', gw.status, 'modelIds:', gwBody.gateway.modelIds.length)

server.close()
ctx._teardown()
