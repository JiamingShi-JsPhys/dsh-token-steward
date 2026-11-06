/**
 * Per-call identity carried from the waterfall into the undici dispatcher via
 * AsyncLocalStorage — provider-proxy's pattern, extended with the matrix's
 * routing bookkeeping.
 *
 * @module host/store
 */
import type { AsyncLocalStorage } from 'node:async_hooks'

export interface UmbraStore {
  /** this call is matrix-routed (present on every store we create) */
  readonly umbra: true
  /** routed target `provider/model` id */
  readonly modelId?: string
  /** set on failover re-dispatches so the router passes them through untouched */
  readonly reentry?: boolean
  /** waterfall-level (provider, model) mutation did not throw — optimism only; the dispatcher verifies */
  readonly rewriteApplied?: boolean
}

export type UmbraAls = AsyncLocalStorage<UmbraStore>

export function createStore(partial: Omit<UmbraStore, 'umbra'> & { umbra?: true }): UmbraStore {
  return { umbra: true, ...partial }
}
