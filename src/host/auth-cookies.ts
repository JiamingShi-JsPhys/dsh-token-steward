/**
 * 网页会话认证 Cookie 的体检与清理。
 *
 * 背景（2026-11 实测）：DSH 桌面版的宿主每次启动都会下发一枚**新名字**的
 * `dsh-auth-<随机>` Cookie（HttpOnly、Path=/、Max-Age 30 天），却从不回收上一次的。
 * 这些 Cookie 全部落在 Electron 默认会话里，浏览器每发一次请求就全带上。
 *
 * 累计到 70 枚左右时，Cookie 请求头越过 Node 默认的 16 KB 头上限，宿主对
 * 每个带凭证的请求回 **431 Request Header Fields Too Large**；桌面端
 * `connectDesktopWelcome` 拿到非 2xx 就抛 `desktop welcome: Web authentication failed`，
 * 应用停在「应用无法启动」——与插件、密钥、账号都无关。
 *
 * 因此这里提供离线清理；「数出来」与提醒阈值在 core/auth-cookies.ts（纯函数，面板共用）：
 *  - `countAuthCookies(header)`：从任意请求的 Cookie 头里数出会话 Cookie 数量
 *    （宿主自己就收得到这个头，无需碰磁盘，也不受文件锁影响）；
 *  - `pruneAuthCookiesFile(dbPath)`：离线清理，**必须关闭 DSH 后运行**
 *    （Chromium 运行期间以独占方式占用 Cookies 文件，读写都会报 EBUSY/无法打开）。
 */
import { copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { AUTH_COOKIE_PREFIX } from '../core/auth-cookies.ts'

export { AUTH_COOKIE_PREFIX, countAuthCookies } from '../core/auth-cookies.ts'

/** 宿主自己的网页源：Cookie 只对这一个 host 有意义。 */
export const AUTH_COOKIE_HOST = '127.0.0.1'

/**
 * 桌面版 Cookie 库的默认位置（Windows）。
 * @param env - 取 `APPDATA` 的环境（测试可注入）。
 * @returns 绝对路径；非 Windows 或没有 APPDATA 时是 undefined。
 */
export function defaultCookieDbPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const appData = env.APPDATA
  if (appData === undefined || appData === '') return undefined
  return join(appData, '@deepseek-ai', 'dsh-desktop', 'Network', 'Cookies')
}

/** 清理结果。 */
export interface AuthCookiePruneResult {
  /** 清理前该源下的会话 Cookie 数。 */
  before: number
  /** 清理后剩余的数量（保留 keep 枚）。 */
  after: number
  /** 备份文件路径；没写备份时为 undefined。 */
  backup?: string
}

/**
 * 删除该源下多余的会话 Cookie，只保留最新 `keep` 枚。
 *
 * 必须**关闭 DSH** 后调用：Chromium 运行期间独占 Cookies 文件。
 * 读不成功的名字（加密值坏掉等）只是删不掉，不会影响其它行。
 *
 * @param dbPath - Cookies 库路径；缺省取 {@link defaultCookieDbPath}。
 * @param options.keep - 保留几枚（默认 0：全清，下次启动宿主会重新下发一枚）。
 * @param options.backup - 是否先写一份 `.bak-steward-<时间>`（默认 true）。
 * @returns 清理结果；库不存在时返回 undefined。
 */
export async function pruneAuthCookiesFile(
  dbPath: string | undefined = defaultCookieDbPath(),
  options: { keep?: number, backup?: boolean } = {},
): Promise<AuthCookiePruneResult | undefined> {
  if (dbPath === undefined || !existsSync(dbPath)) return undefined
  // 动态引入：老宿主没有 node:sqlite 时整个插件不能因为这一个诊断工具而加载失败。
  const { DatabaseSync } = await import('node:sqlite')
  const keep = Math.max(0, Math.trunc(options.keep ?? 0))
  const where = 'host_key = ? AND name LIKE ?'
  const args = [AUTH_COOKIE_HOST, AUTH_COOKIE_PREFIX + '%']

  const db = new DatabaseSync(dbPath)
  try {
    const rows = db
      .prepare(`SELECT name FROM cookies WHERE ${where}`)
      .all(...args) as Array<{ name: string }>
    const before = rows.length
    if (before <= keep) return { before, after: before }

    let backup: string | undefined
    if (options.backup !== false) {
      const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
      backup = `${dbPath}.bak-steward-${stamp}`
      copyFileSync(dbPath, backup)
    }

    // 保留按名字排序的最后 keep 枚：名字是随机的，排序没有语义，
    // 但 keep>0 只用于「测试后马上要再用一次」的场景，留哪枚都不影响正确性。
    const doomed = rows.map((row) => row.name).sort().slice(0, before - keep)
    const remove = db.prepare(`DELETE FROM cookies WHERE ${where} AND name = ?`)
    db.exec('BEGIN')
    try {
      for (const name of doomed) remove.run(...args, name)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    db.exec('VACUUM')

    return { before, after: before - doomed.length, ...(backup === undefined ? {} : { backup }) }
  } finally {
    db.close()
  }
}
