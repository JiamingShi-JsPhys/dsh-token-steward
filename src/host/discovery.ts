/**
 * 上游模型发现：向真实上游 GET /models（OpenAI 形状），把结果按目录注上
 * Tier/名称。网关的发现端点与面板的同源代理路由共用这一份实现——
 * 浏览器跨源直调网关会被 CORS 拦截，所以面板路径必须由宿主代理。
 */
import { PROVIDER_TEMPLATES } from '../core/provider-templates.ts'
import { resolveModelProfile } from '../core/model-match.ts'
import { nodeGet } from './node-get.ts'
import type { FetchLike } from './upstream.ts'

export interface DiscoveredEntry {
  id: string
  object: string
  name: string
  tier: string
  inCatalog: boolean
  /** 擅长一句话（目录命中才有）。 */
  strengths?: string
  /** 擅长标签（机器可读，AI 调控用）。 */
  strength_tags?: string[]
  owned_by: string
}

/** 从 unknown 里取可读消息。 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 上游列表里的一行：id 必有，展示名与上下文窗口有则带上。 */
export interface UpstreamModel {
  id: string
  name?: string
  context?: number
}

/** OpenAI 形状 {data:[{id}]}（也容忍裸数组与 {models:[...]}）。 */
export function extractModelEntries(body: unknown): UpstreamModel[] | undefined {
  const list = Array.isArray(body)
    ? body
    : body !== null && typeof body === 'object' && Array.isArray((body as { data?: unknown }).data)
      ? (body as { data: unknown[] }).data
      : body !== null && typeof body === 'object' && Array.isArray((body as { models?: unknown }).models)
        ? (body as { models: unknown[] }).models
        : undefined
  if (list === undefined) return undefined
  const entries: UpstreamModel[] = []
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue
    const record = entry as { id?: unknown, name?: unknown, limit?: unknown }
    const id = record.id ?? record.name
    if (typeof id !== 'string' || id === '') continue
    // 有的上游（OpenCode Zen）会顺手给出人话名称与上下文窗口，白拿的信息别丢。
    const name = typeof record.name === 'string' && record.name !== id ? record.name : undefined
    const limit = record.limit
    const context = limit !== null && typeof limit === 'object' && typeof (limit as { context?: unknown }).context === 'number'
      ? (limit as { context: number }).context
      : undefined
    entries.push({ id, ...(name === undefined ? {} : { name }), ...(context === undefined ? {} : { context }) })
  }
  return entries
}

/** 只要 id 的版本（老调用点保持兼容）。 */
export function extractModelIds(body: unknown): string[] | undefined {
  return extractModelEntries(body)?.map((entry) => entry.id)
}

/**
 * 取一份 JSON。默认走 Node 的 http/https（见 node-get.ts：主进程的 fetch 走 Chromium 网络栈，
 * 同一个 key 会莫名 401）。测试注入 fetchImpl 时按注入的实现走。
 */
async function fetchJson(
  endpoint: string,
  headers: Record<string, string>,
  timeoutMs: number,
  fetchImpl: FetchLike | undefined,
): Promise<{ status: number, body: unknown }> {
  if (fetchImpl === undefined) {
    const result = await nodeGet(endpoint, headers, timeoutMs)
    if (result.status < 200 || result.status >= 300) return { status: result.status, body: undefined }
    try {
      return { status: result.status, body: JSON.parse(result.body) as unknown }
    } catch {
      throw new Error('upstream /models body is not JSON')
    }
  }
  const upstream = await fetchImpl(endpoint, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (upstream.status < 200 || upstream.status >= 300) return { status: upstream.status, body: undefined }
  return { status: upstream.status, body: await upstream.json() as unknown }
}

export interface DiscoveryOptions {
  fetchImpl?: FetchLike
  timeoutMs?: number
}

/**
 * 探测一家上游的真实模型列表，并按厂商目录注上名称与 Tier。
 * @throws Error（可读消息）：网络失败、非 2xx、响应不是 OpenAI 列表。
 */
export async function discoverUpstreamModels(vendorId: string, baseUrl: string, apiKey: string, options: DiscoveryOptions = {}): Promise<DiscoveredEntry[]> {
  const endpoint = baseUrl.replace(/\/+$/, '') + '/models'
  // 公开模型表（OpenCode Zen 之类）不需要密钥，空 key 就别发一个假的 Bearer。
  const headers = apiKey === '' ? {} : { authorization: 'Bearer ' + apiKey }
  const timeoutMs = options.timeoutMs ?? 15_000
  const upstream = await fetchJson(endpoint, headers, timeoutMs, options.fetchImpl)
  if (upstream.status < 200 || upstream.status >= 300) {
    throw new Error('upstream /models responded ' + String(upstream.status))
  }
  const body: unknown = upstream.body
  const listed = extractModelEntries(body)
  if (listed === undefined) {
    throw new Error('upstream /models body is not an OpenAI list')
  }
  const template = PROVIDER_TEMPLATES.find((entry) => entry.vendorId === vendorId)
  return listed.map((model) => {
    const id = model.id
    // 厂家没被收录（自定义 / 中转站）时再到全域目录里找：内置的强度跟线路无关。
    // 「同族」只借标签，不借名字与评级——那是具体型号的事实。
    const matched = resolveModelProfile(id, template)
    const known = matched !== undefined && matched.kind !== 'family' ? matched.model : undefined
    return {
      id,
      object: 'model',
      name: known?.name ?? model.name ?? id,
      tier: known?.tier ?? 'NA',
      // 有内置档案（含同族）就不该让用户再自打标签。
      inCatalog: matched !== undefined,
      ...(known?.strengths !== undefined ? { strengths: known.strengths } : {}),
      ...(matched?.model.strengthTags !== undefined ? { strength_tags: [...matched.model.strengthTags] } : {}),
      owned_by: 'upstream',
    }
  })
}
