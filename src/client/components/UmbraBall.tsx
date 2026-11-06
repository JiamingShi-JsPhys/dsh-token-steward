/**
 * 悬浮球：常驻在 shell.overlay 上的一颗按钮。
 *
 * 它承担三件事，且都是「一眼可见」：
 *  - 当前调度模式（外环颜色）；
 *  - 今日花费（未定价时退回 token 数，未计量时是破折号）；
 *  - 点开面板 / （长按或键盘）循环切换模式。
 *
 * 不轮询：球只显示 store 里的最后一份快照，真正的节奏由面板决定。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { MatrixSnapshot, RoutingMode } from '../../core/types.ts'
import { ballBadge } from '../../core/panel-view.ts'
import { MODE_ORDER } from '../../core/format.ts'
import css from '../umbra.module.css'

/** 长按判定阈值。 */
const LONG_PRESS_MS = 600

/** 悬浮球的 props。 */
export interface UmbraBallProps {
  snapshot: MatrixSnapshot | undefined
  open: boolean
  t(key: string): string
  onToggle(): void
  onCycleMode(mode: RoutingMode): void
}

/** 悬浮球。 */
export function UmbraBall(props: UmbraBallProps): ReactNode {
  const [pressed, setPressed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => {
    if (timer.current !== undefined) clearTimeout(timer.current)
  }, [])

  const startPress = (): void => {
    setPressed(false)
    if (timer.current !== undefined) clearTimeout(timer.current)
    timer.current = setTimeout(() => { setPressed(true) }, LONG_PRESS_MS)
  }

  const endPress = (): void => {
    if (timer.current !== undefined) {
      clearTimeout(timer.current)
      timer.current = undefined
    }
    if (pressed) {
      // 长按：循环切到下一个模式。
      setPressed(false)
      const current = props.snapshot?.mode ?? 'frugal'
      const index = MODE_ORDER.indexOf(current)
      const next = MODE_ORDER[(index + 1) % MODE_ORDER.length] as RoutingMode
      props.onCycleMode(next)
      return
    }
    props.onToggle()
  }

  const tone = props.snapshot?.mode ?? 'frugal'
  const badge = props.snapshot === undefined ? '—' : ballBadge(props.snapshot)

  return (
    <button
      type="button"
      className={css.ball}
      data-dsh-plugin="umbra-budget"
      data-dsh-part="ball"
      data-tone={tone}
      data-open={props.open ? 'true' : 'false'}
      aria-expanded={props.open}
      title={props.open ? props.t('ball.close') : props.t('ball.open')}
      onPointerDown={startPress}
      onPointerUp={endPress}
      onPointerLeave={() => { if (timer.current !== undefined) { clearTimeout(timer.current); timer.current = undefined } setPressed(false) }}
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
