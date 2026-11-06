/**
 * 单模型卡：能力标签、健康状态、并发、延迟、今日用量与成本。
 *
 * 状态用 data-health 表达而不是类名切换，因此皮肤可以按状态配色，
 * 而本组件不需要知道皮肤的存在。
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
  return (
    <article
      className={css.card}
      data-dsh-part="model-card"
      data-health={face.health}
      data-unpriced={face.unpriced ? 'true' : 'false'}
    >
      <div className={css.cardHead}>
        <span className={css.cardName} title={face.provider + ' / ' + face.model}>{face.displayName}</span>
        {props.card.tier !== undefined ? <span className={css.tierBadge}>[{props.card.tier}]</span> : null}
        <span className={css.statusDot} aria-hidden="true" />
      </div>

      {props.card.dimensions !== undefined ? (
        <div className={css.dimRow} data-dsh-part="dimensions">
          <span className={css.dimBox}>R: {props.card.dimensions.reasoning.score}</span>
          <span className={css.dimBox}>L: {props.card.dimensions.longContext.score}</span>
          <span className={css.dimBox}>C: {props.card.dimensions.coding.score}</span>
          <span className={css.dimBox}>A: {props.card.dimensions.agentic.score}</span>
          <span className={css.dimBox}>P: {props.card.dimensions.proWork.score}</span>
          <span className={css.dimBox}>F: {props.card.dimensions.factuality.score}</span>
        </div>
      ) : null}

      <div className={css.chips}>
        <span className={css.chip} data-part="cost-level">{face.costLevelLabel}</span>
        {face.capabilities.map((capability) => (
          <span key={capability} className={css.chip}>{capability}</span>
        ))}
        {face.unpriced ? <span className={css.chip} data-unpriced="true">{props.t('models.unpriced')}</span> : null}
      </div>

      <div className={css.cardStats}>
        <span className={css.statLabel}>{props.t('models.inflight')}</span>
        <span>{face.inFlightText}</span>
        <span className={css.statLabel}>{props.t('models.latency')}</span>
        <span>{face.latencyText}</span>
        <span className={css.statLabel}>{props.t('models.tokens')}</span>
        <span>{face.tokensText}</span>
        <span className={css.statLabel}>{props.t('models.cost')}</span>
        <span>{face.costText}</span>
        <span className={css.statLabel}>{props.t('models.cache')}</span>
        <span>{face.cacheText}</span>
      </div>

      <div className={css.chips}>
        <span className={css.chip}>{face.healthLabel}</span>
        {face.resumeIn === undefined ? null : <span className={css.chip}>{face.resumeIn}</span>}
      </div>
    </article>
  )
}
