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
import type { CapabilityTag, InputModality, RouteIntent, RoutingMode } from './types.ts'

/** 虚拟模型 id 的前缀。 */
export const VIRTUAL_PREFIX = 'umbra:'

/** 三个模式虚拟 id。 */
export const MODE_IDS: Record<string, RoutingMode> = {
  'umbra:auto': 'frugal',
  'umbra:frugal': 'frugal',
  'umbra:efficiency': 'efficiency',
  'umbra:max_power': 'max_power',
}

/** 一段文本的粗略 token 估算：4 字符 ≈ 1 token。 */
const CHARS_PER_TOKEN = 4

/** 一张图片的固定估算：主流视觉模型按 1024×1024 折算后大致落在这一档。 */
const IMAGE_TOKEN_COST = 1_000

/** 一条 message 的结构开销（role 字段等）。 */
const MESSAGE_OVERHEAD_TOKENS = 4

/** 解析出的虚拟路由意图。 */
export interface VirtualRoute {
  /** umbra:auto 之类；不是虚拟 id 时为 undefined。 */
  virtual: string
  /** 固定模式（auto 不固定）。 */
  mode?: RoutingMode
  /** 直通的具体模型。 */
  pin?: { provider: string; model: string }
}

/**
 * 解析模型 id。
 *
 * 支持的形态：
 *   umbra:auto / umbra:frugal / umbra:efficiency / umbra:max_power
 *   umbra:pin/<provider>/<model>
 *   umbra:alias/<name>
 *   其他任意 id → 直通（作为 provider/model 无法确定，交由网关查表）
 */
export function parseVirtualModel(modelId: string): VirtualRoute {
  if (!modelId.startsWith(VIRTUAL_PREFIX)) return { virtual: '' }
  const rest = modelId.slice(VIRTUAL_PREFIX.length)
  const mode = MODE_IDS[modelId]
  if (mode !== undefined) {
    return modelId === 'umbra:auto' ? { virtual: modelId } : { virtual: modelId, mode }
  }
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
  const hint = body.user ?? body.session_id ?? body.__umbra_burst
  if (typeof hint === 'string' && hint !== '') return 'hint:' + hint
  return 'window:' + String(Math.floor(now / windowMs))
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

  const intent: RouteIntent = {
    requiredCapabilities,
    requiredModalities: inferModalities(body),
    estimatedInputTokens: estimateInputTokens(body),
    expectedOutputTokens: estimateOutputTokens(body),
    needsTools,
    stream: body.stream === true,
    burstKey: burstKeyOf(body, now),
  }
  if (route.virtual !== '') intent.aliasName = route.virtual
  return { intent, route }
}
