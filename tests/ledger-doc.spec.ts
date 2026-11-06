/**
 * ledger-doc.ts：台账文档的纯函数行为。
 *
 * 重点覆盖两件在生产里会咬人的事：手改坏的文件能不能被修复而不是丢掉全部历史，
 * 以及「保留 180 天」到底删哪一天。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LEDGER_VERSION,
  createLedgerDocument,
  dayOf,
  deserializeLedger,
  emptyModelStat,
  foldEvent,
  foldUsage,
  isDateKey,
  localDateKey,
  modelStatOf,
  pruneLedger,
  totalTokens,
} from '../src/core/ledger-doc.ts'
import type { RouteEventView } from '../src/core/types.ts'

function event(overrides: Partial<RouteEventView> = {}): RouteEventView {
  return {
    at: overrides.at ?? Date.UTC(2026, 10, 6, 12, 0, 0),
    requestId: overrides.requestId ?? 'r1',
    mode: overrides.mode ?? 'frugal',
    provider: overrides.provider ?? 'p1',
    model: overrides.model ?? 'm1',
    degradedFrom: overrides.degradedFrom ?? [],
    ok: overrides.ok ?? true,
    latencyMs: overrides.latencyMs ?? 100,
    committed: overrides.committed ?? false,
  }
}

test('新文档是空的且版本正确', () => {
  const document = createLedgerDocument()
  assert.equal(document.version, LEDGER_VERSION)
  assert.deepEqual(document.days, {})
})

test('localDateKey 按本地时间给出 YYYY-MM-DD', () => {
  const ms = new Date(2026, 10, 6, 23, 30, 0).getTime()
  assert.equal(localDateKey(ms), '2026-11-06')
})

test('isDateKey 挡住手改坏的日期', () => {
  assert.equal(isDateKey('2026-11-06'), true)
  assert.equal(isDateKey('2026-13-01'), false)
  assert.equal(isDateKey('2026-02-30'), false)
  assert.equal(isDateKey('26-11-06'), false)
  assert.equal(isDateKey('2026-11-06x'), false)
})

test('成功事件折进当天台账：chosen/attempts/延迟都记', () => {
  const document = createLedgerDocument()
  foldEvent(document, event({ latencyMs: 250 }), '2026-11-06')
  const day = document.days['2026-11-06']
  assert.ok(day)
  assert.equal(day.requests, 1)
  assert.equal(day.modes.frugal, 1)
  assert.equal(day.degraded, 0)
  const stat = day.models['p1/m1']
  assert.ok(stat)
  assert.equal(stat.chosen, 1)
  assert.equal(stat.attempts, 1)
  assert.equal(stat.failures, 0)
  assert.equal(stat.latencyMs, 250)
  assert.equal(stat.latencySamples, 1)
})

test('降级事件：失败尝试与被降级掉的上游都计入 attempts', () => {
  const document = createLedgerDocument()
  foldEvent(document, event({
    provider: 'p2',
    model: 'm2',
    degradedFrom: [
      { provider: 'p1', model: 'm1', errorKind: 'rate-limit' },
      { provider: 'p3', model: 'm3', errorKind: 'timeout' },
    ],
  }), '2026-11-06')
  const day = document.days['2026-11-06']
  assert.ok(day)
  assert.equal(day.degraded, 1)
  assert.equal(day.models['p2/m2']?.attempts, 3)
})

test('失败事件计入 failures 而不是 chosen', () => {
  const document = createLedgerDocument()
  foldEvent(document, event({ ok: false }), '2026-11-06')
  const stat = document.days['2026-11-06']?.models['p1/m1']
  assert.ok(stat)
  assert.equal(stat.chosen, 0)
  assert.equal(stat.failures, 1)
})

test('三种模式分别计数', () => {
  const document = createLedgerDocument()
  foldEvent(document, event({ mode: 'frugal' }), '2026-11-06')
  foldEvent(document, event({ mode: 'balanced' }), '2026-11-06')
  foldEvent(document, event({ mode: 'balanced' }), '2026-11-06')
  const day = document.days['2026-11-06']
  assert.equal(day?.modes.frugal, 1)
  assert.equal(day?.modes.balanced, 2)
  assert.equal(day?.modes.max_power, undefined)
})

test('usage 累加到当天模型，五个桶各自相加', () => {
  const document = createLedgerDocument()
  foldUsage(document, 'p1/m1', '2026-11-06', { input: 10, output: 2, cacheRead: 3, cacheWrite: 1, reasoning: 4 })
  foldUsage(document, 'p1/m1', '2026-11-06', { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 })
  const stat = document.days['2026-11-06']?.models['p1/m1']
  assert.ok(stat)
  assert.equal(stat.usage.input, 15)
  assert.equal(stat.usage.output, 3)
  assert.equal(stat.usage.reasoning, 4)
  assert.equal(totalTokens(stat.usage), 15 + 3 + 3 + 1 + 4)
})

test('dayOf / modelStatOf 幂等取用', () => {
  const document = createLedgerDocument()
  const first = dayOf(document, '2026-11-06')
  const second = dayOf(document, '2026-11-06')
  assert.equal(first, second)
  const statA = modelStatOf(first, 'p1/m1')
  const statB = modelStatOf(first, 'p1/m1')
  assert.equal(statA, statB)
})

test('emptyModelStat 的五个桶都是 0', () => {
  assert.deepEqual(emptyModelStat().usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 })
})

test('pruneLedger 删除保留期之外的日子，并返回被删的键', () => {
  const document = createLedgerDocument()
  dayOf(document, '2026-11-06')
  dayOf(document, '2026-11-05')
  dayOf(document, '2026-10-01')
  dayOf(document, '2025-01-01')
  const removed = pruneLedger(document, '2026-11-06', 2)
  assert.deepEqual(removed, ['2025-01-01', '2026-10-01'])
  assert.deepEqual(Object.keys(document.days).sort(), ['2026-11-05', '2026-11-06'])
})

test('pruneLedger 保留期含今天在内', () => {
  const document = createLedgerDocument()
  dayOf(document, '2026-11-06')
  const removed = pruneLedger(document, '2026-11-06', 1)
  assert.deepEqual(removed, [])
  assert.ok(document.days['2026-11-06'])
})

test('pruneLedger 对非法 today 不做任何删除（宁可不删也不误删）', () => {
  const document = createLedgerDocument()
  dayOf(document, '2026-11-06')
  assert.deepEqual(pruneLedger(document, 'bad-date', 30), [])
  assert.ok(document.days['2026-11-06'])
})

test('deserializeLedger 拒绝根不是对象', () => {
  assert.throws(() => deserializeLedger([]), /root/)
  assert.throws(() => deserializeLedger(null), /root/)
})

test('deserializeLedger 拒绝未知版本，交给调用方隔离', () => {
  assert.throws(() => deserializeLedger({ version: 99, days: {} }), /version/)
})

test('deserializeLedger 丢弃非法日期键而不是整份失败', () => {
  const document = deserializeLedger({
    version: LEDGER_VERSION,
    days: {
      '2026-11-06': { models: {}, modes: {}, degraded: 0, requests: 3 },
      'not-a-date': { models: {}, modes: {}, degraded: 0, requests: 9 },
    },
  })
  assert.deepEqual(Object.keys(document.days), ['2026-11-06'])
  assert.equal(document.days['2026-11-06']?.requests, 3)
})

test('deserializeLedger 修复脏统计而不是丢掉整份历史', () => {
  const document = deserializeLedger({
    version: LEDGER_VERSION,
    days: {
      '2026-11-06': {
        requests: 'oops',
        degraded: -5,
        modes: { frugal: 2, turbo: 9 },
        models: {
          'p1/m1': { chosen: 3, attempts: 'x', failures: null, usage: { input: 7, output: -1 } },
          'badkey': { chosen: 1 },
        },
      },
    },
  })
  const day = document.days['2026-11-06']
  assert.ok(day)
  assert.equal(day.requests, 0)
  assert.equal(day.degraded, 0)
  assert.deepEqual(day.modes, { frugal: 2 })
  assert.equal(day.models['badkey'], undefined)
  const stat = day.models['p1/m1']
  assert.ok(stat)
  assert.equal(stat.chosen, 3)
  assert.equal(stat.attempts, 0)
  assert.equal(stat.failures, 0)
  assert.equal(stat.usage.input, 7)
  assert.equal(stat.usage.output, 0)
})

test('往返：写出去再读回来结构一致', () => {
  const document = createLedgerDocument()
  foldEvent(document, event({ latencyMs: 300 }), '2026-11-06')
  foldUsage(document, 'p1/m1', '2026-11-06', { input: 100, output: 20, cacheRead: 5, cacheWrite: 0, reasoning: 3 })
  const revived = deserializeLedger(JSON.parse(JSON.stringify(document)))
  assert.deepEqual(revived, document)
})
