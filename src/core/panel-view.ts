/**
 * 面板的视图模型。
 *
 * 组件只负责把这里的输出画出来，因此「未定价显示破折号」「空闲 agent 置灰」
 * 「rejected 时挂红条」这些判断全部可以被单测钉死，而不需要 DOM。
 *
 * 纯函数：不读时钟（now 由调用方带入）、不发请求。
 */
import type {
  AgentRouteView,
  MatrixSnapshot,
  ModelCardView,
  RouteEventView,
  RoutingMode,
} from './types.ts'
import {
  MODE_HINT,
  MODE_LABEL,
  MODE_ORDER,
  UNPRICED,
  formatCost,
  formatLatency,
  formatPercent,
  formatRemaining,
  formatTokens,
} from './format.ts'

/** agent 超过这么久没动静就置灰。 */
export const AGENT_IDLE_MS = 90_000

/** 面板主数据区的四张数字卡。 */
export interface Headline {
  /** 今日 token 总数，已缩写。 */
  tokens: string
  /** 今日花费；未定价/未计量时是一个带说明的破折号。 */
  cost: string
  /** 花费下方的补充说明，如「3 个模型未定价」。 */
  costNote?: string
  /** 缓存命中率。 */
  cache: string
  /** 降级请求数。 */
  degraded: string
  /** 计量整体是否可用；false 时 tokens/cache 显示为不可用。 */
  usageAvailable: boolean
}

/** 生成四张数字卡的内容。 */
export function headline(snapshot: MatrixSnapshot): Headline {
  const available = snapshot.usageAvailable
  const unpriced = snapshot.totals.unpricedModels
  const costNote = !available
    ? '计量不可用'
    : unpriced > 0 ? String(unpriced) + ' 个模型未定价' : undefined
  return {
    tokens: available ? formatTokens(snapshot.totals.todayTokens) : UNPRICED,
    cost: available ? formatCost(snapshot.totals.todayCost) : UNPRICED,
    ...(costNote === undefined ? {} : { costNote }),
    cache: available ? formatPercent(snapshot.totals.cacheHitRate) : UNPRICED,
    degraded: String(snapshot.totals.degradedRequests),
    usageAvailable: available,
  }
}

/** 一个模式按钮。 */
export interface ModeOption {
  mode: RoutingMode
  label: string
  hint: string
  active: boolean
}

/** 三个模式按钮（顺序固定，当前模式带 active）。 */
export function modeOptions(snapshot: MatrixSnapshot): ModeOption[] {
  return MODE_ORDER.map((mode) => ({
    mode,
    label: MODE_LABEL[mode],
    hint: MODE_HINT[mode],
    active: snapshot.mode === mode,
  }))
}

/** 一个模型卡的展示数据（在 ModelCardView 之上补格式化字段）。 */
export interface ModelCardFace {
  provider: string
  model: string
  displayName: string
  capabilities: string[]
  costLevelLabel: string
  costLevel: ModelCardView['costLevel']
  health: ModelCardView['health']
  healthLabel: string
  /** 冷却/熔断剩余时间，如「28s」；无倒计时时 undefined。 */
  resumeIn?: string
  inFlightText: string
  latencyText: string
  tokensText: string
  costText: string
  cacheText: string
  /** 该模型是否未定价（面板据此加一个淡淡的标记）。 */
  unpriced: boolean
}

/** 成本档位的中文标签。 */
const COST_LABEL: Record<ModelCardView['costLevel'], string> = {
  free: '免费',
  low: '低',
  medium: '中',
  high: '高',
}

/** 健康状态的中文标签（与 format.ts 的 HEALTH_LABEL 一致，这里只取用）。 */
const HEALTH_TEXT: Record<string, string> = {
  active: '活跃',
  cooling: '冷却中',
  'half-open': '试探中',
  open: '熔断',
  offline: '已下线',
}

/** 生成模型卡的展示数据。 */
export function modelCardFace(card: ModelCardView, now: number): ModelCardFace {
  const resumeIn = formatRemaining(card.resumeAt, now)
  return {
    provider: card.provider,
    model: card.model,
    displayName: card.displayName,
    capabilities: card.capabilities.slice(),
    costLevel: card.costLevel,
    costLevelLabel: COST_LABEL[card.costLevel] ?? card.costLevel,
    health: card.health,
    healthLabel: HEALTH_TEXT[card.health] ?? card.health,
    ...(resumeIn === undefined ? {} : { resumeIn }),
    inFlightText: String(card.inFlight),
    latencyText: formatLatency(card.latencyMs),
    tokensText: formatTokens(card.todayTokens),
    costText: formatCost(card.todayCost),
    cacheText: formatPercent(card.cacheHitRate),
    unpriced: card.todayCost === null,
  }
}

/**
 * 按成本档位分组（free → low → medium → high），组内保持配置顺序。
 * 空组不出现在结果里，因此面板不会画一排空标题。
 */
export function groupByCost(cards: ModelCardView[]): Array<{ costLevel: ModelCardView['costLevel'], label: string, cards: ModelCardView[] }> {
  const order: Array<ModelCardView['costLevel']> = ['free', 'low', 'medium', 'high']
  const groups: Array<{ costLevel: ModelCardView['costLevel'], label: string, cards: ModelCardView[] }> = []
  for (const level of order) {
    const members = cards.filter((card) => card.costLevel === level)
    if (members.length === 0) continue
    groups.push({ costLevel: level, label: COST_LABEL[level], cards: members })
  }
  return groups
}

/** 一行 agent 协作数据。 */
export interface AgentRow {
  agentId: string
  routeText: string
  requestsText: string
  idle: boolean
}

/** 生成代理协作视图的行；空闲的排在后面。 */
export function agentRows(agents: AgentRouteView[], now: number): AgentRow[] {
  const rows = agents.map((agent) => ({
    agentId: agent.agentId,
    routeText: agent.provider + ' / ' + agent.model,
    requestsText: String(agent.requests) + ' 次',
    idle: now - agent.lastSeenAt > AGENT_IDLE_MS,
  }))
  return rows.sort((left, right) => Number(left.idle) - Number(right.idle))
}

/** 一行路由监控数据。 */
export interface RouteRow {
  requestId: string
  /** 「provider/model」或降级链的「a → b」。 */
  routeText: string
  ok: boolean
  modeLabel: string
  latencyText: string
  degraded: boolean
  /** 来自本地精确缓存（未出站、未计费）。 */
  cached?: boolean
  /** 失败时的原因，如「rate-limit」。 */
  failureReason?: string
}

/** 生成路由监控的行（新的在前）。 */
export function routeRows(recent: RouteEventView[], limit = 12): RouteRow[] {
  return recent.slice(-limit).reverse().map((event) => {
    const chain = [...event.degradedFrom.map((entry) => entry.provider + '/' + entry.model), event.provider + '/' + event.model]
    const last = event.degradedFrom[event.degradedFrom.length - 1]
    return {
      requestId: event.requestId,
      routeText: chain.join(' → '),
      ok: event.ok,
      modeLabel: MODE_LABEL[event.mode] ?? event.mode,
      latencyText: formatLatency(event.latencyMs),
      degraded: event.degradedFrom.length > 0,
      ...(event.cached === true ? { cached: true } : {}),
      ...(event.ok || last === undefined ? {} : { failureReason: last.errorKind }),
    }
  })
}

/** 面板顶部的状态横幅。 */
export interface Banner {
  level: 'error' | 'warn'
  text: string
}

/** 根据快照决定要不要挂横幅；不需要时返回 undefined。 */
export function bannerOf(snapshot: MatrixSnapshot): Banner | undefined {
  if (snapshot.pool.status === 'rejected') {
    return { level: 'error', text: '配置被拒绝，仍在使用上一次有效矩阵：' + (snapshot.pool.error ?? '') }
  }
  if (snapshot.pool.status === 'loading') {
    return { level: 'warn', text: '正在读取模型矩阵…' }
  }
  if (!snapshot.usageAvailable) {
    return { level: 'warn', text: '计量不可用：未检测到 dsh-usage 台账，token 与成本显示为破折号' }
  }
  const offline = snapshot.models.filter((card) => card.health === 'offline').length
  if (offline === snapshot.models.length && offline > 0) {
    return { level: 'error', text: '全部模型已下线，任何请求都会被拒绝' }
  }
  return undefined
}

/** 悬浮球上那一个数字：优先显示今日花费，未定价时退回 token 数。 */
export function ballBadge(snapshot: MatrixSnapshot): string {
  if (!snapshot.usageAvailable) return UNPRICED
  const cost = snapshot.totals.todayCost
  if (cost !== null) return formatCost(cost)
  return formatTokens(snapshot.totals.todayTokens)
}

/** 悬浮球的颜色主题：按当前模式区分。 */
export function ballTone(snapshot: MatrixSnapshot): 'frugal' | 'efficiency' | 'max_power' {
  return snapshot.mode
}
