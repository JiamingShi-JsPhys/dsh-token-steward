/**
 * Per-model health state machine (circuit breaker).
 *
 * Transitions:
 *   healthy → cooling   consecutive failures ≥ threshold (kind-specific cooldown)
 *   cooling → healthy   half-open probe succeeded (cooldown elapsed, one call allowed)
 *   any     → disabled  auth failure (manual re-enable via UI/API)
 *
 * `context_overflow` never cools a model — it is task-shaped, not model-shaped;
 * the router just excludes it for the current call.
 *
 * @module core/health
 */
import type { FailureKind, HealthSnapshot, HealthStatus } from './types.ts'

export interface HealthOptions {
  readonly cooldownMs: number
  readonly rateLimitMs: number
  /** consecutive failures before opening the breaker */
  readonly threshold?: number
}

const DEFAULT_THRESHOLD = 2
/** EWMA smoothing for TTFB (0 = old, 1 = new) */
const EWMA_ALPHA = 0.3

export class ModelHealth {
  private status: HealthStatus = 'healthy'
  private failures = 0
  private coolUntil = 0
  private inFlight = 0
  private ewmaTtfbMs = 0
  private lastError: string | undefined
  private halfOpenProbe = false
  private readonly threshold: number
  private readonly cooldownMs: number
  private readonly rateLimitMs: number

  constructor(options: HealthOptions) {
    this.threshold = options.threshold ?? DEFAULT_THRESHOLD
    this.cooldownMs = options.cooldownMs
    this.rateLimitMs = options.rateLimitMs
  }

  snapshot(): HealthSnapshot {
    return {
      status: this.status,
      failures: this.failures,
      coolUntil: this.coolUntil,
      inFlight: this.inFlight,
      ewmaTtfbMs: Math.round(this.ewmaTtfbMs),
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
    }
  }

  begin(): void {
    this.inFlight += 1
    if (this.status === 'cooling' && Date.now() >= this.coolUntil) this.halfOpenProbe = true
  }

  end(): void {
    this.inFlight = Math.max(0, this.inFlight - 1)
  }

  recordSuccess(ttfbMs: number): void {
    this.failures = 0
    this.status = 'healthy'
    this.coolUntil = 0
    this.halfOpenProbe = false
    this.lastError = undefined
    this.ewmaTtfbMs = this.ewmaTtfbMs === 0 ? ttfbMs : this.ewmaTtfbMs * (1 - EWMA_ALPHA) + ttfbMs * EWMA_ALPHA
  }

  /**
   * @returns 'cooldown-opened' when this failure tripped the breaker,
   *          'half-open-failed' when a probe call failed (cooldown restarts),
   *          'disabled' on auth failure, otherwise 'noted'.
   */
  recordFailure(kind: FailureKind, now: number, retryAfterMs?: number, reason?: string): 'cooldown-opened' | 'half-open-failed' | 'disabled' | 'noted' {
    if (kind === 'auth') {
      this.status = 'disabled'
      this.failures += 1
      this.lastError = reason ?? 'auth failure — disabled until re-enabled'
      return 'disabled'
    }
    if (kind === 'context_overflow') {
      this.lastError = reason ?? 'context overflow for this task'
      return 'noted'
    }
    this.failures += 1
    this.lastError = reason
    const threshold = this.threshold
    const wasCooling = this.status === 'cooling'
    if (wasCooling || this.failures >= threshold) {
      this.status = 'cooling'
      const base = kind === 'rate_limited' ? (retryAfterMs ?? this.rateLimitMs) : this.cooldownMs
      this.coolUntil = now + Math.max(base, 1_000)
      this.halfOpenProbe = false
      return wasCooling ? 'half-open-failed' : 'cooldown-opened'
    }
    return 'noted'
  }

  /** Manual enable from the UI clears any state. */
  reEnable(): void {
    this.status = 'healthy'
    this.failures = 0
    this.coolUntil = 0
    this.halfOpenProbe = false
    this.lastError = undefined
  }

  /** Manual disable from the UI. */
  disable(): void {
    this.status = 'disabled'
  }

  /** Whether this in-flight call is the half-open probe (affects routing notes). */
  get probing(): boolean {
    return this.halfOpenProbe
  }
}

/** Best-effort failure classification from an unknown thrown value. */
export function failureKindOf(error: unknown): FailureKind {
  if (error !== null && typeof error === 'object') {
    const status = (error as Record<string, unknown>).status
    if (typeof status === 'number') {
      if (status === 429) return 'rate_limited'
      if (status === 401 || status === 403) return 'auth'
      if (status >= 500) return 'server'
    }
    const name = (error as Record<string, unknown>).name
    if (name === 'AbortError' || name === 'TimeoutError') return 'timeout'
  }
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase()
  if (/429|rate.?limit|too many requests/.test(text)) return 'rate_limited'
  if (/401|403|unauthorized|forbidden|invalid api key|authentication/.test(text)) return 'auth'
  if (/context (length|window)|maximum context|too long|token limit|上下文/.test(text)) return 'context_overflow'
  if (/time[sd]? ?out|etimedout|abort/.test(text)) return 'timeout'
  if (/econnrefused|enotfound|econnreset|epipe|socket|network|fetch failed/.test(text)) return 'network'
  if (/500|502|503|504|bad gateway|internal server/.test(text)) return 'server'
  return 'unknown'
}
