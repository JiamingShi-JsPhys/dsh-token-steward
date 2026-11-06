/**
 * vendors 层：池合成 + 目录匹配 + 发现端点。
 *
 * 断言回答三个产品问题：
 *  - 勾选的模型能不能正确带六维评分入池（目录命中）？
 *  - 目录没有的模型会不会被编造评分？（不会——中性 + 未收录）
 *  - 面板的「测试连接并拉取模型」是否真的打到上游 /models？
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchTemplateModel, PROVIDER_TEMPLATES, normalizeModelId, unknownModelInfo } from '../src/core/provider-templates.ts'
import { modelInfoToEntry, synthesizePool, vendorIsRoutable, vendorEndpoint, VENDOR_KEY_SENTINEL } from '../src/core/vendors.ts'
import { intent } from './fixtures.ts'
import { startGateway } from '../src/host/gateway.ts'
import { createRouter } from '../src/core/router.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVendorStore } from '../src/host/vendor-store.ts'
import type { PoolConfig, VendorConfig } from '../src/core/types.ts'
import type { FetchLike } from '../src/host/upstream.ts'

function vendor(overrides: Partial<VendorConfig> = {}): VendorConfig {
  return {
    vendorId: 'deepseek',
    vendorName: 'DeepSeek',
    officialUrl: 'https://api.deepseek.com/v1',
    customUrl: '',
    apiKey: 'sk-test-1234',
    enabledModels: ['deepseek-v4-1-flash-1017', 'deepseek-v4-pro-0813'],
    ...overrides,
  }
}

const CACHE = { exact_match: false, max_entries: 500, ttl_ms: 3_600_000 }

test('目录匹配：精确 id、归一化 id、显示名三级命中', () => {
  const anthropic = PROVIDER_TEMPLATES.find((vendor) => vendor.vendorId === 'anthropic')!
  assert.equal(matchTemplateModel(anthropic, 'claude-opus-5-5')?.name, 'Claude Opus 5.5')
  assert.equal(matchTemplateModel(anthropic, 'Claude-Opus-5.5')?.name, 'Claude Opus 5.5', '归一化后命中')
  assert.equal(matchTemplateModel(anthropic, 'claudeopus55')?.name, 'Claude Opus 5.5', '无分隔符也命中')
  assert.equal(matchTemplateModel(anthropic, 'totally-unknown'), undefined)
  assert.equal(normalizeModelId('GPT-6.1 Sol'), 'gpt61sol')
})

test('池合成：勾选的模型带六维评分与 Tier 入池', () => {
  const pool = synthesizePool([vendor()], 'frugal', CACHE)
  assert.equal(pool.providers.length, 1)
  const entry = pool.providers[0]!.models.find((model) => model.id === 'deepseek-v4-1-flash-1017')!
  assert.equal(entry.tier, 'A+')
  assert.equal(entry.dimensions?.coding.score, 69.4)
  assert.equal(entry.dimensions?.coding.grade, 'S')
  assert.equal(entry.dimensions?.agentic.grade, 'A+')
  // 榜单估算价：目录模型带 USD/1M 价目，折算成每 1k；不再是「全部未定价」。
  assert.equal(entry.costPer1kOutput, 0.0011)
  assert.deepEqual(entry.pricing, { currency: 'USD', input_per_mtok: 0.28, output_per_mtok: 1.1 })
  assert.equal(entry.capabilities.includes('tool-use'), true)
  // 凭据走 sentinel，明文由 index 注入 secrets，绝不写进池配置。
  assert.equal(pool.providers[0]!.api_key, VENDOR_KEY_SENTINEL + 'deepseek')
})

test('池合成：目录未收录的模型以「未收录」形态入池，绝不编造评分', () => {
  const info = unknownModelInfo('doubao-pro-32k', '豆包 Pro')
  assert.equal(info.tier, 'NA')
  assert.equal(info.scores.coding.grade, 'NA')
  const entry = modelInfoToEntry(info)
  assert.equal(entry.quality_rank, 50, '中性分：能路由，但六维未知不冒充高分')
  assert.ok(entry.tags.tier === 'NA')
})

test('池合成：不可路由的厂商被跳过（缺 Key / 缺端点 / 没勾模型）', () => {
  const pool = synthesizePool([
    vendor({ vendorId: 'a', enabledModels: [] }),
    vendor({ vendorId: 'b', apiKey: '' }),
    vendor({ vendorId: 'c', customUrl: '', officialUrl: '' }),
    vendor({ vendorId: 'd' }),
  ], 'frugal', CACHE)
  assert.deepEqual(pool.providers.map((provider) => provider.provider_name), ['d'])
  assert.equal(vendorIsRoutable(vendor()), true)
  assert.equal(vendorIsRoutable(vendor({ apiKey: '' })), false)
  assert.equal(vendorEndpoint(vendor({ customUrl: 'https://relay.example/v1' })), 'https://relay.example/v1', 'customUrl 优先于官方地址')
})

test('合成池直接可被路由引擎使用（端到端）', () => {
  const pool = synthesizePool([vendor()], 'max_power', CACHE)
  const router = createRouter(pool)
  const planned = router.plan(
    {
      requiredCapabilities: ['coding'],
      requiredModalities: ['text'],
      estimatedInputTokens: 1_000,
      expectedOutputTokens: 1_000,
      needsTools: false,
      dimension: 'coding',
      stream: false,
      burstKey: 'burst-0',
    },
    1_000,
    'r1',
  )
  assert.ok(planned.ok)
  // max_power 按 coding 维度选最高分：69.4 > 57.2。
  assert.equal(planned.decision.chosen.model, 'deepseek-v4-1-flash-1017')
})

// ── 网关发现端点 ─────────────────────────────────────────────────────

async function withDiscovery<T>(run: (baseUrl: string, token: string, upstreamCalls: string[]) => Promise<T>): Promise<T> {
  const upstreamCalls: string[] = []
  const fetchImpl: FetchLike = async (input) => {
    upstreamCalls.push(String(input))
    return new Response(JSON.stringify({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-v4-1-flash-1017' }, { id: 'brand-new-model' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const pool: PoolConfig = synthesizePool([vendor()], 'frugal', CACHE)
  const gateway = await startGateway({
    config: () => pool,
    router: () => createRouter(pool),
    vendors: () => [vendor()],
    secrets: () => new Map([['deepseek', 'sk-test-1234']]),
    fetchImpl,
    now: () => 1_000,
  })
  try {
    return await run(gateway.baseUrl(), gateway.token(), upstreamCalls)
  } finally {
    await gateway.close()
  }
}

test('发现端点：带 vendor 参数时探测上游 /models，目录命中的行带 Tier', async () => {
  await withDiscovery(async (baseUrl, token, upstreamCalls) => {
    const response = await fetch(baseUrl + '/models?vendor=deepseek', {
      headers: { authorization: 'Bearer ' + token },
    })
    assert.equal(response.status, 200)
    const body = await response.json() as { data: Array<{ id: string, tier: string, inCatalog: boolean, name: string }> }
    assert.equal(upstreamCalls.length, 1)
    assert.ok(upstreamCalls[0]!.endsWith('/models'), '探测的是上游的 /models')
    assert.equal(body.data.length, 3)
    const known = body.data.find((entry) => entry.id === 'deepseek-v4-1-flash-1017')!
    assert.equal(known.inCatalog, true)
    assert.equal(known.tier, 'A+')
    const fresh = body.data.find((entry) => entry.id === 'brand-new-model')!
    assert.equal(fresh.inCatalog, false)
    assert.equal(fresh.tier, 'NA')
  })
})

test('发现端点：base_url + api_key 参数优先；错误令牌照常 401', async () => {
  await withDiscovery(async (baseUrl, token) => {
    const response = await fetch(baseUrl + '/models?base_url=' + encodeURIComponent('https://relay.example/v1') + '&api_key=' + encodeURIComponent('sk-relay'), {
      headers: { authorization: 'Bearer ' + token },
    })
    assert.equal(response.status, 200)

    const rejected = await fetch(baseUrl + '/models?vendor=deepseek', {
      headers: { authorization: 'Bearer wrong' },
    })
    assert.equal(rejected.status, 401, '发现端点同样受本地令牌保护')
  })
})


test('vendors.json 往返：modelTags 与 modelPricing 不再在重启后丢失', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'steward-vendors-'))
  try {
    const store = createVendorStore(directory)
    await store.save({
      version: 1,
      mode: 'balanced',
      vendors: [{
        vendorId: 'relay',
        vendorName: 'Relay',
        officialUrl: 'https://official.example/v1',
        customUrl: 'https://relay.example/v1',
        apiKey: 'sk-test-1234',
        enabledModels: ['model-a'],
        modelTags: { 'model-a': ['编程', '做题'] },
        modelPricing: { 'model-a': { input: 0.5, output: 2 } },
      }],
    })
    const loaded = await store.load()
    const vendor = loaded.vendors[0]
    assert.ok(vendor !== undefined)
    assert.deepEqual(vendor.modelTags, { 'model-a': ['编程', '做题'] })
    assert.deepEqual(vendor.modelPricing, { 'model-a': { input: 0.5, output: 2 } })
    assert.equal(loaded.mode, 'balanced')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('用户覆盖价目进入合成池，并压过目录估算价', () => {
  const pool = synthesizePool([vendor({
    modelPricing: { 'deepseek-v4-1-flash-1017': { input: 0.01, output: 0.04 } },
  })], 'frugal', CACHE)
  const entry = pool.providers[0]!.models.find((model) => model.id === 'deepseek-v4-1-flash-1017')!
  assert.deepEqual(entry.pricing, { currency: 'USD', input_per_mtok: 0.01, output_per_mtok: 0.04 })
  assert.equal(entry.costPer1kOutput, 0.00004)
})

test('池合成：向量 / 重排模型不进对话路由（chat:false）', () => {
  const entry = modelInfoToEntry(unknownModelInfo('Qwen3-Embedding-8B'))
  assert.equal(entry.chat, false, 'embedding 模型必须被标成不做对话')
  assert.equal(modelInfoToEntry(unknownModelInfo('Qwen3-Reranker-8B')).chat, false)
  // 正常聊天模型不带这个字段，语义仍是「可以聊」。
  assert.equal(modelInfoToEntry(unknownModelInfo('Qwen')).chat, undefined)
  assert.equal(modelInfoToEntry(unknownModelInfo('deepseek-flash')).chat, undefined)
})

test('池合成：模型 id 必须原样保留用户配置的写法（上游只认真实 id）', () => {
  // 目录里 agnes 的规范化 id 是 agnes-3-0-flash，真实上游要 agnes-3.0-flash。
  const pool = synthesizePool([
    vendor({ vendorId: 'agnes', apiKey: 'k', enabledModels: ['agnes-3.0-flash', 'agnes-2.5-flash'] }),
  ], 'balanced', CACHE)
  const ids = pool.providers.flatMap((entry) => entry.models.map((model) => model.id))
  assert.deepEqual(ids, ['agnes-3.0-flash', 'agnes-2.5-flash'])
  // 元数据仍然来自目录（命中的那条带名字），只是 id 不跟着改。
  const first = pool.providers[0]!.models[0]!
  assert.ok(first.display_name.length > 0)
})

test('线路二选一：官网 / 中转站互斥，不会两个同时生效', () => {
  const base = vendor({ vendorId: 'openai', officialUrl: 'https://api.openai.com/v1', customUrl: 'https://relay.example.com/v1' })
  assert.equal(vendorEndpoint({ ...base, endpointSource: 'official' }), 'https://api.openai.com/v1')
  assert.equal(vendorEndpoint({ ...base, endpointSource: 'relay' }), 'https://relay.example.com/v1')
  // 选官网时，中转站里还留着上次的地址也不该被使用。
  assert.equal(vendorEndpoint({ ...base, endpointSource: 'official', customUrl: 'https://old.example.com/v1' }), 'https://api.openai.com/v1')
  // 老数据没有这个字段：沿用旧规则（填了中转站就用它）。
  assert.equal(vendorEndpoint(base), 'https://relay.example.com/v1')
})

test('目录里每家厂商都带官网链接，且都指向 https', () => {
  // 用户在设置页要能一键去申请 key；缺链接的话他搜到的大半是别人的中转站。
  for (const vendor of PROVIDER_TEMPLATES) {
    assert.ok(vendor.homepage !== undefined && vendor.homepage !== '', vendor.vendorId + ' 缺官网链接')
    assert.ok(vendor.homepage!.startsWith('https://'), vendor.vendorId + ' 的官网必须是 https')
  }
})

test('目录里不再有 Our Free Model 这一家', () => {
  assert.equal(PROVIDER_TEMPLATES.some((vendor) => vendor.vendorId === 'ofm'), false)
})

test('vendors.json 往返：拉取到的模型清单（pulledModels）重启后还在', async () => {
  // 拉取是一次性的网络结果。存不下来的话，重启后用户勾过的型号只剩一串 id，
  // 面板上根本认不出是哪家模型。
  const directory = await mkdtemp(join(tmpdir(), 'steward-vendors-'))
  try {
    const store = createVendorStore(directory)
    await store.save({
      version: 1,
      mode: 'balanced',
      vendors: [{
        vendorId: 'relay',
        vendorName: 'Relay',
        officialUrl: '',
        customUrl: 'https://relay.example/v1',
        apiKey: 'sk-test-1234',
        enabledModels: ['model-a'],
        pulledModels: [{ id: 'model-a', name: 'Model A' }, { id: 'model-b', name: 'Model B' }],
      }],
    })
    const loaded = await store.load()
    assert.deepEqual(loaded.vendors[0]?.pulledModels, [
      { id: 'model-a', name: 'Model A' },
      { id: 'model-b', name: 'Model B' },
    ])
    // 只存清单、不冒充启用：路由仍然只认 enabledModels。
    assert.deepEqual(loaded.vendors[0]?.enabledModels, ['model-a'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

/* ───── 自定义厂家 → 白嫖序列 ───── */

test('自定义厂家（目录里没有这家）的无价目型号按零成本入池，白嫖才用得上', () => {
  const pool = synthesizePool([vendor({
    vendorId: 'my-hpc',
    vendorName: 'My HPC',
    officialUrl: 'https://hpc.example/v1',
    enabledModels: ['some-internal-model'],
  })], 'free', CACHE)
  const entry = pool.providers[0]!.models[0]!
  assert.equal(entry.cost_level, 'free')
  assert.equal(entry.freeAssumed, true)
  // 推定免费 ≠ 编价目：成本仍按「未定价」记账。
  assert.equal(entry.pricing, undefined)
  assert.equal(entry.costPer1kOutput, null)
})

test('用户自己给了价目就不再用推定值：设成 0 是免费，设成正数就不是', () => {
  const zero = synthesizePool([vendor({
    vendorId: 'my-hpc', officialUrl: 'https://hpc.example/v1',
    enabledModels: ['some-internal-model'],
    modelPricing: { 'some-internal-model': { input: 0, output: 0 } },
  })], 'free', CACHE).providers[0]!.models[0]!
  assert.equal(zero.freeAssumed, undefined, '用户明说了 0，就不是推定')

  const paid = synthesizePool([vendor({
    vendorId: 'my-hpc', officialUrl: 'https://hpc.example/v1',
    enabledModels: ['some-internal-model'],
    modelPricing: { 'some-internal-model': { input: 1, output: 3 } },
  })], 'free', CACHE).providers[0]!.models[0]!
  assert.notEqual(paid.cost_level, 'free')
})

test('内置厂家的未收录型号不会被推定免费：那只是目录没跟上', () => {
  const pool = synthesizePool([vendor({
    vendorId: 'agnes',
    officialUrl: 'https://api.agnes-ai.cn/v1',
    enabledModels: ['agnes-brand-new-model'],
  })], 'free', CACHE)
  const entry = pool.providers[0]!.models[0]!
  assert.equal(entry.freeAssumed, undefined)
  assert.notEqual(entry.cost_level, 'free')
})

test('白嫖模式真的会路由到推定的免费模型', () => {
  const config = synthesizePool([vendor({
    vendorId: 'my-hpc',
    officialUrl: 'https://hpc.example/v1',
    enabledModels: ['some-internal-model'],
  })], 'free', CACHE)
  const router = createRouter(config)
  const planned = router.plan(intent({ requiredCapabilities: [], estimatedInputTokens: 100, expectedOutputTokens: 100 }), 1_000, 'r1')
  assert.ok(planned.ok, '白嫖应该选出这家自定义厂家的模型')
  assert.equal(planned.decision.chosen.provider, 'my-hpc')
  assert.equal(planned.decision.chosen.model, 'some-internal-model')
})

test('免费池厂家拉回来的 `…-free` 型号，目录没价目也照样进白嫖', () => {
  const pool = synthesizePool([vendor({
    vendorId: 'opencode',
    officialUrl: 'https://opencode.ai/zen/v1',
    enabledModels: ['mimo-v2.6-flash-free', 'big-pickle'],
  })], 'free', CACHE)
  const models = pool.providers[0]!.models
  const free = models.find((model) => model.id === 'mimo-v2.6-flash-free')!
  const paid = models.find((model) => model.id === 'big-pickle')!
  assert.equal(free.cost_level, 'free')
  assert.equal(free.freeAssumed, true)
  // 名字里没有 free 的未收录型号不猜：免费池里也可能摆着付费型号。
  assert.notEqual(paid.cost_level, 'free')
})
