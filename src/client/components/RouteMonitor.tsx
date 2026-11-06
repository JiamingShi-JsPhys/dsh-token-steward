/**
 * 路由监控：最近若干条请求的去向，降级链画成 a → b。
 *
 * 这一屏的价值是「异常可见」：降级的行有底色，失败的行有红底，
 * 因此用户不用读数字就知道刚才发生了什么。
 */
import type { ReactNode } from 'react'
import type { RouteEventView } from '../../core/types.ts'
import { routeRows } from '../../core/panel-view.ts'
import css from '../umbra.module.css'

/** 路由监控的 props。 */
export interface RouteMonitorProps {
  recent: RouteEventView[]
  t(key: string): string
  /** 最多显示几行。 */
  limit?: number
}

/** 路由监控。 */
export function RouteMonitor(props: RouteMonitorProps): ReactNode {
  const rows = routeRows(props.recent, props.limit ?? 12)
  if (rows.length === 0) {
    return <div className={css.empty} data-dsh-part="route-monitor-empty">{props.t('routes.empty')}</div>
  }
  return (
    <div className={css.list} data-dsh-part="route-monitor">
      {rows.map((row) => (
        <div
          key={row.requestId}
          className={css.row}
          data-ok={row.ok ? 'true' : 'false'}
          data-degraded={row.degraded ? 'true' : 'false'}
          data-cached={row.cached === true ? 'true' : 'false'}
        >
          <span className={css.rowMain} title={row.routeText}>{row.routeText}</span>
          <span className={css.rowMeta}>{row.modeLabel}</span>
          <span className={css.rowMeta}>{row.latencyText}</span>
          <span className={css.rowMeta}>
            {row.cached === true
              ? props.t('routes.cached')
              : row.ok
                ? props.t('routes.ok')
                : (row.failureReason ?? props.t('routes.failed'))}
          </span>
        </div>
      ))}
    </div>
  )
}
