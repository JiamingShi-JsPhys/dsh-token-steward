/**
 * model_pool.yaml loading, example seeding and hot reload.
 *
 * IO is async; reload failures keep the previous pool (fail-closed) and are
 * reported through the reload callback.
 *
 * @module host/pool-file
 */
import { watch, type FSWatcher } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parse as parseYamlText } from 'yaml'
import { normalizePool, type NormalizeResult } from '../core/pool.ts'
import type { ModelPool } from '../core/types.ts'

export const EXAMPLE_POOL_YAML = `# ====================================================================
# dsh-umbra-budget · 模型矩阵定义
# 修改保存后自动热重载；校验失败整体拒绝并保留旧池（fail-closed）。
# 密钥绝不写明文：一律 api_key_ref: env:名称，从环境变量解析。
# ====================================================================
version: 1

defaults:
  cost_level: medium
  availability: direct

providers:
  # ---- A 轨：引用 DSH 设置里已配置的 provider（推荐，协议适配交给宿主）----
  deepseek:
    display_name: DeepSeek 官方
    models:
      deepseek-chat:
        tags:
          capabilities: [coding, fast, agent, tool_use]
          cost_level: low
          context_window: 131072
        pricing: { currency: CNY, input: 2.0, output: 8.0, cache_read: 0.5, cache_write: 2.0 }
      deepseek-reasoner:
        tags:
          capabilities: [reasoning, coding]
          cost_level: medium
          context_window: 131072
        pricing: { currency: CNY, input: 4.0, output: 16.0 }

  # ---- B 轨：直连任意 OpenAI 兼容端点（免费源/镜像源）----
  school:
    display_name: 学校免费源
    models:
      glm-4-flash:
        tags:
          capabilities: [fast, agent]
          cost_level: free
          context_window: 128000
        endpoint: https://school-mirror.example/v1
        api_key_ref: env:SCHOOL_MIRROR_KEY

routing:
  mode: frugal                # frugal | efficiency | max_power
  classifier:
    trivial_max_chars: 2000
    heavy_min_chars: 60000
    heavy_tools: true
  fallback:
    max_retries: 2
    cooldown_ms: 30000
    rate_limit_429_ms: 60000
  scatter:
    efficiency_min_inflight: 2
  cache:
    exact_match: false
`

export interface PoolLoadResult extends NormalizeResult {
  readonly path: string
}

export async function loadPoolFile(path: string, env: Readonly<Record<string, string | undefined>>): Promise<PoolLoadResult> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    return { path, errors: [`无法读取 ${path}: ${error instanceof Error ? error.message : String(error)}`] }
  }
  let value: unknown
  try {
    value = parseYamlText(text)
  } catch (error) {
    return { path, errors: [`model_pool.yaml 解析失败: ${error instanceof Error ? error.message : String(error)}`] }
  }
  const result = normalizePool(value, env)
  return { path, ...result }
}

export async function ensureExamplePool(path: string): Promise<boolean> {
  try {
    await readFile(path, 'utf8')
    return false
  } catch {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, EXAMPLE_POOL_YAML, 'utf8')
    return true
  }
}

export interface PoolWatcher {
  stop(): void
}

/**
 * Watch the pool file for edits (fs.watch on the parent directory — files are
 * often replaced atomically by editors). Debounced; fires only on content mtime change.
 */
export function watchPoolFile(path: string, onChange: () => void, debounceMs = 500): PoolWatcher {
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastStamp = 0
  let watcher: FSWatcher | undefined
  const dir = dirname(path)
  try {
    watcher = watch(dir, { persistent: false }, (_event, filename) => {
      if (filename !== undefined && !path.endsWith(String(filename))) return
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => {
        void (async () => {
          try {
            const info = await stat(path)
            const stamp = info.mtimeMs
            if (stamp === lastStamp) return
            lastStamp = stamp
          } catch {
            /* file may be mid-replace; still fire */
          }
          onChange()
        })()
      }, debounceMs)
    })
  } catch {
    return { stop: () => {} }
  }
  return {
    stop() {
      if (timer !== undefined) clearTimeout(timer)
      watcher?.close()
    },
  }
}
