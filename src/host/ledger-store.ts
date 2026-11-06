/**
 * 路由台账的持久化。
 *
 * 三件事：异步加载（坏文件隔离而不是删除）、去抖落盘、按保留期抽稀。
 * 落盘走 atomic-file 的 rename 语义，因此进程被杀也不会留下半截 JSON。
 *
 * 内存中的文档是唯一真相源；磁盘只是它的镜像。所有写操作都是「改内存 +
 * 排一次后台 flush」，因此调用方（网关热路径）永远不需要 await 磁盘。
 */
import { join } from 'node:path'
import { readFileIfExists, writeFileAtomic, quarantineFile } from './atomic-file.ts'
import {
  createLedgerDocument,
  deserializeLedger,
  foldEvent,
  foldUsage,
  localDateKey,
  pruneLedger,
  type RouteLedgerDocument,
} from '../core/ledger-doc.ts'
import type { RouteEventView, TokenUsage } from '../core/types.ts'

/** 落盘去抖窗口：一次请求可能连写多次，合并成一次磁盘写。 */
export const FLUSH_DEBOUNCE_MS = 1_000

/** 保留期上限，与 dsh-usage 的默认值对齐。 */
export const DEFAULT_RETAIN_DAYS = 180

/** 台账存储的可注入时钟与定时器（测试不等真实时间）。 */
export interface LedgerClock {
  now(): number
  /** 排一次延时回调；返回取消函数。 */
  schedule(delayMs: number, run: () => void): () => void
}

/** 系统时钟：真实 setTimeout。 */
export const systemClock: LedgerClock = {
  now: () => Date.now(),
  schedule: (delayMs, run) => {
    const timer = setTimeout(run, delayMs)
    // 挂起的 flush 不该拖住宿主退出。
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      ;(timer as { unref: () => void }).unref()
    }
    return () => { clearTimeout(timer) }
  },
}

/** 台账存储。 */
export interface RouteLedgerStore {
  /** 从磁盘加载（首次启动时文件不存在是正常状态）。 */
  load(): Promise<void>
  /** 记一条已收口的路由事件。 */
  record(event: RouteEventView): void
  /** 记一次上游 usage（来自网关拿到的真实 token）。 */
  recordUsage(provider: string, model: string, usage: TokenUsage): void
  /** 立刻落盘（卸载、宿主退出前调用）。 */
  flush(): Promise<void>
  /** 读内存文档（只读用途：面板、测试）。 */
  document(): RouteLedgerDocument
  /** 某天的台账。 */
  day(dateKey: string): ReturnType<typeof createLedgerDocument>['days'][string] | undefined
  /** 是否有未落盘的改动。 */
  dirty(): boolean
  /** 加载或落盘时遇到的最后一次错误（面板可展示）。 */
  lastError(): string | undefined
}

/**
 * 建一个台账存储。
 * @param directory - $DSH_HOME/umbra-budget 目录。
 * @param clock - 可注入时钟。
 * @param retainDays - 保留天数。
 */
export function createRouteLedgerStore(
  directory: string,
  clock: LedgerClock = systemClock,
  retainDays: number = DEFAULT_RETAIN_DAYS,
): RouteLedgerStore {
  const path = join(directory, 'route-ledger.json')
  let document: RouteLedgerDocument = createLedgerDocument()
  let dirty = false
  let error: string | undefined
  let cancelPending: (() => void) | undefined
  let inflight: Promise<void> | undefined

  function markDirty(): void {
    dirty = true
    if (cancelPending !== undefined) return
    cancelPending = clock.schedule(FLUSH_DEBOUNCE_MS, () => {
      cancelPending = undefined
      void flush()
    })
  }

  async function flush(): Promise<void> {
    if (cancelPending !== undefined) {
      cancelPending()
      cancelPending = undefined
    }
    // 没有待写内容时也要等掉正在进行的那一次写：flush 的合同是「回来时数据已落盘」。
    if (!dirty) {
      if (inflight !== undefined) await inflight
      return
    }
    // 串行化：上一次写还没结束时，新的 flush 排在它后面。
    if (inflight !== undefined) {
      await inflight
      if (!dirty) return
    }
    dirty = false
    const snapshot = JSON.stringify(document)
    inflight = writeFileAtomic(path, snapshot + '\n')
      .catch((writeError: unknown) => {
        dirty = true
        error = 'flush failed: ' + messageOf(writeError)
      })
      .finally(() => { inflight = undefined })
    await inflight
  }

  async function load(): Promise<void> {
    let text: string | undefined
    try {
      text = await readFileIfExists(path)
    } catch (readError) {
      error = 'cannot read route ledger: ' + messageOf(readError)
      return
    }
    if (text === undefined) {
      document = createLedgerDocument()
      return
    }
    try {
      document = deserializeLedger(JSON.parse(text))
    } catch (parseError) {
      // 结构坏到无法修复：隔离留档，从空台账重来，并让面板能说出发生了什么。
      error = 'route ledger unreadable: ' + messageOf(parseError)
      try {
        const moved = await quarantineFile(path, clock.now())
        error = error + ' (moved to ' + moved + ')'
      } catch {
        // 隔离失败不该阻止插件启动。
      }
      document = createLedgerDocument()
    }
    const removed = pruneLedger(document, localDateKey(clock.now()), retainDays)
    if (removed.length > 0) markDirty()
  }

  function record(event: RouteEventView): void {
    foldEvent(document, event, localDateKey(event.at))
    markDirty()
  }

  function recordUsage(provider: string, model: string, usage: TokenUsage): void {
    foldUsage(document, provider + '/' + model, localDateKey(clock.now()), usage)
    markDirty()
  }

  return {
    load,
    record,
    recordUsage,
    flush,
    document: () => document,
    day: (dateKey) => document.days[dateKey],
    dirty: () => dirty,
    lastError: () => error,
  }
}

/** 从 unknown 里取可读消息。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
