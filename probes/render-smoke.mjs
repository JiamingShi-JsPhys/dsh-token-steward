
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { UmbraBall } from '../src/client/components/UmbraBall.tsx'
import { UmbraPanel } from '../src/client/components/UmbraPanel.tsx'

const t = (key) => key
const snapshot = {
  revision: 3,
  mode: 'efficiency',
  updatedAt: 1000,
  usageAvailable: true,
  models: [
    { provider: 'cheap', model: 'cheap-1', displayName: 'Cheap One', capabilities: ['coding'], costLevel: 'free', contextWindow: 128000, availability: 'direct', health: 'active', inFlight: 1, todayTokens: 1200, todayCost: null, cacheHitRate: 0.5 },
    { provider: 'strong', model: 'strong-1', displayName: 'Strong One', capabilities: ['coding','reasoning'], costLevel: 'high', contextWindow: 1000000, availability: 'direct', health: 'cooling', resumeAt: 31000, inFlight: 0, latencyMs: 820, todayTokens: 2000000, todayCost: { currency: 'CNY', amount: 12.345 }, cacheHitRate: null },
  ],
  agents: [
    { agentId: 'visual_agent', provider: 'strong', model: 'strong-1', lastSeenAt: 199900, requests: 12 },
    { agentId: 'old_agent', provider: 'cheap', model: 'cheap-1', lastSeenAt: 0, requests: 3 },
  ],
  recent: [
    { at: 900, requestId: 'r2', mode: 'efficiency', provider: 'strong', model: 'strong-1', degradedFrom: [{ provider: 'cheap', model: 'cheap-1', errorKind: 'rate-limit' }], ok: true, latencyMs: 500, committed: false },
    { at: 800, requestId: 'r1', mode: 'frugal', provider: 'cheap', model: 'cheap-1', degradedFrom: [], ok: true, latencyMs: 120, committed: false },
  ],
  totals: { todayTokens: 2001200, todayCost: { currency: 'CNY', amount: 12.345 }, cacheHitRate: 0.5, degradedRequests: 1, unpricedModels: 1 },
  pool: { status: 'ok', source: 'model_pool.yaml' },
}

const store = { subscribe: () => () => {}, getState: () => state, refresh: async () => {}, setMode: async () => {}, reload: async () => {}, setOpen() {}, setVisible() {}, start() {}, stop() {} }
const state = { snapshot, error: undefined, loading: false, open: true }

const ballHtml = renderToStaticMarkup(createElement(UmbraBall, { snapshot, open: true, t, onToggle: () => {}, onCycleMode: () => {} }))
const panelHtml = renderToStaticMarkup(createElement(UmbraPanel, { state, store, t, now: 200000, onClose: () => {} }))

console.log('--- BALL ---')
console.log(ballHtml)
console.log('')
console.log('--- PANEL (first 1800 chars) ---')
console.log(panelHtml.slice(0, 1800))
console.log('')
console.log('--- CHECKS ---')
const checks = [
  ['ball has data-dsh-plugin', ballHtml.includes('data-dsh-plugin="umbra-budget"')],
  ['ball has data-dsh-part="ball"', ballHtml.includes('data-dsh-part="ball"')],
  ['ball tone = efficiency', ballHtml.includes('data-tone="efficiency"')],
  ['ball badge shows cost', ballHtml.includes('¥12.35')],
  ['panel has role=dialog', panelHtml.includes('role="dialog"')],
  ['panel mode switch has 3 tabs', (panelHtml.match(/role="tab"/g) || []).length === 3],
  ['active tab is efficiency', panelHtml.includes('aria-selected="true"')],
  ['headline shows dash for unpriced models count', panelHtml.includes('1 个模型未定价')],
  ['model card shows unpriced dash', panelHtml.includes('models.unpriced')],
  ['route row shows degraded chain', panelHtml.includes('cheap/cheap-1 → strong/strong-1')],
  ['agent lane row present', panelHtml.includes('visual_agent')],
  ['idle agent flagged', panelHtml.includes('data-idle="true"')],
  ['active agent not idle', panelHtml.includes('data-idle="false"')],
]
for (const [name, ok] of checks) console.log((ok ? 'PASS ' : 'FAIL ') + name)