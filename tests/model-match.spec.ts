/**
 * 上游型号 → 内置档案：别名、快照、同族三级放宽。
 *
 * 这条链要回答的问题只有一个：**用户还需不需要自己给这个模型打标签？**
 * 认得出（精确 / 别名 / 快照 / 同族）就不该再让他打；认不出才问。
 * 同时守两条底线：
 *  - 同族只借标签，不借评级与价目（那是具体型号的事实）；
 *  - 「两代模型」不许被快照规则认成同一个（claude-haiku-4-5 ≠ claude-haiku-5-5）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveModelProfile, resolveModelPrice, modelMatchToInfo } from '../src/core/model-match.ts'
import { looksLikeNonChat, synthesizePool } from '../src/core/vendors.ts'
import type { VendorConfig } from '../src/core/types.ts'

const CACHE = { exact_match: false, max_entries: 500, ttl_ms: 3_600_000 }

function vendor(overrides: Partial<VendorConfig>): VendorConfig {
  return {
    vendorId: 'custom',
    vendorName: '自定义',
    officialUrl: '',
    customUrl: 'https://relay.example.com/v1',
    apiKey: 'sk-test',
    enabledModels: [],
    ...overrides,
  }
}

test('精确 id 与归一化写法仍然是最先命中的一级', () => {
  assert.equal(resolveModelProfile('claude-opus-5-5')?.kind, 'id')
  assert.equal(resolveModelProfile('Claude-Opus-5.5')?.kind, 'id')
})

test('同一模型换了写法：deepseek-flash 靠显示名命中，deepseek-chat 靠别名表', () => {
  // 目录里那一条的显示名就是「深度求索 DeepSeek Flash」，归一化后正好等于 deepseekflash。
  assert.equal(resolveModelProfile('deepseek-flash')?.model.id, 'deepseek-v4-1-flash-1017')
  const alias = resolveModelProfile('deepseek-chat')
  assert.equal(alias?.kind, 'alias')
  assert.equal(alias?.model.id, 'deepseek-v4-1-flash-1017')
})

test('发版快照：只认日期样式的尾巴', () => {
  assert.equal(resolveModelProfile('deepseek-v4-pro')?.model.id, 'deepseek-v4-pro-0813')
  assert.equal(resolveModelProfile('qwen3-8-max')?.model.id, 'qwen3-8-max-0902')
  assert.equal(resolveModelProfile('deepseek-v4-1-flash')?.model.id, 'deepseek-v4-1-flash-1017')
})

test('小版本不是快照：claude-fable-5 不该被当成 5.1', () => {
  const match = resolveModelProfile('claude-fable-5')
  assert.equal(match?.kind, 'family')
  assert.equal(match?.model.id, 'claude-fable-5', '名字必须留上游自己的')
  assert.equal(match?.model.tier, 'NA')
  assert.equal(resolveModelPrice('claude-fable-5'), undefined, '不借 5.1 的价')
})

test('两代模型不许被快照规则认成同一个', () => {
  const match = resolveModelProfile('claude-haiku-4-5-20251001')
  assert.notEqual(match?.kind, 'version')
  assert.equal(match?.model.id, 'claude-haiku-4-5-20251001', '回落到同族时 id 仍是用户写的那个')
})

test('同族：只借能力与擅长标签，评级 NA、没有价目', () => {
  const match = resolveModelProfile('gpt-6.1-terra')
  assert.equal(match?.kind, 'family')
  assert.equal(match?.familyLabel, 'GPT')
  assert.ok(match?.model.strengthTags?.includes('编程'))
  assert.equal(match?.model.tier, 'NA')
  assert.equal(resolveModelPrice('gpt-6.1-terra'), undefined)
})

test('图像族排在 GPT 前面：gpt-image-2 是画图模型，不是聊天模型', () => {
  const match = resolveModelProfile('gpt-image-2')
  assert.equal(match?.kind, 'family')
  assert.equal(match?.familyLabel, '图像生成')
  assert.equal(match?.model.imageOutput, true)
  const info = modelMatchToInfo(match!, 'gpt-image-2')
  assert.ok(info.capabilities.includes('image_gen'))
})

test('中转站与第三方平台常见写法都认得出（qwen / ds / glm / claude / gpt）', () => {
  for (const id of ['Qwen', 'deepseek-flash', 'glm-flash', 'claude-fable-5', 'gpt-6.1-terra']) {
    assert.notEqual(resolveModelProfile(id), undefined, id + ' 应该认得出')
  }
})

test('真认不出来的型号仍然是 undefined——不编', () => {
  assert.equal(resolveModelProfile('totally-unknown-model'), undefined)
  assert.equal(resolveModelProfile(''), undefined)
})

test('价目按用户写的 id 取：同一族的两个快照各拿各的公开价', () => {
  assert.deepEqual(resolveModelPrice('deepseek-v4-pro'), { input: 1.27, output: 3.8 })
  assert.deepEqual(resolveModelPrice('deepseek-v4-pro-0813'), { input: 0.14, output: 0.56 })
  // 目录里没有自己的价目时，才退回认出来的那一条（快照关系）。
  assert.deepEqual(resolveModelPrice('deepseek-v4-1-flash'), { input: 0.28, output: 1.1 })
})

test('池合成：中转站拉来的 GPT / Claude 带内置标签，不再算「未收录」', () => {
  const pool = synthesizePool([vendor({
    vendorId: 'openai',
    enabledModels: ['gpt-6-astra', 'gpt-6.1-terra', 'claude-fable-5'],
  })], 'frugal', CACHE)
  const models = pool.providers[0]!.models
  const astra = models.find((model) => model.id === 'gpt-6-astra')!
  assert.equal(astra.tier, 'SS', '目录里有的仍然拿完整档案')
  const terra = models.find((model) => model.id === 'gpt-6.1-terra')!
  assert.equal(terra.tier, 'NA', '同族不借评级')
  assert.ok((terra.strengthTags ?? []).includes('编程'), '同族借标签')
  assert.equal(terra.pricing, undefined, '同族不借价目')
  // 小版本不是快照：只借同族标签，不借评级与价目，也不改名。
  const fable = models.find((model) => model.id === 'claude-fable-5')!
  assert.equal(fable.display_name, 'claude-fable-5')
  assert.equal(fable.tier, 'NA')
  assert.equal(fable.pricing, undefined)
  assert.ok((fable.strengthTags ?? []).includes('编程'))
})

test('池合成：Westlake 那种自建端点上的 qwen / ds / glm 也带标签', () => {
  const pool = synthesizePool([vendor({
    customUrl: 'https://hpc-api.westlake.edu.cn/v1',
    enabledModels: ['Qwen', 'deepseek-flash', 'glm-flash'],
  })], 'frugal', CACHE)
  const models = pool.providers[0]!.models
  for (const id of ['Qwen', 'deepseek-flash', 'glm-flash']) {
    const entry = models.find((model) => model.id === id)!
    assert.ok((entry.strengthTags ?? []).length > 0, id + ' 应该有擅长标签')
  }
  // 别名命中的那条同时拿到了价目（0.28 / 1.13），同族的两条没有。
  const ds = models.find((model) => model.id === 'deepseek-flash')!
  assert.deepEqual(ds.pricing, { currency: 'USD', input_per_mtok: 0.28, output_per_mtok: 1.13 })
  const qwen = models.find((model) => model.id === 'Qwen')!
  assert.equal(qwen.pricing, undefined)
})

test('画图 / 视频 / 向量模型不进对话路由（chat: false）', () => {
  for (const id of ['gpt-image-2', 'flux-1', 'sora-2', 'qwen-embedding-8b', 'rerank-3']) {
    assert.equal(looksLikeNonChat(id), true, id + ' 不该被当成聊天模型')
  }
  for (const id of ['gpt-6-astra', 'claude-opus-5-5', 'deepseek-flash']) {
    assert.equal(looksLikeNonChat(id), false, id + ' 是聊天模型')
  }
})

test('池合成：图片模型进池但标成非对话，路由与白嫖都不会挑它', () => {
  const pool = synthesizePool([vendor({
    vendorId: 'openai',
    enabledModels: ['gpt-6-astra', 'gpt-image-2.5-flare'],
  })], 'frugal', CACHE)
  const image = pool.providers[0]!.models.find((model) => model.id === 'gpt-image-2.5-flare')!
  assert.equal(image.chat, false)
  assert.equal(image.imageOutput, true)
  const chat = pool.providers[0]!.models.find((model) => model.id === 'gpt-6-astra')!
  assert.notEqual(chat.chat, false)
})
