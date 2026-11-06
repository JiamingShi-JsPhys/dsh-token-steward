/**
 * Host-half end-to-end contract tests: the FULL routing stack (waterfall
 * router → ALS → umbra dispatcher → fake undici previous) against a fake
 * harness that mirrors the documented DSH surfaces.
 *
 * Proves: mode-driven target selection, waterfall in-place rewrite (mutable
 * backend), dispatcher B-track rewrite (frozen backend), transparent failover
 * with ledger/journal/health bookkeeping, fail-open behaviour.
 *
 * @module tests/host-e2e.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { ModelHealth } from '../src/core/health.ts'
import { UsageLedger } from '../src/core/ledger.ts'
import { normalizePool } from '../src/core/pool.ts'
import type { ModelPool, PoolModel } from '../src/core/types.ts'
import { createUmbraDispatcher } from '../src/host/dispatcher.ts'
import type { GenerateOptionsLike, StreamChunkLike } from '../src/host/dsh-face.ts'
import { RouteJournal } from '../src/host/journal.ts'
import { createRouter } from '../src/host/router.ts'
import { ResponseCache, type ResponseCacheFacade } from '../src/host/response-cache.ts'
import { SignalHub } from '../src/host/signals.ts'
import type { UmbraAls } from '../src/host/store.ts'

// ----------------------------------------------------------------------
// fake harness
// ----------------------------------------------------------------------

interface RecordedRequest {
  origin: string
  path: string
  authorization: string | undefined
  bodyModel: string | undefined
}

interface FailRule {
  message: string
  signal429?: boolean
  retryAfter?: string
}

function makeLogger() {
  return { info: () => {}, warn: () => {}, error: () => {} }
}

function buildHarness(options: { doc: unknown; failRules?: Record<string, FailRule>; freezeOptions?: boolean; cache?: ResponseCacheFacade }) {
  const env = { SCHOOL_MIRROR_KEY: 'sk-school-secret-123' }
  const normalized = normalizePool(options.doc, env)
  assert.ok(normalized.pool !== undefined, 'test pool must normalize')

  const als: UmbraAls = new AsyncLocalStorage()
  const health = new Map<string, ModelHealth>()
  const journal = new RouteJournal(50)
  const signalHub = new SignalHub()
  const ledger = new UsageLedger()
  let frozenHits = 0

  for (const model of normalized.pool.models) {
    health.set(model.id, new ModelHealth({ cooldownMs: 30_000, rateLimitMs: 60_000 }))
  }

  const records: RecordedRequest[] = []
  const failRules = options.failRules ?? {}
  const fakeUndici = makeFakeUndici(records, failRules)

  const stateRef: { pool: ModelPool | undefined } = { pool: normalized.pool }
  const router = createRouter({
    als,
    log: makeLogger(),
    llmLookup: () => llmFacade,
    getState: () => ({ pool: stateRef.pool, health, ledger, journal, signals: signalHub, cache: options.cache }),
    onFrozenOptions: () => {
      frozenHits += 1
    },
  })

  // wire the umbra dispatcher onto the fake undici module
  const previous = fakeUndici.getGlobalDispatcher()
  const umbra = createUmbraDispatcher({
    als,
    previous,
    undici: fakeUndici.module as unknown as Parameters<typeof createUmbraDispatcher>[0]['undici'],
    modelOf: (modelId) => stateRef.pool?.models.find((model: PoolModel) => model.id === modelId),
    onObservation: (observation) => signalHub.noteObservation(observation),
    onSignal: (modelId, signal) => signalHub.noteSignal(modelId, signal),
  })
  fakeUndici.setGlobalDispatcher(umbra)

  // fake llm: waterfall + lazy adapter dispatch through the CURRENT global dispatcher
  const listeners: Array<(options: GenerateOptionsLike, next: () => AsyncIterable<StreamChunkLike>) => unknown> = [router.route as never]

  function runWaterfall(callOptions: GenerateOptionsLike, final: () => AsyncIterable<StreamChunkLike>): AsyncIterable<StreamChunkLike> {
    const dispatchAt = (index: number): AsyncIterable<StreamChunkLike> =>
      index >= listeners.length ? final() : (listeners[index]!(callOptions, () => dispatchAt(index + 1)) as AsyncIterable<StreamChunkLike>)
    return dispatchAt(0)
  }

  const llmFacade = {
    stream(callOptions: GenerateOptionsLike): AsyncIterable<StreamChunkLike> {
      const live = callOptions
      const seen = options.freezeOptions === true ? Object.freeze({ ...callOptions }) : callOptions
      let started = false
      let pulled = 0
      const adapterStream: AsyncIterable<StreamChunkLike> = {
        [Symbol.asyncIterator]: () => ({
          next: async (): Promise<IteratorResult<StreamChunkLike>> => {
            if (!started) {
              started = true
              // HTTP fires at first pull — inside the router's ALS store
              await (fakeUndici.getGlobalDispatcher() as { dispatch(options: unknown, handler: unknown): Promise<void> }).dispatch(
                {
                  origin: endpointOf(live.provider),
                  path: '/v1/chat/completions',
                  method: 'POST',
                  headers: { authorization: 'Bearer sk-harness-original' },
                  body: JSON.stringify({ model: live.model, messages: [] }),
                },
                fakeHandler(),
              )
            }
            if (pulled === 0) {
              pulled += 1
              return { done: false, value: { type: 'text-delta', text: 'ok' } }
            }
            if (pulled === 1) {
              pulled += 1
              return { done: false, value: { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, reasoningTokens: 5 } } }
            }
            return { done: true, value: { type: 'finish', reason: 'stop' } }
          },
        }),
      }
      return runWaterfall(seen, () => adapterStream)
    },
  }

  function fakeHandler() {
    return {
      onConnect: () => {},
      onHeaders: () => {},
      onData: () => {},
      onComplete: () => {},
      onError: () => {},
    }
  }

  function endpointOf(provider: string | undefined): string {
    if (provider === 'school') return 'https://school-mirror.test/v1'
    return 'https://api.deepseek.test/v1'
  }

  return {
    pool: normalized.pool,
    als,
    health,
    journal,
    ledger,
    signalHub,
    records,
    llmFacade,
    stateRef,
    frozenHits: () => frozenHits,
  }
}

function makeFakeUndici(records: RecordedRequest[], failRules: Record<string, FailRule>) {
  class Dispatcher {}
  class ProxyAgent {
    dispatch(): void {}
    close(): Promise<void> { return Promise.resolve() }
  }
  const previous = {
    dispatch(options: Record<string, unknown>, handler: Record<string, ((...args: never[]) => unknown) | undefined>): Promise<void> {
      let authorization: string | undefined
      const rawHeaders = options.headers
      if (Array.isArray(rawHeaders)) {
        for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
          if (String(rawHeaders[index]).toLowerCase() === 'authorization') authorization = String(rawHeaders[index + 1])
        }
      } else if (rawHeaders !== null && typeof rawHeaders === 'object') {
        const record = rawHeaders as Record<string, unknown>
        authorization = typeof record.authorization === 'string' ? record.authorization : undefined
      }
      let bodyModel: string | undefined
      try {
        bodyModel = (JSON.parse(String(options.body)) as { model?: string }).model
      } catch {
        bodyModel = undefined
      }
      records.push({ origin: String(options.origin), path: String(options.path), authorization, bodyModel })
      const rule = bodyModel !== undefined ? failRules[bodyModel] : undefined
      const calls = handler as unknown as { onHeaders?: (...a: unknown[]) => void; onError?: (...a: unknown[]) => void; onConnect?: (...a: unknown[]) => void; onData?: (...a: unknown[]) => void; onComplete?: (...a: unknown[]) => void }
      if (rule !== undefined) {
        if (rule.signal429 === true) {
          calls.onHeaders?.(429, rule.retryAfter !== undefined ? ['retry-after', rule.retryAfter] : [], () => {}, 'Too Many Requests')
        }
        const error = new Error(rule.message)
        calls.onError?.(error)
        throw error
      }
      calls.onConnect?.(() => {})
      calls.onHeaders?.(200, [], () => {}, 'OK')
      calls.onData?.(Buffer.from('{}'))
      calls.onComplete?.({})
      return Promise.resolve()
    },
  }
  let current: unknown = previous
  return {
    module: {
      Dispatcher,
      ProxyAgent,
      getGlobalDispatcher: () => current,
      setGlobalDispatcher: (value: unknown) => {
        current = value
      },
    },
    getGlobalDispatcher: () => current,
    setGlobalDispatcher: (value: unknown) => {
      current = value
    },
  }
}

// ----------------------------------------------------------------------
// pools
// ----------------------------------------------------------------------

function matrixDoc(): Record<string, unknown> {
  return {
    version: 1,
    providers: {
      school: {
        models: {
          'glm-flash': {
            tags: { capabilities: ['fast', 'coding', 'tool_use'], cost_level: 'free', context_window: 128_000 },
            endpoint: 'https://school-mirror.test/v1',
            api_key_ref: 'env:SCHOOL_MIRROR_KEY',
          },
        },
      },
      deepseek: {
        models: {
          'deepseek-chat': {
            tags: { capabilities: ['coding', 'fast', 'tool_use'], cost_level: 'low', context_window: 131_072 },
          },
          'deepseek-reasoner': {
            tags: { capabilities: ['coding', 'tool_use', 'reasoning'], cost_level: 'medium', context_window: 131_072 },
          },
        },
      },
    },
  }
}

async function consume(stream: AsyncIterable<StreamChunkLike>): Promise<StreamChunkLike[]> {
  const chunks: StreamChunkLike[] = []
  for await (const chunk of stream) {
    chunks.push(chunk)
  }
  return chunks
}

// ----------------------------------------------------------------------
// scenarios
// ----------------------------------------------------------------------

test('mutable backend: frugal mode routes to the free B-track model and rewrites the wire', async () => {
  const harness = buildHarness({ doc: matrixDoc() })
  const stream = harness.llmFacade.stream({
    provider: 'deepseek',
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'hello' }],
  })
  const chunks = await consume(stream)
  assert.equal(chunks.length, 2, 'text-delta + usage (done value is not yielded)')
  assert.equal(chunks[0]?.type, 'text-delta')

  // frugal → free model first; the waterfall rewrote (provider, model) in place
  const first = harness.records[0]
  assert.equal(first?.origin, 'https://school-mirror.test', 'dispatch went to the free model origin (endpoint path lives in :path)')
  assert.equal(first?.bodyModel, 'glm-flash')
  assert.equal(first?.authorization, 'Bearer sk-school-secret-123', 'B-track auth header was injected')

  // ledger folded the usage under the routed model
  const today = harness.ledger.todayTotals(new Date())
  assert.equal(today.inputTokens, 100)
  assert.equal(today.calls, 1)
  assert.equal(harness.journal.recent(1)[0]?.chosen, 'school/glm-flash')
})

test('frozen backend: options resist mutation — the dispatcher enforces the route at the wire', async () => {
  const harness = buildHarness({ doc: matrixDoc(), freezeOptions: true })
  const stream = harness.llmFacade.stream({
    provider: 'deepseek',
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'hello' }],
  })
  const chunks = await consume(stream)
  assert.equal(chunks[0]?.type, 'text-delta')
  assert.ok(harness.frozenHits() >= 1, 'frozen options were detected')

  // the harness sent the ORIGINAL request, but the dispatcher rewrote it onto the matrix target
  const first = harness.records[0]
  assert.equal(first?.origin, 'https://school-mirror.test')
  assert.equal(first?.bodyModel, 'glm-flash')
  assert.equal(first?.authorization, 'Bearer sk-school-secret-123')
  assert.equal(harness.signalHub.backendVerdict(), 'dispatcher')
})

test('failover: pre-first-chunk failures walk the candidate chain transparently', async () => {
  const harness = buildHarness({
    doc: matrixDoc(),
    failRules: {
      'glm-flash': { message: 'ECONNRESET mirror is down' },
      'deepseek-chat': { message: 'HTTP 429 Too Many Requests', signal429: true, retryAfter: '30' },
    },
  })
  const stream = harness.llmFacade.stream({
    provider: 'deepseek',
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'hello' }],
  })
  const chunks = await consume(stream)
  assert.equal(chunks[0]?.type, 'text-delta', 'the consumer sees the SUCCESSFUL retry output')
  assert.equal(harness.records.length, 3, 'three attempts: glm-flash, deepseek-chat, deepseek-reasoner')

  const decision = harness.journal.recent(1)[0]
  assert.equal(decision?.fallbacks, 2)
  assert.equal(decision?.finalModel, 'deepseek/deepseek-reasoner')
  assert.equal(decision?.fallbackOf, 'deepseek/deepseek-chat')

  // usage folded under the model that actually served the call
  assert.equal(harness.ledger.todayTotals(new Date()).inputTokens, 100)
  // health recorded the two failures
  assert.equal(harness.health.get('school/glm-flash')?.snapshot().failures, 1)
  assert.equal(harness.health.get('deepseek/deepseek-chat')?.snapshot().failures, 1)
  assert.equal(harness.health.get('deepseek/deepseek-reasoner')?.snapshot().failures, 0)
})

test('fail-open: no eligible candidate → original destination, still observed', async () => {
  const harness = buildHarness({ doc: matrixDoc() })
  const emptied = matrixDoc()
  const providers = emptied.providers as Record<string, Record<string, unknown>>
  providers.deepseek!.models = {}
  providers.school!.models = {}
  const rebuilt = normalizePool(emptied, {})
  assert.ok(rebuilt.pool !== undefined)
  harness.stateRef.pool = { ...rebuilt.pool!, policy: { ...rebuilt.pool!.policy, mode: 'frugal' } }

  const stream = harness.llmFacade.stream({
    provider: 'deepseek',
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'hello' }],
  })
  const chunks = await consume(stream)
  assert.equal(chunks.length, 2)
  const first = harness.records[0]
  assert.equal(first?.origin, 'https://api.deepseek.test/v1', 'went to the ORIGINAL endpoint')
  assert.equal(first?.bodyModel, 'deepseek-chat', 'with the ORIGINAL model')
  assert.equal(harness.journal.recent(1)[0]?.reason.includes('fail-open'), true)
})

test('retry-after hint from the wire is consumed on rate-limit failures', async () => {
  const harness = buildHarness({
    doc: matrixDoc(),
    failRules: {
      'glm-flash': { message: 'HTTP 429 rate limited', signal429: true, retryAfter: '120' },
    },
  })
  const stream = harness.llmFacade.stream({
    provider: 'deepseek',
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'hello' }],
  })
  await consume(stream)
  // glm-flash failed once with Retry-After=120s; one failure does not cool it yet,
  // but the wire-signal path (onHeaders 429 → SignalHub → takeRetryAfter) ran.
  const glm = harness.health.get('school/glm-flash')?.snapshot()
  assert.equal(glm?.failures, 1)
  assert.equal(glm?.status, 'healthy')
})

test('exact-match cache: identical trivial call replays without a second dispatch', async () => {
  const cache = new ResponseCache()
  const harness = buildHarness({ doc: matrixDoc(), cache })
  harness.stateRef.pool = {
    ...harness.stateRef.pool!,
    policy: { ...harness.stateRef.pool!.policy, cache: { exactMatch: true } },
  }

  const prompt = { provider: 'deepseek', model: 'deepseek-chat', messages: [{ role: 'user', content: 'ping' }] }
  const first = await consume(harness.llmFacade.stream({ ...prompt }))
  const second = await consume(harness.llmFacade.stream({ ...prompt }))

  assert.equal(harness.records.length, 1, 'the second call never left the process')
  assert.deepEqual(second, first, 'replayed chunks are byte-identical')
  const reasons = harness.journal.recent(2).map((d) => d.reason)
  assert.ok(reasons.some((reason) => reason.includes('精确缓存命中')), JSON.stringify(reasons))
  // only ONE ledger charge — the cache hit billed nothing
  assert.equal(harness.ledger.todayTotals(new Date()).calls, 1)
  assert.equal(cache.stats().hits, 1)
})

test('exact-match cache: distinct prompts miss and dispatch normally', async () => {
  const cache = new ResponseCache()
  const harness = buildHarness({ doc: matrixDoc(), cache })
  harness.stateRef.pool = {
    ...harness.stateRef.pool!,
    policy: { ...harness.stateRef.pool!.policy, cache: { exactMatch: true } },
  }

  await consume(harness.llmFacade.stream({ provider: 'deepseek', model: 'deepseek-chat', messages: [{ role: 'user', content: 'one' }] }))
  await consume(harness.llmFacade.stream({ provider: 'deepseek', model: 'deepseek-chat', messages: [{ role: 'user', content: 'two' }] }))
  assert.equal(harness.records.length, 2, 'distinct prompts both reached the wire')
  assert.equal(cache.stats().hits, 0)
  assert.equal(cache.stats().misses, 2)
})
