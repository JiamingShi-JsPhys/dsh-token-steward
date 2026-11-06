/**
 * Ledger fold/cost/prune/serialization tests.
 * @module tests/ledger.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'

function assertCloseTo(actual: number | undefined, expected: number, epsilon = 1e-9): void {
  assert.ok(actual !== undefined && Math.abs(actual - expected) < epsilon, `expected ${String(actual)} ~= ${expected}`)
}
import { UsageLedger, addUsage, dayKeyOf, emptyTotals, promptCacheHitRate } from '../src/core/ledger.ts'

const CNY = { currency: 'CNY', input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 }
const USD = { currency: 'USD', input: 1, output: 3 }

test('day keys use local time with zero padding', () => {
  assert.equal(dayKeyOf(new Date(2026, 0, 5)), '2026-01-05')
  assert.equal(dayKeyOf(new Date(2026, 10, 23)), '2026-11-23')
})

test('addUsage folds token families and estimates cost per currency', () => {
  const totals = emptyTotals()
  addUsage(totals, { inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 250_000, cacheWriteTokens: 250_000, reasoningTokens: 100 }, CNY)
  assert.equal(totals.inputTokens, 1_000_000)
  assert.equal(totals.calls, 1)
  // billed input = 1M + 0.25M + 0.25M = 1.5M × ¥2 = ¥3
  // output 0.5M × ¥8 = ¥4 ; cacheRead 0.25M × ¥0.5 = ¥0.125 ; cacheWrite 0.25M × ¥2 = ¥0.5
  assertCloseTo(totals.costByCurrency.CNY, 7.625)
})

test('currencies never mix', () => {
  const ledger = new UsageLedger()
  const now = new Date(2026, 10, 6, 12)
  ledger.add('a/model', { inputTokens: 1_000_000, outputTokens: 0 }, CNY, now)
  ledger.add('b/model', { inputTokens: 1_000_000, outputTokens: 0 }, USD, now)
  const today = ledger.todayTotals(now)
  assert.equal(today.costByCurrency.CNY, 2)
  assert.equal(today.costByCurrency.USD, 1)
})

test('negative/undefined usage fields are treated as zero', () => {
  const totals = emptyTotals()
  addUsage(totals, { inputTokens: -5, outputTokens: undefined, totalTokens: 999 }, CNY)
  assert.equal(totals.inputTokens, 0)
  assert.equal(totals.outputTokens, 0)
  assert.equal(totals.calls, 1, 'the call itself still counts')
})

test('agent attribution folds independently', () => {
  const ledger = new UsageLedger()
  const now = new Date(2026, 10, 6, 12)
  ledger.addForAgent('idea_swarm#2', { inputTokens: 10, outputTokens: 20 }, CNY, now)
  ledger.addForAgent('idea_swarm#2', { inputTokens: 1, outputTokens: 2 }, CNY, now)
  const day = ledger.doc.agents['2026-11-06']!
  assert.equal(day['idea_swarm#2']?.calls, 2)
  assert.equal(day['idea_swarm#2']?.inputTokens, 11)
})

test('prune drops days beyond the retention window', () => {
  const ledger = new UsageLedger()
  ledger.add('m', { inputTokens: 1 }, CNY, new Date(2026, 0, 1))
  ledger.add('m', { inputTokens: 1 }, CNY, new Date(2026, 9, 1))
  const now = new Date(2026, 9, 15)
  const removed = ledger.prune(30, now)
  assert.equal(removed, 1)
  assert.ok(!('2026-01-01' in ledger.doc.days))
  assert.ok('2026-10-01' in ledger.doc.days)
})

test('JSON round-trip preserves the fold', () => {
  const ledger = new UsageLedger()
  const now = new Date(2026, 10, 6, 12)
  ledger.add('m/x', { inputTokens: 42, outputTokens: 7 }, CNY, now)
  const revived = UsageLedger.fromJSON(JSON.parse(JSON.stringify(ledger.toJSON())))
  assert.equal(revived.todayTotals(now).inputTokens, 42)
})

test('fromJSON tolerates garbage', () => {
  for (const garbage of [undefined, null, 'x', 42, {}, { version: 2, days: 1 }]) {
    const ledger = UsageLedger.fromJSON(garbage)
    assert.equal(ledger.todayTotals(new Date()).inputTokens, 0)
  }
})

test('prompt cache hit rate follows the billed-input convention', () => {
  const hit = emptyTotals()
  addUsage(hit, { inputTokens: 300, cacheReadTokens: 100 }, undefined)
  assertCloseTo(promptCacheHitRate(hit), 0.25)
  assert.equal(promptCacheHitRate(emptyTotals()), 0, 'nothing billed → rate 0')
})
