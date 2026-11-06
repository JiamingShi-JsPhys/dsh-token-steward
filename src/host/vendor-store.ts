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
  const mode: RoutingMode = record.mode === 'balanced' || record.mode === 'max_power' ? record.mode : 'frugal'
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
  return {
    vendorId,
    vendorName: stringOr(record.vendorName, vendorId),
    officialUrl: stringOr(record.officialUrl, ''),
    customUrl: stringOr(record.customUrl, ''),
    apiKey: stringOr(record.apiKey, ''),
    enabledModels: enabled,
  }
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
