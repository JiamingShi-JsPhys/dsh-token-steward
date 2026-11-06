/**
 * Persistence + HTTP control-surface tests (fake webServer / req / res).
 * @module tests/host-shell.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { FrameBus } from '../src/host/frames.ts'
import { RouteJournal } from '../src/host/journal.ts'
import { openLedger, readRuntimeState, writeRuntimeState } from '../src/host/persistence.ts'
import { isLoopbackRequest, registerRoutes } from '../src/host/routes.ts'
import { SignalHub } from '../src/host/signals.ts'
import type { IncomingMessageLike, LoggerFace, ServerResponseLike, WebRoute, WebServerFace } from '../src/host/dsh-face.ts'
import type { ModelPool } from '../src/core/types.ts'
import { ModelHealth } from '../src/core/health.ts'

function makeLogger(): LoggerFace {
  return { info: () => {}, warn: () => {}, error: () => {} }
}

// ----------------------------------------------------------------------
// persistence
// ----------------------------------------------------------------------

test('ledger persistence: debounce flush → atomic file → reload round-trip', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'umbra-persist-'))
  const first = await openLedger(dir, makeLogger())
  first.ledger.add('a/m', { inputTokens: 42, outputTokens: 7 }, { currency: 'CNY', input: 2, output: 8 }, new Date())
  await first.flushNow()

  const file = join(dir, 'usage-ledger.json')
  assert.equal(existsSync(file), true)
  const second = await openLedger(dir, makeLogger())
  assert.equal(second.ledger.todayTotals(new Date()).inputTokens, 42)
  await second.close()
})

test('runtime state round-trips; missing file yields empty state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'umbra-state-'))
  assert.deepEqual(await readRuntimeState(dir), {})
  await writeRuntimeState(dir, { mode: 'efficiency', disabledModels: ['x/y'] })
  const state = await readRuntimeState(dir)
  assert.equal(state.mode, 'efficiency')
  assert.deepEqual(state.disabledModels, ['x/y'])
})

// ----------------------------------------------------------------------
// loopback fence
// ----------------------------------------------------------------------

function fakeReq(partial: Partial<IncomingMessageLike>): IncomingMessageLike {
  return {
    method: 'GET',
    url: '/',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    on: () => ({}),
    ...partial,
  }
}

test('loopback fence: loopback passes, remote and proxied requests are rejected', () => {
  assert.equal(isLoopbackRequest(fakeReq({})), true)
  assert.equal(isLoopbackRequest(fakeReq({ socket: { remoteAddress: '192.168.1.5' } })), false)
  assert.equal(isLoopbackRequest(fakeReq({ socket: { remoteAddress: '::ffff:127.0.0.1' } })), true)
  assert.equal(isLoopbackRequest(fakeReq({ headers: { 'x-forwarded-for': '10.0.0.1' } })), false)
  assert.equal(isLoopbackRequest(fakeReq({ headers: { 'sec-fetch-site': 'cross-site' } })), false)
  assert.equal(isLoopbackRequest(fakeReq({ headers: { 'sec-fetch-site': 'same-origin' } })), true)
})

// ----------------------------------------------------------------------
// HTTP surface
// ----------------------------------------------------------------------

interface RecordedResponse {
  status?: number
  headers?: Record<string, string>
  body: string[]
}

function fakeRes(): { res: ServerResponseLike; recorded: RecordedResponse } {
  const recorded: RecordedResponse = { body: [] }
  const res: ServerResponseLike = {
    writeHead(status, headers) {
      recorded.status = status
      recorded.headers = headers
      return res
    },
    write(chunk) {
      recorded.body.push(String(chunk))
      return true as never
    },
    end(chunk) {
      if (chunk !== undefined) recorded.body.push(String(chunk))
      return res
    },
    on: () => res,
  }
  return { res, recorded }
}

function fakeWebServer() {
  const routes = new Map<string, WebRoute>()
  const server: WebServerFace = {
    register(route: WebRoute) {
      routes.set(route.path, route)
      return () => {}
    },
  }
  return { server, routes }
}

function harnessPool(): ModelPool {
  return {
    version: 1,
    models: [
      {
        id: 'school/glm-flash',
        provider: 'school',
        model: 'glm-flash',
        tags: { capabilities: ['fast'], costLevel: 'free', contextWindow: 128_000, availability: 'direct' },
        enabled: true,
        endpoint: 'https://school-mirror.test/v1',
        apiKey: 'sk-test',
        authStyle: 'bearer',
        headers: {},
        configured: true,
        configNotes: [],
      },
    ],
    policy: {
      mode: 'frugal',
      classifier: { trivialMaxChars: 2000, heavyMinChars: 60000, heavyTools: true },
      fallback: { maxRetries: 2, cooldownMs: 30000, rateLimitMs: 60000 },
      scatter: { efficiencyMinInflight: 2 },
      cache: { exactMatch: false },
    },
    loadedAt: 0,
  }
}

function routeServices(overrides: Partial<Parameters<typeof registerRoutes>[1]> = {}) {
  const health = new Map<string, ModelHealth>()
  health.set('school/glm-flash', new ModelHealth({ cooldownMs: 30_000, rateLimitMs: 60_000 }))
  return {
    log: makeLogger(),
    bus: new FrameBus(),
    getState: () => ({
      pool: harnessPool(),
      health,
      ledger: { todayTotals: () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls: 0, costByCurrency: {} }), doc: { days: {}, agents: {} } } as never,
      journal: new RouteJournal(),
      signals: new SignalHub(),
      signalHub: new SignalHub(),
    }) as never,
    setMode: () => {},
    setModelEnabled: () => {},
    runVerify: async () => ({ backend: 'waterfall', detail: 'ok' }),
    ...overrides,
  } as Parameters<typeof registerRoutes>[1]
}

test('overview returns pool cards, today totals and recent routes', async () => {
  const { server, routes } = fakeWebServer()
  registerRoutes(server, routeServices())
  const { res, recorded } = fakeRes()
  const handler = routes.get('/api/umbra-budget/overview')!.handler
  await handler(fakeReq({}), res)
  assert.equal(recorded.status, 200)
  const parsed = JSON.parse(recorded.body.join('')) as { mode: string; pool: unknown[]; recentRoutes: unknown[]; agents: unknown[] }
  assert.equal(parsed.mode, 'frugal')
  assert.equal(parsed.pool.length, 1)
})

test('mode endpoint validates and forwards; rejects unknown modes', async () => {
  const { server, routes } = fakeWebServer()
  const applied: string[] = []
  registerRoutes(server, routeServices({ setMode: (mode) => { applied.push(mode) } }))
  const handler = routes.get('/api/umbra-budget/mode')!.handler

  let wired: IncomingMessageLike | undefined
  wired = fakeReq({ method: 'POST' })
  wired.on = (event, cb) => {
    if (event === 'data') (cb as (c: unknown) => void)(Buffer.from(JSON.stringify({ mode: 'max_power' })))
    if (event === 'end') (cb as () => void)()
    return wired
  }
  const good = fakeRes()
  await handler(wired, good.res)
  assert.equal(good.recorded.status, 200)
  assert.deepEqual(applied, ['max_power'])

  let badWired: IncomingMessageLike | undefined
  badWired = fakeReq({ method: 'POST' })
  badWired.on = (event, cb) => {
    if (event === 'data') (cb as (c: unknown) => void)(Buffer.from(JSON.stringify({ mode: 'turbo' })))
    if (event === 'end') (cb as () => void)()
    return badWired
  }
  const bad = fakeRes()
  await handler(badWired, bad.res)
  assert.equal(bad.recorded.status, 400)
})

test('SSE endpoint subscribes to the bus and relays frames', async () => {
  const { server, routes } = fakeWebServer()
  const services = routeServices()
  registerRoutes(server, services)
  const { res, recorded } = fakeRes()
  let closeCb: (() => void) | undefined
  const sseRes: ServerResponseLike = {
    ...res,
    on(event, cb) {
      if (event === 'close') closeCb = cb as () => void
      return sseRes
    },
  }
  const handler = routes.get('/api/umbra-budget/events')!.handler
  handler(fakeReq({}), sseRes)
  services.bus.publish('cooldown', { modelId: 'x/y' })
  assert.ok(recorded.body.join('').includes('cooldown'), 'frame relayed to the SSE subscriber')
  assert.ok(recorded.body.join('').includes('x/y'))
  closeCb?.()
})

test('remote requests are rejected on mutating endpoints', async () => {
  const { server, routes } = fakeWebServer()
  registerRoutes(server, routeServices())
  const { res, recorded } = fakeRes()
  const handler = routes.get('/api/umbra-budget/mode')!.handler
  const remote = fakeReq({ method: 'POST', socket: { remoteAddress: '10.1.2.3' } })
  remote.on = (event, cb) => {
    if (event === 'end') (cb as () => void)()
    return remote
  }
  await handler(remote, res)
  assert.equal(recorded.status, 403)
})
