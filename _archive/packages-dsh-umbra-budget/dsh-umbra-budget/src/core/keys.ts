/**
 * Environment-reference resolution for pool secrets.
 *
 * YAML never carries plaintext keys — only `env:NAME` (or a bare env name).
 * Resolution happens at pool load time, in memory only.
 *
 * @module core/keys
 */

/**
 * Resolve `ref` against `env`.
 * - `env:NAME` → env.NAME
 * - bare `NAME` → env.NAME (lenient form)
 * - anything else (empty, whitespace) → undefined
 */
export function resolveEnvRef(ref: string | undefined, env: Readonly<Record<string, string | undefined>>): string | undefined {
  if (typeof ref !== 'string') return undefined
  const name = ref.startsWith('env:') ? ref.slice(4) : ref
  const trimmed = name.trim()
  if (trimmed === '') return undefined
  const value = env[trimmed]
  return typeof value === 'string' && value !== '' ? value : undefined
}
