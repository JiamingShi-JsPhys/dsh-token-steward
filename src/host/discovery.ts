/**
 * 上游模型发现：向真实上游 GET /models（OpenAI 形状），把结果按目录注上
 * Tier/名称。网关的发现端点与面板的同源代理路由共用这一份实现——
 * 浏览器跨源直调网关会被 CORS 拦截，所以面板路径必须由宿主代理。
 */
import { matchTemplateModel, PROVIDER_TEMPLATES } from '../core/provider-templates.ts'
import type { FetchLike } from './upstream.ts'

export interface DiscoveredEntry {
  id: string
  object: string
  name: string
  tier: string
  inCatalog: boolean
  owned_by: string
}

/** 从 unknown 里取可读消息。 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** OpenAI 形状 {data:[{id}]}（也容忍裸数组与 {models:[...]}）。 */
export function extractModelIds(body: unknown): string[] | undefined {
  const list = Array.isArray(body)
    ? body
    : body !== null && typeof body === 'object' && Array.isArray((body as { data?: unknown }).data)
      ? (body as { data: unknown[] }).data
      : body !== null && typeof body === 'object' && Array.isArray((body as { models?: unknown }).models)
        ? (body as { models: unknown[] }).models
        : undefined
  if (list === undefined) return undefined
  const ids: string[] = []
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue
    const id = (entry as { id?: unknown }).id ?? (entry as { name?: unknown }).name
    if (typeof id === 'string' && id !== '') ids.push(id)
  }
  return ids
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
  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init as RequestInit))
  const endpoint = baseUrl.replace(/\/+$/, '') + '/models'
  const upstream = await fetchImpl(endpoint, {
    method: 'GET',
    headers: { authorization: 'Bearer ' + apiKey },
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
  })
  if (!upstream.ok) {
    throw new Error('upstream /models responded ' + String(upstream.status))
  }
  const body: unknown = await upstream.json()
  const ids = extractModelIds(body)
  if (ids === undefined) {
    throw new Error('upstream /models body is not an OpenAI list')
  }
  const template = PROVIDER_TEMPLATES.find((entry) => entry.vendorId === vendorId)
  return ids.map((id) => {
    const known = template !== undefined ? matchTemplateModel(template, id) : undefined
    return {
      id,
      object: 'model',
      name: known?.name ?? id,
      tier: known?.tier ?? 'NA',
      inCatalog: known !== undefined,
      owned_by: 'upstream',
    }
  })
}
