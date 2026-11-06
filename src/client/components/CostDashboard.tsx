/**
 * 成本看板：四张数字卡。
 *
 * 「未定价」与「未计量」都显示破折号，不是 0——一个 0 会被读成「今天没花钱」，
 * 那是错的。补充说明（N 个模型未定价 / 计量不可用）紧随其后，告诉用户为什么。
 */
import type { ReactNode } from 'react'
import type { MatrixSnapshot } from '../../core/types.ts'
import { headline } from '../../core/panel-view.ts'
import css from '../steward.module.css'

/** 成本看板的 props。 */
export interface CostDashboardProps {
  snapshot: MatrixSnapshot
  /** 文案查表。 */
  t(key: string): string
}

/** 四张数字卡。 */
export function CostDashboard(props: CostDashboardProps): ReactNode {
  const face = headline(props.snapshot)
  return (
    <div className={css.headline} data-dsh-part="headline" data-cache-backend={face.backend}>
      <Metric label={props.t('headline.saved')} value={face.saved} note={face.savedNote} tone="saved" />
      <Metric label={props.t('headline.cost')} value={face.cost} note={face.costNote} />
      <Metric label={props.t('headline.cache')} value={face.cache} note={props.t('headline.backend') + ': ' + face.backend.toUpperCase()} />
      <Metric label={props.t('headline.degraded')} value={face.degraded} />
    </div>
  )
}

/** 一张数字卡。 */
function Metric(props: { label: string, value: string, note?: string | undefined, tone?: string | undefined }): ReactNode {
  return (
    <div className={css.metric} data-tone={props.tone}>
      <div className={css.metricLabel}>{props.label}</div>
      <div className={css.metricValue}>{props.value}</div>
      {props.note === undefined || props.note === '' ? null : <div className={css.metricNote}>{props.note}</div>}
    </div>
  )
}
