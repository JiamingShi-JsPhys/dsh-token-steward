/**
 * Request fingerprinting + task classification.
 *
 * Everything here is O(messages-capped) text statistics — the classifier NEVER
 * calls a model (extreme-cheap by construction). Deep-frozen options are safe:
 * we only read.
 *
 * @module core/classify
 */
import type { Capability, RequestFingerprint, RoutingPolicy, TaskProfile } from './types.ts'

/** chars per token, deliberately pessimistic (CJK-heavy mixes) */
const CHARS_PER_TOKEN = 2
const MAX_SCANNED_MESSAGES = 400
const MAX_SCANNED_CHARS = 2_000_000

export function fingerprintOf(options: unknown): RequestFingerprint {
  if (options === null || typeof options !== 'object') {
    return { messageCount: 0, totalChars: 0, hasTools: false }
  }
  const source = options as Record<string, unknown>
  let messageCount = 0
  let totalChars = 0
  const messages = source.messages
  if (Array.isArray(messages)) {
    messageCount = messages.length
    const scanLimit = Math.min(messages.length, MAX_SCANNED_MESSAGES)
    for (let index = 0; index < scanLimit && totalChars < MAX_SCANNED_CHARS; index += 1) {
      totalChars += contentChars(messages[index])
    }
  }
  const system = source.system
  if (typeof system === 'string') totalChars += system.length
  const hasTools =
    (Array.isArray(source.tools) && source.tools.length > 0) ||
    (typeof source.tool_choice === 'string' && source.tool_choice !== 'none')
  const reasoningEffort = typeof source.reasoningEffort === 'string' ? source.reasoningEffort : undefined
  const requestedProvider = typeof source.provider === 'string' ? source.provider : undefined
  const requestedModel = typeof source.model === 'string' ? source.model : undefined
  const callerHint =
    pickString(source, ['agent', 'subagent', 'agentName', 'caller', 'source']) ?? undefined
  return {
    messageCount,
    totalChars: Math.round(totalChars),
    hasTools,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(requestedProvider !== undefined ? { requestedProvider } : {}),
    ...(requestedModel !== undefined ? { requestedModel } : {}),
    ...(callerHint !== undefined ? { callerHint } : {}),
  }
}

function contentChars(message: unknown): number {
  if (message === null || typeof message !== 'object') return 0
  const content = (message as Record<string, unknown>).content
  if (typeof content === 'string') return content.length
  if (Array.isArray(content)) {
    let sum = 0
    for (const part of content) {
      if (part !== null && typeof part === 'object') {
        const text = (part as Record<string, unknown>).text
        if (typeof text === 'string') sum += text.length
      }
    }
    return sum
  }
  return 0
}

function pickString(source: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

/**
 * Classify the call and derive the capability floor.
 * Long-context needs a conservative chars→tokens inflation so cheap small-window
 * models never receive a prompt they cannot hold.
 */
export function classify(fingerprint: RequestFingerprint, policy: RoutingPolicy): TaskProfile {
  const heavy = fingerprint.totalChars >= policy.classifier.heavyMinChars || (policy.classifier.heavyTools && fingerprint.hasTools) || fingerprint.reasoningEffort === 'high'
  const trivial = !heavy && fingerprint.totalChars <= policy.classifier.trivialMaxChars && !fingerprint.hasTools
  const taskClass = heavy ? 'heavy' : trivial ? 'trivial' : 'standard'

  const required: Capability[] = []
  if (fingerprint.hasTools) required.push('tool_use')
  if (fingerprint.reasoningEffort === 'high') required.push('reasoning')

  const estimatedInputTokens = Math.ceil(fingerprint.totalChars / CHARS_PER_TOKEN)
  const outputHeadroom = 4_096
  const minContextWindow = Math.ceil((estimatedInputTokens + outputHeadroom) * 1.2)
  if (minContextWindow > 128_000) required.push('long_context')

  return { taskClass, requiredCapabilities: required, minContextWindow }
}
