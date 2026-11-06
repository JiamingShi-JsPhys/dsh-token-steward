/**
 * 从一次 OpenAI 兼容请求里推断路由意图。
 *
 * 纯函数：不读时钟（now 由调用方带入）、不碰网络。网关把它当成唯一的
 * 「请求 → 意图」翻译层，因此这段逻辑可以被单测钉死，而不是只能在真机上试。
 *
 * 推断的三条原则：
 *  1. 宁可少要求，不可错要求——多要一个能力标签会让可用模型突然消失；
 *  2. 有 tools 就必须有 tool-use，这不是偏好而是硬约束（模型不会调工具，任务必然失败）；
 *  3. 虚拟模型 id 是显式的用户意图，优先于任何自动推断。
 */
import type { CapabilityTag, DimensionKey, InputModality, RouteIntent, RoutingMode } from './types.ts'

/** 虚拟模型 id 的前缀。 */
export const VIRTUAL_PREFIX = 'steward:'

/** 四个模式虚拟 id。 */
export const MODE_IDS: Record<string, RoutingMode> = {
  'steward:auto': 'frugal',
  'steward:frugal': 'frugal',
  'steward:balanced': 'balanced',
  'steward:max_power': 'max_power',
  'steward:free': 'free',
}

/**
 * 档位虚拟 id：不是「模式」，而是「这类请求的选路哲学」。
 *
 * `steward:subagent` 给子代理用：DSH 的 `dsh-tool-subagent` 可以把
 * `agentOptions.model` 指到这里，于是所有子代理都按同一套「agentic 质量 +
 * 成本 + 窗口 + 并发分散」的打分选模型，而不用主代理自己猜。
 */
export const PROFILE_IDS: Record<string, 'subagent'> = {
  'steward:subagent': 'subagent',
}

/** 一段文本的粗略 token 估算：4 字符 ≈ 1 token。 */
const CHARS_PER_TOKEN = 4

/** 一张图片的固定估算：主流视觉模型按 1024×1024 折算后大致落在这一档。 */
const IMAGE_TOKEN_COST = 1_000

/** 一条 message 的结构开销（role 字段等）。 */
const MESSAGE_OVERHEAD_TOKENS = 4

/**
 * 友好的模型写法 → 虚拟 id。
 *
 * 宿主会把模型 id 原样塞进 persona（「powered by the {{model}} model」），
 * 于是 `steward:auto` 会被模型自己念出来。让配置里直接写 `Steward Auto`
 * 这类人话，这里再做一次归一（忽略大小写与所有分隔符）。
 */
const FRIENDLY_IDS: Record<string, string> = {
  stewardauto: 'steward:auto',
  stewardfrugal: 'steward:frugal',
  stewardbalanced: 'steward:balanced',
  stewardmaxpower: 'steward:max_power',
  stewardfree: 'steward:free',
  stewardsubagent: 'steward:subagent',
}

/**
 * 中文写法 → 虚拟 id。
 *
 * 模型选择界面要给人看中文，可配置里写的 id 会原样发给网关，
 * 所以「管家·自动」这种写法必须在这里认出是同一条路由。
 * 名称与面板上的调度模式一致：极致便宜 / 效率优先 / 最强火力。
 */
const CHINESE_IDS: Record<string, string> = {
  管家自动: 'steward:auto',
  管家极致便宜: 'steward:frugal',
  管家效率优先: 'steward:balanced',
  管家最强火力: 'steward:max_power',
  管家白嫖: 'steward:free',
  管家白嫖模式: 'steward:free',
  管家子代理: 'steward:subagent',
  管家子代理模式: 'steward:subagent',
}

/** 把 `管家·自动` / `Steward Auto` / `steward:auto` 统一成虚拟 id；其余原样返回。 */
export function canonicalModelId(modelId: string): string {
  const trimmed = modelId.trim()
  // 中文名只去掉分隔符（· ・ - _ . / 和空白），保留汉字本身。
  const chinese = trimmed.replace(/[\s·・\-_./]+/g, '')
  const named = CHINESE_IDS[chinese]
  if (named !== undefined) return named
  const key = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '')
  return FRIENDLY_IDS[key] ?? trimmed
}

/** 解析出的虚拟路由意图。 */
export interface VirtualRoute {
  /** steward:auto 之类；不是虚拟 id 时为 undefined。 */
  virtual: string
  /** 固定模式（auto 不固定）。 */
  mode?: RoutingMode
  /** 档位（子代理等）；普通请求没有。 */
  profile?: 'subagent'
  /** 直通的具体模型。 */
  pin?: { provider: string; model: string }
}

/**
 * 解析模型 id。
 *
 * 支持的形态：
 *   steward:auto / steward:frugal / steward:balanced / steward:max_power / steward:free
 *   steward:subagent（子代理档位）
 *   steward:pin/<provider>/<model>
 *   steward:alias/<name>
 *   其他任意 id → 直通（作为 provider/model 无法确定，交由网关查表）
 */
export function parseVirtualModel(rawModelId: string): VirtualRoute {
  const modelId = canonicalModelId(rawModelId)
  if (!modelId.startsWith(VIRTUAL_PREFIX)) return { virtual: '' }
  const rest = modelId.slice(VIRTUAL_PREFIX.length)
  const mode = MODE_IDS[modelId]
  if (mode !== undefined) {
    return modelId === 'steward:auto' ? { virtual: modelId } : { virtual: modelId, mode }
  }
  const profile = PROFILE_IDS[modelId]
  if (profile !== undefined) return { virtual: modelId, profile }
  if (rest.startsWith('pin/')) {
    const parts = rest.slice(4).split('/')
    if (parts.length === 2 && parts[0] !== '' && parts[1] !== '') {
      return { virtual: modelId, pin: { provider: parts[0] as string, model: parts[1] as string } }
    }
    return { virtual: modelId }
  }
  return { virtual: modelId }
}

/** 从一段内容里取纯文本（OpenAI 的 content 可以是字符串或部件数组）。 */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    if (typeof part !== 'object' || part === null) continue
    const text = (part as { text?: unknown }).text
    if (typeof text === 'string') parts.push(text)
  }
  return parts.join('\n')
}

/** 一条消息里是否含图片部件。 */
export function hasImagePart(content: unknown): boolean {
  if (!Array.isArray(content)) return false
  for (const part of content) {
    if (typeof part !== 'object' || part === null) continue
    const type = (part as { type?: unknown }).type
    if (type === 'image_url' || type === 'input_image' || type === 'image') return true
  }
  return false
}

/** 粗略估算请求的输入 token。 */
export function estimateInputTokens(body: Record<string, unknown>): number {
  const messages = Array.isArray(body.messages) ? body.messages : []
  let total = 0
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue
    const record = message as Record<string, unknown>
    total += MESSAGE_OVERHEAD_TOKENS
    total += Math.ceil(contentText(record.content).length / CHARS_PER_TOKEN)
    if (hasImagePart(record.content)) total += IMAGE_TOKEN_COST
    // 助手发起的工具调用也会占 token，粗略按参数长度算。
    const calls = record.tool_calls
    if (Array.isArray(calls)) {
      for (const call of calls) {
        const args = (call as { function?: { arguments?: unknown } }).function?.arguments
        if (typeof args === 'string') total += Math.ceil(args.length / CHARS_PER_TOKEN)
      }
    }
  }
  // 系统提示与工具定义同样消耗输入 token。
  total += Math.ceil(contentText(body.system).length / CHARS_PER_TOKEN)
  if (Array.isArray(body.tools)) {
    total += Math.ceil(JSON.stringify(body.tools).length / CHARS_PER_TOKEN)
  }
  return total
}

/** 请求期望的输出上限；缺省按 4096 估算。 */
export function estimateOutputTokens(body: Record<string, unknown>): number {
  const explicit = body.max_completion_tokens ?? body.max_tokens
  if (typeof explicit === 'number' && Number.isInteger(explicit) && explicit > 0) return explicit
  return 4_096
}

/** 请求携带的能力要求（不含 tool-use，那条单独判定）。 */
export function inferCapabilities(body: Record<string, unknown>): CapabilityTag[] {
  const tags: CapabilityTag[] = []
  const messages = Array.isArray(body.messages) ? body.messages : []
  const wantsImage = messages.some((message) => {
    if (typeof message !== 'object' || message === null) return false
    return hasImagePart((message as Record<string, unknown>).content)
  })
  if (wantsImage) tags.push('vision')
  if (body.response_format !== undefined) tags.push('json-mode')
  return tags
}

/** 请求携带的输入模态。 */
export function inferModalities(body: Record<string, unknown>): InputModality[] {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const wantsImage = messages.some((message) => {
    if (typeof message !== 'object' || message === null) return false
    return hasImagePart((message as Record<string, unknown>).content)
  })
  return wantsImage ? ['text', 'image'] : ['text']
}

/** 一次请求的 burst 归因键：同一毫秒窗口内的并发请求共享一个键。 */
export function burstKeyOf(body: Record<string, unknown>, now: number, windowMs = 250): string {
  // 优先用调用方显式给的会话/批次线索：子代理并发通常共享同一个 system 提示前缀。
  const hint = body.user ?? body.session_id ?? body.__steward_burst
  if (typeof hint === 'string' && hint !== '') return 'hint:' + hint
  return 'window:' + String(Math.floor(now / windowMs))
}

/**
 * 会话键：用来识别「这是同一个会话的下一轮」，从而把模型粘住。
 *
 * 优先 `session_id`（DSH 的会话身份），其次 `conversation_id` / `chat_id`，
 * 最后退回 `user`——DSH 的 pi-ai 适配器把 agent id 放在 `user` 里，
 * 同一会话的多轮共享它。都没有就返回 undefined（不做粘性）。
 */
export function conversationKeyOf(body: Record<string, unknown>): string | undefined {
  for (const field of ['session_id', 'conversation_id', 'chat_id', 'user'] as const) {
    const value = body[field]
    if (typeof value === 'string' && value !== '') return field + ':' + value
  }
  const metadata = body.metadata
  if (typeof metadata === 'object' && metadata !== null) {
    const nested = (metadata as Record<string, unknown>).session_id
    if (typeof nested === 'string' && nested !== '') return 'session_id:' + nested
  }
  return undefined
}

/** 长上下文维度的判定门槛（粗估 token）。 */
const LONG_CONTEXT_TOKENS = 24_000

/** 代码痕迹：前 4000 字符内命中任一即认为请求以编码为主。 */
const CODE_MARKERS = ['```', 'function ', 'def ', 'class ', 'const ', 'import ', 'import ', 'npm ', 'stack trace', 'Traceback', 'error:']

/**
 * 推断请求的主评分维度（六维选路的主键）。
 * 优先级：带工具 → agentic；超长 → longContext；有代码痕迹 → coding；其余 → reasoning。
 * 纯函数、O(messages)：与 estimateInputTokens 同一趟量级，不做任何深扫描。
 */
export function inferDimension(body: Record<string, unknown>, needsTools: boolean, estimatedInputTokens: number): DimensionKey {
  if (needsTools) return 'agentic'
  if (estimatedInputTokens >= LONG_CONTEXT_TOKENS) return 'longContext'
  const messages = Array.isArray(body.messages) ? body.messages : []
  let scanned = 0
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue
    const text = contentText((message as Record<string, unknown>).content)
    if (text === '') continue
    const head = text.slice(0, 4_000)
    for (const marker of CODE_MARKERS) {
      if (head.includes(marker)) return 'coding'
    }
    scanned += head.length
    if (scanned > 16_000) break
  }
  return 'reasoning'
}

/** 推断的完整结果。 */
export interface IntentInference {
  intent: RouteIntent
  /** 虚拟 id 解析结果，网关据此决定模式或直通。 */
  route: VirtualRoute
}

/**
 * 把一次请求翻成路由意图。
 * @param body - 已解析的请求体。
 * @param modelId - 客户端请求的模型 id。
 * @param now - 当前毫秒（由调用方带入，保证可测）。
 */
export function inferIntent(body: Record<string, unknown>, modelId: string, now: number): IntentInference {
  const route = parseVirtualModel(modelId)
  const needsTools = Array.isArray(body.tools) && body.tools.length > 0
  const requiredCapabilities = inferCapabilities(body)
  if (needsTools && !requiredCapabilities.includes('tool-use')) requiredCapabilities.push('tool-use')

  const estimatedInput = estimateInputTokens(body)
  const conversationKey = conversationKeyOf(body)
  const intent: RouteIntent = {
    requiredCapabilities,
    requiredModalities: inferModalities(body),
    estimatedInputTokens: estimatedInput,
    expectedOutputTokens: estimateOutputTokens(body),
    needsTools,
    // 子代理档位强制按 agentic 打分：子代理的工作就是「读、调工具、改、验」的循环，
    // 即使这一轮恰好没带 tools（比如最后的总结），也仍按代理能力选人。
    dimension: route.profile === 'subagent' ? 'agentic' : inferDimension(body, needsTools, estimatedInput),
    stream: body.stream === true,
    burstKey: burstKeyOf(body, now),
    ...(conversationKey === undefined ? {} : { conversationKey }),
    ...(route.profile === undefined ? {} : { profile: route.profile }),
  }
  if (route.virtual !== '') intent.aliasName = route.virtual
  return { intent, route }
}
