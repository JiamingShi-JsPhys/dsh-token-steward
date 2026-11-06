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
import type { CachePolicy, PoolConfig, RouteIntent, RoutingMode, VendorConfig } from '../core/types.ts'
import type { StewardRouter } from '../core/router.ts'
import { inferIntent } from '../core/intent.ts'
import { cacheKeyOf, LruTtlCache, type CachedResponse } from '../core/response-cache.ts'
import { matchTemplateModel, PROVIDER_TEMPLATES } from '../core/provider-templates.ts'
import { dispatch, usageFromBody, type FetchLike } from './upstream.ts'
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
  /** 绑定端口；0 表示由系统分配（默认）。 */
  port?: number
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
  /** 关闭监听（幂等）。 */
  close(): Promise<void>
}

/** 本地令牌的字节数（32 字节 base64url ≈ 43 字符）。 */
const TOKEN_BYTES = 32

/** 请求体上限：8 MiB，超过直接拒绝，避免内存被一个坏请求吃光。 */
const MAX_BODY_BYTES = 8 * 1024 * 1024

/** 生成一个本地令牌。 */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url')
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

/** 网关公布的模型 id 列表：4 个虚拟 id + 矩阵里每个真实模型。 */
export function publishedModelIds(config: PoolConfig | undefined): string[] {
  const ids = ['steward:auto', 'steward:frugal', 'steward:balanced', 'steward:max_power']
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
  const token = generateToken()

  // ── 本地精确响应缓存（routing.cache.exact_match，默认关闭）────────
  // 命中即回放上次响应字节：不出站、不计费、不进健康状态机。
  let cache: LruTtlCache<CachedResponse> | undefined
  let cachePolicyKey = ''
  function cacheFor(policy: CachePolicy): LruTtlCache<CachedResponse> {
    const key = String(policy.max_entries) + ':' + String(policy.ttl_ms)
    if (cache === undefined || cachePolicyKey !== key) {
      cache = new LruTtlCache<CachedResponse>({ maxEntries: policy.max_entries, ttlMs: policy.ttl_ms })
      cachePolicyKey = key
    }
    return cache
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
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({
        object: 'list',
        data: ids.map((id) => ({ id, object: 'model', owned_by: id.startsWith('steward:') ? 'token-steward' : 'upstream' })),
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

    const modelId = typeof body.model === 'string' ? body.model : ''
    if (modelId === '') {
      writeError(res, 400, 'bad-request', 'model is required')
      return
    }

    const router = options.router()
    const clock = now()
    const { intent, route } = inferIntent(body, modelId, clock)
    const requestId = 'stg-' + randomBytes(8).toString('hex')

    // 虚拟 id 的显式意图优先于全局模式：steward:max_power 就是「这次必须最强」。
    if (route.mode !== undefined) router.setMode(route.mode)

    // ── 精确缓存：键含生效模式与流式形状，换模式/换形状天然失效 ──
    const cacheEnabled = config.routing.cache.exact_match
    const cacheKey = cacheEnabled ? cacheKeyOf(body, modelId, router.getMode()) : undefined
    if (cacheKey !== undefined) {
      const hit = cacheFor(config.routing.cache).get(cacheKey, clock)
      if (hit !== undefined && stillServes(config, hit.provider, hit.model)) {
        await replayResponse(res, hit)
        router.noteCacheHit(requestId, hit.provider, hit.model, clock)
        router.noteAgent(agentIdOf(body), hit.provider, hit.model, clock)
        return
      }
    }
    if (route.pin !== undefined) {
      const pinned: RouteIntent = { ...intent, aliasName: 'pin:' + route.pin.provider + '/' + route.pin.model }
      const planned = router.plan(pinned, clock, requestId, [modelKey(route.pin.provider, route.pin.model)])
      await runPlanned(res, config, router, planned, body, requestId, cacheKey)
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
        await runPlanned(res, config, router, planned, body, requestId, cacheKey)
        return
      }
      const widened: RouteIntent = {
        ...intent,
        requiredCapabilities: unique([...intent.requiredCapabilities, ...(alias.require ?? [])]),
        requiredModalities: unique([...intent.requiredModalities, ...(alias.require_modalities ?? [])]),
      }
      await runPlanned(res, config, router, router.plan(widened, clock, requestId), body, requestId, cacheKey)
      return
    }

    // 客户端直接点名一个真实模型 id 时，按直通处理（仍走熔断与计量）。
    const direct = findDirectRoute(config, modelId)
    if (direct !== undefined) {
      const planned = router.plan(intent, clock, requestId, [direct])
      await runPlanned(res, config, router, planned, body, requestId, cacheKey)
      return
    }

    await runPlanned(res, config, router, router.plan(intent, clock, requestId), body, requestId, cacheKey)
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
    const endpoint = target.replace(/\/+$/, '') + '/models'
    try {
      const upstream = await fetchImpl(endpoint, {
        method: 'GET',
        headers: { authorization: 'Bearer ' + key },
        signal: AbortSignal.timeout(15_000),
      })
      if (!upstream.ok) {
        writeError(res, 502, 'upstream-failed', 'upstream /models responded ' + String(upstream.status))
        return
      }
      const body: unknown = await upstream.json()
      const ids = extractModelIds(body)
      if (ids === undefined) {
        writeError(res, 502, 'upstream-failed', 'upstream /models body is not an OpenAI list')
        return
      }
      const template = PROVIDER_TEMPLATES.find((entry) => entry.vendorId === (vendor?.vendorId ?? ''))
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({
        object: 'list',
        vendor: vendorId ?? '',
        data: ids.map((id) => {
          const known = template !== undefined ? matchTemplateModel(template, id) : undefined
          return {
            id,
            object: 'model',
            name: known?.name ?? id,
            tier: known?.tier ?? 'NA',
            inCatalog: known !== undefined,
            owned_by: 'upstream',
          }
        }),
      }))
    } catch (error) {
      writeError(res, 502, 'upstream-failed', 'model discovery failed: ' + messageOf(error))
    }
  }

  /** OpenAI 形状 {data:[{id}]}（也容忍裸数组与 {models:[...]}）。 */
  function extractModelIds(body: unknown): string[] | undefined {
    const list = Array.isArray(body)
      ? body
      : body !== null && typeof body === 'object' && Array.isArray((body as { data?: unknown }).data)
        ? (body as { data: unknown[] }).data
        : body !== null && typeof body === 'object' && Array.isArray((body as { models?: unknown }).models)
          ? (body as { models: unknown[] }).models
          : undefined
    if (list === undefined) return undefined
    const ids: string[] = []
    for (const entry of list) {
      if (entry === null || typeof entry !== 'object') continue
      const id = (entry as { id?: unknown }).id ?? (entry as { name?: unknown }).name
      if (typeof id === 'string' && id !== '') ids.push(id)
    }
    return ids
  }

  async function runPlanned(
    res: ServerResponse,
    config: PoolConfig,
    router: StewardRouter,
    planned: ReturnType<StewardRouter['plan']>,
    body: Record<string, unknown>,
    requestId: string,
    cacheKey?: string,
  ): Promise<void> {
    if (!planned.ok) {
      const status = planned.refusal.code === 'all-models-cooling' ? 503 : 400
      writeError(res, status, planned.refusal.code, summarizeRefusal(planned.refusal.rejected))
      return
    }

    const outcome = await dispatch(
      {
        requestId,
        body,
        stream: body.stream === true,
        secrets: options.secrets(),
        fetchImpl,
        now,
      },
      config,
      planned.decision,
      (result) => {
        router.report(result, now())
        if (result.usage !== undefined && options.ledger !== undefined) {
          options.ledger.recordUsage(result.provider, result.model, result.usage)
        }
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
        (contentType, chunks) => {
          cacheFor(config.routing.cache).put(cacheKey, { chunks, contentType, provider: servingProvider, model: servingModel }, now())
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
    onRecord?: (contentType: string, chunks: Uint8Array[]) => void,
  ): Promise<void> {
    const contentType = response.headers.get('content-type') ?? 'application/json'
    if (!stream || response.body === null) {
      const text = await response.text()
      let usage = undefined
      try {
        usage = usageFromBody(JSON.parse(text))
      } catch {
        usage = undefined
      }
      if (usage !== undefined && options.ledger !== undefined) {
        options.ledger.recordUsage(provider, model, usage)
      }
      res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' })
      res.end(text)
      onRecord?.(contentType, [Buffer.from(text, 'utf8')])
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
          const usage = lastUsageFromSse(buffer)
          buffer = ''
          if (usage !== undefined && options.ledger !== undefined) {
            options.ledger.recordUsage(provider, model, usage)
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
    if (onRecord !== undefined && recorded.length > 0) onRecord(contentType, recorded)
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
    async close() {
      if (closed) return
      closed = true
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
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

/** 把拒绝原因压成一行人话。 */
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
  for (const chunk of hit.chunks) res.write(chunk)
  res.end()
}

/** 从 unknown 里取可读消息。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
