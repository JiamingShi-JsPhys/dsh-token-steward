/**
 * B-track outbound rewrite planner tests.
 * @module tests/reroute.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { extractBodyModel, operationSuffix, planReroute } from '../src/core/reroute.ts'
import type { PoolModel } from '../src/core/types.ts'

function target(partial: Partial<PoolModel> = {}): PoolModel {
  return {
    id: 'school/glm-4-flash',
    provider: 'school',
    model: 'glm-4-flash',
    tags: { capabilities: ['fast'], costLevel: 'free', contextWindow: 128_000, availability: 'direct' },
    enabled: true,
    endpoint: 'https://school-mirror.example/v1',
    apiKey: 'sk-school-key',
    authStyle: 'bearer',
    headers: {},
    configured: true,
    configNotes: [],
    ...partial,
  }
}

const VIEW = {
  origin: 'https://api.deepseek.com',
  path: '/v1/chat/completions',
  bodyText: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }], stream: true }),
}

test('happy path: origin, path join, auth header, body model swap', () => {
  const result = planReroute(VIEW, target())
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.outcome.origin, 'https://school-mirror.example')
  assert.equal(result.outcome.path, '/v1/chat/completions')
  assert.equal(result.outcome.setHeaders.authorization, 'Bearer sk-school-key')
  assert.deepEqual([...result.outcome.removeHeaders], ['x-api-key', 'api-key'])
  const newModel = extractBodyModel(result.outcome.bodyText)
  assert.equal(newModel, 'glm-4-flash')
  const body = JSON.parse(result.outcome.bodyText!) as Record<string, unknown>
  assert.equal(body.stream, true, 'the rest of the body survives the swap')
})

test('endpoint path prefixes are preserved (zhipu-style /v4)', () => {
  const result = planReroute(
    { ...VIEW, path: '/api/pc/glm/v4/chat/completions' },
    target({ endpoint: 'https://open.bigmodel.example/api/paas/v4' }),
  )
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.outcome.path, '/api/paas/v4/chat/completions')
})

test('x-api-key style swaps the auth mechanism cleanly', () => {
  const result = planReroute(VIEW, target({ authStyle: 'x-api-key' }))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.outcome.setHeaders['x-api-key'], 'sk-school-key')
  assert.equal(result.outcome.setHeaders.authorization, undefined)
  assert.ok(result.outcome.removeHeaders.includes('authorization'))
})

test('model already matching the target keeps the body untouched', () => {
  const sameModel = JSON.stringify({ model: 'glm-4-flash', messages: [] })
  const result = planReroute({ ...VIEW, bodyText: sameModel }, target())
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.outcome.bodyText, sameModel)
})

test('refusals: A-track target, missing key, non-OpenAI path, non-JSON body', () => {
  const aTrack = planReroute(VIEW, target({ endpoint: undefined }))
  assert.equal(aTrack.ok, false)
  if (!aTrack.ok) assert.ok(aTrack.reason.includes('A-track'))

  const noKey = planReroute(VIEW, target({ apiKey: undefined }))
  assert.equal(noKey.ok, false)

  const weirdPath = planReroute({ ...VIEW, path: '/anthropic/v1/messages' }, target())
  assert.equal(weirdPath.ok, false, 'anthropic-protocol path is not rewriteable')
  if (!weirdPath.ok) assert.ok(weirdPath.reason.includes('operation path'))

  const noBody = planReroute({ origin: VIEW.origin, path: VIEW.path }, target())
  assert.equal(noBody.ok, false, 'no body → cannot guarantee the model field')

  const badBody = planReroute({ ...VIEW, bodyText: '<xml>not json</xml>' }, target())
  assert.equal(badBody.ok, false)
})

test('operation suffix recognises the OpenAI wire surface, longest markers first', () => {
  assert.equal(operationSuffix('/v1/chat/completions'), '/chat/completions')
  assert.equal(operationSuffix('/chat/completions?x=1'), '/chat/completions')
  assert.equal(operationSuffix('/v1/models'), '/models')
  assert.equal(operationSuffix('/v1/models/deepseek-chat'), undefined, 'nested /models paths are refused')
  assert.equal(operationSuffix('/completions'), '/completions')
  assert.equal(operationSuffix('/v1/other/thing'), undefined)
})

test('extra pool headers are injected lowercased', () => {
  const result = planReroute(VIEW, target({ headers: { 'X-Custom-Auth': 'token123' } }))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.outcome.setHeaders['x-custom-auth'], 'token123')
})
