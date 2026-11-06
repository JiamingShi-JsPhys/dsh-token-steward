# dsh-token-steward · Client 端 UI 组件拆分计划

> 标杆：本机已安装的 `@linxin666` 全家桶（v0.4.12）。下文每条结论都标注了它的出处文件。

## 一、扒到的真实骨架（不是猜的）

| 事实 | 出处 |
|---|---|
| 悬浮球**不走** `shell.overlay`，直接在 `document.body` 上挂一个 `div[data-dsh-plugin="pet"]` + 独立 React root | `dsh-pet/src/client/index.ts` L615-640 |
| 悬浮球显隐两态：可见渲染 sprite，隐藏渲染召唤按钮；拖拽结束后持久化 `right/bottom` | `dsh-pet/src/client/PetDockEntry.tsx`、`pet-store.ts` |
| `shell.overlay` 是官方 layout 声明的 `{ kind: 'list', scope: 'root' }`，渲染在 `div.overlayLayer[data-shell-overlay]` | `dsh-client-ui-layout/client.js` L233-240 / L420 |
| 设置页走 `ctx.slots.register({ name: 'settings.section', id })`，用 `installWebExtensionPage` 注册 | `dsh-usage/src/client/section-integration.ts` |
| 侧栏底部入口走 `sidebar.footer.action`（`dsh-update`、`dsh-remote-web-ui` 同款） | `dsh-web-all` 依赖包 · `dsh-client-ui-cordis/client.js` |
| 分段控件是「滑动高亮药丸」：`SegmentGroup` 测 active 按钮盒模型写 4 个 CSS 变量 | `dsh-pet/src/client/SegmentGroup.tsx` |
| 设置卡三件套：`PluginSettingsCard.tsx`（外壳）+ `settings-form.ts`（ConfigForm 控制器）+ `settings-card.module.css` | 各包内为 `scripts/sync-shared.mjs` 生成的同步副本 |
| 主题变量体系（实测提取自 `settings-card.module.css`） | `--dsw-alias-bg-layer-2/3`、`--dsw-alias-bg-overlay`、`--dsw-alias-bg-mask-2`、`--dsw-alias-border-l2`、`--dsw-alias-label-primary/secondary/tertiary/dimmed`、`--dsw-alias-label-primary-foreground`、`--dsw-alias-interactive-bg-hover`、`--dsw-alias-brand-primary`、`--dsw-alias-button-primary-fill`、`--dsw-alias-state-error-primary`、`--dsw-alias-state-warn-primary` |

**结论**：全家桶的「悬浮球展开面板」实际由 pets 插件提供，不是 `dsh-web-all` 本体（它是聚合层，`lib/client.js` 只做 frame/CSS 适配）。我们把球与面板照 pet 的挂载方式做，把设置卡照 `dsh-usage` 的方式做，把分段控件与卡片外壳照 `PluginSettingsCard` 三件套做——视觉与交互就和原生一致。

## 二、文件清单（src/client/）

```
src/client/
  index.ts                  apply(ctx)：locale.register + 三处注册（overlay / settings.section / footer.action）+ ctx.effect 清理
  api.ts                    同源 JSON 客户端：api/token-steward/{snapshot,mode,pool,route-log}
  ui-store.ts               useSyncExternalStore 快照仓库（revision 单调、乱序丢弃、可见性门控轮询）
  locales.ts                zh 为键源，en 全量对照
  css-modules.d.ts          *.module.css 的 ambient 声明（照 family 原样）

  components/
    StewardBall.tsx           悬浮球（48px）：模式色环 + 今日成本角标；拖拽持久化、点击展开、长按切模式
    StewardBall.module.css
    StewardPanel.tsx          展开式大面板：锚定球体、四页签、Esc 关闭、焦点陷阱、减少动效降级
    StewardPanel.module.css
    ModeSwitch.tsx          三档模式条（复用 SegmentGroup 的滑动药丸，极致便宜 / 效率优先 / 最强火力）
    CostDashboard.tsx       成本看板头：今日 token、预估成本、缓存命中率、降级次数 + 24h 迷你趋势
    CostDashboard.module.css
    ModelGrid.tsx           模型阵列网格容器：按 cost_level 分组、空态与 rejected 横幅
    ModelCard.tsx           单模型卡：能力 chips、健康状态点、inFlight 并发、延迟、今日 token、成本
    ModelGrid.module.css
    RouteMonitor.tsx        路由监控流：最近 N 条事件，降级链用红色箭头串出 from → to
    AgentLanes.tsx          代理协作视图：每个 agent 一行，当前模型药丸 + 请求数/token，90s 未活跃置灰
    HealthLegend.tsx        状态图例 + 熔断倒计时（active / cooling / half-open / open / offline）

  settings/
    SettingsPanelCard.tsx   settings.section 页：YAML 路径、校验结果、网关端口与令牌复制、默认模式、启用开关
    PluginSettingsCard.tsx  ┐
    SegmentGroup.tsx        ├ 与 family 同款三件套（按 sync-shared 规则同步，不手改副本）
    RangeBubble.tsx         ┘
    settings-form.ts        ConfigForm 控制器（读 schema envelope、写 user 层、validateDraft）
    settings-card.module.css
```

## 三、注册面（三处，全部经 `ctx.effect()` 可回收）

```ts
export const inject = ['slots', 'locale'] as const

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'shell.overlay': { kind: 'list'; scope: 'root' }
  }
}

export function apply(ctx: ClientContext): void {
  // 1) 悬浮球：root 作用域的列表席位，与 pet / wallpaperPicker 可共存
  ctx.effect(() => ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register({ name: 'shell.overlay', id: 'stewardBall' }, StewardBall)), 'steward: ball')

  // 2) 设置页：family 的 settings.section 席位（无 web-ui 家族时是独立一级页）
  ctx.effect(() => installWebExtensionPage(ctx, { key: 'dsh-token-steward', order: 152, ... }), 'steward: settings')

  // 3) 侧栏底部快捷开关（可选，二期）
  ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register({ name: 'sidebar.footer.action', id: 'stewardBudget', locale: NS }, StewardFooterEntry)), 'steward: footer')
}
```

## 四、视觉与交互规约

- **只用 `--dsw-alias-*`**，不写死颜色；深浅色主题各一套（`body[data-ds-dark-theme]`）。
- 主按钮填充用 `--dsw-alias-button-primary-fill` + `--dsw-alias-label-primary-foreground` 三件套，禁用 `--dsw-alias-brand-primary` 作填充（官方面板会黑底黑字）。
- 语义属性：根容器 `data-dsh-plugin="token-steward"`，部件 `data-dsh-part="ball" | "panel" | "model-card" | "route-row"`，状态 `data-state`，与 `semantic-attrs-v1` 对齐，皮肤可覆盖。
- 极客感来自数据本身：状态点脉冲、延迟条、降级红箭头；动效全部受 `prefers-reduced-motion` 降级为淡入。
- **轮询纪律**：球常驻但只 10s 轻量取 `totals`；面板关闭即停；页面不可见即停（照 `UsageFootCard` 的可见性门控）。

## 五、依赖与构建

- `react` / `react-dom` + 官方 `@deepseek-ai/*` **type-only** 导入（浏览器 bundle 纯度门），跨插件协作只走 `ctx.slots` / `ctx.locale`。
- tsdown 使用仓库共享预设 `shared/tsdown.client.ts`；CSS Modules 经 lightningcss 编译。
- `package.json` 需 `"dsh": { "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-slots", "@deepseek-ai/dsh-client-locale", ...] } }`。

## 六、与 Host 半区的契约（已冻结，见 src/core/types.ts）

面板只消费 `MatrixSnapshot`：`mode` / `models[].health,todayTokens,todayCost` / `agents[]` / `recent[]` / `totals` / `pool.status`。
面板只写两个动作：`setMode(mode)` 与 `reloadPool()`。除此之外不发明任何写接口。
