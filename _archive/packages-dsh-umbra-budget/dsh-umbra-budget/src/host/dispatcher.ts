/**
 * The umbra-budget undici dispatcher — L2 of the interception stack.
 *
 * Installed process-wide over the harness's own dispatcher (captured at apply
 * and restored on dispose, provider-proxy style). Per dispatch it:
 *
 *   1. passes everything without an umbra ALS store straight through —
 *      non-matrix traffic keeps the launcher policy bit-for-bit;
 *   2. for matrix-routed calls with a B-track endpoint, rewrites
 *      origin/path/auth-headers/body.model via the pure `planReroute`
 *      (refusals are logged, never guessed);
 *   3. instruments the response handler so HTTP status codes and Retry-After
 *      feed the health machinery with precise signals the stream layer
 *      cannot always see;
 *   4. reports passive verification observations (did the waterfall rewrite
 *      actually flow?) to the runtime's backend probe.
 *
 * @module host/dispatcher
 */
import type { AsyncLocalStorage } from 'node:async_hooks'
import { extractBodyModel, planReroute } from '../core/reroute.ts'
import type { PoolModel } from '../core/types.ts'
import type { UmbraAls, UmbraStore } from './store.ts'
import { bodyAsText, originOf, rewriteHeaders } from './wire.ts'

export interface WireObservation {
  readonly modelId: string
  readonly kind: 'rerouted' | 'reroute-refused' | 'flow-ok' | 'rewrite-ignored' | 'passthrough' | 'status' | 'error'
  readonly origin?: string
  readonly status?: number
  readonly reason?: string
}

export interface WireSignal {
  readonly status: number
  readonly retryAfterMs?: number
}

export interface DispatcherDeps {
  readonly als: UmbraAls
  /** the previously installed dispatcher (harness policy) */
  readonly previous: unknown
  /** the undici module (injected; tests pass fakes) */
  readonly undici: {
    Dispatcher: new () => unknown
    ProxyAgent: new (options: { uri: string }) => { dispatch(options: unknown, handler: unknown): unknown; close(): Promise<void> }
  }
  modelOf(modelId: string | undefined): PoolModel | undefined
  onObservation(observation: WireObservation): void
  onSignal(modelId: string, signal: WireSignal): void
}

export interface UmbraDispatcher {
  dispatch(options: Record<string, unknown>, handler: HandlerRecord): unknown
  close(): Promise<void>
  destroy(error?: unknown): Promise<void>
}

export type HandlerRecord = Record<string, ((...args: unknown[]) => unknown) | undefined>

export interface UndiciModuleShape {
  Dispatcher: new () => unknown
  ProxyAgent: new (options: { uri: string }) => { dispatch(options: unknown, handler: unknown): unknown; close(): Promise<void> }
  getGlobalDispatcher(): unknown
  setGlobalDispatcher(value: unknown): void
}

export function createUmbraDispatcher(deps: DispatcherDeps): UmbraDispatcher {
  const { Dispatcher, ProxyAgent } = deps.undici
  const proxies = new Map<string, { dispatch(options: unknown, handler: unknown): unknown; close(): Promise<void> }>()
  const previous = deps.previous as { dispatch(options: unknown, handler: unknown): unknown; close(): Promise<void>; destroy(error?: unknown): Promise<void> }

  const proxyFor = (uri: string): { dispatch(options: unknown, handler: unknown): unknown } => {
    let agent = proxies.get(uri)
    if (agent === undefined) {
      agent = new (ProxyAgent as new (options: { uri: string }) => { dispatch(options: unknown, handler: unknown): unknown; close(): Promise<void> })({ uri })
      proxies.set(uri, agent)
    }
    return agent
  }

  class UmbraRoutingDispatcher {
    dispatch(options: Record<string, unknown>, handler: HandlerRecord): unknown {
      const store = deps.als.getStore()
      const model = deps.modelOf(store?.modelId)
      if (store === undefined || store.umbra !== true || model === undefined) {
        return previous.dispatch(options, handler)
      }
      const origin = originOf(options.origin)
      if (origin !== undefined && isLoopbackOrigin(origin)) {
        // loopback never leaves the machine — always direct (provider-proxy semantics)
        return previous.dispatch(options, handler)
      }

      let outgoing = options
      const path = typeof options.path === 'string' ? options.path : '/'

      if (model.endpoint !== undefined && model.apiKey !== undefined) {
        const bodyText = bodyAsText(options.body)
        const plan = planReroute({ origin: origin ?? '', path, ...(bodyText !== undefined ? { bodyText } : {}) }, model)
        if (plan.ok) {
          const outcome = plan.outcome
          outgoing = {
            ...options,
            origin: outcome.origin,
            path: outcome.path,
            headers: rewriteHeaders(options.headers, outcome.setHeaders, outcome.removeHeaders),
            ...(outcome.bodyText !== undefined ? { body: outcome.bodyText } : {}),
          }
          deps.onObservation({ modelId: model.id, kind: 'rerouted', origin: outcome.origin })
        } else {
          deps.onObservation({ modelId: model.id, kind: 'reroute-refused', origin, reason: plan.reason })
        }
      } else {
        // A-track: passive verification of the waterfall rewrite
        const bodyModel = extractBodyModel(bodyAsText(options.body))
        if (bodyModel === undefined) {
          deps.onObservation({ modelId: model.id, kind: 'passthrough', origin })
        } else if (store.rewriteApplied === true && bodyModel === model.model) {
          deps.onObservation({ modelId: model.id, kind: 'flow-ok', origin })
        } else if (store.rewriteApplied === true) {
          deps.onObservation({ modelId: model.id, kind: 'rewrite-ignored', origin })
        } else {
          deps.onObservation({ modelId: model.id, kind: 'passthrough', origin })
        }
        if (Object.keys(model.headers).length > 0) {
          outgoing = { ...options, headers: rewriteHeaders(options.headers, model.headers, []) }
        }
      }

      const target = (model.proxy !== undefined ? proxyFor(model.proxy) : previous) as {
        dispatch(options: unknown, handler: unknown): unknown
      }
      return target.dispatch(outgoing, instrumentHandler(handler, model.id, deps))
    }
  }

  const instance = new UmbraRoutingDispatcher() as unknown as UmbraDispatcher
  return {
    dispatch: (options, handler) => instance.dispatch(options, handler),
    async close() {
      await Promise.allSettled([...proxies.values()].map((agent) => agent.close()))
      proxies.clear()
    },
    async destroy(error?: unknown) {
      void error
      await Promise.allSettled([...proxies.values()].map((agent) => agent.close()))
      proxies.clear()
    },
  }
}

/**
 * Wrap an undici handler so status/error events are reported while every
 * callback is forwarded untouched.
 */
export function instrumentHandler(
  handler: HandlerRecord,
  modelId: string,
  deps: Pick<DispatcherDeps, 'onObservation' | 'onSignal'>,
): Record<string, ((...args: never[]) => unknown) | undefined> {
  const wrapped: Record<string, ((...args: never[]) => unknown) | undefined> = {}
  for (const key of ['onConnect', 'onHeaders', 'onData', 'onComplete', 'onError']) {
    const fn = handler[key]
    if (typeof fn !== 'function') continue
    wrapped[key] = (...args: unknown[]) => {
      if (key === 'onHeaders') {
        const status = args[0] as number
        const rawHeaders = args[1] as unknown
        const retryAfterMs = parseRetryAfter(rawHeaders)
        deps.onObservation({ modelId, kind: 'status', status })
        deps.onSignal(modelId, { status, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) })
      }
      if (key === 'onError') {
        deps.onObservation({ modelId, kind: 'error', reason: String(args[0]).slice(0, 200) })
      }
      return (fn as (...a: unknown[]) => unknown).apply(handler, args)
    }
  }
  return wrapped
}

function parseRetryAfter(rawHeaders: unknown): number | undefined {
  const list = Array.isArray(rawHeaders) ? rawHeaders : []
  for (let index = 0; index + 1 < list.length; index += 2) {
    if (String(list[index]).toLowerCase() !== 'retry-after') continue
    const seconds = Number(list[index + 1])
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000
  }
  return undefined
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    const host = url.hostname.toLowerCase()
    if (host === 'localhost' || host === '::1' || host === '0.0.0.0') return true
    return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  } catch {
    return false
  }
}
