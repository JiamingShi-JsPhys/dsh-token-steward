/**
 * Contract tests for the M0 rewrite probe, against a fake harness that mirrors
 * the documented DSH/cordis surfaces:
 *
 *   - `ctx.on('llm/stream', (options, next) => …)` waterfall, listeners chained in
 *     registration order, payload passed by reference;
 *   - public single-arg `llm.stream(options)` AND registration-bound
 *     `prepareCall(config, signal).stream(request)`;
 *   - the HTTP request fires lazily at the FIRST PULL of the returned stream
 *     (provider-proxy's documented adapter behaviour);
 *   - an undici-shaped global dispatcher below the adapter.
 *
 * The fake cannot prove what the REAL harness does — that is the probe's job in a
 * live DSH (see README). What it proves: the probe's mutation/observation/verdict
 * logic behaves correctly under each of the three conceivable waterfall semantics
 * (mutable payload, frozen payload, silently-cloned payload).
 *
 * @module test/probe.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { createProbe } from '../index.js'

const MARKER = '__STEWARD_PROBE__'
const BASE_PROVIDER = 'deepseek'
const BASE_MODEL = 'deepseek-chat'
const BOGUS_PROVIDER = '__steward_nonexistent_provider__'

// ----------------------------------------------------------------------
// Fake harness pieces
// ----------------------------------------------------------------------

function makeLogger() {
  return { info: () => {}, warn: () => {}, error: () => {} }
}

function makeCtx({ settings } = {}) {
  const listeners = new Map()
  const services = new Map()
  const effects = []
  if (settings !== undefined) services.set('settings', settings)
  return {
    on(event, fn) {
      const list = listeners.get(event) ?? []
      list.push(fn)
      listeners.set(event, list)
      return () => {}
    },
    get(name) {
      return services.get(name)
    },
    logger: () => makeLogger(),
    effect(fn) {
      effects.push(fn)
    },
    inject(_deps, cb) {
      cb(makeCtxLikeScope(services))
    },
    __listeners: listeners,
    __effects: effects,
  }
}

function makeCtxLikeScope(services) {
  return { get: (name) => services.get(name) }
}

/** Fake undici module with a swappable global dispatcher. */
function makeFakeUndici() {
  const outbound = []
  class Dispatcher {}
  const previous = {
    dispatch(options, handler) {
      outbound.push({ origin: String(options.origin), path: String(options.path), body: options.body })
      handler.onConnect?.(() => {})
      handler.onHeaders?.(200, [], () => {}, 'OK')
      handler.onData?.(Buffer.from('{}'))
      handler.onComplete?.({})
      return Promise.resolve()
    },
  }
  let current = previous
  return {
    Dispatcher,
    outbound,
    getGlobalDispatcher: () => current,
    setGlobalDispatcher: (d) => {
      current = d
    },
  }
}

/**
 * Fake llm runtime.
 *
 * `waterfallMode`:
 *   - 'mutable': listeners get the live options object; the adapter reads it at
 *     dispatch time → a listener mutation flows (best case).
 *   - 'frozen': options are Object.freeze'd (provider-proxy's "deep-frozen loop
 *     requests") → mutation THROWS in strict mode.
 *   - 'cloned': listeners receive a shallow COPY; the adapter reads the original →
 *     mutation lands on the copy and is silently lost (worst case, hardest to see).
 */
function makeFakeLlm(ctx, fakeUndici, { waterfallMode = 'mutable', endpoints } = {}) {
  const routeTable = endpoints ?? { [BASE_PROVIDER]: 'https://api.deepseek.test/v1' }
  const runWaterfall = (options, final) => {
    const list = ctx.__listeners.get('llm/stream') ?? []
    const dispatchAt = (i) => (i >= list.length ? final(options) : list[i](options, () => dispatchAt(i + 1)))
    return dispatchAt(0)
  }
  const adapterStream = (options) => {
    let started = false
    return {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            if (!started) {
              started = true
              // The HTTP request fires here, at first pull — the ALS store set by
              // the probe's stream wrapper is visible to the dispatcher observer.
              if (!(options.provider in routeTable)) {
                throw new Error(`unknown provider: ${options.provider}`)
              }
              const handler = {
                onConnect: () => {},
                onHeaders: () => {},
                onData: () => {},
                onComplete: () => {},
              }
              await fakeUndici.getGlobalDispatcher().dispatch(
                {
                  origin: routeTable[options.provider],
                  path: '/v1/chat/completions',
                  method: 'POST',
                  headers: { authorization: 'Bearer sk-fake-1234567890' },
                  body: JSON.stringify({ model: options.model, messages: options.messages ?? [] }),
                },
                handler,
              )
            }
            if (pulled === 0) {
              pulled += 1
              return { done: false, value: { type: 'text-delta', text: 'pong' } }
            }
            if (pulled === 1) {
              pulled += 1
              return { done: false, value: { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 } } }
            }
            return { done: true, value: { type: 'finish', reason: 'stop' } }
          },
        }
      },
    }
  }
  let pulled = 0
  const resetPulled = () => {
    pulled = 0
  }

  const shape = (options) => {
    if (waterfallMode === 'frozen') {
      const frozen = Object.freeze({ ...options })
      return frozen
    }
    if (waterfallMode === 'cloned') return { ...options }
    return options
  }

  return {
    // Public one-arg convenience (documented as an instance property plugins may wrap).
    stream(options) {
      resetPulled()
      const live = options
      const seen = shape(live)
      return runWaterfall(seen, (final) => adapterStream(waterfallMode === 'mutable' ? final : live))
    },
    // Registration-bound path used by the official agent loop.
    async prepareCall(config, _signal) {
      const preparedConfig = Object.freeze({ ...config })
      return {
        config: preparedConfig,
        stream(request) {
          resetPulled()
          const merged = { ...preparedConfig, ...request }
          const seen = shape(merged)
          return runWaterfall(seen, (final) => adapterStream(waterfallMode === 'mutable' ? final : merged))
        },
      }
    },
  }
}

const PROBE_CONFIG = {
  provider: BASE_PROVIDER,
  model: BASE_MODEL,
  marker: MARKER,
  probeProvider: BOGUS_PROVIDER,
  timeoutMs: 5000,
}

async function runProbe({ waterfallMode, settings } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'steward-probe-'))
  process.env.STEWARD_PROBE_STATE = stateDir
  const fakeUndici = makeFakeUndici()
  const ctx = makeCtx({ settings })
  const llm = makeFakeLlm(ctx, fakeUndici, { waterfallMode })
  const probe = createProbe({ ctx, llm, config: PROBE_CONFIG, undici: fakeUndici })
  const report = await probe.run()
  probe.dispose()
  return { report, fakeUndici, stateDir }
}

// ----------------------------------------------------------------------
// Scenarios
// ----------------------------------------------------------------------

test('mutable waterfall semantics: rewrite flows on both dispatch paths → backend "waterfall"', async () => {
  const { report, fakeUndici } = await runProbe({ waterfallMode: 'mutable' })

  const pub = report.probes.P1_public_stream
  assert.equal(pub.markerFlow, true, `public path marker flow, got: ${JSON.stringify(pub)}`)
  assert.ok(pub.bodyModelSeen?.includes(MARKER), 'dispatcher saw the marker model in the outbound body')
  assert.equal(pub.outboundRequests >= 1, true)

  const prep = report.probes.P1_prepare_call
  assert.equal(prep.markerFlow, true, `prepareCall path marker flow, got: ${JSON.stringify(prep)}`)
  assert.equal(prep.waterfallSawCall, true, 'the llm/stream waterfall also sees prepareCall-path calls')

  assert.equal(report.probes.P1c_provider_flow.harnessReadProvider, true, 'bogus provider failed before any HTTP request')

  const p3 = report.probes.P3_second_next
  assert.equal(p3.threw, false, 'second next() call did not throw')
  assert.equal(p3.returnedStream, true, 'second next() call returned another stream')

  assert.equal(report.probes.P4_settings_face.present, false)

  assert.equal(report.conclusion.rewriteBackend, 'waterfall', JSON.stringify(report.conclusion))
  assert.equal(report.conclusion.providerFlow, true)

  // The dispatcher observer recorded requests with an auth fingerprint (no secret).
  const tagged = fakeUndici.outbound.filter(() => true)
  assert.equal(tagged.length >= 3, true, 'at least three outbound requests happened (A, B, D plans)')
  assert.ok(report.dispatcher.observations.every((o) => {
    const fp = o.authFingerprint
    return fp === null || fp === undefined || !fp.includes('sk-fake-1234567890')
  }), 'auth fingerprints never contain the raw secret')
})

test('frozen waterfall semantics (deep-frozen loop requests): mutation throws → backend "dispatcher"', async () => {
  const { report } = await runProbe({ waterfallMode: 'frozen' })

  const mutA = report.probes.mutation_A
  assert.equal(mutA.isFrozen, true)
  assert.equal(mutA.mutationThrew, true)
  assert.equal(report.probes.P1_public_stream.markerFlow, false, 'marker never reached the outbound request')

  assert.equal(report.conclusion.rewriteBackend, 'dispatcher', JSON.stringify(report.conclusion))
})

test('silently-cloned waterfall semantics: mutation lands on a copy → backend "inconclusive"', async () => {
  const { report } = await runProbe({ waterfallMode: 'cloned' })

  const mutA = report.probes.mutation_A
  assert.equal(mutA.mutated, true, 'assignment did not throw on the clone')
  assert.equal(mutA.mutationThrew, false)
  assert.equal(report.probes.P1_public_stream.markerFlow, false, 'but the marker never reached the wire')

  assert.equal(report.conclusion.rewriteBackend, 'inconclusive', JSON.stringify(report.conclusion))
})

test('report file is written, parses, and carries the schema kind', async () => {
  const { stateDir } = await runProbe({ waterfallMode: 'mutable' })
  const raw = readFileSync(join(stateDir, 'report.json'), 'utf8')
  const parsed = JSON.parse(raw)
  assert.equal(parsed.kind, 'token-steward-rewrite-probe/1')
  assert.ok(Array.isArray(parsed.waterfallShapes))
  assert.ok(parsed.waterfallShapes.length >= 4, 'a shape census entry exists for every probe call')
  assert.ok(typeof parsed.conclusion.rewriteBackend === 'string')
})
