/**
 * 面板的展示格式化。
 *
 * 纯函数，因此「未定价显示 —」「混币不相加」这些规则能被单测钉死，
 * 而不是靠肉眼看界面。放在 core 里是因为 host 与 client 两侧都要用它。
 */
import type { RoutingMode } from './types.ts'

/** 未定价的占位符：一个破折号，不是 0。 */
export const UNPRICED = '—'

/** 未知值的占位符。 */
export const UNKNOWN = '—'

/** 币种符号。 */
const CURRENCY_SYMBOL: Record<string, string> = { CNY: '¥', USD: '$' }

/** 大数字缩写：1240 万 token 显示成 12.4M。 */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0'
  if (tokens < 1_000) return String(Math.round(tokens))
  if (tokens < 1_000_000) return trim(tokens / 1_000) + 'K'
  return trim(tokens / 1_000_000) + 'M'
}

/** 一位小数，整数不拖 .0。 */
function trim(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

/**
 * 金额格式化。
 * @param cost - 金额与币种；null/undefined 表示「未定价」，显示破折号。
 */
export function formatCost(cost: { currency: string, amount: number } | null | undefined): string {
  if (cost === null || cost === undefined) return UNPRICED
  if (!Number.isFinite(cost.amount)) return UNPRICED
  const symbol = CURRENCY_SYMBOL[cost.currency] ?? cost.currency + ' '
  return symbol + trimCost(cost.amount)
}

/** 金额本身的小数位：大于 1 保留两位，小于 1 保留四位。 */
function trimCost(amount: number): string {
  if (amount >= 100) return String(Math.round(amount))
  if (amount >= 1) return amount.toFixed(2)
  if (amount === 0) return '0'
  return amount.toFixed(4)
}

/** 百分比：0.2534 → 25.3%。未知（null）显示破折号。 */
export function formatPercent(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return UNKNOWN
  return (Math.round(ratio * 1000) / 10).toFixed(1) + '%'
}

/** 延迟：820 → 820ms，1234 → 1.2s。 */
export function formatLatency(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return UNKNOWN
  if (ms < 1_000) return String(Math.round(ms)) + 'ms'
  return trim(ms / 1_000) + 's'
}

/** 剩余冷却时间：毫秒 → 「28s」；已到期返回 undefined。 */
export function formatRemaining(resumeAt: number | undefined, now: number): string | undefined {
  if (resumeAt === undefined) return undefined
  const remaining = resumeAt - now
  if (remaining <= 0) return undefined
  if (remaining < 1_000) return '<1s'
  if (remaining < 60_000) return String(Math.ceil(remaining / 1_000)) + 's'
  return String(Math.ceil(remaining / 60_000)) + 'm'
}

/** 三个模式的中文标签。 */
export const MODE_LABEL: Record<RoutingMode, string> = {
  frugal: '极致便宜',
  balanced: '效率优先',
  max_power: '最强火力',
  free: '白嫖模式',
}

/** 三个模式的一句解释，用作按钮 title。 */
export const MODE_HINT: Record<RoutingMode, string> = {
  frugal: '满足硬过滤的 C/D 级里选最便宜；没有低阶才放宽',
  balanced: '任务对应维度须达 A/A+，再按质量与成本 0.6/0.4 混合，并发自动打散',
  max_power: '六维总和最高者优先，Tier 破平',
  free: '只走零成本的模型（免费池 + 免费型号），一个都没有就报错，绝不偷偷花钱',
}

/** 三个模式的排列顺序（UI 从左到右）。 */
export const MODE_ORDER: RoutingMode[] = ['frugal', 'balanced', 'max_power', 'free']

/** 健康状态的中文标签。 */
export const HEALTH_LABEL: Record<string, string> = {
  active: '活跃',
  cooling: '冷却中',
  'half-open': '试探中',
  open: '熔断',
  offline: '已下线',
}
