/**
 * 价格层：所有「贵 / 便宜 / 省了多少」的计算都在这里钉死。
 *
 * 三条诚实规则必须有测试：未定价是 null 不是 0、混币不相加、节省不能为负。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LIST_PRICES, costOfUsage, isFreePriced, listPriceOf, outputPer1k, priceOf, savingAgainst } from '../src/core/pricing.ts'
import { model } from './fixtures.ts'

test('目录估算价覆盖全部 30+ 个模型，且都是非负有限数', () => {
  const entries = Object.entries(LIST_PRICES)
  assert.ok(entries.length >= 30, '目录模型应有足够多的价目，实际 ' + String(entries.length))
  for (const [id, price] of entries) {
    assert.ok(Number.isFinite(price.input) && price.input >= 0, id + ' 输入价非法')
    assert.ok(Number.isFinite(price.output) && price.output >= 0, id + ' 输出价非法')
  }
})

test('priceOf：pricing 优先于 costPer1k，两者都没有时是 null（未定价）', () => {
  const yaml = model({
    id: 'a',
    pricing: { currency: 'CNY', input_per_mtok: 2, output_per_mtok: 8 },
    costPer1kInput: 0.001,
    costPer1kOutput: 0.002,
  })
  assert.deepEqual(priceOf(yaml), { currency: 'CNY', input: 2, output: 8 })

  const catalog = model({ id: 'b', costPer1kInput: 0.001, costPer1kOutput: 0.002 })
  assert.deepEqual(priceOf(catalog), { currency: 'USD', input: 1, output: 2 })

  assert.equal(priceOf(model({ id: 'c' })), null, '未定价必须是 null，不是 0')
})

test('costOfUsage：按每百万 token 计价，输入与输出分开', () => {
  const price = { currency: 'USD', input: 1, output: 10 }
  const cost = costOfUsage(price, { input: 1_000_000, output: 100_000 })
  assert.ok(cost !== null)
  assert.equal(cost.currency, 'USD')
  assert.equal(cost.amount, 2, '1M 输入 = 1 美元，0.1M 输出 = 1 美元')
})

test('costOfUsage：未定价返回 null，绝不冒充 0', () => {
  assert.equal(costOfUsage(null, { input: 1_000, output: 1_000 }), null)
})

test('savingAgainst：便宜模型相对基准模型的差额', () => {
  const baseline = model({ id: 'base', pricing: { currency: 'USD', input_per_mtok: 10, output_per_mtok: 40 } })
  const chosen = model({ id: 'cheap', pricing: { currency: 'USD', input_per_mtok: 1, output_per_mtok: 4 } })
  const usage = { input: 1_000_000, output: 1_000_000 }
  const saved = savingAgainst(chosen, baseline, usage)
  assert.ok(saved !== null)
  assert.equal(saved.currency, 'USD')
  assert.equal(saved.amount, 45, '(10+40) - (1+4)')
})

test('savingAgainst：选得比基准更贵时是 0，不是负数', () => {
  const baseline = model({ id: 'base', pricing: { currency: 'USD', input_per_mtok: 1, output_per_mtok: 1 } })
  const chosen = model({ id: 'pricey', pricing: { currency: 'USD', input_per_mtok: 9, output_per_mtok: 9 } })
  const saved = savingAgainst(chosen, baseline, { input: 1_000_000, output: 0 })
  assert.deepEqual(saved, { currency: 'USD', amount: 0 })
})

test('savingAgainst：任一侧未定价 → null（不猜）', () => {
  const priced = model({ id: 'a', pricing: { currency: 'USD', input_per_mtok: 1, output_per_mtok: 1 } })
  const unpriced = model({ id: 'b' })
  assert.equal(savingAgainst(priced, unpriced, { input: 1_000, output: 1_000 }), null)
})

test('savingAgainst：币种不同 → null（混币绝不相加）', () => {
  const usd = model({ id: 'a', pricing: { currency: 'USD', input_per_mtok: 10, output_per_mtok: 10 } })
  const cny = model({ id: 'b', pricing: { currency: 'CNY', input_per_mtok: 1, output_per_mtok: 1 } })
  assert.equal(savingAgainst(cny, usd, { input: 1_000, output: 1_000 }), null)
})

test('outputPer1k：成本排序的稳定口径', () => {
  assert.equal(outputPer1k(model({ id: 'a', costPer1kOutput: 0.002 })), 0.002)
  assert.equal(outputPer1k(model({ id: 'b' })), null)
})

test('Agnes 只有 2.0 / 3.0 flash 免费，其余档位照常计费', () => {
  assert.equal(isFreePriced('agnes-3.0-flash'), true)
  assert.equal(isFreePriced('agnes-2.0-flash'), true)
  assert.deepEqual(listPriceOf('agnes-3.0-flash'), { input: 0, output: 0 })
  // 别把整家标成 0：免费档会照着价目真去调付费型号。
  assert.equal(isFreePriced('agnes-2.5-pro'), false)
  assert.equal(isFreePriced('agnes-2.5-flash'), false)
  // 缺数据的型号仍然返回 undefined，别把「不知道」当成「免费」。
  assert.equal(isFreePriced('agnes-brand-new-model'), false)
})
