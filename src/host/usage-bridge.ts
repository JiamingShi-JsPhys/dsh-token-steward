/**
 * 计量桥：把 dsh-usage 的按日台账读成面板需要的「今天每个模型多少 token / 多少钱」。
 *
 * 为什么读它而不是自己再数一遍：同一笔 token 被两套逻辑各算一次，长期必然对不上，
 * 而用户看到的数字必须只有一个来源。dsh-usage 已经按 日→provider→model 存好，
 * 这里只做一次投影。
 *
 * dsh-usage 不在时**不假装有数据**：返回 available: false，面板显示「计量不可用」，
 * 而不是显示 0——0 会被读成「今天没花钱」，那是错的。
 */
import { readFileIfExists } from './atomic-file.ts'
import { localDateKey } from '../core/ledger-doc.ts'
import type { ModelUsageFact, UsageFacts } from '../core/types.ts'

/** dsh-usage 的台账行（只声明本模块读的字段）。 */
interface UsageTotalsRow {
  inputTokens?: unknown
  outputTokens?: unknown
  cacheReadTokens?: unknown
  cacheWriteTokens?: unknown
  reasoningTokens?: unknown
  calls?: unknown
  cost?: unknown
}

/** 一个模型今天的用量事实 + 它是否带定价。 */
export interface UsageProjection {
  /** 计量来源是否可用（文件存在且结构可读）。 */
  available: boolean
  /** key 为 provider/model。 */
  facts: UsageFacts
  /** 台账里的日期键，面板显示「数据截至哪天」。 */
  dateKey: string
  /** 读取失败时的可读原因；成功时为 undefined。 */
  error?: string
}

/** 一个既定的空投影。 */
export function emptyProjection(dateKey: string, error?: string): UsageProjection {
  return error === undefined ? { available: false, facts: {}, dateKey } : { available: false, facts: {}, dateKey, error }
}

/** 读一个数字字段；非数或负数按 0。 */
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** 把一行 totals 折成 token 总数。 */
export function totalOf(row: UsageTotalsRow): number {
  return num(row.inputTokens) + num(row.outputTokens) + num(row.cacheReadTokens)
    + num(row.cacheWriteTokens) + num(row.reasoningTokens)
}

/**
 * 从一行 totals 算出该模型今天的面板事实。
 *
 * 两条严谨性规则：
 *  1. `cost` 为 0 时**不**当成「免费」，而是「未定价」——dsh-usage 对非官方路由
 *     一律写 0，那是「不知道」而不是「不要钱」。是否真的免费由 model_pool 的
 *     `cost_level` 决定，不由这里推断。
 *  2. 缓存命中率 = cacheRead / (input + cacheRead)；分母为 0 时为 null（未知），
 *     不是 0（0% 命中是另一个意思）。
 */
export function factOf(row: UsageTotalsRow, currency = 'CNY'): ModelUsageFact {
  const cacheRead = num(row.cacheReadTokens)
  const input = num(row.inputTokens)
  const cost = num(row.cost)
  const denominator = input + cacheRead
  return {
    todayTokens: totalOf(row),
    todayCost: cost > 0 ? { currency, amount: cost } : null,
    cacheHitRate: denominator === 0 ? null : cacheRead / denominator,
  }
}

/**
 * 从一份 dsh-usage 台账文档里投影出今天的事实。
 * @param raw - 已解析的台账 JSON。
 * @param dateKey - 目标日期。
 * @param currency - 台账的计价币种（dsh-usage 目前固定 CNY）。
 */
export function projectLedger(raw: unknown, dateKey: string, currency = 'CNY'): UsageProjection {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return emptyProjection(dateKey, 'usage ledger is not an object')
  }
  const days = (raw as { days?: unknown }).days
  if (typeof days !== 'object' || days === null || Array.isArray(days)) {
    return emptyProjection(dateKey, 'usage ledger has no days')
  }
  const day = (days as Record<string, unknown>)[dateKey]
  if (typeof day !== 'object' || day === null || Array.isArray(day)) {
    // 文件可读但今天还没有任何用量：这是正常状态，不是错误。
    return { available: true, facts: {}, dateKey }
  }

  const facts: UsageFacts = {}
  for (const [provider, models] of Object.entries(day as Record<string, unknown>)) {
    if (typeof models !== 'object' || models === null || Array.isArray(models)) continue
    for (const [model, row] of Object.entries(models as Record<string, unknown>)) {
      if (typeof row !== 'object' || row === null || Array.isArray(row)) continue
      facts[provider + '/' + model] = factOf(row as UsageTotalsRow, currency)
    }
  }
  return { available: true, facts, dateKey }
}

/** dsh-usage 在 $DSH_HOME 下的相对路径。 */
export const USAGE_LEDGER_SEGMENTS = ['dsh-usage', 'usage-ledger.json'] as const

/**
 * 从磁盘读今天的计量投影。
 * @param dshHome - $DSH_HOME。
 * @param now - 当前毫秒（决定「今天」是哪天）。
 * @returns 投影；文件缺失或损坏时 available: false 并带原因。
 */
export async function readUsageProjection(dshHome: string, now: number): Promise<UsageProjection> {
  const dateKey = localDateKey(now)
  const path = dshHome + '/' + USAGE_LEDGER_SEGMENTS.join('/')
  let text: string | undefined
  try {
    text = await readFileIfExists(path)
  } catch (error) {
    return emptyProjection(dateKey, 'cannot read usage ledger: ' + messageOf(error))
  }
  if (text === undefined) return emptyProjection(dateKey, 'usage ledger not found (dsh-usage is not installed?)')
  try {
    return projectLedger(JSON.parse(text), dateKey)
  } catch (error) {
    return emptyProjection(dateKey, 'usage ledger is not valid JSON: ' + messageOf(error))
  }
}

/** 从 unknown 里取可读消息。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
