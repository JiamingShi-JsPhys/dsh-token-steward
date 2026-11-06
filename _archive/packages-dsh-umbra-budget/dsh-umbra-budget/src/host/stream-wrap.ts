/**
 * Failover-aware stream observer.
 *
 * Wraps an async chunk stream so that:
 *   - every pull runs inside the ALS store (the dispatcher reads the routed
 *     target at dispatch time, exactly like provider-proxy);
 *   - the first content chunk measures TTFB and settles the attempt as healthy;
 *   - `usage` chunks feed the ledger (covers one-shot calls that never appear
 *     in dsh-usage's session-event ledger);
 *   - `return()` (consumer broke early) and `finish` settle the attempt.
 *
 * The failover LOOP itself lives in the router; this module stays a pure
 * per-attempt wrapper.
 *
 * @module host/stream-wrap
 */
import type { UmbraAls, UmbraStore } from './store.ts'
import type { StreamChunkLike } from './dsh-face.ts'
import type { TokenUsageLike } from '../core/types.ts'

export interface AttemptHooks {
  /** first content chunk arrived (TTFB known) */
  onFirstChunk(ttfbMs: number): void
  onUsage(usage: TokenUsageLike): void
  /** the attempt ended: `ok` when the stream completed or the consumer closed it; `error` rethrown by the wrapper */
  onSettled(ok: boolean, error?: unknown): void
}

const CONTENT_TYPES = new Set(['text-delta', 'thinking', 'reasoning', 'tool-call', 'tool_call'])

export function isContentChunk(chunk: StreamChunkLike): boolean {
  return chunk !== null && typeof chunk === 'object' && CONTENT_TYPES.has(chunk.type)
}

export function observeStream(
  stream: AsyncIterable<StreamChunkLike>,
  als: UmbraAls,
  store: UmbraStore,
  hooks: AttemptHooks,
  startMs: number,
): AsyncIterable<StreamChunkLike> {
  let sawFirstChunk = false
  let settled = false
  const settle = (ok: boolean, error?: unknown): void => {
    if (settled) return
    settled = true
    hooks.onSettled(ok, error)
  }

  return {
    [Symbol.asyncIterator]() {
      const inner = stream[Symbol.asyncIterator]()
      const run = <T>(method: 'next' | 'return' | 'throw', arg: unknown): Promise<T> =>
        als.run(store, () => (inner[method] as (a: unknown) => Promise<T>)(arg))

      return {
        async next(value: unknown) {
          try {
            const result = await run<IteratorResult<StreamChunkLike>>('next', value)
            if (result.done === true) {
              settle(sawFirstChunk)
              return result
            }
            const chunk = result.value
            if (!sawFirstChunk && isContentChunk(chunk)) {
              sawFirstChunk = true
              hooks.onFirstChunk(Date.now() - startMs)
            }
            if (chunk !== null && typeof chunk === 'object' && chunk.type === 'usage') {
              const usage = (chunk as { usage?: TokenUsageLike }).usage
              if (usage !== undefined) hooks.onUsage(usage)
            }
            return result
          } catch (error) {
            settle(false, error)
            throw error
          }
        },
        async return(value: unknown) {
          settle(sawFirstChunk)
          return inner.return === undefined
            ? ({ done: true, value } as IteratorResult<StreamChunkLike>)
            : run<IteratorResult<StreamChunkLike>>('return', value)
        },
        async throw(error: unknown) {
          settle(false, error)
          if (inner.throw === undefined) throw error
          return run<IteratorResult<StreamChunkLike>>('throw', error)
        },
        [Symbol.asyncIterator]() {
          return this
        },
      }
    },
  }
}
