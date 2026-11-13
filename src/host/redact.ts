/**
 * 日志与错误消息里的密钥脱敏。
 *
 * 为什么需要：上游 401 常常把收到的 key 原样回显（"Incorrect API key provided:
 * sk-…"）。这条消息会经网关转给客户端，最后出现在 DSH 的界面、会话记录，
 * 甚至被发给另一个模型。日志级别再克制也挡不住「消息正文里带着钥匙」。
 *
 * 两条规则：
 *  1. **已知明文**：把当前 secrets 表里的每个值替换成掩码。精确，无假阳性。
 *  2. **形状匹配**：`sk-…` / `Bearer …` / 常见 `*_KEY=` 形式，覆盖「不是我们
 *     存的那把、但看起来就是钥匙」的情况。
 *
 * 只做替换，不改长度语义之外的任何内容；对普通文本零副作用。
 */

/** 掩码：统一成固定长度，不泄漏原密钥的长度。 */
const MASK = '‹redacted›'

/** 形状匹配：OpenAI / Anthropic / 常见中转站前缀。 */
const SHAPE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{12,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g,
  /\b(x-api-key|api[_-]?key|authorization)\s*[:=]\s*\S+/gi,
]

/** 把一段文本里所有已知明文替换成掩码。 */
export function redactKnown(text: string, secrets: Iterable<string>): string {
  let out = text
  for (const secret of secrets) {
    if (secret.length < 8) continue
    if (!out.includes(secret)) continue
    out = out.split(secret).join(MASK)
  }
  return out
}

/** 把形状上像密钥的片段替换成掩码。 */
export function redactShaped(text: string): string {
  let out = text
  for (const pattern of SHAPE_PATTERNS) out = out.replace(pattern, MASK)
  return out
}

/** 两件事一起做（日志与出站错误消息的统一入口）。 */
export function redact(text: string, secrets: Iterable<string> = []): string {
  return redactShaped(redactKnown(text, secrets))
}
