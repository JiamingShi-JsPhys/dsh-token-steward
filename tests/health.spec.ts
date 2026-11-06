/**
 * health.ts：状态机行为。
 *
 * 每条断言都对应一条运维后果：冷却该不该退避、熔断该不该在半开时放行、
 * 用户取消该不该污染健康分。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  advance,
  beginAttempt,
  createHealth,
  isAvailable,
  setOffline,
  settleAttempt,
  unavailableReason,
  visibleState,
} from '../src/core/health.ts'
import { model } from './fixtures.ts'
import type { AttemptResult } from '../src/core/types.ts'

const DEFAULTS = { cooldown_ms: 30_000, failure_threshold: 3, half_open_after_ms: 60_000 }

function failure(errorKind: NonNullable<AttemptResult['errorKind']>, latencyMs = 100): AttemptResult {
  return { requestId: 'r1', provider: 'p', model: 'm', ok: false, errorKind, latencyMs, committed: false }
}

function success(latencyMs = 100): AttemptResult {
  return { requestId: 'r1', provider: 'p', model: 'm', ok: true, latencyMs, committed: false }
}

test('新模型是 active、并发 0、无延迟样本', () => {
  const health = createHealth(0)
  assert.equal(health.state, 'active')
  assert.equal(health.inFlight, 0)
  assert.equal(health.samples, 0)
  assert.equal(health.ewmaLatencyMs, undefined)
})

test('占住并发位并在结束后释放', () => {
  const health = createHealth(0)
  beginAttempt(health, 1000)
  beginAttempt(health, 1000)
  assert.equal(health.inFlight, 2)
  settleAttempt(health, success(), 1200, DEFAULTS)
  assert.equal(health.inFlight, 1)
})

test('成功一次就把延迟写进 EWMA 并记一个样本', () => {
  const health = createHealth(0)
  settleAttempt(health, success(200), 1_000, DEFAULTS)
  assert.equal(health.ewmaLatencyMs, 200)
  assert.equal(health.samples, 1)
})

test('第二次成功按 0.3 权重平滑，而不是直接覆盖', () => {
  const health = createHealth(0)
  settleAttempt(health, success(200), 1_000, DEFAULTS)
  settleAttempt(health, success(1_200), 2_000, DEFAULTS)
  // 200*0.7 + 1200*0.3 = 500
  assert.equal(health.ewmaLatencyMs, 500)
})

test('429 立即冷却，并按失败次数指数退避', () => {
  const health = createHealth(0)
  settleAttempt(health, failure('rate-limit'), 1_000, DEFAULTS)
  assert.equal(health.state, 'cooling')
  assert.equal(health.resumeAt, 1_000 + 30_000)

  settleAttempt(health, failure('rate-limit'), 31_000, DEFAULTS)
  assert.equal(health.resumeAt, 31_000 + 60_000)
})

test('冷却退避有上限，不会无限膨胀', () => {
  const health = createHealth(0)
  for (let index = 0; index < 8; index += 1) {
    settleAttempt(health, failure('rate-limit'), 1_000 + index * 1_000, DEFAULTS)
  }
  // 上限是 30_000 * 2^4 = 480_000
  const last = 1_000 + 7 * 1_000
  assert.equal(health.resumeAt, last + 480_000)
})

test('冷却到期自动回到 active', () => {
  const health = createHealth(0)
  settleAttempt(health, failure('rate-limit'), 1_000, DEFAULTS)
  assert.equal(isAvailable(model({ id: 'm' }), health, 20_000), false)
  assert.equal(isAvailable(model({ id: 'm' }), health, 31_000), true)
  assert.equal(health.state, 'active')
})

test('连续超时达到阈值才熔断，未达标前仍可用', () => {
  const health = createHealth(0)
  settleAttempt(health, failure('timeout'), 1_000, DEFAULTS)
  settleAttempt(health, failure('timeout'), 2_000, DEFAULTS)
  assert.equal(health.state, 'active')
  assert.equal(isAvailable(model({ id: 'm' }), health, 3_000), true)

  settleAttempt(health, failure('timeout'), 3_000, DEFAULTS)
  assert.equal(health.state, 'open')
  assert.equal(isAvailable(model({ id: 'm' }), health, 3_000), false)
})

test('熔断到期进入半开，而不是直接复活', () => {
  const health = createHealth(0)
  for (let index = 0; index < 3; index += 1) {
    settleAttempt(health, failure('server'), 1_000 + index, DEFAULTS)
  }
  assert.equal(health.state, 'open')
  const resumeAt = health.resumeAt as number
  assert.equal(isAvailable(model({ id: 'm' }), health, resumeAt - 1), false)
  advance(health, resumeAt)
  assert.equal(health.state, 'half-open')
  assert.equal(isAvailable(model({ id: 'm' }), health, resumeAt), true)
})

test('半开试探成功后彻底复位', () => {
  const health = createHealth(0)
  for (let index = 0; index < 3; index += 1) {
    settleAttempt(health, failure('server'), 1_000 + index, DEFAULTS)
  }
  advance(health, health.resumeAt as number)
  settleAttempt(health, success(150), 62_000, DEFAULTS)
  assert.equal(health.state, 'active')
  assert.equal(health.consecutiveFailures, 0)
  assert.equal(health.resumeAt, undefined)
})

test('认证失败一次就熔断：凭据坏了重试无意义', () => {
  const health = createHealth(0)
  settleAttempt(health, failure('auth'), 1_000, DEFAULTS)
  assert.equal(health.state, 'open')
  assert.equal(health.consecutiveFailures, DEFAULTS.failure_threshold)
})

test('客户端取消不计入失败，也不冷却', () => {
  const health = createHealth(0)
  settleAttempt(health, failure('aborted'), 1_000, DEFAULTS)
  assert.equal(health.state, 'active')
  assert.equal(health.consecutiveFailures, 0)
  assert.equal(health.lastErrorKind, 'aborted')
})

test('400 与上下文超限不污染健康分：换模型才有用', () => {
  const health = createHealth(0)
  settleAttempt(health, failure('bad-request'), 1_000, DEFAULTS)
  settleAttempt(health, failure('context-overflow'), 2_000, DEFAULTS)
  assert.equal(health.state, 'active')
  assert.equal(health.consecutiveFailures, 0)
})

test('并发满额时不可用，并给出原因', () => {
  const health = createHealth(0)
  const entry = model({ id: 'm', max_concurrency: 2 })
  beginAttempt(health, 1_000)
  beginAttempt(health, 1_000)
  assert.equal(isAvailable(entry, health, 1_000), false)
  assert.equal(unavailableReason(entry, health, 1_000), 'concurrency-full')
})

test('rpm 滑窗满额后拒绝，跨过一分钟自动清零', () => {
  const health = createHealth(0)
  const entry = model({ id: 'm', max_concurrency: 100, rpm: 2 })
  beginAttempt(health, 1_000)
  beginAttempt(health, 1_000)
  assert.equal(unavailableReason(entry, health, 1_000), 'rpm-exhausted')
  beginAttempt(health, 61_500)
  assert.equal(health.windowCalls, 1)
})

test('rpm 未配置时不限流', () => {
  const health = createHealth(0)
  const entry = model({ id: 'm', max_concurrency: 100 })
  for (let index = 0; index < 50; index += 1) beginAttempt(health, 1_000)
  assert.equal(unavailableReason(entry, health, 1_000), undefined)
})

test('手动下线后即使时间过去也不会自动恢复', () => {
  const health = createHealth(0)
  setOffline(health, true, 1_000)
  assert.equal(visibleState(health, 10_000_000), 'offline')
  assert.equal(unavailableReason(model({ id: 'm' }), health, 10_000_000), 'offline')
})

test('手动上线清空失败计数与滑窗', () => {
  const health = createHealth(0)
  beginAttempt(health, 1_000)
  settleAttempt(health, failure('server'), 1_000, DEFAULTS)
  settleAttempt(health, failure('server'), 1_000, DEFAULTS)
  settleAttempt(health, failure('server'), 1_000, DEFAULTS)
  assert.equal(health.state, 'open')
  setOffline(health, false, 5_000)
  assert.equal(health.state, 'active')
  assert.equal(health.consecutiveFailures, 0)
  assert.equal(health.windowCalls, 0)
})
