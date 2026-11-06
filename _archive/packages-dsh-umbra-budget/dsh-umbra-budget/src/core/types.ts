/**
 * Shared type vocabulary for the umbra-budget model matrix.
 *
 * This module is pure: no runtime imports, no DSH types — safe for the client
 * half, the host half and node strip-types test runs alike.
 *
 * @module core/types
 */

// ==================================================================
// Tags
// ==================================================================

export type Capability =
  | 'coding'
  | 'reasoning'
  | 'vision'
  | 'fast'
  | 'agent'
  | 'long_context'
  | 'tool_use'

export const ALL_CAPABILITIES: readonly Capability[] = ['coding', 'reasoning', 'vision', 'fast', 'agent', 'long_context', 'tool_use']

export type CostLevel = 'free' | 'low' | 'medium' | 'high'

export const COST_RANK: Readonly<Record<CostLevel, number>> = { free: 0, low: 1, medium: 2, high: 3 }

export type Availability = 'direct' | 'proxy'

export type AuthStyle = 'bearer' | 'x-api-key' | 'api-key'

export type ScheduleMode = 'frugal' | 'efficiency' | 'max_power'

export const SCHEDULE_MODES: readonly ScheduleMode[] = ['frugal', 'efficiency', 'max_power']

// ==================================================================
// Model pool (runtime shape of model_pool.yaml)
// ==================================================================

export interface ModelTags {
  readonly capabilities: readonly Capability[]
  readonly costLevel: CostLevel
  readonly contextWindow: number
  readonly availability: Availability
}

export interface ModelPricing {
  readonly currency: string
  /** price per 1M tokens */
  readonly input: number
  readonly output: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
}

export interface PoolModel {
  /** logical id `${provider}/${model}` */
  readonly id: string
  /** DSH provider route name — the rewrite target's first half */
  readonly provider: string
  /** raw model id — the rewrite target's second half */
  readonly model: string
  readonly tags: ModelTags
  readonly pricing?: ModelPricing
  readonly enabled: boolean
  // ---- B-track: free-wired OpenAI-compatible endpoint (all optional) ----
  /** absolute base endpoint, e.g. https://api.example.com/v1 */
  readonly endpoint?: string
  /** resolved api key (from an env ref at load time); never persisted */
  readonly apiKey?: string
  readonly authStyle: AuthStyle
  /** per-model outbound proxy URL (L2) */
  readonly proxy?: string
  /** extra headers injected at dispatch (L2) */
  readonly headers: Readonly<Record<string, string>>
  /** true when an env-referenced key resolved and (for B-track) an endpoint exists */
  readonly configured: boolean
  /** load-time diagnostics for the UI (why configured=false) */
  readonly configNotes: readonly string[]
}

export interface RoutingPolicy {
  readonly mode: ScheduleMode
  readonly classifier: {
    readonly trivialMaxChars: number
    readonly heavyMinChars: number
    readonly heavyTools: boolean
  }
  readonly fallback: {
    readonly maxRetries: number
    readonly cooldownMs: number
    readonly rateLimitMs: number
  }
  readonly scatter: {
    readonly efficiencyMinInflight: number
  }
  readonly cache: {
    readonly exactMatch: boolean
  }
}

export interface ModelPool {
  readonly version: 1
  readonly models: readonly PoolModel[]
  readonly policy: RoutingPolicy
  /** epoch ms of the load — UI staleness hint */
  readonly loadedAt: number
}

// ==================================================================
// Task classification
// ==================================================================

export type TaskClass = 'trivial' | 'standard' | 'heavy'

export interface RequestFingerprint {
  readonly messageCount: number
  readonly totalChars: number
  readonly hasTools: boolean
  readonly reasoningEffort?: string
  readonly requestedProvider?: string
  readonly requestedModel?: string
  /** caller hint when the runtime exposes one (probe P2 decides) */
  readonly callerHint?: string
}

export interface TaskProfile {
  readonly taskClass: TaskClass
  readonly requiredCapabilities: readonly Capability[]
  /** minimum usable context window in tokens */
  readonly minContextWindow: number
}

// ==================================================================
// Health & failover
// ==================================================================

export type HealthStatus = 'healthy' | 'cooling' | 'disabled'

export type FailureKind =
  | 'rate_limited'
  | 'auth'
  | 'server'
  | 'network'
  | 'timeout'
  | 'context_overflow'
  | 'unknown'

export interface HealthSnapshot {
  readonly status: HealthStatus
  readonly failures: number
  readonly coolUntil: number
  readonly inFlight: number
  readonly ewmaTtfbMs: number
  readonly lastError?: string
}

// ==================================================================
// Routing decisions
// ==================================================================

export interface RouteCandidate {
  readonly modelId: string
  readonly score: number
}

export interface RouteDecision {
  readonly ts: number
  readonly mode: ScheduleMode
  readonly taskClass: TaskClass
  readonly totalChars: number
  readonly requested: { readonly provider?: string; readonly model?: string }
  readonly chain: readonly RouteCandidate[]
  /** model actually dispatched first */
  readonly chosen: string
  /** set when failover swapped models mid-call (pre-first-chunk) */
  readonly finalModel?: string
  readonly fallbackOf?: string
  readonly fallbacks: number
  readonly reason: string
}

// ==================================================================
// Usage ledger
// ==================================================================

export interface TokenUsageLike {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
}

export interface UsageTotals {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  calls: number
  /** per-currency estimated cost; keeps currencies from mixing */
  costByCurrency: Record<string, number>
}

export interface LedgerDocument {
  version: 1
  /** local day `YYYY-MM-DD` → modelId → totals */
  days: Record<string, Record<string, UsageTotals>>
  /** local day → agent label → totals */
  agents: Record<string, Record<string, UsageTotals>>
}

// ==================================================================
// Live view for UI/API
// ==================================================================

export interface ModelCardView {
  readonly model: PoolModel
  readonly health: HealthSnapshot
  readonly today: UsageTotals
}

export interface AgentAssignmentView {
  readonly agent: string
  readonly modelId: string
  readonly since: number
}

export interface UmbraOverview {
  readonly mode: ScheduleMode
  readonly backend: RewriteBackend
  readonly pool: readonly ModelCardView[]
  readonly today: UsageTotals
  readonly promptCacheHitRate: number
  readonly localCache: { readonly hits: number; readonly misses: number; readonly size: number; readonly enabled: boolean }
  readonly recentRoutes: readonly RouteDecision[]
  readonly agents: readonly AgentAssignmentView[]
}

/** which enforcement mechanism the runtime verified as effective */
export type RewriteBackend = 'waterfall' | 'dispatcher' | 'mixed' | 'unknown'

// ==================================================================
// SSE frames
// ==================================================================

export type RouteEventKind = 'dispatch' | 'fallback' | 'cooldown' | 'recovery' | 'usage'

export interface RouteEventFrame {
  readonly rev: number
  readonly kind: RouteEventKind
  readonly ts: number
  readonly modelId?: string
  readonly fromModelId?: string
  readonly reason?: string
  readonly decision?: RouteDecision
}
