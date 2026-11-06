/**
 * 设置页：settings.section 席位。
 *
 * 两个分区：
 *  - 全局控制区：配置状态、网关地址、本地令牌、默认调度模式；
 *  - 厂家配置区（vendors）：横向厂家 Tab，每家一个表单（API Key + Base URL），
 *    「测试连接并拉取模型」走网关的发现端点，勾选启用后整表保存到 vendors.json。
 *
 * 交互纪律：
 *  - 密钥永不过线：GET /vendors 只回掩码；保存时空串 = 保留已存明文；
 *  - Anthropic 厂商固定渲染红字防封警告（纯文字，无 Emoji）；
 *  - 草稿是本地状态，只有点保存才会落到宿主。
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { MatrixSnapshot, RoutingMode, VendorConfig } from '../../core/types.ts'
import type { CatalogVendor, DiscoveredModel, VendorView } from '../api.ts'
import { MODE_HINT, MODE_LABEL, MODE_ORDER } from '../../core/format.ts'
import { PROVIDER_TEMPLATES, VENDOR_TAB_ORDER } from '../../core/provider-templates.ts'
import css from '../steward.module.css'

/** 厂家 Tab 的形态：目录厂商 + Custom。 */
type TabId = string

/** 设置页需要的接口面。 */
export interface SettingsPanelProps {
  snapshot: MatrixSnapshot | undefined
  /** 网关接线参数；未启动时 undefined。 */
  gateway: { baseUrl: string, token: string, modelIds: string[], port: number } | undefined
  /** 配置文件路径。 */
  poolPath: string
  /** 台账保留天数。 */
  retainDays: number
  /** 厂家配置（密钥掩码）+ 目录；未拉取时 undefined。 */
  vendors: { mode: RoutingMode, vendors: VendorView[], catalog: CatalogVendor[] } | undefined
  /** 重新读一次配置。 */
  onReload(): void
  /** 切换默认模式。 */
  onSelectMode(mode: RoutingMode): void
  /** 整表保存厂家配置（apiKey 空串 = 保留已存明文）。 */
  onSaveVendors(vendors: VendorConfig[]): void
  /** 探测上游模型列表；失败抛错。 */
  onDiscover(params: { vendor?: string, baseUrl?: string, apiKey?: string }): Promise<DiscoveredModel[]>
  t(key: string): string
  /** 复制到剪贴板的实现（测试注入）。 */
  copy?(text: string): Promise<void>
}

/** 一家厂商的本地草稿。 */
interface VendorDraft {
  vendorName: string
  customUrl: string
  apiKey: string
  enabledModels: string[]
}

/** 设置页。 */
export function SettingsPanel(props: SettingsPanelProps): ReactNode {
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
      data-dsh-plugin="token-steward"
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

      <VendorsSection
        gateway={props.gateway}
        vendors={props.vendors}
        onSave={(vendors) => { props.onSaveVendors(vendors) }}
        onDiscover={props.onDiscover}
        t={props.t}
      />

      <p className={css.settingsHint}>{props.t('settings.hint')}</p>
    </section>
  )
}

// ── 厂家配置区 ────────────────────────────────────────────────────────

function VendorsSection(props: {
  gateway: SettingsPanelProps['gateway']
  vendors: SettingsPanelProps['vendors']
  onSave(vendors: VendorConfig[]): void
  onDiscover(params: { vendor?: string, baseUrl?: string, apiKey?: string }): Promise<DiscoveredModel[]>
  t(key: string): string
}): ReactNode {
  const t = props.t
  const catalog = props.vendors?.catalog ?? catalogFromTemplates()
  const saved = props.vendors?.vendors ?? []

  /** Tab 顺序：产品指定的九家在前，其余目录厂商随后，Custom 最后。 */
  const tabs = useMemo(() => {
    const known = catalog.map((vendor) => vendor.vendorId)
    const ordered = VENDOR_TAB_ORDER.filter((id) => known.includes(id))
    const rest = known.filter((id) => !ordered.includes(id))
    return [...ordered, ...rest, 'custom']
  }, [catalog])

  const [activeTab, setActiveTab] = useState<TabId>(tabs[0] ?? 'custom')
  const [drafts, setDrafts] = useState<Record<string, VendorDraft>>({})
  const [discovered, setDiscovered] = useState<Record<string, DiscoveredModel[]>>({})
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | undefined>(undefined)

  const savedBy = useMemo(() => {
    const map = new Map<string, VendorView>()
    for (const vendor of saved) map.set(vendor.vendorId, vendor)
    return map
  }, [saved])

  function draftOf(tab: TabId): VendorDraft {
    const existing = drafts[tab]
    if (existing !== undefined) return existing
    const view = savedBy.get(tab)
    const template = catalog.find((vendor) => vendor.vendorId === tab)
    return {
      vendorName: view?.vendorName ?? template?.vendorName ?? (tab === 'custom' ? '' : tab),
      customUrl: view?.customUrl ?? '',
      apiKey: '',
      enabledModels: view?.enabledModels ?? [],
    }
  }

  function updateDraft(tab: TabId, patch: Partial<VendorDraft>): void {
    setDrafts((previous) => ({ ...previous, [tab]: { ...draftOf(tab), ...patch } }))
  }

  async function fetchModels(tab: TabId): Promise<void> {
    if (props.gateway === undefined) {
      setNotice(t('vendors.noGateway'))
      return
    }
    const draft = draftOf(tab)
    setBusy(true)
    setNotice(undefined)
    try {
      const params: { vendor?: string, baseUrl?: string, apiKey?: string } = { baseUrl: draft.customUrl }
      if (tab !== 'custom') params.vendor = tab
      if (draft.apiKey !== '') params.apiKey = draft.apiKey
      const discoveredModels = await props.onDiscover(params)
      setDiscovered((previous) => ({ ...previous, [tab]: discoveredModels }))
      // 目录厂商：发现结果里把目录内模型默认勾上（首次接入的合理起点）。
      if (draft.enabledModels.length === 0 && tab !== 'custom') {
        const fromCatalog = discoveredModels.filter((entry) => entry.inCatalog).map((entry) => entry.id)
        if (fromCatalog.length > 0) updateDraft(tab, { enabledModels: fromCatalog })
      }
    } catch (error) {
      setNotice(t('vendors.fetchFailed') + ': ' + (error instanceof Error ? error.message : String(error)))
    } finally {
      setBusy(false)
    }
  }

  function toggleModel(tab: TabId, modelId: string): void {
    const draft = draftOf(tab)
    const next = draft.enabledModels.includes(modelId)
      ? draft.enabledModels.filter((id) => id !== modelId)
      : [...draft.enabledModels, modelId]
    updateDraft(tab, { enabledModels: next })
  }

  function saveVendor(tab: TabId): void {
    const draft = draftOf(tab)
    const view = savedBy.get(tab)
    const vendorId = tab === 'custom' ? slugOf(draft.vendorName || 'custom') : tab
    const template = catalog.find((vendor) => vendor.vendorId === vendorId)
    const config: VendorConfig = {
      vendorId,
      vendorName: draft.vendorName !== '' ? draft.vendorName : template?.vendorName ?? vendorId,
      officialUrl: template?.officialUrl ?? '',
      customUrl: draft.customUrl,
      // 空串 = 保留已存明文（掩码回显绝不回传）。
      apiKey: draft.apiKey,
      enabledModels: [...draft.enabledModels],
    }
    void view
    // 保留模式跟随当前全局模式（模式切换有自己的持久化通道）。
    const mode = props.vendors?.mode ?? 'frugal'
    const others = saved.filter((entry) => entry.vendorId !== vendorId).map((entry) => toConfig(entry))
    props.onSave([...others, config].map((entry) => (entry.vendorId === vendorId ? { ...entry, apiKey: draft.apiKey } : entry)))
    void mode
    setDrafts((previous) => ({ ...previous, [tab]: { ...draft, apiKey: '' } }))
    setNotice(t('vendors.saved'))
  }

  const draft = draftOf(activeTab)
  const discoveredList = discovered[activeTab]
  const checkList: Array<{ id: string, name: string, tier: string, inCatalog: boolean }> =
    discoveredList ??
    (activeTab !== 'custom'
      ? (catalog.find((vendor) => vendor.vendorId === activeTab)?.models ?? []).map((entry) => ({ id: entry.id, name: entry.name, tier: entry.tier, inCatalog: true }))
      : [])

  return (
    <div className={css.vendorsSection} data-dsh-part="vendors">
      <div className={css.metricLabel}>{t('vendors.title')}</div>

      <div className={css.vendorLayout}>
        <nav className={css.vendorNav} role="tablist" aria-orientation="vertical">
          {tabs.map((tab) => {
            const label = tab === 'custom' ? t('vendors.tabCustom') : catalog.find((vendor) => vendor.vendorId === tab)?.vendorName ?? tab
            return (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={activeTab === tab}
                className={css.vendorNavItem}
                data-active={activeTab === tab ? 'true' : 'false'}
                onClick={() => { setActiveTab(tab); setNotice(undefined) }}
              >
                {label}
              </button>
            )
          })}
        </nav>

        <div className={css.vendorPane}>
      {activeTab === 'anthropic' ? (
        <div className={css.vendorWarning} data-tone="danger">
          {t('vendors.anthropicWarning')}
        </div>
      ) : null}

      {activeTab === 'custom' ? (
        <label className={css.vendorField}>
          <span className={css.metricLabel}>{t('vendors.customName')}</span>
          <input
            className={css.vendorInput}
            value={draft.vendorName}
            onChange={(event) => { updateDraft('custom', { vendorName: event.target.value }) }}
            placeholder="Doubao"
          />
        </label>
      ) : null}

      <label className={css.vendorField}>
        <span className={css.metricLabel}>{t('vendors.apiKey')}</span>
        <input
          className={css.vendorInput}
          type="password"
          autoComplete="off"
          value={draft.apiKey}
          onChange={(event) => { updateDraft(activeTab, { apiKey: event.target.value }) }}
          placeholder={savedBy.get(activeTab)?.apiKeyMasked ?? t('vendors.keyPlaceholder')}
        />
      </label>

      <label className={css.vendorField}>
        <span className={css.metricLabel}>{t('vendors.baseUrl')}</span>
        <input
          className={css.vendorInput}
          value={draft.customUrl}
          onChange={(event) => { updateDraft(activeTab, { customUrl: event.target.value }) }}
          placeholder={catalog.find((vendor) => vendor.vendorId === activeTab)?.officialUrl ?? 'https://…/v1'}
        />
      </label>

      <div className={css.vendorActions}>
        <button type="button" className={css.vendorButton} disabled={busy} onClick={() => { void fetchModels(activeTab) }}>
          {t('vendors.fetch')}
        </button>
        <button type="button" className={css.vendorButton} data-tone="primary" disabled={busy} onClick={() => { saveVendor(activeTab) }}>
          {t('vendors.save')}
        </button>
        {notice !== undefined ? <span className={css.vendorNotice}>{notice}</span> : null}
      </div>

      {checkList.length > 0 ? (
        <div className={css.modelCheckList} data-dsh-part="vendor-models">
          {checkList.map((entry) => (
            <label key={entry.id} className={css.modelCheckRow}>
              <input
                type="checkbox"
                checked={draft.enabledModels.includes(entry.id)}
                onChange={() => { toggleModel(activeTab, entry.id) }}
              />
              <span className={css.modelCheckName}>{entry.name}</span>
              <code className={css.modelCheckId}>{entry.id}</code>
              <span className={css.modelCheckTier}>{entry.inCatalog ? '[' + entry.tier + ']' : '[' + t('vendors.uncatalogued') + ']'}</span>
            </label>
          ))}
        </div>
      ) : (
        activeTab === 'custom' ? (
          <label className={css.vendorField}>
            <span className={css.metricLabel}>{t('vendors.manualIds')}</span>
            <textarea
              className={css.vendorInput}
              rows={3}
              value={draft.enabledModels.join('\n')}
              onChange={(event) => {
                const ids = event.target.value.split(/[\n,]/).map((id) => id.trim()).filter((id) => id !== '')
                updateDraft('custom', { enabledModels: ids })
              }}
              placeholder={'model-a\nmodel-b'}
            />
          </label>
        ) : null
      )}
        </div>
      </div>
    </div>
  )
}

/** Custom 厂商名 → 稳定 vendorId。 */
function slugOf(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  return slug === '' ? 'custom' : slug
}

/** 掩码视图 → 可保存配置（apiKey 空串 = 保留已存明文）。 */
function toConfig(view: VendorView): VendorConfig {
  return {
    vendorId: view.vendorId,
    vendorName: view.vendorName,
    officialUrl: view.officialUrl,
    customUrl: view.customUrl,
    apiKey: '',
    enabledModels: [...view.enabledModels],
  }
}

/** 宿主未返回目录时的本地回退（静态模板就在包里）。 */
function catalogFromTemplates(): CatalogVendor[] {
  return PROVIDER_TEMPLATES.map((vendor) => ({
    vendorId: vendor.vendorId,
    vendorName: vendor.vendorName,
    officialUrl: vendor.officialUrl,
    models: vendor.models.map((model) => ({ id: model.id, name: model.name, tier: model.tier })),
  }))
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
