/**
 * Health circuit-breaker tests.
 * @module tests/health.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ModelHealth, failureKindOf } from '../src/core/health.ts'

const OPTS = { cooldownMs: 30_000, rateLimitMs: 60_000 }

test('healthy until the consecutive-failure threshold trips the breaker', () => {
  const health = new ModelHealth(OPTS)
  const now = 1_000
  assert.equal(health.recordFailure('server', now), 'noted')
  assert.equal(health.snapshot().status, 'healthy')
  assert.equal(health.recordFailure('server', now + 1), 'cooldown-opened')
  const snapshot = health.snapshot()
  assert.equal(snapshot.status, 'cooling')
  assert.ok(snapshot.coolUntil >= now + 30_000)
})

test('a success resets the counter and reopens the breaker', () => {
  const health = new ModelHealth(OPTS)
  health.recordFailure('server', 0)
  health.recordFailure('server', 1)
  health.recordSuccess(120)
  const snapshot = health.snapshot()
  assert.equal(snapshot.status, 'healthy')
  assert.equal(snapshot.failures, 0)
  assert.equal(snapshot.ewmaTtfbMs, 120)
})

test('rate limiting uses the dedicated cooldown (or Retry-After)', () => {
  const health = new ModelHealth(OPTS)
  health.recordFailure('server', 0)
  const opened = health.recordFailure('rate_limited', 1_000, 120_000)
  assert.equal(opened, 'cooldown-opened')
  assert.ok(health.snapshot().coolUntil >= 121_000, 'Retry-After wins when larger')
})

test('auth failure disables the model outright', () => {
  const health = new ModelHealth(OPTS)
  assert.equal(health.recordFailure('auth', 0), 'disabled')
  assert.equal(health.snapshot().status, 'disabled')
  health.reEnable()
  assert.equal(health.snapshot().status, 'healthy')
})

test('context overflow never cools the model (task-shaped, not model-shaped)', () => {
  const health = new ModelHealth(OPTS)
  health.recordFailure('server', 0)
  assert.equal(health.recordFailure('context_overflow', 1), 'noted')
  assert.equal(health.snapshot().status, 'healthy')
})

test('half-open probe failure restarts the cooldown', () => {
  const health = new ModelHealth(OPTS)
  const now = 0
  health.recordFailure('server', now)
  health.recordFailure('server', now + 1)
  assert.equal(health.snapshot().status, 'cooling')
  const second = health.recordFailure('server', now + 40_000, undefined, 'still down')
  assert.equal(second, 'half-open-failed')
  assert.ok(health.snapshot().coolUntil > now + 40_000)
})

test('in-flight counting is balanced by begin/end', () => {
  const health = new ModelHealth(OPTS)
  health.begin()
  health.begin()
  assert.equal(health.snapshot().inFlight, 2)
  health.end()
  health.end()
  health.end() // never negative
  assert.equal(health.snapshot().inFlight, 0)
})

test('failureKindOf classifies by status field and message', () => {
  assert.equal(failureKindOf({ status: 429 }), 'rate_limited')
  assert.equal(failureKindOf({ status: 401 }), 'auth')
  assert.equal(failureKindOf({ status: 503 }), 'server')
  assert.equal(failureKindOf(new Error('HTTP 429 Too Many Requests')), 'rate_limited')
  assert.equal(failureKindOf(new Error('maximum context length exceeded')), 'context_overflow')
  assert.equal(failureKindOf(new Error('ECONNREFUSED 127.0.0.1:9')), 'network')
  assert.equal(failureKindOf(new Error('Request timed out')), 'timeout')
  assert.equal(failureKindOf(new Error('something odd')), 'unknown')
})
