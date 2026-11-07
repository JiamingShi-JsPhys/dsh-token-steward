/**
 * 悬浮球：常驻在 shell.overlay 上的一颗按钮。
 *
 * 它承担两件事，且都是「一眼可见」：
 *  - 当前档位（外环颜色）；
 *  - 今日已省（未定价时退回 token 数，未计量时是破折号）；
 * 点一下展开 / 收起面板。
 *
 * 刻意不做「长按切档」：档位由输入框里选的模型决定，球上偷偷换档只会让
 * 输入框和面板各说各话。要换档，就换输入框里的模型。
 *
 * 不轮询：球只显示 store 里的最后一份快照，真正的节奏由面板决定。
 */
import type { ReactNode } from 'react'
import type { MatrixSnapshot, RoutingMode } from '../../core/types.ts'
import { ballBadge } from '../../core/panel-view.ts'
import css from '../steward.module.css'

/** 悬浮球的 props。 */
export interface StewardBallProps {
  snapshot: MatrixSnapshot | undefined
  /** 输入框里选中的档位（优先于快照里的模式，点完模型选择立刻生效）。 */
  mode?: RoutingMode
  open: boolean
  t(key: string): string
  onToggle(): void
}

/** 悬浮球。 */
export function StewardBall(props: StewardBallProps): ReactNode {
  const tone = props.mode ?? props.snapshot?.mode ?? 'frugal'
  const badge = props.snapshot === undefined ? '—' : ballBadge(props.snapshot)

  return (
    <button
      type="button"
      className={css.ball}
      data-dsh-plugin="token-steward"
      data-dsh-part="ball"
      data-tone={tone}
      data-open={props.open ? 'true' : 'false'}
      aria-expanded={props.open}
      title={props.open ? props.t('ball.close') : props.t('ball.open')}
      onClick={props.onToggle}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          props.onToggle()
        }
      }}
    >
      <span className={css.ring} aria-hidden="true" />
      <span className={css.ballBadge} aria-label={props.t('ball.badge')}>{badge}</span>
    </button>
  )
}
