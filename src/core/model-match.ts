/**
 * 上游型号 → 内置档案：把「换了个写法」「换了个路径」的同一个模型认出来。
 *
 * 为什么需要这一层：内置目录是按**官方 id** 写的（`claude-fable-5-1`、
 * `deepseek-v4-1-flash-1017`），而中转站、第三方平台、甚至官方自己的新一批
 * 别名，写出来的常是 `claude-fable-5`、`deepseek-flash`、`Qwen`。
 * 只做精确匹配的话，用户每接一家中转站都要给一堆本来认识的老朋友「自打标签」——
 * 那些标签本来就该由内置目录给出，跟从哪条线路进来无关。
 *
 * 命中顺序（先精确、后宽松，宁可查不到也不认错）：
 *  1. `id`      — 精确 id / 归一化 id / 显示名（沿用 matchTemplateModel 的三级命中）；
 *  2. `alias`   — 手工维护的别名表（同一模型的不同叫法）；
 *  3. `version` — 一边是另一边加**纯数字尾巴**（发版日期 / 小版本号）的快照关系；
 *  4. `family`  — 只认得出「这是哪一族」，于是只沿用能力与擅长标签，
 *                 **不继承评级、六维分与价目**——那些是具体型号的事实，不能借用。
 *
 * 价目也走这里：同一个模型在自己那个 id 下的价目优先于目录条目的 id，
 * 这样 `deepseek-v4-pro` 与 `deepseek-v4-pro-0813` 各拿各的公开价，不会被对方改掉。
 */
import {
  DIMENSION_KEYS,
  PROVIDER_TEMPLATES,
  matchTemplateModel,
  normalizeModelId,
  type TemplateModel,
  type TemplateVendor,
} from './provider-templates.ts'
import { listPriceOf } from './pricing.ts'
import type { DimensionSet, ModelInfo, ModelPrice } from './types.ts'

/** 命中方式。`family` 是「同族参考」，其余三种都是「同一个模型」。 */
export type ModelMatchKind = 'id' | 'alias' | 'version' | 'family'

/** 一次命中。 */
export interface ModelMatch {
  kind: ModelMatchKind
  /** 命中的内置档案；`family` 时是合成的同族档案（评级 NA、无价目）。 */
  model: TemplateModel
  /** 命中的厂商目录节；`family` 时没有。 */
  vendor?: TemplateVendor
  /** 同族的展示名（`family` 时有值，例如「Claude」）。 */
  familyLabel?: string
}

/**
 * 同一模型的不同叫法：目录 id → 上游可能写出来的其它 id。
 *
 * 只收「有据可查的同一模型」，不收「看起来像」的：写错一条，路由就会按
 * 别人的强弱与价钱去排一个它并不认识的模型，比查不到更糟。
 */
export const MODEL_ALIASES: Readonly<Record<string, readonly string[]>> = {
  // DeepSeek 官方文档里的「DeepSeek Flash」就是带发布日期的那个快照。
  'deepseek-v4-1-flash-1017': ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-chat'],
}

/** 归一化别名索引：别名 → 目录 id。 */
const ALIAS_INDEX: ReadonlyMap<string, string> = (() => {
  const index = new Map<string, string>()
  for (const [canonical, aliases] of Object.entries(MODEL_ALIASES)) {
    for (const spelling of [canonical, ...aliases]) index.set(normalizeModelId(spelling), canonical)
  }
  return index
})()

/** 一个「族」的通用档案：只写这一族的公认长处，不写具体型号的强弱。 */
export interface ModelFamily {
  familyId: string
  label: string
  pattern: RegExp
  /** 与目录 capabilities 同词表。 */
  capabilities: readonly string[]
  /** 与目录 strengthTags 同词表的擅长标签。 */
  strengthTags: readonly string[]
  imageInput?: boolean
  imageOutput?: boolean
  videoOutput?: boolean
}

/**
 * 族表：顺序即优先级。
 *
 * 图像 / 视频生成放在最前——`gpt-image-2` 必须落在图像族，而不是被 `gpt` 抢走。
 * 通用 `vl / vision` 放最后，只兜住前面都没认出来的多模态型号。
 */
export const MODEL_FAMILIES: readonly ModelFamily[] = [
  {
    familyId: 'image',
    label: '图像生成',
    pattern: /(^|[-_/.])(image|imagen|dall-?e|flux|stable-diffusion|sd3|midjourney)([-_/.]|$)/i,
    capabilities: ['image_gen'],
    strengthTags: ['图像生成'],
    imageOutput: true,
  },
  {
    familyId: 'video',
    label: '视频生成',
    pattern: /(^|[-_/.])(video|veo|sora|kling|seedance|cogvideo)([-_/.]|$)/i,
    capabilities: ['video_gen'],
    strengthTags: ['视频生成'],
    videoOutput: true,
  },
  {
    familyId: 'claude',
    label: 'Claude',
    pattern: /claude|anthropic/i,
    capabilities: ['coding', 'reasoning', 'vision', 'tool-use'],
    strengthTags: ['编程', '智能体', '推理'],
    imageInput: true,
  },
  {
    familyId: 'openai',
    label: 'GPT',
    pattern: /(^|[-_/.])(gpt|chatgpt|codex)([-_/.]|$)|^o[134](-|$)/i,
    capabilities: ['coding', 'reasoning', 'vision', 'tool-use'],
    strengthTags: ['编程', '推理', '智能体'],
    imageInput: true,
  },
  {
    familyId: 'gemini',
    label: 'Gemini',
    pattern: /gemini|gemma|palm-?\d/i,
    capabilities: ['coding', 'reasoning', 'vision', 'tool-use'],
    strengthTags: ['推理', '多模态'],
    imageInput: true,
  },
  {
    familyId: 'qwen',
    label: '通义千问',
    pattern: /qwen|tongyi|qwq/i,
    capabilities: ['coding', 'reasoning', 'tool-use'],
    strengthTags: ['中文', '编程'],
  },
  {
    familyId: 'deepseek',
    label: 'DeepSeek',
    pattern: /deepseek/i,
    capabilities: ['coding', 'reasoning', 'tool-use'],
    strengthTags: ['编程', '推理'],
  },
  {
    familyId: 'glm',
    label: 'GLM',
    pattern: /glm|chatglm|zhipu/i,
    capabilities: ['coding', 'reasoning', 'tool-use'],
    strengthTags: ['中文', '文案'],
  },
  {
    familyId: 'kimi',
    label: 'Kimi',
    pattern: /kimi|moonshot/i,
    capabilities: ['coding', 'reasoning', 'tool-use'],
    strengthTags: ['编程'],
  },
  {
    familyId: 'grok',
    label: 'Grok',
    pattern: /grok|xai/i,
    capabilities: ['coding', 'reasoning', 'tool-use'],
    strengthTags: ['前端', '编程'],
  },
  {
    familyId: 'llama',
    label: 'Llama',
    pattern: /llama/i,
    capabilities: ['coding', 'reasoning'],
    strengthTags: ['编程', '开源'],
  },
  {
    familyId: 'mistral',
    label: 'Mistral',
    pattern: /mistral|mixtral|codestral|devstral/i,
    capabilities: ['coding', 'reasoning'],
    strengthTags: ['文案'],
  },
  {
    familyId: 'ernie',
    label: 'ERNIE',
    pattern: /ernie|wenxin/i,
    capabilities: ['coding', 'fast'],
    strengthTags: ['中文', '快速'],
  },
  {
    familyId: 'doubao',
    label: '豆包',
    pattern: /doubao|(^|[-_/])seed([-_/]|$)/i,
    capabilities: ['coding', 'reasoning', 'vision', 'tool-use'],
    strengthTags: ['智能体', '多模态'],
    imageInput: true,
  },
  {
    familyId: 'hunyuan',
    label: '混元',
    pattern: /hunyuan|^hy\d/i,
    capabilities: ['coding', 'reasoning', 'tool-use'],
    strengthTags: ['中文'],
  },
  {
    familyId: 'mimo',
    label: 'MiMo',
    pattern: /mimo/i,
    capabilities: ['coding', 'reasoning', 'tool-use'],
    strengthTags: ['推理'],
  },
  {
    familyId: 'step',
    label: 'Step',
    pattern: /^step[-_]?\d|stepfun/i,
    capabilities: ['coding', 'reasoning'],
    strengthTags: ['做题'],
  },
  {
    familyId: 'minimax',
    label: 'MiniMax',
    pattern: /minimax|abab/i,
    capabilities: ['coding', 'reasoning', 'tool-use'],
    strengthTags: ['推理'],
  },
  {
    familyId: 'muse',
    label: 'Muse',
    pattern: /(^|[-_/])muse([-_/]|$)/i,
    capabilities: ['coding', 'reasoning', 'tool-use'],
    strengthTags: ['做题'],
  },
  {
    familyId: 'agnes',
    label: 'Agnes',
    pattern: /agnes/i,
    capabilities: ['coding', 'reasoning', 'tool-use'],
    strengthTags: ['推理'],
  },
  {
    familyId: 'inkling',
    label: 'Inkling',
    pattern: /inkling/i,
    capabilities: ['reasoning'],
    strengthTags: ['做题'],
  },
  {
    familyId: 'vision',
    label: '多模态',
    pattern: /(^|[-_/])(vl|vision)([-_/]|$)/i,
    capabilities: ['coding', 'vision'],
    strengthTags: ['多模态'],
    imageInput: true,
  },
]

/** 中性六维：不编造数值，路由按 50 处理，评级显示 NA。 */
function neutralScores(): DimensionSet {
  const scores = {} as DimensionSet
  for (const key of DIMENSION_KEYS) scores[key] = { score: 50, grade: 'NA' }
  return scores
}

/** 把一条族档案摊成一个目录条目的形状（评级 NA、无价目）。 */
function familyModel(family: ModelFamily, id: string): TemplateModel {
  return {
    id,
    name: id,
    tier: 'NA',
    contextWindow: 128_000,
    costPer1kInput: null,
    costPer1kOutput: null,
    capabilities: [...family.capabilities],
    scores: neutralScores(),
    strengthTags: [...family.strengthTags],
    ...(family.imageInput === true ? { imageInput: true } : {}),
    ...(family.imageOutput === true ? { imageOutput: true } : {}),
    ...(family.videoOutput === true ? { videoOutput: true } : {}),
  }
}

/** 在全部目录里按归一化 id 精确找一条。 */
function exactGlobal(modelId: string): { vendor: TemplateVendor, model: TemplateModel } | undefined {
  for (const vendor of PROVIDER_TEMPLATES) {
    const model = matchTemplateModel(vendor, modelId)
    if (model !== undefined) return { vendor, model }
  }
  return undefined
}

/**
 * 发版快照：`deepseek-v4-pro` ↔ `deepseek-v4-pro-0813`、`qwen3-8-max` ↔ `qwen3-8-max-0902`。
 *
 * 只认**日期样式的尾巴**（4–8 位纯数字，例如 0813 / 20251001）：那是同一个模型的
 * 快照标签，价目与强弱都该沿用。`claude-fable-5` 与 `claude-fable-5-1` 尾巴只有一位，
 * 那是**另一个小版本**，不是快照——把它俩认成一个，就会把 5 显示成 5.1、还借走它的评级。
 * `claude-haiku-4-5` 与 `claude-haiku-5-5` 同理不会被认成同一个。
 */
function versionMatch(modelId: string): { vendor: TemplateVendor, model: TemplateModel } | undefined {
  const wanted = normalizeModelId(modelId)
  if (wanted.length < 6) return undefined
  let best: { vendor: TemplateVendor, model: TemplateModel } | undefined
  let bestTail = Number.POSITIVE_INFINITY
  for (const vendor of PROVIDER_TEMPLATES) {
    for (const model of vendor.models) {
      const candidate = normalizeModelId(model.id)
      const longer = candidate.length >= wanted.length ? candidate : wanted
      const shorter = longer === candidate ? wanted : candidate
      if (!longer.startsWith(shorter)) continue
      const tail = longer.slice(shorter.length)
      if (tail.length < 4 || tail.length > 8 || !/^\d+$/.test(tail)) continue
      if (tail.length < bestTail) {
        bestTail = tail.length
        best = { vendor, model }
      }
    }
  }
  return best
}

/**
 * 认一个上游型号。
 * @param modelId - 上游真实写法（发给上游的那个字符串）。
 * @param vendor - 可选的「当前这一家」目录节；给了就先在它自己家里找，避免跨家抢人。
 */
export function resolveModelProfile(modelId: string, vendor?: TemplateVendor): ModelMatch | undefined {
  if (vendor !== undefined) {
    const local = matchTemplateModel(vendor, modelId)
    if (local !== undefined) return { kind: 'id', model: local, vendor }
  }
  const exact = exactGlobal(modelId)
  if (exact !== undefined) return { kind: 'id', model: exact.model, vendor: exact.vendor }

  const canonical = ALIAS_INDEX.get(normalizeModelId(modelId))
  if (canonical !== undefined) {
    for (const entry of PROVIDER_TEMPLATES) {
      const model = entry.models.find((candidate) => candidate.id === canonical)
      if (model !== undefined) return { kind: 'alias', model, vendor: entry }
    }
  }

  const snapshot = versionMatch(modelId)
  if (snapshot !== undefined) return { kind: 'version', model: snapshot.model, vendor: snapshot.vendor }

  for (const family of MODEL_FAMILIES) {
    if (!family.pattern.test(modelId)) continue
    return { kind: 'family', model: familyModel(family, modelId), familyLabel: family.label }
  }
  return undefined
}

/**
 * 这个型号该按哪一份价目算。
 *
 * 先按**用户实际写的 id** 查（归一化后），查到就用它；查不到再退回目录条目的 id。
 * 这样同一族的两个快照各拿各的公开价，不会因为「认成了另一条」而串价。
 */
export function resolveModelPrice(modelId: string): ModelPrice | undefined {
  const own = listPriceOf(modelId)
  if (own !== undefined) return own
  const match = resolveModelProfile(modelId)
  if (match === undefined || match.kind === 'family') return undefined
  return listPriceOf(match.model.id)
}

/** 命中结果 → 路由层的 ModelInfo 视图。`id` 永远是用户写的那一个。 */
export function modelMatchToInfo(match: ModelMatch, modelId: string): ModelInfo {
  const model = match.model
  const price = match.kind === 'family' ? undefined : resolveModelPrice(modelId)
  return {
    id: modelId,
    // 精确 / 别名 / 发版快照都是同一个型号，沿用目录里的名字（更好读）；
    // 同族是「另一个型号」，只借标签——名字必须留上游自己的。
    name: match.kind === 'family' ? modelId : model.name,
    tier: model.tier,
    contextWindow: model.contextWindow,
    costPer1kInput: model.costPer1kInput,
    costPer1kOutput: model.costPer1kOutput,
    capabilities: [...model.capabilities],
    scores: { ...model.scores },
    ...(model.strengths !== undefined ? { strengths: model.strengths } : {}),
    ...(model.strengthTags !== undefined ? { strengthTags: [...model.strengthTags] } : {}),
    ...(model.imageInput === true ? { imageInput: true } : {}),
    ...(model.imageOutput === true ? { imageOutput: true } : {}),
    ...(model.videoOutput === true ? { videoOutput: true } : {}),
    ...(price === undefined ? {} : { price }),
  }
}
