/**
 * 模式切换条：三个按钮共享一个滑动高亮。
 *
 * 切换是乐观的：store 先改本地快照，被服务端拒绝时回滚并报错。
 * 因此这里不维护自己的选中状态，永远读快照。
 */
import type { ReactNode } from 'react'
import type { RoutingMode } from '../../core/types.ts'
import { modeOptions } from '../../core/panel-view.ts'
import type { MatrixSnapshot } from '../../core/types.ts'
import { SegmentGroup } from './SegmentGroup.tsx'
import css from '../umbra.module.css'

/** 模式条的 props。 */
export interface ModeSwitchProps {
  snapshot: MatrixSnapshot
  onSelect(mode: RoutingMode): void
  /** 切换进行中时禁用，避免连点产生竞态。 */
  busy?: boolean
}

/** 模式条。 */
export function ModeSwitch(props: ModeSwitchProps): ReactNode {
  const options = modeOptions(props.snapshot)
  return (
    <SegmentGroup role="tablist" aria-label="routing mode" data-dsh-part="mode-switch">
      {options.map((option) => (
        <button
          key={option.mode}
          type="button"
          role="tab"
          className={css.segment}
          data-active={option.active ? 'true' : 'false'}
          aria-selected={option.active}
          title={option.hint}
          disabled={props.busy === true}
          onClick={() => { props.onSelect(option.mode) }}
        >
          {option.label}
        </button>
      ))}
    </SegmentGroup>
  )
}
