/**
 * 自动接线：把网关自己写进 DSH 的模型菜单。
 *
 * 为什么需要这一步：插件装好之后，网关已经在 127.0.0.1 上跑着了，可是 DSH 的
 * 模型菜单读的是 profile 里 `@deepseek-ai/dsh-llm-pi-ai` 的 providers——那里
 * 没有 `steward` 这一家，用户就得自己去 YAML 里抄一段 baseURL、apiKeyEnv、
 * defaultMaxTokens 和四个模型。抄错一个字段，菜单里就一个档位都看不到，
 * 而报错信息（「No API key for provider」「连接被拒绝」）完全指不到配置上。
 *
 * 所以：插件启动、网关就绪之后，检查一遍 profile，缺什么补什么。
 *
 * 三条纪律：
 *  1. **幂等**：已经接好就一个字节都不写——profile 被改动会触发宿主重载，
 *     每次启动都改写一次等于每次启动都抖一下。
 *  2. **只碰那一块**：写回走**文本拼接**，不是「解析成对象再整体序列化」。
 *     profile 是用户手写的一千多行配置，整份重排为了加七行不值得，
 *     而且一旦序列化器把它写坏了，DSH 当场起不来。
 *  3. **失败不致命**：认不出结构就原样返回 undefined，只记一条日志；
 *     面板里仍有「同步到系统模型」可以手工兜底。
 */
import { canonicalModelId } from '../core/intent.ts'
import { HARNESS_DEFAULT_MAX_TOKENS } from './harness-sync.ts'

/** profile 里这一家的键名；`harnessProviders` 靠它把网关自己排除在导入之外。 */
export const STEWARD_PROVIDER_ID = 'steward'

/** 菜单里要出现的四个档位。子代理不是模式，不进菜单。 */
export const STEWARD_WIRE_MODELS: ReadonlyArray<{ id: string, name: string }> = [
  { id: 'steward:frugal', name: '管家·极致便宜' },
  { id: 'steward:balanced', name: '管家·效率优先' },
  { id: 'steward:max_power', name: '管家·最强火力' },
  { id: 'steward:free', name: '管家·免费档' },
]

/** 写进 profile 的接线参数。 */
export interface StewardWireSpec {
  /** 网关的实际地址，例如 http://127.0.0.1:51741/v1。 */
  baseUrl: string
  /** 本地令牌的环境变量名；插件启动时会把它写进进程环境。 */
  apiKeyEnv: string
  /** 菜单里的档位；缺省用 STEWARD_WIRE_MODELS。 */
  models?: ReadonlyArray<{ id: string, name: string }>
}

/** 这家上游在 profile 里应该长什么样。 */
export function stewardProviderBlock(spec: StewardWireSpec): Record<string, unknown> {
  const models = spec.models ?? STEWARD_WIRE_MODELS
  return {
    displayName: '管家',
    api: 'openai-completions',
    baseURL: spec.baseUrl,
    apiKeyEnv: spec.apiKeyEnv,
    // llm-pi-ai 的缺省 128000 比大多数上游的真实上限还大，直连会 400。
    defaultMaxTokens: HARNESS_DEFAULT_MAX_TOKENS,
    models: models.map((model) => ({ id: model.id, name: model.name })),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 取出 llm-pi-ai 那一行的 providers 容器；没有就返回 undefined（不修改文档）。 */
export function stewardContainerOf(doc: unknown): Record<string, unknown> | undefined {
  const entries = Array.isArray(doc)
    ? doc
    : isRecord(doc) && Array.isArray(doc.plugins) ? doc.plugins : undefined
  if (entries === undefined) return undefined
  for (const entry of entries) {
    if (!isRecord(entry)) continue
    const name = typeof entry.name === 'string' ? entry.name : ''
    if (!name.endsWith('llm-pi-ai')) continue
    const config = isRecord(entry.config) ? entry.config : {}
    const providers = isRecord(config.providers) ? config.providers : {}
    return providers
  }
  return undefined
}

/** profile 文档里这一家的模型 id 清单。 */
function modelIdsOf(provider: Record<string, unknown>): string[] {
  const models = Array.isArray(provider.models) ? provider.models : []
  const ids: string[] = []
  for (const model of models) {
    const id = typeof model === 'string'
      ? model
      : isRecord(model) && typeof model.id === 'string' ? model.id : ''
    if (id !== '') ids.push(id)
  }
  return ids
}

/** 地址比对：忽略大小写与末尾斜杠。 */
function sameUrl(a: string, b: string): boolean {
  return a.trim().toLowerCase().replace(/\/+$/, '') === b.trim().toLowerCase().replace(/\/+$/, '')
}

/**
 * 已经接好了吗？
 *
 * 判定标准是「**能跑起来**」而不是「一字不差」：地址对、令牌变量对、四个档位都在，
 * 就算接好。用户自己改了显示名、调了输出上限、顺手多留一个旧档位，都不重写——
 * profile 不该因为我们每次启动都被改一遍。
 */
export function stewardWired(doc: unknown, spec: StewardWireSpec): boolean {
  const container = stewardContainerOf(doc)
  const provider = container?.[STEWARD_PROVIDER_ID]
  if (!isRecord(provider)) return false
  const baseUrl = typeof provider.baseURL === 'string'
    ? provider.baseURL
    : typeof provider.baseUrl === 'string' ? provider.baseUrl : ''
  if (baseUrl === '' || !sameUrl(baseUrl, spec.baseUrl)) return false
  const apiKeyEnv = typeof provider.apiKeyEnv === 'string' ? provider.apiKeyEnv.trim() : ''
  if (apiKeyEnv !== spec.apiKeyEnv) return false
  const present = new Set(modelIdsOf(provider))
  for (const model of spec.models ?? STEWARD_WIRE_MODELS) {
    if (!present.has(model.id)) return false
  }
  return true
}

/* ────────────────────────── 文本拼接 ────────────────────────── */

/** 一行 YAML 的缩进（空格数）；行尾的 `\r` 不算内容。 */
function indentOf(line: string): number {
  const match = /^[ \t]*/.exec(line)
  return match === null ? 0 : match[0].length
}

function contentOf(line: string): string {
  return line.trim().replace(/\r$/, '')
}

/** 这一行是不是 llm-pi-ai 插件声明。 */
function isPiAiLine(line: string): boolean {
  const text = contentOf(line)
  return /^(name:\s*['"]?@deepseek-ai\/dsh-llm-pi-ai|-\s*id:\s*['"]?llm-pi-ai)/.test(text)
}

/** 已经在这一块里写过的、用户自己调过的字段（重写时保留）。 */
interface KeptFields {
  displayName?: number | string
  defaultMaxTokens?: number | string
  api?: string
  extraModels: Array<{ id: string, name: string }>
}

function keepFromBlock(lines: string[], start: number, end: number, keyIndent: number): KeptFields {
  const kept: KeptFields = { extraModels: [] }
  // 字段缩进取「key 之后第一行有内容的那一行」的缩进，别写死 +2：
  // 用户可能整份用四空格，我们不替他改缩进风格。
  let indent = keyIndent + 2
  for (let i = start + 1; i < end; i += 1) {
    if (contentOf(lines[i] as string) === '') continue
    indent = indentOf(lines[i] as string)
    break
  }
  let inModels = false
  let modelIndent = -1
  for (let i = start + 1; i < end; i += 1) {
    const line = lines[i] as string
    const text = contentOf(line)
    if (text === '') continue
    const ind = indentOf(line)
    if (inModels) {
      if (ind > modelIndent) {
        const id = /^-\s*id:\s*(.+)$/.exec(text)
        if (id !== null) kept.extraModels.push({ id: (id[1] as string).trim().replace(/^['"]|['"]$/g, ''), name: '' })
        const name = /^name:\s*(.+)$/.exec(text)
        const last = kept.extraModels[kept.extraModels.length - 1]
        if (name !== null && last !== undefined && last.name === '') {
          last.name = (name[1] as string).trim().replace(/^['"]|['"]$/g, '')
        }
        continue
      }
      inModels = false
    }
    if (ind !== indent) continue
    const displayName = /^displayName:\s*(.+)$/.exec(text)
    if (displayName !== null) kept.displayName = (displayName[1] as string).trim()
    const maxTokens = /^defaultMaxTokens:\s*(\d+)$/.exec(text)
    if (maxTokens !== null) kept.defaultMaxTokens = Number(maxTokens[1])
    const api = /^api:\s*(.+)$/.exec(text)
    if (api !== null) kept.api = (api[1] as string).trim()
    if (/^models:\s*$/.test(text)) {
      inModels = true
      modelIndent = ind
    }
  }
  return kept
}

/** 把块渲染成文本行（`indent` 是 `steward:` 这一行的缩进）。 */
export function renderStewardBlock(spec: StewardWireSpec, indent: number, kept?: KeptFields): string[] {
  const pad = ' '.repeat(indent)
  const inner = ' '.repeat(indent + 2)
  const item = ' '.repeat(indent + 4)
  const block = stewardProviderBlock(spec)
  const models = spec.models ?? STEWARD_WIRE_MODELS
  // 去重要按**虚拟 id** 比：老配置里常写成「管家·极致便宜」这种中文名，
  // 它和 `steward:frugal` 是同一条路由，留着菜单里就多出一份一模一样的东西。
  const wanted = new Set(models.map((model) => canonicalModelId(model.id)))
  const extras = (kept?.extraModels ?? []).filter((model) => model.id !== '' && !wanted.has(canonicalModelId(model.id)))
  const lines = [
    pad + STEWARD_PROVIDER_ID + ':',
    inner + 'displayName: ' + String(kept?.displayName ?? block.displayName),
    inner + 'api: ' + String(kept?.api ?? block.api),
    inner + 'baseURL: ' + spec.baseUrl,
    inner + 'apiKeyEnv: ' + spec.apiKeyEnv,
    inner + 'defaultMaxTokens: ' + String(kept?.defaultMaxTokens ?? block.defaultMaxTokens),
    inner + 'models:',
  ]
  for (const model of models) {
    lines.push(item + '- id: ' + model.id)
    lines.push(item + '  name: ' + model.name)
  }
  // 用户自己加的旧档位（例如老会话里还留着的 steward:auto）留在末尾，不替他删。
  for (const model of extras) {
    lines.push(item + '- id: ' + model.id)
    lines.push(item + '  name: ' + (model.name === '' ? model.id : model.name))
  }
  return lines
}

/**
 * 在 profile 文本里就地补上 `providers.steward`。
 *
 * 只改这一块：其余行原样返回（含注释、空行、CRLF）。认不出结构时返回
 * `undefined`——宁可这一轮不接，也不要拿一个序列化器把整份配置重排一遍。
 */
export function wireStewardInText(text: string, spec: StewardWireSpec): string | undefined {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)

  // 1. 找 llm-pi-ai 那一行。
  const entryAt = lines.findIndex((line) => isPiAiLine(line))
  if (entryAt === -1) {
    // 整个 profile 里都没有 llm-pi-ai：在末尾补一条完整的插件声明。
    const block = [
      '- id: llm-pi-ai',
      "  name: '@deepseek-ai/dsh-llm-pi-ai'",
      '  config:',
      '    providers:',
      ...renderStewardBlock(spec, 6),
    ]
    const body = lines.join(eol).replace(/\s*$/, '')
    return body + eol + eol + block.join(eol) + eol
  }
  const entryIndent = indentOf(lines[entryAt] as string)

  // 2. 它的 config 下必须有独立的 `providers:` 行（flow 写法 `providers: {...}` 不接）。
  let providersAt = -1
  for (let i = entryAt + 1; i < lines.length; i += 1) {
    const line = lines[i] as string
    const text = contentOf(line)
    if (text !== '' && indentOf(line) <= entryIndent && !text.startsWith('-')) break
    if (/^providers:\s*$/.test(text)) { providersAt = i; break }
  }
  if (providersAt === -1) return undefined
  const providersIndent = indentOf(lines[providersAt] as string)

  // 3. 子项的缩进：取 providers 之后第一行有内容的行，认不出来就 +2。
  let childIndent = providersIndent + 2
  for (let i = providersAt + 1; i < lines.length; i += 1) {
    const text = contentOf(lines[i] as string)
    if (text === '') continue
    childIndent = indentOf(lines[i] as string)
    break
  }

  // 4. 已经有了？找到那一块的起止行。
  let blockStart = -1
  for (let i = providersAt + 1; i < lines.length; i += 1) {
    const text = contentOf(lines[i] as string)
    if (text === '') continue
    const ind = indentOf(lines[i] as string)
    if (ind < childIndent) break
    if (ind === childIndent && new RegExp('^' + STEWARD_PROVIDER_ID + ':\\s*$').test(text)) { blockStart = i; break }
  }

  if (blockStart === -1) {
    const rendered = renderStewardBlock(spec, childIndent)
    const next = [...lines.slice(0, providersAt + 1), ...rendered, ...lines.slice(providersAt + 1)]
    return next.join(eol)
  }

  // 5. 替换陈旧的那一块：保留用户调过的显示名/上限/协议与自己加的旧档位。
  let blockEnd = lines.length
  for (let i = blockStart + 1; i < lines.length; i += 1) {
    const text = contentOf(lines[i] as string)
    if (text === '') continue
    if (indentOf(lines[i] as string) <= childIndent) { blockEnd = i; break }
  }
  const kept = keepFromBlock(lines, blockStart, blockEnd, childIndent)
  const rendered = renderStewardBlock(spec, childIndent, kept)
  const next = [...lines.slice(0, blockStart), ...rendered, ...lines.slice(blockEnd)]
  return next.join(eol)
}
