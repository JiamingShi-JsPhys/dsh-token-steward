/**
 * 代理协作视图：每个子代理当前被分到哪个模型。
 *
 * 超过 90 秒没动静的行置灰——一个三天前跑过一次的代理挂在「活跃」区
 * 会让人误以为矩阵正在被使用。
 */
import type { ReactNode } from 'react'
import type { AgentRouteView } from '../../core/types.ts'
import { agentRows } from '../../core/panel-view.ts'
import css from '../steward.module.css'

/** 代理协作视图的 props。 */
export interface AgentLanesProps {
  agents: AgentRouteView[]
  now: number
  t(key: string): string
}

/** 代理协作视图。 */
export function AgentLanes(props: AgentLanesProps): ReactNode {
  const rows = agentRows(props.agents, props.now)
  if (rows.length === 0) {
    return <div className={css.empty} data-dsh-part="agent-lanes-empty">{props.t('agents.empty')}</div>
  }
  return (
    <div className={css.list} data-dsh-part="agent-lanes">
      {rows.map((row) => (
        <div key={row.agentId} className={css.row} data-idle={row.idle ? 'true' : 'false'}>
          <span className={css.rowMain} title={row.agentId}>{row.agentId}</span>
          <span className={css.rowMeta}>{row.routeText}</span>
          <span className={css.rowMeta}>{row.requestsText}</span>
          {row.idle ? <span className={css.rowMeta}>{props.t('agents.idle')}</span> : null}
        </div>
      ))}
    </div>
  )
}
