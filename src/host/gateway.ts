/**
 * 本地网关：一个只监听回环地址的 OpenAI 兼容端点。
 *
 * 为什么需要它：DSH 的 llm-pi-ai 适配器在构造 SDK 客户端时就捕获了 fetch，
 * 请求体对扩展是深冻结的（生态插件 dsh-provider-proxy 的架构文档有原文，github.com/apolenkov/dsh-provider-proxy）。
 * 想真正改写「用哪个模型 / 失败换谁 / 怎么计量」，唯一可靠的位置是 HTTP 这一层。
 *
 * 安全边界：
 *  - 只绑 127.0.0.1，端口由系统分配（0），因此不会与任何已有服务抢端口；
 *  - 每次启动生成一个随机本地令牌，客户端必须带 `Authorization: Bearer <token>`；
 *    这不是加密，而是防止本机上其它进程顺手把请求打进矩阵；
 *  - 令牌与端口写进 `$DSH_HOME/token-steward/gateway.json`（0600），
 *    这是 profile 接线时唯一需要读的东西。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { CachePolicy, PoolConfig, RouteIntent, RoutingMode, TokenUsage, VendorConfig } from '../core/types.ts'
import type { StewardRouter } from '../core/router.ts'
import { inferIntent } from '../core/intent.ts'
import { cacheKeyOf } from '../core/response-cache.ts'
import { createMemoryCache, createResponseCache, type CachedResponse, type CacheStatsView, type ResponseCache } from './sqlite-cache.ts'
import { costOfUsage, priceOf } from '../core/pricing.ts'
import { discoverUpstreamModels } from './discovery.ts'
import { dispatch, findRoute, usageFromBody, type FetchLike } from './upstream.ts'
import type { RouteLedgerStore } from './ledger-store.ts'
import { modelKey } from '../core/router.ts'

/** 网关可观测的错误码（与 GatewayErrorCode 对应）。 */
type GatewayCode =
  | 'pool-rejected'
  | 'no-capable-model'
  | 'all-models-cooling'
  | 'upstream-failed'
  | 'committed-then-failed'
  | 'unauthorized'
  | 'bad-request'

/** 网关运行参数。 */
export interface GatewayOptions {
  /** 当前生效配置的读取器；配置热重载后这里返回新对象。 */
  config(): PoolConfig | undefined
  /** 路由引擎。 */
  router(): StewardRouter
  /** 厂家配置（vendors.json）；发现端点用它解析 vendor 参数。 */
  vendors?(): VendorConfig[]
  /** 已展开的凭据（provider → 明文）。 */
  secrets(): Map<string, string>
  /** 路由台账；可为空（未启用持久化时）。 */
  ledger?: RouteLedgerStore
  /** 面板提示：启动日志出口。 */
  log?(level: 'info' | 'warn' | 'error', message: string): void
  /** 注入 fetch（测试用）。 */
  fetchImpl?: FetchLike
  /** 注入时钟（测试用）。 */
  now?(): number
  /**
   * 请求里的虚拟 id 指定了固定模式（管家·极致便宜 等）时通知宿主：
   * 宿主据此把「默认调度模式」同步过去并落盘，面板与 composer 才不会各说各话。
   */
  onMode?(mode: RoutingMode): void
  /** 绑定端口；0 表示由系统分配（默认）。 */
  port?: number
  /** gateway.json 的路径；提供时复用已持久化的令牌（跨重启稳定接线）。 */
  statePath?: string
  /**
   * SQLite 缓存目录；缺省时缓存只存在内存里（测试与老宿主）。
   * 提供时落 `cache.sqlite`，重启仍可命中。
   */
  cacheDirectory?: string
  /**
   * 读取「继承来的」本地令牌用的环境（默认 process.env）。
   * 测试注入用；生产永远走真实进程环境。
   */
  env?: NodeJS.ProcessEnv
}

/** 从既有 gateway.json 里读回令牌（文件缺失或损坏返回 undefined）。 */
async function readPersistedToken(statePath: string | undefined): Promise<string | undefined> {
  if (statePath === undefined) return undefined
  try {
    const text = await readFile(statePath, 'utf8')
    const parsed = JSON.parse(text) as { token?: unknown }
    const token = parsed.token
    if (typeof token === 'string' && token.length >= 32) return token
  } catch {
    // 不存在或损坏 → 生成新令牌。
  }
  return undefined
}

/** 网关句柄。 */
export interface Gateway {
  /** 实际监听端口。 */
  port(): number
  /** 客户端应使用的 baseURL，如 http://127.0.0.1:52331/v1。 */
  baseUrl(): string
  /** 本次启动生成的本地令牌。 */
  token(): string
  /** 当前模式（可被面板改）。 */
  setMode(mode: RoutingMode): RoutingMode
  /** 缓存统计（含今日节省）；缓存关闭时 backend = off。 */
  cacheStats(at?: number): Promise<CacheStatsView>
  /** 关闭监听（幂等）。 */
  close(): Promise<void>
}

/** 本地令牌的字节数（32 字节 base64url ≈ 43 字符）。 */
const TOKEN_BYTES = 32

/** 请求体上限：8 MiB，超过直接拒绝，避免内存被一个坏请求吃光。 */
const MAX_BODY_BYTES = 8 * 1024 * 1024

/**
 * 出站 max_tokens 的硬上限。
 *
 * 客户端（含 DSH 自己）会按「模型很大」发一个远超上游能力的 max_tokens，
 * 中转站直接 400（实测 Agnes：`max_tokens 不能超过 65536`）。各家当前的
 * 输出上限都 ≤ 65536，所以这里统一压到 65536：既不会再被拒，也不会
 * 把正常请求截短。
 */
export const MAX_OUTPUT_CEILING = 65_536

/** 把出站请求的 max_tokens / max_completion_tokens 压到上限之内（原地修改）。 */
export function clampOutputBudget(body: Record<string, unknown>): Record<string, unknown> {
  for (const field of ['max_tokens', 'max_completion_tokens'] as const) {
    const value = body[field]
    if (typeof value === 'number' && Number.isFinite(value) && value > MAX_OUTPUT_CEILING) {
      body[field] = MAX_OUTPUT_CEILING
    }
  }
  return body
}

/** 生成一个本地令牌。 */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

/**
 * DSH profile 里 steward provider 的 `apiKeyEnv`。
 * 插件启动后把自己生成的令牌写进进程环境，llm-pi-ai 靠它取本地凭据。
 */
export const STEWARD_TOKEN_ENV = 'STEWARD_LOCAL_TOKEN'

/** 本地令牌的形状：base64url，至少 32 字符（生成的是 43 字符）。 */
const LOCAL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,}$/

/** 一个值看起来是否像我们发的本地令牌。 */
export function looksLikeLocalToken(value: unknown): value is string {
  return typeof value === 'string' && LOCAL_TOKEN_PATTERN.test(value)
}

/**
 * 启动时选哪把令牌。
 *
 * **继承来的环境变量优先。** 这是 1.1.1 修掉的一个真机故障：DSH 的
 * `llm-pi-ai` 可能在插件 apply 之前就把 `apiKeyEnv` 读进自己的凭据缓存——
 * 那时进程里只有启动时从用户环境继承的 `STEWARD_LOCAL_TOKEN`，插件随后
 * 再写 process.env 已经来不及。只要继承值与 gateway.json 漂移过一次
 * （用户环境变量来自旧令牌、gateway.json 后来重建过），DSH 手里就是一把
 * 旧钥匙，每次请求都被网关 401，界面显示「API 密钥无效 AUTH」。
 *
 * 因此：继承值是合法令牌形状就采用它，网关主动对齐到 DSH 已经拿着的钥匙。
 * 两者从此不可能再漂移；用户环境变量缺失时才回落到持久化令牌。
 */
export function resolveStartupToken(persisted: string | undefined, inherited: string | undefined): string {
  if (looksLikeLocalToken(inherited)) return inherited
  if (looksLikeLocalToken(persisted)) return persisted
  return generateToken()
}

/** 写一个 OpenAI 形状的错误响应。 */
function writeError(res: ServerResponse, status: number, code: GatewayCode, message: string): void {
  if (res.headersSent) {
    res.end()
    return
  }
  const body = JSON.stringify({ error: { type: code, code, message } })
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(body)
}

/** 读请求体，带上限。 */
async function readBody(req: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    total += buffer.length
    if (total > MAX_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** 常量时间比较，避免用长度差异探测令牌。 */
function tokenMatches(expected: string, provided: string): boolean {
  if (expected.length !== provided.length) return false
  let diff = 0
  for (let index = 0; index < expected.length; index += 1) {
    diff |= expected.charCodeAt(index) ^ provided.charCodeAt(index)
  }
  return diff === 0
}

/** 从 Authorization 头里取出 bearer。 */
function bearerOf(req: IncomingMessage): string {
  const header = req.headers.authorization
  if (typeof header !== 'string') return ''
  const match = /^Bearer\s+(.+)$/i.exec(header)
  return match?.[1] ?? ''
}

/**
 * 虚拟 id 的自述（面板与模型发现共用）。
 *
 * DSH 的模型选择界面和「让 Agent 自己挑模型」的提示词都会读这份清单；
 * 只给一串 `steward:xxx`，人和 Agent 都只能瞎猜。给每个虚拟 id 一句
 * 「什么时候用它」，选择才是有依据的。
 */
export const VIRTUAL_MODEL_INFO: Record<string, { name: string, strengths: string, tags: string[] }> = {
  'steward:auto': {
    name: '管家·自动',
    strengths: '跟随当前全局调度档位；不确定用哪个时选它',
    tags: ['auto', 'matrix'],
  },
  'steward:frugal': {
    name: '管家·极致便宜',
    strengths: '在满足硬过滤的 C/D 级型号里选最便宜；改格式、批量杂活、跑测试日志这类活',
    tags: ['cheap', 'frugal'],
  },
  'steward:balanced': {
    name: '管家·效率优先',
    strengths: '任务主维度达 A/A+ 后按质量 0.6 + 成本 0.4 折中；并发请求自动分散到不同上游',
    tags: ['balanced', 'quality-cost', 'spread'],
  },
  'steward:max_power': {
    name: '管家·最强火力',
    strengths: '六维总和最高的型号；难题、长链推理、关键代码、一次做对比省钱重要时',
    tags: ['max-power', 'reasoning', 'quality'],
  },
  'steward:free': {
    name: '管家·白嫖',
    strengths: '只走零成本型号，绝不偷偷切到付费模型；选不到就报错说明原因',
    tags: ['free', 'zero-cost'],
  },
  'steward:subagent': {
    name: '管家·子代理',
    strengths: '子代理专用：按 agentic 能力（0.6）+ 成本（0.4）+ 上下文窗口 + 并发分散自动选型；'
      + '工具调用可靠、能接住父会话的长前缀、一批子代理同时开工时不撞限流。'
      + '把 dsh-tool-subagent 的 agentOptions.model 指到它即可',
    tags: ['subagent', 'tool-use', 'agentic', 'long-context', 'cost-aware', 'spread'],
  },
}

/** 网关对外公布的模型 id 列表：6 个虚拟 id + 矩阵里每个真实模型。 */
export function publishedModelIds(config: PoolConfig | undefined): string[] {
  const ids = [
    'steward:auto',
    'steward:frugal',
    'steward:balanced',
    'steward:max_power',
    'steward:free',
    'steward:subagent',
  ]
  if (config === undefined) return ids
  for (const provider of config.providers) {
    for (const model of provider.models) {
      if (model.availability === 'offline') continue
      ids.push(model.id)
    }
  }
  return ids
}

/**
 * 启动网关。
 * @param options - 配置读取器、路由器、凭据与可注入依赖。
 * @returns 网关句柄；端口已经绑定完毕。
 */
export async function startGateway(options: GatewayOptions): Promise<Gateway> {
  const log = options.log ?? (() => {})
  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init as RequestInit))
  const now = options.now ?? (() => Date.now())

  /** 一次真实出站的用量：台账记一笔，路由引擎据基准模型折算节省。 */
  function recordUsage(provider: string, model: string, usage: TokenUsage): void {
    options.ledger?.recordUsage(provider, model, usage)
    options.router().noteUsage(provider, model, usage, now())
  }
  // 令牌持久化：复用 gateway.json 里已有的令牌（llm-pi-ai 的 apiKeyEnv 是静态
  // 环境变量，令牌换了接线就断）。继承来的环境变量优先——DSH 可能已经把它
  // 读进凭据缓存，网关必须对齐到 DSH 手里那把钥匙，而不是反过来。
  const persisted = await readPersistedToken(options.statePath)
  const inherited = (options.env ?? process.env)[STEWARD_TOKEN_ENV]
  const token = resolveStartupToken(persisted, inherited)
  if (persisted !== undefined && persisted !== token) {
    // 不打印令牌本身，只说明发生了对齐。
    log('info', 'gateway token adopted from ' + STEWARD_TOKEN_ENV + ' (persisted value differed)')
  }

  // ── 本地精确响应缓存（routing.cache.exact_match，默认开启）────────
  // 命中即回放上次响应字节：不出站、不计费、不进健康状态机。
  let activeCache: ResponseCache | undefined
  let cachePolicyKey = ''
  let pendingCache: Promise<ResponseCache> | undefined
  async function cacheFor(policy: CachePolicy): Promise<ResponseCache> {
    const key = String(policy.max_entries) + ':' + String(policy.ttl_ms)
    if (activeCache !== undefined && cachePolicyKey === key) return activeCache
    if (pendingCache !== undefined && cachePolicyKey === key) return await pendingCache
    cachePolicyKey = key
    const previous = activeCache
    const factory = options.cacheDirectory === undefined
      ? Promise.resolve(createMemoryCache(policy))
      : createResponseCache({ directory: options.cacheDirectory, policy })
    pendingCache = factory
    const created = await factory
    if (cachePolicyKey !== key) {
      // 并发热重载：这份策略已过期，关掉它，按新策略重来。
      await created.close().catch(() => {})
      return await cacheFor(policy)
    }
    activeCache = created
    pendingCache = undefined
    if (previous !== undefined) void previous.close().catch(() => {})
    return created
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      log('error', 'gateway handler failed: ' + messageOf(error))
      writeError(res, 500, 'upstream-failed', messageOf(error))
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname.replace(/\/+$/, '')

    // 健康检查不需要令牌：它只回答「进程还活着」，不暴露任何模型信息。
    if (path === '/health' || path === '/v1/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    if (!tokenMatches(token, bearerOf(req))) {
      writeError(res, 401, 'unauthorized', 'missing or invalid local gateway token')
      return
    }

    if (path === '/v1/models' && req.method === 'GET') {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const vendorParam = url.searchParams.get('vendor')
      const baseUrlParam = url.searchParams.get('base_url')
      // 双职责：带 vendor/base_url 参数 = 帮面板探测上游的真实模型列表；
      // 无参数 = 给 llm-pi-ai 的发布清单（虚拟 id + 矩阵全集）。
      if (vendorParam !== null || baseUrlParam !== null) {
        await handleModelDiscovery(res, vendorParam, baseUrlParam, url.searchParams.get('api_key'))
        return
      }
      const config = options.config()
      const ids = publishedModelIds(config)
      // AI 可读：每个模型带擅长描述与标签（真实上游模型才有多余信息）。
      const byId = new Map(config?.providers.flatMap((provider) => provider.models.map((model) => [model.id, model] as const)) ?? [])
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({
        object: 'list',
        data: ids.map((id) => {
          const model = byId.get(id)
          const virtual = VIRTUAL_MODEL_INFO[id]
          return {
            id,
            object: 'model',
            owned_by: id.startsWith('steward:') ? 'token-steward' : 'upstream',
            ...(virtual === undefined ? {} : { name: virtual.name, strengths: virtual.strengths, strength_tags: [...virtual.tags] }),
            ...(model?.strengths !== undefined ? { strengths: model.strengths } : {}),
            ...(model?.strengthTags !== undefined ? { strength_tags: [...model.strengthTags] } : {}),
          }
        }),
      }))
      return
    }

    if (path === '/v1/chat/completions' && req.method === 'POST') {
      await handleCompletions(req, res)
      return
    }

    writeError(res, 404, 'bad-request', 'unknown path ' + path)
  }

  async function handleCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const config = options.config()
    if (config === undefined) {
      writeError(res, 503, 'pool-rejected', 'model pool is not loaded')
      return
    }

    const text = await readBody(req)
    if (text === undefined) {
      writeError(res, 413, 'bad-request', 'request body exceeds ' + String(MAX_BODY_BYTES) + ' bytes')
      return
    }
    let body: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        writeError(res, 400, 'bad-request', 'request body must be a JSON object')
        return
      }
      body = parsed as Record<string, unknown>
    } catch {
      writeError(res, 400, 'bad-request', 'request body is not valid JSON')
      return
    }
    clampOutputBudget(body)

    const modelId = typeof body.model === 'string' ? body.model : ''
    if (modelId === '') {
      writeError(res, 400, 'bad-request', 'model is required')
      return
    }

    const router = options.router()
    const clock = now()
    const { intent, route } = inferIntent(body, modelId, clock)
    const requestId = 'stg-' + randomBytes(8).toString('hex')
    // 这个会话上一轮服务过它的厂商：只有在「换了一家」时才做跨厂商归一化。
    const previousProvider = previousProviderOf(router, intent)

    // 虚拟 id 的显式意图优先于全局模式：steward:max_power 就是「这次必须最强」。
    // 顺手把全局模式同步过去，用户在 composer 里选的模型就是设置页里的那一档。
    if (route.mode !== undefined) {
      router.setMode(route.mode)
      options.onMode?.(route.mode)
    }

    // ── 精确缓存：键含生效模式与流式形状，换模式/换形状天然失效 ──
    const cacheEnabled = config.routing.cache.exact_match
    const cacheKey = cacheEnabled ? cacheKeyOf(body, modelId, router.getMode()) : undefined
    if (cacheKey !== undefined) {
      const hit = await (await cacheFor(config.routing.cache)).get(cacheKey, clock)
      if (hit !== undefined && stillServes(config, hit.provider, hit.model)) {
        await replayResponse(res, hit)
        router.noteCacheHit(requestId, hit.provider, hit.model, clock, {
          tokens: hit.inputTokens + hit.outputTokens,
          cost: hit.savedCost,
        })
        router.noteAgent(agentIdOf(body), hit.provider, hit.model, clock)
        return
      }
    }
    if (route.pin !== undefined) {
      const pinned: RouteIntent = { ...intent, aliasName: 'pin:' + route.pin.provider + '/' + route.pin.model }
      const planned = router.plan(pinned, clock, requestId, [modelKey(route.pin.provider, route.pin.model)])
      await runPlanned(res, config, router, planned, body, requestId, intent, cacheKey, previousProvider)
      return
    }
    if (route.virtual.startsWith('steward:alias/')) {
      const name = route.virtual.slice('steward:alias/'.length)
      const alias = config.routing.aliases[name]
      if (alias === undefined) {
        writeError(res, 400, 'bad-request', 'unknown alias ' + JSON.stringify(name))
        return
      }
      if (alias.mode !== undefined) router.setMode(alias.mode)
      if (alias.pin !== undefined) {
        const planned = router.plan(intent, clock, requestId, [modelKey(alias.pin.provider, alias.pin.model)])
        await runPlanned(res, config, router, planned, body, requestId, intent, cacheKey, previousProvider)
        return
      }
      const widened: RouteIntent = {
        ...intent,
        requiredCapabilities: unique([...intent.requiredCapabilities, ...(alias.require ?? [])]),
        requiredModalities: unique([...intent.requiredModalities, ...(alias.require_modalities ?? [])]),
      }
      await runPlanned(res, config, router, router.plan(widened, clock, requestId), body, requestId, intent, cacheKey, previousProvider)
      return
    }

    // 客户端直接点名一个真实模型 id 时，按直通处理（仍走熔断与计量）。
    const direct = findDirectRoute(config, modelId)
    if (direct !== undefined) {
      const planned = router.plan(intent, clock, requestId, [direct])
      await runPlanned(res, config, router, planned, body, requestId, intent, cacheKey, previousProvider)
      return
    }

    await runPlanned(res, config, router, router.plan(intent, clock, requestId), body, requestId, intent, cacheKey, previousProvider)
  }

  /**
   * 模型发现：向真实上游 GET /models（OpenAI 形状），把结果按目录注上
   * Tier/名称后回给面板勾选。base_url / api_key 参数优先，其次 vendor
   * 参数查 vendors.json。密钥只在本机内存里转一手，绝不写进响应。
   */
  async function handleModelDiscovery(res: ServerResponse, vendorId: string | null, baseUrlParam: string | null, keyParam: string | null): Promise<void> {
    const vendors = options.vendors?.() ?? []
    const vendor = vendorId !== null ? vendors.find((entry) => entry.vendorId === vendorId) : undefined
    if (vendorId !== null && vendor === undefined) {
      writeError(res, 400, 'bad-request', 'unknown vendor ' + JSON.stringify(vendorId))
      return
    }
    const target = baseUrlParam ?? (vendor !== undefined && vendor.customUrl !== '' ? vendor.customUrl : vendor?.officialUrl ?? '')
    const key = keyParam ?? vendor?.apiKey ?? ''
    if (target === '' || key === '') {
      writeError(res, 400, 'bad-request', 'discovery needs base_url and api_key (or a saved vendor with both)')
      return
    }
    try {
      const entries = await discoverUpstreamModels(vendor?.vendorId ?? '', target, key, { fetchImpl })
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ object: 'list', vendor: vendorId ?? '', data: entries }))
    } catch (error) {
      writeError(res, 502, 'upstream-failed', 'model discovery failed: ' + messageOf(error))
    }
  }

    async function runPlanned(
    res: ServerResponse,
    config: PoolConfig,
    router: StewardRouter,
    planned: ReturnType<StewardRouter['plan']>,
    body: Record<string, unknown>,
    requestId: string,
    intent: RouteIntent,
    cacheKey?: string,
    previousProvider?: string,
  ): Promise<void> {
    if (!planned.ok) {
      const status = planned.refusal.code === 'all-models-cooling' ? 503 : 400
      writeError(res, status, planned.refusal.code, refusalMessage(router.getMode(), planned.refusal.rejected))
      return
    }

    const outcome = await dispatch(
      {
        requestId,
        body,
        stream: body.stream === true,
        secrets: options.secrets(),
        ...(previousProvider === undefined ? {} : { previousProvider }),
        fetchImpl,
        now,
      },
      config,
      planned.decision,
      (result) => {
        router.report(result, now())
        if (result.usage !== undefined) recordUsage(result.provider, result.model, result.usage)
      },
    )

    if (!outcome.ok || outcome.response === undefined) {
      writeError(res, 502, 'upstream-failed', outcome.message ?? 'all candidates failed')
      return
    }

    // 记录「谁被选中」：面板的代理协作视图依赖这条。
    router.noteAgent(agentIdOf(body), outcome.provider, outcome.model, now())

    const servingProvider = outcome.provider
    const servingModel = outcome.model
    if (cacheKey !== undefined && config.routing.cache.exact_match) {
      // 干净完成后把响应字节存入缓存；计费仍按真实上游记账（这一次是真的出站了）。
      await relay(outcome.response, res, body.stream === true, servingProvider, servingModel,
        async (contentType, chunks, usage) => {
          const found = findRoute(config, servingProvider, servingModel)
          const tokens = usage ?? { input: intent.estimatedInputTokens, output: intent.expectedOutputTokens }
          const cache = await cacheFor(config.routing.cache)
          await cache.put(cacheKey, {
            body: concatChunks(chunks),
            contentType,
            provider: servingProvider,
            model: servingModel,
            inputTokens: tokens.input,
            outputTokens: tokens.output,
            savedCost: costOfUsage(found === undefined ? null : priceOf(found.model), { input: tokens.input, output: tokens.output }),
          }, now())
        })
      return
    }
    await relay(outcome.response, res, body.stream === true, servingProvider, servingModel)
  }

  /**
   * 把上游响应原样转发给客户端，同时读一遍 usage 记账。
   * @param provider - 真正服务的 provider（计量必须记在它名下）。
   * @param model - 真正服务的模型 id。
   */
  async function relay(
    response: Response,
    res: ServerResponse,
    stream: boolean,
    provider: string,
    model: string,
    onRecord?: (contentType: string, chunks: Uint8Array[], usage?: TokenUsage) => void | Promise<void>,
  ): Promise<void> {
    const contentType = response.headers.get('content-type') ?? 'application/json'
    if (!stream || response.body === null) {
      const text = await response.text()
      let usage: TokenUsage | undefined
      try {
        usage = usageFromBody(JSON.parse(text))
      } catch {
        usage = undefined
      }
      if (usage !== undefined) recordUsage(provider, model, usage)
      res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' })
      res.end(text)
      await onRecord?.(contentType, [Buffer.from(text, 'utf8')], usage)
      return
    }

    res.writeHead(200, {
      'content-type': contentType,
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let usage: TokenUsage | undefined
    const recorded: Uint8Array[] = onRecord === undefined ? [] : []
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        res.write(value)
        if (onRecord !== undefined) recorded.push(value.slice())
        // 只在缓冲增长时扫一次 usage，扫描成本与帧数无关。
        if (buffer.includes('"usage"')) {
          const parsed = lastUsageFromSse(buffer)
          buffer = ''
          if (parsed !== undefined) {
            usage = parsed
            recordUsage(provider, model, parsed)
          }
        } else if (buffer.length > 256 * 1024) {
          buffer = ''
        }
      }
    } catch (error) {
      log('warn', 'relay interrupted: ' + messageOf(error))
      // 中断的流不完整，不进缓存。
      return
    } finally {
      res.end()
    }
    if (recorded.length > 0) await onRecord?.(contentType, recorded, usage)
  }

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('gateway failed to bind a TCP port'))
        return
      }
      resolve(address.port)
    })
  })

  log('info', 'gateway listening on http://127.0.0.1:' + String(port) + '/v1')

  let closed = false
  return {
    port: () => port,
    baseUrl: () => 'http://127.0.0.1:' + String(port) + '/v1',
    token: () => token,
    setMode: (mode) => options.router().setMode(mode),
    async cacheStats(at = now()) {
      // 缓存开启但还没有第一个请求时，也要如实报告后端（sqlite/memory），
      // 否则面板会误显示「缓存关闭」。
      const policy = options.config()?.routing.cache
      if (policy?.exact_match === true) {
        const cache = await cacheFor(policy)
        return await cache.stats(at)
      }
      return { backend: 'off' as const, hits: 0, misses: 0, size: 0, evictions: 0, savedTokens: 0, savedCost: null, cacheHitsToday: 0 }
    },
    async close() {
      if (closed) return
      closed = true
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      if (activeCache !== undefined) {
        const cache = activeCache
        activeCache = undefined
        await cache.close().catch(() => {})
      }
    },
  }
}

/** 去重但保序。 */
function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

/** 客户端直接点名真实模型时返回它的 key。 */
function findDirectRoute(config: PoolConfig, modelId: string): string | undefined {
  for (const provider of config.providers) {
    for (const model of provider.models) {
      if (model.id === modelId) return modelKey(provider.provider_name, model.id)
    }
  }
  return undefined
}

/** 从请求体里取 agent 身份线索，没有就用 'unknown'。 */
function agentIdOf(body: Record<string, unknown>): string {
  const hint = body.user ?? body.session_id
  return typeof hint === 'string' && hint !== '' ? hint : 'unknown'
}

/**
 * 这个会话上一轮真正服务的 provider。
 *
 * 路由引擎的粘性表记的是 `provider/model`；取第一段作为「上一家」。
 * 没有记录（新会话 / 上一轮没成功）就返回 undefined——此时不需要做
 * 跨厂商归一化，也不该假装有。
 */
function previousProviderOf(router: StewardRouter, intent: RouteIntent): string | undefined {
  const previous = router.affinityOf(intent.conversationKey, intent.profile)
  if (previous === undefined) return undefined
  const slash = previous.indexOf('/')
  return slash > 0 ? previous.slice(0, slash) : undefined
}

/** 把拒绝原因压成一行人话。 */
/**
 * 拒绝原因 + 一句「下一步该干什么」。
 *
 * 白嫖模式最容易被误解：用户勾了一堆模型却全被 `not-free` 挡回来，
 * 报错里只有「agnes/agnes-3.0-flash: not-free」，看不出是**模式**在挑人。
 * 这里把该去面板做什么直接写在错误里。
 */
export function refusalMessage(
  mode: string,
  rejected: Array<{ provider: string; model: string; reason: string }>,
): string {
  const base = summarizeRefusal(rejected)
  if (mode !== 'free') return base
  const allNotFree = rejected.length > 0 && rejected.every((entry) => entry.reason === 'not-free')
  if (rejected.length > 0 && !allNotFree) return base
  return base + '｜白嫖模式只跑零成本模型：去「厂家设置」把要用的型号价目填 0（或勾选名字带 free 的免费型号）再保存'
}

function summarizeRefusal(rejected: Array<{ provider: string; model: string; reason: string }>): string {
  if (rejected.length === 0) return 'no model satisfies this request'
  const head = rejected.slice(0, 3).map((entry) => entry.provider + '/' + entry.model + ': ' + entry.reason).join('; ')
  return rejected.length <= 3 ? head : head + ' (+' + String(rejected.length - 3) + ' more)'
}

/** 从 SSE 缓冲里取最后一条 usage。 */
export function lastUsageFromSse(text: string): ReturnType<typeof usageFromBody> {
  const lines = text.split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? ''
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload === '' || payload === '[DONE]') continue
    try {
      const parsed: unknown = JSON.parse(payload)
      const usage = usageFromBody(parsed)
      if (usage !== undefined) return usage
    } catch {
      // 半截帧：跳过。
    }
  }
  return undefined
}

/** 缓存命中的模型必须仍在矩阵里且没被用户下线，否则按未命中处理。 */
function stillServes(config: PoolConfig, provider: string, model: string): boolean {
  for (const entry of config.providers) {
    if (entry.provider_name !== provider) continue
    for (const candidate of entry.models) {
      if (candidate.id !== model) continue
      return candidate.availability !== 'offline'
    }
  }
  return false
}

/** 原样回放一份缓存的响应字节（形状由键保证与请求一致）。 */
async function replayResponse(res: ServerResponse, hit: CachedResponse): Promise<void> {
  const headers: Record<string, string> = { 'content-type': hit.contentType, 'cache-control': 'no-store' }
  if (hit.contentType.includes('text/event-stream')) {
    headers.connection = 'keep-alive'
    headers['x-accel-buffering'] = 'no'
  }
  res.writeHead(200, headers)
  res.write(hit.body)
  res.end()
}

/** 把分块读到的响应拼成一个可回放的字节串。 */
function concatChunks(chunks: Uint8Array[]): Uint8Array {
  let total = 0
  for (const chunk of chunks) total += chunk.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/** 从 unknown 里取可读消息。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
