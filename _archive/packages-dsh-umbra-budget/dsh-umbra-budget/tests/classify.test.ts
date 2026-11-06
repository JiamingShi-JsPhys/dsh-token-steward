/**
 * Classifier tests — O(1) statistics only, capability derivation.
 * @module tests/classify.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { classify, fingerprintOf } from '../src/core/classify.ts'
import { defaultPolicy } from '../src/core/pool.ts'

const POLICY = defaultPolicy()

test('fingerprint reads messages, tools and system defensively', () => {
  const fp = fingerprintOf({
    provider: 'deepseek',
    model: 'deepseek-chat',
    system: 'you are a helper',
    messages: [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: [{ type: 'text', text: 'hello there' }, { type: 'image', url: 'x' }] },
    ],
    tools: [{ name: 'run_code' }],
  })
  assert.equal(fp.messageCount, 2)
  assert.equal(fp.totalChars, 2 + 'you are a helper'.length + 'hello there'.length)
  assert.equal(fp.hasTools, true)
  assert.equal(fp.requestedProvider, 'deepseek')
})

test('fingerprint survives garbage input', () => {
  assert.equal(fingerprintOf(null).totalChars, 0)
  assert.equal(fingerprintOf(undefined).messageCount, 0)
  assert.equal(fingerprintOf('text').hasTools, false)
  assert.equal(fingerprintOf({ messages: 'not-an-array' }).messageCount, 0)
})

test('short tool-free prompt is trivial', () => {
  const profile = classify(fingerprintOf({ messages: [{ role: 'user', content: 'hi' }] }), POLICY)
  assert.equal(profile.taskClass, 'trivial')
  assert.deepEqual(profile.requiredCapabilities, [])
})

test('tool-carrying call becomes heavy (default heavyTools=true) and requires tool_use', () => {
  const profile = classify(
    fingerprintOf({ messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'x' }] }),
    POLICY,
  )
  assert.equal(profile.taskClass, 'heavy')
  assert.ok(profile.requiredCapabilities.includes('tool_use'))
})

test('long prompt requires long_context and a large window', () => {
  // 300k CJK chars ≈ 150k tokens → window floor above 128k
  const long = '字'.repeat(300_000)
  const profile = classify(fingerprintOf({ messages: [{ role: 'user', content: long }] }), POLICY)
  assert.equal(profile.taskClass, 'heavy')
  assert.ok(profile.minContextWindow > 128_000)
  assert.ok(profile.requiredCapabilities.includes('long_context'))
})

test('high reasoning effort requires the reasoning capability', () => {
  const profile = classify(
    fingerprintOf({ messages: [{ role: 'user', content: 'think' }], reasoningEffort: 'high' }),
    POLICY,
  )
  assert.ok(profile.requiredCapabilities.includes('reasoning'))
  assert.equal(profile.taskClass, 'heavy')
})

test('mid-size call without tools is standard', () => {
  const mid = 'a'.repeat(10_000)
  const profile = classify(fingerprintOf({ messages: [{ role: 'user', content: mid }] }), POLICY)
  assert.equal(profile.taskClass, 'standard')
  assert.ok(profile.minContextWindow > 0)
})
