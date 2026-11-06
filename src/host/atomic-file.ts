/**
 * 原子文件读写。
 *
 * 「原子」在这里是一件具体的事：写临时文件 → fsync → rename 覆盖。
 * rename 在同一文件系统内是原子的，所以读者要么看到旧内容，要么看到新内容，
 * 永远不会看到写了一半的 JSON。半截的台账比丢失一天的数据更糟——它会让
 * 下一次加载把整份文件当成损坏而隔离掉。
 *
 * 全部异步（fs/promises），不阻塞宿主事件循环。
 */
import { readFile, rename, mkdir, open, unlink, stat } from 'node:fs/promises'
import { dirname, join, basename } from 'node:path'
import { randomBytes } from 'node:crypto'

/** 读文件；不存在时返回 undefined 而不是抛错（首次启动就是这个状态）。 */
export async function readFileIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
}

/** 原子写：临时文件 + fsync + rename。 */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = join(dirname(path), '.' + basename(path) + '.' + randomBytes(6).toString('hex') + '.tmp')
  const handle = await open(temporary, 'w')
  try {
    await handle.writeFile(data, 'utf8')
    // fsync 之后 rename，才保证「rename 成功」等价于「内容已落盘」。
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await renameWithRetry(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

/** 重试次数：Windows 上并发 rename 同一个目标会短暂 EPERM/EEXIST。 */
const RENAME_ATTEMPTS = 8

/** 重试间隔（毫秒），逐次递增。 */
const RENAME_BACKOFF_MS = 5

/**
 * rename，带 Windows 有界重试。
 *
 * POSIX 上 rename 覆盖是原子的；Windows 上目标正被另一个 rename 触及时，
 * 内核会瞬时拒绝（EPERM/EEXIST/EACCES）。重试几次即可，不需要锁——
 * 每次重试仍然是一次完整的原子替换。
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      lastError = error
      if (!isTransientRenameError(error)) throw error
      await new Promise((resolve) => setTimeout(resolve, RENAME_BACKOFF_MS * (attempt + 1)))
    }
  }
  throw lastError
}

/** 是否是 Windows 上并发 rename 的瞬时错误。 */
function isTransientRenameError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = (error as { code?: unknown }).code
  return code === 'EPERM' || code === 'EACCES' || code === 'EEXIST'
}

/**
 * 把一份无法解析的文件隔离到旁边，而不是删除。
 *
 * 命名带时间戳，用户可以在出问题时自己去看；我们绝不静默丢弃用户数据。
 * @returns 隔离后的路径。
 */
export async function quarantineFile(path: string, now: number): Promise<string> {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
  const target = path + '.corrupt-' + stamp
  try {
    await rename(path, target)
    return target
  } catch (error) {
    if (isNotFound(error)) return target
    throw error
  }
}

/** 文件是否存在。 */
export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }
}

/** 是否是 ENOENT。 */
export function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}
