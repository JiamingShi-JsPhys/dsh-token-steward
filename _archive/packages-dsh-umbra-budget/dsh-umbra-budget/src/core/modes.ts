/**
 * The three scheduling modes as pure sorters, plus the candidate-chain builder.
 *
 * `selectChain` returns the FULL ordered candidate list; the router dispatches
 * the head and walks the tail on failover. Health is injected as snapshots so
 * the sorters stay pure and unit-testable.
 *
 * @module core/modes
 */
import { eligibleModels } from './pool.ts'
import { COST_RANK, type HealthSnapshot, type ModelPool, type PoolModel, type RouteCandidate, type TaskProfile } from './types.ts'

const FAST_BONUS = 1_000

function capabilityCoverage(model: PoolModel, required: readonly { toString(): string }[]): number {
  return model.tags.capabilities.length
}

/**
 * frugal — cheapest first; ties broken by wider capability coverage, then window.
 * The eligibility filter has already removed models that cannot do the job, so
 * "降级到顶配" happens naturally only when nothing cheaper qualifies.
 */
function rankFrugal(model: PoolModel, profile: TaskProfile, health: HealthSnapshot | undefined): number {
  let score = COST_RANK[model.tags.costLevel] * 1_000_000
  score -= capabilityCoverage(model, profile.requiredCapabilities) * 1_000
  score -= Math.min(model.tags.contextWindow, 1_000_000)
  score += health?.inFlight ?? 0
  return score
}

/**
 * efficiency — speed first: `fast` models, then least in-flight (scatter the
 * idea_swarm fan-out across the matrix), then cheaper, then wider coverage.
 */
function rankEfficiency(model: PoolModel, profile: TaskProfile, health: HealthSnapshot | undefined, minInflight: number): number {
  let score = 0
  if (!model.tags.capabilities.includes('fast')) score += 5_000_000
  const inflight = health?.inFlight ?? 0
  score += inflight >= minInflight ? inflight * 100_000 : inflight * 1_000
  score += COST_RANK[model.tags.costLevel] * 10_000
  score -= capabilityCoverage(model, profile.requiredCapabilities) * 100
  return score
}

/**
 * max_power — most capable first: capability coverage dominates, then window,
 * then reasoning/coding specific tags; cost only as a last tiebreak.
 */
function rankMaxPower(model: PoolModel, _profile: TaskProfile, _health: HealthSnapshot | undefined): number {
  let score = -model.tags.capabilities.length * 10_000_000
  score -= Math.min(model.tags.contextWindow, 10_000_000)
  if (model.tags.capabilities.includes('reasoning')) score -= 1_000_000
  if (model.tags.capabilities.includes('vision')) score -= 500_000
  score += COST_RANK[model.tags.costLevel]
  return score
}

export interface SelectOptions {
  readonly now: number
  /** exclude these ids (context-overflow hits from earlier attempts of this call) */
  readonly exclude?: readonly string[]
}

/**
 * Build the ordered candidate chain for one call.
 * A model is eligible when enabled+configured, covers every required capability,
 * and its window fits; cooling models are skipped, disabled models never return.
 */
export function selectChain(pool: ModelPool, profile: TaskProfile, health: ReadonlyMap<string, HealthSnapshot>, options: SelectOptions): RouteCandidate[] {
  const excluded = new Set(options.exclude ?? [])
  const candidates = eligibleModels(pool, profile.requiredCapabilities, profile.minContextWindow).filter(
    (model) => !excluded.has(model.id) && isAvailable(health.get(model.id), options.now),
  )
  const mode = pool.policy.mode
  const minInflight = pool.policy.scatter.efficiencyMinInflight
  const scored = candidates.map((model) => {
    const snapshot = health.get(model.id)
    let score: number
    if (mode === 'frugal') score = rankFrugal(model, profile, snapshot)
    else if (mode === 'efficiency') score = rankEfficiency(model, profile, snapshot, minInflight)
    else score = rankMaxPower(model, profile, snapshot)
    return { modelId: model.id, score }
  })
  scored.sort((left, right) => left.score - right.score || left.modelId.localeCompare(right.modelId))
  return scored
}

/** cooling models become half-open after their cooldown elapses (one probe allowed). */
export function isAvailable(snapshot: HealthSnapshot | undefined, now: number): boolean {
  if (snapshot === undefined) return true
  if (snapshot.status === 'disabled') return false
  if (snapshot.status === 'cooling') return now >= snapshot.coolUntil
  return true
}
