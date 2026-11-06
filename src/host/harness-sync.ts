/**
 * 反向同步：管家里的这家厂家 → DSH「系统模型设置」。
 *
 * 面板里的模型是从上游拉回来的，改完只有管家自己知道；DSH 的模型菜单读的是
 * profile 里 `@deepseek-ai/dsh-llm-pi-ai` 的 providers。把勾好的型号写回去，
 * 用户在系统模型设置里就能直接选到——这就是「管家 → 系统模型设置」。
 *
 * 纯函数：给一份已解析的 YAML 文档 + 一个厂家描述，回一份新的文档。
 * 不读盘、不写盘，方便单测。
 */
import type { VendorConfig } from '../core/types.ts'
import { normalizeEndpoint } from './harness-import.ts'

/**
 * 写回 profile 时的默认输出上限。
 *
 * llm-pi-ai 的 `defaultMaxTokens` 缺省是 128000——比绝大多数上游的真实上限都大，
 * 直连 Agnes 会直接 400（`max_tokens 不能超过 65536`）。65536 是所有已知上游都
 * 接受的上界，写进去既能跑，又不会把正常请求截短。
 */
export const HARNESS_DEFAULT_MAX_TOKENS = 65_536

/** 要写进 profile 的厂家形态（密钥单独给，便于调用方决定用明文还是环境变量）。 */
export interface HarnessSyncInput {
  vendorId: string
  vendorName: string
  baseUrl: string
  /** 明文密钥；空串表示不写（沿用 profile 里已有的）。 */
  apiKey: string
  /** 模型清单；空清单表示不动。 */
  models: Array<{ id: string, name: string }>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 找到（或就地创建）llm-pi-ai 那一行的 config.providers 容器。 */
function providersOf(doc: unknown): { container: Record<string, unknown>, changed: boolean } {
  const entries = Array.isArray(doc)
    ? doc
    : isRecord(doc) && Array.isArray(doc.plugins) ? doc.plugins : undefined
  if (entries === undefined) {
    return { container: {}, changed: true }
  }
  for (const entry of entries) {
    if (!isRecord(entry)) continue
    const name = typeof entry.name === 'string' ? entry.name : ''
    if (!name.endsWith('llm-pi-ai')) continue
    if (!isRecord(entry.config)) entry.config = {}
    const config = entry.config as Record<string, unknown>
    if (!isRecord(config.providers)) config.providers = {}
    return { container: config.providers as Record<string, unknown>, changed: false }
  }
  // 没有 llm-pi-ai 这一行：新建一条，至少让写回是有效的。
  const fresh = { name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: {} } }
  if (Array.isArray(entries)) entries.push(fresh)
  return { container: (fresh.config as { providers: Record<string, unknown> }).providers, changed: true }
}

/**
 * 把一家厂家写进 profile 文档。
 *
 * 合并策略：同名 provider 就地更新（覆盖 baseURL / 模型清单；密钥为空则保留原来的），
 * 其余 provider 一个字不动——用户的 agnes、其它上游都在同一个块里。
 */
export function upsertHarnessProvider(doc: unknown, input: HarnessSyncInput): unknown {
  const { container } = providersOf(doc)
  const existing = isRecord(container[input.vendorId]) ? container[input.vendorId] as Record<string, unknown> : {}
  const models = input.models.length > 0
    ? input.models.map((model) => ({ id: model.id, name: model.name }))
    : Array.isArray(existing.models) ? existing.models : []
  const next: Record<string, unknown> = {
    ...existing,
    displayName: input.vendorName,
    api: typeof existing.api === 'string' ? existing.api : 'openai-completions',
    baseURL: input.baseUrl,
    models,
    // 用户已经自己设过的就留着，没设的补一个上游普遍能接受的上限。
    defaultMaxTokens: typeof existing.defaultMaxTokens === 'number' ? existing.defaultMaxTokens : HARNESS_DEFAULT_MAX_TOKENS,
  }
  // 密钥：有明文就写 apiKey，但**不能**删掉 apiKeyEnv。
  //
  // llm-pi-ai 的 provider 只认 apiKeyEnv（credential-ref），`apiKey` 是给本插件
  // 自己回读用的、DSH 根本不看。以前这里把 apiKeyEnv 删掉，等于把这家上游的
  // 凭据指针一起拔了——DSH 当场报「No API key for provider: xxx」。
  if (input.apiKey !== '') next.apiKey = input.apiKey
  container[input.vendorId] = next
  return doc
}

/**
 * 这家厂家在 profile 里该写到哪个键上。
 *
 * 同 id 已经存在就写它；否则找地址相同的那一条——用户在管家里的厂家名
 * （custom / westlake）和 profile 里的 provider 键未必一致，按地址对上就不会
 * 在同一份配置里多留一份「同一家上游」的副本。
 */
export function resolveSyncVendorId(doc: unknown, vendorId: string, baseUrl: string): string {
  const { container } = providersOf(doc)
  if (isRecord(container[vendorId])) return vendorId
  const target = normalizeEndpoint(baseUrl)
  if (target !== '') {
    for (const [key, raw] of Object.entries(container)) {
      if (!isRecord(raw)) continue
      const url = typeof raw.baseURL === 'string' ? raw.baseURL : typeof raw.baseUrl === 'string' ? raw.baseUrl : ''
      if (url !== '' && normalizeEndpoint(url) === target) return key
    }
  }
  return vendorId
}

/** 从管家配置里挑出要同步的那一家（找不到返回 undefined）。 */
export function syncInputFromVendor(vendor: VendorConfig, baseUrl: string): HarnessSyncInput {
  return {
    vendorId: vendor.vendorId,
    vendorName: vendor.vendorName,
    baseUrl,
    apiKey: vendor.apiKey,
    models: vendor.enabledModels.map((id) => {
      const named = vendor.pulledModels?.find((model) => model.id === id)
      return { id, name: named?.name ?? id }
    }),
  }
}
