/**
 * 自动接线：装好插件就该在模型菜单里多出四个档位。
 *
 * 钉住四件事：
 *  - 空 profile 也能培出一条可用的 llm-pi-ai；
 *  - 已经接好就一个字节都不改（幂等，否则每次启动都抖动 profile）；
 *  - 用户自己调过的显示名 / 输出上限 / 旧档位留着，其余厂家一个字不碰；
 *  - 认不出结构（flow 写法）时宁可不动手。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parse } from 'yaml'
import {
  renderStewardBlock,
  stewardContainerOf,
  stewardProviderBlock,
  stewardWired,
  wireStewardInText,
  STEWARD_PROVIDER_ID,
  STEWARD_WIRE_MODELS,
} from '../src/host/harness-wire.ts'

const SPEC = { baseUrl: 'http://127.0.0.1:51741/v1', apiKeyEnv: 'STEWARD_LOCAL_TOKEN' }

const PROFILE = [
  '# 用户自己的注释，不该被抹掉',
  '- id: llm-pi-ai',
  "  name: '@deepseek-ai/dsh-llm-pi-ai'",
  '  config:',
  '    providers:',
  '      agnes:',
  '        displayName: Agnes',
  '        api: openai-completions',
  '        baseURL: https://api.agnes-ai.cn/v1',
  '        models:',
  '          - id: agnes-3.0-flash',
  '            name: agnes-3.0-flash',
  '',
].join('\n')

function containerOf(text: string): Record<string, unknown> {
  return stewardContainerOf(parse(text))!
}

test('四个档位就是菜单里要出现的那四个（子代理不是模式）', () => {
  assert.deepEqual(STEWARD_WIRE_MODELS.map((model) => model.id), [
    'steward:frugal', 'steward:balanced', 'steward:max_power', 'steward:free',
  ])
  assert.equal(STEWARD_PROVIDER_ID, 'steward')
})

test('写进 profile 的块：地址、apiKeyEnv、输出上限、四个模型都在', () => {
  const block = stewardProviderBlock(SPEC)
  assert.equal(block.baseURL, 'http://127.0.0.1:51741/v1')
  assert.equal(block.apiKeyEnv, 'STEWARD_LOCAL_TOKEN')
  assert.equal(block.defaultMaxTokens, 65_536)
  assert.equal(block.api, 'openai-completions')
  assert.equal((block.models as unknown[]).length, 4)
})

test('还没接过线的 profile：补上 steward，注释与别的厂家原样留着', () => {
  assert.equal(stewardWired(parse(PROFILE), SPEC), false)
  const text = wireStewardInText(PROFILE, SPEC)!
  assert.ok(text.includes('# 用户自己的注释'), '注释必须保留')
  assert.ok(text.includes('agnes-3.0-flash'), '别的上游不能动')
  const container = containerOf(text)
  assert.deepEqual(new Set(Object.keys(container)), new Set(['agnes', 'steward']))
  assert.deepEqual(container.agnes, {
    displayName: 'Agnes',
    api: 'openai-completions',
    baseURL: 'https://api.agnes-ai.cn/v1',
    models: [{ id: 'agnes-3.0-flash', name: 'agnes-3.0-flash' }],
  })
  assert.equal(stewardWired(parse(text), SPEC), true)
  assert.equal((container.steward as { baseURL: string }).baseURL, SPEC.baseUrl)
})

test('幂等：接好以后判定为已接，不再重写', () => {
  const once = wireStewardInText(PROFILE, SPEC)!
  assert.equal(stewardWired(parse(once), SPEC), true)
  // 就算真被重写一次，产物也应当一字不差——否则就成了每启动一次抖一次。
  assert.equal(wireStewardInText(once, SPEC), once)
})

test('profile 里根本没有 llm-pi-ai：在末尾补一条', () => {
  const bare = '# 只有别的插件\n- id: ui-theme\n  name: "@deepseek-ai/dsh-client-ui-theme"\n'
  assert.equal(stewardContainerOf(parse(bare)), undefined)
  const text = wireStewardInText(bare, SPEC)!
  assert.equal(stewardWired(parse(text), SPEC), true)
  const plugins = parse(text) as Array<{ name: string }>
  assert.equal(plugins[plugins.length - 1]!.name, '@deepseek-ai/dsh-llm-pi-ai')
  assert.ok(text.includes('# 只有别的插件'))
})

test('端口变了要重写地址，用户调过的显示名与上限留着', () => {
  const first = wireStewardInText(PROFILE, SPEC)!
  const tweaked = first
    .replace('displayName: 管家', 'displayName: 我的管家')
    .replace('defaultMaxTokens: 65536', 'defaultMaxTokens: 32000')
  const moved = { ...SPEC, baseUrl: 'http://127.0.0.1:51800/v1' }
  assert.equal(stewardWired(parse(tweaked), moved), false, '地址不同 = 需要更新')
  const text = wireStewardInText(tweaked, moved)!
  assert.equal(stewardWired(parse(text), moved), true)
  assert.ok(text.includes('displayName: 我的管家'))
  assert.ok(text.includes('defaultMaxTokens: 32000'))
  assert.ok(text.includes('baseURL: http://127.0.0.1:51800/v1'))
})

test('少了一个档位就补回来，用户自己加的旧档位不删', () => {
  const doc = PROFILE.replace(
    '      agnes:',
    ['      steward:', '        displayName: 管家', '        baseURL: http://127.0.0.1:51741/v1',
      '        apiKeyEnv: STEWARD_LOCAL_TOKEN', '        models:', '          - id: steward:frugal',
      '            name: 管家·极致便宜', '          - id: steward:auto', '            name: 管家·自动',
      '      agnes:'].join('\n'),
  )
  assert.equal(stewardWired(parse(doc), SPEC), false)
  const text = wireStewardInText(doc, SPEC)!
  const models = (containerOf(text).steward as { models: Array<{ id: string }> }).models.map((model) => model.id)
  assert.deepEqual(new Set(models), new Set([
    'steward:frugal', 'steward:balanced', 'steward:max_power', 'steward:free', 'steward:auto',
  ]))
  assert.equal(models[models.length - 1], 'steward:auto', '用户自己的档位排在末尾，不被打散')
})

test('老配置里的中文档位 id 不会在菜单里留一份重复', () => {
  // 早期版本手写 profile 时用的是「管家·极致便宜」当 id；它和 steward:frugal 是同一条
  // 路由，重写时应当认出来，否则菜单里会并排出现两份一模一样的档位。
  const doc = PROFILE.replace(
    '      agnes:',
    ['      steward:', '        baseURL: http://127.0.0.1:51741/v1', '        apiKeyEnv: STEWARD_LOCAL_TOKEN',
      '        models:', '          - id: 管家·极致便宜', '            name: 管家·极致便宜',
      '          - id: 管家·免费档', '            name: 管家·免费档', '      agnes:'].join('\n'),
  )
  const text = wireStewardInText(doc, SPEC)!
  const models = (containerOf(text).steward as { models: Array<{ id: string }> }).models
  assert.deepEqual(models.map((model) => model.id), [
    'steward:frugal', 'steward:balanced', 'steward:max_power', 'steward:free',
  ])
})

test('apiKeyEnv 名字不对也要重写（令牌取不到等于没有密钥）', () => {
  const doc = wireStewardInText(PROFILE, SPEC)!.replace('apiKeyEnv: STEWARD_LOCAL_TOKEN', 'apiKeyEnv: SOMETHING_ELSE')
  assert.equal(stewardWired(parse(doc), SPEC), false)
  const text = wireStewardInText(doc, SPEC)!
  assert.ok(text.includes('apiKeyEnv: STEWARD_LOCAL_TOKEN'))
  assert.equal(stewardWired(parse(text), SPEC), true)
})

test('四空格缩进的 profile 也按它自己的缩进写', () => {
  const doc = [
    '- id: llm-pi-ai',
    "  name: '@deepseek-ai/dsh-llm-pi-ai'",
    '  config:',
    '    providers:',
    '        agnes:',
    '            displayName: Agnes',
    '            baseURL: https://api.agnes-ai.cn/v1',
    '',
  ].join('\n')
  const text = wireStewardInText(doc, SPEC)!
  assert.equal(stewardWired(parse(text), SPEC), true)
  assert.ok(text.includes('        steward:'), '与 agnes 同缩进')
})

test('flow 写法的 providers 不动手（宁可这一轮不接）', () => {
  const doc = [
    '- id: llm-pi-ai',
    "  name: '@deepseek-ai/dsh-llm-pi-ai'",
    '  config:',
    '    providers: { agnes: { baseURL: https://api.agnes-ai.cn/v1 } }',
    '',
  ].join('\n')
  assert.equal(wireStewardInText(doc, SPEC), undefined)
})

test('CRLF 的 profile 仍然用 CRLF 写回', () => {
  const crlf = PROFILE.replace(/\n/g, '\r\n')
  const text = wireStewardInText(crlf, SPEC)!
  assert.ok(text.includes('\r\n'), '不能把用户的换行风格改掉')
  assert.equal(stewardWired(parse(text), SPEC), true)
})

test('地址比对忽略大小写与末尾斜杠', () => {
  const text = wireStewardInText(PROFILE, SPEC)!
  assert.equal(stewardWired(parse(text), { ...SPEC, baseUrl: 'HTTP://127.0.0.1:51741/v1/' }), true)
})

test('渲染出来的块本身能被 YAML 解析（冒号不打引号也不炸）', () => {
  const doc = parse(['providers:', ...renderStewardBlock(SPEC, 2)].join('\n')) as {
    providers: Record<string, { models: Array<{ id: string }> }>
  }
  assert.equal(doc.providers.steward!.models.length, 4)
})
