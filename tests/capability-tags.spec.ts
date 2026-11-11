/**
 * 用户打的标签要真的改变路由。
 *
 * 起因：免费池里的三个自建端点型号（自建端点上的 deepseek-flash / glm-flash / Qwen）
 * 上游明明能看图，用户也在面板里标了「多模态」，带图的请求却一直被
 * `missing-capability:vision` 拒掉——因为标签只写进了展示用的 strengthTags，
 * 没有进引擎的 capabilities。
 *
 * 这里钉住三件事：
 *  - 标签怎么写法都能认成能力（vision / 多模态 / 看图）；
 *  - 能力标签进 capabilities，同时把输入模态补上 image；
 *  - 不标就还是不能看图（不能为了「能跑」把所有人都当成多模态）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { capabilityOf, CAPABILITY_TAGS, synthesizePool } from '../src/core/vendors.ts'
import { createRouter } from '../src/core/router.ts'
import { inferIntent } from '../src/core/intent.ts'
import type { VendorConfig } from '../src/core/types.ts'

const CACHE = { exact_match: false, max_entries: 10, ttl_ms: 1_000 }

function vendor(overrides: Partial<VendorConfig> = {}): VendorConfig {
  return {
    vendorId: 'lab',
    vendorName: 'lab',
    officialUrl: 'https://relay.example.com/v1',
    customUrl: '',
    endpointSource: 'official',
    apiKey: 'sk-test',
    enabledModels: ['deepseek-flash'],
    ...overrides,
  }
}

/** 一条带图的请求：文本 + data URL 图片。 */
function imageIntent(modelId: string): ReturnType<typeof inferIntent>['intent'] {
  const body = {
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '这张图是什么颜色' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAB' } },
      ],
    }],
  }
  return inferIntent(body, modelId, Date.now()).intent
}

test('标签写法：英文、中文、大小写都认得出是同一个能力', () => {
  for (const tag of ['vision', 'Vision', '多模态', '看图', '视觉', '图像理解']) {
    assert.equal(capabilityOf(tag), 'vision', tag)
  }
  assert.equal(capabilityOf('编程'), 'coding')
  assert.equal(capabilityOf('tool use'), 'tool-use')
  assert.equal(capabilityOf('长上下文'), 'long-context')
  // 纯展示标签不该被误认成能力。
  assert.equal(capabilityOf('文案'), undefined)
  assert.equal(capabilityOf('做题'), undefined)
  assert.equal(capabilityOf(''), undefined)
  // 归一化出来的每个能力都必须是引擎真正认识的那几个。
  for (const tag of CAPABILITY_TAGS) assert.equal(capabilityOf(tag), tag)
})

test('标了「多模态」的型号：capabilities 与输入模态都补上', () => {
  const pool = synthesizePool([vendor({ modelTags: { 'deepseek-flash': ['多模态'] } })], 'free', CACHE)
  const entry = pool.providers[0]!.models[0]!
  assert.ok(entry.capabilities.includes('vision'), 'vision 要进 capabilities，否则硬过滤会拦')
  assert.deepEqual(entry.input_modalities, ['text', 'image'])
  assert.equal(entry.imageInput, true)
  // 标签本身仍然留着，AI 调控与卡片展示还要用。
  assert.ok((entry.strengthTags ?? []).includes('多模态'))
})

test('路由：免费档里带图请求会落到被标了 vision 的型号上', () => {
  // 免费档只认零成本的型号：用户把这一家的价目填成 0（自建端点的常见用法）。
  const pool = synthesizePool([vendor({
    modelTags: { 'deepseek-flash': ['vision'] },
    modelPricing: { 'deepseek-flash': { input: 0, output: 0 } },
  })], 'free', CACHE)
  const router = createRouter(pool)
  const plan = router.plan(imageIntent('steward:free'), Date.now(), 'req-1')
  assert.equal(plan.ok, true, plan.ok ? '' : JSON.stringify(plan.refusal.rejected))
  if (plan.ok) {
    assert.equal(plan.decision.chosen.model, 'deepseek-flash')
  }
})

test('没标注的型号仍然接不了图——不会为了能跑把所有人都当成多模态', () => {
  const pool = synthesizePool([vendor({ modelPricing: { 'deepseek-flash': { input: 0, output: 0 } } })], 'free', CACHE)
  const router = createRouter(pool)
  const plan = router.plan(imageIntent('steward:free'), Date.now(), 'req-1')
  assert.equal(plan.ok, false)
  if (!plan.ok) {
    assert.equal(plan.refusal.code, 'no-capable-model')
    assert.ok(plan.refusal.rejected.some((entry) => entry.reason === 'missing-capability:vision'))
  }
})

test('纯文本请求不受影响：标了 vision 也不影响它被选中', () => {
  const pool = synthesizePool([vendor({
    modelTags: { 'deepseek-flash': ['vision'] },
    modelPricing: { 'deepseek-flash': { input: 0, output: 0 } },
  })], 'free', CACHE)
  const router = createRouter(pool)
  const { intent } = inferIntent({ messages: [{ role: 'user', content: '你好' }] }, 'steward:free', Date.now())
  const plan = router.plan(intent, Date.now(), 'req-2')
  assert.equal(plan.ok, true)
})

test('目录已认识的多模态型号不因用户标签而丢能力（合并而不是覆盖）', () => {
  const pool = synthesizePool([vendor({
    vendorId: 'openai',
    officialUrl: 'https://api.openai.com/v1',
    enabledModels: ['gpt-6-astra'],
    modelTags: { 'gpt-6-astra': ['快速'] },
  })], 'frugal', CACHE)
  const entry = pool.providers[0]!.models[0]!
  assert.ok(entry.capabilities.includes('vision'), '目录里本来就有的 vision 不能被用户标签挤掉')
  assert.ok(entry.capabilities.includes('fast'), '用户补的 fast 要加上')
})
