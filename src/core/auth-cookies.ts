/**
 * 网页会话认证 Cookie：纯判定部分（不碰文件系统，客户端与服务端共用）。
 *
 * 宿主每次启动下发一枚新名字的 `dsh-auth-<随机>` Cookie，且从不回收旧的；
 * 累计到 70 枚左右时请求头越过 Node 默认 16 KB 上限，宿主回 431，
 * 桌面端随即报 `desktop welcome: Web authentication failed`。
 * 这里只负责「数出来」与「什么时候该提醒」，清理见 host/auth-cookies.ts。
 */

/** 宿主下发的会话 Cookie 名字前缀。 */
export const AUTH_COOKIE_PREFIX = 'dsh-auth-'

/** 建议开始提醒的数量：离头上限还有余量，来得及离线清理。 */
export const AUTH_COOKIE_WARN = 40

/** 距离故障极近的数量：再启动一两次就可能 431。 */
export const AUTH_COOKIE_DANGER = 55

/**
 * 从 Cookie 请求头里数出 `dsh-auth-*` 的数量。
 * @param header - `req.headers.cookie`，形如 `a=1; dsh-auth-xxx=v; b=2`。
 * @returns 会话 Cookie 数量；没有头时是 0。
 */
export function countAuthCookies(header: string | undefined): number {
  if (header === undefined || header === '') return 0
  let count = 0
  for (const pair of header.split(';')) {
    const name = (pair.split('=', 1)[0] ?? '').trim()
    if (name.startsWith(AUTH_COOKIE_PREFIX)) count += 1
  }
  return count
}
