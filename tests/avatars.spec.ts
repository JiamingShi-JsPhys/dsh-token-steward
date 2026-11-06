/**
 * AI 娘头像注册表：有图用图，没图用字母 + 几何兜底。
 *
 * 这里不测「好不好看」，只测三条会直接影响界面的行为：
 * 键的优先级、兜底字母、以及同一模型永远得到同一色相。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AVATAR_URLS, avatarFor, avatarUrlOf, hueOf, registerAvatar } from '../src/core/avatars.ts'

test('内置榜单头像：每家厂商一张，同厂商的模型共用', () => {
  const opus = avatarFor('anthropic', 'claude-opus-5-5', true)
  assert.equal(opus.url, 'api/token-steward/avatar?id=vendor-anthropic')
  assert.equal(opus.shape, 'hex')
  const haiku = avatarFor('anthropic', 'claude-haiku-5-5', true)
  assert.equal(haiku.url, opus.url, '同一家厂商必须共用一张头像')
  // 没有立绘的厂商仍然走字母兜底。
  assert.equal(avatarFor('agnes', 'agnes-3-0-flash', true).url, undefined)
})

test('没有图时：厂商首字母 + 六边形兜底', () => {
  const spec = avatarFor('unknown-vendor', 'unknown-model', true)
  assert.equal(spec.url, undefined)
  assert.equal(spec.letter, 'U')
  assert.equal(spec.shape, 'hex')
  assert.equal(spec.hue, hueOf('unknown-vendor/unknown-model'))
})

test('未收录模型用圆形兜底', () => {
  const spec = avatarFor('my-relay', 'some-model', false)
  assert.equal(spec.letter, 'M')
  assert.equal(spec.shape, 'circle')
})

test('色相稳定：同名永远同色，不同名基本不同色', () => {
  assert.equal(hueOf('anthropic/opus'), hueOf('anthropic/opus'))
  assert.ok(hueOf('anthropic/opus') >= 0 && hueOf('anthropic/opus') < 360)
  assert.notEqual(hueOf('anthropic/opus'), hueOf('openai/gpt'))
})

test('注册表三级优先级：模型 > 厂商 > 全局', () => {
  const before = { ...AVATAR_URLS }
  try {
    AVATAR_URLS['*'] = 'https://example.com/default.webp'
    assert.equal(avatarUrlOf('vendor-a', 'model-x'), 'https://example.com/default.webp')

    AVATAR_URLS['vendor-a'] = 'https://example.com/vendor-a.webp'
    assert.equal(avatarUrlOf('vendor-a', 'model-x'), 'https://example.com/vendor-a.webp')

    registerAvatar('vendor-a/model-x', 'https://example.com/model-x.webp')
    assert.equal(avatarUrlOf('vendor-a', 'model-x'), 'https://example.com/model-x.webp')

    const spec = avatarFor('vendor-a', 'model-x', true)
    assert.equal(spec.url, 'https://example.com/model-x.webp')
    assert.equal(spec.key, 'vendor-a/model-x')
  } finally {
    for (const key of Object.keys(AVATAR_URLS)) delete AVATAR_URLS[key]
    Object.assign(AVATAR_URLS, before)
  }
})

test('字母兜底不会为空：空 provider / 空 model 也有字符', () => {
  const spec = avatarFor('', 'model-only', false)
  assert.equal(spec.letter, 'M')
  assert.equal(avatarFor('', '', false).letter, '?')
})

test('厂商推断：中转站把模型挂在 custom 下，也能认回是哪家的头像', () => {
  // provider 是「一个桶」，靠模型名认厂商。
  assert.equal(avatarFor('custom', 'Qwen3-Embedding-8B', true).url, 'api/token-steward/avatar?id=vendor-alibaba')
  assert.equal(avatarFor('custom', 'deepseek-flash', true).url, 'api/token-steward/avatar?id=vendor-deepseek')
  assert.equal(avatarFor('custom', 'glm-flash', true).url, 'api/token-steward/avatar?id=vendor-zhipu')
  assert.equal(avatarFor('my-relay', 'claude-opus-5-5', true).url, 'api/token-steward/avatar?id=vendor-anthropic')
  // provider 名本身就是厂商时优先。
  assert.equal(avatarFor('moonshot', 'kimi-k2', true).url, 'api/token-steward/avatar?id=vendor-moonshot')
  // 认不出来就老实兜底，绝不瞎猜。
  assert.equal(avatarFor('custom', 'totally-unknown-7b', true).url, undefined)
})

test('厂商推断后：generic provider 的字母兜底取模型首字母', () => {
  assert.equal(avatarFor('custom', 'agnes-3-0-flash', true).letter, 'A')
  assert.equal(avatarFor('custom', 'zzz-model', true).letter, 'Z')
  // 真厂商仍然是厂商首字母。
  assert.equal(avatarFor('my-relay', 'some-model', true).letter, 'M')
})
