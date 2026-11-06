/**
 * model_pool.yaml 的文件层：读、解码、校验、热重载。
 *
 * 与 core/pool-schema.ts 的分工：那边是纯校验，这边只做 IO 与状态持有。
 * 一条硬规则沿用配置层的语义——**任何一次失败都保留上一次有效的矩阵**，
 * 并在状态里留下可读的错误行，绝不因为一次手滑保存就把路由清空。
 *
 * 解码器由调用方注入（宿主机自带 yaml，见 M0 探针 3），因此本模块
 * 不依赖任何第三方包，测试时传一个极简解码器即可。
 */
import { readFileIfExists, quarantineFile } from './atomic-file.ts'
import { parsePool, type PoolDiagnostic, type PoolParseResult } from '../core/pool-schema.ts'
import type { PoolConfig } from '../core/types.ts'

/** YAML 解码器：接收文本，返回普通对象；解析失败应抛错。 */
export type YamlDecoder = (text: string) => unknown

/** 配置加载状态；面板直接消费这个形状。 */
export interface PoolLoadState {
  status: 'ok' | 'rejected' | 'loading'
  /** 配置来源路径，面板显示用。 */
  source: string
  /** rejected 时的可读原因（第一条诊断 + 计数）。 */
  error?: string
  /** rejected 时的全部诊断，供设置页展开。 */
  diagnostics?: PoolDiagnostic[]
  /** 最近一次成功加载的时刻。 */
  loadedAt?: number
}

/** 一次加载的结果。 */
export interface PoolLoadResult {
  /** 本次是否拿到了可用配置。false 时 config 是上一次的有效配置。 */
  ok: boolean
  /** 当前生效的配置；从未成功过时为 undefined。 */
  config: PoolConfig | undefined
  state: PoolLoadState
  warnings: string[]
}

/** 把诊断压成一行可读的错误，面板顶部横幅用。 */
export function summarizeDiagnostics(diagnostics: PoolDiagnostic[]): string {
  if (diagnostics.length === 0) return 'invalid configuration'
  const first = diagnostics[0] as PoolDiagnostic
  const head = first.path + ': ' + first.message
  return diagnostics.length === 1 ? head : head + ' (+' + String(diagnostics.length - 1) + ' more)'
}

/** 配置持有者：读文件、保持上一次有效配置、给出状态。 */
export interface PoolFileLoader {
  /** 读一次文件并应用；失败时保留旧配置。 */
  load(now: number): Promise<PoolLoadResult>
  /** 当前生效配置（可能为 undefined）。 */
  current(): PoolConfig | undefined
  /** 当前加载状态。 */
  state(): PoolLoadState
  /** 最近一次成功加载的警告（未定价、全 offline 之类）。 */
  warnings(): string[]
}

/**
 * 建一个配置持有者。
 * @param path - model_pool.yaml 的绝对路径。
 * @param decode - YAML 解码器。
 * @param now - 首次状态的时间戳（避免读时钟）。
 */
export function createPoolFileLoader(path: string, decode: YamlDecoder): PoolFileLoader {
  let config: PoolConfig | undefined
  let warnings: string[] = []
  let state: PoolLoadState = { status: 'loading', source: path }

  async function load(now: number): Promise<PoolLoadResult> {
    let text: string | undefined
    try {
      text = await readFileIfExists(path)
    } catch (error) {
      state = {
        status: 'rejected',
        source: path,
        error: 'cannot read ' + path + ': ' + messageOf(error),
        ...(state.loadedAt === undefined ? {} : { loadedAt: state.loadedAt }),
      }
      return { ok: false, config, state, warnings }
    }

    if (text === undefined) {
      state = { status: 'rejected', source: path, error: 'not found: ' + path }
      return { ok: false, config, state, warnings }
    }

    const applied = apply(text, now)
    return applied
  }

  /** 把一段文本当作配置应用；热重载与首次加载共用这一条路径。 */
  function apply(text: string, now: number): PoolLoadResult {
    let decoded: unknown
    try {
      decoded = decode(text)
    } catch (error) {
      state = {
        status: 'rejected',
        source: path,
        error: 'YAML: ' + messageOf(error),
        ...(state.loadedAt === undefined ? {} : { loadedAt: state.loadedAt }),
      }
      return { ok: false, config, state, warnings }
    }

    const parsed: PoolParseResult = parsePool(decoded)
    if (!parsed.ok) {
      state = {
        status: 'rejected',
        source: path,
        error: summarizeDiagnostics(parsed.diagnostics),
        diagnostics: parsed.diagnostics,
        ...(state.loadedAt === undefined ? {} : { loadedAt: state.loadedAt }),
      }
      return { ok: false, config, state, warnings }
    }

    config = parsed.config
    warnings = parsed.warnings
    state = { status: 'ok', source: path, loadedAt: now }
    return { ok: true, config, state, warnings }
  }

  return {
    load,
    current: () => config,
    state: () => state,
    warnings: () => warnings,
  }
}

/** 把无法解析的配置文件挪到旁边留档，并返回隔离路径。 */
export async function quarantinePoolFile(path: string, now: number): Promise<string> {
  return quarantineFile(path, now)
}

/** 从 unknown 里取可读消息。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
