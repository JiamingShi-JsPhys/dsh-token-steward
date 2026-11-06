/**
 * M0 探针 6（关键）：伪造一个 loopback 网关，用 pi-ai 实际使用的 openai SDK
 * 走一遍 chat.completions 流式请求，验证：
 *   T2  baseURL 指向本地网关可用，路径是 {baseURL}/chat/completions
 *   T3  stream_options.include_usage 带回 usage 桶
 *   T6  模型 id 原样透传（含冒号），网关能读到并据此选路
 */
import { createServer } from 'node:http'

let seen = null
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    seen = { method: req.method, url: req.url, auth: req.headers.authorization, body: JSON.parse(body) }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    const frame = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n')
    frame({ id: 'chatcmpl-probe', object: 'chat.completion.chunk', created: 1, model: seen.body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'pong' }, finish_reason: null }] })
    frame({ id: 'chatcmpl-probe', object: 'chat.completion.chunk', created: 1, model: seen.body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
    if (seen.body.stream_options?.include_usage) {
      frame({ id: 'chatcmpl-probe', object: 'chat.completion.chunk', created: 1, model: seen.body.model, choices: [], usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13, prompt_tokens_details: { cached_tokens: 4 } } })
    }
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
console.log('gateway listening on 127.0.0.1:' + port)

const { default: OpenAI } = await import(process.env.OPENAI_SDK)
const client = new OpenAI({ apiKey: 'local-token-abc', baseURL: 'http://127.0.0.1:' + port + '/v1' })

const stream = await client.chat.completions.create({
  model: 'umbra:auto',
  messages: [{ role: 'user', content: 'ping' }],
  stream: true,
  stream_options: { include_usage: true },
})

let text = ''
let usage = null
for await (const chunk of stream) {
  text += chunk.choices?.[0]?.delta?.content ?? ''
  if (chunk.usage) usage = chunk.usage
}
server.close()

console.log('--- 网关实际收到 ---')
console.log('method :', seen.method)
console.log('url    :', seen.url)
console.log('auth   :', seen.auth)
console.log('model  :', JSON.stringify(seen.body.model), '  <-- 模型 id 是否原样透传')
console.log('stream_options:', JSON.stringify(seen.body.stream_options))
console.log('--- 客户端收到 ---')
console.log('text   :', JSON.stringify(text))
console.log('usage  :', JSON.stringify(usage))
console.log('')
console.log('VERDICT T2 (baseURL=本地网关):', seen.url === '/v1/chat/completions' ? 'PASS' : 'FAIL url=' + seen.url)
console.log('VERDICT T3 (usage 桶):', usage?.prompt_tokens === 11 && usage?.prompt_tokens_details?.cached_tokens === 4 ? 'PASS' : 'FAIL')
console.log('VERDICT T6 (含冒号 id 透传):', seen.body.model === 'umbra:auto' ? 'PASS' : 'FAIL')