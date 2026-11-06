/**
 * format.ts：展示格式化的严谨性。
 *
 * 这些断言直接对应用户会说错的三句话：「今天花了 0 元」「缓存命中 0%」
 * 「这个模型免费」——每一条都必须是破折号或明确值，而不是一个看起来像数的 0。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HEALTH_LABEL,
  MODE_HINT,
  MODE_LABEL,
  MODE_ORDER,
  UNPRICED,
  UNKNOWN,
  formatCost,
  formatLatency,
  formatPercent,
  formatRemaining,
  formatTokens,
} from '../src/core/format.ts'

test('formatTokens 在三个量级上各自缩写', () => {
  assert.equal(formatTokens(0), '0')
  assert.equal(formatTokens(999), '999')
  assert.equal(formatTokens(1_500), '1.5K')
  assert.equal(formatTokens(12_400_000), '12.4M')
})

test('formatTokens 对负数与非数按 0', () => {
  assert.equal(formatTokens(-5), '0')
  assert.equal(formatTokens(Number.NaN), '0')
})

test('formatCost 对 null 显示破折号，而不是 ¥0', () => {
  assert.equal(formatCost(null), UNPRICED)
  assert.equal(formatCost(undefined), UNPRICED)
})

test('formatCost 对金额为 0 的对象仍显示 0（这是真的 0 元）', () => {
  assert.equal(formatCost({ currency: 'CNY', amount: 0 }), '¥0')
})

test('formatCost 按量级选择小数位', () => {
  assert.equal(formatCost({ currency: 'CNY', amount: 235.4509 }), '¥235')
  assert.equal(formatCost({ currency: 'CNY', amount: 2.5678 }), '¥2.57')
  assert.equal(formatCost({ currency: 'USD', amount: 0.0123 }), '$0.0123')
})

test('formatCost 支持未知币种', () => {
  assert.equal(formatCost({ currency: 'EUR', amount: 1 }), 'EUR 1.00')
})

test('formatPercent 对未知显示破折号，对 0 显示 0.0%', () => {
  assert.equal(formatPercent(null), UNKNOWN)
  assert.equal(formatPercent(undefined), UNKNOWN)
  assert.equal(formatPercent(0), '0.0%')
  assert.equal(formatPercent(0.2534), '25.3%')
})

test('formatLatency 在秒级切换单位', () => {
  assert.equal(formatLatency(820), '820ms')
  assert.equal(formatLatency(1_234), '1.2s')
  assert.equal(formatLatency(undefined), UNKNOWN)
})

test('formatRemaining 对已到期返回 undefined', () => {
  assert.equal(formatRemaining(1_000, 2_000), undefined)
  assert.equal(formatRemaining(undefined, 2_000), undefined)
  assert.equal(formatRemaining(28_000, 0), '28s')
  assert.equal(formatRemaining(120_000, 0), '2m')
  assert.equal(formatRemaining(400, 0), '<1s')
})

test('四个模式都有标签与解释，且顺序固定', () => {
  assert.deepEqual(MODE_ORDER, ['frugal', 'balanced', 'max_power', 'free'])
  for (const mode of MODE_ORDER) {
    assert.ok(MODE_LABEL[mode].length > 0)
    assert.ok(MODE_HINT[mode].length > 0)
  }
  assert.equal(MODE_LABEL.frugal, '极致便宜')
  assert.equal(MODE_LABEL.free, '白嫖模式')
})

test('五种健康状态都有中文标签', () => {
  for (const state of ['active', 'cooling', 'half-open', 'open', 'offline']) {
    assert.ok((HEALTH_LABEL[state] ?? '').length > 0, state)
  }
})
