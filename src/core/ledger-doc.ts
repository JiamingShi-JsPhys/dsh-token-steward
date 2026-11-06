/**
 * 路由台账文档：纯数据 + 纯函数，不含任何 IO。
 *
 * 存的是「谁被选中、降级几次、每模型今天用了多少 token」，与 dsh-usage 的
 * 按日台账互补——那份台账回答「花了多少钱」，这份回答「钱花在谁能上」。
 *
 * 文档按本地日期分桶，保留期由调用方传入；抽稀（prune）是纯函数，
 * 因此「保留 180 天后会删掉哪一天」可以被单测钉死，而不需要等到 180 天后。
 */
import type { RouteEventView, RoutingMode, TokenUsage } from './types.ts'

/** 台账 schema 版本；结构变更时递增，加载器据此迁移或隔离。 */
export const LEDGER_VERSION = 1

/** 一个模型在一天内的路由统计。 */
export interface ModelDayStat {
  /** 被选为首选的次数。 */
  chosen: number
  /** 被派出去尝试的次数（含降级尝试）。 */
  attempts: number
  /** 失败次数。 */
  failures: number
  /** 累计 token（网关从上游 usage 字段拿到的真实值）。 */
  usage: TokenUsage
  /** 累计耗时，用于算平均。 */
  latencyMs: number
  /** 有延迟样本的次数。 */
  latencySamples: number
}

/** 一天的台账。 */
export interface DayLedger {
  /** provider/model → 统计。 */
  models: Record<string, ModelDayStat>
  /** 当天各模式的请求数。 */
  modes: Partial<Record<RoutingMode, number>>
  /** 当天降级过的请求数。 */
  degraded: number
  /** 当天请求总数。 */
  requests: number
}

/** 台账文档。 */
export interface RouteLedgerDocument {
  version: typeof LEDGER_VERSION
  /** 本地日期 YYYY-MM-DD → 当天台账。 */
  days: Record<string, DayLedger>
}

/** 一条全零的模型统计。 */
export function emptyModelStat(): ModelDayStat {
  return {
    chosen: 0,
    attempts: 0,
    failures: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    latencyMs: 0,
    latencySamples: 0,
  }
}

/** 一条全零的当天台账。 */
export function emptyDay(): DayLedger {
  return { models: {}, modes: {}, degraded: 0, requests: 0 }
}

/** 一份全新的台账文档。 */
export function createLedgerDocument(): RouteLedgerDocument {
  return { version: LEDGER_VERSION, days: {} }
}

/** 本地日期键；测试可传入固定毫秒，因此这里不读时钟。 */
export function localDateKey(ms: number): string {
  const date = new Date(ms)
  const year = String(date.getFullYear())
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return year + '-' + month + '-' + day
}

/** 一个 YYYY-MM-DD 键是否合法（用它挡住手改坏的文件）。 */
export function isDateKey(key: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false
  const [year, month, day] = key.split('-').map(Number) as [number, number, number]
  if (month < 1 || month > 12) return false
  if (day < 1 || day > 31) return false
  const probe = new Date(year, month - 1, day)
  return probe.getFullYear() === year && probe.getMonth() === month - 1 && probe.getDate() === day
}

/** 取（必要时创建）某天的台账。 */
export function dayOf(document: RouteLedgerDocument, dateKey: string): DayLedger {
  const existing = document.days[dateKey]
  if (existing !== undefined) return existing
  const created = emptyDay()
  document.days[dateKey] = created
  return created
}

/** 取（必要时创建）某天某模型的统计。 */
export function modelStatOf(day: DayLedger, key: string): ModelDayStat {
  const existing = day.models[key]
  if (existing !== undefined) return existing
  const created = emptyModelStat()
  day.models[key] = created
  return created
}

/** 把一次已收口的路由事件折进当天台账；纯函数式写入，不返回新对象但只改传入的文档。 */
export function foldEvent(document: RouteLedgerDocument, event: RouteEventView, dateKey: string): void {
  const day = dayOf(document, dateKey)
  day.requests += 1
  day.modes[event.mode] = (day.modes[event.mode] ?? 0) + 1
  if (event.degradedFrom.length > 0) day.degraded += 1

  const key = event.provider + '/' + event.model
  const stat = modelStatOf(day, key)
  if (event.ok) stat.chosen += 1
  else stat.failures += 1
  // 被降级掉的那些尝试也要计数，否则「这个模型被用过几次」会失真。
  stat.attempts += event.degradedFrom.length + 1

  stat.latencyMs += event.latencyMs
  stat.latencySamples += 1
}

/** 把一次上游 usage 累加到当天某模型。 */
export function foldUsage(
  document: RouteLedgerDocument,
  key: string,
  dateKey: string,
  usage: TokenUsage,
): void {
  const stat = modelStatOf(dayOf(document, dateKey), key)
  stat.usage.input += usage.input
  stat.usage.output += usage.output
  stat.usage.cacheRead += usage.cacheRead
  stat.usage.cacheWrite += usage.cacheWrite
  stat.usage.reasoning += usage.reasoning
}

/** 一个模型在某天的 token 总数（五个桶相加）。 */
export function totalTokens(usage: TokenUsage): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite + usage.reasoning
}

/**
 * 抽稀：只保留 today 起往前 retainDays 天。
 * @returns 被删掉的日期键，供日志确认「删了什么」而不是「删了多少」。
 */
export function pruneLedger(
  document: RouteLedgerDocument,
  today: string,
  retainDays: number,
): string[] {
  const keep = new Set<string>()
  const base = dateKeyToUtcMidnight(today)
  if (base === undefined) return []
  for (let offset = 0; offset < retainDays; offset += 1) {
    keep.add(localDateKey(base - offset * 86_400_000))
  }
  const removed: string[] = []
  for (const key of Object.keys(document.days)) {
    if (keep.has(key)) continue
    delete document.days[key]
    removed.push(key)
  }
  return removed.sort()
}

/** 把 YYYY-MM-DD 解析成当日 UTC 零点毫秒；非法返回 undefined。 */
function dateKeyToUtcMidnight(key: string): number | undefined {
  if (!isDateKey(key)) return undefined
  const [year, month, day] = key.split('-').map(Number) as [number, number, number]
  return Date.UTC(year, month - 1, day)
}

/**
 * 反序列化一份可能被手改坏的台账。
 *
 * 策略：结构坏 → 抛错（调用方隔离整份文件）；单条统计坏 → 就地修复为可用值，
 * 因为一行脏数据不该让用户丢掉全部历史。
 */
export function deserializeLedger(value: unknown): RouteLedgerDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('route ledger: root must be an object')
  }
  const root = value as Record<string, unknown>
  if (root.version !== LEDGER_VERSION) {
    throw new Error('route ledger: unsupported version ' + JSON.stringify(root.version))
  }
  const rawDays = root.days
  if (typeof rawDays !== 'object' || rawDays === null || Array.isArray(rawDays)) {
    throw new Error('route ledger: days must be an object')
  }
  const document = createLedgerDocument()
  for (const [dateKey, rawDay] of Object.entries(rawDays as Record<string, unknown>)) {
    if (!isDateKey(dateKey)) continue
    if (typeof rawDay !== 'object' || rawDay === null || Array.isArray(rawDay)) continue
    document.days[dateKey] = repairDay(rawDay as Record<string, unknown>)
  }
  return document
}

/** 把一天的原始数据修复成合法结构。 */
function repairDay(raw: Record<string, unknown>): DayLedger {
  const day = emptyDay()
  day.requests = nonNegative(raw.requests)
  day.degraded = nonNegative(raw.degraded)

  if (typeof raw.modes === 'object' && raw.modes !== null && !Array.isArray(raw.modes)) {
    for (const [mode, count] of Object.entries(raw.modes as Record<string, unknown>)) {
      if (mode !== 'frugal' && mode !== 'efficiency' && mode !== 'max_power') continue
      const parsed = nonNegative(count)
      if (parsed > 0) day.modes[mode] = parsed
    }
  }

  if (typeof raw.models === 'object' && raw.models !== null && !Array.isArray(raw.models)) {
    for (const [key, rawStat] of Object.entries(raw.models as Record<string, unknown>)) {
      if (!key.includes('/')) continue
      if (typeof rawStat !== 'object' || rawStat === null || Array.isArray(rawStat)) continue
      day.models[key] = repairModelStat(rawStat as Record<string, unknown>)
    }
  }
  return day
}

/** 把一个模型的原始统计修复成合法结构。 */
function repairModelStat(raw: Record<string, unknown>): ModelDayStat {
  const stat = emptyModelStat()
  stat.chosen = nonNegative(raw.chosen)
  stat.attempts = nonNegative(raw.attempts)
  stat.failures = nonNegative(raw.failures)
  stat.latencyMs = nonNegative(raw.latencyMs)
  stat.latencySamples = nonNegative(raw.latencySamples)
  if (typeof raw.usage === 'object' && raw.usage !== null && !Array.isArray(raw.usage)) {
    const usage = raw.usage as Record<string, unknown>
    stat.usage = {
      input: nonNegative(usage.input),
      output: nonNegative(usage.output),
      cacheRead: nonNegative(usage.cacheRead),
      cacheWrite: nonNegative(usage.cacheWrite),
      reasoning: nonNegative(usage.reasoning),
    }
  }
  return stat
}

/** 把任意值读成非负整数；坏值归零而不是抛错。 */
function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}
