/**
 * dsh-umbra-budget · 核心契约类型
 *
 * 这些类型是 host 半区（配置/路由/网关/计量）与 client 半区（shell.overlay 面板）
 * 共同消费的唯一契约。全部可按 JSON 原样过线：不含函数、Date、Map、class 实例。
 * 时间一律 epoch 毫秒 number，金额一律 { currency, amount } 二元组。
 *
 * 命名空间约定见 docs/architecture.md「虚拟模型 id」一节。
 */

/* ────────────────────────────── 基础枚举 ────────────────────────────── */

/** 全局调度模式；UI 可在运行时切换，覆盖 YAML 的 routing.mode。 */
export type RoutingMode = 'frugal' | 'efficiency' | 'max_power'

/** 成本档位；frugal 模式的主序。 */
export type CostLevel = 'high' | 'medium' | 'low' | 'free'

/** 可达性：direct 直连，proxy 需经代理，offline 用户手动下线。 */
export type Availability = 'direct' | 'proxy' | 'offline'

/** 能力标签；路由硬过滤与打分的依据。 */
export type CapabilityTag =
  | 'coding'
  | 'reasoning'
  | 'vision'
  | 'fast'
  | 'tool-use'
  | 'long-context'
  | 'json-mode'
  | 'multilingual'

/** 输入模态；与 capabilities 分开：vision 标签是「能看图」，模态是「吃什么」。 */
export type InputModality = 'text' | 'image' | 'audio' | 'file'

/** 上游 API 形状；一期只支持 OpenAI 兼容，新增形状是纯增量。 */
export type ApiShape = 'openai-completions'

/**
 * 凭据引用，由 credentials 模块展开（纯字符串在这一层不解析）：
 *   env:NAME        → process.env.NAME
 *   file:/abs/path  → 读文件首行
 *   literal:xxxx    → 明文（加载时告警一次）
 *   ${NAME}         → 等价 env:NAME
 * 展开后的明文只存在于内存，永不进入日志、快照或过线文档。
 */
export type CredentialRef = string

/* ────────────────────────────── 配置层 ────────────────────────────── */

/** 一个模型的计价表（每百万 token）；缺省时该模型计为「未定价」，成本显示 —，不冒充 0。 */
export interface PricingTable {
  currency: 'CNY' | 'USD'
  input_per_mtok: number
  output_per_mtok: number
  cache_read_per_mtok?: number
  cache_write_per_mtok?: number
}

/** 矩阵中的一个模型（YAML: providers[].models[]）。字段已归一化，可选字段均有值。 */
export interface ModelEntry {
  /** 上游真实模型 id，原样透传给 endpoint。 */
  id: string
  /** 面板显示名；缺省用 id。 */
  display_name: string
  /** 硬过滤条件：请求要求的标签必须是它的子集。 */
  capabilities: CapabilityTag[]
  cost_level: CostLevel
  /** 硬过滤：估算输入 + 期望输出必须放得下。 */
  context_window: number
  max_output_tokens: number
  availability: Availability
  /** availability=proxy 时必填的代理 URL。 */
  proxy_url?: string
  input_modalities: InputModality[]
  /** 单模型并发闸门；efficiency 模式的打散上限。 */
  max_concurrency: number
  /** 每分钟请求上限（滑窗）；缺省不限。 */
  rpm?: number
  /** 0-100 的能力分，max_power 模式的主序。 */
  quality_rank: number
  pricing?: PricingTable
  /** 自由标签，面板展示用，不参与路由。 */
  tags: Record<string, string>
}

/** 一个 OpenAI 兼容上游（YAML: providers[]）。 */
export interface ProviderEntry {
  provider_name: string
  endpoint: string
  api: ApiShape
  api_key: CredentialRef
  /** 附加到每次出站的 header。 */
  headers: Record<string, string>
  /** 覆盖 defaults.timeout_ms。 */
  timeout_ms?: number
  models: ModelEntry[]
}

/** 全局默认值（YAML: defaults），全部有缺省。 */
export interface RoutingDefaults {
  timeout_ms: number
  /** 一次客户端请求内最多尝试几个模型（含首个）。 */
  max_attempts: number
  /** 429/限流后的基础冷却时长，按失败次数指数退避。 */
  cooldown_ms: number
  /** 连续失败几次触发熔断。 */
  failure_threshold: number
  /** 熔断后多久进入半开试探。 */
  half_open_after_ms: number
}

/**
 * 本地精确响应缓存（YAML: routing.cache）。
 *
 * 只服务「逐字节可复现」的简单调用：同一份 prompt 在 TTL 内重复出现时，
 * 直接回放上一次的响应，不出站、不计费。默认关闭——开启即表示用户接受
 * 「同 prompt 必然要同一个答案」的语义。
 */
export interface CachePolicy {
  exact_match: boolean
  /** LRU 容量上限。 */
  max_entries: number
  /** 条目存活时长（毫秒）。 */
  ttl_ms: number
}

/** 别名路由：把虚拟模型 id 映射成一次路由意图（YAML: routing.aliases）。 */
export interface RoutingAlias {
  /** 覆盖全局模式；缺省用当前全局模式。 */
  mode?: RoutingMode
  /** 追加的能力硬要求。 */
  require?: CapabilityTag[]
  /** 追加强制的输入模态。 */
  require_modalities?: InputModality[]
  /** 直接钉死到一个模型（仍走熔断，但没有别的选择）。 */
  pin?: { provider: string; model: string }
}

/** 已校验、已归一化的完整矩阵配置。解析失败时整份拒绝，绝不半应用。 */
export interface PoolConfig {
  version: 1
  defaults: RoutingDefaults
  routing: {
    mode: RoutingMode
    /** key 是虚拟 id 的后半段：alias 名 → umbra:alias/<name>。 */
    aliases: Record<string, RoutingAlias>
    /** agent_id → 路由意图覆盖（子代理级钉子）。 */
    agent_overrides: Record<string, RoutingAlias>
    /** 本地精确响应缓存；exact_match 默认 false。 */
    cache: CachePolicy
  }
  providers: ProviderEntry[]
}

/* ────────────────────────────── 路由意图与决策 ────────────────────────────── */

/** 从一次客户端请求推断出的路由意图；由网关从请求体 + 虚拟模型 id 推导。 */
export interface RouteIntent {
  requiredCapabilities: CapabilityTag[]
  requiredModalities: InputModality[]
  /** 粗估输入 token；只用于窗口硬过滤与成本预估，不追求精确。 */
  estimatedInputTokens: number
  /** 期望输出上限，参与窗口硬过滤。 */
  expectedOutputTokens: number
  /** 请求是否携带 tools；为真时隐式要求 tool-use。 */
  needsTools: boolean
  stream: boolean
  /** 并发打散组：同一批并发请求共享一个 burstKey。 */
  burstKey: string
  /** 虚拟 id 解析出的别名名，用于解释「为什么选了它」。 */
  aliasName?: string
}

/** 一个候选模型及其排序依据。 */
export interface RouteCandidate {
  provider: string
  model: string
  /** 越大越优先。 */
  score: number
  /** 面板直接展示的排序理由，如 ['cost:free', 'quality 48']。 */
  reasons: string[]
}

/** 一次路由的完整决策：首选 + 有序降级链。 */
export interface RouteDecision {
  requestId: string
  mode: RoutingMode
  chosen: RouteCandidate
  /** 失败时按序顶上，已排除首选。 */
  fallbacks: RouteCandidate[]
  decidedAt: number
  /** 命中别名、被迫降级、或硬过滤后候选偏少的说明。 */
  notes: string[]
}

/** 无可服务模型时的决策结果（不抛错，面板据此挂横幅）。 */
export interface RouteRefusal {
  requestId: string
  mode: RoutingMode
  /** GatewayErrorCode 中与选路相关的那几种。 */
  code: 'no-capable-model' | 'all-models-cooling'
  /** 每个模型被淘汰的原因，按淘汰顺序。 */
  rejected: Array<{ provider: string; model: string; reason: string }>
  decidedAt: number
}

export type PlanResult =
  | { ok: true; decision: RouteDecision }
  | { ok: false; refusal: RouteRefusal }

/* ────────────────────────────── 健康与熔断 ────────────────────────────── */

export type HealthState = 'active' | 'cooling' | 'half-open' | 'open' | 'offline'

/** 单模型运行时健康；纯状态机，可单元测试。 */
export interface ModelHealth {
  state: HealthState
  consecutiveFailures: number
  /** cooling / open 的解除时刻；undefined 表示没有挂起的恢复。 */
  resumeAt?: number | undefined
  lastErrorKind?: ErrorKind | undefined
  /** 指数加权的平均延迟；无样本时为 undefined。 */
  ewmaLatencyMs?: number | undefined
  /** 已成功完成的调用数，EWMA 的样本门槛。 */
  samples: number
  inFlight: number
  /** rpm 滑窗起点与计数。 */
  windowStartedAt: number
  windowCalls: number
}

export type ErrorKind =
  | 'rate-limit'
  | 'timeout'
  | 'transport'
  | 'server'
  | 'auth'
  | 'bad-request'
  | 'context-overflow'
  | 'empty'
  | 'aborted'

/* ────────────────────────────── 计量 ────────────────────────────── */

/** 一个调用返回的 token 分桶；与 dsh-usage 台账的五个桶同构。 */
export interface TokenUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
}

/** 一次上游尝试的结果，回灌给健康状态机与计量。 */
export interface AttemptResult {
  requestId: string
  provider: string
  model: string
  ok: boolean
  httpStatus?: number
  errorKind?: ErrorKind
  latencyMs: number
  /** 已向客户端提交首个字节的尝试不可再降级；网关据此收口。 */
  committed: boolean
  /** 网关确认这是本次请求的最后一次尝试（成功、已提交、或候选耗尽）。 */
  final?: boolean
  usage?: TokenUsage
}

/* ────────────────────────────── 引擎接口 ────────────────────────────── */

/** 打分器的输入上下文；路由引擎在打分前填好。 */
export interface ScoreContext {
  mode: RoutingMode
  now: number
  /** 同一 burstKey 已派给该模型的请求数（并发打散的依据）。 */
  burstLoad: number
}

/** 一个模型的一次打分结果。 */
export interface ScoreResult {
  score: number
  reasons: string[]
}

/** 打分器：新增调度模式只加一个实现，不改过滤与降级逻辑。 */
export type Scorer = (
  model: ModelEntry,
  intent: RouteIntent,
  health: ModelHealth,
  context: ScoreContext,
) => ScoreResult

/** 面板快照的外部输入（计量与代理归因由其他模块提供）。 */
export interface ModelUsageFact {
  todayTokens: number
  /** 无定价表时为 null，面板显示 —。 */
  todayCost: { currency: string; amount: number } | null
  /** 0-1；上游未报缓存桶时为 null。 */
  cacheHitRate: number | null
}

/** key 为 `${provider}/${model}`。 */
export type UsageFacts = Record<string, ModelUsageFact>

export interface SnapshotInput {
  usage?: UsageFacts
  /** 计量来源是否可用；false 时面板显示「计量不可用」而不是 0。 */
  usageAvailable?: boolean
  pool?: { status: 'ok' | 'rejected' | 'loading'; source: string; error?: string }
}

/** 路由引擎：plan 纯决策，report 只动内存状态，都不触碰网络与磁盘。 */
export interface RouterEngine {
  plan(intent: RouteIntent, now: number): PlanResult
  report(result: AttemptResult, now: number): void
  setMode(mode: RoutingMode): RoutingMode
  getMode(): RoutingMode
  /** 登记一次 agent → 模型归因（代理协作视图的数据源）。 */
  noteAgent(agentId: string, provider: string, model: string, now: number): void
  snapshot(now: number, input?: SnapshotInput): MatrixSnapshot
}

/* ────────────────────────────── 面板视图（过线文档） ────────────────────────────── */

/** 模型卡片：面板网格的一项。 */
export interface ModelCardView {
  provider: string
  model: string
  displayName: string
  capabilities: CapabilityTag[]
  costLevel: CostLevel
  contextWindow: number
  availability: Availability
  health: HealthState
  /** open / cooling 的恢复时刻。 */
  resumeAt?: number
  inFlight: number
  latencyMs?: number
  todayTokens: number
  todayCost: { currency: string; amount: number } | null
  cacheHitRate: number | null
}

/** 路由事件：面板的实时流。 */
export interface RouteEventView {
  at: number
  requestId: string
  mode: RoutingMode
  /** 最终服务的模型。 */
  provider: string
  model: string
  /** 被降级时，前面失败的尝试。 */
  degradedFrom: Array<{ provider: string; model: string; errorKind: ErrorKind }>
  ok: boolean
  latencyMs: number
  committed: boolean
  /** true 表示这条响应来自本地精确缓存（未出站、未计费）。 */
  cached?: boolean
}

/** 代理协作视图：一个 agent 当前被分到哪个模型。 */
export interface AgentRouteView {
  agentId: string
  provider: string
  model: string
  /** 该 agent 最近的活跃时刻；超过 90s 视为空闲，面板置灰。 */
  lastSeenAt: number
  requests: number
}

export interface MatrixTotals {
  todayTokens: number
  todayCost: { currency: string; amount: number } | null
  cacheHitRate: number | null
  degradedRequests: number
  /** 无定价模型的条数，面板提示「N 个模型未定价」。 */
  unpricedModels: number
}

/** 面板一次轮询拿到的完整快照。 */
export interface MatrixSnapshot {
  /** 单调递增；客户端靠它丢弃乱序响应。 */
  revision: number
  mode: RoutingMode
  updatedAt: number
  usageAvailable: boolean
  models: ModelCardView[]
  agents: AgentRouteView[]
  /** 最近 N 条路由事件，新的在后。 */
  recent: RouteEventView[]
  totals: MatrixTotals
  pool: { status: 'ok' | 'rejected' | 'loading'; source: string; error?: string }
}

/* ────────────────────────────── 网关协议 ────────────────────────────── */

/** 网关状态文件（$DSH_HOME/umbra-budget/gateway.json，0600）供面板与用户读取接线参数。 */
export interface GatewayState {
  appliedAt: number
  pid: number
  host: '127.0.0.1'
  port: number
  /** baseURL，直接抄进 llm-pi-ai 的 providers.umbra.baseURL。 */
  baseUrl: string
  /** 网关 /v1/models 公布的模型 id（矩阵全集 + 4 个 umbra:* 虚拟 id）。 */
  modelIds: string[]
  /** 本地 Bearer 令牌；同时写入状态文件，供 profile 的 apiKeyEnv 解析。 */
  token: string
}

/** 网关可观测的错误码，作为 OpenAI 兼容 error.type 回给调用方。 */
export type GatewayErrorCode =
  | 'pool-rejected'
  | 'no-capable-model'
  | 'all-models-cooling'
  | 'upstream-failed'
  | 'committed-then-failed'
  | 'unauthorized'
