/**
 * 面板页签：成本看板 / 模型矩阵 / 路由日志 / 代理协作。
 *
 * 复用 SegmentGroup 的滑动药丸，视觉与模式条同构；页签只回答「看哪一屏」，
 * 不持有数据，因此切换不会触发任何网络请求。
 */
import type { ReactNode } from 'react'
import { SegmentGroup } from './SegmentGroup.tsx'
import css from '../steward.module.css'

/** 四个页签。 */
export type PanelTab = 'overview' | 'models' | 'routes' | 'agents'

/** 页签顺序（固定）。 */
export const PANEL_TABS: readonly PanelTab[] = ['overview', 'models', 'routes', 'agents'] as const

/** 页签的 props。 */
export interface PanelTabsProps {
  active: PanelTab
  onChange(tab: PanelTab): void
  t(key: string): string
}

/** 取页签文案的 key。 */
export function tabLabelKey(tab: PanelTab): string {
  return 'panel.tab.' + tab
}

/** 页签条。 */
export function PanelTabs(props: PanelTabsProps): ReactNode {
  return (
    <SegmentGroup role="tablist" aria-label="panel tab" data-dsh-part="panel-tabs">
      {PANEL_TABS.map((tab) => (
        <button
          key={tab}
          type="button"
          role="tab"
          aria-selected={props.active === tab}
          className={css.segment}
          data-active={props.active === tab ? 'true' : 'false'}
          data-dsh-part={'tab-' + tab}
          onClick={() => { props.onChange(tab) }}
        >
          {props.t(tabLabelKey(tab))}
        </button>
      ))}
    </SegmentGroup>
  )
}
