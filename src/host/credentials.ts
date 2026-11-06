/**
 * 凭据展开。
 *
 * 唯一一条硬规则：**明文只存在于内存，且只写进 Authorization 头**。
 * 它不进日志、不进快照、不进状态文件、不进任何会过线的 JSON。
 *
 * 因此这里不做「记住上一次解析结果」的缓存——缓存会把明文活得更久；
 * 一次 env 查找的代价远小于一次泄漏。
 */
import { readFile } from 'node:fs/promises'
import type { CredentialRef } from '../core/types.ts'

/** 一个可注入的凭据来源（测试不碰真实环境变量与磁盘）。 */
export interface CredentialSources {
  /** 读环境变量。 */
  env(name: string): string | undefined
  /** 读文件首行。 */
  readFile(path: string): Promise<string>
}

/** 系统来源。 */
export const systemSources: CredentialSources = {
  env: (name) => process.env[name],
  readFile: async (path) => readFile(path, 'utf8'),
}

/** 展开成功与失败的二元结果。 */
export type CredentialResult =
  | { ok: true; secret: string }
  | { ok: false; reason: string }

/** 判断一个引用走哪条分支。 */
export function credentialKind(ref: CredentialRef): 'env' | 'file' | 'literal' | 'unknown' {
  if (ref.startsWith('env:')) return 'env'
  if (ref.startsWith('file:')) return 'file'
  if (ref.startsWith('literal:')) return 'literal'
  if (/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(ref)) return 'env'
  return 'unknown'
}

/**
 * 展开一个凭据引用。
 * @param ref - env:NAME / file:/abs/path / literal:xxx / ${NAME}
 * @param sources - 可注入来源。
 * @returns 明文或失败原因；原因里只出现引用写法，绝不出现明文。
 */
export async function resolveCredential(
  ref: CredentialRef,
  sources: CredentialSources = systemSources,
): Promise<CredentialResult> {
  const kind = credentialKind(ref)
  if (kind === 'unknown') {
    return { ok: false, reason: 'unrecognized credential reference; use env:NAME, file:/abs/path, literal:xxx, or ${NAME}' }
  }
  if (kind === 'literal') {
    const secret = ref.slice('literal:'.length)
    if (secret === '') return { ok: false, reason: 'literal credential is empty' }
    return { ok: true, secret }
  }
  if (kind === 'env') {
    const name = ref.startsWith('env:')
      ? ref.slice('env:'.length)
      : ref.slice(2, ref.length - 1)
    const secret = sources.env(name)
    if (secret === undefined || secret === '') {
      return { ok: false, reason: 'environment variable ' + name + ' is not set' }
    }
    return { ok: true, secret }
  }

  const path = ref.slice('file:'.length)
  if (path === '') return { ok: false, reason: 'file credential has no path' }
  try {
    const text = await sources.readFile(path)
    const first = text.split(/\r?\n/)[0] ?? ''
    const secret = first.trim()
    if (secret === '') return { ok: false, reason: 'credential file ' + path + ' is empty' }
    return { ok: true, secret }
  } catch (error) {
    return { ok: false, reason: 'cannot read credential file ' + path + ': ' + messageOf(error) }
  }
}

/**
 * 把明文打码后展示：只留前 3 位与后 2 位。
 * 面板与日志一律用它，绝不直接输出明文。
 */
export function maskSecret(secret: string): string {
  if (secret.length <= 6) return '*'.repeat(secret.length)
  return secret.slice(0, 3) + '*'.repeat(Math.max(3, secret.length - 5)) + secret.slice(-2)
}

/** 从 unknown 里取可读消息。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
