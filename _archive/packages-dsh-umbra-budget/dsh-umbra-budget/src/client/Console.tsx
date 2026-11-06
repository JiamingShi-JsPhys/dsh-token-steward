/**
 * The umbra-budget console — shell.overlay full-screen panel.
 *
 * Four blocks: mode switcher header (with today totals + cache hit + backend
 * badge), model grid, live route monitor (SSE), agent collaboration map.
 * Data: 10s overview polling + SSE frames; everything cleans up on unmount.
 *
 * @module client/Console.tsx
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RouteEventFrame, ScheduleMode, UmbraOverview } from '../core/types.ts'
import { SCHEDULE_MODES } from '../core/types.ts'
import { fetchOverview, postModelToggle, postMode, postVerify, subscribeEvents } from './api.ts'
import { isConsoleOpen, setConsoleOpen, subscribeConsoleOpen } from './console-open.ts'
import { styles } from './console-classes.ts'

const POLL_MS = 10_000

const MODE_LABELS: Record<ScheduleMode, string> = {
  frugal: '◆ 极致便宜',
  efficiency: '⚡ 效率优先',
  max_power: '🔥 最强火力',
}

const BACKEND_LABELS: Record<string, string> = {
  waterfall: '瀑布改写',
  dispatcher: 'Dispatcher 强制',
  mixed: '混合后端',
  unknown: '待验证',
}

const STATUS_LABELS: Record<string, string> = {
  healthy: '活跃',
  cooling: '冷却',
  disabled: '离线',
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

function formatCost(costByCurrency: Record<string, number>): string {
  const entries = Object.entries(costByCurrency)
  if (entries.length === 0) return '—'
  return entries.map(([currency, cost]) => `¥${cost.toFixed(2)}`.replace('¥', currency === 'CNY' ? '¥' : `${currency} `)).join(' + ')
}

function formatTime(ts: number): string {
  const date = new Date(ts)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`
}

export function Console(): JSX.Element {
  const [visible, setVisible] = useState(isConsoleOpen())
  const [overview, setOverview] = useState<UmbraOverview | undefined>(undefined)
  const [liveFrames, setLiveFrames] = useState<RouteEventFrame[]>([])
  const [connected, setConnected] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    const unsubscribeOpen = subscribeConsoleOpen((next) => {
      if (mountedRef.current) setVisible(next)
    })
    return () => {
      mountedRef.current = false
      unsubscribeOpen()
    }
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await fetchOverview()
      if (mountedRef.current) {
        setOverview(next)
        setError(undefined)
      }
    } catch (cause) {
      if (mountedRef.current) setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    if (!visible) return
    mountedRef.current = true
    void refresh()
    const poll = setInterval(() => {
      void refresh()
    }, POLL_MS)
    const unsubscribe = subscribeEvents((frame) => {
      if (!mountedRef.current) return
      setLiveFrames((previous) => [frame, ...previous].slice(0, 30))
      if (frame.kind === 'dispatch' || frame.kind === 'cooldown' || frame.kind === 'recovery') void refresh()
    }, setConnected)
    return () => {
      mountedRef.current = false
      clearInterval(poll)
      unsubscribe()
    }
  }, [visible, refresh])

  const mode = overview?.mode ?? 'frugal'

  const handleMode = useCallback(async (next: ScheduleMode): Promise<void> => {
    setBusy(true)
    try {
      await postMode(next)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }, [refresh])

  const handleToggle = useCallback(async (modelId: string, enabled: boolean): Promise<void> => {
    setBusy(true)
    try {
      await postModelToggle(modelId, enabled)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }, [refresh])

  const handleVerify = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      await postVerify()
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }, [refresh])

  const liveDecisions = useMemo(
    () => liveFrames.filter((frame) => frame.decision !== undefined).slice(0, 12),
    [liveFrames],
  )

  if (!visible) return <div data-dsh-plugin="umbra-budget" />

  return (
    <div className={styles.overlay} data-dsh-plugin="umbra-budget">
      <div className={styles.panel}>
        <header className={styles.header}>
          <div className={styles.titleBlock}>
            <span className={styles.title}>UMBRA BUDGET</span>
            <span className={styles.subtitle}>模型矩阵调度中枢</span>
          </div>
          <div className={styles.headerStats}>
            <span className={styles.statChip}>
              今日 {formatTokens(overview?.today.inputTokens ?? 0)} in / {formatTokens(overview?.today.outputTokens ?? 0)} out
            </span>
            <span className={styles.statChip}>{formatCost(overview?.today.costByCurrency ?? {})}</span>
            <span className={styles.statChip} title="provider 侧 prompt cache 命中率">
              缓存命中 {Math.round((overview?.promptCacheHitRate ?? 0) * 100)}%
            </span>
            {overview?.localCache.enabled === true ? (
              <span className={styles.statChip} title="本地精确响应缓存（trivial 调用，零出站）">
                本地缓存 {overview.localCache.hits}/{overview.localCache.hits + overview.localCache.misses}
              </span>
            ) : null}
            <span className={`${styles.statChip} ${styles.backendChip}`} title={overview?.backend ?? ''}>
              {BACKEND_LABELS[overview?.backend ?? 'unknown'] ?? overview?.backend}
            </span>
            <span className={`${styles.liveDot} ${connected ? styles.liveOn : styles.liveOff}`} />
          </div>
          <button className={styles.closeButton} onClick={() => setConsoleOpen(false)} aria-label="关闭控制台">
            ✕
          </button>
        </header>

        <div className={styles.modeBar}>
          {SCHEDULE_MODES.map((candidate) => (
            <button
              key={candidate}
              className={`${styles.modeButton} ${candidate === mode ? styles.modeActive : ''}`}
              disabled={busy}
              onClick={() => void handleMode(candidate)}
            >
              {MODE_LABELS[candidate]}
            </button>
          ))}
          <button className={styles.verifyButton} disabled={busy} onClick={() => void handleVerify()}>
            验证路由后端
          </button>
        </div>

        {error !== undefined ? <div className={styles.errorBar}>{error}</div> : null}

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>模型阵列</h2>
          <div className={styles.grid}>
            {(overview?.pool ?? []).map((card) => (
              <div key={card.model.id} className={styles.card}>
                <div className={styles.cardHead}>
                  <span className={`${styles.statusDot} ${styles[`status_${card.health.status}`] ?? ''}`} />
                  <span className={styles.modelName}>{card.model.model}</span>
                  <span className={styles.providerName}>{card.model.provider}</span>
                </div>
                <div className={styles.tagRow}>
                  <span className={`${styles.tag} ${styles[`cost_${card.model.tags.costLevel}`] ?? ''}`}>{card.model.tags.costLevel}</span>
                  {card.model.tags.capabilities.slice(0, 4).map((capability) => (
                    <span key={capability} className={styles.tag}>
                      {capability}
                    </span>
                  ))}
                </div>
                <div className={styles.cardStats}>
                  <span>{formatTokens(card.today.inputTokens + card.today.cacheReadTokens + card.today.cacheWriteTokens)} in</span>
                  <span>{formatTokens(card.today.outputTokens)} out</span>
                  <span>{formatCost(card.today.costByCurrency)}</span>
                  <span>{card.health.ewmaTtfbMs > 0 ? `${card.health.ewmaTtfbMs}ms` : '—'}</span>
                </div>
                {card.model.configNotes.length > 0 ? (
                  <div className={styles.note}>{card.model.configNotes[0]}</div>
                ) : null}
                <button
                  className={styles.toggleButton}
                  disabled={busy}
                  onClick={() => void handleToggle(card.model.id, card.health.status === 'disabled')}
                >
                  {card.health.status === 'disabled' ? '启用' : '禁用'}
                </button>
              </div>
            ))}
            {(overview?.pool.length ?? 0) === 0 ? <div className={styles.empty}>矩阵为空 — 编辑 model_pool.yaml</div> : null}
          </div>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>
            路由监控
            <span className={styles.sectionHint}>{connected ? '实时' : 'SSE 未连接'}</span>
          </h2>
          <div className={styles.routes}>
            {liveDecisions.map((frame) => {
              const decision = frame.decision!
              return (
                <div key={`${frame.rev}-${decision.ts}`} className={styles.routeRow}>
                  <span className={styles.routeTime}>{formatTime(decision.ts)}</span>
                  <span className={styles.routeMode}>{MODE_LABELS[decision.mode]}</span>
                  <span className={styles.routeFlow}>
                    {decision.requested.model ?? '?'} <span className={styles.routeArrow}>→</span>{' '}
                    <strong>{decision.finalModel ?? decision.chosen}</strong>
                    {decision.fallbacks > 0 ? <em className={styles.fallbackBadge}>容灾×{decision.fallbacks}</em> : null}
                  </span>
                  <span className={styles.routeReason}>{decision.reason}</span>
                </div>
              )
            })}
            {liveDecisions.length === 0 ? (
              (overview?.recentRoutes ?? []).slice(0, 12).map((decision) => (
                <div key={`${decision.ts}-${decision.chosen}`} className={styles.routeRow}>
                  <span className={styles.routeTime}>{formatTime(decision.ts)}</span>
                  <span className={styles.routeMode}>{MODE_LABELS[decision.mode]}</span>
                  <span className={styles.routeFlow}>
                    {decision.requested.model ?? '?'} <span className={styles.routeArrow}>→</span>{' '}
                    <strong>{decision.finalModel ?? decision.chosen}</strong>
                    {decision.fallbacks > 0 ? <em className={styles.fallbackBadge}>容灾×{decision.fallbacks}</em> : null}
                  </span>
                  <span className={styles.routeReason}>{decision.reason}</span>
                </div>
              ))
            ) : null}
            {liveDecisions.length === 0 && (overview?.recentRoutes.length ?? 0) === 0 ? (
              <div className={styles.empty}>暂无路由记录 — 发起一次对话即可看到分发去向</div>
            ) : null}
          </div>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>代理协作</h2>
          <div className={styles.agents}>
            {(overview?.agents ?? []).map((assignment) => (
              <div key={`${assignment.agent}-${assignment.modelId}`} className={styles.agentRow}>
                <span className={styles.agentName}>{assignment.agent}</span>
                <span className={styles.routeArrow}>→</span>
                <span className={styles.agentModel}>{assignment.modelId}</span>
              </div>
            ))}
            {(overview?.agents.length ?? 0) === 0 ? <div className={styles.empty}>暂无代理归属</div> : null}
          </div>
        </section>
      </div>
    </div>
  )
}
