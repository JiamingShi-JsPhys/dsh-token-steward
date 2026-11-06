/**
 * dsh-umbra-budget — DSH 模型矩阵调度中枢（host 半区）。
 *
 * 装配三段拦截栈：
 *   L1 路由决策  ctx.on('llm/stream') waterfall + AsyncLocalStorage
 *   L2 请求改写  undici 全局 dispatcher（B 轨端点/鉴权/模型名 + per-model 代理 + 状态回传）
 *   L3 观测台账  流 chunk usage 折叠 + 健康熔断 + 路由日志 + HTTP/SSE 控制面
 *
 * 一切注册都是 effect：ctx.effect 收齐全部清理函数，卸载时恢复原 dispatcher、
 * 停止文件监听、落盘台账。失效配置整体拒绝（fail-closed），绝不阻断宿主。
 *
 * @module dsh-umbra-budget
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Config } from './config.ts'
import { classify, fingerprintOf } from './core/classify.ts'
import { ModelHealth } from './core/health.ts'
import { selectChain } from './core/modes.ts'
import type { ModelPool, PoolModel, RewriteBackend, ScheduleMode, TokenUsageLike } from './core/types.ts'
import { SCHEDULE_MODES } from './core/types.ts'
import type { GenerateOptionsLike, HostContextFace, LlmServiceFace, WebServerFace } from './host/dsh-face.ts'
import { createUmbraDispatcher, type UndiciModuleShape } from './host/dispatcher.ts'
import { FrameBus } from './host/frames.ts'
import { RouteJournal } from './host/journal.ts'
import { ensureExamplePool, loadPoolFile, watchPoolFile } from './host/pool-file.ts'
import { openLedger, readRuntimeState, writeApplyState, writeRuntimeState, type LedgerPersistence, type RuntimeState } from './host/persistence.ts'
import { registerRoutes } from './host/routes.ts'
import { createRouter, healthSnapshots } from './host/router.ts'
import { ResponseCache } from './host/response-cache.ts'
import { SignalHub } from './host/signals.ts'
import type { UmbraAls } from './host/store.ts'

export const name = 'umbra-budget'
export const inject = ['llm']
export { Config }

interface ResolvedConfig {
  enabled: boolean
  mode: ScheduleMode
  poolPath: string
}

/** cordis volatile references arrive as live objects with .get() */
function resolveVolatile<T>(value: unknown): T | undefined {
  return value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function'
    ? (value as { get(): T }).get()
    : (value as T | undefined)
}

function dshHome(): string {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return home
}

export async function apply(ctx: HostContextFace, rawConfig: unknown): Promise<void> {
  const log = ctx.logger('umbra-budget')
  const config = resolveConfig(rawConfig)
  if (!config.enabled) {
    log.info('umbra-budget: enabled=false，宿主流量完全不经矩阵')
    await writeApplyState(join(dshHome(), 'umbra-budget'), { status: 'disabled' })
    return
  }

  const als: UmbraAls = new AsyncLocalStorage()
  const stateDir = join(dshHome(), 'umbra-budget')
  const poolPath = config.poolPath !== '' ? config.poolPath : join(stateDir, 'model_pool.yaml')

  // ---- pool: seed example on first run, load, apply persisted runtime overrides ----
  const seeded = await ensureExamplePool(poolPath)
  if (seeded) log.info('umbra-budget: 已生成示例矩阵 %s — 按需编辑后自动热重载', poolPath)
  let load = await loadPoolFile(poolPath, process.env)
  if (load.pool === undefined) {
    log.error('umbra-budget: model_pool 校验失败，矩阵未生效（fail-closed）：\n%s', load.errors.join('\n'))
  }
  let pool: ModelPool | undefined = load.pool
  const runtimeState = await readRuntimeState(stateDir)
  /** live view of UI-persisted overrides (mode / disabled models) — kept current for hot reloads */
  const runtimeOverrides: RuntimeState = { ...runtimeState }
  if (pool !== undefined && runtimeState.mode !== undefined) pool = withMode(pool, runtimeState.mode)
  if (pool !== undefined && runtimeState.disabledModels !== undefined) pool = withDisabled(pool, runtimeState.disabledModels)

  // ---- services ----
  const health = new Map<string, ModelHealth>()
  const journal = new RouteJournal(50)
  const signalHub = new SignalHub()
  const bus = new FrameBus()
  const responseCache = new ResponseCache()
  const persistence = await openLedger(stateDir, log)
  const ledger = persistence.ledger
  syncHealth(health, pool)

  let currentPool = pool
  const getState = () => ({ pool: currentPool, health, ledger, journal, signals: signalHub, cache: responseCache })

  const events = {
    onCooldown: (modelId: string) => {
      bus.publish('cooldown', { modelId })
    },
    onRecovery: (modelId: string) => {
      bus.publish('recovery', { modelId })
    },
  }
  const router = createRouter(
    {
      als,
      log,
      llmLookup: () => ctx.get<LlmServiceFace>('llm'),
      getState,
      onFrozenOptions: (error) => {
        log.info('umbra-budget: options 深冻结（%s）— L2 dispatcher 后端接管', error instanceof Error ? error.message : String(error))
      },
    },
    events,
  )

  // ---- L2 dispatcher (optional: missing undici only costs the B-track) ----
  let dispatcherDispose: (() => void) | undefined
  try {
    const undici = (await import('undici')) as unknown as UndiciModuleShape
    const previous = (undici as { getGlobalDispatcher(): unknown }).getGlobalDispatcher()
    const dispatcher = createUmbraDispatcher({
      als,
      previous,
      undici,
      modelOf: (modelId) => currentPool?.models.find((model) => model.id === modelId),
      onObservation: (observation) => signalHub.noteObservation(observation),
      onSignal: (modelId, signal) => signalHub.noteSignal(modelId, signal),
    })
    ;(undici as { setGlobalDispatcher(value: unknown): void }).setGlobalDispatcher(dispatcher)
    dispatcherDispose = () => {
      try {
        ;(undici as { setGlobalDispatcher(value: unknown): void }).setGlobalDispatcher(previous)
      } catch {
        /* best effort */
      }
      void dispatcher.close().catch(() => {})
    }
    log.info('umbra-budget: L2 dispatcher 已接管出站路由')
  } catch (error) {
    log.warn('umbra-budget: undici 不可用，L2 层未启用（B 轨与代理改写不可用）: %s', error instanceof Error ? error.message : String(error))
  }

  // ---- L1 waterfall ----
  const llmStreamListener = (options: GenerateOptionsLike, next: () => AsyncIterable<unknown>) => router.route(options, next as () => AsyncIterable<never>) as unknown
  const sessionListener = (session: unknown, event: { type?: string; data?: unknown }) => {
    if (event?.type === 'request/header') {
      const headerConfig = (event.data as { header?: { config?: { provider?: string; model?: string } } } | null)?.header?.config
      journal.noteRequestRoute(session, headerConfig?.provider, headerConfig?.model)
    } else if (event?.type === 'request/context') {
      const data = event.data as { provider?: string; model?: string } | null
      journal.noteRequestRoute(session, data?.provider, data?.model)
    } else if (event?.type === 'assistant/message') {
      const usage = (event.data as { usage?: TokenUsageLike } | null)?.usage
      if (usage !== undefined) {
        // Session-event usage is folded under the harness-attributed route so
        // one-shot calls that never pull through the waterfall still count.
        const provider = (event.data as { provider?: string }).provider
        const model = (event.data as { model?: string }).model
        if (provider !== undefined && model !== undefined) {
          persistence.scheduleFlush()
        }
      }
    } else if (event?.type === 'subagent/catalog') {
      journal.noteSubagentCatalog(event.data)
    }
  }
  ctx.on('llm/stream', llmStreamListener as never)
  ctx.on('session/event', sessionListener as never)

  // ---- L3 control surface ----
  let routesDispose: (() => void) | undefined
  const webServer = ctx.get<WebServerFace>('webServer')
  if (webServer !== undefined && typeof webServer.register === 'function') {
    routesDispose = registerRoutes(webServer, {
      log,
      bus,
      getState: () => ({ ...getState(), signalHub }),
      setMode: (mode) => applyMode(mode),
      setModelEnabled: (modelId, enabled) => applyModelToggle(modelId, enabled),
      runVerify: () => verifyRouting(),
    })
  } else {
    log.warn('umbra-budget: webServer 服务不可用 — 控制台 API 未挂载（面板将无数据）')
  }

  // ---- pool hot reload ----
  const watcher = watchPoolFile(poolPath, () => {
    void (async () => {
      const next = await loadPoolFile(poolPath, process.env)
      if (next.pool === undefined) {
        log.error('umbra-budget: model_pool 热重载校验失败，保留旧池：\n%s', next.errors.join('\n'))
        return
      }
      currentPool = withMode(next.pool, currentPool?.policy.mode ?? config.mode)
      currentPool = withDisabled(currentPool, runtimeOverrides.disabledModels ?? [])
      syncHealth(health, currentPool)
      load = next
      log.info('umbra-budget: model_pool 热重载完成（%d 个矩阵单元）', currentPool.models.length)
      await writeApplyState(stateDir, { status: 'active', models: currentPool.models.length, reloaded: true })
    })()
  })

  // ---- ledger persistence triggers ----
  journal.onUpdate(() => persistence.scheduleFlush())

  // ---- volatile config updates (settings page) ----
  ctx.on('loader/volatile-update', (() => {
    const next = resolveConfig(rawConfig)
    if (next.mode !== currentPool?.policy.mode && next.mode !== undefined) {
      void applyMode(next.mode)
    }
    log.info('umbra-budget: volatile 配置已更新')
  }) as never)

  // ---- verify: active one-shot routing probe (cheap marker call) ----
  async function verifyRouting(): Promise<{ backend: string; detail: string }> {
    const state = getState()
    const pool = state.pool
    if (pool === undefined || pool.models.length === 0) {
      return { backend: 'unknown', detail: '矩阵未生效，无可探测模型' }
    }
    const llm = ctx.get<LlmServiceFace>('llm')
    if (llm === undefined) return { backend: 'unknown', detail: 'llm 服务不可用' }

    // predict the target exactly the way the router will for a trivial call
    const probeRequest: GenerateOptionsLike = {
      provider: pool.models[0]!.provider,
      model: pool.models[0]!.model,
      messages: [{ role: 'user', content: 'umbra verify ping' }],
      maxTokens: 8,
    }
    const profile = classify(fingerprintOf(probeRequest), pool.policy)
    const chain = selectChain(pool, profile, healthSnapshots(state.health), { now: Date.now() })
    if (chain.length === 0) return { backend: 'unknown', detail: '矩阵没有可用候选' }
    const targetId = chain[0]!.modelId

    const before = signalHub.counters_snapshot()
    try {
      // the router intercepts this call and re-routes it to the chain head;
      // pulls must run inside an ALS store so the dispatcher sees the attribution
      const probeStore = { umbra: true as const, modelId: targetId }
      await als.run(probeStore, async () => {
        const stream = llm.stream(probeRequest)
        for await (const chunk of stream) {
          if (chunk !== null && typeof chunk === 'object' && chunk.type === 'text-delta') break
        }
      })
    } catch (error) {
      log.info('umbra-budget: 探测调用失败（结论仍可从 dispatcher 观测得出）: %s', error instanceof Error ? error.message : String(error))
    }
    const after = signalHub.counters_snapshot()
    const flowed = after.flowOk > before.flowOk
    const rerouted = after.rerouted > before.rerouted
    const ignored = after.rewriteIgnored > before.rewriteIgnored
    let backend: RewriteBackend = 'unknown'
    let detail = ''
    if (flowed && rerouted) {
      backend = 'mixed'
      detail = 'waterfall 改写生效且 B 轨改写参与'
    } else if (flowed) {
      backend = 'waterfall'
      detail = `waterfall 改写到达出站请求（目标 ${targetId}）`
    } else if (ignored) {
      backend = 'dispatcher'
      detail = 'waterfall 改写被宿主忽略 — dispatcher 层强制（B 轨不受影响）'
    } else if (rerouted) {
      backend = 'dispatcher'
      detail = 'B 轨端点改写完成'
    } else {
      detail = '证据不足 — 查看路由监控与 state.json'
    }
    await writeRuntimeState(stateDir, await mergeRuntimeState({ backend }))
    log.info('umbra-budget: 路由验证 → %s（%s）', backend, detail)
    return { backend, detail }
  }

  async function mergeRuntimeState(patch: Partial<RuntimeState>): Promise<RuntimeState> {
    const state = await readRuntimeState(stateDir)
    return { ...state, ...patch }
  }

  async function applyMode(mode: ScheduleMode): Promise<void> {
    if (currentPool !== undefined) currentPool = withMode(currentPool, mode)
    runtimeOverrides.mode = mode
    await writeRuntimeState(stateDir, await mergeRuntimeState({ mode }))
    log.info('umbra-budget: 调度模式 → %s', mode)
  }

  async function applyModelToggle(modelId: string, enabled: boolean): Promise<void> {
    const instance = health.get(modelId)
    if (instance === undefined) return
    if (enabled) instance.reEnable()
    else instance.disable()
    const disabled = [...health.entries()].filter(([, value]) => value.snapshot().status === 'disabled').map(([key]) => key)
    runtimeOverrides.disabledModels = disabled
    await writeRuntimeState(stateDir, await mergeRuntimeState({ disabledModels: disabled }))
    log.info('umbra-budget: %s → %s', modelId, enabled ? '启用' : '禁用')
  }

  await writeApplyState(stateDir, {
    status: load.pool === undefined ? 'rejected' : 'active',
    models: currentPool?.models.length ?? 0,
    mode: currentPool?.policy.mode ?? config.mode,
    poolPath,
    backend: signalHub.backendVerdict(),
    settingsFace: probeSettingsFace(ctx),
  })

  ctx.effect(() => () => {
    watcher.stop()
    routesDispose?.()
    dispatcherDispose?.()
    void persistence.close().catch(() => {})
    log.info('umbra-budget: 已卸载（dispatcher 恢复、台账落盘、监听清理）')
  })
}

/**
 * P4 capability probe: what face does the settings service expose? Method
 * NAMES only (never values) — recorded so the B-track auto-registration
 * enhancement can be planned against real evidence instead of guesses.
 */
export function probeSettingsFace(ctx: HostContextFace): { present: boolean; methodNames: string[] } {
  const settings = ctx.get<object>('settings')
  if (settings === undefined || settings === null) return { present: false, methodNames: [] }
  const names = new Set<string>()
  for (let obj: object | null = settings; obj !== null && obj !== Object.prototype; obj = Object.getPrototypeOf(obj)) {
    for (const key of Object.getOwnPropertyNames(obj)) {
      try {
        if (typeof Reflect.get(settings, key) === 'function') names.add(key)
      } catch {
        /* getter may throw; ignore */
      }
    }
    if (obj === Object.prototype) break
  }
  return { present: true, methodNames: [...names].sort() }
}

// ----------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------

function resolveConfig(rawConfig: unknown): ResolvedConfig {
  const source = (rawConfig ?? {}) as Record<string, unknown>
  const enabled = resolveVolatile<boolean>(source.enabled) ?? true
  const rawMode = resolveVolatile<string>(source.mode) ?? 'frugal'
  const mode = (SCHEDULE_MODES as readonly string[]).includes(rawMode) ? (rawMode as ScheduleMode) : 'frugal'
  const poolPath = resolveVolatile<string>(source.poolPath) ?? ''
  return { enabled, mode, poolPath }
}

export function withMode(pool: ModelPool, mode: ScheduleMode): ModelPool {
  if (pool.policy.mode === mode) return pool
  return { ...pool, policy: { ...pool.policy, mode } }
}

export function withDisabled(pool: ModelPool, disabled: readonly string[]): ModelPool {
  if (disabled.length === 0) return pool
  return {
    ...pool,
    models: pool.models.map((model) => (disabled.includes(model.id) ? { ...model, enabled: false } : model)),
  }
}

export function syncHealth(health: Map<string, ModelHealth>, pool: ModelPool | undefined): void {
  if (pool === undefined) return
  const policy = pool.policy
  for (const model of pool.models) {
    if (!health.has(model.id)) {
      health.set(
        model.id,
        new ModelHealth({
          cooldownMs: policy.fallback.cooldownMs,
          rateLimitMs: policy.fallback.rateLimitMs,
        }),
      )
    }
  }
}

export default { name, inject, Config, apply }
