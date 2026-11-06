/**
 * 展开式大面板：四块内容共用一个容器。
 *
 * 交互上按 shell.overlay 的常驻层来设计：
 *  - Esc 关闭；关闭时把焦点还给悬浮球；
 *  - 焦点在面板内循环（一个简单的焦点陷阱，避免 Tab 跑进背后的对话区）；
 *  - 打开时自动刷新一次，关闭即停轮询（store 负责节奏）。
 */
import { useEffect, useRef, type ReactNode } from 'react'
import type { MatrixSnapshot } from '../../core/types.ts'
import type { PanelState } from '../store.ts'
import type { PanelStore } from '../store.ts'
import { bannerOf } from '../../core/panel-view.ts'
import { AgentLanes } from './AgentLanes.tsx'
import { CostDashboard } from './CostDashboard.tsx'
import { ModeSwitch } from './ModeSwitch.tsx'
import { ModelGrid } from './ModelGrid.tsx'
import { RouteMonitor } from './RouteMonitor.tsx'
import css from '../umbra.module.css'

/** 面板的 props。 */
export interface UmbraPanelProps {
  state: PanelState
  store: PanelStore
  t(key: string): string
  onClose(): void
  /** 普通模式下的当前毫秒，由外层定时器推进，用于倒计时。 */
  now: number
}

/** 大面板。 */
export function UmbraPanel(props: UmbraPanelProps): ReactNode {
  const snap = props.state.snapshot
  const banner = snap === undefined ? undefined : bannerOf(snap)
  const root = useRef<HTMLDivElement | null>(null)

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
      data-dsh-plugin="umbra-budget"
      data-dsh-part="panel"
      data-mode={snap?.mode ?? 'frugal'}
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
          <div className={css.body}>
            <CostDashboard snapshot={snap} t={props.t} />
            <section className={css.section}>
              <ModelGrid cards={snap.models} now={props.now} t={props.t} />
            </section>
            <section className={css.section}>
              <h4 className={css.sectionTitle}>{props.t('panel.tab.routes')}</h4>
              <RouteMonitor recent={snap.recent} t={props.t} />
            </section>
            <section className={css.section}>
              <h4 className={css.sectionTitle}>{props.t('panel.tab.agents')}</h4>
              <AgentLanes agents={snap.agents} now={props.now} t={props.t} />
            </section>
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
