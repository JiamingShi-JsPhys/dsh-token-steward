/**
 * 文件层：原子写、配置加载、台账持久化。
 *
 * 这一层的断言全部围绕「进程被杀、文件被手改坏、保存到一半」三种真实故障，
 * 因为它们是这一层唯一的理由。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  fileExists,
  quarantineFile,
  readFileIfExists,
  writeFileAtomic,
} from '../src/host/atomic-file.ts'
import { createPoolFileLoader } from '../src/host/pool-file.ts'
import { createRouteLedgerStore, type LedgerClock } from '../src/host/ledger-store.ts'
import { createPoolWatcher, type WatchTimers } from '../src/host/pool-watch.ts'
import { deserializeLedger } from '../src/core/ledger-doc.ts'
import type { RouteEventView } from '../src/core/types.ts'

/** 一个临时目录；测试结束即删。 */
async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'steward-test-'))
}

/** 手动推进的时钟：不产生真实等待。 */
function manualClock(start = 1_000_000): LedgerClock & { advance(ms: number): void; run(): void } {
  let current = start
  let pending: { at: number; run: () => void } | undefined
  return {
    now: () => current,
    schedule: (delayMs, run) => {
      const entry = { at: current + delayMs, run }
      pending = entry
      return () => { if (pending === entry) pending = undefined }
    },
    advance(ms) {
      current += ms
    },
    run() {
      const entry = pending
      if (entry === undefined) return
      if (current < entry.at) return
      pending = undefined
      entry.run()
    },
  }
}

/** 有界等待一个条件成立；返回是否在预算内成立。 */
async function waitFor(check: () => boolean | Promise<boolean>, budgetMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    if (await check()) return true
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/**
 * 等去抖回调里的异步 flush 落地。
 * 有界轮询而不是「猜几轮微任务」：文件真的出现就立刻返回，最多等 1 秒。
 */
async function settle(path?: string): Promise<void> {
  const deadline = Date.now() + 1_000
  for (;;) {
    await new Promise((resolve) => setImmediate(resolve))
    if (path === undefined) return
    if (await fileExists(path)) return
    if (Date.now() > deadline) return
  }
}

test('writeFileAtomic 创建目录并写入内容', async () => {
  const dir = await scratch()
  const path = join(dir, 'nested', 'file.json')
  await writeFileAtomic(path, '{"a":1}')
  assert.equal(await readFile(path, 'utf8'), '{"a":1}')
  await rm(dir, { recursive: true, force: true })
})

test('writeFileAtomic 覆盖写不留临时文件', async () => {
  const dir = await scratch()
  const path = join(dir, 'file.json')
  await writeFileAtomic(path, 'first')
  await writeFileAtomic(path, 'second')
  assert.equal(await readFile(path, 'utf8'), 'second')
  const entries = await readdir(dir)
  assert.deepEqual(entries, ['file.json'])
  await rm(dir, { recursive: true, force: true })
})

test('writeFileAtomic 并发写最终只有一个完整内容（不会交错）', async () => {
  const dir = await scratch()
  const path = join(dir, 'file.json')
  const big = 'x'.repeat(50_000)
  await Promise.all([
    writeFileAtomic(path, big + '-a'),
    writeFileAtomic(path, big + '-b'),
    writeFileAtomic(path, big + '-c'),
  ])
  const text = await readFile(path, 'utf8')
  assert.equal(text.length, big.length + 2)
  assert.ok(text.endsWith('-a') || text.endsWith('-b') || text.endsWith('-c'))
  await rm(dir, { recursive: true, force: true })
})

test('readFileIfExists 对不存在的文件返回 undefined 而不是抛错', async () => {
  const dir = await scratch()
  assert.equal(await readFileIfExists(join(dir, 'nope.json')), undefined)
  await rm(dir, { recursive: true, force: true })
})

test('fileExists 报告真实存在性', async () => {
  const dir = await scratch()
  const path = join(dir, 'a.txt')
  assert.equal(await fileExists(path), false)
  await writeFile(path, 'x')
  assert.equal(await fileExists(path), true)
  await rm(dir, { recursive: true, force: true })
})

test('quarantineFile 改名留档而不是删除', async () => {
  const dir = await scratch()
  const path = join(dir, 'broken.json')
  await writeFile(path, 'not json')
  const moved = await quarantineFile(path, Date.UTC(2026, 10, 6, 12, 0, 0))
  assert.ok(moved.includes('corrupt-'))
  assert.equal(await fileExists(path), false)
  assert.equal(await readFile(moved, 'utf8'), 'not json')
  await rm(dir, { recursive: true, force: true })
})

/* ────────────────────────── 配置加载 ────────────────────────── */

/** 极简 YAML 解码器：只为测试用，够读夹具即可。 */
function tinyYaml(text: string): unknown {
  if (text.trim() === 'BROKEN') throw new Error('bad yaml')
  return JSON.parse(text)
}

const VALID_POOL = JSON.stringify({
  providers: [{
    provider_name: 'p1',
    endpoint: 'https://p1.example/v1',
    api: 'openai-completions',
    api_key: 'env:P1_KEY',
    models: [{ id: 'm1', capabilities: ['coding'], cost_level: 'free', context_window: 128000, availability: 'direct', quality_rank: 40 }],
  }],
})

test('配置加载：文件不存在时状态是 rejected 且没有配置', async () => {
  const dir = await scratch()
  const loader = createPoolFileLoader(join(dir, 'model_pool.yaml'), tinyYaml)
  const result = await loader.load(1_000)
  assert.equal(result.ok, false)
  assert.equal(result.config, undefined)
  assert.equal(result.state.status, 'rejected')
  assert.ok((result.state.error ?? '').includes('not found'))
  await rm(dir, { recursive: true, force: true })
})

test('配置加载：合法文件返回配置并记 loadedAt', async () => {
  const dir = await scratch()
  const path = join(dir, 'model_pool.yaml')
  await writeFile(path, VALID_POOL)
  const loader = createPoolFileLoader(path, tinyYaml)
  const result = await loader.load(1_500)
  assert.equal(result.ok, true)
  assert.equal(result.config?.providers[0]?.provider_name, 'p1')
  assert.equal(result.state.status, 'ok')
  assert.equal(result.state.loadedAt, 1_500)
  await rm(dir, { recursive: true, force: true })
})

test('配置加载：YAML 语法错误时保留上一次有效配置', async () => {
  const dir = await scratch()
  const path = join(dir, 'model_pool.yaml')
  await writeFile(path, VALID_POOL)
  const loader = createPoolFileLoader(path, tinyYaml)
  await loader.load(1_000)

  await writeFile(path, 'BROKEN')
  const result = await loader.load(2_000)
  assert.equal(result.ok, false)
  assert.equal(result.config?.providers[0]?.provider_name, 'p1', '上一次有效配置必须还在')
  assert.equal(result.state.status, 'rejected')
  assert.ok((result.state.error ?? '').includes('YAML'))
  assert.equal(loader.current()?.providers[0]?.provider_name, 'p1')
  await rm(dir, { recursive: true, force: true })
})

test('配置加载：schema 非法时保留旧配置并给出全部诊断', async () => {
  const dir = await scratch()
  const path = join(dir, 'model_pool.yaml')
  await writeFile(path, VALID_POOL)
  const loader = createPoolFileLoader(path, tinyYaml)
  await loader.load(1_000)

  await writeFile(path, JSON.stringify({ providers: [] }))
  const result = await loader.load(2_000)
  assert.equal(result.ok, false)
  assert.equal(result.state.status, 'rejected')
  assert.equal(result.state.diagnostics?.[0]?.path, 'providers')
  assert.ok((result.state.error ?? '').includes('providers'))
  await rm(dir, { recursive: true, force: true })
})

test('配置加载：修复后重新变回 ok', async () => {
  const dir = await scratch()
  const path = join(dir, 'model_pool.yaml')
  await writeFile(path, JSON.stringify({ providers: [] }))
  const loader = createPoolFileLoader(path, tinyYaml)
  assert.equal((await loader.load(1_000)).ok, false)

  await writeFile(path, VALID_POOL)
  const result = await loader.load(2_000)
  assert.equal(result.ok, true)
  assert.equal(result.state.status, 'ok')
  assert.equal(result.state.diagnostics, undefined)
  await rm(dir, { recursive: true, force: true })
})

test('配置加载：warnings 透传（未定价模型）', async () => {
  const dir = await scratch()
  const path = join(dir, 'model_pool.yaml')
  await writeFile(path, VALID_POOL)
  const loader = createPoolFileLoader(path, tinyYaml)
  const result = await loader.load(1_000)
  assert.ok(result.warnings.some((line) => line.includes('未定价')))
  assert.deepEqual(loader.warnings(), result.warnings)
  await rm(dir, { recursive: true, force: true })
})

/* ────────────────────────── 台账持久化 ────────────────────────── */

function event(overrides: Partial<RouteEventView> = {}): RouteEventView {
  return {
    at: overrides.at ?? Date.UTC(2026, 10, 6, 12, 0, 0),
    requestId: overrides.requestId ?? 'r1',
    mode: overrides.mode ?? 'frugal',
    provider: overrides.provider ?? 'p1',
    model: overrides.model ?? 'm1',
    degradedFrom: overrides.degradedFrom ?? [],
    ok: overrides.ok ?? true,
    latencyMs: overrides.latencyMs ?? 100,
    committed: overrides.committed ?? false,
  }
}

test('台账：首次加载没有文件时是空文档', async () => {
  const dir = await scratch()
  const store = createRouteLedgerStore(dir)
  await store.load()
  assert.deepEqual(store.document().days, {})
  assert.equal(store.lastError(), undefined)
  await rm(dir, { recursive: true, force: true })
})

test('台账：record 后去抖落盘，落盘内容可被反序列化', async () => {
  const dir = await scratch()
  const clock = manualClock(Date.UTC(2026, 10, 6, 12, 0, 0))
  const store = createRouteLedgerStore(dir, clock)
  await store.load()
  store.record(event())
  assert.equal(store.dirty(), true)

  clock.advance(1_000)
  clock.run()
  await store.flush()

  const text = await readFile(join(dir, 'route-ledger.json'), 'utf8')
  const revived = deserializeLedger(JSON.parse(text))
  assert.equal(revived.days['2026-11-06']?.requests, 1)
  await rm(dir, { recursive: true, force: true })
})

test('台账：多次 record 合并成一次落盘', async () => {
  const dir = await scratch()
  const clock = manualClock(Date.UTC(2026, 10, 6, 12, 0, 0))
  const store = createRouteLedgerStore(dir, clock)
  await store.load()
  store.record(event({ requestId: 'r1' }))
  store.record(event({ requestId: 'r2' }))
  store.record(event({ requestId: 'r3' }))
  clock.advance(1_000)
  clock.run()
  await store.flush()

  const text = await readFile(join(dir, 'route-ledger.json'), 'utf8')
  assert.equal(deserializeLedger(JSON.parse(text)).days['2026-11-06']?.requests, 3)
  await rm(dir, { recursive: true, force: true })
})

test('台账：flush 立刻落盘，不等去抖', async () => {
  const dir = await scratch()
  const clock = manualClock(Date.UTC(2026, 10, 6, 12, 0, 0))
  const store = createRouteLedgerStore(dir, clock)
  await store.load()
  store.record(event())
  await store.flush()
  assert.equal(store.dirty(), false)
  assert.equal(await fileExists(join(dir, 'route-ledger.json')), true)
  await rm(dir, { recursive: true, force: true })
})

test('台账：重启后读回历史', async () => {
  const dir = await scratch()
  const clock = manualClock(Date.UTC(2026, 10, 6, 12, 0, 0))
  const first = createRouteLedgerStore(dir, clock)
  await first.load()
  first.record(event())
  await first.flush()

  const second = createRouteLedgerStore(dir, clock)
  await second.load()
  assert.equal(second.document().days['2026-11-06']?.requests, 1)
  await rm(dir, { recursive: true, force: true })
})

test('台账：损坏的 JSON 被隔离留档，插件照常启动', async () => {
  const dir = await scratch()
  await writeFile(join(dir, 'route-ledger.json'), 'this is not json')
  const store = createRouteLedgerStore(dir, manualClock(Date.UTC(2026, 10, 6, 12, 0, 0)))
  await store.load()
  assert.deepEqual(store.document().days, {})
  assert.ok((store.lastError() ?? '').includes('unreadable'))
  const files = await readdir(dir)
  assert.ok(files.some((name) => name.includes('corrupt-')), 'files: ' + files.join(', '))
  await rm(dir, { recursive: true, force: true })
})

test('台账：未知版本同样隔离，而不是静默当成空台账', async () => {
  const dir = await scratch()
  await writeFile(join(dir, 'route-ledger.json'), JSON.stringify({ version: 99, days: {} }))
  const store = createRouteLedgerStore(dir, manualClock(Date.UTC(2026, 10, 6, 12, 0, 0)))
  await store.load()
  assert.ok((store.lastError() ?? '').includes('unreadable'))
  await rm(dir, { recursive: true, force: true })
})

test('台账：加载时按保留期抽稀旧日子', async () => {
  const dir = await scratch()
  const today = new Date(2026, 10, 6, 12, 0, 0).getTime()
  await writeFile(join(dir, 'route-ledger.json'), JSON.stringify({
    version: 1,
    days: {
      '2026-11-06': { models: {}, modes: {}, degraded: 0, requests: 1 },
      '2020-01-01': { models: {}, modes: {}, degraded: 0, requests: 9 },
    },
  }))
  const store = createRouteLedgerStore(dir, manualClock(today), 30)
  await store.load()
  assert.deepEqual(Object.keys(store.document().days), ['2026-11-06'])
  await rm(dir, { recursive: true, force: true })
})

test('台账：recordUsage 累加真实 token 并落到当天', async () => {
  const dir = await scratch()
  const clock = manualClock(Date.UTC(2026, 10, 6, 12, 0, 0))
  const store = createRouteLedgerStore(dir, clock)
  await store.load()
  store.recordUsage('p1', 'm1', { input: 10, output: 5, cacheRead: 2, cacheWrite: 0, reasoning: 1 })
  store.recordUsage('p1', 'm1', { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 })
  await store.flush()
  const day = store.day('2026-11-06')
  assert.equal(day?.models['p1/m1']?.usage.input, 11)
  assert.equal(day?.models['p1/m1']?.usage.output, 6)
  await rm(dir, { recursive: true, force: true })
})

test('台账：day() 对不存在的日期返回 undefined', async () => {
  const dir = await scratch()
  const store = createRouteLedgerStore(dir, manualClock())
  await store.load()
  assert.equal(store.day('1999-01-01'), undefined)
  await rm(dir, { recursive: true, force: true })
})

/* ────────────────────────── 去抖的真实行为 ────────────────────────── */

test('台账：去抖回调自己到点就会落盘，不需要外部调用 flush', async () => {
  const dir = await scratch()
  let pending: (() => void) | undefined
  const clock: LedgerClock = {
    now: () => Date.UTC(2026, 10, 6, 12, 0, 0),
    schedule: (_delayMs, run) => {
      pending = run
      return () => { pending = undefined }
    },
  }
  const store = createRouteLedgerStore(dir, clock)
  await store.load()
  store.record(event())

  assert.ok(pending !== undefined, 'record 必须排一次去抖落盘')
  pending()
  await settle(join(dir, 'route-ledger.json'))

  assert.equal(await fileExists(join(dir, 'route-ledger.json')), true)
  await rm(dir, { recursive: true, force: true })
})

test('台账：flush 会取消还没触发的去抖，不重复写', async () => {
  const dir = await scratch()
  let scheduled = 0
  let cancelled = 0
  let pending: (() => void) | undefined
  const clock: LedgerClock = {
    now: () => Date.UTC(2026, 10, 6, 12, 0, 0),
    schedule: (_delayMs, run) => {
      scheduled += 1
      pending = run
      return () => { cancelled += 1; pending = undefined }
    },
  }
  const store = createRouteLedgerStore(dir, clock)
  await store.load()
  store.record(event())
  assert.equal(scheduled, 1)

  await store.flush()
  assert.equal(cancelled, 1)
  assert.equal(pending, undefined)
  await rm(dir, { recursive: true, force: true })
})

test('台账：落盘失败时保留 dirty，下次还会再试', async () => {
  const dir = await scratch()
  const store = createRouteLedgerStore(dir, manualClock(Date.UTC(2026, 10, 6, 12, 0, 0)))
  await store.load()
  store.record(event())

  // 把目录换成一个同名文件，让 writeFileAtomic 无法创建目录。
  await rm(dir, { recursive: true, force: true })
  await writeFile(dir, 'blocker')
  await store.flush()
  assert.equal(store.dirty(), true)
  assert.ok((store.lastError() ?? '').includes('flush failed'))
  await rm(dir, { force: true })
})

/* ────────────────────────── 热重载 ────────────────────────── */

/** 可手动触发的定时器：测试不等真实去抖窗口。 */
function manualTimers(): { timers: WatchTimers; fire(): void; pending(): boolean } {
  let entry: (() => void) | undefined
  return {
    timers: {
      schedule: (_delayMs, run) => {
        entry = run
        return () => { entry = undefined }
      },
    },
    fire() {
      const run = entry
      entry = undefined
      run?.()
    },
    pending: () => entry !== undefined,
  }
}

test('热重载：一次保存引发的事件被去抖合并，只重载一次', async () => {
  const dir = await scratch()
  const path = join(dir, 'model_pool.yaml')
  await writeFile(path, 'v1')
  const clock = manualTimers()
  let calls = 0
  const watcher = createPoolWatcher(path, () => { calls += 1 }, () => {}, clock.timers)
  watcher.start()
  // 等初始内容读完，否则第一次比较没有基线。
  await waitFor(async () => true)

  await writeFile(path, 'v2')
  // fs.watch 的事件何时到达由操作系统决定，这里等它真的把去抖排上。
  const scheduled = await waitFor(() => clock.pending())
  assert.equal(scheduled, true, 'fs.watch 应当把一次重载排进去抖')

  clock.fire()
  await waitFor(async () => calls > 0)

  assert.equal(calls, 1)
  watcher.stop()
  await rm(dir, { recursive: true, force: true })
})

test('热重载：内容没变时不通知调用方', async () => {
  const dir = await scratch()
  const path = join(dir, 'model_pool.yaml')
  await writeFile(path, 'same')
  const clock = manualTimers()
  let calls = 0
  const watcher = createPoolWatcher(path, () => { calls += 1 }, () => {}, clock.timers)
  watcher.start()
  await new Promise((resolve) => setTimeout(resolve, 20))

  clock.fire()
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(calls, 0, '内容相同不该触发重载')
  watcher.stop()
  await rm(dir, { recursive: true, force: true })
})

test('热重载：文件在保存窗口中瞬时缺失时不报「配置被删」', async () => {
  const dir = await scratch()
  const path = join(dir, 'model_pool.yaml')
  await writeFile(path, 'v1')
  const clock = manualTimers()
  let calls = 0
  const watcher = createPoolWatcher(path, () => { calls += 1 }, () => {}, clock.timers)
  watcher.start()
  await new Promise((resolve) => setTimeout(resolve, 20))

  await rm(path)
  clock.fire()
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(calls, 0)
  watcher.stop()
  await rm(dir, { recursive: true, force: true })
})

test('热重载：无法监视时报告一行诊断且不抛错', () => {
  const clock = manualTimers()
  const reports: string[] = []
  const watcher = createPoolWatcher(
    join(tmpdir(), 'steward-does-not-exist', 'model_pool.yaml'),
    () => {},
    (message) => reports.push(message),
    clock.timers,
  )
  watcher.start()
  assert.equal(watcher.active(), false)
  assert.equal(reports.length, 1)
  assert.ok(reports[0]?.includes('cannot watch'))
  watcher.stop()
})

test('热重载：stop 之后不再排新的重载', async () => {
  const dir = await scratch()
  const path = join(dir, 'model_pool.yaml')
  await writeFile(path, 'v1')
  const clock = manualTimers()
  let calls = 0
  const watcher = createPoolWatcher(path, () => { calls += 1 }, () => {}, clock.timers)
  watcher.start()
  watcher.stop()
  assert.equal(watcher.active(), false)
  clock.fire()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 0)
  await rm(dir, { recursive: true, force: true })
})