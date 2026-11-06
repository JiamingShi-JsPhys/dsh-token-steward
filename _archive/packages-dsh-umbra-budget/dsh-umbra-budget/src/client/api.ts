/**
 * Control-panel data plane: same-origin fetch (document-relative paths, like
 * the official dsh-usage client) + SSE live frames + action posts.
 *
 * @module client/api
 */
import type { RouteEventFrame, ScheduleMode, UmbraOverview } from '../core/types.ts'

const FETCH_TIMEOUT_MS = 20_000
const API_PREFIX = 'api/umbra-budget/'

async function fetchApi(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${API_PREFIX}${path}`, {
    ...init,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`umbra-budget: ${path} → HTTP ${response.status}`)
  return response.json() as Promise<unknown>
}

export async function fetchOverview(): Promise<UmbraOverview> {
  return (await fetchApi('overview')) as UmbraOverview
}

export async function postMode(mode: ScheduleMode): Promise<void> {
  await fetchApi('mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode }) })
}

export async function postModelToggle(modelId: string, enabled: boolean): Promise<void> {
  await fetchApi('model-toggle', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modelId, enabled }),
  })
}

export async function postVerify(): Promise<{ backend: string; detail: string }> {
  return (await fetchApi('verify', { method: 'POST' })) as { backend: string; detail: string }
}

/** SSE live frames; the returned disposer closes the stream. */
export function subscribeEvents(onFrame: (frame: RouteEventFrame) => void, onStatus?: (connected: boolean) => void): () => void {
  let source: EventSource | undefined
  let closed = false
  const connect = (): void => {
    if (closed) return
    source = new EventSource(`${API_PREFIX}events`)
    source.onopen = () => onStatus?.(true)
    source.onmessage = (message) => {
      try {
        onFrame(JSON.parse(message.data) as RouteEventFrame)
      } catch {
        /* malformed frame — skip */
      }
    }
    source.onerror = () => {
      onStatus?.(false)
      // EventSource auto-reconnects; nothing to do
    }
  }
  connect()
  return () => {
    closed = true
    source?.close()
  }
}
