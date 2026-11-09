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
  ApiShape,
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
  unknownModelInfo,
  PROVIDER_TEMPLATES,
  type TemplateVendor,
} from './provider-templates.ts'
import { modelMatchToInfo, resolveModelProfile } from './model-match.ts'

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
/**
 * 引擎认得的能力标签。
 *
 * 用户在面板里给模型打的标签，如果正好是这几个之一（`vision`、`tool-use` …），
 * 它就是一条**能力声明**，必须参与路由硬过滤；其余标签只作展示与选路提示。
 * 以前这里只写进 `strengthTags`，于是「给模型标了 vision」只改了个徽标，
 * 带图的请求照样被 `missing-capability:vision` 拒掉——用户看到一个盘子里
 * 明明能看图的模型，管家却说他不是多模态。
 */
export const CAPABILITY_TAGS: readonly CapabilityTag[] = [
  'coding', 'reasoning', 'vision', 'fast', 'tool-use', 'long-context', 'json-mode', 'multilingual',
]

/** 这个标签是不是引擎能力（而不是纯展示标签）。 */
export function isCapabilityTag(tag: string): tag is CapabilityTag {
  return (CAPABILITY_TAGS as readonly string[]).includes(tag)
}

/**
 * 标签的另一种写法 → 能力。
 *
 * 面板上的标签是给人打的，中文比 `vision` 自然得多（占位符里写的就是
 * 「多模态」）。可引擎只认英文枚举，认不出来就等于没打——用户明明标了
 * 「多模态」，带图的请求照样被拒。这里把常见叫法翻过去。
 */
const CAPABILITY_ALIASES: Readonly<Record<string, CapabilityTag>> = {
  coding: 'coding', 编程: 'coding', 代码: 'coding', 写代码: 'coding',
  reasoning: 'reasoning', 推理: 'reasoning', 思考: 'reasoning',
  vision: 'vision', 多模态: 'vision', 看图: 'vision', 视觉: 'vision', 图像理解: 'vision',
  fast: 'fast', 快速: 'fast', 低延迟: 'fast',
  'tool-use': 'tool-use', 工具: 'tool-use', 工具调用: 'tool-use', 函数调用: 'tool-use',
  'long-context': 'long-context', 长上下文: 'long-context', 长文本: 'long-context',
  'json-mode': 'json-mode', json: 'json-mode',
  multilingual: 'multilingual', 多语言: 'multilingual',
}

/** 把一个用户标签认成引擎能力；不是能力标签就返回 undefined。 */
export function capabilityOf(tag: string): CapabilityTag | undefined {
  const trimmed = tag.trim()
  const normalized = trimmed.toLowerCase().replace(/[\s_]+/g, '-')
  return CAPABILITY_ALIASES[normalized] ?? CAPABILITY_ALIASES[trimmed]
}

export function modelInfoToEntry(info: ModelInfo): ModelEntry {
  const scores = info.scores
  const values = (Object.values(scores) as DimensionScore[]).map((entry) => entry.score)
  const average = values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
  // 引擎的 capabilities 只认识已知标签；目录里的 image_gen 等展示型标签不参与硬过滤。
  const capabilities = info.capabilities.filter((tag: string): tag is CapabilityTag => isCapabilityTag(tag))
  const price = info.price ?? null
  const priced = price !== null
  return {
    id: info.id,
    display_name: info.name,
    capabilities,
    // legacy 档位只在六维成本缺失时被 scorer 回退使用：未定价取中性 medium。
    cost_level: priced ? costLevelOf(price.output / 1_000) : 'medium',
    context_window: info.contextWindow,
    max_output_tokens: 8_192,
    availability: 'direct',
    input_modalities: capabilities.includes('vision') ? ['text', 'image'] : ['text'],
    max_concurrency: DEFAULT_MAX_CONCURRENCY,
    quality_rank: Math.round(info.scores.reasoning.score * 0.2 + average * 0.8),
    tags: { tier: info.tier },
    tier: info.tier,
    dimensions: { ...scores } as DimensionSet,
    costPer1kInput: priced ? price.input / 1_000 : null,
    costPer1kOutput: priced ? price.output / 1_000 : null,
    ...(priced ? { pricing: { currency: 'USD', input_per_mtok: price.input, output_per_mtok: price.output } } : {}),
    ...(info.strengths !== undefined ? { strengths: info.strengths } : {}),
    ...(info.strengthTags !== undefined ? { strengthTags: [...info.strengthTags] } : {}),
    ...(info.imageInput === true ? { imageInput: true } : {}),
    ...(info.imageOutput === true ? { imageOutput: true } : {}),
    ...(info.videoOutput === true ? { videoOutput: true } : {}),
    // 非对话模型不进路由：中转站的模型列表里，画图的、配音的、向量 / 重排的
    // 和聊天模型长得一模一样，选进去只会让某一轮对话莫名其妙地 400。
    ...(looksLikeNonChat(info.id) || info.imageOutput === true || info.videoOutput === true ? { chat: false } : {}),
  }
}

/**
 * 名字一看就知道不是对话模型：向量 / 重排 / 画图 / 配音 / 视频。
 *
 * 只看名字这一层，是因为目录里还认识不到的那些型号没有 imageOutput 之类的标记；
 * 目录认识的那些由 `modelInfoToEntry` 按 imageOutput / videoOutput 直接判。
 */
export function looksLikeNonChat(id: string): boolean {
  return /embed|rerank|dall-?e|imagen|midjourney|flux|stable-diffusion|whisper|moderation/i.test(id)
    || /(^|[-_/.])(image|video|veo|sora|kling|seedance|audio|speech|tts)([-_/.]|$)/i.test(id)
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

/**
 * 这家厂商实际说哪套协议。
 *
 * 没显式配置时按地址猜：官方 Anthropic 端点（`*.anthropic.com`）说的是
 * `/v1/messages`；其余一律当 OpenAI 兼容——中转站绝大多数都是这一套，
 * 哪怕它挂着 anthropic 的名字。
 */
export function apiShapeFor(vendor: VendorConfig): ApiShape {
  if (vendor.api !== undefined) return vendor.api
  return isAnthropicHost(vendorEndpoint(vendor)) ? 'anthropic-messages' : 'openai-completions'
}

/** 地址是不是 Anthropic 官方域名。 */
export function isAnthropicHost(endpoint: string): boolean {
  try {
    return /(^|\.)anthropic\.com$/i.test(new URL(endpoint).hostname)
  } catch {
    return /anthropic\.com/i.test(endpoint)
  }
}

/** 展开一家厂商的最终 Base URL。 */
export function vendorEndpoint(vendor: VendorConfig): string {
  const official = (vendor.officialUrl ?? '').trim()
  const relay = (vendor.customUrl ?? '').trim()
  const source = vendor.endpointSource ?? (relay !== '' ? 'relay' : 'official')
  if (source === 'relay') return relay !== '' ? relay : official
  return official !== '' ? official : relay
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
        // 认型号：先这家自己的目录，再全域目录（别名 / 快照 / 同族逐级放宽）。
        // 内置的强度与擅长标签跟接入线路无关，能对上就该沿用；对不上才是「未收录」。
        // 目录只提供元数据（名称 / 评级 / 价目）；**id 必须用用户配置的原始写法**，
        // 因为它是真正发给上游的那个字符串。目录里的规范化 id（agnes-3-0-flash）
        // 和上游真实 id（agnes-3.0-flash）并不总是同一个，替换过去就是 400。
        const match = resolveModelProfile(modelId, template)
        const catalogued = match !== undefined ? modelMatchToInfo(match, modelId) : unknownModelInfo(modelId)
        // 用户在面板里覆盖的价目优先于目录估算价。
        const override = vendor.modelPricing?.[modelId]
        const base = override === undefined ? catalogued : { ...catalogued, price: { ...override } }
        // 用户在面板里给模型打的标签。两种含义各归各位：
        //  - 能力型（vision / tool-use …）→ 进 capabilities，参与硬过滤与模态判定；
        //  - 其余（「中文」「文案」…）→ 只进 strengthTags，给 AI 调控与展示看。
        const userTags = vendor.modelTags?.[modelId] ?? []
        const userCapabilities = userTags
          .map((tag) => capabilityOf(tag))
          .filter((tag): tag is CapabilityTag => tag !== undefined)
        const info: ModelInfo = userTags.length === 0
          ? base
          : {
            ...base,
            capabilities: [...new Set([...base.capabilities, ...userCapabilities])],
            ...(userCapabilities.includes('vision') ? { imageInput: true } : {}),
            strengthTags: [...(base.strengthTags ?? []), ...userTags.filter((tag) => !(base.strengthTags ?? []).includes(tag))],
          }
        const entry = modelInfoToEntry(info)
        // 目录里没有价目的型号，按两条线索推定零成本，让它进得了白嫖：
        //  - 自定义厂家（目录里根本没有这家）：用户是手动勾进来的，白嫖就该认它；
        //  - 型号名里就写着 free（`…-free`）：上游自己标的免费额度，目录没跟上而已。
        // 只推定 cost_level，不编价目——成本看板照旧记「未定价」。
        // 用户给了价目（哪怕覆盖成 0）就按用户的走，这条不再生效。
        const unpriced = entry.costPer1kInput === null && entry.costPer1kOutput === null
        const namedFree = /(^|[-_.])free$/i.test(modelId)
        if (unpriced && (template === undefined || namedFree)) {
          entry.cost_level = 'free'
          entry.freeAssumed = true
        }
        return entry
      })
    if (models.length === 0) continue
    providers.push({
      provider_name: vendor.vendorId,
      endpoint: vendorEndpoint(vendor),
      api: apiShapeFor(vendor),
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
