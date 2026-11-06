/**
 * 模型阵列：按成本档位分组展示。
 *
 * 分组而不是平铺，是因为「极致便宜模式到底会不会偷偷挑贵的」这个问题，
 * 用户需要一眼看到档位分布；一排按分数排序的卡片回答不了它。
 */
import type { ReactNode } from 'react'
import type { ModelCardView } from '../../core/types.ts'
import { groupByCost } from '../../core/panel-view.ts'
import { ModelCard } from './ModelCard.tsx'
import css from '../umbra.module.css'

/** 模型阵列的 props。 */
export interface ModelGridProps {
  cards: ModelCardView[]
  now: number
  t(key: string): string
}

/** 模型阵列。 */
export function ModelGrid(props: ModelGridProps): ReactNode {
  if (props.cards.length === 0) {
    return <div className={css.empty} data-dsh-part="model-grid-empty">{props.t('models.empty')}</div>
  }
  const groups = groupByCost(props.cards)
  return (
    <div data-dsh-part="model-grid">
      {groups.map((group) => (
        <section key={group.costLevel} className={css.section}>
          <h4 className={css.sectionTitle}>{group.label} · {group.cards.length}</h4>
          <div className={css.cardGrid}>
            {group.cards.map((card) => (
              <ModelCard key={card.provider + '/' + card.model} card={card} now={props.now} t={props.t} />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
