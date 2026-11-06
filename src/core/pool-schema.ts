/**
 * model_pool.yaml 的校验与归一化。
 *
 * 纯函数：接收已经解码好的普通对象（YAML 解码器在宿主侧，属于 M2 的 IO 层），
 * 输出 {@link PoolConfig} 或一份带路径的诊断清单。不读文件、不展开凭据、
 * 不碰时钟。
 *
 * 一条硬规则：任一字段非法 → **整份拒绝**。半应用的路由表比没有路由表更危险，
 * 因为用户看到「保存成功」，流量却走进了没打算用的模型。
 */
import type {
  ApiShape,
  Availability,
  CachePolicy,
  CapabilityTag,
  CostLevel,
  InputModality,
  ModelEntry,
  PoolConfig,
  PricingTable,
  ProviderEntry,
  RoutingAlias,
  RoutingDefaults,
  RoutingMode,
} from './types.ts'

/** 一条带配置路径的诊断。 */
export interface PoolDiagnostic {
  /** 如 providers[0].models[2].context_window。 */
  path: string
  message: string
}

/** 解析结果：要么整份配置，要么全部诊断。 */
export type PoolParseResult =
  | { ok: true; config: PoolConfig; warnings: string[] }
  | { ok: false; diagnostics: PoolDiagnostic[] }

export const CAPABILITY_TAGS: readonly CapabilityTag[] = [
  'coding', 'reasoning', 'vision', 'fast', 'tool-use', 'long-context', 'json-mode', 'multilingual',
]

export const INPUT_MODALITIES: readonly InputModality[] = ['text', 'image', 'audio', 'file']

export const COST_LEVELS: readonly CostLevel[] = ['high', 'medium', 'low', 'free']

export const AVAILABILITIES: readonly Availability[] = ['direct', 'proxy', 'offline']

export const ROUTING_MODES: readonly RoutingMode[] = ['frugal', 'balanced', 'max_power']

export const API_SHAPES: readonly ApiShape[] = ['openai-completions']

/** 缺省值：与 docs/architecture.md 的 defaults 一节一致。 */
export const DEFAULT_DEFAULTS: RoutingDefaults = {
  timeout_ms: 60_000,
  max_attempts: 3,
  cooldown_ms: 30_000,
  failure_threshold: 3,
  half_open_after_ms: 60_000,
}

/** 本地精确响应缓存的缺省策略：关闭。 */
export const DEFAULT_CACHE: CachePolicy = {
  exact_match: false,
  max_entries: 500,
  ttl_ms: 3_600_000,
}

/** 一个模型在缺省时的并发闸门。 */
const DEFAULT_MAX_CONCURRENCY = 4

/** 一个模型在缺省时可用的输出 token。 */
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function asPositiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

function asNonNegativeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 读一个字符串数组；非数组或含非字符串即报错。 */
function readStringArray(
  value: unknown,
  path: string,
  fail: (path: string, message: string) => void,
): string[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    fail(path, 'expected a list of strings')
    return undefined
  }
  const out: string[] = []
  for (const [index, item] of value.entries()) {
    const text = asString(item)
    if (text === undefined) {
      fail(path + '[' + String(index) + ']', 'expected a non-empty string')
      return undefined
    }
    out.push(text)
  }
  return out
}

/** 读枚举数组：逐项校验取值域。 */
function readEnumArray<T extends string>(
  value: unknown,
  path: string,
  domain: readonly T[],
  fail: (path: string, message: string) => void,
): T[] | undefined {
  const raw = readStringArray(value, path, fail)
  if (raw === undefined) return undefined
  const out: T[] = []
  for (const [index, item] of raw.entries()) {
    if (!(domain as readonly string[]).includes(item)) {
      fail(path + '[' + String(index) + ']', 'expected one of ' + domain.join(' | ') + ', got ' + JSON.stringify(item))
      return undefined
    }
    out.push(item as T)
  }
  return out
}

/** 读一个枚举标量。 */
function readEnum<T extends string>(
  value: unknown,
  path: string,
  domain: readonly T[],
  fail: (path: string, message: string) => void,
): T | undefined {
  const text = asString(value)
  if (text === undefined) {
    fail(path, 'expected one of ' + domain.join(' | '))
    return undefined
  }
  if (!(domain as readonly string[]).includes(text)) {
    fail(path, 'expected one of ' + domain.join(' | ') + ', got ' + JSON.stringify(text))
    return undefined
  }
  return text as T
}

/** 读计价表；缺任一必填字段即报错。 */
function readPricing(
  value: unknown,
  path: string,
  fail: (path: string, message: string) => void,
): PricingTable | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    fail(path, 'expected a pricing mapping')
    return undefined
  }
  const currency = readEnum(value.currency, path + '.currency', ['CNY', 'USD'] as const, fail)
  const input = asFiniteNumber(value.input_per_mtok)
  const output = asFiniteNumber(value.output_per_mtok)
  if (input === undefined || input < 0) {
    fail(path + '.input_per_mtok', 'expected a non-negative number')
    return undefined
  }
  if (output === undefined || output < 0) {
    fail(path + '.output_per_mtok', 'expected a non-negative number')
    return undefined
  }
  if (currency === undefined) return undefined
  const table: PricingTable = { currency, input_per_mtok: input, output_per_mtok: output }
  const cacheRead = asFiniteNumber(value.cache_read_per_mtok)
  if (cacheRead !== undefined && cacheRead >= 0) table.cache_read_per_mtok = cacheRead
  const cacheWrite = asFiniteNumber(value.cache_write_per_mtok)
  if (cacheWrite !== undefined && cacheWrite >= 0) table.cache_write_per_mtok = cacheWrite
  return table
}

/** 读 headers 字典。 */
function readHeaders(
  value: unknown,
  path: string,
  fail: (path: string, message: string) => void,
): Record<string, string> | undefined {
  if (value === undefined) return {}
  if (!isRecord(value)) {
    fail(path, 'expected a mapping of header name to value')
    return undefined
  }
  const out: Record<string, string> = {}
  for (const [name, raw] of Object.entries(value)) {
    const text = asString(raw)
    if (text === undefined) {
      fail(path + '.' + name, 'expected a non-empty single-line string')
      return undefined
    }
    if (/[\r\n]/.test(text)) {
      fail(path + '.' + name, 'header values must not contain line breaks')
      return undefined
    }
    out[name] = text
  }
  return out
}

/** 读一个模型条目。 */
function readModel(
  value: unknown,
  path: string,
  fail: (path: string, message: string) => void,
  warn: (message: string) => void,
): ModelEntry | undefined {
  if (!isRecord(value)) {
    fail(path, 'expected a model mapping')
    return undefined
  }
  const id = asString(value.id)
  if (id === undefined) {
    fail(path + '.id', 'expected a non-empty model id')
    return undefined
  }
  if (value.capabilities === undefined) {
    fail(path + '.capabilities', 'expected a list of capability tags (use [] for a model with no special capability)')
    return undefined
  }
  const capabilities = readEnumArray(value.capabilities, path + '.capabilities', CAPABILITY_TAGS, fail)
  const modalitiesRaw = readEnumArray(value.input_modalities, path + '.input_modalities', INPUT_MODALITIES, fail)
  const costLevel = readEnum(value.cost_level, path + '.cost_level', COST_LEVELS, fail)
  const availability = readEnum(value.availability, path + '.availability', AVAILABILITIES, fail)
  const contextWindow = asPositiveInt(value.context_window)
  if (contextWindow === undefined) {
    fail(path + '.context_window', 'expected a positive integer')
    return undefined
  }
  if (capabilities === undefined || modalitiesRaw === undefined || costLevel === undefined || availability === undefined) {
    return undefined
  }

  const proxyUrl = asString(value.proxy_url)
  if (availability === 'proxy' && proxyUrl === undefined) {
    fail(path + '.proxy_url', 'availability: proxy requires a proxy_url')
    return undefined
  }
  if (availability !== 'proxy' && proxyUrl !== undefined) {
    fail(path + '.proxy_url', 'proxy_url is only meaningful when availability is proxy')
    return undefined
  }

  const maxConcurrency = asPositiveInt(value.max_concurrency)
  if (value.max_concurrency !== undefined && maxConcurrency === undefined) {
    fail(path + '.max_concurrency', 'expected a positive integer')
    return undefined
  }
  const rpm = asPositiveInt(value.rpm)
  if (value.rpm !== undefined && rpm === undefined) {
    fail(path + '.rpm', 'expected a positive integer')
    return undefined
  }
  const qualityRank = asNonNegativeInt(value.quality_rank)
  if (qualityRank === undefined || qualityRank > 100) {
    fail(path + '.quality_rank', 'expected an integer between 0 and 100')
    return undefined
  }
  const maxOutput = asPositiveInt(value.max_output_tokens)
  if (value.max_output_tokens !== undefined && maxOutput === undefined) {
    fail(path + '.max_output_tokens', 'expected a positive integer')
    return undefined
  }
  const pricing = readPricing(value.pricing, path + '.pricing', fail)
  if (value.pricing !== undefined && pricing === undefined) return undefined
  const tags = readHeaders(value.tags, path + '.tags', fail)
  if (tags === undefined) return undefined

  // 面板与计量都靠 pricing 判「未定价」，这里把缺失显式告知一次。
  if (pricing === undefined) warn(path + ': no pricing table; its cost shows as — (未定价)')

  const modalities: InputModality[] = modalitiesRaw.length > 0 ? modalitiesRaw : ['text']
  if (modalities.length === 0) modalities.push('text')
  if (capabilities.includes('vision') && !modalities.includes('image')) {
    warn(path + ': declares capability vision but not input_modalities: image')
  }

  const entry: ModelEntry = {
    id,
    display_name: asString(value.display_name) ?? id,
    capabilities,
    cost_level: costLevel,
    context_window: contextWindow,
    max_output_tokens: maxOutput ?? DEFAULT_MAX_OUTPUT_TOKENS,
    availability,
    input_modalities: modalities,
    max_concurrency: maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
    quality_rank: qualityRank,
    tags: tags ?? {},
  }
  if (proxyUrl !== undefined) entry.proxy_url = proxyUrl
  if (rpm !== undefined) entry.rpm = rpm
  if (pricing !== undefined) entry.pricing = pricing
  return entry
}

/** 读一个 provider 条目。 */
function readProvider(
  value: unknown,
  path: string,
  fail: (path: string, message: string) => void,
  warn: (message: string) => void,
): ProviderEntry | undefined {
  if (!isRecord(value)) {
    fail(path, 'expected a provider mapping')
    return undefined
  }
  const providerName = asString(value.provider_name)
  if (providerName === undefined) {
    fail(path + '.provider_name', 'expected a non-empty provider name')
    return undefined
  }
  const endpoint = asString(value.endpoint)
  if (endpoint === undefined) {
    fail(path + '.endpoint', 'expected a non-empty URL')
    return undefined
  }
  let parsed: URL | undefined
  try {
    parsed = new URL(endpoint)
  } catch {
    parsed = undefined
  }
  if (parsed === undefined || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    fail(path + '.endpoint', 'expected an http(s) URL, got ' + JSON.stringify(endpoint))
    return undefined
  }
  const api = readEnum(value.api, path + '.api', API_SHAPES, fail)
  const apiKey = asString(value.api_key)
  if (apiKey === undefined) {
    fail(path + '.api_key', 'expected a credential reference such as env:MY_KEY')
    return undefined
  }
  if (!/^(env:|file:|literal:|\$\{)/.test(apiKey)) {
    fail(path + '.api_key', 'expected env:NAME, file:/abs/path, literal:xxx, or ${NAME}')
    return undefined
  }
  const headers = readHeaders(value.headers, path + '.headers', fail)
  if (headers === undefined || api === undefined) return undefined

  const rawModels = value.models
  if (!Array.isArray(rawModels) || rawModels.length === 0) {
    fail(path + '.models', 'expected a non-empty list of models')
    return undefined
  }
  const models: ModelEntry[] = []
  const seen = new Set<string>()
  for (const [index, raw] of rawModels.entries()) {
    const model = readModel(raw, path + '.models[' + String(index) + ']', fail, warn)
    if (model === undefined) return undefined
    if (seen.has(model.id)) {
      fail(path + '.models[' + String(index) + '].id', 'duplicate model id ' + JSON.stringify(model.id))
      return undefined
    }
    seen.add(model.id)
    models.push(model)
  }

  const timeoutMs = asPositiveInt(value.timeout_ms)
  if (value.timeout_ms !== undefined && timeoutMs === undefined) {
    fail(path + '.timeout_ms', 'expected a positive integer')
    return undefined
  }

  const provider: ProviderEntry = {
    provider_name: providerName,
    endpoint,
    api,
    api_key: apiKey,
    headers: headers ?? {},
    models,
  }
  if (timeoutMs !== undefined) provider.timeout_ms = timeoutMs
  return provider
}

/** 读一个别名 / agent 覆盖块。 */
function readAlias(
  value: unknown,
  path: string,
  fail: (path: string, message: string) => void,
): RoutingAlias | undefined {
  if (value === undefined) return {}
  if (!isRecord(value)) {
    fail(path, 'expected a routing mapping')
    return undefined
  }
  const alias: RoutingAlias = {}
  if (value.mode !== undefined) {
    const mode = readEnum(value.mode, path + '.mode', ROUTING_MODES, fail)
    if (mode === undefined) return undefined
    alias.mode = mode
  }
  const require = value.require === undefined
    ? []
    : readEnumArray(value.require, path + '.require', CAPABILITY_TAGS, fail)
  if (require === undefined) return undefined
  if (require.length > 0) alias.require = require

  const modalities = value.require_modalities === undefined
    ? []
    : readEnumArray(value.require_modalities, path + '.require_modalities', INPUT_MODALITIES, fail)
  if (modalities === undefined) return undefined
  if (modalities.length > 0) alias.require_modalities = modalities

  if (value.pin !== undefined) {
    if (!isRecord(value.pin)) {
      fail(path + '.pin', 'expected a mapping with provider and model')
      return undefined
    }
    const provider = asString(value.pin.provider)
    const model = asString(value.pin.model)
    if (provider === undefined || model === undefined) {
      fail(path + '.pin', 'expected both provider and model')
      return undefined
    }
    alias.pin = { provider, model }
  }
  return alias
}

/** 读别名表；key 必须是合法标识符。 */
function readAliasTable(
  value: unknown,
  path: string,
  fail: (path: string, message: string) => void,
): Record<string, RoutingAlias> | undefined {
  if (value === undefined) return {}
  if (!isRecord(value)) {
    fail(path, 'expected a mapping of name to routing')
    return undefined
  }
  const out: Record<string, RoutingAlias> = {}
  for (const [name, raw] of Object.entries(value)) {
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) {
      fail(path + '.' + name, 'expected a name matching [a-z0-9][a-z0-9_-]*')
      return undefined
    }
    const alias = readAlias(raw, path + '.' + name, fail)
    if (alias === undefined) return undefined
    out[name] = alias
  }
  return out
}

/** 读 defaults 段，逐项回落。 */
function readDefaults(
  value: unknown,
  path: string,
  fail: (path: string, message: string) => void,
): RoutingDefaults | undefined {
  if (value === undefined) return { ...DEFAULT_DEFAULTS }
  if (!isRecord(value)) {
    fail(path, 'expected a mapping')
    return undefined
  }
  const out: RoutingDefaults = { ...DEFAULT_DEFAULTS }
  const keys: Array<keyof RoutingDefaults> = [
    'timeout_ms', 'max_attempts', 'cooldown_ms', 'failure_threshold', 'half_open_after_ms',
  ]
  for (const key of keys) {
    if (value[key] === undefined) continue
    const parsed = asPositiveInt(value[key])
    if (parsed === undefined) {
      fail(path + '.' + key, 'expected a positive integer')
      return undefined
    }
    out[key] = parsed
  }
  return out
}

/**
 * 校验并归一化一份矩阵配置。
 * @param raw - 已解码的 YAML 数据（普通对象）。
 * @returns 整份配置或全部诊断。
 */
export function parsePool(raw: unknown): PoolParseResult {
  const diagnostics: PoolDiagnostic[] = []
  const warnings: string[] = []
  const fail = (path: string, message: string): void => {
    diagnostics.push({ path, message })
  }
  const warn = (message: string): void => {
    warnings.push(message)
  }

  if (!isRecord(raw)) {
    fail('(root)', 'expected a mapping with version, defaults, routing, providers')
    return { ok: false, diagnostics }
  }

  const version = raw.version
  if (version !== undefined && version !== 1) {
    fail('version', 'expected 1, got ' + JSON.stringify(version))
    return { ok: false, diagnostics }
  }

  const defaults = readDefaults(raw.defaults, 'defaults', fail)
  if (defaults === undefined) return { ok: false, diagnostics }

  let mode: RoutingMode = 'frugal'
  let aliases: Record<string, RoutingAlias> = {}
  let agentOverrides: Record<string, RoutingAlias> = {}
  if (raw.routing !== undefined) {
    if (!isRecord(raw.routing)) {
      fail('routing', 'expected a mapping')
      return { ok: false, diagnostics }
    }
    if (raw.routing.mode !== undefined) {
      const parsed = readEnum(raw.routing.mode, 'routing.mode', ROUTING_MODES, fail)
      if (parsed === undefined) return { ok: false, diagnostics }
      mode = parsed
    }
    const parsedAliases = readAliasTable(raw.routing.aliases, 'routing.aliases', fail)
    if (parsedAliases === undefined) return { ok: false, diagnostics }
    aliases = parsedAliases

    const parsedAgents = readAliasTable(raw.routing.agent_overrides, 'routing.agent_overrides', fail)
    if (parsedAgents === undefined) return { ok: false, diagnostics }
    agentOverrides = parsedAgents
  }

  const rawProviders = raw.providers
  if (!Array.isArray(rawProviders) || rawProviders.length === 0) {
    fail('providers', 'expected a non-empty list of providers')
    return { ok: false, diagnostics }
  }

  const providers: ProviderEntry[] = []
  const seenProviders = new Set<string>()
  for (const [index, rawProvider] of rawProviders.entries()) {
    const provider = readProvider(rawProvider, 'providers[' + String(index) + ']', fail, warn)
    if (provider === undefined) return { ok: false, diagnostics }
    if (seenProviders.has(provider.provider_name)) {
      fail('providers[' + String(index) + '].provider_name',
        'duplicate provider name ' + JSON.stringify(provider.provider_name))
      return { ok: false, diagnostics }
    }
    seenProviders.add(provider.provider_name)
    providers.push(provider)
  }

  // 别名里的 pin 必须指向真实存在的模型，否则路由会静默落空。
  const known = new Set<string>()
  for (const provider of providers) {
    for (const model of provider.models) known.add(provider.provider_name + '/' + model.id)
  }
  for (const [tableName, table] of [['routing.aliases', aliases], ['routing.agent_overrides', agentOverrides]] as const) {
    for (const [name, alias] of Object.entries(table)) {
      if (alias.pin === undefined) continue
      const key = alias.pin.provider + '/' + alias.pin.model
      if (!known.has(key)) {
        fail(tableName + '.' + name + '.pin', 'unknown model ' + JSON.stringify(key))
        return { ok: false, diagnostics }
      }
    }
  }

  // 全部模型都标 offline 的矩阵必然每次请求都被拒，提前说清楚。
  const online = providers.some((provider) => provider.models.some((model) => model.availability !== 'offline'))
  if (!online) warn('every model is availability: offline; no request can be routed')

  let cache: CachePolicy = { ...DEFAULT_CACHE }
  if (raw.routing !== undefined && raw.routing.cache !== undefined) {
    const parsed = readCachePolicy(raw.routing.cache, 'routing.cache', fail)
    if (parsed === undefined) return { ok: false, diagnostics }
    cache = parsed
  }

  const config: PoolConfig = {
    version: 1,
    defaults,
    routing: { mode, aliases, agent_overrides: agentOverrides, cache },
    providers,
  }
  return { ok: true, config, warnings }
}

/** 便捷函数：解析失败时抛出带全部诊断的错误。 */
export function parsePoolOrThrow(raw: unknown): PoolConfig {
  const result = parsePool(raw)
  if (result.ok) return result.config
  const detail = result.diagnostics.map((d) => d.path + ': ' + d.message).join('; ')
  throw new Error('model_pool: invalid configuration — ' + detail)
}

/** 读 routing.cache：布尔与两个正整数，字段缺省取默认策略。 */
function readCachePolicy(
  value: unknown,
  path: string,
  fail: (path: string, message: string) => void,
): CachePolicy | undefined {
  if (!isRecord(value)) {
    fail(path, 'expected a mapping with exact_match, max_entries, ttl_ms')
    return undefined
  }
  let exact = DEFAULT_CACHE.exact_match
  if (value.exact_match !== undefined) {
    if (typeof value.exact_match !== 'boolean') {
      fail(path + '.exact_match', 'expected a boolean')
      return undefined
    }
    exact = value.exact_match
  }
  let maxEntries = DEFAULT_CACHE.max_entries
  if (value.max_entries !== undefined) {
    const parsed = asPositiveInt(value.max_entries)
    if (parsed === undefined) {
      fail(path + '.max_entries', 'expected a positive integer')
      return undefined
    }
    maxEntries = parsed
  }
  let ttl = DEFAULT_CACHE.ttl_ms
  if (value.ttl_ms !== undefined) {
    const parsed = asPositiveInt(value.ttl_ms)
    if (parsed === undefined) {
      fail(path + '.ttl_ms', 'expected a positive integer')
      return undefined
    }
    ttl = parsed
  }
  return { exact_match: exact, max_entries: maxEntries, ttl_ms: ttl }
}
