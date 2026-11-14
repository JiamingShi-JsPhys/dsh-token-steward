/**
 * 静态加密（encryption at rest）。
 *
 * 为什么要有这一层：`vendors.json` 里的厂家密钥、`gateway.json` 里的本地令牌、
 * `cache.sqlite` 里的模型回复，此前都是明文落的盘。权限 0600 只挡别的用户，
 * 挡不住最常发生的三种泄漏：
 *   - 备份 / 同步盘把 `~/.dsh` 整个上传；
 *   - 用户把配置文件贴进 issue、聊天或截图；
 *   - 同一账号下的其它程序、Agent 工具直接 `cat` 一遍。
 *
 * 实现：AES-256-GCM，每个值独立随机 IV，密钥 32 字节。
 *
 * 主密钥**不再和密文放在同一个目录**：默认交给操作系统的凭据存储（Windows
 * DPAPI、macOS Keychain、Linux libsecret），拿不到时才落到用户配置目录下的
 * `vault.key`——无论如何都在 `$DSH_HOME/token-steward` 之外。旧版本留下的
 * `<数据目录>/.vault-key` 会在首次启动时被搬走并删除。`STEWARD_VAULT_KEY`
 * 仍是最高优先级的覆盖（base64url / base64，32 字节）。
 *
 * **威胁模型要说清楚**：这层加密防的是「配置文件被整份拷走」（备份、同步盘、
 * 贴给别人、被其它工具读走），**不防**已经能以你的身份执行代码的恶意软件——
 * 那种情况下它同样能读凭据存储。对外文档按这个口径写，不夸大。
 *
 * 格式：
 *   文本  `enc:v1:<iv>.<tag>.<ciphertext>`（三段都是 base64url）
 *   字节  `STV1` + 12 字节 IV + 16 字节 tag + 密文
 * 带版本前缀，将来换算法时可以并存。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import {
  defaultBackends,
  defaultKeyDirectory,
  dpapiBackend,
  fileBackend,
  keychainBackend,
  KEY_BYTES,
  parseKey,
  removeLegacyKey,
  secretToolBackend,
  type KeyBackend,
} from './vault-key-store.ts'

/** 文本密文前缀。 */
export const SEALED_PREFIX = 'enc:v1:'

/** 二进制密文头（4 字节魔数）。 */
const BINARY_MAGIC = Buffer.from('STV1', 'ascii')

/** IV 长度（GCM 推荐 12）。 */
const IV_BYTES = 12

/** GCM 认证标签长度。 */
const TAG_BYTES = 16

/** 这个值是不是我们封装的密文。 */
export function isSealed(value: string): boolean {
  return value.startsWith(SEALED_PREFIX)
}

/** 一段字节是不是我们封装的密文。 */
export function isSealedBytes(value: Uint8Array): boolean {
  return value.length > BINARY_MAGIC.length + IV_BYTES + TAG_BYTES
    && Buffer.from(value.subarray(0, BINARY_MAGIC.length)).equals(BINARY_MAGIC)
}

/** 加解密接口；`available()` 为 false 时 seal/open 退化为原样返回。 */
export interface SecretVault {
  /** 封装成字符串；空串保持空串。 */
  seal(plain: string): string
  /** 解开字符串；不是密文就原样返回；解不开（密钥不匹配 / 被篡改）返回 undefined。 */
  open(text: string): string | undefined
  /** 封装一段字节。 */
  sealBytes(plain: Uint8Array): Uint8Array
  /** 解开一段字节；不是密文就原样返回；解不开返回 undefined。 */
  openBytes(value: Uint8Array): Uint8Array | undefined
  /** 密钥是否真的可用。 */
  available(): boolean
  /** 密钥文件路径（设置页与文档用）。 */
  keyPath(): string
}

export interface VaultOptions {
  /** 读环境变量（测试注入）。 */
  env?: NodeJS.ProcessEnv
  /** 密钥缺失时是否生成；默认 true。测试里关掉可拿到单例行为。 */
  create?: boolean
  /** 旧位置（状态目录）里的密钥文件名；只用于迁移，默认 `.vault-key`。 */
  keyFile?: string
  /** 新位置（状态目录之外）的目录；默认按平台取用户配置目录。 */
  keyDirectory?: string
  /** 强制后端；默认 `auto`（按平台挑，凭据存储优先，文件兜底）。 */
  keyBackend?: 'auto' | 'file' | 'dpapi' | 'keychain' | 'secret-tool'
}

/** 一个不可用的保险实现：读写都不变身，绝不 panic。 */
function degradedVault(keyPath: string): SecretVault {
  return {
    seal: (plain) => plain,
    open: (text) => text,
    sealBytes: (plain) => plain,
    openBytes: (value) => value,
    available: () => false,
    keyPath: () => keyPath,
  }
}

/**
 * 打开（必要时创建）一个数据目录对应的密钥库。
 *
 * 优先级：`STEWARD_VAULT_KEY` → 凭据存储 / 配置目录里的 `vault.key` →
 * 迁移状态目录里的旧 `.vault-key` → 新生成一枚。全都拿不到就退化：
 * 功能照常，但**不加密**，调用方应当记一条警告。
 */
export async function createSecretVault(directory: string, options: VaultOptions = {}): Promise<SecretVault> {
  const env = options.env ?? process.env
  const configured = typeof env.STEWARD_VAULT_DIR === 'string' && env.STEWARD_VAULT_DIR.trim() !== ''
    ? env.STEWARD_VAULT_DIR
    : undefined
  const keyDirectory = options.keyDirectory ?? configured ?? defaultKeyDirectory(env)
  const backends = selectBackends(keyDirectory, options.keyBackend)
  /** 真正用上的位置（写进 keyPath()，也就是日志与设置页）。 */
  let used: string = backends[0]?.location() ?? keyDirectory

  // 1. 显式覆盖优先，语义与 1.2.0 完全一致。
  const fromEnv = typeof env.STEWARD_VAULT_KEY === 'string' ? parseKey(env.STEWARD_VAULT_KEY) : undefined
  if (fromEnv !== undefined) return liveVault(fromEnv, () => 'env:STEWARD_VAULT_KEY')

  // 2. 凭据存储 / 新位置的密钥文件。
  let sawBrokenBackend = false
  for (const backend of backends) {
    const result = await backend.read()
    if (result.state === 'ok') {
      used = backend.location()
      return liveVault(result.key, () => used)
    }
    if (result.state === 'invalid') {
      // 在，但内容不是密钥：绝不覆盖，退化为不加密。
      return degradedVault(backend.location())
    }
    if (result.state === 'unavailable') sawBrokenBackend = true
  }

  // 3. 老版本把钥匙放在状态目录里：搬走，然后从原地删掉。
  const legacyPath = join(directory, options.keyFile ?? '.vault-key')
  const legacy = await readLegacyKey(legacyPath)
  if (legacy.state === 'ok') {
    const moved = await writeNewKey(backends, legacy.key)
    if (moved !== undefined) {
      used = moved
      // 同一把钥匙已经在状态目录之外了，旧文件不留（否则加密白做）。
      if (legacyPath !== moved) await removeLegacyKey(legacyPath)
      return liveVault(legacy.key, () => used)
    }
    // 新位置写不进去：继续用旧钥匙，宁可不迁移也不能把用户的密文变成孤儿。
    return liveVault(legacy.key, () => legacyPath)
  }
  if (legacy.state === 'invalid' || legacy.state === 'unavailable') {
    return degradedVault(legacyPath)
  }

  // 4. 全新安装：生成一枚。某个后端「暂时不可用」时不生成，
  //    免得新钥匙和凭据库里已有的那把对不上、把旧密文变成孤儿。
  if (sawBrokenBackend || options.create === false) return degradedVault(used)
  const fresh = randomBytes(KEY_BYTES)
  const stored = await writeNewKey(backends, fresh)
  if (stored === undefined) return degradedVault(used)
  used = stored
  return liveVault(fresh, () => used)
}

function selectBackends(directory: string, forced: VaultOptions['keyBackend']): KeyBackend[] {
  if (forced === undefined || forced === 'auto') return defaultBackends(directory)
  switch (forced) {
    case 'file': return [fileBackend(join(directory, 'vault.key'))]
    case 'dpapi': return [dpapiBackend(directory), fileBackend(join(directory, 'vault.key'))]
    case 'keychain': return [keychainBackend(), fileBackend(join(directory, 'vault.key'))]
    case 'secret-tool': return [secretToolBackend(), fileBackend(join(directory, 'vault.key'))]
  }
}

/** 从旧位置读密钥；区分「没有」「有但坏了」「读不了」。 */
async function readLegacyKey(path: string): Promise<{ state: 'ok', key: Buffer } | { state: 'missing' } | { state: 'invalid' } | { state: 'unavailable' }> {
  const { readFile } = await import('node:fs/promises')
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
      ? { state: 'missing' }
      : { state: 'unavailable' }
  }
  const key = parseKey(text.split(/\r?\n/)[0] ?? '')
  return key === undefined ? { state: 'invalid' } : { state: 'ok', key }
}

/** 把密钥写进第一个写得进去的后端；全失败返回 undefined。 */
async function writeNewKey(backends: KeyBackend[], key: Buffer): Promise<string | undefined> {
  for (const backend of backends) {
    try {
      await backend.write(key)
      return backend.location()
    } catch {
      // 下一个后端（通常是普通的 vault.key 文件）。
    }
  }
  return undefined
}

/** 真正干活的实现。 */
function liveVault(key: Buffer, keyPath: () => string): SecretVault {
  return {
    seal(plain) {
      if (plain === '') return ''
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
      const tag = cipher.getAuthTag()
      return SEALED_PREFIX
        + iv.toString('base64url') + '.'
        + tag.toString('base64url') + '.'
        + ciphertext.toString('base64url')
    },
    open(text) {
      if (!isSealed(text)) return text
      const parts = text.slice(SEALED_PREFIX.length).split('.')
      if (parts.length !== 3) return undefined
      const [ivText, tagText, dataText] = parts as [string, string, string]
      try {
        const iv = Buffer.from(ivText, 'base64url')
        const tag = Buffer.from(tagText, 'base64url')
        if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return undefined
        const decipher = createDecipheriv('aes-256-gcm', key, iv)
        decipher.setAuthTag(tag)
        const plain = Buffer.concat([decipher.update(Buffer.from(dataText, 'base64url')), decipher.final()])
        return plain.toString('utf8')
      } catch {
        // 认证失败：密钥换了，或者密文被改过。绝不返回半截明文。
        return undefined
      }
    },
    sealBytes(plain) {
      if (plain.length === 0) return plain
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()])
      return Buffer.concat([BINARY_MAGIC, iv, cipher.getAuthTag(), ciphertext])
    },
    openBytes(value) {
      if (!isSealedBytes(value)) return value
      const iv = Buffer.from(value.subarray(BINARY_MAGIC.length, BINARY_MAGIC.length + IV_BYTES))
      const tag = Buffer.from(value.subarray(
        BINARY_MAGIC.length + IV_BYTES,
        BINARY_MAGIC.length + IV_BYTES + TAG_BYTES,
      ))
      const data = Buffer.from(value.subarray(BINARY_MAGIC.length + IV_BYTES + TAG_BYTES))
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, iv)
        decipher.setAuthTag(tag)
        return Buffer.concat([decipher.update(data), decipher.final()])
      } catch {
        return undefined
      }
    },
    available: () => true,
    keyPath,
  }
}
