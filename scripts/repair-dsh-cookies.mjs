#!/usr/bin/env node
/**
 * 离线清理 DSH 桌面版堆积的网页会话 Cookie。
 *
 * 症状：DSH 打不开，提示「应用无法启动或已意外停止 / desktop welcome: Web authentication failed」。
 * 原因：宿主每次启动下发一枚新的 `dsh-auth-<随机>` Cookie 且从不回收旧的，攒到 70 枚左右
 *       请求头超过 16 KB，宿主对带凭证的请求一律回 431。
 * 做法：**先完全退出 DSH**（Chromium 运行期间独占 Cookies 文件），再运行本脚本。
 *
 *   node scripts/repair-dsh-cookies.mjs            # 全清（推荐）
 *   node scripts/repair-dsh-cookies.mjs --keep 1   # 保留 1 枚
 *   node scripts/repair-dsh-cookies.mjs --db <路径> # 指定 Cookies 库
 */
import { existsSync } from 'node:fs'
import { defaultCookieDbPath, pruneAuthCookiesFile } from '../src/host/auth-cookies.ts'

const argv = process.argv.slice(2)

function flag(name) {
  const index = argv.indexOf(name)
  if (index < 0) return undefined
  const value = argv[index + 1]
  return value === undefined || value.startsWith('--') ? '' : value
}

const quiet = argv.includes('--quiet')
const dbPath = flag('--db') || defaultCookieDbPath()
const keep = Number.parseInt(flag('--keep') ?? '0', 10)

if (dbPath === undefined) {
  console.error('找不到 Cookies 库：没有 APPDATA（本脚本只面向 Windows 桌面版 DSH）')
  process.exit(2)
}
if (!existsSync(dbPath)) {
  console.error('找不到 Cookies 库：' + dbPath)
  console.error('如果 DSH 还没登录过网页界面，这个文件本来就不存在，无需清理。')
  process.exit(2)
}

try {
  const result = await pruneAuthCookiesFile(dbPath, { keep: Number.isNaN(keep) ? 0 : keep })
  if (result === undefined) {
    console.error('没有可清理的内容：' + dbPath)
    process.exit(2)
  }
  if (quiet) {
    if (result.before !== result.after) {
      console.log(`会话 Cookie ${String(result.before)} → ${String(result.after)}`)
    }
  } else {
    console.log('Cookies 库：' + dbPath)
    console.log(`会话 Cookie（dsh-auth-*）：${String(result.before)} → ${String(result.after)}`)
    if (result.backup !== undefined) console.log('备份：' + result.backup)
    if (result.before === result.after) {
      console.log('已经是干净的，DSH 可以直接启动。')
    } else {
      console.log('完成。现在重新打开 DSH 即可（首次启动会重新下发一枚会话 Cookie）。')
    }
  }
  process.exit(0)
} catch (error) {
  const message = String(error && error.message ? error.message : error)
  if (/EBUSY|busy|locked|unable to open|SQLITE_BUSY|SQLITE_CANTOPEN/iu.test(message)) {
    console.error('打不开 Cookies 库——DSH 很可能还在运行。')
    console.error('请先完全退出 DSH（托盘图标也要退出），再运行本脚本。')
  } else {
    console.error('清理失败：' + message)
  }
  process.exit(1)
}
