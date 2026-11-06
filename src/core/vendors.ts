/**
 * vendors.json → 路由池的合成层。
 *
 * 面板的厂家配置（VendorConfig[]）是 Token 管家的**第一配置源**：
 * 每家厂商按用户勾选的 enabledModels 展开成路由模型，六维评分从
 * provider-templates 目录按 id/名称匹配注入；目录未收录的模型以
 * 「未收录」形态入池（中性分，面板如实标注），绝不编造评分。
 *
 * 纯函数：不读文件、不展开凭据（明文由 index.ts 直接放进 secrets 映射，
 * 合成出的 ProviderEntry.api_key 只是占位符，永远不会被发送）。
 */
import type {
  CapabilityTag,
  DimensionScore,
  DimensionSet,
  ModelEntry,
  ModelInfo,
  PoolConfig,
  ProviderEntry,
  RoutingDefaults,
  VendorConfig,
} from './types.ts'
import {
  matchTemplateModel,
  templateModelToInfo,
  unknownModelInfo,
  PROVIDER_TEMPLATES,
  type TemplateVendor,
} from './provider-templates.ts'

/** 合成池用的缺省 defaults（yaml 高级覆盖路径不在本层）。 */
export const SYNTH_DEFAULTS: RoutingDefaults = {
  timeout_ms: 60_000,
  max_attempts: 3,
  cooldown_ms: 30_000,
  failure_threshold: 3,
  half_open_after_ms: 60_000,
}

/** 占位 api_key 前缀：真实明文由 index.ts 按 provider_name 注入 secrets。 */
export const VENDOR_KEY_SENTINEL = 'steward-vendor:'

/** 合成时给目录未收录模型的中立并发上限。 */
const DEFAULT_MAX_CONCURRENCY = 4

/** ModelInfo（管家档案）→ ModelEntry（路由引擎条目）。 */
export function modelInfoToEntry(info: ModelInfo): ModelEntry {
  const scores = info.scores
  const values = (Object.values(scores) as DimensionScore[]).map((entry) => entry.score)
  const average = values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
  // 引擎的 capabilities 只认识已知标签；目录里的 image_gen 等展示型标签不参与硬过滤。
  const KNOWN: readonly CapabilityTag[] = ['coding', 'reasoning', 'vision', 'fast', 'tool-use', 'long-context', 'json-mode', 'multilingual']
  const capabilities = info.capabilities.filter((tag: string): tag is CapabilityTag => (KNOWN as readonly string[]).includes(tag))
  const priced = info.costPer1kOutput !== null || info.costPer1kInput !== null
  return {
    id: info.id,
    display_name: info.name,
    capabilities,
    // legacy 档位只在六维成本缺失时被 scorer 回退使用：未定价取中性 medium。
    cost_level: priced ? costLevelOf(info.costPer1kOutput ?? info.costPer1kInput) : 'medium',
    context_window: info.contextWindow,
    max_output_tokens: 8_192,
    availability: 'direct',
    input_modalities: capabilities.includes('vision') ? ['text', 'image'] : ['text'],
    max_concurrency: DEFAULT_MAX_CONCURRENCY,
    quality_rank: Math.round(info.scores.reasoning.score * 0.2 + average * 0.8),
    tags: { tier: info.tier },
    tier: info.tier,
    dimensions: { ...scores } as DimensionSet,
    costPer1kInput: info.costPer1kInput,
    costPer1kOutput: info.costPer1kOutput,
  }
}

/** 每千 token 输出价 → legacy 成本档位（仅作展示与回退，六维成本才是主序）。 */
function costLevelOf(per1k: number | null): 'free' | 'low' | 'medium' | 'high' {
  if (per1k === null) return 'medium'
  if (per1k <= 0) return 'free'
  if (per1k <= 0.002) return 'low'
  if (per1k <= 0.02) return 'medium'
  return 'high'
}

/** 一家厂商能不能入池：有可用 Base URL、有凭据、勾了至少一个模型。 */
export function vendorIsRoutable(vendor: VendorConfig): boolean {
  const endpoint = vendor.customUrl !== '' ? vendor.customUrl : vendor.officialUrl
  return endpoint !== '' && vendor.apiKey !== '' && vendor.enabledModels.length > 0
}

/** 展开一家厂商的最终 Base URL。 */
export function vendorEndpoint(vendor: VendorConfig): string {
  return vendor.customUrl !== '' ? vendor.customUrl : vendor.officialUrl
}

/**
 * vendors.json → 完整 PoolConfig。
 * @param mode - 全局模式（面板切换时持久化在 vendors.json 里）。
 */
export function synthesizePool(vendors: VendorConfig[], mode: PoolConfig['routing']['mode'], cache: PoolConfig['routing']['cache']): PoolConfig {
  const providers: ProviderEntry[] = []
  for (const vendor of vendors) {
    if (!vendorIsRoutable(vendor)) continue
    const template = PROVIDER_TEMPLATES.find((entry) => entry.vendorId === vendor.vendorId)
    const models = vendor.enabledModels
      .map((modelId) => {
        const known = template !== undefined ? matchTemplateModel(template, modelId) : undefined
        const info = template !== undefined && known !== undefined ? templateModelToInfo(template, known) : unknownModelInfo(modelId)
        return modelInfoToEntry(info)
      })
    if (models.length === 0) continue
    providers.push({
      provider_name: vendor.vendorId,
      endpoint: vendorEndpoint(vendor),
      api: 'openai-completions',
      api_key: VENDOR_KEY_SENTINEL + vendor.vendorId,
      headers: {},
      models,
    })
  }
  return {
    version: 1,
    defaults: { ...SYNTH_DEFAULTS },
    routing: {
      mode,
      aliases: {},
      agent_overrides: {},
      cache: { ...cache },
    },
    providers,
  }
}

/** 已知的厂商目录（面板 Tab 与 Custom 的补全提示用）。 */
export function templateVendors(): readonly TemplateVendor[] {
  return PROVIDER_TEMPLATES
}
