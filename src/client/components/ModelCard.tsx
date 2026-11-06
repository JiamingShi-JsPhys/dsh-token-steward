/**
 * 单模型卡（极简调试风）。
 *
 * 悬浮面板是「看一眼现在怎么样」的地方，不是报表：只保留
 *  - 模型名（过长省略号）
 *  - 一枚关键标签：目录评级 [SSS] / [UNRATED] / [NO-CHAT]
 *  - 健康状态点（data-health 配色由皮肤决定）
 *
 * 并发、延迟、今日用量、花费、缓存明细一律不在这里展开——面板只有两列、
 * 每张卡两行，扫读成本最低。需要细节时去设置页看模型矩阵。
 */
import type { ReactNode } from 'react'
import type { ModelCardView } from '../../core/types.ts'
import { modelCardFace } from '../../core/panel-view.ts'
import css from '../steward.module.css'

/** 模型卡的 props。 */
export interface ModelCardProps {
  card: ModelCardView
  /** 当前毫秒，用来算冷却倒计时。 */
  now: number
  t(key: string): string
}

/** 一张模型卡。 */
export function ModelCard(props: ModelCardProps): ReactNode {
  const face = modelCardFace(props.card, props.now)
  const tier = props.card.tier ?? ''
  const badge = tier !== '' && tier !== 'NA'
    ? '[' + tier + ']'
    : props.card.chat === false ? '[NO-CHAT]' : '[UNRATED]'
  return (
    <article
      className={css.card}
      data-dsh-part="model-card"
      data-health={face.health}
      data-unpriced={face.unpriced ? 'true' : 'false'}
      data-tier={tier === '' ? 'NA' : tier}
    >
      <div className={css.cardTop}>
        <div className={css.cardHeading}>
          <span className={css.cardName} title={face.provider + ' / ' + face.model}>{face.displayName}</span>
          <span className={css.cardProvider} data-minimal="true">{badge}</span>
        </div>
        <span className={css.statusDot} aria-hidden="true" />
      </div>
    </article>
  )
}
