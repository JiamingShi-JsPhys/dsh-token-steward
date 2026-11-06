/**
 * Outbound rewrite planner for B-track (free-wired OpenAI-compatible) targets.
 *
 * The undici dispatcher layer calls `planReroute` per request; this module owns
 * the pure decision: where the request goes, which auth headers replace the old
 * ones, and how the body's `model` field is swapped. Anything not provably an
 * OpenAI-compatible operation path is REFUSED (fail-closed — we never forward a
 * request whose protocol we cannot reason about).
 *
 * @module core/reroute
 */
import type { PoolModel } from './types.ts'

export interface OutboundView {
  readonly origin: string
  readonly path: string
  readonly bodyText?: string
}

export interface RerouteOutcome {
  readonly origin: string
  readonly path: string
  /** headers to set/replace (lowercase names) */
  readonly setHeaders: Readonly<Record<string, string>>
  /** old auth headers to drop (lowercase names) */
  readonly removeHeaders: readonly string[]
  readonly bodyText?: string
}

export type RerouteResult = { readonly ok: true; readonly outcome: RerouteOutcome } | { readonly ok: false; readonly reason: string }

/** operation markers of the OpenAI wire protocol, longest first */
const OPERATION_MARKERS: readonly string[] = [
  '/chat/completions',
  '/completions',
  '/responses',
  '/embeddings',
  '/moderations',
  '/images/generations',
  '/images/edits',
  '/audio/transcriptions',
  '/audio/translations',
  '/audio/speech',
  '/rerank',
  '/models',
]

const AUTH_HEADER_NAMES: readonly string[] = ['authorization', 'x-api-key', 'api-key']
const MAX_REWRITABLE_BODY_BYTES = 8 * 1024 * 1024

/**
 * Plan the rewrite of one outbound request onto `target`'s endpoint.
 * A-track targets (no endpoint in the pool) are refused here — their routing
 * happens in the waterfall layer, not at the wire.
 */
export function planReroute(view: OutboundView, target: PoolModel): RerouteResult {
  if (target.endpoint === undefined) {
    return { ok: false, reason: 'A-track target: pool entry declares no endpoint' }
  }
  if (target.apiKey === undefined) {
    return { ok: false, reason: `B-track target has no resolvable key (${target.id})` }
  }
  let endpointUrl: URL
  try {
    endpointUrl = new URL(target.endpoint)
  } catch {
    return { ok: false, reason: `target endpoint is not a URL: ${target.endpoint}` }
  }

  const suffix = operationSuffix(view.path)
  if (suffix === undefined) {
    return { ok: false, reason: `not a recognised OpenAI-compatible operation path: ${view.path}` }
  }
  const targetBase = endpointUrl.pathname.replace(/\/+$/, '')
  const newPath = `${targetBase}${suffix}`

  // body model swap
  let bodyText: string | undefined
  const bodyModel = extractBodyModel(view.bodyText)
  if (bodyModel === target.model) {
    bodyText = view.bodyText
  } else if (view.bodyText === undefined) {
    return { ok: false, reason: 'request body unavailable — refusing to rewrite without a swappable model field' }
  } else if (view.bodyText.length > MAX_REWRITABLE_BODY_BYTES) {
    return { ok: false, reason: 'request body exceeds the rewritable size cap' }
  } else {
    const swapped = swapBodyModel(view.bodyText, target.model)
    if (swapped === undefined) {
      return { ok: false, reason: 'request body is not a JSON object with a model field' }
    }
    bodyText = swapped
  }

  // auth headers: set the target's auth, drop every other auth style
  const setHeaders: Record<string, string> = {}
  const authValue = target.authStyle === 'bearer' ? `Bearer ${target.apiKey}` : target.apiKey
  const authHeaderName = target.authStyle === 'bearer' ? 'authorization' : target.authStyle
  setHeaders[authHeaderName] = authValue
  for (const [name, value] of Object.entries(target.headers)) {
    setHeaders[name.toLowerCase()] = value
  }

  const removeHeaders = AUTH_HEADER_NAMES.filter((name) => name !== authHeaderName)

  return {
    ok: true,
    outcome: {
      origin: endpointUrl.origin,
      path: newPath,
      setHeaders,
      removeHeaders,
      ...(bodyText !== undefined ? { bodyText } : {}),
    },
  }
}

/** Everything from the first recognised operation marker onward; undefined when none. */
export function operationSuffix(path: string): string | undefined {
  const clean = path.split('?')[0] ?? path
  for (const marker of OPERATION_MARKERS) {
    const index = clean.indexOf(marker)
    if (index >= 0) {
      const suffix = clean.slice(index)
      // '/models' must not swallow '/v1/models/foo' style drains — accept only a
      // terminal match for the generic markers
      if (marker === '/models' && index + marker.length !== clean.length) continue
      return suffix
    }
  }
  return undefined
}

export function extractBodyModel(bodyText: string | undefined): string | undefined {
  if (bodyText === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(bodyText)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const model = (parsed as Record<string, unknown>).model
      return typeof model === 'string' ? model : undefined
    }
  } catch {
    /* not JSON */
  }
  return undefined
}

function swapBodyModel(bodyText: string, model: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(bodyText)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const record = parsed as Record<string, unknown>
    if (!('model' in record)) return undefined
    record.model = model
    return JSON.stringify(record)
  } catch {
    return undefined
  }
}
