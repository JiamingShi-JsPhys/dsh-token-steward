/**
 * 40×40 的模型头像。
 *
 * 有图用图，没图用「厂商首字母 + 确定性色相」兜底；加载失败自动回落，
 * 因此界面上永远不会出现裂图。外框颜色跟随 Tier（SSS 金 → D 暗灰），
 * 这就是「四周配上跟随 Tier 变色的发光边框」。
 */
import { useState, type CSSProperties, type ReactNode } from 'react'
import { avatarFor } from '../../core/avatars.ts'
import css from '../steward.module.css'

/** 头像的 props。 */
export interface ModelAvatarProps {
  provider: string
  model: string
  /** Tier 评级；未收录为 undefined。 */
  tier?: string | undefined
  /** 目录是否收录（决定六边形 / 圆形）。 */
  known: boolean
}

/** 头像。 */
export function ModelAvatar(props: ModelAvatarProps): ReactNode {
  const spec = avatarFor(props.provider, props.model, props.known)
  const [failed, setFailed] = useState(false)
  const style = { '--avatar-hue': String(spec.hue) } as CSSProperties
  return (
    <span
      className={css.avatar}
      data-shape={spec.shape}
      data-tier={props.tier ?? 'NA'}
      data-dsh-part="avatar"
      style={style}
      aria-hidden="true"
    >
      {spec.url !== undefined && !failed ? (
        <img
          className={css.avatarImage}
          src={spec.url}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => { setFailed(true) }}
        />
      ) : (
        <span className={css.avatarLetter}>{spec.letter}</span>
      )}
    </span>
  )
}
