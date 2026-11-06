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
import type { ImportScope, MatrixSnapshot, ModelPrice, RoutingMode, VendorConfig } from '../../core/types.ts'
import type { CatalogVendor, DiscoveredModel, VendorView } from '../api.ts'
import { MODE_HINT, MODE_LABEL } from '../../core/format.ts'
import { findModelProfile, matchTemplateModel, PROVIDER_TEMPLATES, VENDOR_TAB_ORDER } from '../../core/provider-templates.ts'
import { isFreePriced, listPriceOf } from '../../core/pricing.ts'
import { bundledAvatarUrl } from '../../core/avatar-assets.ts'
import css from '../steward.module.css'

/** 厂家 Tab 的形态：目录厂商 + 自定义厂商 + 新建入口。 */
type TabId = string

/** 插件主页：面板右上角的 GitHub 入口。 */
export const REPO_URL = 'https://github.com/JiamingShi-JsPhys/dsh-token-steward'

/** 设置页的三个板块。调度模式不在这里选——它由输入框里选的模型决定。 */
type SectionId = 'vendors' | 'free' | 'freeload'
const SECTIONS: readonly SectionId[] = ['vendors', 'free', 'freeload']

/**
 * 「新建自定义厂商」入口的哨兵 id。
 *
 * 不能用 'custom'：老数据里真的存着 vendorId='custom' 的厂商，两者撞在一起
 * 就会渲染出两个一模一样的「自定义」Tab，改一个另一个跟着变。
 */
const NEW_TAB = '__new__'

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
  /** 只重拉厂家列表：打开设置时同步一次，别的地方（Agent 工具）改了配置也能看见。 */
  onRefreshVendors?: () => void
  /** 切换默认模式。 */
  onSelectMode(mode: RoutingMode): void
  /** 整表保存厂家配置（apiKey 空串 = 保留已存明文）。 */
  onSaveVendors(vendors: VendorConfig[]): void
  /** 探测上游模型列表；失败抛错。 */
  onDiscover(params: { vendor?: string, baseUrl?: string, apiKey?: string }): Promise<DiscoveredModel[]>
  /** 从 DSH 现有 profile 抓取已配好的上游；scope 限定为「当前这一家」。 */
  onImportHarness(scope?: ImportScope): Promise<{ ok: boolean, imported: string[], error?: string }>
  /** 反向同步：把这家的型号写回 DSH 的系统模型设置。 */
  onSyncHarness(vendorId: string): Promise<{ ok: boolean, file?: string, models?: number, error?: string }>
  /** 显式删除一家厂家。 */
  onDeleteVendor(vendorId: string): Promise<{ ok: boolean, error?: string }>
  t(key: string): string
  /** 复制到剪贴板的实现（测试注入）。 */
  copy?(text: string): Promise<void>
}

/** 一家厂商的本地草稿。 */
interface VendorDraft {
  vendorName: string
  customUrl: string
  /** 官网 / 中转站二选一（右边两个单选点）。 */
  endpointSource: 'official' | 'relay'
  apiKey: string
  enabledModels: string[]
  /** 用户给模型打的擅长标签（AI 调控可读）。 */
  modelTags: Record<string, string[]>
  /** 用户覆盖的价目（每百万 token）。 */
  modelPricing: Record<string, ModelPrice>
}

/** 设置页。 */
export function SettingsPanel(props: SettingsPanelProps): ReactNode {
  const snapshot = props.snapshot
  const [copied, setCopied] = useState<string | undefined>(undefined)
  /** 设置页的三个板块：厂家设置（含自定义）/ 免费池 / 白嫖模式。 */
  const [section, setSection] = useState<SectionId>('vendors')

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
        <div className={css.headerActions}>
          <a
            className={css.iconButton}
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            data-dsh-part="repo-link"
            title={props.t('settings.repoHint')}
          >
            {props.t('settings.repo')}
          </a>
          <button type="button" className={css.iconButton} onClick={props.onReload}>
            {props.t('panel.reload')}
          </button>
        </div>
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

      {/* 调度模式由输入框里选的模型决定（管家·自动 / 极致便宜 / 效率优先 / 最强火力 / 白嫖），
          设置页不再放一排永远和真实行为对不上的按钮，只把「现在是什么模式」说清楚。 */}
      <div className={css.settingsModes}>
        <div className={css.metricLabel}>{props.t('settings.mode')}</div>
        <p className={css.settingsModeLine} data-dsh-part="mode-line">
          <strong>{MODE_LABEL[snapshot?.mode ?? 'frugal']}</strong>
          <span>{MODE_HINT[snapshot?.mode ?? 'frugal']}</span>
        </p>
        <p className={css.vendorHint}>{props.t('settings.modeDecided')}</p>
      </div>

      <div className={css.settingsModeRow} role="tablist" aria-label={props.t('settings.sections')}>
        {SECTIONS.map((entry) => (
          <button
            key={entry}
            type="button"
            role="tab"
            aria-selected={section === entry}
            className={css.segment}
            data-active={section === entry ? 'true' : 'false'}
            data-dsh-part={'section-' + entry}
            onClick={() => { setSection(entry) }}
          >
            {props.t('sections.' + entry)}
          </button>
        ))}
      </div>

      <button
        type="button"
        className={css.agentEntry}
        data-dsh-part="agent-entry"
        onClick={() => { void copyText('agentPrompt', props.t('vendors.agentPrompt')) }}
      >
        ＋ {props.t('vendors.agentEntry')}
      </button>
      {copied === 'agentPrompt' ? <div className={css.vendorNotice}>{props.t('vendors.agentPromptCopied')}</div> : null}

      {section === 'freeload' ? <FreeloadSection snapshot={props.snapshot} t={props.t} /> : (
        <VendorsSection
          gateway={props.gateway}
          vendors={props.vendors}
          only={section}
          onSave={(vendors) => { props.onSaveVendors(vendors) }}
          onDiscover={props.onDiscover}
          onImportHarness={props.onImportHarness}
          onSyncHarness={props.onSyncHarness}
          onDeleteVendor={props.onDeleteVendor}
          onRefreshVendors={props.onRefreshVendors}
          t={props.t}
        />
      )}

      <p className={css.settingsHint}>{props.t('settings.hint')}</p>
    </section>
  )
}

// ── 白嫖模式 ────────────────────────────────────────────────────────

/**
 * 白嫖模式：只走零成本模型的那一档。
 *
 * 它不是「另一个调度模式按钮」，而是输入框里一个可选模型（管家·白嫖）。
 * 这里做两件事：说清楚它是什么，以及现在到底有哪些模型会被它用上——
 * 池子里一个零成本的都没有时，用户必须能立刻看出问题在哪。
 */
function FreeloadSection(props: { snapshot: MatrixSnapshot | undefined, t(key: string): string }): ReactNode {
  const t = props.t
  const free = (props.snapshot?.models ?? []).filter((model) => model.costLevel === 'free' && model.chat !== false)
  return (
    <div className={css.vendorsSection} data-dsh-part="freeload">
      <div className={css.metricLabel}>{t('sections.freeload')}</div>
      <p className={css.vendorNote} data-dsh-part="freeload-note">{t('freeload.desc')}</p>
      <div className={css.vendorStatus}>
        <span className={css.vendorStatusMain}>{t('freeload.count')} {String(free.length)}</span>
      </div>
      {free.length === 0 ? (
        <span className={css.vendorHint} data-dsh-part="freeload-empty">{t('freeload.empty')}</span>
      ) : (
        <div className={css.modelCardGrid} data-dsh-part="freeload-models">
          {free.map((model) => (
            <div key={model.provider + '/' + model.model} className={css.modelSwitchCard} data-on="true">
              <span className={css.modelSwitchName}>{model.displayName}</span>
              {/* 自定义厂家没有价目：标出来，别让人以为这是查到的官方免费额度。 */}
              {model.freeAssumed === true ? <span className={css.modelSwitchOn}>{t('freeload.assumed')}</span> : null}
              <code className={css.modelCheckId}>{model.provider + '/' + model.model}</code>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── 厂家配置区 ────────────────────────────────────────────────────────

function VendorsSection(props: {
  gateway: SettingsPanelProps['gateway']
  vendors: SettingsPanelProps['vendors']
  onSave(vendors: VendorConfig[]): void
  onDiscover(params: { vendor?: string, baseUrl?: string, apiKey?: string }): Promise<DiscoveredModel[]>
  onImportHarness(scope?: ImportScope): Promise<{ ok: boolean, imported: string[], error?: string }>
  /** 反向同步：把这家写回 DSH 的系统模型设置。 */
  onSyncHarness(vendorId: string): Promise<{ ok: boolean, file?: string, models?: number, error?: string }>
  /** 显式删除一家厂家。 */
  onDeleteVendor(vendorId: string): Promise<{ ok: boolean, error?: string }>
  onRefreshVendors?: (() => void) | undefined
  /** 只看某一组：厂家设置（含自定义）/ 免费池。 */
  only?: 'vendors' | 'free' | undefined
  t(key: string): string
}): ReactNode {
  const t = props.t
  const catalog = props.vendors?.catalog ?? catalogFromTemplates()
  const saved = props.vendors?.vendors ?? []

  /** 左栏分组：内置（目录厂商）+ 自定义（保存的自定义厂商 + 添加入口）。 */
  const groups = useMemo(() => {
    const catalogIds = new Set(catalog.map((vendor) => vendor.vendorId))
    const primary = VENDOR_TAB_ORDER.filter((id) => catalogIds.has(id))
    const restBuiltIn = catalog.map((vendor) => vendor.vendorId).filter((id) => !primary.includes(id))
    // 去重：历史数据可能留下同一个 id 的多条，左栏不该出现两个一样的自定义。
    const savedCustom = [...new Set(saved.filter((vendor) => !catalogIds.has(vendor.vendorId)).map((vendor) => vendor.vendorId))]
    // 免费池单独一节：这些厂商只在「极致便宜」档有意义，混在内置里只会挡住视线。
    const freeIds = PROVIDER_TEMPLATES.filter((vendor) => vendor.group === 'free').map((vendor) => vendor.vendorId)
    const builtIn = [...primary, ...restBuiltIn].filter((id) => !freeIds.includes(id))
    const pool = freeIds.filter((id) => !savedCustom.includes(id))
    // 免费池那一组单独成一个板块；其余（含自定义）都在「厂家设置」里。
    if (props.only === 'free') return [{ label: t('sections.free'), items: pool }]
    if (props.only === 'vendors') return [{ label: t('sections.vendors'), items: [...builtIn, ...savedCustom, NEW_TAB] }]
    return [
      { label: t('vendors.groupBuiltIn'), items: builtIn },
      { label: t('vendors.groupFree'), items: pool },
      { label: t('vendors.groupCustom'), items: [...savedCustom, NEW_TAB] },
    ]
  }, [catalog, saved, t, props.only])
  const tabs = useMemo(() => groups.flatMap((group) => group.items), [groups])

  const [activeTab, setActiveTab] = useState<TabId>(tabs[0] ?? NEW_TAB)
  const [drafts, setDrafts] = useState<Record<string, VendorDraft>>({})
  const [discovered, setDiscovered] = useState<Record<string, DiscoveredModel[]>>({})
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  /** 删除确认：第一次点只是「瞄准」，第二次才真的删——手滑删掉一家厂商代价太大。 */
  const [removeArmed, setRemoveArmed] = useState<TabId | undefined>(undefined)
  /** 用户主动取消勾选的型号（`tab/modelId`）。拉取时自动勾零成本模型，但不能把
      用户刚取消的又勾回来。 */
  const [dismissed, setDismissed] = useState<Record<string, true>>({})
  // 打开设置就把厂家列表拉一遍：宿主那边可能刚被 Agent 工具改过。
  useEffect(() => { props.onRefreshVendors?.() }, [])

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
    // 自定义厂家没有目录，地址只有「Base URL」这一个输入框：
    // 已经存下来的 officialUrl 要回填进去，否则表单是空的，一保存地址就没了。
    const officialOf = view?.officialUrl ?? template?.officialUrl ?? ''
    const relayOf = view?.customUrl ?? ''
    const survived = relayOf !== '' ? relayOf : (template === undefined ? officialOf : '')
    const source = view?.endpointSource ?? (relayOf !== '' ? 'relay' : 'official')
    return {
      vendorName: view?.vendorName ?? template?.vendorName ?? (tab === NEW_TAB ? '' : tab),
      customUrl: survived,
      // 官网那一路没有地址时不能停在这边：单选点是禁用的，用户会卡在一个空的表单里。
      endpointSource: source === 'official' && officialOf === '' ? 'relay' : source,
      apiKey: '',
      enabledModels: view?.enabledModels ?? [],
      modelTags: { ...(view?.modelTags ?? {}) },
      modelPricing: { ...(view?.modelPricing ?? {}) },
    }
  }

  /**
   * 这家当前该存下来的模型清单：刚拉取的优先，否则沿用上次保存的快照。
   *
   * 还要并上已勾选的型号——取消勾选只是「先不用它」，不等于「从清单里删掉」。
   * 少了这一步，用户点掉一个勾再保存，那张卡片就凭空消失了，想再勾回来都没处点。
   */
  function pulledFor(tab: TabId): Array<{ id: string, name: string }> {
    const fresh = discovered[tab]
    const base = fresh !== undefined
      ? fresh.map((entry) => ({ id: entry.id, name: entry.name }))
      : [...(savedBy.get(tab)?.pulledModels ?? [])]
    const byId = new Map(base.map((model) => [model.id, model] as const))
    // 已勾选的、以及上次保存时勾选过的，都要留着：取消勾选 ≠ 删除。
    const keep = [...(savedBy.get(tab)?.enabledModels ?? []), ...draftOf(tab).enabledModels]
    for (const id of keep) {
      if (!byId.has(id)) byId.set(id, { id, name: id })
    }
    return [...byId.values()]
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
      // 选官网就把目录里的官方地址带上（OpenCode Zen 这类还没保存过的厂商也能直接拉）；
      // 选中转站则只发中转地址。
      const params: { vendor?: string, baseUrl?: string, apiKey?: string } = {
        baseUrl: draft.endpointSource === 'relay' ? draft.customUrl.trim() : officialUrl,
      }
      if (tab !== NEW_TAB) params.vendor = tab
      if (draft.apiKey !== '') params.apiKey = draft.apiKey
      const discoveredModels = await props.onDiscover(params)
      setDiscovered((previous) => ({ ...previous, [tab]: discoveredModels }))
      // 拉取只负责「列出来」，**不**顺手把整份清单都勾上：上游动不动几十上百个模型，
      // 一次全勾会把路由池和模型菜单一起撑爆。只自动勾零成本模型——它们本来就该进白嫖，
      // 用户不用再一个个点。用户主动取消勾选的零成本模型不该被重新勾回来。
      if (tab !== NEW_TAB) {
        const freeIds = discoveredModels
          .filter((entry) => isFreePriced(entry.id) && dismissed[tab + '/' + entry.id] !== true)
          .map((entry) => entry.id)
        const merged = [...new Set([...draft.enabledModels, ...freeIds])]
        if (merged.length !== draft.enabledModels.length) updateDraft(tab, { enabledModels: merged })
      }
    } catch (error) {
      setNotice(t('vendors.fetchFailed') + ': ' + (error instanceof Error ? error.message : String(error)))
    } finally {
      setBusy(false)
    }
  }

  /** 反向同步：把这家勾好的型号写回 DSH 的系统模型设置（profile 的 llm-pi-ai）。 */
  async function syncToSystem(tab: TabId): Promise<void> {
    if (tab === NEW_TAB) return
    setBusy(true)
    setNotice(undefined)
    try {
      const result = await props.onSyncHarness(tab)
      setNotice(result.ok
        ? t('vendors.synced') + ' ' + String(result.models ?? 0)
        : (result.error ?? t('vendors.syncFailed')))
    } catch (error) {
      setNotice(t('vendors.syncFailed') + ': ' + (error instanceof Error ? error.message : String(error)))
    } finally {
      setBusy(false)
    }
  }

  /** 这家现在实际用的地址（官网或中转），也是「从系统导入」时比对的依据。 */
  function endpointOf(tab: TabId): string {
    const draft = draftOf(tab)
    if (draft.endpointSource === 'relay' && draft.customUrl.trim() !== '') return draft.customUrl.trim()
    if (tab === NEW_TAB) return draft.customUrl.trim()
    return catalog.find((vendor) => vendor.vendorId === tab)?.officialUrl
      ?? savedBy.get(tab)?.officialUrl
      ?? ''
  }

  /**
   * 把 DSH 里已经配好的这一家抓过来（地址 / 密钥 / 模型清单都是现成的）。
   *
   * 只拉当前这一家：按 provider id 和地址（规范化后）比对 profile，对不上的不碰。
   * 整份导入会把所有上游的几十上百个模型一起塞进来，那正是用户不想要的那种「太多」。
   */
  async function importExisting(tab: TabId): Promise<void> {
    const baseUrl = endpointOf(tab)
    if (tab === NEW_TAB && baseUrl === '') {
      setNotice(t('vendors.importNeedUrl'))
      return
    }
    setBusy(true)
    setNotice(undefined)
    try {
      const result = await props.onImportHarness({
        ...(tab === NEW_TAB ? {} : { vendorId: tab }),
        baseUrl,
      })
      if (!result.ok) {
        setNotice(result.error ?? t('vendors.importNone'))
        return
      }
      const first = result.imported[0]
      // 导入改的是宿主的配置：这两家的本地草稿必须丢掉，否则表单还停在旧地址上。
      setDrafts((previous) => {
        const next = { ...previous }
        delete next[tab]
        if (first !== undefined) delete next[first]
        return next
      })
      if (first !== undefined) setActiveTab(first)
      setNotice(t('vendors.imported') + ' ' + String(result.imported.length) + ' · ' + result.imported.join(' / '))
    } catch (error) {
      setNotice(t('vendors.fetchFailed') + ': ' + (error instanceof Error ? error.message : String(error)))
    } finally {
      setBusy(false)
    }
  }

  /** 覆盖某个模型的价目；清空任意一栏 = 恢复目录估算价。 */
  function setPrice(tab: TabId, modelId: string, field: 'input' | 'output', raw: string): void {
    const draft = draftOf(tab)
    const next = { ...draft.modelPricing }
    const parsed = raw === '' ? null : Number(raw)
    if (parsed === null || !Number.isFinite(parsed) || parsed < 0) {
      delete next[modelId]
      updateDraft(tab, { modelPricing: next })
      return
    }
    const catalog = listPriceOf(modelId)
    const current = next[modelId] ?? { input: catalog?.input ?? 0, output: catalog?.output ?? 0 }
    next[modelId] = { ...current, [field]: parsed }
    updateDraft(tab, { modelPricing: next })
  }

  function toggleModel(tab: TabId, modelId: string): void {
    const draft = draftOf(tab)
    const turningOff = draft.enabledModels.includes(modelId)
    const next = turningOff
      ? draft.enabledModels.filter((id) => id !== modelId)
      : [...draft.enabledModels, modelId]
    // 取消勾选要记住：下一次「拉取模型」不该把它自动勾回来。
    setDismissed((previous) => {
      const key = tab + '/' + modelId
      if (turningOff) return { ...previous, [key]: true }
      if (previous[key] === undefined) return previous
      const copy = { ...previous }
      delete copy[key]
      return copy
    })
    updateDraft(tab, { enabledModels: next })
  }

  function saveVendor(tab: TabId): void {
    const draft = draftOf(tab)
    const view = savedBy.get(tab)
    // 自定义厂商必须各自独立：同名（都叫 Custom）时自动加序号，
    // 否则两家会挤在同一个 vendorId 上，改一个另一个跟着变。
    let vendorId = tab === NEW_TAB ? slugOf(draft.vendorName || 'custom') : tab
    if (tab === NEW_TAB) {
      // 占位表里既有已保存厂商，也有目录厂商：自定义厂商不能顶替内置的 id。
      const taken = new Set<string>([
        ...saved.map((entry) => entry.vendorId),
        ...catalog.map((entry) => entry.vendorId),
      ])
      const base = vendorId
      let suffix = 2
      while (taken.has(vendorId)) {
        vendorId = base + '-' + String(suffix)
        suffix += 1
      }
    }
    const template = catalog.find((vendor) => vendor.vendorId === vendorId)
    const config: VendorConfig = {
      vendorId,
      vendorName: draft.vendorName !== '' ? draft.vendorName : template?.vendorName ?? vendorId,
      // 自定义厂家的 officialUrl 是它自己的地址（从系统导入时写进来的那个）。
      // 以前这里直接写 ''，每保存一次就把地址抹掉，厂家当场变得不可路由——
      // 模型还在清单里，池子里却一个都没有。
      officialUrl: template?.officialUrl ?? savedBy.get(vendorId)?.officialUrl ?? '',
      customUrl: draft.customUrl,
      endpointSource: draft.endpointSource,
      // 空串 = 保留已存明文（掩码回显绝不回传）。
      apiKey: draft.apiKey,
      enabledModels: [...draft.enabledModels],
      pulledModels: pulledFor(vendorId),
      modelTags: { ...draft.modelTags },
      modelPricing: { ...draft.modelPricing },
    }
    void view
    // 保留模式跟随当前全局模式（模式切换有自己的持久化通道）。
    const mode = props.vendors?.mode ?? 'frugal'
    const others = saved.filter((entry) => entry.vendorId !== vendorId).map((entry) => toConfig(entry))
    const next = [...others, config]
    props.onSave(next.map((entry) => (entry.vendorId === vendorId ? { ...entry, apiKey: draft.apiKey } : entry)))
    // 白嫖模式最怕「改完不知道它还认不认」：保存时直接把结果说出来。
    if (mode === 'free') {
      setNotice(t('vendors.savedFree').replace('{n}', String(countZeroCost(next))))
    }
    if (tab === NEW_TAB) {
      // 新建成功后这张草稿已经落成真正的厂商，清掉它并跟过去，避免留下第二份。
      setDrafts((previous) => {
        const next = { ...previous }
        delete next[NEW_TAB]
        return next
      })
      setActiveTab(vendorId)
    } else {
      setDrafts((previous) => ({ ...previous, [tab]: { ...draft, apiKey: '' } }))
    }
    setNotice(t('vendors.saved'))
  }

  /** 把一家厂商整条从配置里删掉（模型、密钥、价目一起走）。 */
  function removeVendor(tab: TabId): void {
    if (removeArmed !== tab) {
      setRemoveArmed(tab)
      setNotice(undefined)
      return
    }
    // 走显式删除接口：保存是「合并」，永远不该顺带把别家删掉。
    // 必须等宿主回话再动界面：删失败时把表单清掉、报「已删除」，比不删还糟。
    setRemoveArmed(undefined)
    setBusy(true)
    void props.onDeleteVendor(tab)
      .then((result) => {
        if (!result.ok) {
          setNotice(result.error ?? t('vendors.removeFailed'))
          return
        }
        setDrafts((previous) => {
          const next = { ...previous }
          delete next[tab]
          return next
        })
        setNotice(t('vendors.removed'))
        setActiveTab(tabs.find((entry) => entry !== tab) ?? NEW_TAB)
        // 宿主那份配置已经变了，立刻重拉一次，别等下一次轮询。
        props.onRefreshVendors?.()
      })
      .catch((error: unknown) => {
        setNotice(t('vendors.removeFailed') + ': ' + (error instanceof Error ? error.message : String(error)))
      })
      .finally(() => { setBusy(false) })
  }

  const draft = draftOf(activeTab)
  const vendorBackdrop = bundledAvatarUrl(activeTab)
  const officialUrl = catalog.find((vendor) => vendor.vendorId === activeTab)?.officialUrl
    ?? savedBy.get(activeTab)?.officialUrl
    ?? ''
  // 官网（去哪家申请 key）：目录里写死的静态地址，自定义厂商没有。
  const homepageUrl = PROVIDER_TEMPLATES.find((vendor) => vendor.vendorId === activeTab)?.homepage
    ?? catalog.find((vendor) => vendor.vendorId === activeTab)?.homepage
    ?? ''
  const activeMeta = PROVIDER_TEMPLATES.find((vendor) => vendor.vendorId === activeTab)
  const discoveredList = discovered[activeTab]
  // 卡片只来自真实拉取结果（或上次拉取的快照）。内置目录不再冒充「这家有哪些模型」：
  // 编一张清单出来，用户勾了也未必存在，等于在配置一个不存在的上游。
  const checkList: Array<{ id: string, name: string, tier: string, inCatalog: boolean }> =
    discoveredList ??
    (activeTab === NEW_TAB
      ? []
      : (savedBy.get(activeTab)?.pulledModels ?? []).map((entry) => {
        const known = activeMeta !== undefined
          ? matchTemplateModel(activeMeta, entry.id)
          : findModelProfile(entry.id)?.model
        return { id: entry.id, name: entry.name, tier: known?.tier ?? 'NA', inCatalog: known !== undefined }
      }))
  // 已保存的型号必须一直在列表里：勾过的 id 已经写进 vendors.json，
  // 列表里却看不到它们才是最吓人的。
  const listed = new Set(checkList.map((entry) => entry.id))
  // 草稿里勾过的 + 上次保存时勾过但现在取消掉的：都要留在列表里，否则一取消勾选
  // 卡片就没了，想再勾回来都找不到入口。
  const keepListed = [...draft.enabledModels, ...(savedBy.get(activeTab)?.enabledModels ?? [])]
  for (const id of keepListed) {
    if (!listed.has(id)) {
      listed.add(id)
      const known = activeMeta !== undefined ? matchTemplateModel(activeMeta, id) : findModelProfile(id)?.model
      checkList.push({ id, name: known?.name ?? id, tier: known?.tier ?? 'NA', inCatalog: known !== undefined })
    }
  }

  // 全池一共加进来多少个模型：用户在左栏点了一圈之后，需要一个总数确认结果。
  const totalPicked = saved.reduce((sum, vendor) => sum + vendor.enabledModels.length, 0)

  return (
    <div className={css.vendorsSection} data-dsh-part="vendors">
      {/* 头像只在「官方地址」那一行出现一次，32px、不虚化：
          整块背景会把表单文字染成一片，既不清晰也不利于读数。 */}
      <div className={css.metricLabel}>
        {t('vendors.title')}
        {totalPicked > 0 ? (
          <span className={css.vendorTotal} data-dsh-part="vendor-total">
            {t('vendors.totalPicked')} {String(totalPicked)} {t('vendors.totalUnit')}
          </span>
        ) : null}
      </div>

      <div className={css.vendorLayout}>
        <nav className={css.vendorNav} role="tablist" aria-orientation="vertical">
          {groups.map((group) => (
            <div key={group.label} className={css.vendorNavGroup}>
              <div className={css.vendorNavGroupLabel}>{group.label}</div>
              {group.items.map((tab) => {
                const label = tab === NEW_TAB
                  ? '＋ ' + t('vendors.tabCustom')
                  : catalog.find((vendor) => vendor.vendorId === tab)?.vendorName
                    ?? savedBy.get(tab)?.vendorName
                    ?? tab
                // 左栏直接读出「这家配没配、已经加了几个模型」——不用点进去才知道。
                const view = savedBy.get(tab)
                const picked = view?.enabledModels.length ?? 0
                const ready = view !== undefined && view.hasKey && picked > 0
                return (
                  <button
                    key={tab}
                    type="button"
                    role="tab"
                    aria-selected={activeTab === tab}
                    className={css.vendorNavItem}
                    data-active={activeTab === tab ? 'true' : 'false'}
                    data-ready={ready ? 'true' : 'false'}
                    onClick={() => { setActiveTab(tab); setNotice(undefined); setRemoveArmed(undefined) }}
                  >
                    <span className={css.vendorNavDot} aria-hidden="true" />
                    <span className={css.vendorNavLabel}>{label}</span>
                    {picked > 0 ? <span className={css.vendorNavCount}>{picked}</span> : null}
                  </button>
                )
              })}
            </div>
          ))}
        </nav>

        <div className={css.vendorPane}>
      {/* 已经加进池子的模型数 + 密钥状态：和左栏的小圆点同源，一眼看出还差什么。 */}
      <div className={css.vendorStatus} data-dsh-part="vendor-status">
        <span className={css.vendorStatusMain}>
          {draft.enabledModels.length > 0
            ? t('vendors.selected') + ' ' + String(draft.enabledModels.length)
            : t('vendors.notSelected')}
        </span>
        <span className={css.vendorStatusDot} data-on={savedBy.get(activeTab)?.hasKey === true ? 'true' : 'false'} aria-hidden="true" />
        {/* 清单公开的厂商（OpenCode Zen）：没 key 也能拉模型，说「未填密钥」只会误导。 */}
        <span>{savedBy.get(activeTab)?.hasKey === true
          ? t('vendors.keySaved')
          : activeMeta?.publicModels === true ? t('vendors.keyOptional') : t('vendors.keyMissing')}</span>
      </div>

      {/* 这家是什么、要不要 key —— 尤其是本机转发口那两家，不解释没人知道。 */}
      {PROVIDER_TEMPLATES.find((vendor) => vendor.vendorId === activeTab)?.note === undefined ? null : (
        <p className={css.vendorNote} data-dsh-part="vendor-note">
          {PROVIDER_TEMPLATES.find((vendor) => vendor.vendorId === activeTab)?.note}
        </p>
      )}
      {/* 官网链接：申请 key 要去的地方。没有链接的话，用户搜到的大半是别人的中转站。 */}
      {homepageUrl === '' ? null : (
        <a
          className={css.vendorLink}
          href={homepageUrl}
          target="_blank"
          rel="noreferrer"
          data-dsh-part="vendor-home"
        >
          {t('vendors.homepage')} ↗
        </a>
      )}
      {catalog.find((vendor) => vendor.vendorId === activeTab) === undefined ? (
        <label className={css.vendorField}>
          <span className={css.metricLabel}>{t('vendors.customName')}</span>
          <input
            className={css.vendorInput}
            value={draft.vendorName}
            onChange={(event) => { updateDraft(activeTab, { vendorName: event.target.value }) }}
            placeholder="Doubao"
          />
        </label>
      ) : null}

      {/* 线路二选一：右边两个点就是单选。选官网时中转站输入框置灰，
          不会出现「两行都在、到底用哪个」的歧义。 */}
      <div className={css.endpointRow} data-dsh-part="endpoint-official">
        {/* 一个厂家一张头像：小、清楚、就在这一行的开头，认得出是谁。 */}
        {vendorBackdrop === undefined ? null : (
          <img className={css.vendorFace} src={vendorBackdrop} alt="" aria-hidden="true" />
        )}
        <span className={css.metricLabel}>{t('vendors.officialUrl')}</span>
        <code className={css.vendorOfficial} data-dsh-part="official-url">{officialUrl === '' ? '—' : officialUrl}</code>
        <button
          type="button"
          role="radio"
          aria-checked={draft.endpointSource === 'official'}
          aria-label={t('vendors.useOfficial')}
          className={css.endpointDot}
          data-active={draft.endpointSource === 'official'}
          disabled={officialUrl === ''}
          onClick={() => { updateDraft(activeTab, { endpointSource: 'official' }) }}
        />
      </div>

      {PROVIDER_TEMPLATES.find((vendor) => vendor.vendorId === activeTab)?.noRelay === true ? null : (
      <div className={css.endpointRow} data-dsh-part="endpoint-relay">
        <span className={css.metricLabel}>{t('vendors.baseUrl')}</span>
        <input
          className={css.vendorInput}
          value={draft.customUrl}
          disabled={draft.endpointSource !== 'relay'}
          onChange={(event) => { updateDraft(activeTab, { customUrl: event.target.value }) }}
          placeholder="https://relay.example.com/v1"
        />
        <button
          type="button"
          role="radio"
          aria-checked={draft.endpointSource === 'relay'}
          aria-label={t('vendors.useRelay')}
          className={css.endpointDot}
          data-active={draft.endpointSource === 'relay'}
          onClick={() => { updateDraft(activeTab, { endpointSource: 'relay' }) }}
        />
      </div>
      )}

      {/* 模型清单公开的厂商（OpenCode Zen）：不用密钥就能先看有什么模型。 */}
      {PROVIDER_TEMPLATES.find((vendor) => vendor.vendorId === activeTab)?.publicModels === true ? (
        <span className={css.vendorHint}>{t('vendors.publicModels')}</span>
      ) : null}

      {/* 红字防封警告固定在 API Key 正上方（产品红线）。
          只对 Anthropic 出现：官方账号直连的封号风险是它独有的，
          其余厂商（尤其是中转站）没有这层限制，不该挂红条吓人。 */}
      {activeTab === 'anthropic' ? (
        <div className={css.banWarning} data-tone="danger" data-dsh-part="ban-warning" role="alert">
          {t('vendors.anthropicWarning')}
        </div>
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
      {/* 已存的密钥一直留着（留空 = 不改），这里把掩码明写出来，
          免得用户以为空输入框代表「key 丢了」，重新填一遍反而覆盖成新的。 */}
      {savedBy.get(activeTab)?.hasKey === true && draft.apiKey === '' ? (
        <span className={css.vendorHint} data-dsh-part="vendor-key-kept">
          {t('vendors.keyKept')} <code>{savedBy.get(activeTab)?.apiKeyMasked}</code>
        </span>
      ) : null}

      <div className={css.vendorActions}>
        <button type="button" className={css.vendorButton} disabled={busy} onClick={() => { void fetchModels(activeTab) }}>
          {t('vendors.fetch')}
        </button>
        <button
          type="button"
          className={css.vendorButton}
          data-dsh-part="import-harness"
          disabled={busy}
          title={t('vendors.importHint')}
          onClick={() => { void importExisting(activeTab) }}
        >
          {t('vendors.importExisting')}
        </button>
        <button
          type="button"
          className={css.vendorButton}
          data-dsh-part="sync-harness"
          disabled={busy || activeTab === NEW_TAB}
          title={t('vendors.syncHint')}
          onClick={() => { void syncToSystem(activeTab) }}
        >
          {t('vendors.sync')}
        </button>
        <button type="button" className={css.vendorButton} data-tone="primary" disabled={busy} onClick={() => { saveVendor(activeTab) }}>
          {t('vendors.save')}
        </button>
        {/* 只有自定义厂家能删：内置厂家的存在是产品的一部分，删了下次还会出现在列表里，
            留着按钮只会让人以为删干净了。 */}
        {activeTab !== NEW_TAB
          && savedBy.get(activeTab) !== undefined
          && !catalog.some((vendor) => vendor.vendorId === activeTab) ? (
          <button
            type="button"
            className={css.vendorButton}
            data-tone="danger"
            data-armed={removeArmed === activeTab ? 'true' : 'false'}
            data-dsh-part="vendor-remove"
            disabled={busy}
            onClick={() => { removeVendor(activeTab) }}
          >
            {removeArmed === activeTab ? t('vendors.removeConfirm') : t('vendors.remove')}
          </button>
        ) : null}
        {notice !== undefined ? <span className={css.vendorNotice}>{notice}</span> : null}
      </div>

      {checkList.length === 0 ? (
        <span className={css.vendorHint} data-dsh-part="vendor-pull-first">{t('vendors.pullFirst')}</span>
      ) : null}

      {checkList.length > 0 ? (
        <div className={css.modelCardGrid} data-dsh-part="vendor-models">
          {checkList.map((entry) => {
            // 标注来自本地静态目录（与宿主同源），匹配走归一化（上游 id 与目录 id 的分隔符可能不同）。
            const activeTemplate = PROVIDER_TEMPLATES.find((vendor) => vendor.vendorId === activeTab)
            // 自定义厂商没有目录节：再去全域目录里找，内置的强度/擅长照样能显示。
            const template = activeTemplate !== undefined
              ? matchTemplateModel(activeTemplate, entry.id)
              : findModelProfile(entry.id)?.model
            const badges: string[] = []
            if (template?.imageInput === true) badges.push(t('models.imageInput'))
            if (template?.imageOutput === true) badges.push(t('models.imageOutput'))
            if (template?.videoOutput === true) badges.push(t('models.videoOutput'))
            const multimodal = template?.imageInput === true || template?.imageOutput === true || template?.videoOutput === true
              || template?.capabilities.includes('vision') === true
            if (multimodal) badges.unshift(t('models.multimodal'))
            const enabled = draft.enabledModels.includes(entry.id)
            const userTags = draft.modelTags[entry.id] ?? []
            const catalogPrice = listPriceOf(entry.id)
            const price = draft.modelPricing[entry.id]
            return (
              <div key={entry.id} className={css.modelSwitchCard} data-on={enabled ? 'true' : 'false'}>
                <label className={css.modelSwitchHead}>
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={() => { toggleModel(activeTab, entry.id) }}
                  />
                  <span className={css.modelSwitchName}>{entry.name}</span>
                  {enabled ? <span className={css.modelSwitchOn}>{t('vendors.enabledTag')}</span> : null}
                  {/* 白嫖到底认不认这个型号，勾上就告诉你：价目 0 / 目录零价 / 名字带 free。 */}
                  {enabled && (price !== undefined
                    ? price.input === 0 && price.output === 0
                    : isFreePriced(entry.id) || /(^|[-_.])free$/i.test(entry.id))
                    ? <span className={css.modelSwitchOn} data-tone="free">{t('vendors.freeBadge')}</span>
                    : null}
                </label>
                {badges.length > 0 ? (
                  <span className={css.modelCheckBadges}>
                    {badges.map((badge) => <span key={badge} className={css.chip}>{badge}</span>)}
                  </span>
                ) : null}
                <code className={css.modelCheckId}>{entry.id}</code>
                {entry.inCatalog ? null : <input
                  className={css.vendorInput}
                  value={userTags.join(', ')}
                  placeholder={t('vendors.tagPlaceholder')}
                  onClick={(event) => { event.preventDefault() }}
                  onChange={(event) => {
                    const tags = event.target.value.split(/[,，]/).map((tag) => tag.trim()).filter((tag) => tag !== '')
                    updateDraft(activeTab, { modelTags: { ...draft.modelTags, [entry.id]: tags } })
                  }}
                />}
                <div className={css.priceRow} title={t('vendors.priceTitle')}>
                  <span className={css.priceTitle}>{t('vendors.priceIn')}</span>
                  <input
                    className={css.priceInput}
                    type="number"
                    min="0"
                    step="0.01"
                    aria-label={t('vendors.priceIn')}
                    value={price?.input ?? ''}
                    placeholder={catalogPrice === undefined ? '—' : String(catalogPrice.input)}
                    onClick={(event) => { event.preventDefault() }}
                    onChange={(event) => { setPrice(activeTab, entry.id, 'input', event.target.value) }}
                  />
                  <span className={css.priceTitle}>{t('vendors.priceOut')}</span>
                  <input
                    className={css.priceInput}
                    type="number"
                    min="0"
                    step="0.01"
                    aria-label={t('vendors.priceOut')}
                    value={price?.output ?? ''}
                    placeholder={catalogPrice === undefined ? '—' : String(catalogPrice.output)}
                    onClick={(event) => { event.preventDefault() }}
                    onChange={(event) => { setPrice(activeTab, entry.id, 'output', event.target.value) }}
                  />
                  <span className={css.priceUnit}>USD/1M</span>
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        activeTab === NEW_TAB ? (
          <label className={css.vendorField}>
            <span className={css.metricLabel}>{t('vendors.manualIds')}</span>
            <textarea
              className={css.vendorInput}
              rows={3}
              value={draft.enabledModels.join('\n')}
              onChange={(event) => {
                const ids = event.target.value.split(/[\n,]/).map((id) => id.trim()).filter((id) => id !== '')
                updateDraft(activeTab, { enabledModels: ids })
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
/**
 * 这一份配置里白嫖模式真正能用的模型数（零价目 / 目录零价 / 名字带 free）。
 * 保存后立刻回显，省得用户改完还在猜「白嫖到底认不认」。
 */
function countZeroCost(vendors: VendorConfig[]): number {
  let total = 0
  for (const vendor of vendors) {
    for (const id of vendor.enabledModels) {
      const price = vendor.modelPricing?.[id]
      if (price !== undefined) {
        if (price.input === 0 && price.output === 0) total += 1
        continue
      }
      if (isFreePriced(id) || /(^|[-_.])free$/i.test(id)) total += 1
    }
  }
  return total
}

function toConfig(view: VendorView): VendorConfig {
  return {
    vendorId: view.vendorId,
    vendorName: view.vendorName,
    officialUrl: view.officialUrl,
    customUrl: view.customUrl,
    endpointSource: view.endpointSource ?? (view.customUrl !== '' ? 'relay' : 'official'),
    apiKey: '',
    enabledModels: [...view.enabledModels],
    ...(view.pulledModels === undefined ? {} : { pulledModels: view.pulledModels.map((model) => ({ ...model })) }),
    modelTags: { ...view.modelTags },
    modelPricing: { ...view.modelPricing },
  }
}

/** 宿主未返回目录时的本地回退（静态模板就在包里）。 */
function catalogFromTemplates(): CatalogVendor[] {
  return PROVIDER_TEMPLATES.map((vendor) => ({
    vendorId: vendor.vendorId,
    vendorName: vendor.vendorName,
    officialUrl: vendor.officialUrl,
    ...(vendor.homepage === undefined ? {} : { homepage: vendor.homepage }),
    // 目录只负责厂商信息（地址 / 官网 / 说明），模型清单一律以拉取结果为准。
    models: [],
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
