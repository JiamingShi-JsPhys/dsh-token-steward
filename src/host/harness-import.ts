/**
 * 把 DSH 里**已经配好**的模型抓过来当厂家。
 *
 * 用户的痛点是显而易见的：他在 DSH 的 profile 里早就填过 Base URL、密钥和模型清单，
 * 到了 Token 管家的面板却要再抄一遍。这里直接把 `cordis.patch.yml` 里
 * `@deepseek-ai/dsh-llm-pi-ai` 的 providers 读成 VendorConfig，密钥从 apiKeyEnv
 * 指向的环境变量取（取不到就留空，让用户补一次）。
 *
 * 纯函数：给一段已解析的 YAML 文档，回一批厂家档案；不读盘、不写盘。
 */
import type { ImportScope, VendorConfig } from '../core/types.ts'

/** 从 profile 里读出来的一个上游。 */
export interface HarnessProvider {
  /** provider 的配置键，也就是它在 DSH 里的 id。 */
  vendorId: string
  vendorName: string
  baseUrl: string
  /** 密钥来自哪个环境变量；空串表示直接写在配置里。 */
  apiKeyEnv: string
  /** 配置里直接写的密钥（多数人不用这条路）。 */
  apiKey: string
  /** 已经配置好的模型 id 清单。 */
  models: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 从一份已解析的 cordis.patch.yml 里取出全部上游。
 *
 * 只认 `llm-pi-ai` 这个插件（DSH 里 OpenAI 兼容上游都挂在它下面），
 * 并且跳过我们自己（provider id = steward），否则导入会把网关自己再连一遍。
 */
export function harnessProviders(doc: unknown): HarnessProvider[] {
  const entries = Array.isArray(doc)
    ? doc
    : isRecord(doc) && Array.isArray(doc.plugins) ? doc.plugins : []
  const found: HarnessProvider[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    if (!isRecord(entry)) continue
    const pluginName = asText(entry.name)
    if (!pluginName.endsWith('llm-pi-ai')) continue
    const config = isRecord(entry.config) ? entry.config : {}
    const providers = isRecord(config.providers) ? config.providers : {}
    for (const [key, raw] of Object.entries(providers)) {
      if (!isRecord(raw)) continue
      if (key === 'steward' || seen.has(key)) continue
      const baseUrl = asText(raw.baseURL) || asText(raw.baseUrl) || asText(raw.endpoint)
      if (baseUrl === '') continue
      const models: string[] = []
      if (Array.isArray(raw.models)) {
        for (const model of raw.models) {
          const id = typeof model === 'string' ? model.trim() : isRecord(model) ? asText(model.id) : ''
          if (id !== '') models.push(id)
        }
      }
      seen.add(key)
      found.push({
        vendorId: key,
        vendorName: asText(raw.displayName) || key,
        baseUrl,
        apiKeyEnv: asText(raw.apiKeyEnv),
        apiKey: asText(raw.apiKey),
        models,
      })
    }
  }
  return found
}

/**
 * 地址规范化：比 URL 时忽略大小写、末尾斜杠，以及 OpenAI 兼容层常见的 `/v1`。
 * 用户填 `https://api.x.com/v1`、profile 里写 `https://api.x.com` 是同一家。
 */
export function normalizeEndpoint(url: string): string {
  return url.trim().toLowerCase().replace(/\/+$/, '').replace(/\/v1$/, '').replace(/\/+$/, '')
}

/**
 * 按范围挑出要导入的上游。
 *
 * 面板停在谁身上就只拉谁：provider id 对上，或者地址（规范化后）对上，都算这家。
 * 不给范围时原样返回——那是「整份导入」的老行为，只留给脚本调用。
 */
export function selectHarnessProviders(providers: HarnessProvider[], scope?: ImportScope): HarnessProvider[] {
  if (scope === undefined) return providers
  const id = (scope.vendorId ?? '').trim()
  const url = normalizeEndpoint(scope.baseUrl ?? '')
  if (id === '' && url === '') return providers
  return providers.filter((provider) => (id !== '' && provider.vendorId === id)
    || (url !== '' && normalizeEndpoint(provider.baseUrl) === url))
}

/**
 * 上游 → 厂家配置。
 *
 * 取密钥的顺序：apiKeyEnv 指向的环境变量 → 配置里写死的 apiKey。
 * 都取不到就留空串——面板会显示「已配置但没有密钥」，让用户补一次，
 * 而不是把一个空密钥当成配置好了。
 */
export function harnessVendor(provider: HarnessProvider, env: Record<string, string | undefined>): VendorConfig {
  const fromEnv = provider.apiKeyEnv === '' ? '' : (env[provider.apiKeyEnv] ?? '').trim()
  return {
    vendorId: provider.vendorId,
    vendorName: provider.vendorName,
    officialUrl: provider.baseUrl,
    customUrl: '',
    endpointSource: 'official',
    apiKey: fromEnv !== '' ? fromEnv : provider.apiKey,
    enabledModels: [...provider.models],
  }
}

/**
 * 把抓到的厂家并进现有配置：同 id 的就地更新（保留用户打的标签与价目），
 * 新的追加在后面。用户在面板里改过的东西不该被一次导入抹掉。
 */
export function mergeImportedVendors(existing: VendorConfig[], incoming: VendorConfig[]): VendorConfig[] {
  const byId = new Map(existing.map((vendor) => [vendor.vendorId, vendor]))
  for (const vendor of incoming) {
    const previous = byId.get(vendor.vendorId)
    if (previous === undefined) {
      byId.set(vendor.vendorId, vendor)
      continue
    }
    byId.set(vendor.vendorId, {
      ...vendor,
      // 导入时取不到密钥，就沿用已存的那把，别把用户配好的配置弄成空的。
      apiKey: vendor.apiKey !== '' ? vendor.apiKey : previous.apiKey,
      enabledModels: vendor.enabledModels.length > 0 ? vendor.enabledModels : previous.enabledModels,
      ...(previous.modelTags === undefined ? {} : { modelTags: previous.modelTags }),
      ...(previous.modelPricing === undefined ? {} : { modelPricing: previous.modelPricing }),
    })
  }
  return [...byId.values()]
}
