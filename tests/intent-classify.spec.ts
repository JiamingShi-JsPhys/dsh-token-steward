/**
 * intent.ts + classify.ts：网关两侧的纯逻辑。
 *
 * intent 决定「要什么模型」，classify 决定「失败后怎么办」。
 * 两者都是纯函数，因此这里不启动任何服务、不发任何请求。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  burstKeyOf,
  contentText,
  estimateInputTokens,
  estimateOutputTokens,
  hasImagePart,
  inferIntent,
  parseVirtualModel,
} from '../src/core/intent.ts'
import { bodyText, classifyFailure, errorMessageOf, worthRetrying } from '../src/core/classify.ts'

/* ────────────────────────── 虚拟模型 id ────────────────────────── */

test('steward:auto 不固定模式', () => {
  assert.deepEqual(parseVirtualModel('steward:auto'), { virtual: 'steward:auto' })
})

test('三个模式虚拟 id 各自固定一个模式', () => {
  assert.deepEqual(parseVirtualModel('steward:frugal'), { virtual: 'steward:frugal', mode: 'frugal' })
  assert.deepEqual(parseVirtualModel('steward:balanced'), { virtual: 'steward:balanced', mode: 'balanced' })
  assert.deepEqual(parseVirtualModel('steward:max_power'), { virtual: 'steward:max_power', mode: 'max_power' })
})

test('steward:pin/<provider>/<model> 解析出直通目标', () => {
  assert.deepEqual(parseVirtualModel('steward:pin/agnes/agnes-3.0-flash'), {
    virtual: 'steward:pin/agnes/agnes-3.0-flash',
    pin: { provider: 'agnes', model: 'agnes-3.0-flash' },
  })
})

test('残缺的 pin 不抛出，只是不给出目标', () => {
  assert.deepEqual(parseVirtualModel('steward:pin/agnes'), { virtual: 'steward:pin/agnes' })
  assert.deepEqual(parseVirtualModel('steward:pin//'), { virtual: 'steward:pin//' })
})

test('非虚拟 id 返回空 virtual，交给网关按名字查表', () => {
  assert.deepEqual(parseVirtualModel('gpt-4o'), { virtual: '' })
  assert.deepEqual(parseVirtualModel('deepseek-flash'), { virtual: '' })
})

test('未知的 steward: 前缀仍被识别为虚拟 id', () => {
  assert.equal(parseVirtualModel('steward:alias/analysis').virtual, 'steward:alias/analysis')
})

/* ────────────────────────── 内容提取 ────────────────────────── */

test('contentText 支持字符串与部件数组', () => {
  assert.equal(contentText('hello'), 'hello')
  assert.equal(contentText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb')
  assert.equal(contentText(undefined), '')
  assert.equal(contentText(42), '')
})

test('hasImagePart 认得出三种图片部件写法', () => {
  assert.equal(hasImagePart([{ type: 'image_url', image_url: { url: 'x' } }]), true)
  assert.equal(hasImagePart([{ type: 'input_image' }]), true)
  assert.equal(hasImagePart([{ type: 'image' }]), true)
  assert.equal(hasImagePart([{ type: 'text', text: 'x' }]), false)
  assert.equal(hasImagePart('plain'), false)
})

/* ────────────────────────── token 估算 ────────────────────────── */

test('estimateInputTokens 按 4 字符≈1 token 估算消息文本', () => {
  const body = { messages: [{ role: 'user', content: 'a'.repeat(400) }] }
  const tokens = estimateInputTokens(body)
  // 400 字符 = 100 token，加上每条消息 4 的结构开销
  assert.equal(tokens, 104)
})

test('estimateInputTokens 给图片一个固定估算值', () => {
  const textOnly = estimateInputTokens({ messages: [{ role: 'user', content: 'a'.repeat(400) }] })
  const withImage = estimateInputTokens({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'a'.repeat(400) }, { type: 'image_url', image_url: { url: 'x' } }] }],
  })
  assert.equal(withImage, textOnly + 1_000)
})

test('estimateInputTokens 计入 tools 定义的体积', () => {
  const base = estimateInputTokens({ messages: [{ role: 'user', content: 'hi' }] })
  const withTools = estimateInputTokens({
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'read', description: 'x'.repeat(400) } }],
  })
  assert.ok(withTools > base)
})

test('estimateOutputTokens 优先用显式上限，否则回落到 4096', () => {
  assert.equal(estimateOutputTokens({ max_tokens: 512 }), 512)
  assert.equal(estimateOutputTokens({ max_completion_tokens: 256 }), 256)
  assert.equal(estimateOutputTokens({}), 4_096)
  assert.equal(estimateOutputTokens({ max_tokens: 0 }), 4_096)
})

/* ────────────────────────── 意图推断 ────────────────────────── */

test('带 tools 的请求隐式要求 tool-use', () => {
  const { intent } = inferIntent({ tools: [{ type: 'function' }], messages: [] }, 'steward:auto', 0)
  assert.equal(intent.needsTools, true)
  assert.ok(intent.requiredCapabilities.includes('tool-use'))
})

test('没有 tools 的请求不要求 tool-use', () => {
  const { intent } = inferIntent({ messages: [] }, 'steward:auto', 0)
  assert.equal(intent.needsTools, false)
  assert.equal(intent.requiredCapabilities.includes('tool-use'), false)
})

test('含图片的请求要求 vision 与 image 模态', () => {
  const { intent } = inferIntent({
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }],
  }, 'steward:auto', 0)
  assert.ok(intent.requiredCapabilities.includes('vision'))
  assert.deepEqual(intent.requiredModalities, ['text', 'image'])
})

test('response_format 存在时要求 json-mode', () => {
  const { intent } = inferIntent({ messages: [], response_format: { type: 'json_object' } }, 'steward:auto', 0)
  assert.ok(intent.requiredCapabilities.includes('json-mode'))
})

test('stream 标志被如实带出', () => {
  assert.equal(inferIntent({ messages: [], stream: true }, 'steward:auto', 0).intent.stream, true)
  assert.equal(inferIntent({ messages: [] }, 'steward:auto', 0).intent.stream, false)
})

test('虚拟 id 被写进 aliasName，供面板解释「为什么选它」', () => {
  const { intent } = inferIntent({ messages: [] }, 'steward:max_power', 0)
  assert.equal(intent.aliasName, 'steward:max_power')
})

test('普通模型 id 不写 aliasName', () => {
  const { intent } = inferIntent({ messages: [] }, 'deepseek-flash', 0)
  assert.equal(intent.aliasName, undefined)
})

test('burstKey 优先用请求里的批次线索', () => {
  assert.equal(burstKeyOf({ user: 'swarm-42' }, 1_000), 'hint:swarm-42')
  assert.equal(burstKeyOf({ session_id: 's1' }, 1_000), 'hint:s1')
})

test('没有线索时按时间窗归并', () => {
  assert.equal(burstKeyOf({}, 1_000, 250), burstKeyOf({}, 1_100, 250))
  assert.notEqual(burstKeyOf({}, 1_000, 250), burstKeyOf({}, 1_300, 250))
})

/* ────────────────────────── 失败分类 ────────────────────────── */

test('429 一律是限流', () => {
  assert.equal(classifyFailure({ status: 429 }), 'rate-limit')
})

test('401 / 403 一律是凭据问题', () => {
  assert.equal(classifyFailure({ status: 401 }), 'auth')
  assert.equal(classifyFailure({ status: 403 }), 'auth')
})

test('5xx 是服务端错误', () => {
  assert.equal(classifyFailure({ status: 500 }), 'server')
  assert.equal(classifyFailure({ status: 503 }), 'server')
})

test('408 是超时', () => {
  assert.equal(classifyFailure({ status: 408 }), 'timeout')
})

test('413 是上下文超限', () => {
  assert.equal(classifyFailure({ status: 413 }), 'context-overflow')
})

test('400 + 上下文措辞 → context-overflow（要求换更大窗口）', () => {
  for (const text of [
    'This model\'s maximum context length is 8192 tokens',
    'too many tokens in prompt',
    'Please reduce the length of the messages',
  ]) {
    assert.equal(classifyFailure({ status: 400, body: { error: { message: text } } }), 'context-overflow', text)
  }
})

test('400 + 限流措辞 → rate-limit（有些网关用 400 报限流）', () => {
  assert.equal(classifyFailure({ status: 400, body: { error: { message: 'rate limit exceeded' } } }), 'rate-limit')
})

test('400 + 凭据措辞 → auth', () => {
  assert.equal(classifyFailure({ status: 400, body: { error: { message: 'Invalid API key provided' } } }), 'auth')
})

test('普通 400 是 bad-request', () => {
  assert.equal(classifyFailure({ status: 400, body: { error: { message: 'messages[0].role is required' } } }), 'bad-request')
})

test('没有状态码时按异常消息判断传输层失败', () => {
  assert.equal(classifyFailure({ message: 'fetch failed: ECONNRESET' }), 'transport')
  assert.equal(classifyFailure({ message: 'getaddrinfo ENOTFOUND api.example' }), 'transport')
  assert.equal(classifyFailure({ message: 'socket hang up' }), 'transport')
})

test('没有状态码且消息含 timeout → timeout', () => {
  assert.equal(classifyFailure({ message: 'request timeout after 60000ms' }), 'timeout')
})

test('主动取消优先于一切', () => {
  assert.equal(classifyFailure({ aborted: true, status: 500 }), 'aborted')
})

test('无法归类时保守地当作服务端错误（可重试）', () => {
  assert.equal(classifyFailure({}), 'server')
})

test('worthRetrying：请求本身有错就不该换模型重试', () => {
  assert.equal(worthRetrying('bad-request'), false)
  assert.equal(worthRetrying('aborted'), false)
  assert.equal(worthRetrying('rate-limit'), true)
  assert.equal(worthRetrying('auth'), true)
  assert.equal(worthRetrying('context-overflow'), true)
  assert.equal(worthRetrying('timeout'), true)
})

test('bodyText 把错误体压成可搜索文本', () => {
  assert.equal(bodyText('Hello'), 'hello')
  assert.equal(bodyText({ error: { message: 'RATE LIMIT' } }), '{"error":{"message":"rate limit"}}')
  assert.equal(bodyText(undefined), '')
})

test('errorMessageOf 优先取嵌套的 error.message', () => {
  assert.equal(errorMessageOf({ error: { message: 'boom' } }, 'fallback'), 'boom')
  assert.equal(errorMessageOf({ error: 'boom' }, 'fallback'), 'boom')
  assert.equal(errorMessageOf({ message: 'boom' }, 'fallback'), 'boom')
  assert.equal(errorMessageOf('  plain text  ', 'fallback'), '  plain text  ')
  assert.equal(errorMessageOf(undefined, 'fallback'), 'fallback')
})

test('errorMessageOf 对超长消息截断，不把整个上游响应回传给客户端', () => {
  const long = 'x'.repeat(2_000)
  assert.equal(errorMessageOf({ error: { message: long } }, 'fallback').length, 500)
})
