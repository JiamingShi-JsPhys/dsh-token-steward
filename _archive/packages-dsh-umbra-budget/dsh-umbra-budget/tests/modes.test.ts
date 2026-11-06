/**
 * Mode sorter tests — the three scheduling modes produce the intended orders.
 * @module tests/modes.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { selectChain } from '../src/core/modes.ts'
import { defaultPolicy } from '../src/core/pool.ts'
import type { HealthSnapshot, PoolModel, TaskProfile } from '../src/core/types.ts'

function makeModel(partial: Partial<PoolModel> & { id: string; provider: string; model: string }): PoolModel {
  return {
    tags: { capabilities: ['coding'], costLevel: 'medium', contextWindow: 128_000, availability: 'direct' },
    enabled: true,
    authStyle: 'bearer',
    headers: {},
    configured: true,
    configNotes: [],
    ...partial,
  }
}

const MODELS: readonly PoolModel[] = [
  makeModel({ id: 'glm/glm-flash', provider: 'glm', model: 'glm-flash', tags: { capabilities: ['fast', 'coding'], costLevel: 'free', contextWindow: 128_000, availability: 'direct' } }),
  makeModel({ id: 'deepseek/deepseek-chat', provider: 'deepseek', model: 'deepseek-chat', tags: { capabilities: ['coding', 'fast', 'agent'], costLevel: 'low', contextWindow: 131_072, availability: 'direct' } }),
  makeModel({ id: 'deepseek/deepseek-reasoner', provider: 'deepseek', model: 'deepseek-reasoner', tags: { capabilities: ['coding', 'reasoning'], costLevel: 'medium', contextWindow: 131_072, availability: 'direct' } }),
  makeModel({ id: 'anthropic/claude', provider: 'anthropic', model: 'claude-4-5', tags: { capabilities: ['coding', 'reasoning', 'vision', 'agent', 'long_context', 'tool_use'], costLevel: 'high', contextWindow: 200_000, availability: 'direct' } }),
]

function poolWith(mode: 'frugal' | 'efficiency' | 'max_power', models: readonly PoolModel[]) {
  return {
    version: 1 as const,
    models,
    policy: {
      ...defaultPolicy(),
      mode,
    },
    loadedAt: 0,
  }
}

const PROFILE: TaskProfile = { taskClass: 'standard', requiredCapabilities: ['coding'], minContextWindow: 10_000 }
const NO_HEALTH = new Map<string, HealthSnapshot>()

test('frugal: free first, then low/medium/high', () => {
  const pool = poolWith('frugal', MODELS)
  const chain = selectChain(pool, PROFILE, NO_HEALTH, { now: 0 })
  assert.deepEqual(chain.map((c) => c.modelId), [
    'glm/glm-flash',
    'deepseek/deepseek-chat',
    'deepseek/deepseek-reasoner',
    'anthropic/claude',
  ])
})

test('frugal: a model that cannot cover the requirement never appears, however cheap', () => {
  const pool = poolWith('frugal', [
    makeModel({ id: 'tiny/tiny', provider: 'tiny', model: 'tiny', tags: { capabilities: [], costLevel: 'free', contextWindow: 8_000, availability: 'direct' } }),
  ])
  const chain = selectChain(pool, PROFILE, NO_HEALTH, { now: 0 })
  assert.deepEqual(chain, [], 'no capability coverage → not eligible')
})

test('efficiency: fast models lead; in-flight scatter pushes hot models down', () => {
  const pool = poolWith('efficiency', MODELS)
  const chain = selectChain(pool, PROFILE, NO_HEALTH, { now: 0 })
  assert.equal(chain[0]!.modelId, 'glm/glm-flash', 'fast + free leads')

  const hot = new Map<string, HealthSnapshot>([
    ['glm/glm-flash', { status: 'healthy', failures: 0, coolUntil: 0, inFlight: 4, ewmaTtfbMs: 100 }],
  ])
  const scattered = selectChain(pool, PROFILE, hot, { now: 0 })
  assert.notEqual(scattered[0]!.modelId, 'glm/glm-flash', 'hot model is pushed down by scatter')
})

test('efficiency: least-in-flight wins among fast models (idea_swarm fan-out)', () => {
  const models = MODELS.filter((m) => m.id !== 'anthropic/claude' && m.id !== 'deepseek/deepseek-reasoner')
  const pool = poolWith('efficiency', models)
  const busy = new Map<string, HealthSnapshot>([
    ['glm/glm-flash', { status: 'healthy', failures: 0, coolUntil: 0, inFlight: 3, ewmaTtfbMs: 100 }],
    ['deepseek/deepseek-chat', { status: 'healthy', failures: 0, coolUntil: 0, inFlight: 1, ewmaTtfbMs: 100 }],
  ])
  const chain = selectChain(pool, PROFILE, busy, { now: 0 })
  assert.equal(chain[0]!.modelId, 'deepseek/deepseek-chat')
})

test('max_power: broadest capability coverage and biggest window first', () => {
  const pool = poolWith('max_power', MODELS)
  const chain = selectChain(pool, PROFILE, NO_HEALTH, { now: 0 })
  assert.equal(chain[0]!.modelId, 'anthropic/claude')
  assert.equal(chain[chain.length - 1]!.modelId, 'glm/glm-flash')
})

test('cooling models are skipped until cooldown elapses; disabled never return', () => {
  const pool = poolWith('frugal', MODELS)
  const now = 100_000
  const health = new Map<string, HealthSnapshot>([
    ['glm/glm-flash', { status: 'cooling', failures: 2, coolUntil: now + 5_000, inFlight: 0, ewmaTtfbMs: 0 }],
    ['deepseek/deepseek-chat', { status: 'disabled', failures: 9, coolUntil: 0, inFlight: 0, ewmaTtfbMs: 0 }],
  ])
  const chain = selectChain(pool, PROFILE, health, { now })
  assert.deepEqual(chain.map((c) => c.modelId), ['deepseek/deepseek-reasoner', 'anthropic/claude'])

  const afterCooldown = selectChain(pool, PROFILE, health, { now: now + 10_000 })
  assert.equal(afterCooldown[0]!.modelId, 'glm/glm-flash', 'half-open window re-admits the cooled model')

  const withDisabledOnly = selectChain(pool, PROFILE, new Map(Object.entries({})), { now })
  assert.ok(withDisabledOnly.length >= 3)
})

test('excluded ids (context-overflow hits) are dropped from the chain', () => {
  const pool = poolWith('frugal', MODELS)
  const chain = selectChain(pool, PROFILE, NO_HEALTH, { now: 0, exclude: ['glm/glm-flash'] })
  assert.equal(chain[0]!.modelId, 'deepseek/deepseek-chat')
})
