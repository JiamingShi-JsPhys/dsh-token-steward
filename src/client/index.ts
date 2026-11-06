/**
 * dsh-token-steward · Client 半区。
 *
 * 注册两个席位，都被 ctx.effect 完整回收：
 *  - `shell.overlay`（官方 ui-layout 声明的 root 列表席位）：悬浮球 + 展开面板；
 *  - `settings.section`（官方 settings 声明的列表席位）：配置与接线页。
 *
 * 球与面板共享同一个 store 与同一个 React root，因此不会出现「球在、面板
 * 找不到它的状态」这类分裂；设置页是低频界面，用独立 store，打开才拉数据。
 *
 * 席位读取失败不致命：`shell.overlay` 只有 dsh-client-ui-layout 在场时才存在，
 * 而设置页在 ui-settings 缺席时就没有落点。两种情况下另一侧照常工作。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// 类型合并：拉进 ctx.locale / ctx.slots 与席位名。
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { createElement, useEffect, useReducer, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createPanelClient } from './api.ts'
import { createPanelStore, type PanelStore } from './store.ts'
import { NS, en, zh } from './locales.ts'
import { StewardBall } from './components/StewardBall.tsx'
import { StewardPanel } from './components/StewardPanel.tsx'
import { SettingsPanel } from './settings/SettingsPanel.tsx'

export const name = 'dsh-token-steward'

/** 必需服务：席位注册表与本地化（都来自渲染器与 locale 插件的 Context 合并）。 */
export const inject = ['slots', 'locale'] as const

/** 两个席位名。 */
export const OVERLAY_SEAT = 'shell.overlay'
export const SETTINGS_SEAT = 'settings.section'

/** 设置页在该席位里的 id（设置导航据此定位）。 */
export const SETTINGS_SECTION_ID = 'token-steward'

/** 设置导航里的排序权重；dsh-usage 占 100，这里排在它之后。 */
export const SETTINGS_SECTION_ORDER = 140

/** 倒计时刷新频率；只有面板打开时才走。 */
const TICK_MS = 1_000

/** 应用。 */
export function apply(ctx: ClientContext): void {
  // 与全家桶一致：register 一次，bind 拿到该命名空间的取词函数。
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'steward: locale')
  const translate = (key: string): string => {
    try {
      return ctx.locale.bind(NS)(key)
    } catch {
      // 语言插件尚未就绪时退回中文键源，界面不会出现空白按钮。
      return (zh as Record<string, string>)[key] ?? key
    }
  }

  mountOverlay(ctx, translate)
  mountSettings(ctx, translate)
}

/** 悬浮球与面板。 */
function mountOverlay(ctx: ClientContext, translate: (key: string) => string): void {
  ctx.effect(() => {
    const store: PanelStore = createPanelStore(createPanelClient())
    let root: Root | undefined
    let container: HTMLElement | undefined
    let ticker: ReturnType<typeof setInterval> | undefined
    let now = Date.now()

    function render(): ReactElement {
      const state = store.getState()
      return createElement('div', { 'data-dsh-plugin': 'token-steward' },
        createElement(StewardBall, {
          snapshot: state.snapshot,
          open: state.open,
          t: translate,
          onToggle: () => { store.setOpen(!state.open) },
          onCycleMode: (mode) => { void store.setMode(mode) },
        }),
        state.open
          ? createElement(StewardPanel, { state, store, t: translate, now, onClose: () => { store.setOpen(false) } })
          : null,
      ) as ReactElement
    }

    /** 只在面板打开时推进时间，否则倒计时没有观众。 */
    function syncTicker(): void {
      const shouldTick = store.getState().open
      if (shouldTick && ticker === undefined) {
        ticker = setInterval(() => {
          now = Date.now()
          root?.render(render())
        }, TICK_MS)
      } else if (!shouldTick && ticker !== undefined) {
        clearInterval(ticker)
        ticker = undefined
      }
    }

    function draw(): void {
      if (root === undefined) return
      now = Date.now()
      root.render(render())
      syncTicker()
    }

    return ctx.slots.inject(OVERLAY_SEAT, () => {
      container = document.createElement('div')
      container.setAttribute('data-dsh-steward-root', '')
      document.body.appendChild(container)
      root = createRoot(container)
      const unsubscribe = store.subscribe(draw)
      store.start()

      const onVisibility = (): void => { store.setVisible(document.visibilityState === 'visible') }
      document.addEventListener('visibilitychange', onVisibility)
      draw()

      return () => {
        document.removeEventListener('visibilitychange', onVisibility)
        unsubscribe()
        store.stop()
        if (ticker !== undefined) clearInterval(ticker)
        ticker = undefined
        root?.unmount()
        root = undefined
        container?.remove()
        container = undefined
      }
    })
  }, 'steward: overlay entry')
}

/** 设置页：低频界面，打开时才拉数据。 */
function mountSettings(ctx: ClientContext, translate: (key: string) => string): void {
  ctx.effect(() => {
    const store: PanelStore = createPanelStore(createPanelClient())
    store.start()
    void store.refreshVendors()

    function SettingsSection(): ReactElement {
      // 设置页是 React 组件，store 却在 React 之外。不订阅的话，宿主数据变了
      // （删掉一家、导入一家、保存之后）组件不会重渲染，左栏还挂着已经删掉的那一家——
      // 用户看到的就是「删除键没反应」。这里把 store 的通知接进 React 的渲染周期。
      const [, bump] = useReducer((n: number) => n + 1, 0)
      useEffect(() => store.subscribe(() => { bump() }), [])
      // 打开设置页就取一次最新数据：快照只在悬浮面板展开时轮询，
      // 靠它自己更新的话，白嫖页读到的可能是很久以前的入池结果。
      useEffect(() => {
        void Promise.all([store.refresh(), store.refreshVendors(), store.refreshGateway()])
      }, [])
      const state = store.getState()
      return createElement(SettingsPanel, {
        snapshot: state.snapshot,
        gateway: state.gateway,
        poolPath: state.snapshot?.pool.source ?? 'model_pool.yaml',
        // 台账保留天数由宿主如实报上来；拿不到时才退回配置默认值。
        retainDays: state.snapshot?.retentionDays ?? 180,
        vendors: state.vendors,
        onReload: () => { void store.reload() },
        onRefreshAll: () => { void store.refreshAll() },
        onRefreshData: () => { void Promise.all([store.refresh(), store.refreshVendors()]) },
        onRefreshVendors: () => { void store.refreshVendors() },
        onSelectMode: (mode) => { void store.setMode(mode) },
        onSaveVendors: (vendors) => { void store.saveVendors(state.vendors?.mode ?? 'frugal', vendors) },
        onDiscover: (params) => store.discoverModels(params),
        onImportHarness: (scope) => store.importHarness(scope),
        onSyncHarness: (vendorId) => store.syncHarness(vendorId),
        onDeleteVendor: (vendorId) => store.deleteVendor(vendorId),
        t: translate,
      }) as ReactElement
    }

    // label 与 order 决定设置导航里那一行怎么显示、排在哪。
    const dispose = ctx.slots.inject(SETTINGS_SEAT, () => ctx.slots.register({
      name: SETTINGS_SEAT,
      id: SETTINGS_SECTION_ID,
      order: SETTINGS_SECTION_ORDER,
      label: () => translate('settings.nav'),
      locale: NS,
    }, SettingsSection))

    return () => {
      dispose()
      store.stop()
    }
  }, 'steward: settings section')
}
