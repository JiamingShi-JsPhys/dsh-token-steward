/**
 * HTTP control surface: overview / SSE events / mode / model toggle / verify.
 *
 * Mounted on the harness loopback web server (`ctx.webServer.register`); every
 * request passes a loopback trust fence before touching state. Live frames
 * (route decisions, cooldowns, recovery) flow through the shared FrameBus.
 *
 * @module host/routes
 */
import { promptCacheHitRate } from '../core/ledger.ts'
import { healthSnapshots } from './router.ts'
import type { RouterState } from './router.ts'
import type { SignalHub } from './signals.ts'
import type { FrameBus } from './frames.ts'
import type { IncomingMessageLike, LoggerFace, ServerResponseLike, WebRoute, WebServerFace } from './dsh-face.ts'
import type { RouteEventFrame, ScheduleMode, UmbraOverview } from '../core/types.ts'
import { SCHEDULE_MODES } from '../core/types.ts'

export interface RouteServices {
  readonly log: LoggerFace
  readonly bus: FrameBus
  readonly getState: () => RouterState & { readonly signalHub: SignalHub }
  setMode(mode: ScheduleMode): Promise<void> | void
  setModelEnabled(modelId: string, enabled: boolean): Promise<void> | void
  runVerify(): Promise<{ backend: string; detail: string }>
}

const SSE_HEARTBEAT_MS = 15_000

export function registerRoutes(webServer: WebServerFace, services: RouteServices): () => void {
  const { bus } = services
  const disposers: Array<() => void> = []

  const heartbeat = setInterval(() => {
    if (bus.subscriberCount > 0) bus.publish('usage')
  }, SSE_HEARTBEAT_MS)
  heartbeat.unref?.()
  disposers.push(() => clearInterval(heartbeat))
  disposers.push(
    services.getState().journal.onUpdate((decision) => {
      bus.publish('dispatch', { ts: decision.ts, decision })
    }),
  )

  const overview = (): UmbraOverview => {
    const state = services.getState()
    const now = new Date()
    const today = state.ledger.todayTotals(now)
    const snapshots = healthSnapshots(state.health)
    const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls: 0, costByCurrency: {} }
    return {
      mode: state.pool?.policy.mode ?? 'frugal',
      backend: state.signalHub.backendVerdict(),
      pool: (state.pool?.models ?? []).map((model) => ({
        model,
        health: snapshots.get(model.id) ?? { status: 'healthy' as const, failures: 0, coolUntil: 0, inFlight: 0, ewmaTtfbMs: 0 },
        today: state.ledger.doc.days[todayKey(now)]?.[model.id] ?? { ...zero, costByCurrency: {} },
      })),
      today,
      promptCacheHitRate: promptCacheHitRate(today),
      localCache: { ...(state.cache?.stats() ?? { hits: 0, misses: 0, size: 0, evictions: 0 }), enabled: state.pool?.policy.cache.exactMatch === true },
      recentRoutes: state.journal.recent(50),
      agents: state.journal.assignments(12),
    }
  }

  const routes: WebRoute[] = [
    {
      kind: 'exact',
      path: '/api/umbra-budget/overview',
      async handler(_req, res) {
        writeJson(res, 200, overview())
      },
    },
    {
      kind: 'exact',
      path: '/api/umbra-budget/events',
      handler(req, res) {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'loopback only' })
          return
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        res.write('retry: 3000\n\n')
        const unsubscribe = bus.subscribe((eventFrame: RouteEventFrame) => {
          try {
            res.write(`data: ${JSON.stringify(eventFrame)}\n\n`)
          } catch {
            unsubscribe()
          }
        })
        const cleanup = (): void => {
          unsubscribe()
        }
        res.on('close', cleanup)
        res.on('error', cleanup)
      },
    },
    {
      kind: 'exact',
      path: '/api/umbra-budget/mode',
      async handler(req, res) {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'loopback only' })
        const body = await readJsonBody(req)
        const mode = body?.mode
        if (typeof mode !== 'string' || !SCHEDULE_MODES.includes(mode as ScheduleMode)) {
          return writeJson(res, 400, { error: `mode 必须是 ${SCHEDULE_MODES.join(' | ')}` })
        }
        await services.setMode(mode as ScheduleMode)
        writeJson(res, 200, { ok: true, mode })
      },
    },
    {
      kind: 'exact',
      path: '/api/umbra-budget/model-toggle',
      async handler(req, res) {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'loopback only' })
        const body = await readJsonBody(req)
        const modelId = body?.modelId
        const enabled = body?.enabled
        if (typeof modelId !== 'string' || typeof enabled !== 'boolean') {
          return writeJson(res, 400, { error: '需要 { modelId: string, enabled: boolean }' })
        }
        await services.setModelEnabled(modelId, enabled)
        writeJson(res, 200, { ok: true, modelId, enabled })
      },
    },
    {
      kind: 'exact',
      path: '/api/umbra-budget/verify',
      async handler(req, res) {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'loopback only' })
        try {
          writeJson(res, 200, await services.runVerify())
        } catch (error) {
          writeJson(res, 500, { backend: 'unknown', detail: error instanceof Error ? error.message : String(error) })
        }
      },
    },
  ]

  for (const route of routes) {
    const registered = webServer.register(route)
    if (typeof registered === 'function') disposers.push(registered as () => void)
  }

  return () => {
    for (const disposer of disposers) {
      try {
        disposer()
      } catch {
        /* best effort */
      }
    }
  }
}

// ----------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------

export function isLoopbackRequest(req: IncomingMessageLike): boolean {
  const remote = req.socket?.remoteAddress ?? ''
  if (!isLoopbackAddress(remote)) return false
  // proxied requests are never trusted
  for (const header of ['x-forwarded-for', 'x-real-ip', 'forwarded']) {
    if (req.headers[header] !== undefined) return false
  }
  const fetchSite = req.headers['sec-fetch-site']
  if (typeof fetchSite === 'string' && fetchSite !== 'same-origin' && fetchSite !== 'none') return false
  return true
}

function isLoopbackAddress(address: string): boolean {
  const host = address.replace(/^::ffff:/, '').toLowerCase()
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

function readJsonBody(req: IncomingMessageLike): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    const finish = (value: Record<string, unknown> | undefined): void => {
      if (done) return
      done = true
      resolve(value)
    }
    req.on('data', (chunk?: unknown) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      size += buffer.length
      if (size > 64 * 1024) finish(undefined)
      else chunks.push(buffer)
    })
    req.on('end', () => {
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
      } catch {
        finish(undefined)
      }
    })
    req.on('error', () => finish(undefined))
  })
}

function writeJson(res: ServerResponseLike, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

function todayKey(now: Date): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
