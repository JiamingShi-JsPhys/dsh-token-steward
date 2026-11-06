/**
 * The routing engine — L1 of the interception stack.
 *
 * A `llm/stream` waterfall listener that, for every model call:
 *
 *   1. fingerprints the request (read-only; deep-frozen options are safe),
 *   2. classifies it and builds the mode-ordered candidate chain,
 *   3. mutates `options.{provider, model}` in place when the target differs —
 *      a TypeError (deep-frozen options) is caught and surfaced as a backend
 *      signal; the dispatcher layer then enforces the route at the wire,
 *   4. calls the waterfall `next()` synchronously (the waterfall contract) and
 *      hands the stream to a `FailoverStream` that owns the candidate walk:
 *      a failure BEFORE the first content chunk transparently re-dispatches
 *      the next candidate through the llm service under an ALS reentry store
 *      (the router never re-routes its own retry); a failure after content
 *      has flowed is rethrown — output is never duplicated.
 *
 * When the matrix offers no eligible candidate the call fails OPEN to its
 * original destination — the harness keeps working even with a broken pool.
 *
 * @module host/router
 */
import { classify, fingerprintOf } from '../core/classify.ts'
import type { UsageLedger } from '../core/ledger.ts'
import { failureKindOf } from '../core/health.ts'
import { selectChain } from '../core/modes.ts'
import type { FailureKind, ModelPool, PoolModel, RequestFingerprint, RouteCandidate, TaskProfile, TokenUsageLike } from '../core/types.ts'
import type { GenerateOptionsLike, LlmServiceFace, LoggerFace, StreamChunkLike } from './dsh-face.ts'
import { cacheKeyOf, worthRecording, type ResponseCacheFacade } from './response-cache.ts'
import type { RouteJournal } from './journal.ts'
import type { UmbraAls } from './store.ts'
import { createStore } from './store.ts'
import type { ModelHealth } from '../core/health.ts'
import type { HealthSnapshot } from '../core/types.ts'

export interface WireSignals {
  /** HTTP-layer hint from the dispatcher; consumed on rate-limit failures */
  takeRetryAfter(modelId: string): number | undefined
}

export interface RouterState {
  readonly pool?: ModelPool
  readonly health: Map<string, ModelHealth>
  readonly ledger: UsageLedger
  readonly journal: RouteJournal
  readonly signals: WireSignals
  /** present when the exact-match response cache is constructed */
  readonly cache?: ResponseCacheFacade
}

export interface RouterDeps {
  readonly als: UmbraAls
  readonly log: LoggerFace
  readonly llmLookup: () => LlmServiceFace | undefined
  readonly getState: () => RouterState
  /** called when an options mutation is refused (deep-frozen options) */
  readonly onFrozenOptions?: (error: unknown) => void
}

export interface RouterEvents {
  onCooldown?(modelId: string): void
  onRecovery?(modelId: string): void
}

export function createRouter(deps: RouterDeps, events: RouterEvents = {}) {
  const { als, log } = deps

  /** The waterfall listener. */
  function route(options: GenerateOptionsLike, next: () => AsyncIterable<StreamChunkLike>): AsyncIterable<StreamChunkLike> {
    if (als.getStore()?.reentry === true) return next()

    const state = deps.getState()
    const pool = state.pool
    if (pool === undefined) return next()

    const fingerprint = fingerprintOf(options)
    const profile = classify(fingerprint, pool.policy)
    const now = Date.now()
    const requested = requestedOf(fingerprint)

    // ---- exact-match response cache (trivial calls only, opt-in) ----
    const cacheActive = state.cache !== undefined && pool.policy.cache.exactMatch && profile.taskClass === 'trivial'
    const cacheKey = cacheActive ? cacheKeyOf(options) : undefined
    if (cacheKey !== undefined) {
      const hit = state.cache!.lookup(cacheKey)
      if (hit !== undefined) {
        state.journal.open({
          ts: now,
          mode: pool.policy.mode,
          taskClass: profile.taskClass,
          totalChars: fingerprint.totalChars,
          requested,
          chain: [{ modelId: hit.modelId, score: 0 }],
          chosen: hit.modelId,
          reason: '精确缓存命中（未出站，不计费）',
        })
        return replayCached(hit.chunks)
      }
    }

    const chain = selectChain(pool, profile, healthSnapshots(state.health), { now })

    // ---- fail-open: no eligible candidate → original destination, observed only ----
    if (chain.length === 0) {
      const requestedId = requestedIdOf(fingerprint)
      const decisionId = state.journal.open({
        ts: now,
        mode: pool.policy.mode,
        taskClass: profile.taskClass,
        totalChars: fingerprint.totalChars,
        requested,
        chain: [],
        chosen: requestedId ?? 'unrouted',
        reason: '矩阵无满足条件的候选 — 按原请求直连（fail-open）',
      })
      const store = createStore({ modelId: requestedId })
      return observeStreamWithUsage(next(), als, store, state, now, () => {
        state.journal.update(decisionId, { reason: '矩阵无候选直连完成（fail-open）' })
      })
    }

    const decisionId = state.journal.open({
      ts: now,
      mode: pool.policy.mode,
      taskClass: profile.taskClass,
      totalChars: fingerprint.totalChars,
      requested,
      chain,
      chosen: chain[0]!.modelId,
      reason: `${pool.policy.mode} · ${profile.taskClass} · ${chain.length} 候选`,
    })

    // ---- first attempt: mutate options in place, then dispatch synchronously ----
    const first = chain[0]!
    const model = pool.models.find((entry) => entry.id === first.modelId)
    const health = state.health.get(first.modelId)
    health?.begin()

    let rewriteApplied = false
    if (model !== undefined && !(fingerprint.requestedProvider === model.provider && fingerprint.requestedModel === model.model)) {
      try {
        options.provider = model.provider
        options.model = model.model
        rewriteApplied = true
      } catch (error) {
        deps.onFrozenOptions?.(error)
        log.warn('umbra-budget: options 冻结，waterfall 改写未生效；L2 dispatcher 将接管本请求')
      }
    }

    let firstStream: AsyncIterable<StreamChunkLike> | undefined
    let initialError: unknown
    try {
      firstStream = next()
    } catch (error) {
      initialError = error
      health?.end()
    }

    const failover = new FailoverStream(deps, events, {
      options,
      chain,
      fingerprint,
      decisionId,
      startMs: now,
      rewriteApplied,
    })
    if (initialError !== undefined) {
      failover.setInitialFailure(initialError)
    } else {
      failover.setFirstStream(firstStream!)
    }
    const served = failover.stream()
    if (cacheKey === undefined || state.cache === undefined) return served
    // record the exact chunk sequence the consumer receives; stored on completion
    return recordForCache(served, (chunks) => {
      state.cache!.remember(cacheKey, chunks, failover.servedModelId())
    })
  }

  /**
   * The candidate walk. First attempt's stream arrives pre-opened (waterfall
   * contract); later attempts open through `llm.stream` under a reentry store.
   */
  class FailoverStream {
    private inner: AsyncIterator<StreamChunkLike> | undefined
    private index = 0
    private sawFirstChunk = false
    private settled = false
    private fallbacks = 0
    private currentModelId: string
    private startOfAttempt = Date.now()
    private pendingInitialError: unknown
    private readonly excluded: string[] = []
    private readonly depsRef: RouterDeps
    private readonly eventsRef: RouterEvents
    private readonly params: {
      readonly options: GenerateOptionsLike
      readonly chain: readonly RouteCandidate[]
      readonly fingerprint: RequestFingerprint
      readonly decisionId: number
      readonly startMs: number
      readonly rewriteApplied: boolean
    }

    constructor(
      depsRef: RouterDeps,
      eventsRef: RouterEvents,
      params: {
        readonly options: GenerateOptionsLike
        readonly chain: readonly RouteCandidate[]
        readonly fingerprint: RequestFingerprint
        readonly decisionId: number
        readonly startMs: number
        readonly rewriteApplied: boolean
      },
    ) {
      this.depsRef = depsRef
      this.eventsRef = eventsRef
      this.params = params
      this.currentModelId = params.chain[0]?.modelId ?? ''
    }

    setFirstStream(stream: AsyncIterable<StreamChunkLike>): void {
      this.inner = stream[Symbol.asyncIterator]()
    }

    /** the model that actually served (or is serving) the consumer's output */
    servedModelId(): string {
      return this.currentModelId
    }

    setInitialFailure(error: unknown): void {
      this.pendingInitialError = error
      const state = this.depsRef.getState()
      const kind = failureKindOf(error)
      const health = state.health.get(this.currentModelId)
      if (kind !== 'context_overflow') {
        const outcome = health?.recordFailure(kind, Date.now(), state.signals.takeRetryAfter(this.currentModelId), messageOf(error))
        if (outcome === 'cooldown-opened') this.eventsRef.onCooldown?.(this.currentModelId)
      }
      this.excluded.push(this.currentModelId)
    }

    stream(): AsyncIterable<StreamChunkLike> {
      const self = this
      return {
        [Symbol.asyncIterator]() {
          return {
            next: (value?: unknown) => self.pull(value),
            return: async (value?: unknown) => {
              self.settleOk()
              const inner = self.inner
              return inner?.return !== undefined
                ? inner.return(value)
                : ({ done: true, value } as IteratorResult<StreamChunkLike>)
            },
            throw: async (error?: unknown) => {
              const inner = self.inner
              if (inner?.throw !== undefined) return inner.throw(error)
              throw error
            },
            [Symbol.asyncIterator]() {
              return this
            },
          }
        },
      }
    }

    private async pull(value: unknown): Promise<IteratorResult<StreamChunkLike>> {
      const state = this.depsRef.getState()
      for (;;) {
        if (this.pendingInitialError !== undefined) {
          const error = this.pendingInitialError
          this.pendingInitialError = undefined
          if (!this.advance(error, state)) throw error
          continue
        }
        if (this.inner === undefined) {
          this.startOfAttempt = Date.now()
          this.currentModelId = this.params.chain[this.index]!.modelId
          state.health.get(this.currentModelId)?.begin()
          this.inner = this.openRetry(state)[Symbol.asyncIterator]()
        }

        const store = createStore({
          modelId: this.currentModelId,
          ...(this.index > 0 ? { reentry: true } : {}),
        })
        try {
          const result = await als.run(store, () => this.inner!.next(value))
          if (result.done !== true) {
            const chunk = result.value
            if (!this.sawFirstChunk && chunk !== null && typeof chunk === 'object' && (chunk.type === 'text-delta' || chunk.type === 'thinking' || chunk.type === 'tool-call')) {
              this.sawFirstChunk = true
              state.health.get(this.currentModelId)?.recordSuccess(Date.now() - this.startOfAttempt)
            }
            if (chunk !== null && typeof chunk === 'object' && chunk.type === 'usage') {
              recordUsage(state, this.currentModelId, (chunk as { usage?: TokenUsageLike }).usage ?? {})
            }
          } else {
            this.settleOk()
          }
          return result
        } catch (error) {
          const beforeFirstChunk = !this.sawFirstChunk
          state.health.get(this.currentModelId)?.end()
          const kind = failureKindOf(error)
          if (kind !== 'context_overflow') {
            const outcome = state.health.get(this.currentModelId)?.recordFailure(
              kind,
              Date.now(),
              state.signals.takeRetryAfter(this.currentModelId),
              messageOf(error),
            )
            if (outcome === 'cooldown-opened') this.eventsRef.onCooldown?.(this.currentModelId)
          }
          this.excluded.push(this.currentModelId)

          if (!this.advance(error, state)) {
            this.settleError()
            throw error
          }
        }
      }
    }

    /**
     * Move to the next candidate. Returns false (and journals the terminal
     * failure) when the chain or the retry budget is exhausted.
     */
    private advance(error: unknown, state: RouterState): boolean {
      const maxRetries = state.pool?.policy.fallback.maxRetries ?? 2
      const canRetry = !this.sawFirstChunk && this.index + 1 < this.params.chain.length && this.fallbacks < maxRetries
      if (!canRetry) return false
      this.index += 1
      this.fallbacks += 1
      const from = this.currentModelId
      const to = this.params.chain[this.index]!.modelId
      state.journal.update(this.params.decisionId, {
        finalModel: to,
        fallbackOf: from,
        fallbacks: this.fallbacks,
        chosen: to,
        reason: `${from} 失败（${failureKindOf(error)}）→ 容灾换模 ${to}`,
      })
      this.depsRef.log.warn('umbra-budget: 容灾换模 %s → %s', from, to)
      this.inner = undefined
      return true
    }

    /** Failover attempt through the public llm.stream, bypassing the router. */
    private openRetry(state: RouterState): AsyncIterable<StreamChunkLike> {
      const model = state.pool?.models.find((entry) => entry.id === this.currentModelId)
      const llm = this.depsRef.llmLookup()
      if (model === undefined || llm === undefined) {
        throw new Error(`umbra-budget: 容灾换模失败 — llm 服务不可用或目标模型缺失（${this.currentModelId}）`)
      }
      const retryOptions: GenerateOptionsLike = { ...this.params.options, provider: model.provider, model: model.model }
      const store = createStore({ modelId: this.currentModelId, reentry: true })
      return als.run(store, () => llm.stream(retryOptions))
    }

    private settleOk(): void {
      if (this.settled) return
      this.settled = true
      this.depsRef.getState().health.get(this.currentModelId)?.end()
    }

    private settleError(): void {
      if (this.settled) return
      this.settled = true
      this.depsRef.getState().health.get(this.currentModelId)?.end()
    }
  }

  return { route }
}

// ----------------------------------------------------------------------
// cache helpers
// ----------------------------------------------------------------------

/** Replays a cached chunk sequence verbatim; nothing is dispatched or billed. */
function replayCached(chunks: readonly StreamChunkLike[]): AsyncIterable<StreamChunkLike> {
  const iterator = {
    next: async (): Promise<IteratorResult<StreamChunkLike>> => {
      if (index >= chunks.length) return { done: true, value: undefined }
      const chunk = chunks[index]
      index += 1
      return { done: false, value: chunk! }
    },
  }
  let index = 0
  return {
    [Symbol.asyncIterator]() {
      return iterator
    },
  }
}

/** Tee that hands the exact chunk sequence the consumer received to the cache. */
function recordForCache(
  stream: AsyncIterable<StreamChunkLike>,
  sink: (chunks: StreamChunkLike[]) => void,
): AsyncIterable<StreamChunkLike> {
  const recorded: StreamChunkLike[] = []
  let keep = true
  return {
    [Symbol.asyncIterator]() {
      const inner = stream[Symbol.asyncIterator]()
      return {
        next: async (value?: unknown) => {
          const result = await inner.next(value)
          if (result.done === true) {
            if (keep) sink(recorded)
            return result
          }
          recorded.push(result.value)
          if (keep && !worthRecording(recorded)) keep = false
          return result
        },
        return: async (value?: unknown) => {
          // consumer closed early — do not cache a truncated response
          return inner.return !== undefined ? inner.return(value) : ({ done: true, value } as IteratorResult<StreamChunkLike>)
        },
        throw: async (error?: unknown) => {
          keep = false
          if (inner.throw !== undefined) return inner.throw(error)
          throw error
        },
        [Symbol.asyncIterator]() {
          return this
        },
      }
    },
  }
}

// ----------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------

export function healthSnapshots(health: Map<string, ModelHealth>): Map<string, HealthSnapshot> {
  const snapshots = new Map<string, HealthSnapshot>()
  for (const [id, instance] of health) snapshots.set(id, instance.snapshot())
  return snapshots
}

function requestedOf(fingerprint: RequestFingerprint): { provider?: string; model?: string } {
  return {
    ...(fingerprint.requestedProvider !== undefined ? { provider: fingerprint.requestedProvider } : {}),
    ...(fingerprint.requestedModel !== undefined ? { model: fingerprint.requestedModel } : {}),
  }
}

function requestedIdOf(fingerprint: RequestFingerprint): string | undefined {
  if (fingerprint.requestedProvider === undefined && fingerprint.requestedModel === undefined) return undefined
  return `${fingerprint.requestedProvider ?? '?'}/${fingerprint.requestedModel ?? '?'}`
}

function messageOf(error: unknown): string {
  return String(error instanceof Error ? error.message : error).slice(0, 200)
}

/** Usage-only observation wrapper (fail-open path). */
function observeStreamWithUsage(
  stream: AsyncIterable<StreamChunkLike>,
  alsRef: UmbraAls,
  store: ReturnType<typeof createStore>,
  state: RouterState,
  startMs: number,
  onDone: () => void,
): AsyncIterable<StreamChunkLike> {
  let sawFirst = false
  let innerRef: AsyncIterator<StreamChunkLike> | undefined
  const wrap = {
    [Symbol.asyncIterator]() {
      const inner = stream[Symbol.asyncIterator]()
      innerRef = inner
      const run = (method: 'next' | 'return' | 'throw', arg: unknown) =>
        alsRef.run(store, () => (inner[method] as (a: unknown) => Promise<IteratorResult<StreamChunkLike>>)(arg))
      return {
        next: async (value: unknown) => {
          const result = await run('next', value)
          if (result.done !== true) {
            const chunk = result.value
            if (!sawFirst && chunk !== null && typeof chunk === 'object' && (chunk.type === 'text-delta' || chunk.type === 'thinking')) {
              sawFirst = true
              onDone()
            }
            if (chunk !== null && typeof chunk === 'object' && chunk.type === 'usage') {
              recordUsage(state, store.modelId, (chunk as { usage?: TokenUsageLike }).usage ?? {})
            }
          }
          return result
        },
        return: async (value: unknown) =>
          inner.return === undefined
            ? ({ done: true, value } as IteratorResult<StreamChunkLike>)
            : run('return', value),
        throw: async (error: unknown) =>
          inner.throw === undefined ? (() => { throw error })() : run('throw', error),
        [Symbol.asyncIterator]() {
          return this
        },
      }
    },
  }
  void innerRef
  return wrap
}

function recordUsage(state: RouterState, modelId: string | undefined, usage: TokenUsageLike): void {
  if (modelId === undefined) return
  const model = state.pool?.models.find((entry) => entry.id === modelId)
  state.ledger.add(modelId, usage, model?.pricing, new Date())
}

export type { FailureKind, TaskProfile }
