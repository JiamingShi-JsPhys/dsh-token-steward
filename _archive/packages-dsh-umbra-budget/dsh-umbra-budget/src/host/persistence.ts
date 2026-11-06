/**
 * Durable runtime state: ledger persistence (debounced atomic writes) and the
 * small JSON state file (mode / disabled models / diagnostics).
 *
 * @module host/persistence
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { UsageLedger } from '../core/ledger.ts'
import type { ScheduleMode } from '../core/types.ts'
import type { LoggerFace } from './dsh-face.ts'

const FLUSH_DEBOUNCE_MS = 3_000

/** temp-file + rename atomic JSON write. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
}

export async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    const text = await readFile(path, 'utf8')
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

export interface LedgerPersistence {
  readonly ledger: UsageLedger
  /** call after any ledger mutation; coalesces into one flush */
  scheduleFlush(): void
  flushNow(): Promise<void>
  close(): Promise<void>
}

export async function openLedger(stateDir: string, log: LoggerFace, keepDays = 90): Promise<LedgerPersistence> {
  const path = join(stateDir, 'usage-ledger.json')
  const loaded = await readJson<unknown>(path)
  const ledger = UsageLedger.fromJSON(loaded)
  ledger.prune(keepDays, new Date())
  let timer: ReturnType<typeof setTimeout> | undefined
  let flushing = false

  const flush = async (): Promise<void> => {
    if (flushing) return
    flushing = true
    try {
      await mkdir(stateDir, { recursive: true })
      await writeJsonAtomic(path, ledger.toJSON())
    } catch (error) {
      log.warn('umbra-budget: 台账落盘失败: %s', error instanceof Error ? error.message : String(error))
    } finally {
      flushing = false
    }
  }

  return {
    ledger,
    scheduleFlush() {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        void flush()
      }, FLUSH_DEBOUNCE_MS)
    },
    flushNow: flush,
    async close() {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      await flush()
    },
  }
}

export interface RuntimeState {
  mode?: ScheduleMode
  disabledModels?: string[]
  backend?: string
}

export async function readRuntimeState(stateDir: string): Promise<RuntimeState> {
  return (await readJson<RuntimeState>(join(stateDir, 'runtime-state.json'))) ?? {}
}

export async function writeRuntimeState(stateDir: string, state: RuntimeState): Promise<void> {
  await mkdir(stateDir, { recursive: true })
  await writeJsonAtomic(join(stateDir, 'runtime-state.json'), state)
}

/** provider-proxy-style diagnostics file (the Desktop host captures no stdout). */
export async function writeApplyState(stateDir: string, entry: Record<string, unknown>): Promise<void> {
  try {
    await mkdir(stateDir, { recursive: true })
    await writeJsonAtomic(join(stateDir, 'state.json'), {
      appliedAt: new Date().toISOString(),
      pid: process.pid,
      ...entry,
    })
  } catch {
    /* diagnostics are best effort */
  }
}
