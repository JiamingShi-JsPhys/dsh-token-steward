/**
 * Wire-level helpers for the dispatcher: undici header surgery and body
 * decoding. Header forms mirror dsh-provider-proxy's `injectHeaders` (flat
 * `[name, value, …]` arrays or records).
 *
 * @module host/wire
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export const MAX_REWRITABLE_BODY_BYTES = 8 * 1024 * 1024

/**
 * Decode a dispatch body as UTF-8 text when it is a plain string or a byte
 * buffer within the cap; streams and oversized bodies return undefined (the
 * rewrite planner then refuses to touch the request).
 */
export function bodyAsText(body: unknown): string | undefined {
  if (typeof body === 'string') return body
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    if (body.byteLength > MAX_REWRITABLE_BODY_BYTES) return undefined
    try {
      return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8')
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * Apply a reroute plan to undici dispatch headers: drop `remove` names, replace
 * values of `set` names (case-insensitive), keep everything else.
 *
 * @returns a fresh flat `[name, value, …]` array (undici's preferred form).
 */
export function rewriteHeaders(existing: unknown, set: Readonly<Record<string, string>>, remove: readonly string[]): string[] {
  const removeSet = new Set(remove)
  const setEntries = Object.entries(set)
  const setNames = new Set(setEntries.map(([name]) => name.toLowerCase()))
  const entries: [string, string][] = []
  const pushExisting = (name: string, value: string): void => {
    const lower = name.toLowerCase()
    if (removeSet.has(lower) || setNames.has(lower)) return
    entries.push([name, value])
  }
  if (Array.isArray(existing)) {
    for (let index = 0; index + 1 < existing.length; index += 2) {
      pushExisting(String(existing[index]), String(existing[index + 1]))
    }
  } else if (isRecord(existing)) {
    for (const [name, value] of Object.entries(existing)) {
      if (Array.isArray(value)) {
        for (const item of value) pushExisting(name, String(item))
      } else if (value !== undefined && value !== null) {
        pushExisting(name, String(value))
      }
    }
  }
  for (const [name, value] of setEntries) entries.push([name, value])
  return entries.flat()
}

/** Safely stringify an origin-ish value. */
export function originOf(origin: unknown): string | undefined {
  if (typeof origin === 'string') return origin
  if (origin !== null && typeof origin === 'object') {
    const href = (origin as { href?: unknown }).href
    if (typeof href === 'string') return href
  }
  return undefined
}
