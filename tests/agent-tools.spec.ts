/**
 * Agent 工具：对话式管理动作的全部语义。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { executeStewardAction, type StewardToolDeps } from '../src/host/agent-tools.ts'
import type { RoutePreview, RoutingMode, VendorConfig } from '../src/core/types.ts'

function deps(initial: VendorConfig[] = [], recommend?: StewardToolDeps['recommend']) {
  let vendors: VendorConfig[] = initial.map((vendor) => ({ ...vendor }))
  let mode: RoutingMode = 'frugal'
  const calls: string[] = []
  return {
    deps: {
      getVendorConfigs: () => vendors.map((vendor) => ({ ...vendor })),
      async saveVendorConfigs(next) {
        calls.push('save')
        vendors = next.map((vendor) => ({ ...vendor }))
      },
      async setMode(next) {
        calls.push('mode:' + next)
        mode = next
      },
      getMode: () => mode,
      gatewayBaseUrl: () => 'http://127.0.0.1:51741/v1',
      recommend: recommend ?? (() => undefined),
    } as StewardToolDeps,
    calls,
    vendors: () => vendors,
    mode: () => mode,
  }
}

function vendor(partial: Partial<VendorConfig> & { vendorId: string }): VendorConfig {
  return {
    vendorId: partial.vendorId,
    vendorName: partial.vendorName ?? partial.vendorId,
    officialUrl: partial.officialUrl ?? '',
    customUrl: partial.customUrl ?? 'https://' + partial.vendorId + '.example/v1',
    apiKey: partial.apiKey ?? 'sk-existing',
    enabledModels: partial.enabledModels ?? ['model-a'],
    modelTags: partial.modelTags ?? {},
  }
}

test('show_status 返回模式/网关/厂商摘要，且不含密钥明文', async () => {
  const d = deps([vendor({ vendorId: 'agnes', apiKey: 'sk-secret-123' })])
  const out = await executeStewardAction(d.deps, { action: 'show_status' })
  assert.ok(out.includes('frugal'))
  assert.ok(out.includes('agnes'))
  assert.ok(!out.includes('sk-secret-123'), '密钥明文绝不回给 Agent')
})

test('recommend_model：把排序与理由回给 Agent，并给出子代理接法', async () => {
  const preview: RoutePreview = {
    mode: 'balanced',
    ranked: [
      { provider: 'midbox', model: 'fast-mid', score: 1_007_805, reasons: ['PROFILE:subagent', 'GATE:B+', 'STICKY:on'] },
      { provider: 'premium', model: 'omni-pro', score: 1_006_505, reasons: ['PROFILE:subagent', 'GATE:B+'] },
    ],
    rejected: [],
    notes: ['profile:subagent'],
  }
  const d = deps([], () => preview)
  const out = await executeStewardAction(d.deps, { action: 'recommend_model', profile: 'subagent', task: '读仓库并改一个测试' })
  assert.ok(out.includes('midbox/fast-mid'))
  assert.ok(out.includes('GATE:B+'))
  assert.ok(out.includes('子代理'))
  // 要让推荐自动生效，告诉 Agent 该改哪一处配置。
  assert.ok(out.includes('steward:subagent'))
})

test('recommend_model：矩阵未加载时说明原因，不编造推荐', async () => {
  const d = deps()
  const out = await executeStewardAction(d.deps, { action: 'recommend_model', profile: 'subagent' })
  assert.ok(out.includes('还没加载'))
})

test('add_or_update_vendor：新厂商入库；已有厂商空 Key 保留明文', async () => {
  const d = deps([vendor({ vendorId: 'agnes', apiKey: 'sk-keep-me' })])
  const out1 = await executeStewardAction(d.deps, {
    action: 'add_or_update_vendor',
    vendor_id: 'doubao',
    base_url: 'https://ark.example/v3',
    api_key: 'env:ARK_API_KEY',
    enabled_models: ['doubao-seed-1-6'],
  })
  assert.ok(out1.includes('已保存'))
  assert.equal(d.vendors().length, 2)
  const doubao = d.vendors().find((vendor) => vendor.vendorId === 'doubao')!
  assert.equal(doubao.apiKey, 'env:ARK_API_KEY')

  const out2 = await executeStewardAction(d.deps, {
    action: 'add_or_update_vendor',
    vendor_id: 'agnes',
    base_url: 'https://api.agnes-ai.cn/v1',
  })
  assert.ok(out2.includes('已保存'))
  assert.equal(d.vendors().find((vendor) => vendor.vendorId === 'agnes')?.apiKey, 'sk-keep-me', '空 Key 保留已存明文')
})

test('tag_model / set_enabled_models / remove_vendor 全走保存路径', async () => {
  const d = deps([vendor({ vendorId: 'agnes', enabledModels: ['a', 'b'] })])
  await executeStewardAction(d.deps, { action: 'tag_model', vendor_id: 'agnes', model_id: 'a', tags: ['编程', '做题'] })
  assert.deepEqual(d.vendors()[0]?.modelTags?.a, ['编程', '做题'])

  await executeStewardAction(d.deps, { action: 'set_enabled_models', vendor_id: 'agnes', enabled_models: ['a'] })
  assert.deepEqual(d.vendors()[0]?.enabledModels, ['a'])

  await executeStewardAction(d.deps, { action: 'tag_model', vendor_id: 'agnes', model_id: 'a', tags: [] })
  assert.equal(d.vendors()[0]?.modelTags?.a, undefined, '空标签 = 清除')

  await executeStewardAction(d.deps, { action: 'remove_vendor', vendor_id: 'agnes' })
  assert.equal(d.vendors().length, 0)
  assert.ok(d.calls.filter((entry) => entry === 'save').length >= 3)
})

test('set_mode 校验取值域；未知动作给出可读提示', async () => {
  const d = deps()
  const bad = await executeStewardAction(d.deps, { action: 'set_mode', mode: 'turbo' })
  assert.ok(bad.includes('frugal | balanced | max_power'))
  await executeStewardAction(d.deps, { action: 'set_mode', mode: 'max_power' })
  assert.equal(d.mode(), 'max_power')
  const unknown = await executeStewardAction(d.deps, { action: 'nonsense' })
  assert.ok(unknown.includes('未知 action'))
})
