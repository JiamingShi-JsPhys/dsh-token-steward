/**
 * Usage ledger: local-day → modelId (and → agent) folded totals with cost
 * estimation. In-memory fold + JSON (de)serialization; the host owns debounce
 * and atomic persistence.
 *
 * Billed input = input + cacheRead + cacheWrite (dsh-usage's convention).
 * Cost per model pricing; currencies never mix (per-currency buckets).
 *
 * @module core/ledger
 */
import type { LedgerDocument, ModelPricing, TokenUsageLike, UsageTotals } from './types.ts'

export function emptyTotals(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls: 0, costByCurrency: {} }
}

/** Local-day key in `YYYY-MM-DD`. */
export function dayKeyOf(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function addUsage(target: UsageTotals, usage: TokenUsageLike, pricing?: ModelPricing): void {
  target.inputTokens += nonNegative(usage.inputTokens)
  target.outputTokens += nonNegative(usage.outputTokens)
  target.cacheReadTokens += nonNegative(usage.cacheReadTokens)
  target.cacheWriteTokens += nonNegative(usage.cacheWriteTokens)
  target.reasoningTokens += nonNegative(usage.reasoningTokens)
  target.calls += 1
  if (pricing !== undefined) {
    const currency = pricing.currency
    const billedInput = nonNegative(usage.inputTokens) + nonNegative(usage.cacheReadTokens) + nonNegative(usage.cacheWriteTokens)
    const output = nonNegative(usage.outputTokens)
    const cost =
      (billedInput / 1_000_000) * pricing.input +
      (output / 1_000_000) * pricing.output +
      (nonNegative(usage.cacheReadTokens) / 1_000_000) * (pricing.cacheRead ?? pricing.input) +
      (nonNegative(usage.cacheWriteTokens) / 1_000_000) * (pricing.cacheWrite ?? pricing.input)
    target.costByCurrency[currency] = round4((target.costByCurrency[currency] ?? 0) + cost)
  }
}

/** prompt-cache hit rate over the given totals (0 when nothing was billed yet). */
export function promptCacheHitRate(total: UsageTotals): number {
  const billedInput = total.inputTokens + total.cacheReadTokens + total.cacheWriteTokens
  if (billedInput <= 0) return 0
  return total.cacheReadTokens / billedInput
}

function nonNegative(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

export class UsageLedger {
  private document: LedgerDocument

  constructor(document?: LedgerDocument) {
    this.document = document ?? { version: 1, days: {}, agents: {} }
  }

  get doc(): LedgerDocument {
    return this.document
  }

  add(modelId: string, usage: TokenUsageLike, pricing: ModelPricing | undefined, now: Date): void {
    const day = dayKeyOf(now)
    const dayBucket = (this.document.days[day] ??= {})
    const totals = (dayBucket[modelId] ??= emptyTotals())
    addUsage(totals, usage, pricing)
  }

  addForAgent(agent: string, usage: TokenUsageLike, pricing: ModelPricing | undefined, now: Date): void {
    if (agent === '') return
    const day = dayKeyOf(now)
    const bucket = (this.document.agents[day] ??= {})
    const totals = (bucket[agent] ??= emptyTotals())
    addUsage(totals, usage, pricing)
  }

  todayTotals(now: Date): UsageTotals {
    return this.dayTotals(dayKeyOf(now))
  }

  dayTotals(day: string): UsageTotals {
    const sum = emptyTotals()
    const bucket = this.document.days[day]
    if (bucket === undefined) return sum
    for (const totals of Object.values(bucket)) {
      sum.inputTokens += totals.inputTokens
      sum.outputTokens += totals.outputTokens
      sum.cacheReadTokens += totals.cacheReadTokens
      sum.cacheWriteTokens += totals.cacheWriteTokens
      sum.reasoningTokens += totals.reasoningTokens
      sum.calls += totals.calls
      for (const [currency, cost] of Object.entries(totals.costByCurrency)) {
        sum.costByCurrency[currency] = round4((sum.costByCurrency[currency] ?? 0) + cost)
      }
    }
    return sum
  }

  /** prompt-cache hit rate across today's models. */
  todayCacheHitRate(now: Date): number {
    return promptCacheHitRate(this.todayTotals(now))
  }

  prune(keepDays: number, now: Date): number {
    const cutoff = new Date(now.getTime() - keepDays * 86_400_000)
    const cutoffKey = dayKeyOf(cutoff)
    let removed = 0
    for (const day of Object.keys(this.document.days)) {
      if (day < cutoffKey) {
        delete this.document.days[day]
        removed += 1
      }
    }
    for (const day of Object.keys(this.document.agents)) {
      if (day < cutoffKey) delete this.document.agents[day]
    }
    return removed
  }

  toJSON(): LedgerDocument {
    return this.document
  }

  static fromJSON(value: unknown): UsageLedger {
    if (value !== null && typeof value === 'object') {
      const doc = value as Record<string, unknown>
      if (doc.version === 1 && typeof doc.days === 'object' && doc.days !== null) {
        return new UsageLedger({
          version: 1,
          days: doc.days as LedgerDocument['days'],
          agents: typeof doc.agents === 'object' && doc.agents !== null ? (doc.agents as LedgerDocument['agents']) : {},
        })
      }
    }
    return new UsageLedger()
  }
}
