/**
 * 配置热重载。
 *
 * 一条纪律：**编辑器保存不是一次事件，是一串事件**。VS Code 的「临时文件 + rename」
 * 会先给出 rename、再给出 change，Vim 会给出 rename 后重建。因此这里用去抖，
 * 并且只在内容真的变化时才通知（比对文件字节，而不是相信事件类型）。
 *
 * 监听失败不算致命：拿不到 watch 就退化成「只在启动时读一次」，路由照常工作。
 */
import { readFileSync, watch, type FSWatcher } from 'node:fs'
import { readFile } from 'node:fs/promises'

/** 去抖窗口：编辑器一次保存引发的一串事件合并成一次重载。 */
export const RELOAD_DEBOUNCE_MS = 250

/** 热重载监听器的可注入定时器（测试不用等真实时间）。 */
export interface WatchTimers {
  schedule(delayMs: number, run: () => void): () => void
}

/** 系统定时器。 */
export const systemTimers: WatchTimers = {
  schedule: (delayMs, run) => {
    const timer = setTimeout(run, delayMs)
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      ;(timer as { unref: () => void }).unref()
    }
    return () => { clearTimeout(timer) }
  },
}

/** 一个配置监视器。 */
export interface PoolWatcher {
  /** 开始监视；已存在时无操作。 */
  start(): void
  /** 停止监视并释放所有资源。 */
  stop(): void
  /** 是否正在监视（拿不到 watch 时为 false）。 */
  active(): boolean
  /** 最近一次通知的重载原因，测试与日志用。 */
  lastReason(): string | undefined
}

/** 监视失败时的处理：日志一行即可，功能退化为「只在启动时读一次」。 */
export type WatchFailureReporter = (message: string) => void

/**
 * 建一个配置监视器。
 * @param path - 被监视的文件。
 * @param onChange - 内容真的变化时调用（参数是触发原因）。
 * @param report - 无法监视时的诊断出口。
 * @param timers - 可注入定时器。
 */
export function createPoolWatcher(
  path: string,
  onChange: (reason: string) => void,
  report: WatchFailureReporter = () => {},
  timers: WatchTimers = systemTimers,
): PoolWatcher {
  let watcher: FSWatcher | undefined
  let cancelPending: (() => void) | undefined
  let lastContent: string | undefined
  let reason: string | undefined
  let stopped = false

  /** 读当前内容；读不到时返回 undefined（文件被删/被改名）。 */
  async function content(): Promise<string | undefined> {
    try {
      return await readFile(path, 'utf8')
    } catch {
      return undefined
    }
  }

  /** 一次去抖后的重载：内容没变就不打扰调用方。 */
  async function reload(trigger: string): Promise<void> {
    if (stopped) return
    const next = await content()
    if (next === undefined) {
      // 保存过程中的瞬时缺失（rename 窗口）不该被当成「配置被删」。
      return
    }
    if (next === lastContent) return
    lastContent = next
    reason = trigger
    onChange(trigger)
  }

  function schedule(trigger: string): void {
    if (stopped) return
    if (cancelPending !== undefined) cancelPending()
    cancelPending = timers.schedule(RELOAD_DEBOUNCE_MS, () => {
      cancelPending = undefined
      void reload(trigger)
    })
  }

  function start(): void {
    if (watcher !== undefined || stopped) return
    // 基线必须同步读：异步读有可能在第一次事件之后才落地，于是把「刚写进去的
    // 新内容」当成基线，第一次保存就被误判成「没变」，热重载整条链路静默失效。
    // 配置文件很小，同步读一次不值得为它冒这个竞态。
    try {
      lastContent = readFileSync(path, 'utf8')
    } catch {
      lastContent = undefined
    }
    try {
      watcher = watch(path, { persistent: false }, (eventType) => {
        schedule(eventType === 'rename' ? 'renamed' : 'changed')
      })
      watcher.on('error', (error) => {
        report('pool watch error: ' + messageOf(error))
      })
    } catch (error) {
      // 父目录不存在等情况：不致命，退化成一次性读取。
      report('cannot watch ' + path + ': ' + messageOf(error))
      watcher = undefined
    }
  }

  function stop(): void {
    stopped = true
    if (cancelPending !== undefined) {
      cancelPending()
      cancelPending = undefined
    }
    if (watcher !== undefined) {
      watcher.close()
      watcher = undefined
    }
  }

  return {
    start,
    stop,
    active: () => watcher !== undefined,
    lastReason: () => reason,
  }
}

/** 从 unknown 里取可读消息。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
