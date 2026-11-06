/**
 * 展开式大面板：四个页签共用一个容器。
 *
 *  - 成本看板：今日已省 / 花费 / 缓存命中 / 降级 + 最近路由；
 *  - 模型矩阵：头像 + Tier + 六维 + 极客标签；
 *  - 路由日志：降级链 `a → b`、缓存命中、失败原因；
 *  - 代理协作：子代理 → 模型归因。
 *
 * 交互沿用 shell.overlay 的常驻层：Esc 关闭、焦点陷阱、打开即刷新、
 * 关闭即停轮询（节奏由 store 决定）。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { MatrixSnapshot } from '../../core/types.ts'
import type { PanelState, PanelStore } from '../store.ts'
import { bannerOf } from '../../core/panel-view.ts'
import { AgentLanes } from './AgentLanes.tsx'
import { CostDashboard } from './CostDashboard.tsx'
import { ModeSwitch } from './ModeSwitch.tsx'
import { ModelGrid } from './ModelGrid.tsx'
import { RouteMonitor } from './RouteMonitor.tsx'
import { PanelTabs, type PanelTab } from './PanelTabs.tsx'
import css from '../steward.module.css'

/** 面板的 props。 */
export interface StewardPanelProps {
  state: PanelState
  store: PanelStore
  t(key: string): string
  onClose(): void
  /** 普通模式下的当前毫秒，由外层定时器推进，用于倒计时。 */
  now: number
}

/** 大面板。 */
export function StewardPanel(props: StewardPanelProps): ReactNode {
  const snap = props.state.snapshot
  const banner = snap === undefined ? undefined : bannerOf(snap)
  const root = useRef<HTMLDivElement | null>(null)
  const [tab, setTab] = useState<PanelTab>('overview')

  useEffect(() => {
    const element = root.current
    if (element === null) return undefined
    const first = element.querySelector<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
    first?.focus()
    return () => { element.blur() }
  }, [])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.stopPropagation()
        props.onClose()
        return
      }
      if (event.key !== 'Tab') return
      const element = root.current
      if (element === null) return
      const focusable = Array.from(element.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ))
      if (focusable.length === 0) return
      const first = focusable[0] as HTMLElement
      const last = focusable[focusable.length - 1] as HTMLElement
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => { document.removeEventListener('keydown', onKeyDown, true) }
  }, [props.onClose])

  return (
    <div
      ref={root}
      className={css.panel}
      role="dialog"
      aria-modal="false"
      aria-label={props.t('panel.title')}
      data-dsh-plugin="token-steward"
      data-dsh-part="panel"
      data-mode={snap?.mode ?? 'frugal'}
      data-tab={tab}
    >
      <header className={css.header}>
        <div>
          <h3 className={css.title}>{props.t('panel.title')}</h3>
          <p className={css.subtitle}>{props.t('panel.subtitle')}</p>
        </div>
        <div className={css.headerActions}>
          <button type="button" className={css.iconButton} onClick={() => { void props.store.reload() }}>
            {props.t('panel.reload')}
          </button>
          <button type="button" className={css.iconButton} onClick={props.onClose}>
            {props.t('panel.close')}
          </button>
        </div>
      </header>

      {banner === undefined ? null : (
        <div className={css.banner} data-level={banner.level} data-dsh-part="banner">{banner.text}</div>
      )}

      {snap === undefined ? (
        <div className={css.empty}>{props.state.error ?? props.t('panel.subtitle')}</div>
      ) : (
        <>
          <ModeSwitch snapshot={snap} busy={props.state.loading} onSelect={(mode) => { void props.store.setMode(mode) }} />
          <PanelTabs active={tab} onChange={setTab} t={props.t} />
          <div className={css.body} data-dsh-part="panel-body">
            {tab === 'overview' ? (
              <>
                <CostDashboard snapshot={snap} t={props.t} />
                <section className={css.section}>
                  <h4 className={css.sectionTitle}>{props.t('panel.tab.routes')}</h4>
                  <RouteMonitor recent={snap.recent} t={props.t} limit={6} />
                </section>
              </>
            ) : null}

            {tab === 'models' ? (
              <section className={css.section}>
                <ModelGrid cards={snap.models} now={props.now} t={props.t} />
              </section>
            ) : null}

            {tab === 'routes' ? (
              <section className={css.section}>
                <RouteMonitor recent={snap.recent} t={props.t} limit={40} />
              </section>
            ) : null}

            {tab === 'agents' ? (
              <section className={css.section}>
                <AgentLanes agents={snap.agents} now={props.now} t={props.t} />
              </section>
            ) : null}

            {props.state.error === undefined ? null : (
              <div className={css.errorLine}>{props.t('panel.error')}: {props.state.error}</div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

/** 导出给测试与上层复用的快照类型别名。 */
export type { MatrixSnapshot }
