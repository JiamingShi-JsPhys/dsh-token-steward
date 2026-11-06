/**
 * vendors.json 的读写（$DSH_HOME/token-steward/vendors.json，0600）。
 *
 * 这是 Token 管家面板的**第一配置源**：厂家 Tab 里粘贴的 API Key 与勾选的
 * 模型都落在这里。明文密钥只存在这一个文件里（0600，与 gateway.json 同级），
 * 永不进入日志、快照与任何过线 JSON——GET 接口只回掩码尾部。
 *
 * 损坏处理与台账一致：隔离留档为 .corrupt-<ISO>，然后当空配置启动，
 * 绝不让一个坏文件把插件挂载打崩。
 */
import { chmod, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { RoutingMode, VendorConfig } from '../core/types.ts'
import { readFileIfExists, writeFileAtomic, quarantineFile, isNotFound } from './atomic-file.ts'

/** vendors.json 的版本。 */
export const VENDORS_VERSION = 1

/** 落盘文档：全局模式 + 厂家配置数组。 */
export interface VendorsDocument {
  version: typeof VENDORS_VERSION
  /** 全局模式持久化在这里（面板切换即更新，重启保留）。 */
  mode: RoutingMode
  vendors: VendorConfig[]
}

export function emptyVendorsDocument(): VendorsDocument {
  return { version: VENDORS_VERSION, mode: 'frugal', vendors: [] }
}

export interface VendorStore {
  /** 读当前文档；文件缺失或损坏时返回空文档（损坏原文件已隔离留档）。 */
  load(): Promise<VendorsDocument>
  /** 原子写入（0600）。 */
  save(document: VendorsDocument): Promise<void>
  /** 文件路径（设置页展示）。 */
  path(): string
}

export function createVendorStore(directory: string): VendorStore {
  const filePath = join(directory, 'vendors.json')

  return {
    path: () => filePath,
    async load() {
      const text = await readFileIfExists(filePath)
      if (text === undefined) return emptyVendorsDocument()
      try {
        const parsed = parseDocument(text)
        if (parsed !== undefined) return parsed
      } catch {
        // fall through to quarantine
      }
      // 结构不对：隔离留档，按空配置继续。
      await quarantineFile(filePath, Date.now()).catch(() => {})
      return emptyVendorsDocument()
    },
    async save(document) {
      await writeFileAtomic(filePath, JSON.stringify(document, null, 2) + '\n')
      await chmod(filePath, 0o600).catch(() => {})
    },
  }
}

/** 解析并校验文档形状；不合形返回 undefined（由调用方隔离）。 */
function parseDocument(text: string): VendorsDocument | undefined {
  const raw: unknown = JSON.parse(text)
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  if (record.version !== VENDORS_VERSION) return undefined
  if (!Array.isArray(record.vendors)) return undefined
  const mode: RoutingMode = record.mode === 'balanced' || record.mode === 'max_power' || record.mode === 'free' ? record.mode : 'frugal'
  const vendors: VendorConfig[] = []
  for (const entry of record.vendors) {
    const vendor = coerceVendor(entry)
    if (vendor !== undefined) vendors.push(vendor)
  }
  return { version: VENDORS_VERSION, mode, vendors }
}

function coerceVendor(entry: unknown): VendorConfig | undefined {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined
  const record = entry as Record<string, unknown>
  const vendorId = record.vendorId
  if (typeof vendorId !== 'string' || vendorId === '') return undefined
  const stringOr = (value: unknown, fallback: string): string => (typeof value === 'string' ? value : fallback)
  const enabled = Array.isArray(record.enabledModels)
    ? record.enabledModels.filter((id): id is string => typeof id === 'string' && id !== '')
    : []
  const modelTags = coerceModelTags(record.modelTags)
  const modelPricing = coerceModelPricing(record.modelPricing)
  const pulledModels = coercePulledModels(record.pulledModels)
  return {
    vendorId,
    vendorName: stringOr(record.vendorName, vendorId),
    officialUrl: stringOr(record.officialUrl, ''),
    customUrl: stringOr(record.customUrl, ''),
    ...(record.endpointSource === 'official' || record.endpointSource === 'relay'
      ? { endpointSource: record.endpointSource }
      : {}),
    apiKey: stringOr(record.apiKey, ''),
    enabledModels: enabled,
    // 这两项以前被丢掉：保存后重启即丢失，AI 打的标签与用户覆盖的价目都白做。
    ...(modelTags === undefined ? {} : { modelTags }),
    ...(modelPricing === undefined ? {} : { modelPricing }),
    ...(pulledModels === undefined ? {} : { pulledModels }),
  }
}

/** 拉取快照：`{ id, name }[]`；id 空的丢，name 缺省用 id。 */
function coercePulledModels(value: unknown): Array<{ id: string, name: string }> | undefined {
  if (!Array.isArray(value)) return undefined
  const out: Array<{ id: string, name: string }> = []
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    if (id === '') continue
    const name = typeof record.name === 'string' && record.name.trim() !== '' ? record.name : id
    out.push({ id, name })
  }
  return out.length > 0 ? out : undefined
}

/** 模型标签：`{ modelId: string[] }`；非法值逐条丢弃。 */
function coerceModelTags(value: unknown): Record<string, string[]> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: Record<string, string[]> = {}
  for (const [modelId, tags] of Object.entries(value as Record<string, unknown>)) {
    if (modelId === '' || !Array.isArray(tags)) continue
    const list = tags.filter((tag): tag is string => typeof tag === 'string' && tag !== '')
    if (list.length > 0) out[modelId] = list
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/** 模型价目覆盖：`{ modelId: { input, output } }`（每百万 token，非负有限数）。 */
function coerceModelPricing(value: unknown): Record<string, { input: number, output: number }> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: Record<string, { input: number, output: number }> = {}
  for (const [modelId, price] of Object.entries(value as Record<string, unknown>)) {
    if (modelId === '' || price === null || typeof price !== 'object' || Array.isArray(price)) continue
    const record = price as Record<string, unknown>
    const input = record.input
    const output = record.output
    if (typeof input !== 'number' || typeof output !== 'number') continue
    if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) continue
    out[modelId] = { input, output }
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/** rename 的重导出仅供测试使用（损坏隔离的行为在 atomic-file 里）。 */
export { rename, isNotFound }

/** 把面板 PUT 上来的数组 coerce 成 VendorConfig[]（非法条目跳过）。 */
export function coerceVendorsList(value: unknown): VendorConfig[] {
  if (!Array.isArray(value)) return []
  const out: VendorConfig[] = []
  for (const entry of value) {
    const vendor = coerceVendor(entry)
    if (vendor !== undefined) out.push(vendor)
  }
  return out
}

/** 掩码：只回末四位，永不回明文。 */
export function maskKey(key: string): string {
  if (key === '') return ''
  return '••••' + key.slice(-4)
}
