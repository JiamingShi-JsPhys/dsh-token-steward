/**
 * dsh-token-steward · Host 半区。
 *
 * 一次 apply 只做三件事，且都可被 ctx.effect 干净回收：
 *  1. 把 model_pool.yaml 读成矩阵，建路由引擎，起本地网关；
 *  2. 把面板要的四条 HTTP 路由挂到宿主 webServer 上；
 *  3. 把网关接线参数写进 $DSH_HOME/token-steward/gateway.json，
 *     并盯着 model_pool.yaml 的改动做热重载。
 *
 * 设计上刻意如此：所有判断都在 core/ 的纯函数里，所有 IO 都在 host/ 的
 * 薄壳里，本文件只负责把它们串起来并在出错时降级（而不是让插件加载失败）。
 *
 * 一条纪律：**本插件永远不该让宿主起不来**。配置坏了、端口占不到、yaml 解不了，
 * 都只是「本插件不可用」，宿主该照常工作。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { access, mkdir, readFile, readdir } from 'node:fs/promises'

import { createPoolFileLoader } from './host/pool-file.ts'
import { createVendorStore, coerceVendorsList, maskKey, type VendorsDocument } from './host/vendor-store.ts'
import { harnessProviders, harnessVendor, mergeImportedVendors, selectHarnessProviders, type HarnessProvider } from './host/harness-import.ts'
import { HARNESS_DEFAULT_MAX_TOKENS, resolveSyncVendorId, syncInputFromVendor, upsertHarnessProvider, type HarnessSyncInput } from './host/harness-sync.ts'
import { discoverUpstreamModels } from './host/discovery.ts'
import { executeStewardAction, STEWARD_TOOL_PARAMETERS, type StewardActionArgs, type StewardToolDeps } from './host/agent-tools.ts'
import { synthesizePool, templateVendors, vendorEndpoint, vendorIsRoutable } from './core/vendors.ts'
import { DEFAULT_CACHE } from './core/pool-schema.ts'
import { createPoolWatcher } from './host/pool-watch.ts'
import { createRouteLedgerStore } from './host/ledger-store.ts'
import { createRouter, type StewardRouter } from './core/router.ts'
import { credentialKind, resolveCredential } from './host/credentials.ts'
import { startGateway, type Gateway } from './host/gateway.ts'
import { makePanelRoutes } from './host/routes.ts'
import { readUsageProjection } from './host/usage-bridge.ts'
import { writeFileAtomic } from './host/atomic-file.ts'
import type { GatewayState, ImportScope, PoolConfig, RoutingMode } from './core/types.ts'

/**
 * profile 里 steward provider 的 `apiKeyEnv`。插件启动时要把它写进进程环境，
 * 否则 DSH 会把「管家」当成一家没有密钥的上游，从模型菜单里整个藏起来。
 */
export const STEWARD_TOKEN_ENV = 'STEWARD_LOCAL_TOKEN'

/** 插件名（cordis 行 id 与日志前缀）。 */
export const name = 'token-steward'

/** 必需服务：HTTP 载体。llm 不 inject——没有模型的部署也该能挂载插件。 */
export const inject = ['webServer']

/** 配置形状（schemastery 由宿主注入，这里只声明读到的字段）。 */
export interface StewardConfigFields {
  enabled?: unknown
  poolPath?: unknown
  retainDays?: unknown
  usagePollMs?: unknown
  gatewayPort?: unknown
}

/** 解析后的配置。 */
export interface ResolvedConfig {
  enabled: boolean
  poolPath: string
  retainDays: number
  usagePollMs: number
  gatewayPort: number
}

/** 默认保留天数。 */
const DEFAULT_RETAIN_DAYS = 180

/** 默认计量轮询间隔。 */
const DEFAULT_USAGE_POLL_MS = 15_000

/** 默认网关端口：0 表示由系统分配。 */
const DEFAULT_GATEWAY_PORT = 0

/** 从配置字段里读字符串（可能是 volatile 引用）。 */
function readString(field: unknown): string | undefined {
  const value = readField(field)
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** 从配置字段里读数字。 */
function readNumber(field: unknown, fallback: number): number {
  const value = readField(field)
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 从配置字段里读布尔。 */
function readBoolean(field: unknown, fallback: boolean): boolean {
  const value = readField(field)
  return typeof value === 'boolean' ? value : fallback
}

/** 跟随 volatile 引用取当前值。 */
function readField(field: unknown): unknown {
  if (field !== null && typeof field === 'object' && typeof (field as { get?: unknown }).get === 'function') {
    return (field as { get: () => unknown }).get()
  }
  return field
}

/** $DSH_HOME 的解析：与宿主其它插件一致，缺省 ~/.dsh。 */
export function dshHome(): string {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  return join(homedir(), '.dsh')
}

/** 本插件的数据目录。 */
export function dataDirectory(): string {
  return join(dshHome(), 'token-steward')
}

/** 解析配置。 */
export function resolveConfig(config?: StewardConfigFields): ResolvedConfig {
  return {
    enabled: readBoolean(config?.enabled, true),
    poolPath: readString(config?.poolPath) ?? join(dataDirectory(), 'model_pool.yaml'),
    retainDays: Math.max(1, Math.round(readNumber(config?.retainDays, DEFAULT_RETAIN_DAYS))),
    usagePollMs: Math.max(2_000, Math.round(readNumber(config?.usagePollMs, DEFAULT_USAGE_POLL_MS))),
    gatewayPort: Math.max(0, Math.round(readNumber(config?.gatewayPort, DEFAULT_GATEWAY_PORT))),
  }
}

/**
 * 只在 llm-pi-ai.providers 下写一条 provider，其余内容（含注释）原样保留。
 *
 * 用 `yaml` 的 parseDocument：它把注释挂在节点上，toString 会带着走。
 * 拿不到这个模块就返回 undefined，调用方退回「解析成对象再整体序列化」的老路
 * （那条路会丢注释，所以只作兜底）。
 */
async function writeProviderPreservingComments(text: string, input: HarnessSyncInput & { apiKey: string }): Promise<string | undefined> {
  type Node = {
    items?: Node[]
    contents?: Node
    get?: (key: string) => unknown
    set?: (key: string, value: unknown) => void
    toString?: () => string
  }
  try {
    const module = await import('yaml') as { parseDocument?: (text: string) => Node & { createNode?: (value: unknown) => unknown, toString?: () => string } }
    if (typeof module.parseDocument !== 'function') return undefined
    const doc = module.parseDocument(text)
    const root = doc.contents
    if (root === undefined) return undefined
    const entries: Node[] = Array.isArray(root.items) ? root.items : []
    const findIn = (node: Node): unknown => (typeof node.get === 'function' ? node.get('name') : undefined)
    let entry = entries.find((item) => String(findIn(item) ?? '').endsWith('llm-pi-ai'))
    if (entry !== undefined) {
      const config = entry.get?.('config') as Node | undefined
      if (config === undefined || typeof config.get !== 'function') return undefined
      let providers = config.get('providers') as Node | undefined
      if (providers === undefined || typeof providers.set !== 'function') {
        providers = doc.createNode?.({}) as Node
        config.set?.('providers', providers)
      }
      const existing = providers.get?.(input.vendorId) as Node | undefined
      const current = existing !== undefined && typeof existing.get === 'function' ? existing : undefined
      const models = input.models.length > 0
        ? input.models
        : (current?.get?.('models') as unknown[] | undefined) ?? []
      const next: Record<string, unknown> = {
        displayName: input.vendorName,
        api: current?.get?.('api') ?? 'openai-completions',
        baseURL: input.baseUrl,
        models,
        // llm-pi-ai 缺省的 128000 比很多上游的真实上限还大（直连 Agnes 就是 400）。
        defaultMaxTokens: (current?.get?.('defaultMaxTokens') as number | undefined) ?? HARNESS_DEFAULT_MAX_TOKENS,
      }
      if (input.apiKey !== '') {
        // 写明文密钥，但保留 apiKeyEnv：DSH 只认 apiKeyEnv 指向的凭据，
        // 删掉它这家上游就彻底没有密钥了（`apiKey` 是给我们自己回读的）。
        next.apiKey = input.apiKey
        const keptEnv = current?.get?.('apiKeyEnv')
        if (typeof keptEnv === 'string' && keptEnv !== '') next.apiKeyEnv = keptEnv
      } else {
        // 留空 = 保留原来的密钥；原来用的是环境变量就继续用环境变量。
        const keptKey = current?.get?.('apiKey')
        const keptEnv = current?.get?.('apiKeyEnv')
        if (typeof keptKey === 'string' && keptKey !== '') next.apiKey = keptKey
        else if (typeof keptEnv === 'string' && keptEnv !== '') next.apiKeyEnv = keptEnv
      }
      providers.set?.(input.vendorId, doc.createNode?.(next) as never)
      return doc.toString?.()
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * YAML 编解码器的惰性加载：宿主自带 yaml，取不到时给出可读失败。
 *
 * 反向同步要写回 profile，所以这里比只读路径多要一个 stringify/dump。
 */
async function loadYamlCodec(): Promise<{ parse: (text: string) => unknown, stringify: (value: unknown) => string }> {
  const candidates = ['yaml', 'js-yaml']
  for (const specifier of candidates) {
    try {
      const module = await import(specifier) as {
        parse?: (text: string) => unknown
        stringify?: (value: unknown) => string
        dump?: (value: unknown) => string
        default?: { parse?: (text: string) => unknown, stringify?: (value: unknown) => string, dump?: (value: unknown) => string }
      }
      const parse = module.parse ?? module.default?.parse
      const stringify = module.stringify ?? module.dump ?? module.default?.stringify ?? module.default?.dump
      if (typeof parse === 'function' && typeof stringify === 'function') {
        return { parse: (text: string) => parse(text), stringify: (value: unknown) => stringify(value) }
      }
    } catch {
      // 下一个候选。
    }
  }
  throw new Error('no YAML codec available (expected the host to provide "yaml" or "js-yaml")')
}

/** 只读路径用的解码器；拿不到编解码器时返回一个会抛错的桩。 */
async function loadYamlDecoder(): Promise<(text: string) => unknown> {
  try {
    return (await loadYamlCodec()).parse
  } catch {
    return () => { throw new Error('no YAML decoder available (expected the host to provide "yaml" or "js-yaml")') }
  }
}

/**
 * 挂载插件。
 * @param ctx - 宿主上下文。
 * @param config - 行配置。
 */
export async function apply(ctx: {
  logger?: (name: string) => { info(...args: unknown[]): void, warn(...args: unknown[]): void, error(...args: unknown[]): void }
  webServer?: { register(route: unknown): () => void }
  effect?: (fn: () => () => void, label?: string) => void
  /** 可选服务探测（tools / skills 等按需获取）。 */
  get?<T = unknown>(name: string): T | undefined
}, config?: StewardConfigFields): Promise<void> {
  // 落盘自诊断第一站：Desktop 宿主不捕获 stdout，apply 是否被调用、在哪一步
  // 失败，只有写进文件才能从外部看见（provider-proxy 的 state.json 同款）。
  try {
    const { mkdir } = await import('node:fs/promises')
    const dir = join(dataDirectory())
    await mkdir(dir, { recursive: true })
    await writeFileAtomic(join(dir, 'state.json'), JSON.stringify({ appliedAt: Date.now(), pid: process.pid, status: 'mounting' }, null, 2) + String.fromCharCode(10))
  } catch {
    // 诊断写不进去也不阻断挂载。
  }
  const settings = resolveConfig(config)
  const log = ctx.logger?.('token-steward') ?? { info() {}, warn() {}, error() {} }
  if (!settings.enabled) {
    log.info('disabled by configuration; nothing mounted')
    return
  }

  const directory = dataDirectory()
  await mkdir(directory, { recursive: true }).catch(() => {})

  // ── 配置（vendors.json 优先，model_pool.yaml 作为高级回退）───
  const decode = await loadYamlDecoder()
  const loader = createPoolFileLoader(settings.poolPath, decode)
  await loader.load(Date.now())
  const vendorStore = createVendorStore(directory)
  let vendorDoc: VendorsDocument = await vendorStore.load()
  let usingVendors = vendorDoc.vendors.length > 0
  let configValue: PoolConfig | undefined = currentPool()
  let router: StewardRouter | undefined = configValue === undefined ? undefined : createRouter(configValue)

  /** 当前生效配置：厂家面板有内容时以 vendors.json 合成，否则回退 yaml。 */
  function currentPool(): PoolConfig | undefined {
    return usingVendors
      ? synthesizePool(vendorDoc.vendors, vendorDoc.mode, DEFAULT_CACHE)
      : loader.current()
  }

  /**
   * 面板保存厂家配置；apiKey 为空串表示保留已存明文。
   *
   * **只合并、不整表替换**：面板手里的列表可能是一份旧快照，整表写回会把
   * 它没见过的厂家（比如刚被别处加进来的）悄悄删掉。删除是另一个显式动作
   * （deleteVendor），不该由「保存」顺带完成。
   */
  async function saveVendors(mode: RoutingMode, input: unknown): Promise<{ ok: boolean, error?: string }> {
    const incoming = coerceVendorsList(input)
    const byId = new Map(vendorDoc.vendors.map((vendor) => [vendor.vendorId, vendor] as const))
    for (const vendor of incoming) {
      const existing = byId.get(vendor.vendorId)
      byId.set(vendor.vendorId, { ...vendor, apiKey: vendor.apiKey !== '' ? vendor.apiKey : (existing?.apiKey ?? '') })
    }
    const merged = [...byId.values()]
    vendorDoc = { version: vendorDoc.version, mode, vendors: merged }
    await vendorStore.save(vendorDoc)
    usingVendors = vendorDoc.vendors.length > 0
    configValue = currentPool()
    router = configValue === undefined ? undefined : createRouter(configValue, undefined, router?.getMode())
    await refreshSecrets()
    log.info('vendors saved (%d configured, %d routable)', merged.length, merged.filter(vendorIsRoutable).length)
    return { ok: true }
  }

  /** 删掉一家厂家（显式动作，和保存分开：保存永远不删东西）。 */
  async function deleteVendor(vendorId: string): Promise<{ ok: boolean, error?: string }> {
    const next = vendorDoc.vendors.filter((vendor) => vendor.vendorId !== vendorId)
    if (next.length === vendorDoc.vendors.length) return { ok: false, error: '没有这家厂家' }
    vendorDoc = { ...vendorDoc, vendors: next }
    await vendorStore.save(vendorDoc)
    usingVendors = vendorDoc.vendors.length > 0
    configValue = currentPool()
    router = configValue === undefined ? undefined : createRouter(configValue, undefined, router?.getMode())
    await refreshSecrets()
    log.info('vendor %s removed', vendorId)
    return { ok: true }
  }

  /**
   * 把 DSH profile 里已经配好的上游抓过来。
   *
   * 用户早在 profile 里填过 Base URL / 密钥 / 模型清单，面板不该再问一遍。
   * 只读 `llm-pi-ai` 的 providers，跳过我们自己的 steward 网关。
   *
   * `scope` 来自面板：用户停在哪家就只拉哪家。不传才是整份导入——profile 里
   * 上游一多，一次全搬会把几十上百个模型一起塞进白嫖池，没人想要那个。
   */
  async function importFromHarness(scope?: ImportScope): Promise<{ ok: boolean, imported: string[], error?: string }> {
    const files = await harnessPatchFiles()
    if (files.length === 0) {
      return { ok: false, imported: [], error: '没有找到 DSH 的 profile 配置（cordis.patch.yml）' }
    }
    const collected = new Map<string, HarnessProvider>()
    for (const file of files) {
      try {
        const text = await readFile(file, 'utf8')
        for (const provider of harnessProviders(decode(text))) collected.set(provider.vendorId, provider)
      } catch (error) {
        log.warn('import: %s: %s', file, error instanceof Error ? error.message : String(error))
      }
    }
    if (collected.size === 0) {
      return { ok: false, imported: [], error: 'profile 里没有可导入的模型配置' }
    }
    const picked = selectHarnessProviders([...collected.values()], scope)
    if (picked.length === 0) {
      return {
        ok: false,
        imported: [],
        error: scope?.baseUrl !== undefined && scope.baseUrl !== ''
          ? '系统模型设置里没有地址是 ' + scope.baseUrl + ' 的上游'
          : '系统模型设置里没有这家上游',
      }
    }
    const incoming = picked.map((provider) => harnessVendor(provider, process.env))
    const merged = mergeImportedVendors(vendorDoc.vendors, incoming)
    vendorDoc = { version: vendorDoc.version, mode: vendorDoc.mode, vendors: merged }
    await vendorStore.save(vendorDoc)
    usingVendors = vendorDoc.vendors.length > 0
    configValue = currentPool()
    router = configValue === undefined ? undefined : createRouter(configValue, undefined, router?.getMode())
    await refreshSecrets()
    log.info('imported %d providers from DSH profiles', incoming.length)
    return { ok: true, imported: incoming.map((vendor) => vendor.vendorId) }
  }

  /**
   * 反向同步：把管家里的这家厂家写回 DSH 的系统模型设置。
   *
   * 用户在管家里勾好的型号，只有写回 profile 才会出现在 DSH 的模型菜单里。
   * 只动 llm-pi-ai.providers 下同 id 的那一条，其余内容原样保留。
   */
  async function syncToHarness(vendorId: string): Promise<{ ok: boolean, file?: string, models?: number, error?: string }> {
    const vendor = vendorDoc.vendors.find((entry) => entry.vendorId === vendorId)
    if (vendor === undefined) return { ok: false, error: '这家厂家还没保存，先保存一次再同步' }
    if (vendor.enabledModels.length === 0) return { ok: false, error: '这家厂家还没勾选任何模型' }
    const files = await harnessPatchFiles()
    if (files.length === 0) return { ok: false, error: '没有找到 DSH 的 profile 配置（cordis.patch.yml）' }
    const file = files[0] as string
    let codec: Awaited<ReturnType<typeof loadYamlCodec>>
    try {
      codec = await loadYamlCodec()
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
    try {
      const text = await readFile(file, 'utf8')
      const literalKey = credentialKind(vendor.apiKey) === 'unknown' || credentialKind(vendor.apiKey) === 'literal'
        ? vendor.apiKey.replace(/^literal:/, '')
        : ''
      const input = syncInputFromVendor(vendor, vendorEndpoint(vendor))
      // 写回时按地址认领已有的 provider 键：同 id 不在、但地址一样的，就地更新，
      // 别在同一份 profile 里留两份同一家上游。
      const targetId = resolveSyncVendorId(codec.parse(text), input.vendorId, input.baseUrl)
      const payload = { ...input, vendorId: targetId, apiKey: literalKey }
      // 优先用能保住注释的写法：profile 是用户手写的，重排+丢注释等于毁了他的配置。
      const written = await writeProviderPreservingComments(text, payload)
      if (written !== undefined) await writeFileAtomic(file, written)
      else {
        const doc = codec.parse(text)
        upsertHarnessProvider(doc, payload)
        await writeFileAtomic(file, codec.stringify(doc))
      }
      log.info('vendor %s synced to %s (%d models)', vendorId, file, input.models.length)
      return { ok: true, file, models: input.models.length }
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
  }

  /** profile 里的 cordis.patch.yml（desktop 优先，其余 profile 一并扫）。 */
  async function harnessPatchFiles(): Promise<string[]> {
    const profiles = join(dshHome(), 'profiles')
    const candidates = [join(profiles, 'desktop', 'cordis.patch.yml')]
    try {
      for (const name of await readdir(profiles)) {
        const file = join(profiles, name, 'cordis.patch.yml')
        if (!candidates.includes(file)) candidates.push(file)
      }
    } catch {
      // profile 目录不存在就算了，下面统一做存在性检查。
    }
    const existing: string[] = []
    for (const file of candidates) {
      try {
        await access(file)
        existing.push(file)
      } catch {
        // 跳过不存在的 profile。
      }
    }
    return existing
  }

  /** 配置变了就重建路由引擎；失败时保留旧引擎。 */
  async function reload(now: number): Promise<{ ok: boolean, status: string, error?: string }> {
    vendorDoc = await vendorStore.load()
    usingVendors = vendorDoc.vendors.length > 0
    if (usingVendors) {
      configValue = currentPool()
      router = configValue === undefined ? undefined : createRouter(configValue, undefined, router?.getMode())
      await refreshSecrets()
      return { ok: true, status: 'ok' }
    }
    const result = await loader.load(now)
    if (result.ok && result.config !== undefined) {
      configValue = result.config
      router = createRouter(configValue, undefined, router?.getMode())
      for (const warning of result.warnings) log.warn('config: %s', warning)
    }
    const state = loader.state()
    return state.error === undefined
      ? { ok: result.ok, status: state.status }
      : { ok: result.ok, status: state.status, error: state.error }
  }

  // ── 凭据（只在内存）──────────────────────────────────────
  let secrets = new Map<string, string>()
  async function refreshSecrets(): Promise<void> {
    const next = new Map<string, string>()
    if (configValue === undefined) {
      secrets = next
      return
    }
    for (const provider of configValue.providers) {
      // 厂家合成的条目走 vendors.json 的明文（sentinel 不是凭据引用）。
      if (provider.api_key.startsWith('steward-vendor:')) continue
      const resolved = await resolveCredential(provider.api_key)
      if (resolved.ok) next.set(provider.provider_name, resolved.secret)
      else log.warn('provider %s: %s', provider.provider_name, resolved.reason)
    }
    for (const vendor of vendorDoc.vendors) {
      if (vendor.apiKey === '') continue
      // 双语义：env:/file:/literal: 引用走解析器；面板粘贴的明文直接使用。
      if (credentialKind(vendor.apiKey) === 'unknown') {
        next.set(vendor.vendorId, vendor.apiKey)
        continue
      }
      const resolved = await resolveCredential(vendor.apiKey)
      if (resolved.ok) next.set(vendor.vendorId, resolved.secret)
      else log.warn('vendor %s: %s', vendor.vendorId, resolved.reason)
    }
    secrets = next
  }
  await refreshSecrets()

  // ── 台账 ────────────────────────────────────────────────
  const ledger = createRouteLedgerStore(directory, undefined, settings.retainDays)
  await ledger.load()

  // ── 计量（只在面板轮询时读，避免常驻 IO）──────────────────
  let usageCache = { at: 0, available: false, facts: {} as Record<string, unknown>, dateKey: '' }
  async function usageNow(now: number): Promise<typeof usageCache> {
    if (now - usageCache.at < settings.usagePollMs) return usageCache
    const projection = await readUsageProjection(dshHome(), now)
    usageCache = {
      at: now,
      available: projection.available,
      facts: projection.facts as unknown as Record<string, unknown>,
      dateKey: projection.dateKey,
    }
    return usageCache
  }

  // ── 网关 ────────────────────────────────────────────────
  let gateway: Gateway | undefined
  const statePath = join(directory, 'gateway.json')
  if (router !== undefined) {
    try {
      gateway = await startGateway({
        config: () => configValue,
        router: () => router as StewardRouter,
        vendors: () => vendorDoc.vendors,
        secrets: () => secrets,
        ledger,
        log: (level, message) => { log[level]('%s', message) },
        port: settings.gatewayPort,
        statePath,
        // SQLite 响应缓存落在插件数据目录：重启后仍可命中，命中即 0 token。
        cacheDirectory: directory,
        // composer 里选了「管家·极致便宜」这类模型 → 默认模式跟着改并落盘。
        onMode: (mode) => {
          if (vendorDoc.mode === mode) return
          vendorDoc = { ...vendorDoc, mode }
          void vendorStore.save(vendorDoc).catch((error: unknown) => {
            log.warn('cannot persist mode: %s', error instanceof Error ? error.message : String(error))
          })
        },
      })
      // DSH 的 steward provider 用 `apiKeyEnv: STEWARD_LOCAL_TOKEN` 取本地令牌。
      // 令牌是网关自己生成的，只有我们手里有——必须由我们写进进程环境。
      // 指望用户手工 export 是不可靠的：换个启动方式（比如从另一个 shell 拉起）
      // 变量就不在了，DSH 会认为这家没有密钥，直接把「管家」从模型菜单里藏掉。
      process.env[STEWARD_TOKEN_ENV] = gateway.token()
      const state: GatewayState = {
        appliedAt: Date.now(),
        pid: process.pid,
        host: '127.0.0.1',
        port: gateway.port(),
        baseUrl: gateway.baseUrl(),
        modelIds: gatewayModelIds(configValue),
        token: gateway.token(),
      }
      await writeFileAtomic(statePath, JSON.stringify(state, null, 2) + '\n')
      log.info('gateway ready at %s (%d models)', state.baseUrl, state.modelIds.length)
    } catch (error) {
      // 端口占不到之类的失败：插件仍挂载，面板会显示「网关未启动」。
      log.error('gateway failed to start: %s', messageOf(error))
      gateway = undefined
    }
  } else {
    log.warn('no usable model pool at %s; gateway not started', settings.poolPath)
  }

  // ── 面板路由 ────────────────────────────────────────────
  const disposers: Array<() => void> = []
  if (ctx.webServer !== undefined) {
    // 内置头像随包发布（assets/avatars），由同源路由提供，浏览器无需跨域。
    const avatarDirectory = fileURLToPath(new URL('../assets/avatars', import.meta.url))
    const routes = makePanelRoutes({
      snapshot: async () => {
        const now = Date.now()
        // 先按 usagePollMs 节流地刷一次计量，再组快照：面板拿到的永远是最新一版，
        // 而不是「上一次轮询的那一版」。绝不能只在 apply 时预热一次——那样
        // dsh-usage 在启动之后写入的数据将永远不可见。
        await usageNow(now)
        const poolState = usingVendors
          ? { status: 'ok' as const, source: 'vendors.json' }
          : loader.state()
        const cache = gateway === undefined ? undefined : await gateway.cacheStats(now)
        if (router === undefined) return emptySnapshot(now, poolState)
        return router.snapshot(now, {
          usage: usageCache.facts as never,
          usageAvailable: usageCache.available,
          pool: poolState,
          retentionDays: settings.retainDays,
          ...(cache === undefined
            ? {}
            : {
              cacheBackend: cache.backend,
              cacheSavings: { tokens: cache.savedTokens, cost: cache.savedCost, cacheHits: cache.cacheHitsToday },
            }),
        })
      },
      setMode: (mode: RoutingMode) => {
        if (router === undefined) return false
        router.setMode(mode)
        if (usingVendors) {
          // 模式选择要跨重启保留：vendors.json 路径写回自己的文档。
          vendorDoc = { ...vendorDoc, mode }
          void vendorStore.save(vendorDoc).catch((error: unknown) => {
            log.warn('cannot persist mode: %s', messageOf(error))
          })
        } else {
          void persistMode(settings.poolPath, mode).catch((error: unknown) => {
            log.warn('cannot persist mode: %s', messageOf(error))
          })
        }
        return true
      },
      discover: async (vendorId: string, baseUrl: string, apiKey: string) => {
        // 面板同源代理：宿主进程发起上游探测（浏览器跨源会被 CORS 拦截）。
        // 没传地址/密钥就回落到这家厂商已保存的那一份，用户不必重复抄写。
        const saved = vendorDoc.vendors.find((vendor) => vendor.vendorId === vendorId)
        const template = templateVendors().find((entry) => entry.vendorId === vendorId)
        // 还没保存过的目录厂商（OpenCode Zen）直接用目录里的官方地址。
        const endpoint = baseUrl.trim() !== ''
          ? baseUrl.trim()
          : (saved === undefined ? (template?.officialUrl ?? '') : vendorEndpoint(saved))
        const key = apiKey.trim() !== '' ? apiKey.trim() : (saved?.apiKey ?? '')
        // 模型清单公开的厂商（OpenCode Zen）不需要密钥就能列模型；
        // 真正调用模型时仍然要它自己的 key。
        const publicModels = template?.publicModels === true
        if (endpoint === '' || (key === '' && !publicModels)) {
          throw new Error('endpoint and api key are required')
        }
        return discoverUpstreamModels(vendorId, endpoint, key)
      },
      getVendors: () => ({
        mode: vendorDoc.mode,
        vendors: vendorDoc.vendors.map((vendor) => ({
          vendorId: vendor.vendorId,
          vendorName: vendor.vendorName,
          officialUrl: vendor.officialUrl,
          customUrl: vendor.customUrl,
          ...(vendor.endpointSource === undefined ? {} : { endpointSource: vendor.endpointSource }),
          hasKey: vendor.apiKey !== '',
          apiKeyMasked: maskKey(vendor.apiKey),
          enabledModels: [...vendor.enabledModels],
          ...(vendor.pulledModels === undefined ? {} : { pulledModels: vendor.pulledModels.map((model) => ({ ...model })) }),
          modelTags: { ...(vendor.modelTags ?? {}) },
          modelPricing: { ...(vendor.modelPricing ?? {}) },
        })),
      }),
      saveVendors: (mode, input) => saveVendors(mode, input),
      importHarness: (scope?: ImportScope) => importFromHarness(scope),
      syncHarness: (vendorId: string) => syncToHarness(vendorId),
      deleteVendor: (vendorId: string) => deleteVendor(vendorId),
      reload: () => reload(Date.now()),
      gateway: () => gateway === undefined
        ? undefined
        : {
          baseUrl: gateway.baseUrl(),
          token: gateway.token(),
          modelIds: gatewayModelIds(configValue),
          port: gateway.port(),
        },
    }, { avatarDirectory })
    for (const route of routes) {
      try {
        disposers.push(ctx.webServer.register(route))
      } catch (error) {
        log.warn('cannot register %s: %s', route.path, messageOf(error))
      }
    }
    // 面板打开时才会请求；这里先预热一次，让首帧就有数。
    void usageNow(Date.now())
  } else {
    log.warn('webServer is not available; the panel routes are not mounted')
  }

  // ── Agent 工具：让 Agent 对话式管理矩阵（「让 Agent 帮我配置」）────
  const toolDeps: StewardToolDeps = {
    getVendorConfigs: () => vendorDoc.vendors.map((vendor) => ({ ...vendor })),
    saveVendorConfigs: async (vendors) => {
      vendorDoc = { ...vendorDoc, vendors }
      usingVendors = vendorDoc.vendors.length > 0
      configValue = currentPool()
      router = configValue === undefined ? undefined : createRouter(configValue, undefined, router?.getMode())
      await vendorStore.save(vendorDoc)
      await refreshSecrets()
    },
    setMode: async (mode) => {
      router?.setMode(mode)
      vendorDoc = { ...vendorDoc, mode }
      await vendorStore.save(vendorDoc)
    },
    getMode: () => router?.getMode() ?? vendorDoc.mode,
    gatewayBaseUrl: () => gateway?.baseUrl(),
  }
  const tools = ctx.get?.<{ register(tool: unknown): () => void }>('tools')
  if (tools !== undefined && typeof tools.register === 'function') {
    try {
      disposers.push(tools.register({
        name: 'token_steward_manage',
        description: '管理 Token 管家模型矩阵：添加/移除厂商、启用/停用模型、给模型打擅长标签、切换调度模式。改动立即生效（热重载）。',
        parameters: STEWARD_TOOL_PARAMETERS,
        output: { schema: { type: 'string' } },
        async execute(args: StewardActionArgs) {
          return executeStewardAction(toolDeps, args)
        },
      }))
      log.info('agent tool registered: token_steward_manage')
    } catch (error) {
      log.warn('agent tool registration failed: %s', error instanceof Error ? error.message : String(error))
    }
  }
  const skills = ctx.get?.<{ register(skill: unknown): () => void }>('skills')
  if (skills !== undefined && typeof skills.register === 'function') {
    try {
      disposers.push(skills.register({
        name: 'token-steward',
        description: '用对话管理 Token 管家模型矩阵（厂商/模型/标签/模式）',
        content: [
          '# Token 管家（模型矩阵）',
          '',
          '当用户想「接入某个模型厂商 / 启用某些模型 / 给模型打擅长标签 / 切换调度模式」时，使用 token_steward_manage 工具。',
          '',
          '工作流：',
          '1. 先 action=show_status 看当前矩阵；',
          '2. 接厂商：action=add_or_update_vendor，给 vendor_id / base_url / api_key（推荐 env:NAME 引用）/ enabled_models；',
          '3. 勾模型：action=set_enabled_models；',
          '4. 打标签：action=tag_model，标签用简单能力词（编程 / 文案 / 视频 / 做题 / 推理 / 多模态 / 快速 / 前端 …）；',
          '5. 切模式：action=set_mode（frugal=满足硬过滤的 C/D 级里最便宜；balanced=任务维度须达 A/A+ 再看成本；max_power=六维总和最高）。',
          '',
          '所有改动立即热生效，无需重启。密钥永不出现在你的回复里。',
        ].join('\n'),
        source: 'runtime',
        provider: 'dsh-token-steward',
      }))
      log.info('runtime skill registered: token-steward')
    } catch (error) {
      log.warn('skill registration failed: %s', error instanceof Error ? error.message : String(error))
    }
  }

  // ── 热重载 ──────────────────────────────────────────────
  const watcher = createPoolWatcher(
    settings.poolPath,
    () => {
      void reload(Date.now()).then(async (result) => {
        if (!result.ok) {
          log.warn('config rejected, keeping the previous matrix: %s', result.error ?? '')
          return
        }
        await refreshSecrets()
        log.info('config reloaded (%d providers)', configValue?.providers.length ?? 0)
      })
    },
    (message) => { log.warn('%s', message) },
  )
  watcher.start()

  // ── 回收 ────────────────────────────────────────────────
  const teardown = (): void => {
    watcher.stop()
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 路由 fiber 已随宿主退场。
      }
    }
    if (gateway !== undefined) {
      const closing = gateway
      gateway = undefined
      void closing.close().catch(() => {})
    }
    void ledger.flush().catch(() => {})
  }

  if (typeof ctx.effect === 'function') ctx.effect(() => teardown, 'token-steward: runtime')
  else log.warn('ctx.effect is unavailable; resources rely on process exit')
}

/** 网关公布的模型 id（与 host/gateway 的规则同源）。 */
function gatewayModelIds(config: PoolConfig | undefined): string[] {
  const ids = ['steward:auto', 'steward:frugal', 'steward:balanced', 'steward:max_power', 'steward:free']
  if (config === undefined) return ids
  for (const provider of config.providers) {
    for (const model of provider.models) {
      if (model.availability === 'offline') continue
      ids.push(model.id)
    }
  }
  return ids
}

/** 没有任何可用配置时的空快照，保证面板永远拿到完整形状。 */
function emptySnapshot(now: number, pool: { status: string, source: string, error?: string }): unknown {
  return {
    revision: now,
    mode: 'frugal',
    updatedAt: now,
    usageAvailable: false,
    models: [],
    agents: [],
    recent: [],
    totals: { todayTokens: 0, todayCost: null, cacheHitRate: null, degradedRequests: 0, unpricedModels: 0 },
    savings: { tokens: 0, cost: null, cacheHits: 0, cacheBackend: 'off' },
    pool,
  }
}

/** 把模式写回 model_pool.yaml 的 routing.mode 一行（最小侵入的原地改写）。 */
async function persistMode(path: string, mode: RoutingMode): Promise<void> {
  const { readFileIfExists, writeFileAtomic } = await import('./host/atomic-file.ts')
  const text = await readFileIfExists(path)
  if (text === undefined) return
  const pattern = /(^routing:[\s\S]*?^\s+mode:\s*)([a-z_]+)/m
  const next = pattern.test(text)
    ? text.replace(pattern, '$1' + mode)
    : text + (text.endsWith('\n') ? '' : '\n') + 'routing:\n  mode: ' + mode + '\n'
  if (next === text) return
  await writeFileAtomic(path, next)
}

/** 从 unknown 里取可读消息。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default { name, inject, apply }
