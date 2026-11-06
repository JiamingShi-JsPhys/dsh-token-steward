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
import { startGateway } from '../src/host/gateway.ts'
import { createRouter } from '../src/core/router.ts'
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
  assert.equal(entry.costPer1kOutput, null, '评分表没有价格 = 未定价')
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
