/**
 * AI 娘头像注册表。
 *
 * 模型卡左上角是一枚 40×40 的六边形头像：有图用图，没图用「厂商首字母 +
 * 确定性几何纹样」兜底——绝不出现裂图，也绝不为了好看编一个不存在的链接。
 *
 * 键支持三级覆盖（先精确、后厂商、最后通用）：
 *   'vendor/model'  单个模型
 *   'vendor'        整家厂商
 *   '*'             全局默认
 *
 * 用户提供榜单图片后，只需在 AVATAR_URLS 里加一行（或运行时调 registerAvatar），
 * 面板无需改动。URL 可以是 https、data: 或插件包内的相对路径。
 */
import { BUNDLED_VENDOR_AVATARS, bundledAvatarUrl } from './avatar-assets.ts'

/** 头像形状：目录模型六边形，未收录模型圆形。 */
export type AvatarShape = 'hex' | 'circle'

/** 头像规格。 */
export interface AvatarSpec {
  /** 命中的注册表键；未命中时是 provider 本身。 */
  key: string
  /** 远程/内联图片地址；无图时 undefined，组件渲染字母兜底。 */
  url: string | undefined
  /** 字母兜底：厂商首字母（大写）。 */
  letter: string
  /** 形状：目录模型用六边形，未收录模型用圆形。 */
  shape: AvatarShape
  /** 几何纹样的色相（0-359），由 provider 稳定推导。 */
  hue: number
}

/** 榜单头像 URL。键见文件头注释；留空即全部走字母兜底。 */
export const AVATAR_URLS: Record<string, string> = {
  // 例：'anthropic/claude-opus-5-5': 'https://…/opus-5-5.webp',
  // 例：'anthropic': 'https://…/anthropic.webp',
}

/** 运行时注册一张头像（Agent / 设置页导入后用）。 */
export function registerAvatar(key: string, url: string): void {
  AVATAR_URLS[key] = url
}

/**
 * provider 名只是「一个桶」时（中转站常把模型全挂在 custom 下），
 * 用它自己的首字母没有意义，改用模型名首字母。
 */
const GENERIC_PROVIDERS: ReadonlySet<string> = new Set([
  'custom', 'default', 'relay', 'proxy', 'local', 'api', 'openai-compatible', 'compatible',
])

/** provider 名里的厂商别名。 */
const PROVIDER_VENDORS: Record<string, string> = {
  anthropic: 'anthropic',
  claude: 'anthropic',
  openai: 'openai',
  azure: 'openai',
  google: 'google',
  gemini: 'google',
  deepmind: 'google',
  meta: 'meta',
  llama: 'meta',
  moonshot: 'moonshot',
  kimi: 'moonshot',
  deepseek: 'deepseek',
  xiaomi: 'xiaomi',
  mimo: 'xiaomi',
  alibaba: 'alibaba',
  qwen: 'alibaba',
  dashscope: 'alibaba',
  minimax: 'minimax',
  abab: 'minimax',
  xai: 'xai',
  grok: 'xai',
  zhipu: 'zhipu',
  zai: 'zhipu',
  bigmodel: 'zhipu',
  glm: 'zhipu',
  stepfun: 'stepfun',
  mistral: 'mistral',
  inkling: 'inkling',
}

/** 模型名 → 厂商：中转站把所有模型挂在 custom 下时，靠这个认出是谁家的。 */
const MODEL_VENDORS: ReadonlyArray<readonly [RegExp, string]> = [
  [/qwen|qwq|qvq/i, 'alibaba'],
  [/deepseek/i, 'deepseek'],
  [/glm|chatglm|zhipu/i, 'zhipu'],
  [/claude|opus|sonnet|haiku/i, 'anthropic'],
  [/gpt|chatgpt|davinci/i, 'openai'],
  [/gemini|gemma|palm/i, 'google'],
  [/kimi|moonshot/i, 'moonshot'],
  [/minimax|abab/i, 'minimax'],
  [/grok/i, 'xai'],
  [/mistral|mixtral|codestral|devstral/i, 'mistral'],
  [/step[-_.]?\d|stepfun/i, 'stepfun'],
  [/llama/i, 'meta'],
  [/mimo|xiaomi/i, 'xiaomi'],
  [/inkling/i, 'inkling'],
]

/** provider 或模型名归一：小写、去掉分隔符，便于别名匹配。 */
function normalizeName(text: string): string {
  return text.trim().toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/**
 * 认出这个模型属于哪家厂商（只认内置头像里真有的厂商）。
 *
 * 顺序：provider 名 → 模型名。都对不上返回 undefined（走字母兜底），
 * 绝不为了「看起来有头像」而瞎猜一家。
 */
export function vendorIdOf(provider: string, model: string): string | undefined {
  const fromProvider = PROVIDER_VENDORS[normalizeName(provider)]
  if (fromProvider !== undefined && BUNDLED_VENDOR_AVATARS.has(fromProvider)) return fromProvider
  const bareProvider = normalizeName(provider)
  if (BUNDLED_VENDOR_AVATARS.has(bareProvider)) return bareProvider
  for (const [pattern, vendor] of MODEL_VENDORS) {
    if (pattern.test(model) && BUNDLED_VENDOR_AVATARS.has(vendor)) return vendor
  }
  return undefined
}

/** 按三级键查图；没有自定义图时用榜单裁出的内置头像。 */
export function avatarUrlOf(provider: string, model: string): string | undefined {
  const vendor = vendorIdOf(provider, model)
  return AVATAR_URLS[provider + '/' + model]
    ?? AVATAR_URLS[provider]
    ?? AVATAR_URLS['*']
    ?? (vendor === undefined ? undefined : bundledAvatarUrl(vendor))
}

/** 稳定哈希：同一个名字永远得到同一个色相。 */
export function hueOf(text: string): number {
  let hash = 0
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) % 360
  }
  return hash
}

/** 一个模型的头像规格。 */
export function avatarFor(provider: string, model: string, known: boolean): AvatarSpec {
  // 中转站把模型挂在 custom 下时，「C」毫无信息量，改用模型名首字母。
  const letterSource = GENERIC_PROVIDERS.has(normalizeName(provider)) ? model : provider
  const letter = (letterSource.trim()[0] ?? provider.trim()[0] ?? model.trim()[0] ?? '?').toUpperCase()
  return {
    key: AVATAR_URLS[provider + '/' + model] !== undefined ? provider + '/' + model : provider,
    url: avatarUrlOf(provider, model),
    letter,
    shape: known ? 'hex' : 'circle',
    hue: hueOf(provider + '/' + model),
  }
}
