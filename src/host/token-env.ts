/**
 * 把本地令牌同步回操作系统的用户环境变量。
 *
 * 为什么需要：DSH 的 `llm-pi-ai` 可能在插件挂载之前就读 `apiKeyEnv`，那时
 * 进程里只有从系统继承的值。插件在进程内写 `process.env` 只对「本次启动」
 * 有效；下次从开始菜单直接启动时，继承的还是系统里那份。只要它与网关令牌
 * 漂移过一次，就会出现「API 密钥无效 AUTH」。
 *
 * 现已有的两道保障：
 *  1. 网关启动时优先采用继承来的合法令牌（resolveStartupToken）；
 *  2. 漂移窗口内网关同时接受旧持久化令牌。
 * 这里补第三道：把当前令牌写回用户环境变量，让「下次启动继承什么」也永远
 * 正确——两个方向都对齐，漂移不可能再发生。
 *
 * 只处理 Windows（HKCU\Environment）。其它平台的环境变量由启动器或用户 shell
 * 管理，插件不越界改写用户的 rc 文件。
 */
import { execFile } from 'node:child_process'

/** 可注入的依赖（测试用）。 */
export interface TokenEnvDeps {
  platform?: NodeJS.Platform
  /** 写一个用户级环境变量（默认 reg add HKCU\Environment）。 */
  write?(name: string, value: string): Promise<void> | void
}

/** 默认写入器：reg add 不经过 shell，令牌是一个参数，不会被再次解释。 */
function writeWithReg(name: string, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'reg',
      ['add', 'HKCU\\Environment', '/v', name, '/t', 'REG_SZ', '/d', value, '/f'],
      { windowsHide: true },
      (error) => {
        if (error === null) resolve()
        else reject(error)
      },
    )
  })
}

/**
 * 把令牌写进用户环境变量。
 * @returns 是否真的写入成功（非 Windows、写入失败都是 false——调用方只记日志）。
 */
export async function persistUserTokenEnv(
  token: string,
  name: string,
  deps: TokenEnvDeps = {},
): Promise<boolean> {
  const platform = deps.platform ?? process.platform
  if (platform !== 'win32') return false
  const write = deps.write ?? writeWithReg
  try {
    await write(name, token)
    return true
  } catch {
    return false
  }
}
