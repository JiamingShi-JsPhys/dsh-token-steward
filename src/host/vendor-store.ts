/**
 * vendors.json 的读写（$DSH_HOME/token-steward/vendors.json，0600）。
 *
 * 这是 Token 管家面板的**第一配置源**：厂家 Tab 里粘贴的 API Key 与勾选的
 * 模型都落在这里。密钥以 AES-256-GCM 密文写盘（`enc:v1:` 前缀，密钥在
 * `.vault-key`），解密只发生在内存里；永不进入日志、快照与任何过线 JSON——
 * GET 接口只回掩码尾部。老版本留下的明文在启动读盘时就地转成密文。
 *
 * 损坏处理与台账一致：隔离留档为 .corrupt-<ISO>，然后当空配置启动，
 * 绝不让一个坏文件把插件挂载打崩。
 */
import { chmod, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { RoutingMode, VendorConfig } from '../core/types.ts'
import { readFileIfExists, writeFileAtomic, quarantineFile, isNotFound } from './atomic-file.ts'
import { isSealed, type SecretVault } from './secret-vault.ts'
import { isSafeRecordKey } from '../core/record-keys.ts'

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

export interface VendorStoreOptions {
  /** 静态加密；缺省表示不加密（测试与老调用点）。 */
  vault?: SecretVault
}

export function createVendorStore(directory: string, options: VendorStoreOptions = {}): VendorStore {
  const filePath = join(directory, 'vendors.json')
  const vault = options.vault
  /**
   * 解不开的密文（换了密钥、文件被改过）：原样留着。
   *
   * 绝不能因为一次读失败就在下次保存时把用户密钥抹成空串——那等于「钥匙丢了，
   * 顺手把锁也砸了」。面板会显示 hasKey=false，用户重新填一次就恢复正常。
   */
  const sealedBackup = new Map<string, string>()

  /** 原子写盘（密文），load 的自动迁移与 save 共用。 */
  const persist = async (document: VendorsDocument): Promise<void> => {
    const out: VendorsDocument = vault === undefined || !vault.available()
      ? document
      : { ...document, vendors: document.vendors.map((vendor) => sealVendor(vendor, vault, sealedBackup)) }
    await writeFileAtomic(filePath, JSON.stringify(out, null, 2) + '\n', { mode: 0o600 })
    await chmod(filePath, 0o600).catch(() => {})
  }

  return {
    path: () => filePath,
    async load() {
      const text = await readFileIfExists(filePath)
      if (text === undefined) return emptyVendorsDocument()
      try {
        const parsed = parseDocument(text)
        if (parsed !== undefined) {
          if (vault !== undefined && vault.available()) {
            const needsSeal = unseal(parsed, vault, sealedBackup)
            if (needsSeal) {
              /*
               * 启动即迁移：1.1.x 留下的是明文，不该因为「用户还没点保存」就一直
               * 躺在盘上。写失败不阻断挂载——内存里仍是可用的明文，下次保存会重试。
               */
              await persist(parsed).catch(() => {})
            }
          }
          return parsed
        }
      } catch {
        // fall through to quarantine
      }
      // 结构不对：隔离留档，按空配置继续。
      await quarantineFile(filePath, Date.now()).catch(() => {})
      return emptyVendorsDocument()
    },
    save: persist,
  }
}

/** 保存前把 apiKey 换成密文；空串沿用上次解不开的那份密文。 */
function sealVendor(vendor: VendorConfig, vault: SecretVault, backup: Map<string, string>): VendorConfig {
  if (vendor.apiKey === '') {
    const kept = backup.get(vendor.vendorId)
    return kept === undefined ? vendor : { ...vendor, apiKey: kept }
  }
  if (isSealed(vendor.apiKey)) return vendor
  const sealed = vault.seal(vendor.apiKey)
  if (isSealed(sealed)) backup.set(vendor.vendorId, sealed)
  return { ...vendor, apiKey: sealed }
}

/**
 * 读盘后把 apiKey 解密回明文（只在内存里）；解不开的留个备份再置空。
 *
 * 返回值 = 「盘上还有明文」：有任何一个非空、又不是 `enc:v1:` 的值，就说明这是
 * 1.1.x 留下的老文件（或用户手改过），load 据此立刻重写为密文。
 */
function unseal(document: VendorsDocument, vault: SecretVault, backup: Map<string, string>): boolean {
  let plaintextOnDisk = false
  for (const vendor of document.vendors) {
    if (!isSealed(vendor.apiKey)) {
      if (vendor.apiKey !== '') plaintextOnDisk = true
      continue
    }
    const plain = vault.open(vendor.apiKey)
    if (plain === undefined) {
      backup.set(vendor.vendorId, vendor.apiKey)
      vendor.apiKey = ''
      continue
    }
    vendor.apiKey = plain
    backup.delete(vendor.vendorId)
  }
  return plaintextOnDisk
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
    ...(record.api === 'openai-completions' || record.api === 'anthropic-messages'
      ? { api: record.api }
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
    if (!isSafeRecordKey(modelId) || !Array.isArray(tags)) continue
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
    if (!isSafeRecordKey(modelId) || price === null || typeof price !== 'object' || Array.isArray(price)) continue
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
