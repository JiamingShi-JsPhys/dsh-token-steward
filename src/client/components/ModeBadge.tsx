/**
 * 当前档位徽标。
 *
 * 面板顶部只显示「现在用的是哪一档」：模式是由输入框里选的模型决定的
 * （管家·自动 / 极致便宜 / 效率优先 / 最强火力 / 免费档），再摆四个切换按钮
 * 只会让人以为面板能改档，和真实行为打架。要换档，就换输入框里的模型。
 */
import type { ReactNode } from 'react'
import type { RoutingMode } from '../../core/types.ts'
import { MODE_HINT, MODE_LABEL } from '../../core/format.ts'
import css from '../steward.module.css'

/** 徽标的 props。 */
export interface ModeBadgeProps {
  mode: RoutingMode
  /** 「当前为」这句前缀，随语言切换。 */
  label: string
}

/** 只读档位徽标。 */
export function ModeBadge(props: ModeBadgeProps): ReactNode {
  const mode = props.mode
  return (
    <div className={css.modeBadge} data-dsh-part="mode-badge" data-mode={mode} title={MODE_HINT[mode]}>
      <span className={css.modeBadgeLead}>{props.label}</span>
      <strong className={css.modeBadgeName}>{MODE_LABEL[mode]}</strong>
    </div>
  )
}
