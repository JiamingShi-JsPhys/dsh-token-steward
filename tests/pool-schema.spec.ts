/**
 * pool-schema.ts：配置校验与归一化。
 *
 * 中心断言只有一条：**任一字段非法 → 整份拒绝**，绝不半应用。
 * 其余断言覆盖缺省回落、跨字段约束与警告（未定价、全 offline）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_DEFAULTS, parsePool, parsePoolOrThrow } from '../src/core/pool-schema.ts'

/** 一份最小可用的原始配置。 */
function minimal(): Record<string, unknown> {
  return {
    providers: [
      {
        provider_name: 'p1',
        endpoint: 'https://p1.example/v1',
        api: 'openai-completions',
        api_key: 'env:P1_KEY',
        models: [{ id: 'm1', capabilities: ['coding'], cost_level: 'free', context_window: 128000, availability: 'direct', quality_rank: 40 }],
      },
    ],
  }
}

/** 解析并断言成功，返回结果。 */
function expectOk(raw: unknown) {
  const result = parsePool(raw)
  assert.ok(result.ok, 'expected ok, got: ' + JSON.stringify(result.ok ? [] : result.diagnostics))
  return result
}

/** 解析并断言失败，返回诊断路径列表。 */
function expectFail(raw: unknown): string[] {
  const result = parsePool(raw)
  assert.equal(result.ok, false)
  if (result.ok) return []
  return result.diagnostics.map((entry) => entry.path)
}

test('最小配置即可解析，缺省值全部回落', () => {
  const result = expectOk(minimal())
  assert.equal(result.config.version, 1)
  assert.deepEqual(result.config.defaults, DEFAULT_DEFAULTS)
  assert.equal(result.config.routing.mode, 'frugal')
  assert.deepEqual(result.config.routing.aliases, {})

  const model = result.config.providers[0]?.models[0]
  assert.equal(model?.display_name, 'm1')
  assert.equal(model?.max_concurrency, 4)
  assert.equal(model?.max_output_tokens, 8192)
  assert.deepEqual(model?.input_modalities, ['text'])
  assert.equal(model?.pricing, undefined)
  assert.deepEqual(model?.tags, {})
})

test('根不是映射时整份拒绝', () => {
  assert.deepEqual(expectFail([]), ['(root)'])
  assert.deepEqual(expectFail('hello'), ['(root)'])
  assert.deepEqual(expectFail(null), ['(root)'])
})

test('version 不是 1 时拒绝', () => {
  assert.deepEqual(expectFail({ ...minimal(), version: 2 }), ['version'])
})

test('providers 缺省或为空时拒绝', () => {
  assert.deepEqual(expectFail({}), ['providers'])
  assert.deepEqual(expectFail({ providers: [] }), ['providers'])
})

test('每个 defaults 字段都会被校验为正整数', () => {
  assert.deepEqual(expectFail({ ...minimal(), defaults: { max_attempts: 0 } }), ['defaults.max_attempts'])
})

test('defaults 只覆盖写出的字段，其余保持缺省', () => {
  const result = expectOk({ ...minimal(), defaults: { max_attempts: 5 } })
  assert.equal(result.config.defaults.max_attempts, 5)
  assert.equal(result.config.defaults.cooldown_ms, DEFAULT_DEFAULTS.cooldown_ms)
})

test('routing.mode 取值域受限', () => {
  assert.deepEqual(expectFail({ ...minimal(), routing: { mode: 'turbo' } }), ['routing.mode'])
})

test('provider 的 endpoint 非 http(s) 时拒绝', () => {
  const bad = minimal() as { providers: Array<Record<string, unknown>> }
  bad.providers[0]!.endpoint = 'ftp://p1.example'
  assert.deepEqual(expectFail(bad), ['providers[0].endpoint'])
})

test('provider 的 api_key 必须是可识别的凭据引用', () => {
  const bad = minimal() as { providers: Array<Record<string, unknown>> }
  bad.providers[0]!.api_key = 'plain-text-key'
  assert.deepEqual(expectFail(bad), ['providers[0].api_key'])
})

test('四种凭据引用写法都被接受', () => {
  for (const ref of ['env:P1_KEY', 'file:/tmp/key', 'literal:abc', '${P1_KEY}']) {
    const raw = minimal() as { providers: Array<Record<string, unknown>> }
    raw.providers[0]!.api_key = ref
    expectOk(raw)
  }
})

test('api 只接受 openai-completions', () => {
  const bad = minimal() as { providers: Array<Record<string, unknown>> }
  bad.providers[0]!.api = 'anthropic-messages'
  assert.deepEqual(expectFail(bad), ['providers[0].api'])
})

test('同一 provider 内模型 id 重复时拒绝', () => {
  const raw = minimal() as { providers: Array<Record<string, unknown>> }
  const models = raw.providers[0]!.models as unknown[]
  models.push(models[0])
  assert.deepEqual(expectFail(raw), ['providers[0].models[1].id'])
})

test('重名 provider 时拒绝', () => {
  const raw = minimal() as { providers: unknown[] }
  raw.providers.push(raw.providers[0])
  assert.deepEqual(expectFail(raw), ['providers[1].provider_name'])
})

test('model 必填字段缺失时逐个拒绝', () => {
  const cases: Array<[string, string]> = [
    ['id', 'providers[0].models[0].id'],
    ['capabilities', 'providers[0].models[0].capabilities'],
    ['cost_level', 'providers[0].models[0].cost_level'],
    ['context_window', 'providers[0].models[0].context_window'],
    ['availability', 'providers[0].models[0].availability'],
  ]
  for (const [field, path] of cases) {
    const raw = minimal() as { providers: Array<{ models: Array<Record<string, unknown>> }> }
    delete raw.providers[0]!.models[0]![field]
    assert.deepEqual(expectFail(raw), [path], 'missing ' + field)
  }
})

test('capabilities 显式为空是合法的（无特殊能力的模型）', () => {
  const raw = minimal() as { providers: Array<{ models: Array<Record<string, unknown>> }> }
  raw.providers[0]!.models[0]!.capabilities = []
  const result = expectOk(raw)
  assert.deepEqual(result.config.providers[0]?.models[0]?.capabilities, [])
})

test('capabilities 里的未知标签被拒绝并点名取值', () => {
  const raw = minimal() as { providers: Array<{ models: Array<Record<string, unknown>> }> }
  raw.providers[0]!.models[0]!.capabilities = ['coding', 'telepathy']
  const result = parsePool(raw)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.diagnostics[0]?.path, 'providers[0].models[0].capabilities[1]')
  assert.ok((result.diagnostics[0]?.message ?? '').includes('telepathy'))
})

test('cost_level 只接受四档', () => {
  const raw = minimal() as { providers: Array<{ models: Array<Record<string, unknown>> }> }
  raw.providers[0]!.models[0]!.cost_level = 'cheap'
  assert.deepEqual(expectFail(raw), ['providers[0].models[0].cost_level'])
})

test('availability=proxy 必须带 proxy_url', () => {
  const raw = minimal() as { providers: Array<{ models: Array<Record<string, unknown>> }> }
  raw.providers[0]!.models[0]!.availability = 'proxy'
  assert.deepEqual(expectFail(raw), ['providers[0].models[0].proxy_url'])
})

test('availability 不是 proxy 时带 proxy_url 会被拒绝，避免配置静默失效', () => {
  const raw = minimal() as { providers: Array<{ models: Array<Record<string, unknown>> }> }
  raw.providers[0]!.models[0]!.proxy_url = 'http://127.0.0.1:7890'
  assert.deepEqual(expectFail(raw), ['providers[0].models[0].proxy_url'])
})

test('availability=proxy 且带 proxy_url 时通过', () => {
  const raw = minimal() as { providers: Array<{ models: Array<Record<string, unknown>> }> }
  raw.providers[0]!.models[0]!.availability = 'proxy'
  raw.providers[0]!.models[0]!.proxy_url = 'http://127.0.0.1:7890'
  const result = expectOk(raw)
  assert.equal(result.config.providers[0]?.models[0]?.proxy_url, 'http://127.0.0.1:7890')
})

test('quality_rank 限定 0..100', () => {
  const raw = minimal() as { providers: Array<{ models: Array<Record<string, unknown>> }> }
  raw.providers[0]!.models[0]!.quality_rank = 101
  assert.deepEqual(expectFail(raw), ['providers[0].models[0].quality_rank'])
})

test('pricing 缺必填字段时拒绝', () => {
  const raw = minimal() as { providers: Array<{ models: Array<Record<string, unknown>> }> }
  raw.providers[0]!.models[0]!.pricing = { currency: 'CNY', input_per_mtok: 1 }
  assert.deepEqual(expectFail(raw), ['providers[0].models[0].pricing.output_per_mtok'])
})

test('pricing 的币种限定 CNY / USD', () => {
  const raw = minimal() as { providers: Array<{ models: Array<Record<string, unknown>> }> }
  raw.providers[0]!.models[0]!.pricing = { currency: 'EUR', input_per_mtok: 1, output_per_mtok: 2 }
  assert.deepEqual(expectFail(raw), ['providers[0].models[0].pricing.currency'])
})

test('完整 pricing 被保留，包括缓存分桶', () => {
  const raw = minimal() as { providers: Array<{ models: Array<Record<string, unknown>> }> }
  raw.providers[0]!.models[0]!.pricing = {
    currency: 'CNY', input_per_mtok: 0.5, output_per_mtok: 2,
    cache_read_per_mtok: 0.1, cache_write_per_mtok: 0.6,
  }
  const result = expectOk(raw)
  assert.deepEqual(result.config.providers[0]?.models[0]?.pricing, {
    currency: 'CNY', input_per_mtok: 0.5, output_per_mtok: 2,
    cache_read_per_mtok: 0.1, cache_write_per_mtok: 0.6,
  })
})

test('没有定价表时给出未定价警告，而不是静默', () => {
  const result = expectOk(minimal())
  assert.ok(result.warnings.some((line) => line.includes('未定价')), 'warnings: ' + result.warnings.join(' | '))
})

test('声明 vision 却没声明 image 模态时给出警告', () => {
  const raw = minimal() as { providers: Array<{ models: Array<Record<string, unknown>> }> }
  raw.providers[0]!.models[0]!.capabilities = ['coding', 'vision']
  const result = expectOk(raw)
  assert.ok(result.warnings.some((line) => line.includes('vision')))
})

test('声明 vision 且声明 image 模态时没有该警告', () => {
  const raw = minimal() as { providers: Array<{ models: Array<Record<string, unknown>> }> }
  raw.providers[0]!.models[0]!.capabilities = ['coding', 'vision']
  raw.providers[0]!.models[0]!.input_modalities = ['text', 'image']
  const result = expectOk(raw)
  assert.equal(result.warnings.some((line) => line.includes('vision')), false)
})

test('端点是 http 也接受（本地网关形态）', () => {
  const raw = minimal() as { providers: Array<Record<string, unknown>> }
  raw.providers[0]!.endpoint = 'http://127.0.0.1:8080/v1'
  expectOk(raw)
})

test('headers 的值不允许换行', () => {
  const raw = minimal() as { providers: Array<Record<string, unknown>> }
  raw.providers[0]!.headers = { 'x-a': 'line1\nline2' }
  assert.deepEqual(expectFail(raw), ['providers[0].headers.x-a'])
})

test('routing.aliases 的 pin 必须指向已声明模型', () => {
  const raw = { ...minimal(), routing: { aliases: { analysis: { pin: { provider: 'p1', model: 'ghost' } } } } }
  assert.deepEqual(expectFail(raw), ['routing.aliases.analysis.pin'])
})

test('routing.aliases 的 pin 指向真实模型时通过', () => {
  const raw = { ...minimal(), routing: { aliases: { analysis: { mode: 'max_power', pin: { provider: 'p1', model: 'm1' } } } } }
  const result = expectOk(raw)
  assert.equal(result.config.routing.aliases.analysis?.mode, 'max_power')
  assert.deepEqual(result.config.routing.aliases.analysis?.pin, { provider: 'p1', model: 'm1' })
})

test('别名名必须是合法标识符', () => {
  const raw = { ...minimal(), routing: { aliases: { 'bad name!': { mode: 'frugal' } } } }
  assert.deepEqual(expectFail(raw), ['routing.aliases.bad name!'])
})

test('agent_overrides 与 aliases 同构，pin 同样校验', () => {
  const raw = { ...minimal(), routing: { agent_overrides: { visual_agent: { pin: { provider: 'p1', model: 'ghost' } } } } }
  assert.deepEqual(expectFail(raw), ['routing.agent_overrides.visual_agent.pin'])
})

test('所有模型都 offline 时给出警告', () => {
  const raw = minimal() as { providers: Array<{ models: Array<Record<string, unknown>> }> }
  raw.providers[0]!.models[0]!.availability = 'offline'
  const result = expectOk(raw)
  assert.ok(result.warnings.some((line) => line.includes('offline')))
})

test('parsePoolOrThrow 在失败时抛出带路径的错误', () => {
  assert.throws(() => parsePoolOrThrow({ providers: [] }), /providers/)
})

test('parsePoolOrThrow 成功时直接返回配置', () => {
  assert.equal(parsePoolOrThrow(minimal()).providers[0]?.provider_name, 'p1')
})

test('拒绝要尽早：第一个致命错误就收口，不制造级联噪声', () => {
  const raw = {
    defaults: { max_attempts: 0 },
    routing: { mode: 'turbo' },
    providers: [
      { provider_name: 'p1', endpoint: 'https://p1.example/v1', api: 'openai-completions', api_key: 'env:K', models: [] },
    ],
  }
  assert.deepEqual(expectFail(raw), ['defaults.max_attempts'])
})

test('真实示例形态可被完整解析', () => {
  const raw = {
    version: 1,
    defaults: { timeout_ms: 60000, max_attempts: 3, cooldown_ms: 30000, failure_threshold: 3, half_open_after_ms: 60000 },
    routing: {
      mode: 'frugal',
      agent_overrides: { visual_agent: { require: ['vision'] }, analysis_agent: { mode: 'max_power' } },
    },
    providers: [
      {
        provider_name: 'deepseek-official',
        endpoint: 'https://api.deepseek.com/v1',
        api: 'openai-completions',
        api_key: 'env:DEEPSEEK_API_KEY',
        headers: {},
        models: [{
          id: 'deepseek-flash',
          display_name: 'DeepSeek V4.1 Flash',
          capabilities: ['fast', 'coding', 'tool-use', 'long-context'],
          cost_level: 'low',
          context_window: 1000000,
          max_output_tokens: 32768,
          availability: 'direct',
          input_modalities: ['text'],
          max_concurrency: 8,
          rpm: 600,
          quality_rank: 62,
          pricing: { currency: 'CNY', input_per_mtok: 0.5, output_per_mtok: 2.0, cache_read_per_mtok: 0.1 },
        }],
      },
      {
        provider_name: 'agnes',
        endpoint: 'https://api.agnes-ai.cn/v1',
        api: 'openai-completions',
        api_key: 'env:AGNES_API_KEY',
        models: [{
          id: 'agnes-3.0-flash',
          display_name: 'Agnes 3.0 Flash',
          capabilities: ['fast', 'coding', 'vision'],
          cost_level: 'free',
          context_window: 128000,
          availability: 'direct',
          input_modalities: ['text', 'image'],
          max_concurrency: 4,
          quality_rank: 48,
        }],
      },
      {
        provider_name: 'mirror-cn',
        endpoint: 'https://mirror.example.cn/v1',
        api: 'openai-completions',
        api_key: 'env:MIRROR_API_KEY',
        headers: { 'x-opencode-session': '{{opencodeSession}}' },
        models: [{
          id: 'glm-5.3-flash',
          capabilities: ['fast', 'coding', 'reasoning', 'tool-use'],
          cost_level: 'low',
          context_window: 200000,
          availability: 'proxy',
          proxy_url: 'http://127.0.0.1:7890',
          max_concurrency: 2,
          rpm: 60,
          quality_rank: 55,
        }],
      },
    ],
  }
  const result = expectOk(raw)
  assert.equal(result.config.providers.length, 3)
  assert.equal(result.config.providers[2]?.models[0]?.proxy_url, 'http://127.0.0.1:7890')
  assert.equal(result.config.routing.agent_overrides.analysis_agent?.mode, 'max_power')
})
