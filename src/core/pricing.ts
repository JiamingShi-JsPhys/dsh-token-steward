/**
 * 价格层：把「贵 / 便宜 / 省了多少」变成可计算的事实。
 *
 * 三条纪律，与面板的诚实规则同源：
 *  1. 未定价 = null，不是 0——0 会被读成「免费」，那是错的；
 *  2. 货币不混算：CNY 与 USD 各自累计，绝不加在一起；
 *  3. 目录价是**榜单估算价**（USD / 百万 token），用户可在 vendors.json 里
 *     按模型覆盖；覆盖优先于目录，目录优先于 YAML 的 pricing。
 *
 * 纯函数，不读文件、不读时钟，因此「最便宜」「成本适中」「今日已省」
 * 都能被单测钉死。
 */
import type { ModelEntry, ModelInfo, ModelPrice, TokenUsage } from './types.ts'

/** 一个模型的价目：USD（或指定币种）/ 百万 token。 */
export type { ModelPrice }

/** 一次调用的金额。 */
export interface MoneyAmount {
  currency: string
  amount: number
}

/**
 * 目录模型的榜单估算价（USD / 1M tokens）。
 *
 * 2026-11 按官方定价页核过一轮：官方页能直读的用官方数字（DeepSeek / 火山 /
 * 智谱 / Kimi / MiniMax / StepFun / 硅基流动 / OpenRouter）；境外厂商本机直连
 * 失败，改用 OpenRouter 现价 + LiteLLM 价格表双源交叉，两源一致才写。
 * 人民币价按 7.1 折算 USD，只用于横向比较。
 *
 * 仍然只是「参考价」：真实账单以厂商为准，用户在设置页逐模型覆盖的值优先。
 */
export const LIST_PRICES: Readonly<Record<string, ModelPrice>> = {

  // 免费额度：真实价格为 0，路由在「极致便宜」档会优先用它们
  'glm-4-5-flash': { input: 0, output: 0 },
  'glm-4-flash-250414': { input: 0, output: 0 },
  'glm-z1-flash': { input: 0, output: 0 },
  'glm-4v-flash': { input: 0, output: 0 },
  'ernie-speed-128k': { input: 0, output: 0 },
  'ernie-speed-pro-128k': { input: 0, output: 0 },
  'ernie-lite-8k': { input: 0, output: 0 },
  'ernie-tiny-8k': { input: 0, output: 0 },
  'Qwen/Qwen2.5-7B-Instruct': { input: 0, output: 0 },
  'THUDM/glm-4-9b-chat': { input: 0, output: 0 },
  'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B': { input: 0, output: 0 },
  'deepseek/deepseek-r1:free': { input: 0, output: 0 },
  'qwen/qwen3-8b:free': { input: 0, output: 0 },
  'meta-llama/llama-3.3-70b-instruct:free': { input: 0, output: 0 },
  // Anthropic
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-fable-5-1': { input: 12, output: 60 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  // OpenAI
  'gpt-6-astra': { input: 10, output: 40 },
  'gpt-6-1-sol': { input: 8, output: 32 },
  'gpt-6-luna': { input: 1.5, output: 6 },
  // Google
  'gemini-4-argon': { input: 5, output: 20 },
  'gemini-3-8-flash': { input: 0.5, output: 3 },
  'gemini-3-5-flash-lite': { input: 0.1, output: 0.4 },
  // Meta（开源托管）
  'muse-wonder-full': { input: 4, output: 16 },
  'muse-wonder': { input: 2, output: 8 },
  'muse-spark-1-3': { input: 1.25, output: 4.25 },
  'muse-spark-open': { input: 0.3, output: 1.2 },
  'muse-glimmer': { input: 0.08, output: 0.3 },
  // DeepSeek
  'deepseek-v4-1-flash-1017': { input: 0.28, output: 1.1 },
  'deepseek-v4-pro-0813': { input: 0.14, output: 0.56 },
  // 豆包（火山方舟）
  'doubao-seed-1-6': { input: 0.85, output: 4.23 },
  'doubao-seed-1-6-flash': { input: 0.11, output: 0.38 },
  'doubao-1-5-pro-32k': { input: 0.3, output: 0.9 },
  'doubao-1-5-lite-32k': { input: 0.08, output: 0.3 },
  // Agnes —— 免费只覆盖 2.0 flash 与 3.0 flash 两档（2026-06 起无限期免费），
  // 其余档位照常计费。别把整家都标成 0：免费档会照着这个价目真去调付费型号。
  'agnes-2-0-flash': { input: 0, output: 0 },
  'agnes-3-0-flash': { input: 0, output: 0 },
  'agnes-2-5-pro': { input: 0.6, output: 2.4 },
  'agnes-2-5-pro-alpha': { input: 0.6, output: 2.4 },
  'agnes-2-5-pro-beta': { input: 0.5, output: 2 },
  'agnes-2-5-flash': { input: 0.03, output: 0.15 },
  'agnes-image-2-0-flash': { input: 0.02, output: 0.08 },
  'agnes-image-2-5-flash': { input: 0.02, output: 0.08 },
  'agnes-image-2-1-flash': { input: 0.02, output: 0.08 },
  'agnes-video-2-5': { input: 0.05, output: 0.2 },
  'agnes-video-2-5-flash': { input: 0.03, output: 0.12 },
  // Inkling
  inkling: { input: 1, output: 4.05 },
  'inkling-small': { input: 0.1, output: 0.4 },
  // Moonshot
  'kimi-k3-1-pro': { input: 0.6, output: 2.5 },
  // Alibaba
  'qwen3-8-max-0902': { input: 0.6, output: 2.4 },
  'qwen3-8-flash-next': { input: 0.15, output: 0.6 },
  'qwen3-8-27b': { input: 0.1, output: 0.4 },
  // Xiaomi
  'mimo-v2-6-pro': { input: 0.5, output: 2 },
  'mimo-v2-6-flash': { input: 0.1, output: 0.4 },
  // Z.ai / 智谱
  'glm-5-3': { input: 0.4, output: 1.6 },
  'glm-5-3-flash': { input: 0.05, output: 0.2 },
  // MiniMax
  'minimax-m3-1-flash': { input: 0.2, output: 0.8 },
  'minimax-m3': { input: 0.59, output: 2.37 },
  // xAI
  'grok-4-7': { input: 2, output: 6 },
  // Mistral
  'mistral-large-4-preview': { input: 2, output: 6 },
  'mistral-medium-3-5': { input: 0.4, output: 2 },
  'mistral-small-4': { input: 0.1, output: 0.3 },
  // StepFun
  'step-5-preview': { input: 0.4, output: 1.6 },
  'step-3-7-flash': { input: 0.19, output: 1.14 },
  'step3-vl-10b': { input: 0.05, output: 0.2 },

  // ── 2026-11 核过的现役型号（官方价 / OpenRouter 现价 / LiteLLM 三源交叉）──
  // 人民币标价的按 7.1 折算成 USD，只用于横向比较；调价后在设置页逐模型覆盖。
  'gpt-5-2': { input: 1.75, output: 14 },
  'gpt-5-4-mini': { input: 0.75, output: 4.5 },
  'o4-mini': { input: 1.1, output: 4.4 },
  'gemini-3-pro': { input: 2, output: 12 },
  'gemini-3-pro-preview': { input: 2, output: 12 },
  'gemini-3-flash': { input: 0.5, output: 3 },
  'gemini-3-flash-preview': { input: 0.5, output: 3 },
  'gemini-3-1-flash-lite': { input: 0.25, output: 1.5 },
  'deepseek-flash': { input: 0.28, output: 1.13 },
  'deepseek-v4-pro': { input: 1.27, output: 3.8 },
  'doubao-seed-2-1-pro': { input: 0.85, output: 4.23 },
  'doubao-seed-2-1-lite': { input: 0.11, output: 0.38 },
  'kimi-k3': { input: 3, output: 15 },
  'kimi-k2-6': { input: 0.95, output: 4 },
  'qwen3-8-max': { input: 1.69, output: 5.07 },
  'qwen3-8-flash': { input: 0.15, output: 0.47 },
  'glm-5': { input: 0.56, output: 2.54 },
  'glm-4-5-air': { input: 0.11, output: 0.28 },
  'minimax-m2-7': { input: 0.21, output: 0.84 },
  'hunyuan-t1': { input: 0.14, output: 0.56 },
  'hunyuan-turbos': { input: 0.11, output: 0.28 },
  'grok-4-fast': { input: 0.2, output: 0.5 },
  'mistral-large-3': { input: 0.5, output: 1.5 },
  'mistral-small-2603': { input: 0.15, output: 0.6 },
  'step-3-5-flash': { input: 0.1, output: 0.3 },
  'mimo-v2-5': { input: 0.4, output: 2 },
}

/**
 * 查价：上游真实 id（`agnes-3.0-flash`）与价目表的键（`agnes-3-0-flash`）写法不同，
 * 直接查会全部落空——免费档的「免费」判定、面板的自动勾选都靠这一步，必须归一。
 * 只做最小归一（小写 + 点转横线），不学 matchTemplateModel 那套激进匹配：
 * 价目算错比查不到更糟。
 */
export function listPriceOf(modelId: string): ModelPrice | undefined {
  const direct = LIST_PRICES[modelId]
  if (direct !== undefined) return direct
  const lower = modelId.trim().toLowerCase()
  return LIST_PRICES[lower] ?? LIST_PRICES[lower.replace(/\./g, '-')]
}

/**
 * 这个模型在价目表里是不是零成本（输入输出都是 0）。
 *
 * 只认「明确写了 0」的条目；查不到价格的是未知，不是免费——
 * 免费档绝不能把「不知道多少钱」当成「不要钱」。
 */
export function isFreePriced(modelId: string): boolean {
  const price = listPriceOf(modelId)
  if (price === undefined) return false
  return price.input === 0 && price.output === 0
}

/** 目录估算价的币种（榜单以美元计价）。 */
export const LIST_PRICE_CURRENCY = 'USD'

/**
 * 一个模型生效的价目（每百万 token）。
 *
 * 优先级：`pricing`（YAML 显式配置）→ `costPer1k*`（目录/用户覆盖，按 1000 折算）
 * → 未定价 null。
 */
export function priceOf(model: Pick<ModelEntry, 'pricing' | 'costPer1kInput' | 'costPer1kOutput'>): { currency: string, input: number, output: number } | null {
  if (model.pricing !== undefined) {
    return {
      currency: model.pricing.currency,
      input: model.pricing.input_per_mtok,
      output: model.pricing.output_per_mtok,
    }
  }
  const input = model.costPer1kInput
  const output = model.costPer1kOutput
  if ((input === null || input === undefined) && (output === null || output === undefined)) return null
  return {
    currency: LIST_PRICE_CURRENCY,
    input: (input ?? 0) * 1_000,
    output: (output ?? 0) * 1_000,
  }
}

/** 一次 token 用量换算成金额；未定价返回 null。 */
export function costOfUsage(
  price: { currency: string, input: number, output: number } | null,
  usage: Pick<TokenUsage, 'input' | 'output'>,
): MoneyAmount | null {
  if (price === null) return null
  const amount = (usage.input / 1_000_000) * price.input + (usage.output / 1_000_000) * price.output
  if (!Number.isFinite(amount) || amount < 0) return null
  return { currency: price.currency, amount }
}

/**
 * 用基准模型（通常是六维总和最高的那个）衡量「这次选便宜模型省了多少」。
 * 基准更便宜或未定价时返回 0：节省不能是负数，也不能凭空捏造。
 */
export function savingAgainst(
  chosen: Pick<ModelEntry, 'pricing' | 'costPer1kInput' | 'costPer1kOutput'>,
  baseline: Pick<ModelEntry, 'pricing' | 'costPer1kInput' | 'costPer1kOutput'>,
  usage: Pick<TokenUsage, 'input' | 'output'>,
): MoneyAmount | null {
  const chosenCost = costOfUsage(priceOf(chosen), usage)
  const baselineCost = costOfUsage(priceOf(baseline), usage)
  if (chosenCost === null || baselineCost === null) return null
  if (chosenCost.currency !== baselineCost.currency) return null
  const saved = baselineCost.amount - chosenCost.amount
  if (saved <= 0) return { currency: chosenCost.currency, amount: 0 }
  return { currency: chosenCost.currency, amount: saved }
}

/** 目录条目 → 生效价（目录估算，供 provider-templates 合成）。 */
export function priceForModelInfo(info: Pick<ModelInfo, 'id'>): ModelPrice | undefined {
  return listPriceOf(info.id)
}

/** 每 1k 输出价（成本排序的稳定口径）。 */
export function outputPer1k(model: Pick<ModelEntry, 'pricing' | 'costPer1kInput' | 'costPer1kOutput'>): number | null {
  const price = priceOf(model)
  if (price === null) return null
  return price.output / 1_000
}
