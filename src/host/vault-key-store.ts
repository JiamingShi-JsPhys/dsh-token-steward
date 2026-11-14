/**
 * 主密钥放在哪里。
 *
 * 1.2.0 把 AES 主密钥写在 `<状态目录>/.vault-key`，和密文（`vendors.json`、
 * `gateway.json`、`cache.sqlite`）挨在同一层目录、同一个权限面里。任何能以当前
 * 用户身份执行的进程——被投毒的依赖、恶意 MCP、误跑的脚本——伸一次手就能把
 * 钥匙和锁一起拿走，AES-256-GCM 就只剩「好看」。
 *
 * 现在按平台优先放到操作系统的凭据存储里：
 *   Windows  DPAPI（按当前用户绑定，另存为 `vault.key.dpapi` 的密文块）
 *   macOS    Keychain（`security`）
 *   Linux    libsecret（`secret-tool`），没有就降到普通文件
 * 都拿不到时退回到**状态目录之外**的普通密钥文件（配置目录下的 `vault.key`），
 * 再不行才是 degraded（照常运行、不加密，由调用方告警）。
 *
 * `STEWARD_VAULT_KEY` 仍然是最高优先级的显式覆盖，语义不变。
 *
 * 边界照旧：这一层挡的是「配置/备份被整份拷走」，不挡已经以你的身份运行的恶意
 * 代码——它可以直接读同一个凭据存储。文档按这个口径写，不夸大。
 */
import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 密钥长度：AES-256 的 32 字节。 */
export const KEY_BYTES = 32

/** 读一个密钥位置的结论。 */
export type KeyRead =
  | { state: 'ok', key: Buffer }
  /** 明确不存在：可以安全地新建。 */
  | { state: 'missing' }
  /** 在，但内容不是一把合法密钥：绝不覆盖用户的文件，退化为不加密。 */
  | { state: 'invalid' }
  /** 后端暂时用不了（命令失败、权限、凭据库锁着）：不新建，避免把旧密文变成孤儿。 */
  | { state: 'unavailable' }

/** 一个可以读写主密钥的位置。 */
export interface KeyBackend {
  /** 写进日志与设置页的说法（路径或 `keychain:` 之类）。 */
  location(): string
  read(): Promise<KeyRead>
  /** 写入密钥；失败抛错。已存在时由实现决定是否覆盖（本模块只在不存在时调用）。 */
  write(key: Buffer): Promise<void>
}

/** 解析 base64 / base64url 的密钥字符串，必须正好 32 字节。 */
export function parseKey(text: string): Buffer | undefined {
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

/** 密钥文件的首行就是密钥；顺带容忍结尾换行。 */
async function readKeyFile(path: string): Promise<KeyRead> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (isMissing(error)) return { state: 'missing' }
    return { state: 'unavailable' }
  }
  const key = parseKey(text.split(/\r?\n/)[0] ?? '')
  return key === undefined ? { state: 'invalid' } : { state: 'ok', key }
}

/** 原子写入一个 0600 文件（临时文件 + rename，绝不留下半个密钥）。 */
async function writeSecretFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = path + '.' + randomBytes(6).toString('hex') + '.tmp'
  const handle = await open(temporary, 'w', 0o600)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, path)
  await chmod(path, 0o600).catch(() => {})
}

/** 普通密钥文件后端（配置目录里，状态目录之外）。 */
export function fileBackend(path: string): KeyBackend {
  return {
    location: () => path,
    read: () => readKeyFile(path),
    write: async (key) => { await writeSecretFile(path, key.toString('base64url') + '\n') },
  }
}

/* ────────────────────────── 外部命令 ────────────────────────── */

interface CommandResult { code: number, stdout: string, stderr: string }

function runCommand(command: string, args: string[], input?: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(command + ' timed out'))
    }, 10_000)
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }) })
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
}

/* ────────────────────────── Windows DPAPI ────────────────────────── */

const DPAPI_FILE = 'vault.key.dpapi'

/**
 * DPAPI 的调用脚本。密钥经环境变量传入，避免出现在命令行上
 * （同一个用户的其他进程能看到别人的命令行，看不到别人的环境变量）。
 */
const DPAPI_PROTECT = [
  'Add-Type -AssemblyName System.Security',
  '$b = [Convert]::FromBase64String($env:STEWARD_KEY_IN)',
  "$p = [System.Security.Cryptography.ProtectedData]::Protect($b, $null, 'CurrentUser')",
  '[Convert]::ToBase64String($p)',
].join('; ')

const DPAPI_UNPROTECT = [
  'Add-Type -AssemblyName System.Security',
  '$b = [Convert]::FromBase64String($env:STEWARD_KEY_IN)',
  "$p = [System.Security.Cryptography.ProtectedData]::Unprotect($b, $null, 'CurrentUser')",
  '[Convert]::ToBase64String($p)',
].join('; ')

async function runDpapi(script: string, input: string): Promise<string> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        timeout: 15_000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, STEWARD_KEY_IN: input },
      },
      (error, out) => {
        if (error !== null) reject(error)
        else resolve(String(out))
      },
    )
  })
  return stdout.trim()
}

/**
 * DPAPI 后端：磁盘上只有一段只有当前 Windows 用户能解开的密文。
 * 文件被拷到别的账户 / 别的机器上就只是一段随机字节。
 */
export function dpapiBackend(directory: string): KeyBackend {
  const path = join(directory, DPAPI_FILE)
  return {
    location: () => path,
    async read(): Promise<KeyRead> {
      // 磁盘上那段不是 32 字节密钥，而是 DPAPI 密文块，不能按密钥文件解析。
      let blob: string
      try {
        blob = (await readFile(path, 'utf8')).trim()
      } catch (error) {
        return isMissing(error) ? { state: 'missing' } : { state: 'unavailable' }
      }
      if (blob === '') return { state: 'invalid' }
      try {
        const plain = await runDpapi(DPAPI_UNPROTECT, blob)
        const key = parseKey(plain)
        return key === undefined ? { state: 'invalid' } : { state: 'ok', key }
      } catch {
        // 解不开（换了账户 / 换了机器 / PowerShell 不可用）：不新建，交给 degraded。
        return { state: 'unavailable' }
      }
    },
    async write(key) {
      const sealed = await runDpapi(DPAPI_PROTECT, key.toString('base64'))
      if (sealed === '') throw new Error('dpapi protect returned nothing')
      await writeSecretFile(path, sealed + '\n')
    },
  }
}

/* ────────────────────────── macOS Keychain ────────────────────────── */

const KEYCHAIN_SERVICE = 'dsh-token-steward-vault'
const KEYCHAIN_ACCOUNT = 'vault'

/** Keychain 后端：密钥不落文件，交给系统钥匙串按登录账户保护。 */
export function keychainBackend(): KeyBackend {
  return {
    location: () => 'keychain:' + KEYCHAIN_SERVICE,
    async read(): Promise<KeyRead> {
      try {
        const result = await runCommand(
          'security',
          ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'],
        )
        if (result.code !== 0) {
          // 44 = errSecItemNotFound；stderr 里带 could not be found 也是「还没配过」。
          if (result.code === 44 || /could not be found/i.test(result.stderr)) return { state: 'missing' }
          return { state: 'unavailable' }
        }
        const key = parseKey(result.stdout.split(/\r?\n/)[0] ?? '')
        return key === undefined ? { state: 'invalid' } : { state: 'ok', key }
      } catch {
        return { state: 'unavailable' }
      }
    },
    async write(key) {
      const result = await runCommand('security', [
        'add-generic-password', '-U',
        '-s', KEYCHAIN_SERVICE,
        '-a', KEYCHAIN_ACCOUNT,
        '-w', key.toString('base64url'),
      ])
      if (result.code !== 0) throw new Error('keychain write failed: ' + result.stderr.trim())
    },
  }
}

/* ────────────────────────── Linux libsecret ────────────────────────── */

/** libsecret 后端（`secret-tool`）；没有这个命令时由调用方退回普通文件。 */
export function secretToolBackend(): KeyBackend {
  const attrs = ['service', KEYCHAIN_SERVICE, 'key', KEYCHAIN_ACCOUNT]
  return {
    location: () => 'libsecret:' + KEYCHAIN_SERVICE,
    async read(): Promise<KeyRead> {
      try {
        const result = await runCommand('secret-tool', ['lookup', ...attrs])
        if (result.code !== 0) {
          if (result.stdout.trim() === '') return { state: 'missing' }
          return { state: 'unavailable' }
        }
        const key = parseKey(result.stdout.split(/\r?\n/)[0] ?? '')
        return key === undefined ? { state: 'invalid' } : { state: 'ok', key }
      } catch {
        return { state: 'unavailable' }
      }
    },
    async write(key) {
      const result = await runCommand(
        'secret-tool',
        ['store', '--label', 'DSH Token Steward vault key', ...attrs],
        key.toString('base64url') + '\n',
      )
      if (result.code !== 0) throw new Error('secret-tool store failed: ' + result.stderr.trim())
    },
  }
}

/* ────────────────────────── 默认位置 ────────────────────────── */

/**
 * 默认密钥目录：**状态目录之外**的用户配置目录。
 * Windows 走 `%APPDATA%\dsh-token-steward`，macOS 走 Application Support，
 * 其余按 XDG。这样把 `~/.dsh` 打包、同步、贴给别人，带走的只有密文。
 */
export function defaultKeyDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const home = homedir()
  if (process.platform === 'win32') {
    const appData = typeof env.APPDATA === 'string' && env.APPDATA !== '' ? env.APPDATA : join(home, 'AppData', 'Roaming')
    return join(appData, 'dsh-token-steward')
  }
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'dsh-token-steward')
  const xdg = typeof env.XDG_CONFIG_HOME === 'string' && env.XDG_CONFIG_HOME !== '' ? env.XDG_CONFIG_HOME : join(home, '.config')
  return join(xdg, 'dsh-token-steward')
}

/** 按平台给出后端链：凭据存储优先，普通文件兜底。 */
export function defaultBackends(directory: string): KeyBackend[] {
  if (process.platform === 'win32') return [dpapiBackend(directory), fileBackend(join(directory, 'vault.key'))]
  if (process.platform === 'darwin') return [keychainBackend(), fileBackend(join(directory, 'vault.key'))]
  return [secretToolBackend(), fileBackend(join(directory, 'vault.key'))]
}

/** 删掉迁移后的旧密钥文件（不留在原地，也不再被任何代码读取）。 */
export async function removeLegacyKey(path: string): Promise<boolean> {
  try {
    await rm(path, { force: true })
    return true
  } catch {
    return false
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}
