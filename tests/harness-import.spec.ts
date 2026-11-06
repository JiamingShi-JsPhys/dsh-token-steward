/**
 * 「从 DSH 已有配置导入」的解析与合并：
 *  - 只认 llm-pi-ai 的 providers，跳过我们自己的 steward；
 *  - 密钥按 apiKeyEnv 取环境变量，取不到才用配置里写死的；
 *  - 导入不抹掉用户已经打好的标签与价目。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { harnessProviders, harnessVendor, mergeImportedVendors, normalizeEndpoint, selectHarnessProviders } from '../src/host/harness-import.ts'
import type { VendorConfig } from '../src/core/types.ts'

const PATCH = [
  { id: 'token-steward', name: 'dsh-token-steward', config: { enabled: true } },
  {
    id: 'llm',
    name: '@deepseek-ai/dsh-llm-pi-ai',
    config: {
      providers: {
        steward: { displayName: 'Steward Matrix', apiKeyEnv: 'STEWARD_LOCAL_TOKEN', baseURL: 'http://127.0.0.1:1/v1', models: [{ id: 'Steward Auto' }] },
        agnes: { displayName: 'Agnes', apiKeyEnv: 'AGNES_KEY', baseURL: 'https://api.agnes.ai/v1', models: [{ id: 'agnes-3.0-flash' }, { id: 'agnes-2.5-pro' }] },
        broken: { displayName: 'No URL' },
      },
    },
  },
]

test('只认 llm-pi-ai 的 providers，并跳过自己的网关', () => {
  const providers = harnessProviders(PATCH)
  assert.deepEqual(providers.map((entry) => entry.vendorId), ['agnes'])
  assert.equal(providers[0]?.vendorName, 'Agnes')
  assert.equal(providers[0]?.baseUrl, 'https://api.agnes.ai/v1')
  assert.deepEqual(providers[0]?.models, ['agnes-3.0-flash', 'agnes-2.5-pro'])
})

test('密钥优先取 apiKeyEnv 指向的环境变量，取不到才用配置里的明文', () => {
  const provider = { vendorId: 'x', vendorName: 'X', baseUrl: 'https://x/v1', apiKeyEnv: 'X_KEY', apiKey: 'literal', models: ['m'] }
  assert.equal(harnessVendor(provider, { X_KEY: 'env-key' }).apiKey, 'env-key')
  assert.equal(harnessVendor(provider, {}).apiKey, 'literal')
  // 两条路都没有：留空串，面板如实显示「已配置但没密钥」。
  assert.equal(harnessVendor({ ...provider, apiKey: '' }, {}).apiKey, '')
})

test('导入走官网地址，模型清单原样带过来', () => {
  const vendor = harnessVendor({ vendorId: 'agnes', vendorName: 'Agnes', baseUrl: 'https://api.agnes.ai/v1', apiKeyEnv: '', apiKey: 'k', models: ['a', 'b'] }, {})
  assert.equal(vendor.endpointSource, 'official')
  assert.equal(vendor.officialUrl, 'https://api.agnes.ai/v1')
  assert.deepEqual(vendor.enabledModels, ['a', 'b'])
})

test('合并：同 id 就地更新，保留用户标签与价目；新厂商追加', () => {
  const existing: VendorConfig[] = [{
    vendorId: 'agnes', vendorName: 'Agnes', officialUrl: 'https://old/v1', customUrl: '', apiKey: 'saved-key',
    enabledModels: ['old-model'], modelTags: { 'old-model': ['快'] }, modelPricing: { 'old-model': { input: 1, output: 2 } },
  }]
  const incoming: VendorConfig[] = [{
    vendorId: 'agnes', vendorName: 'Agnes', officialUrl: 'https://api.agnes.ai/v1', customUrl: '', endpointSource: 'official',
    apiKey: '', enabledModels: ['agnes-3.0-flash'],
  }]
  const merged = mergeImportedVendors(existing, incoming)
  assert.equal(merged.length, 1)
  assert.equal(merged[0]?.officialUrl, 'https://api.agnes.ai/v1')
  // 导入时取不到密钥 → 沿用已存的那把，不把用户配好的东西弄空。
  assert.equal(merged[0]?.apiKey, 'saved-key')
  assert.deepEqual(merged[0]?.enabledModels, ['agnes-3.0-flash'])
  assert.deepEqual(merged[0]?.modelTags, { 'old-model': ['快'] })
})

/* ───── 按范围导入：面板停在哪家，就只拉哪家 ───── */

test('地址规范化：大小写、末尾斜杠、/v1 后缀都不影响比对', () => {
  assert.equal(normalizeEndpoint('HTTPS://API.Agnes.ai/v1/'), normalizeEndpoint('https://api.agnes.ai'))
  assert.equal(normalizeEndpoint(' https://hpc-api.westlake.edu.cn/v1 '), 'https://hpc-api.westlake.edu.cn')
})

test('给了 id 就只拉这一家，别家不动', () => {
  const providers = harnessProviders(PATCH)
  const picked = selectHarnessProviders(providers, { vendorId: 'agnes' })
  assert.deepEqual(picked.map((entry) => entry.vendorId), ['agnes'])
})

test('id 对不上时按 URL 对：用户在中转站那家点导入，也能对上 profile 里的官方地址', () => {
  const providers = [
    { vendorId: 'westlake', vendorName: 'Westlake', baseUrl: 'https://hpc-api.westlake.edu.cn/v1', apiKeyEnv: '', apiKey: 'k', models: ['Qwen'] },
    { vendorId: 'agnes', vendorName: 'Agnes', baseUrl: 'https://api.agnes.ai/v1', apiKeyEnv: '', apiKey: 'k', models: ['a'] },
  ]
  const picked = selectHarnessProviders(providers, { vendorId: 'custom', baseUrl: 'https://HPC-API.westlake.edu.cn/v1/' })
  assert.deepEqual(picked.map((entry) => entry.vendorId), ['westlake'])
})

test('对不上就一个都不给：不能退化成「整份导入」', () => {
  assert.deepEqual(selectHarnessProviders(harnessProviders(PATCH), { vendorId: 'nope', baseUrl: 'https://nope.example/v1' }), [])
})

test('不带范围时保持老行为（整份导入）', () => {
  assert.equal(selectHarnessProviders(harnessProviders(PATCH)).length, 1)
})
