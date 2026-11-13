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
 * 实现：AES-256-GCM，每个值独立随机 IV，密钥 32 字节，落盘在
 * `<数据目录>/.vault-key`（0600，首次使用时生成）。也接受
 * `STEWARD_VAULT_KEY`（base64url）覆盖，便于把密钥放到别处或做可迁移备份。
 *
 * **威胁模型要说清楚**：密钥和密文在同一台机器、同一个用户下。这层加密防的是
 * 「配置文件单独流出」，**不防**已经能以你的身份执行代码的恶意软件——那种情况下
 * 它同样能读 `.vault-key`。对外文档按这个口径写，不夸大。
 *
 * 格式：
 *   文本  `enc:v1:<iv>.<tag>.<ciphertext>`（三段都是 base64url）
 *   字节  `STV1` + 12 字节 IV + 16 字节 tag + 密文
 * 带版本前缀，将来换算法时可以并存。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmod, mkdir, open, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 文本密文前缀。 */
export const SEALED_PREFIX = 'enc:v1:'

/** 二进制密文头（4 字节魔数）。 */
const BINARY_MAGIC = Buffer.from('STV1', 'ascii')

/** IV 长度（GCM 推荐 12）。 */
const IV_BYTES = 12

/** GCM 认证标签长度。 */
const TAG_BYTES = 16

/** 密钥文件里的密钥长度。 */
const KEY_BYTES = 32

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
  /** 密钥文件缺失时是否生成；默认 true。测试里关掉可拿到单例行为。 */
  create?: boolean
  /** 密钥文件名。 */
  keyFile?: string
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

/** 解析 base64 / base64url 的密钥字符串，必须正好 32 字节。 */
function parseKey(text: string): Buffer | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  let buffer: Buffer
  try {
    buffer = Buffer.from(trimmed, 'base64url')
  } catch {
    return undefined
  }
  if (buffer.length !== KEY_BYTES) {
    try {
      const fallback = Buffer.from(trimmed, 'base64')
      if (fallback.length === KEY_BYTES) return fallback
    } catch {
      return undefined
    }
    return undefined
  }
  return buffer
}

/**
 * 打开（必要时创建）一个数据目录对应的密钥库。
 *
 * 密钥来源优先级：`STEWARD_VAULT_KEY` 环境变量 → `<directory>/.vault-key`。
 * 两者都拿不到就退化：功能照常，但**不加密**，调用方应当记一条警告。
 */
export async function createSecretVault(directory: string, options: VaultOptions = {}): Promise<SecretVault> {
  const keyPath = join(directory, options.keyFile ?? '.vault-key')
  const env = options.env ?? process.env
  const fromEnv = typeof env.STEWARD_VAULT_KEY === 'string' ? parseKey(env.STEWARD_VAULT_KEY) : undefined
  const key = fromEnv ?? await loadOrCreateKey(keyPath, options.create !== false)
  if (key === undefined) return degradedVault(keyPath)
  return liveVault(key, keyPath)
}

/** 读密钥文件；不存在且允许创建时生成一枚。 */
async function loadOrCreateKey(keyPath: string, create: boolean): Promise<Buffer | undefined> {
  try {
    const text = await readFile(keyPath, 'utf8')
    const parsed = parseKey(text.split(/\r?\n/)[0] ?? '')
    if (parsed !== undefined) return parsed
    // 文件在但内容不对：不覆盖（可能被用户改坏了），退化为不加密，由调用方告警。
    return undefined
  } catch (error) {
    if (!isMissing(error) || !create) return undefined
  }
  try {
    await mkdir(join(keyPath, '..'), { recursive: true })
    const fresh = randomBytes(KEY_BYTES)
    // 以 0600 原子创建：先写临时文件再 rename，避免半个密钥文件被读到。
    const temporary = keyPath + '.' + fresh.toString('hex').slice(0, 12) + '.tmp'
    const handle = await open(temporary, 'w', 0o600)
    try {
      await handle.writeFile(fresh.toString('base64url') + '\n', 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    const { rename } = await import('node:fs/promises')
    await rename(temporary, keyPath)
    await chmod(keyPath, 0o600).catch(() => {})
    return fresh
  } catch {
    return undefined
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

/** 真正干活的实现。 */
function liveVault(key: Buffer, keyPath: string): SecretVault {
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
    keyPath: () => keyPath,
  }
}
