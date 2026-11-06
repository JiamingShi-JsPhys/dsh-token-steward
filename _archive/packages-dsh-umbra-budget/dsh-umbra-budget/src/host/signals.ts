/**
 * Wire signal hub: dispatcher observations + HTTP-layer hints.
 *
 * Doubles as the passive rewrite-verification probe — the dispatcher compares
 * what the waterfall mutated against what actually left the process, so the
 * runtime KNOWS which enforcement backend is effective (no guessing).
 *
 * @module host/signals
 */
import type { RewriteBackend } from '../core/types.ts'
import type { WireObservation, WireSignal } from './dispatcher.ts'

export interface BackendCounters {
  rerouted: number
  rerouteRefused: number
  flowOk: number
  rewriteIgnored: number
  passthrough: number
  status429: number
  status5xx: number
}

export class SignalHub {
  private retryAfter = new Map<string, { value: number; ts: number }>()
  private counters: BackendCounters = {
    rerouted: 0,
    rerouteRefused: 0,
    flowOk: 0,
    rewriteIgnored: 0,
    passthrough: 0,
    status429: 0,
    status5xx: 0,
  }

  noteObservation(observation: WireObservation): void {
    switch (observation.kind) {
      case 'rerouted':
        this.counters.rerouted += 1
        break
      case 'reroute-refused':
        this.counters.rerouteRefused += 1
        break
      case 'flow-ok':
        this.counters.flowOk += 1
        break
      case 'rewrite-ignored':
        this.counters.rewriteIgnored += 1
        break
      case 'passthrough':
        this.counters.passthrough += 1
        break
      case 'status':
        if (observation.status === 429) this.counters.status429 += 1
        if (observation.status !== undefined && observation.status >= 500) this.counters.status5xx += 1
        break
      default:
        break
    }
  }

  noteSignal(modelId: string, signal: WireSignal): void {
    if (signal.retryAfterMs !== undefined) {
      this.retryAfter.set(modelId, { value: signal.retryAfterMs, ts: Date.now() })
    }
  }

  /** Consume the pending Retry-After hint for a model (stale hints are dropped). */
  takeRetryAfter(modelId: string): number | undefined {
    const hint = this.retryAfter.get(modelId)
    if (hint === undefined) return undefined
    this.retryAfter.delete(modelId)
    if (Date.now() - hint.ts > 60_000) return undefined
    return hint.value
  }

  counters_snapshot(): BackendCounters {
    return { ...this.counters }
  }

  /**
   * Heuristic backend verdict from passive evidence:
   *   flow-ok proves the waterfall mutation reached the wire;
   *   rewrite-ignored proves it did not (dispatcher must enforce);
   *   rerouted proves the B-track wire rewrite is doing real work.
   */
  backendVerdict(): RewriteBackend {
    const { flowOk, rewriteIgnored, rerouted } = this.counters
    if (flowOk > 0 && rerouted > 0) return 'mixed'
    if (flowOk > 0) return 'waterfall'
    if (rewriteIgnored > 0) return 'dispatcher'
    if (rerouted > 0) return 'dispatcher'
    return 'unknown'
  }
}
