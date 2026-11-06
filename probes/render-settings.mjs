
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SettingsPanel } from '../src/client/settings/SettingsPanel.tsx'

const t = (key) => key
const snapshot = {
  revision: 1, mode: 'frugal', updatedAt: 0, usageAvailable: true,
  models: [], agents: [], recent: [],
  totals: { todayTokens: 0, todayCost: null, cacheHitRate: null, degradedRequests: 0, unpricedModels: 0 },
  pool: { status: 'rejected', source: 'x', error: 'providers[0].endpoint: expected an http(s) URL' },
}
const html = renderToStaticMarkup(createElement(SettingsPanel, {
  snapshot,
  gateway: { baseUrl: 'http://127.0.0.1:52000/v1', token: 'abc123', modelIds: ['steward:auto'], port: 52000 },
  poolPath: 'C:/Users/x/.dsh/token-steward/model_pool.yaml',
  retainDays: 180,
  onReload: () => {}, onSelectMode: () => {}, t,
  copy: async () => {},
}))
console.log(html.slice(0, 1400))
console.log('--- CHECKS ---')
const checks = [
  ['settings root has plugin attr', html.includes('data-dsh-plugin="token-steward"')],
  ['settings part is settings-section', html.includes('data-dsh-part="settings-section"')],
  ['rejected status shown', html.includes('expected an http(s) URL')],
  ['gateway baseUrl shown', html.includes('http://127.0.0.1:52000/v1')],
  ['token shown', html.includes('abc123')],
  ['three mode radios', (html.match(/role="radio"/g) || []).length === 3],
  ['frugal radio checked', html.includes('aria-checked="true"')],
  ['copy buttons present', (html.match(/settings.copy/g) || []).length >= 2],
]
for (const [name, ok] of checks) console.log((ok ? 'PASS ' : 'FAIL ') + name)
if (checks.some(([, ok]) => !ok)) process.exit(1)
