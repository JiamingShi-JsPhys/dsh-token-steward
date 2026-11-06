
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { writeFileSync, readFileSync } from 'node:fs'
import { UmbraBall } from '../src/client/components/UmbraBall.tsx'
import { UmbraPanel } from '../src/client/components/UmbraPanel.tsx'
import { UmbraSettings } from '../src/client/settings/UmbraSettings.tsx'

const t = (key) => ({
  'ball.open': '展开模型矩阵', 'ball.close': '收起模型矩阵', 'ball.badge': '今日花费',
  'panel.title': 'Umbra 模型矩阵', 'panel.subtitle': '按任务属性自动分发；失败自动换人',
  'panel.close': '关闭', 'panel.reload': '重新读取配置',
  'panel.tab.routes': '路由监控', 'panel.tab.agents': '代理协作',
  'headline.tokens': '今日 token', 'headline.cost': '今日花费', 'headline.cache': '缓存命中', 'headline.degraded': '降级请求',
  'models.inflight': '并发', 'models.latency': '延迟', 'models.tokens': '今日 token',
  'models.cost': '今日花费', 'models.cache': '缓存', 'models.unpriced': '未定价',
  'routes.empty': '还没有请求经过矩阵。', 'routes.ok': '成功', 'routes.failed': '失败',
  'agents.empty': '还没有子代理使用矩阵。', 'agents.idle': '空闲', 'panel.error': '错误',
  'settings.title': 'Umbra 模型矩阵', 'settings.description': '配置模型池、调度模式与网关接线',
  'settings.poolPath': '配置文件路径', 'settings.gateway': '网关地址', 'settings.token': '本地令牌',
  'settings.copy': '复制', 'settings.copied': '已复制', 'settings.status': '配置状态',
  'settings.mode': '默认调度模式', 'settings.retainDays': '台账保留天数',
  'settings.hint': '在 profile 的 llm-pi-ai 里把 baseURL 指向网关地址，apiKeyEnv 指向一个存放本地令牌的环境变量。',
}[key] ?? key)

const snapshot = {
  revision: 3, mode: 'efficiency', updatedAt: 0, usageAvailable: true,
  models: [
    { provider: 'deepseek-official', model: 'deepseek-flash', displayName: 'DeepSeek V4.1 Flash', capabilities: ['fast','coding','tool-use','long-context'], costLevel: 'low', contextWindow: 1000000, availability: 'direct', health: 'active', inFlight: 2, latencyMs: 820, todayTokens: 1240000, todayCost: { currency: 'CNY', amount: 3.42 }, cacheHitRate: 0.62 },
    { provider: 'agnes', model: 'agnes-3.0-flash', displayName: 'Agnes 3.0 Flash', capabilities: ['fast','coding','vision'], costLevel: 'free', contextWindow: 128000, availability: 'direct', health: 'active', inFlight: 0, latencyMs: 410, todayTokens: 88000, todayCost: null, cacheHitRate: 0.31 },
    { provider: 'mirror-cn', model: 'glm-5.3-flash', displayName: 'GLM 5.3 Flash (镜像)', capabilities: ['fast','coding','reasoning','tool-use'], costLevel: 'low', contextWindow: 200000, availability: 'proxy', health: 'cooling', resumeAt: Date.now() + 28000, inFlight: 0, latencyMs: 1600, todayTokens: 220000, todayCost: null, cacheHitRate: null },
    { provider: 'frontier', model: 'frontier-max', displayName: 'Frontier Max', capabilities: ['coding','reasoning','vision','tool-use','long-context'], costLevel: 'high', contextWindow: 2000000, availability: 'direct', health: 'open', resumeAt: Date.now() + 52000, inFlight: 0, latencyMs: 2400, todayTokens: 3400000, todayCost: { currency: 'CNY', amount: 28.1 }, cacheHitRate: 0.44 },
  ],
  agents: [
    { agentId: 'visual_agent', provider: 'agnes', model: 'agnes-3.0-flash', lastSeenAt: Date.now() - 2000, requests: 14 },
    { agentId: 'analysis_agent', provider: 'frontier', model: 'frontier-max', lastSeenAt: Date.now() - 5000, requests: 6 },
    { agentId: 'stale_agent', provider: 'mirror-cn', model: 'glm-5.3-flash', lastSeenAt: Date.now() - 600000, requests: 2 },
  ],
  recent: [
    { at: 0, requestId: 'r1', mode: 'efficiency', provider: 'frontier', model: 'frontier-max', degradedFrom: [{ provider: 'mirror-cn', model: 'glm-5.3-flash', errorKind: 'rate-limit' }], ok: true, latencyMs: 1400, committed: false },
    { at: 0, requestId: 'r2', mode: 'frugal', provider: 'agnes', model: 'agnes-3.0-flash', degradedFrom: [], ok: true, latencyMs: 380, committed: false },
    { at: 0, requestId: 'r3', mode: 'max_power', provider: 'frontier', model: 'frontier-max', degradedFrom: [{ provider: 'frontier', model: 'frontier-max', errorKind: 'timeout' }], ok: false, latencyMs: 60000, committed: false },
  ],
  totals: { todayTokens: 4948000, todayCost: { currency: 'CNY', amount: 31.52 }, cacheHitRate: 0.4567, degradedRequests: 2, unpricedModels: 2 },
  pool: { status: 'ok', source: 'C:/Users/x/.dsh/umbra-budget/model_pool.yaml' },
}
const store = { subscribe: () => () => {}, getState: () => state, refresh: async () => {}, setMode: async () => {}, reload: async () => {}, setOpen() {}, setVisible() {}, start() {}, stop() {} }
const state = { snapshot, error: undefined, loading: false, open: true, gateway: { baseUrl: 'http://127.0.0.1:52000/v1', token: 'preview-token-placeholder', modelIds: [], port: 52000 } }

const previewHtml = {
  light: { body: '#f5f6f8', layer2: '#ffffff', layer3: 'rgba(0,0,0,0.045)', overlay: '#ffffff', border: 'rgba(0,0,0,0.1)', label: '#111317', secondary: '#4b5058', tertiary: '#8a9099', dimmed: '#a8aeb6', brand: '#2f6feb', hover: 'rgba(0,0,0,0.06)', success: '#1a7f37', warn: '#bf8700', error: '#b42318', mask: 'rgba(0,0,0,0.06)', primaryFill: '#2f6feb', primaryFg: '#ffffff' },
  dark: { body: '#14161a', layer2: '#1b1e24', layer3: 'rgba(255,255,255,0.06)', overlay: '#22262e', border: 'rgba(255,255,255,0.12)', label: '#eef0f3', secondary: '#b3b9c2', tertiary: '#8a9099', dimmed: '#6b717a', brand: '#6b9dff', hover: 'rgba(255,255,255,0.08)', success: '#3fb950', warn: '#d29922', error: '#f85149', mask: 'rgba(255,255,255,0.06)', primaryFill: '#3b7dfa', primaryFg: '#ffffff' },
}
function tokens(t) {
  return [
    '--dsw-alias-bg-layer-2:' + t.layer2, '--dsw-alias-bg-layer-3:' + t.layer3, '--dsw-alias-bg-overlay:' + t.overlay,
    '--dsw-alias-bg-mask-2:' + t.mask, '--dsw-alias-border-l2:' + t.border,
    '--dsw-alias-label-primary:' + t.label, '--dsw-alias-label-secondary:' + t.secondary,
    '--dsw-alias-label-tertiary:' + t.tertiary, '--dsw-alias-label-dimmed:' + t.dimmed,
    '--dsw-alias-label-primary-foreground:' + t.primaryFg,
    '--dsw-alias-brand-primary:' + t.brand, '--dsw-alias-interactive-bg-hover:' + t.hover,
    '--dsw-alias-state-success-primary:' + t.success, '--dsw-alias-state-warn-primary:' + t.warn,
    '--dsw-alias-state-error-primary:' + t.error,
    '--dsw-alias-button-primary-fill:' + t.primaryFill,
  ].join(';')
}

// esbuild 与本入口同批产出 .cache/preview-bundle.css，类名与组件里的 css.* 完全一致。
const css = readFileSync('.cache/preview-bundle.css', 'utf8')
const panel = renderToStaticMarkup(createElement(UmbraPanel, { state, store, t, now: Date.now(), onClose: () => {} }))
const ball = renderToStaticMarkup(createElement(UmbraBall, { snapshot, open: true, t, onToggle: () => {}, onCycleMode: () => {} }))
const settings = renderToStaticMarkup(createElement(UmbraSettings, { snapshot, gateway: state.gateway, poolPath: snapshot.pool.source, retainDays: 180, onReload: () => {}, onSelectMode: () => {}, t, copy: async () => {} }))

function stage(theme) {
  return '<div class="stage" style="' + tokens(previewHtml[theme]) + ';background:' + previewHtml[theme].body + '">'
    + '<div class="stageLabel">' + theme + '</div>'
    + '<div class="stageRow">'
    +   '<div class="col colPanel">' + panel + ball + '</div>'
    +   '<div class="col colSettings">' + settings + '</div>'
    + '</div>'
    + '</div>'
}

const html = '<!doctype html><html><head><meta charset="utf-8"><style>' + 'body{background:#0b0c0e}'
  + 'body{margin:0;font-family:ui-sans-serif,system-ui,"Segoe UI",sans-serif}'
  + '.stage{position:relative;padding:26px 16px 16px;color:var(--dsw-alias-label-primary);border-bottom:1px solid rgba(128,128,128,.25)}'
  + '.stageLabel{position:absolute;left:16px;top:8px;font-size:10px;letter-spacing:.12em;text-transform:uppercase;opacity:.45;color:var(--dsw-alias-label-primary)}'
  + '.stageRow{display:flex;gap:20px;align-items:flex-start}'
  + '.col{position:relative}'
  + '.colPanel{width:600px;flex:none}'
  + '.colSettings{width:440px;flex:none}'
  + '.colPanel .umbra_panel{position:relative;right:auto;bottom:auto;width:100%;max-height:none}'
  + '.colPanel .umbra_ball{position:relative;right:auto;bottom:auto;margin-top:12px;display:inline-flex;width:auto}'
  + css
  + '</style></head><body>' + stage('light') + stage('dark') + '</body></html>'

writeFileSync('.cache/preview.html', html)
console.log('preview bytes:', html.length)