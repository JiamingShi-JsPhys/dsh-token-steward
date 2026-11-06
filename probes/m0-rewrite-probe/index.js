/**
 * `dsh-umbra-rewrite-probe` — M0 capability probe for the umbra-budget model matrix.
 *
 * Answers, against the REAL running harness:
 *
 *   P1  Can a `llm/stream` waterfall listener rewrite `options.provider`/`options.model`
 *       so the change reaches the outbound HTTP request? Tested on BOTH dispatch paths:
 *       public `llm.stream(options)` and registration-bound `prepareCall().stream()`
 *       (the official agent-loop path). Proof signals:
 *         a) `Object.isFrozen(options)` / assignment TypeError — mutation resisted;
 *         b) outbound request body `model` carries the marker (dispatcher observation);
 *         c) the API error echoes the marker model (unknown-model round trip).
 *   P1c Does the harness re-read `options.provider`? (rewrite to a provider id that
 *       cannot exist; a harness-level failure before any HTTP request proves it does.)
 *   P2  What shape does the waterfall hand over? (own keys, frozenness, caller fields)
 *       plus which `session/event` types flow during the window.
 *   P3  Is the waterfall `next()` re-callable? (double call on a throwaway probe call.)
 *   P4  What face does `ctx.get('settings')` expose? (method NAMES only; never values.)
 *
 * Only probe-issued calls are rewritten (tagged in an AsyncLocalStorage store); user
 * traffic passes through untouched. Every step is failure-isolated; a probe crash
 * writes a partial report and never affects the harness.
 *
 * Report: `$DSH_HOME/umbra-probe/report.json` (the Desktop host captures no stdout).
 *
 * @module dsh-umbra-rewrite-probe
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'umbra-rewrite-probe'
export const inject = ['llm']

/**
 * Build the probe. `injected.undici` lets tests supply a fake undici module;
 * production resolves the real one dynamically inside `apply`.
 */
export function createProbe({ ctx, llm, config = {}, undici }) {
  const log = ctx.logger('umbra-probe')
  const als = new AsyncLocalStorage()
  const marker = typeof config.marker === 'string' && config.marker !== '' ? config.marker : '__UMBRA_PROBE__'
  const baseProvider = config.provider ?? 'deepseek'
  const baseModel = config.model ?? 'deepseek-chat'
  const bogusProvider = config.probeProvider ?? '__umbra_nonexistent_provider__'
  const timeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : 30_000

  const report = {
    kind: 'umbra-rewrite-probe/1',
    startedAt: new Date().toISOString(),
    pid: process.pid,
    node: process.version,
    runtime: { hasPrepareCall: typeof llm?.prepareCall === 'function' },
    probes: {},
    dispatcher: { installed: false, observations: [] },
    sessionEvents: [],
    waterfallShapes: [],
  }
  const record = (key, value) => {
    report.probes[key] = value
    log.info('probe %s: %s', key, JSON.stringify(value))
  }

  // ------------------------------------------------------------------
  // Dispatcher observer: watches every outbound request; the ones issued
  // inside a probe ALS store get fingerprinted (origin, path, body.model,
  // auth fingerprint — never the secret itself).
  // ------------------------------------------------------------------
  let observer = null
  async function installObserver() {
    if (observer) return true
    const mod = undici ?? await import('undici')
    const previous = mod.getGlobalDispatcher()
    const { Dispatcher } = mod
    const obs = report.dispatcher.observations
    const inst = new (class extends Dispatcher {
      dispatch(options, handler) {
        const store = als.getStore()
        if (store !== undefined && store.probe !== undefined) {
          obs.push({
            tag: store.probe.tag,
            origin: safeText(options.origin, 120),
            path: safeText(options.path, 200),
            method: safeText(options.method, 8),
            bodyModel: bodyModelOf(options.body),
            authFingerprint: authFingerprintOf(options.headers),
          })
          handler = wrapHandler(handler, (kind, extra) => obs.push({ tag: store.probe.tag, kind, ...extra }))
        }
        return previous.dispatch(options, handler)
      }
    })()
    mod.setGlobalDispatcher(inst)
    observer = {
      uninstall() {
        try {
          mod.setGlobalDispatcher(previous)
        } catch {
          /* best effort */
        }
      },
    }
    report.dispatcher.installed = true
    return true
  }

  // ------------------------------------------------------------------
  // Waterfall listener: census every call, rewrite only probe calls.
  // ------------------------------------------------------------------
  ctx.on('llm/stream', (options, next) => {
    const store = als.getStore()
    report.waterfallShapes.push(shapeOf(options))
    if (store === undefined || store.probe === undefined) return next()

    const plan = store.probe
    const outcome = { tag: plan.tag, isFrozen: Object.isFrozen(options), mutated: false, mutationThrew: false, mutationError: null }
    if (plan.rewriteModel !== undefined || plan.rewriteProvider !== undefined) {
      try {
        if (plan.rewriteModel !== undefined) options.model = plan.rewriteModel
        if (plan.rewriteProvider !== undefined) options.provider = plan.rewriteProvider
        outcome.mutated = true
      } catch (error) {
        outcome.mutationThrew = true
        outcome.mutationError = safeText(error instanceof Error ? error.message : String(error), 200)
      }
    }
    report.probes[`mutation_${plan.tag}`] = outcome

    if (plan.secondNext === true) {
      const first = next()
      let second
      let secondError = null
      try {
        second = next()
      } catch (error) {
        secondError = safeText(error instanceof Error ? error.message : String(error), 200)
      }
      report.probes.P3_second_next = {
        threw: secondError !== null,
        secondError,
        sameReference: second !== undefined && second === first,
        returnedStream: second !== undefined && second !== null && typeof second[Symbol.asyncIterator] === 'function',
      }
      if (second !== undefined && second !== first && second !== null && typeof second.return === 'function') {
        void Promise.resolve(second.return(undefined)).catch(() => {})
      }
      return wrapStream(first, als, store)
    }

    const stream = next()
    if (stream === null || stream === undefined || typeof stream[Symbol.asyncIterator] !== 'function') {
      record(`stream_${plan.tag}`, { kind: 'not-async-iterable', got: typeof stream })
      return stream
    }
    return wrapStream(stream, als, store)
  })

  // ------------------------------------------------------------------
  // Session/event census (P2): event types and data key NAMES only.
  // ------------------------------------------------------------------
  try {
    ctx.on('session/event', (session, event) => {
      report.sessionEvents.push({
        type: safeText(event?.type, 60),
        sessionIdKind: typeof session?.id,
        dataKeys: event?.data !== null && typeof event?.data === 'object' ? Object.keys(event.data).slice(0, 12) : [],
      })
      if (report.sessionEvents.length > 400) report.sessionEvents.length = 400
    })
  } catch (error) {
    record('session_event_listener', { ok: false, error: safeText(String(error), 200) })
  }

  // ------------------------------------------------------------------
  // Runner
  // ------------------------------------------------------------------
  async function run() {
    await step('dispatcher_observer', async () => ({ installed: await installObserver() }))
    await step('P1_public_stream', callViaPublicStream)
    await step('P1_prepare_call', callViaPrepareCall)
    await step('P1c_provider_flow', callWithBogusProvider)
    await step('P3_second_next_call', callForSecondNext)
    await step('P4_settings_face', probeSettingsFace)

    report.conclusion = conclude(report)
    report.finishedAt = new Date().toISOString()
    writeReport(report)
    log.info('probe complete: %s', JSON.stringify(report.conclusion))
    return report
  }

  async function step(key, fn) {
    try {
      record(key, await fn())
    } catch (error) {
      record(key, { ok: false, error: safeText(error instanceof Error ? error.message : String(error), 300) })
    }
  }

  /** Public one-arg `llm.stream` path, model rewritten to the marker model. */
  async function callViaPublicStream() {
    const markerModel = `${baseModel}${marker}`
    const store = { probe: { tag: 'A', rewriteModel: markerModel } }
    const result = await pullUnder((signal) => als.run(store, () => llm.stream({
      provider: baseProvider,
      model: baseModel,
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 8,
      signal,
    })))
    return judgeMarkerCall(result, 'A', markerModel)
  }

  /** Registration-bound `prepareCall().stream()` path (official agent-loop shape). */
  async function callViaPrepareCall() {
    if (typeof llm.prepareCall !== 'function') return { skipped: 'runtime exposes no prepareCall' }
    const markerModel = `${baseModel}${marker}`
    const store = { probe: { tag: 'B', rewriteModel: markerModel } }
    const result = await pullUnder(async (signal) => {
      const prepared = await llm.prepareCall({ provider: baseProvider, model: baseModel }, signal)
      if (typeof prepared?.stream !== 'function') throw new Error('prepareCall returned no stream handle')
      const request = prepared.config !== null && typeof prepared.config === 'object'
        ? { ...prepared.config, messages: [{ role: 'user', content: 'ping' }], signal }
        : { messages: [{ role: 'user', content: 'ping' }], signal }
      return als.run(store, () => prepared.stream(request))
    })
    return {
      ...judgeMarkerCall(result, 'B', markerModel),
      waterfallSawCall: report.probes.mutation_B !== undefined,
    }
  }

  /** Provider field flow: rewrite to a provider id that cannot exist. */
  async function callWithBogusProvider() {
    const store = { probe: { tag: 'C', rewriteProvider: bogusProvider } }
    const result = await pullUnder((signal) => als.run(store, () => llm.stream({
      provider: baseProvider,
      model: baseModel,
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 8,
      signal,
    })))
    const outbound = report.dispatcher.observations.filter((o) => o.tag === 'C')
    // If the rewrite did NOT flow, the call proceeds on the ORIGINAL provider and an
    // outbound request appears; a failure with zero outbound requests means the
    // rewritten (bogus) provider id reached the harness resolver.
    const harnessReadProvider = !result.ok && outbound.length === 0
    return {
      callError: result.errorSummary ?? null,
      errorKind: result.errorKind ?? null,
      outboundRequests: outbound.length,
      harnessReadProvider,
      note: harnessReadProvider
        ? 'call failed before any HTTP request — the rewritten provider id reached the harness resolver'
        : 'inconclusive — inspect callError and dispatcher observations',
    }
  }

  /** Throwaway call dedicated to the second-next experiment. */
  async function callForSecondNext() {
    const store = { probe: { tag: 'D', secondNext: true } }
    const result = await pullUnder((signal) => als.run(store, () => llm.stream({
      provider: baseProvider,
      model: baseModel,
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 8,
      signal,
    })))
    return { callOk: result.ok === true, errorSummary: result.errorSummary ?? null }
  }

  /** P4: settings service face — method names only, never values. */
  async function probeSettingsFace() {
    const settings = ctx.get('settings')
    if (settings === undefined || settings === null) return { present: false }
    const names = new Set()
    for (let obj = settings; obj !== null && obj !== undefined; obj = Object.getPrototypeOf(obj)) {
      for (const key of Object.getOwnPropertyNames(obj)) {
        try {
          if (typeof settings[key] === 'function') names.add(key)
        } catch {
          /* getter may throw; ignore */
        }
      }
      if (obj === Object.prototype) break
    }
    const face = { present: true, methodNames: [...names].sort() }
    if (typeof settings.describe === 'function') {
      try {
        const described = await settings.describe()
        face.describeOk = true
        face.describeTopLevelKeys = described !== null && typeof described === 'object' ? Object.keys(described).slice(0, 30) : []
      } catch (error) {
        face.describeOk = false
        face.describeError = safeText(String(error), 200)
      }
    }
    return face
  }

  // ------------------------------------------------------------------
  // Stream pull under timeout (abort signal passed into the call);
  // classifies failure origin.
  // ------------------------------------------------------------------
  async function pullUnder(call) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const stream = await call(controller.signal)
      const chunks = []
      for await (const chunk of stream) {
        chunks.push({ type: chunk?.type, hasUsage: chunk?.usage !== undefined })
        if (chunks.length >= 3) break
      }
      return { ok: true, chunks: chunks.length, apiResponded: chunks.length > 0 }
    } catch (error) {
      if (controller.signal.aborted) {
        return { ok: false, errorKind: 'timeout', apiResponded: false, errorSummary: `probe timeout after ${timeoutMs}ms` }
      }
      return classifyCallError(error)
    } finally {
      clearTimeout(timer)
    }
  }

  function judgeMarkerCall(result, tag, markerModel) {
    const obs = report.dispatcher.observations.filter((o) => o.tag === tag)
    const bodyModelSeen = obs.find((o) => typeof o.bodyModel === 'string' && o.bodyModel.includes(marker))?.bodyModel
    const apiEcho = result.errorKind === 'api' && typeof result.errorSummary === 'string' && result.errorSummary.includes(marker)
    return {
      callOk: result.ok === true,
      apiResponded: result.apiResponded === true,
      errorKind: result.errorKind ?? null,
      errorSummary: result.errorSummary ?? null,
      markerModel,
      outboundRequests: obs.length,
      bodyModelSeen: bodyModelSeen ?? null,
      markerFlow: bodyModelSeen !== undefined || apiEcho,
      note: bodyModelSeen !== undefined
        ? 'dispatcher saw the marker model in the outbound body — waterfall rewrite FLOWED'
        : apiEcho
          ? 'API error echoes the marker model — rewrite FLOWED (round-trip proof)'
          : result.ok === true
            ? 'call succeeded but dispatcher saw no marker — rewrite likely IGNORED (check observations)'
            : 'call failed without marker evidence — inspect errorSummary',
    }
  }

  const dispose = () => {
    if (observer) observer.uninstall()
  }
  return { run, dispose, report }
}

// ----------------------------------------------------------------------
// Verdicts
// ----------------------------------------------------------------------

function conclude(report) {
  const mutationOf = (tag) => report.probes[`mutation_${tag}`] ?? {}
  const pub = report.probes.P1_public_stream ?? {}
  const prep = report.probes.P1_prepare_call ?? {}
  const providerFlow = report.probes.P1c_provider_flow ?? {}

  const pubProof = pub.markerFlow === true
  const prepProof = prep.markerFlow === true
  const frozenHit = mutationOf('A').isFrozen === true || mutationOf('B').isFrozen === true
  const threwHit = mutationOf('A').mutationThrew === true || mutationOf('B').mutationThrew === true

  let backend = 'unknown'
  const notes = []
  if (pubProof && prepProof) {
    backend = 'waterfall'
    notes.push('model rewrite flowed on BOTH the public stream and the prepareCall path')
  } else if (pubProof && !prepProof) {
    backend = 'waterfall-public-only'
    notes.push('rewrite flowed on the public path only; agent-loop traffic needs the dispatcher backend')
  } else if (prepProof && !pubProof) {
    backend = 'waterfall-prepare-only'
    notes.push('rewrite flowed on the prepareCall path only')
  } else if (frozenHit || threwHit) {
    backend = 'dispatcher'
    notes.push('waterfall options resisted or ignored mutation — enforce routing at the undici dispatcher layer')
  } else if (pubMutationNoProof(mutationOf, pub, prep)) {
    backend = 'inconclusive'
    notes.push('mutation did not throw but no marker proof — inspect dispatcher observations manually')
  }
  if (providerFlow.harnessReadProvider === true && backend === 'waterfall') {
    notes.push('provider field also flows — full (provider, model) rewrite confirmed')
  }
  if (report.dispatcher.installed !== true) {
    notes.push('dispatcher observer unavailable — marker flow could not be observed at the HTTP layer')
  }
  return { rewriteBackend: backend, notes, providerFlow: providerFlow.harnessReadProvider === true }
}

function pubMutationNoProof(mutationOf, pub, prep) {
  const a = mutationOf('A')
  const b = mutationOf('B')
  const mutatedSomewhere = a.mutated === true || b.mutated === true
  return mutatedSomewhere === true && pub.markerFlow !== true && prep.markerFlow !== true
}

function classifyCallError(error) {
  const raw = error instanceof Error ? error.message : String(error)
  const text = raw.toLowerCase()
  const network = /econnrefused|enotfound|econnreset|etimedout|epipe|fetch failed|socket|network/.test(text)
  const frozen = /frozen|read only|not extensible|cannot add|cannot assign/.test(text)
  const errorKind = /429|rate.?limit/.test(text)
    ? 'rate_limited'
    : /401|403|unauthorized|api key|forbidden|authentication/.test(text)
      ? 'auth'
      : frozen
        ? 'frozen'
        : /unknown provider|provider.*(not|cannot).*(found|resolved|configur)/.test(text)
          ? 'harness'
          : network ? 'network' : 'api'
  return {
    ok: false,
    errorKind,
    apiResponded: !network,
    errorSummary: safeText(raw, 300),
  }
}

// ----------------------------------------------------------------------
// Small helpers
// ----------------------------------------------------------------------

function shapeOf(options) {
  if (options === undefined || options === null) return { kind: typeof options }
  const interesting = {}
  for (const key of ['provider', 'model', 'messages', 'tools', 'session', 'sessionId', 'agent', 'subagent', 'caller', 'source', 'system']) {
    if (key in options) interesting[key] = typeof options[key]
  }
  return { kind: 'object', isFrozen: Object.isFrozen(options), keys: Object.keys(options).slice(0, 24), interesting }
}

function wrapStream(iterable, als, store) {
  return {
    [Symbol.asyncIterator]() {
      const inner = iterable[Symbol.asyncIterator]()
      const run = (method, arg) => als.run(store, () => inner[method](arg))
      return {
        next: (value) => run('next', value),
        return: (value) => (inner.return === undefined ? Promise.resolve({ done: true, value }) : run('return', value)),
        throw: (error) => (inner.throw === undefined ? Promise.reject(error) : run('throw', error)),
        [Symbol.asyncIterator]() {
          return this
        },
      }
    },
  }
}

function wrapHandler(handler, record) {
  const wrapped = {}
  for (const key of ['onConnect', 'onHeaders', 'onData', 'onComplete', 'onError']) {
    const fn = handler[key]
    if (typeof fn !== 'function') continue
    wrapped[key] = (...args) => {
      if (key === 'onHeaders') record('status', { status: args[0] })
      if (key === 'onError') record('error', { message: safeText(String(args[0]), 200) })
      return fn.apply(handler, args)
    }
  }
  return wrapped
}

function safeText(value, max) {
  const text = value === undefined || value === null ? '' : String(value)
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function bodyModelOf(body) {
  if (body === undefined || body === null) return undefined
  if (typeof body !== 'string') return `(${typeof body})`
  try {
    const parsed = JSON.parse(body)
    return typeof parsed?.model === 'string' ? parsed.model : undefined
  } catch {
    return undefined
  }
}

function authFingerprintOf(headers) {
  let auth = null
  if (headers !== undefined && headers !== null) {
    if (typeof headers.get === 'function') auth = headers.get('authorization') ?? headers.get('x-api-key')
    else if (typeof headers === 'object') auth = headers.authorization ?? headers['x-api-key'] ?? headers.Authorization
  }
  if (typeof auth !== 'string' || auth === '') return null
  return `${auth.slice(0, 4)}…(${auth.length})`
}

export function reportDir() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return process.env.UMBRA_PROBE_STATE ?? join(home, 'umbra-probe')
}

function writeReport(report) {
  try {
    const dir = reportDir()
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  } catch {
    /* diagnostics are best effort */
  }
}

/**
 * Cordis apply — wire the probe to the live services and run once.
 */
export async function apply(ctx, config) {
  const log = ctx.logger('umbra-probe')
  let probe = null
  ctx.inject(['llm'], async (scope) => {
    const llm = scope.get('llm')
    let undici
    try {
      undici = await import('undici')
    } catch {
      undici = undefined
    }
    probe = createProbe({ ctx, llm, config, undici })
    if (config?.autoRun !== false) await probe.run()
  })
  ctx.effect(() => () => {
    probe?.dispose()
    log.info('umbra-rewrite-probe disposed')
  })
}

export default { name, inject, apply }
