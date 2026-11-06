/**
 * dsh-token-steward · 核心契约类型
 *
 * 这些类型是 host 半区（配置/路由/网关/计量）与 client 半区（shell.overlay 面板）
 * 共同消费的唯一契约。全部可按 JSON 原样过线：不含函数、Date、Map、class 实例。
 * 时间一律 epoch 毫秒 number，金额一律 { currency, amount } 二元组。
 *
 * 命名空间约定见 docs/architecture.md「虚拟模型 id」一节。
 */

/* ────────────────────────────── 基础枚举 ────────────────────────────── */

/** 全局调度模式；UI 可在运行时切换，覆盖 YAML 的 routing.mode。 */
export type RoutingMode = 'frugal' | 'balanced' | 'max_power' | 'free'

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

/* ────────────────────────────── 六维评分与厂家目录 ────────────────────────────── */

/** 六个评分维度（产品评分表的列）。 */
export type DimensionKey = 'reasoning' | 'longContext' | 'coding' | 'agentic' | 'proWork' | 'factuality'

/** 一维评分：数值与字母评级是彼此独立的事实字段（73.2 可以是 SSS 而 75.0 是 SS）。 */
export interface DimensionScore {
  score: number
  grade: string
}

/** 一个模型的价目（每百万 token）。币种随价格一起携带，绝不混算。 */
export interface ModelPrice {
  input: number
  output: number
}

/** 六维评分集合；六个键一个不能少（见 provider-templates 的 DIMENSION_KEYS）。 */
export type DimensionSet = Record<DimensionKey, DimensionScore>

/** 一个模型在「管家」语义下的完整档案（目录命中或用户覆盖后的最终形态）。 */
export interface ModelInfo {
  id: string
  name: string
  /** SSS ~ D；目录未收录时为 'NA'。 */
  tier: string
  contextWindow: number
  /** null = 未定价，面板显示 —，绝不冒充 0。 */
  costPer1kInput: number | null
  costPer1kOutput: number | null
  /** coding / reasoning / vision / image_gen / tool-use / fast … */
  capabilities: string[]
  scores: DimensionSet
  /** 擅长什么（一句话，目录录入的公开定位）。 */
  strengths?: string
  /** 擅长标签（机器可读，给 AI 调控选路用）。 */
  strengthTags?: string[]
  /** 图片输入（多模态理解）。 */
  imageInput?: boolean
  /** 图片输出（文生图）。 */
  imageOutput?: boolean
  /** 视频输出（文生视频）。 */
  videoOutput?: boolean
  /** 生效价目（目录估算或用户覆盖）；缺省 = 未定价。 */
  price?: ModelPrice
}

/**
 * 一家厂商的面板配置（vendors.json 的一条）。
 * apiKey 是用户在面板里粘贴的明文，只落 0600 的 vendors.json，
 * 永不进入日志、快照与任何过线 JSON（GET 接口只回掩码尾部）。
 */
export interface VendorConfig {
  vendorId: string
  vendorName: string
  /** 目录里的官方 Base URL（Custom 厂商为用户所填）。 */
  officialUrl: string
  /** 中转站 Base URL；只在 endpointSource='relay' 时有意义。 */
  customUrl: string
  /**
   * 这个厂商走哪条线：`official` 用内置官网地址，`relay` 用 customUrl。
   *
   * 二选一而不是「填了就用」——两行同时在场时，用户很容易以为两个都生效，
   * 或者为了拉取模型把官网地址原样再敲一遍。缺省（老数据）按老规则回落。
   */
  endpointSource?: 'official' | 'relay'
  apiKey: string
  /** 用户勾选启用的模型 id（来自 /v1/models 拉取或手填）。 */
  enabledModels: string[]
  /**
   * 上次「拉取模型」的结果快照（id + 显示名）。
   *
   * 拉取是一次性的网络结果，重启就没了；不存下来的话，用户勾过的型号在面板里
   * 只剩一串光秃秃的 id。这里只存清单，不改路由——路由只认 enabledModels。
   */
  pulledModels?: Array<{ id: string, name: string }>
  /** 用户给模型打的擅长标签（modelId → 标签数组），AI 调控可读。 */
  modelTags?: Record<string, string[]>
  /** 用户覆盖的价目（modelId → 每百万 token），优先于目录估算价。 */
  modelPricing?: Record<string, ModelPrice>
}

/**
 * 「从 DSH 已有模型导入」的作用范围。
 *
 * 不给范围 = 把 profile 里所有上游整份搬过来（老行为，模型一多就成了灾难）；
 * 给了就只搬对上的那一家：面板停在谁身上，就只拉谁。
 */
export interface ImportScope {
  /** 面板当前停留的厂家 id（精确匹配 profile 里的 provider 键）。 */
  vendorId?: string
  /** 当前这家实际使用的地址；按它规范化后比对 profile 的 baseURL。 */
  baseUrl?: string
}

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
  /** 单模型并发闸门；balanced 模式的打散上限。 */
  max_concurrency: number
  /** 每分钟请求上限（滑窗）；缺省不限。 */
  rpm?: number
  /**
   * 是否接受对话请求；缺省 true。
   *
   * 中转站的 /v1/models 会把向量与重排模型一起列出来，它们对
   * `chat/completions` 毫无意义。合成池时按 id 识别并置 false，
   * 引擎据此把它们挡在路由之外（仍留在池里可见、可手动改回）。
   */
  chat?: boolean
  /** 0-100 的能力分，legacy 模式的主序；六维评分存在时不再作为主序。 */
  quality_rank: number
  pricing?: PricingTable
  /** 自由标签，面板展示用，不参与路由。 */
  tags: Record<string, string>
  /** ── Token 管家扩展（由 ModelInfo 合成时填入）── */
  tier?: string
  overall?: number
  dimensions?: DimensionSet
  costPer1kInput?: number | null
  costPer1kOutput?: number | null
  /**
   * 零成本是「推定」的：自定义厂家目录里没有，型号也就没有价目。
   * 用户既然把它勾进来，白嫖模式就认它；成本看板仍按未定价记账，不编数字。
   */
  freeAssumed?: boolean
  strengths?: string
  strengthTags?: string[]
  imageInput?: boolean
  imageOutput?: boolean
  videoOutput?: boolean
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
    /** key 是虚拟 id 的后半段：alias 名 → steward:alias/<name>。 */
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
  /** 请求的主评分维度（六维选路的主键）；推断不出时缺省 reasoning。 */
  dimension: DimensionKey
  stream: boolean
  /** 并发打散组：同一批并发请求共享一个 burstKey。 */
  burstKey: string
  /** 虚拟 id 解析出的别名名，用于解释「为什么选了它」。 */
  aliasName?: string
  /**
   * 会话键（session_id / user）。同一会话的连续请求共享它：
   * 路由据此做「模型粘性」，避免每轮换人把前缀缓存和输出风格全部打散。
   */
  conversationKey?: string
  /**
   * 请求档位。`subagent` = 通过 `steward:subagent` 发来的子代理请求：
   * 强制按 agentic 维度打分，并偏好「工具可靠 + 成本可控 + 窗口够大 + 能扛并发」。
   */
  profile?: 'subagent'
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
  /**
   * 本会话上次成功服务的模型对象（同一份配置里的引用）。
   * 打分器命中它时给一点粘性加分：不改变模式的胜负规则，只在接近的候选间
   * 优先沿用同一个模型，保住上游的前缀缓存与输出风格。
   */
  stickyModel?: ModelEntry
}

/** 一次「只排名、不派发」的结果（Agent 选模型 / 面板解释用）。 */
export interface RoutePreview {
  mode: RoutingMode
  /** 已按分数降序；最多 limit 条。 */
  ranked: RouteCandidate[]
  rejected: Array<{ provider: string; model: string; reason: string }>
  notes: string[]
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
  /** 缓存后端（sqlite | memory | off），面板展示用。 */
  cacheBackend?: string
  /** 缓存持久层报的「今日」节省；缺省时用路由引擎的进程内累计。 */
  cacheSavings?: {
    tokens: number
    cost: { currency: string, amount: number } | null
    cacheHits: number
  }
  /** 台账保留天数（宿主配置的真实值，面板如实展示，不写死）。 */
  retentionDays?: number
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
  /** 六维目录的字母评级；legacy 配置为 undefined。 */
  tier?: string
  /** 六维评分；legacy 配置为 undefined，卡片不渲染数值框。 */
  dimensions?: DimensionSet
  strengths?: string
  strengthTags?: string[]
  imageInput?: boolean
  imageOutput?: boolean
  videoOutput?: boolean
  capabilities: CapabilityTag[]
  costLevel: CostLevel
  /** 零成本是推定的（自定义厂家、没有目录价目），面板要如实标注。 */
  freeAssumed?: boolean
  contextWindow: number
  availability: Availability
  /** 只作展示：false 表示它是向量 / 重排模型，不参与对话路由。 */
  chat?: boolean
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

/**
 * 今日已省（面板角标与成本看板的数据源）。
 *
 * 两个来源，分开记、相加时先看币种：
 *  - cache：命中本地响应缓存，没有出站、没有计费；
 *  - routing：选了比「六维总和最高的基准模型」更便宜的模型。
 * 未定价的调用不产生金额，只累计省下的 token 数。
 */
export interface SavingsView {
  /** 缓存命中省下的 token。 */
  tokens: number
  /** 省下的金额；混币或全部未定价时为 null，面板显示 —。 */
  cost: { currency: string; amount: number } | null
  /** 今日缓存命中次数。 */
  cacheHits: number
  /** 缓存后端：sqlite | memory | off。 */
  cacheBackend: string
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
  /** 今日已省（缓存 + 路由）；没有数据时是 0 token / null 金额。 */
  savings: SavingsView
  /** 台账保留天数；宿主未报时为 undefined（面板显示默认值）。 */
  retentionDays?: number
  /** 本次请求携带的网页会话 Cookie（dsh-auth-*）数量；宿主未统计时为 undefined。 */
  authCookies?: number
  pool: { status: 'ok' | 'rejected' | 'loading'; source: string; error?: string }
}

/* ────────────────────────────── 网关协议 ────────────────────────────── */

/** 网关状态文件（$DSH_HOME/token-steward/gateway.json，0600）供面板与用户读取接线参数。 */
export interface GatewayState {
  appliedAt: number
  pid: number
  host: '127.0.0.1'
  port: number
  /** baseURL，直接抄进 llm-pi-ai 的 providers.steward.baseURL。 */
  baseUrl: string
  /** 网关 /v1/models 公布的模型 id（矩阵全集 + 4 个 steward:* 虚拟 id）。 */
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
