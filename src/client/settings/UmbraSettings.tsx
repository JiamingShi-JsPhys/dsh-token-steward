/**
 * 设置页：settings.section 席位。
 *
 * 只回答四件事，且都必须是「用户此刻最想知道」的：
 *  - 配置文件在哪、现在是什么状态（ok / rejected 及原因）；
 *  - 网关地址与本地令牌怎么抄进 profile（这是接入的唯一动作）；
 *  - 当前默认调度模式；
 *  - 台账保留天数（会写进配置文件，因此只读展示，改动走配置文件）。
 *
 * 视觉上对齐全家桶：同一套 --dsw-alias-* 令牌、同一套语义属性、同一套
 * 圆角与间距。它不复制 PluginSettingsCard 的三件套（那是 sync-shared 生成的
 * 家族副本），而是用同样的规则独立实现，避免在外部仓库里维护一份手工同步的副本。
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { MatrixSnapshot, RoutingMode } from '../../core/types.ts'
import { MODE_HINT, MODE_LABEL, MODE_ORDER } from '../../core/format.ts'
import css from '../umbra.module.css'

/** 设置页需要的接口面。 */
export interface UmbraSettingsProps {
  snapshot: MatrixSnapshot | undefined
  /** 网关接线参数；未启动时 undefined。 */
  gateway: { baseUrl: string, token: string, modelIds: string[], port: number } | undefined
  /** 配置文件路径。 */
  poolPath: string
  /** 台账保留天数。 */
  retainDays: number
  /** 重新读一次配置。 */
  onReload(): void
  /** 切换默认模式。 */
  onSelectMode(mode: RoutingMode): void
  t(key: string): string
  /** 复制到剪贴板的实现（测试注入）。 */
  copy?(text: string): Promise<void>
}

/** 设置页。 */
export function UmbraSettings(props: UmbraSettingsProps): ReactNode {
  const snapshot = props.snapshot
  const [copied, setCopied] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (copied === undefined) return undefined
    const timer = setTimeout(() => { setCopied(undefined) }, 1_500)
    return () => { clearTimeout(timer) }
  }, [copied])

  async function copyText(label: string, text: string): Promise<void> {
    const run = props.copy ?? defaultCopy
    try {
      await run(text)
      setCopied(label)
    } catch {
      setCopied(undefined)
    }
  }

  const status = snapshot?.pool.status ?? 'loading'
  const statusText = status === 'ok'
    ? props.t('settings.status') + ': OK'
    : status === 'rejected'
      ? props.t('settings.status') + ': ' + (snapshot?.pool.error ?? 'rejected')
      : props.t('settings.status') + ': …'

  return (
    <section
      className={css.settingsCard}
      data-dsh-plugin="umbra-budget"
      data-dsh-part="settings-section"
      data-status={status}
    >
      <header className={css.settingsHeader}>
        <div>
          <h3 className={css.title}>{props.t('settings.title')}</h3>
          <p className={css.subtitle}>{props.t('settings.description')}</p>
        </div>
        <button type="button" className={css.iconButton} onClick={props.onReload}>
          {props.t('panel.reload')}
        </button>
      </header>

      <div className={css.settingsBanner} data-level={status === 'rejected' ? 'error' : 'ok'}>
        {statusText}
      </div>

      <Field label={props.t('settings.poolPath')} value={props.poolPath} mono />
      <Field
        label={props.t('settings.gateway')}
        value={props.gateway === undefined ? '—' : props.gateway.baseUrl}
        mono
        onCopy={props.gateway === undefined ? undefined : () => { void copyText('baseUrl', props.gateway?.baseUrl ?? '') }}
        copyLabel={copied === 'baseUrl' ? props.t('settings.copied') : props.t('settings.copy')}
      />
      <Field
        label={props.t('settings.token')}
        value={props.gateway === undefined ? '—' : props.gateway.token}
        mono
        onCopy={props.gateway === undefined ? undefined : () => { void copyText('token', props.gateway?.token ?? '') }}
        copyLabel={copied === 'token' ? props.t('settings.copied') : props.t('settings.copy')}
      />
      <Field label={props.t('settings.retainDays')} value={String(props.retainDays)} />

      <div className={css.settingsModes} role="radiogroup" aria-label={props.t('settings.mode')}>
        <div className={css.metricLabel}>{props.t('settings.mode')}</div>
        <div className={css.settingsModeRow}>
          {MODE_ORDER.map((mode) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={snapshot?.mode === mode}
              className={css.segment}
              data-active={snapshot?.mode === mode ? 'true' : 'false'}
              title={MODE_HINT[mode]}
              onClick={() => { props.onSelectMode(mode) }}
            >
              {MODE_LABEL[mode]}
            </button>
          ))}
        </div>
      </div>

      <p className={css.settingsHint}>{props.t('settings.hint')}</p>
    </section>
  )
}

/** 一行只读字段，可带复制按钮。 */
function Field(props: {
  label: string
  value: string
  mono?: boolean
  onCopy?: (() => void) | undefined
  copyLabel?: string | undefined
}): ReactNode {
  return (
    <div className={css.settingsField}>
      <div className={css.metricLabel}>{props.label}</div>
      <div className={css.settingsValueRow}>
        <code className={props.mono === true ? css.settingsValueMono : css.settingsValue} title={props.value}>
          {props.value}
        </code>
        {props.onCopy === undefined ? null : (
          <button type="button" className={css.iconButton} onClick={props.onCopy}>{props.copyLabel}</button>
        )}
      </div>
    </div>
  )
}

/** 默认复制实现：优先 navigator.clipboard，退化为一个隐藏 textarea。 */
async function defaultCopy(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
    await navigator.clipboard.writeText(text)
    return
  }
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  document.execCommand('copy')
  area.remove()
}
