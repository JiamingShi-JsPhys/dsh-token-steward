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
import { AUTH_COOKIE_DANGER, AUTH_COOKIE_WARN } from './auth-cookies.ts'
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
  /** 今日已省：优先金额，未定价时退回省下的 token。 */
  saved: string
  /** 已省数字下方的来源说明。 */
  savedNote: string
  /** 缓存后端（sqlite / memory / off）。 */
  backend: string
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
  const savings = snapshot.savings
  const savedCost = savings?.cost ?? null
  const saved = savings === undefined
    ? UNPRICED
    : savedCost !== null
      ? formatCost(savedCost)
      : savings.tokens > 0 ? formatTokens(savings.tokens) : '0'
  return {
    tokens: available ? formatTokens(snapshot.totals.todayTokens) : UNPRICED,
    cost: available ? formatCost(snapshot.totals.todayCost) : UNPRICED,
    ...(costNote === undefined ? {} : { costNote }),
    saved,
    savedNote: savings === undefined
      ? ''
      : savedCost !== null
        ? String(savings.cacheHits) + ' 次缓存命中 + 降配选路'
        : '省下 ' + formatTokens(savings.tokens) + ' token（未定价）',
    backend: savings?.cacheBackend ?? 'off',
    // 上游 usage 台账不给缓存信息时，退回本地缓存的真实命中次数——
    // 「—」会让人以为缓存没工作，而它其实刚刚省下了一次出站。
    cache: snapshot.totals.cacheHitRate !== null
      ? formatPercent(snapshot.totals.cacheHitRate)
      : (savings?.cacheHits ?? 0) > 0 ? String((savings as { cacheHits: number }).cacheHits) + ' 次' : UNPRICED,
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
  strengths: string | undefined
  strengthTags: string[] | undefined
  imageInput: boolean
  imageOutput: boolean
  videoOutput: boolean
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
    strengths: card.strengths,
    strengthTags: card.strengthTags,
    imageInput: card.imageInput === true,
    imageOutput: card.imageOutput === true,
    videoOutput: card.videoOutput === true,
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
  if (snapshot.pool.status === 'empty') {
    return { level: 'warn', text: '还没接入任何厂家：打开「管家设置 → 厂家设置」接一家，或从系统里导入已有配置' }
  }
  // 会话 Cookie 堆积是「下一次启动直接打不开」的那种故障，所以排在计量问题前面。
  const authCookies = snapshot.authCookies ?? 0
  if (authCookies >= AUTH_COOKIE_DANGER) {
    return {
      level: 'error',
      text: `网页会话 Cookie 已有 ${String(authCookies)} 个，DSH 下次启动会因请求头过大失败：关闭 DSH 后在插件目录运行 npm run repair:cookies，再重新打开`,
    }
  }
  if (authCookies >= AUTH_COOKIE_WARN) {
    return {
      level: 'warn',
      text: `网页会话 Cookie 已有 ${String(authCookies)} 个（宿主每次启动新增一枚），建议关闭 DSH 后运行 npm run repair:cookies 清理`,
    }
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

/**
 * 悬浮球上那一个数字：**今日已省**。
 * 有金额显示金额，只有 token 时显示 token；一无所有时是诚实的 0。
 */
export function ballBadge(snapshot: MatrixSnapshot): string {
  const savings = snapshot.savings
  if (savings === undefined) return UNPRICED
  if (savings.cost !== null) return formatCost(savings.cost)
  if (savings.tokens > 0) return formatTokens(savings.tokens)
  return '0'
}

/* ────────────────────────────── 极客标签 ────────────────────────────── */

/** 六维在卡片上的短名（大写、不带空格）。 */
const DIMENSION_TAG: Record<string, string> = {
  reasoning: 'REASONING',
  longContext: 'LONG-CONTEXT',
  coding: 'CODING',
  agentic: 'AGENTIC',
  proWork: 'PRO-WORK',
  factuality: 'FACTUALITY',
}

/** 六维固定展示顺序（与评分表列顺序一致）。 */
const DIMENSION_ORDER = ['reasoning', 'longContext', 'coding', 'agentic', 'proWork', 'factuality'] as const

/** 窗口的人类写法：128000 → 128K，1000000 → 1M。 */
export function windowTag(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '?'
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000
    return (Number.isInteger(millions) ? String(millions) : millions.toFixed(1)) + 'M'
  }
  return String(Math.round(tokens / 1_000)) + 'K'
}

/**
 * 评级是否是真事实。
 *
 * 目录里没被评过级的模型记作 `NA`（中性 50 分）。把它印成
 * `[REASONING: NA]` 会让一整排标签变成噪声，所以这里统一视作「未知」。
 */
function isKnownGrade(grade: string | undefined): boolean {
  if (grade === undefined) return false
  const trimmed = grade.trim()
  return trimmed !== '' && trimmed.toUpperCase() !== 'NA'
}

/**
 * 模型卡的极客标签：全部大写纯文字 + 方括号，由 CSS 加 1px 实线边框与等宽字体。
 * 规格示例：`[REASONING: SSS]`、`[VISION]`、`[200K]`。**绝不使用 Emoji。**
 */
export function geekTags(card: ModelCardView): string[] {
  const tags: string[] = []
  const tierKnown = isKnownGrade(card.tier)
  if (tierKnown) tags.push('[TIER: ' + card.tier + ']')
  let dimensionKnown = false
  if (card.dimensions !== undefined) {
    for (const key of DIMENSION_ORDER) {
      const reading = card.dimensions[key]
      // 未评级的维度不冒充事实：NA 不上标签，改用一枚 [UNRATED] 说明「这家还没评过」。
      if (!isKnownGrade(reading.grade)) continue
      dimensionKnown = true
      tags.push('[' + (DIMENSION_TAG[key] ?? key.toUpperCase()) + ': ' + reading.grade + ']')
    }
  }
  if (!tierKnown && !dimensionKnown) tags.push('[UNRATED]')
  for (const capability of card.capabilities) {
    tags.push('[' + capability.toUpperCase().replace(/_/g, '-') + ']')
  }
  if (card.imageInput === true) tags.push('[VISION]')
  if (card.imageOutput === true) tags.push('[IMAGE-OUT]')
  if (card.videoOutput === true) tags.push('[VIDEO-OUT]')
  // 向量 / 重排模型留在矩阵里可见，但永远不会被派对话：用标签说清楚。
  if (card.chat === false) tags.push('[NO-CHAT]')
  tags.push('[' + windowTag(card.contextWindow) + ']')
  if (card.todayCost === null) tags.push('[UNPRICED]')
  return [...new Set(tags)]
}

/** 悬浮球的颜色主题：按当前模式区分。 */
export function ballTone(snapshot: MatrixSnapshot): RoutingMode {
  return snapshot.mode
}
