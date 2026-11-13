/**
 * 1.2.0 的边界断言：出站地址、日志脱敏、密钥落盘。
 *
 * 每一条都对应一个具体的攻击面，不是「防呆」：
 *  - 云元数据端点（169.254.169.254）不能作为探测目标；
 *  - 上游回显的 key 不能原样进日志或回给客户端；
 *  - vendors.json 里不能出现明文 key，但老文件必须能平滑升级。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertUpstreamUrl } from '../src/host/discovery.ts'
import { redact, redactKnown, redactShaped } from '../src/host/redact.ts'
import { createSecretVault } from '../src/host/secret-vault.ts'
import { coerceVendorsList, createVendorStore, type VendorsDocument } from '../src/host/vendor-store.ts'
import { parsePool } from '../src/core/pool-schema.ts'

/* ────────────────────────── 出站地址 ────────────────────────── */

test('探测地址：只放行 http/https，且拒绝内嵌凭据', () => {
  assert.equal(assertUpstreamUrl('https://api.example.com/v1').hostname, 'api.example.com')
  assert.equal(assertUpstreamUrl('http://127.0.0.1:11434/v1').hostname, '127.0.0.1', '本地 Ollama 是正当用法')
  for (const bad of ['file:///etc/passwd', 'ftp://example.com', 'gopher://example.com']) {
    assert.throws(() => assertUpstreamUrl(bad), /only http and https/, bad)
  }
  assert.throws(() => assertUpstreamUrl('https://user:pass@example.com/v1'), /must not embed credentials/)
  assert.throws(() => assertUpstreamUrl('not a url'), /not a valid url/)
  assert.throws(() => assertUpstreamUrl('https://example.com/' + 'a'.repeat(2100)), /too long/)
})

test('探测地址：云元数据与链路本地一律拒绝', () => {
  for (const bad of [
    'http://169.254.169.254/latest/meta-data',
    'http://169.254.1.1/',
    'http://metadata.google.internal/computeMetadata/v1',
    'http://[fe80::1]/',
    'http://0.0.0.0:8080/',
  ]) {
    assert.throws(() => assertUpstreamUrl(bad), /link-local or metadata/, bad)
  }
})

/* ────────────────────────── 脱敏 ────────────────────────── */

test('脱敏：已知明文与形状可疑的片段都变成掩码', () => {
  const secret = 'sk-live-abcdefghijklmnopqrstuvwxyz'
  const message = 'Incorrect API key provided: ' + secret + ' (Bearer ' + secret + ')'
  const cleaned = redact(message, [secret])
  assert.ok(!cleaned.includes(secret))
  assert.equal(cleaned.split('‹redacted›').length - 1, 2)
  // 不认识的那把钥匙，按形状也要挡住。
  const shaped = redactShaped('key=sk-proj-0123456789abcdef\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz')
  assert.ok(!shaped.includes('sk-proj-0123456789abcdef'))
  assert.ok(!shaped.includes('abcdefghijklmnopqrstuvwxyz'))
  // 普通文本零副作用。
  assert.equal(redact('上游返回 500，已切到下一家'), '上游返回 500，已切到下一家')
  // 太短的「已知值」不做替换，避免把常见词打码。
  assert.equal(redactKnown('the model is fast', ['fast']), 'the model is fast')
})

/* ────────────────────────── 密钥落盘 ────────────────────────── */

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'steward-store-'))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function document(apiKey: string): VendorsDocument {
  return {
    version: 1,
    mode: 'frugal',
    vendors: [{
      vendorId: 'lab',
      vendorName: 'lab',
      officialUrl: 'https://relay.example.com/v1',
      customUrl: '',
      endpointSource: 'official',
      apiKey,
      enabledModels: ['deepseek-flash'],
    }],
  }
}

test('vendors.json：密钥以密文写盘，重启后能解回明文', async () => {
  await withDirectory(async (directory) => {
    const vault = await createSecretVault(directory, { env: {} })
    const store = createVendorStore(directory, { vault })
    await store.save(document('sk-live-super-secret-value'))
    const raw = await readFile(join(directory, 'vendors.json'), 'utf8')
    assert.ok(!raw.includes('sk-live-super-secret-value'), '明文绝不能出现在文件里')
    assert.ok(raw.includes('enc:v1:'), '应写成 enc:v1: 密文')
    if (process.platform !== 'win32') {
      assert.equal((await stat(join(directory, 'vendors.json'))).mode & 0o777, 0o600)
    }
    const reopened = createVendorStore(directory, { vault: await createSecretVault(directory, { env: {} }) })
    const loaded = await reopened.load()
    assert.equal(loaded.vendors[0]?.apiKey, 'sk-live-super-secret-value')
  })
})

test('vendors.json：老版本留下的明文能读，并在下次保存时升级成密文', async () => {
  await withDirectory(async (directory) => {
    await writeFile(join(directory, 'vendors.json'), JSON.stringify(document('sk-legacy-plain-key'), null, 2), 'utf8')
    const vault = await createSecretVault(directory, { env: {} })
    const store = createVendorStore(directory, { vault })
    const loaded = await store.load()
    assert.equal(loaded.vendors[0]?.apiKey, 'sk-legacy-plain-key')
    await store.save(loaded)
    const raw = await readFile(join(directory, 'vendors.json'), 'utf8')
    assert.ok(!raw.includes('sk-legacy-plain-key'))
    assert.ok(raw.includes('enc:v1:'))
  })
})

test('vendors.json：解不开的密文原样保留，不被一次保存抹掉', async () => {
  await withDirectory(async (directory) => {
    const writer = createVendorStore(directory, { vault: await createSecretVault(directory, { env: {} }) })
    await writer.save(document('sk-keep-me'))
    const before = JSON.parse(await readFile(join(directory, 'vendors.json'), 'utf8')) as { vendors: Array<{ apiKey: string }> }
    const sealedValue = before.vendors[0]!.apiKey
    // 换一把钥匙再打开：解不开，但文件不能被改坏。
    const foreign = await createSecretVault(directory, {
      env: { STEWARD_VAULT_KEY: Buffer.alloc(32, 9).toString('base64url') },
    })
    const store = createVendorStore(directory, { vault: foreign })
    const loaded = await store.load()
    assert.equal(loaded.vendors[0]?.apiKey, '', '解不开时对上层表现为没有密钥')
    await store.save(loaded)
    const after = JSON.parse(await readFile(join(directory, 'vendors.json'), 'utf8')) as { vendors: Array<{ apiKey: string }> }
    assert.equal(after.vendors[0]?.apiKey, sealedValue, '密文必须一字不差地留着')
  })
})

/* ────────────────────────── 原型键 ────────────────────────── */

test('原型键：modelTags / modelPricing 里的 __proto__ 被丢弃，不污染 Object.prototype', () => {
  // 字面量 `{__proto__: ...}` 在 JS 里是设原型；用 JSON.parse 才是真的「键」。
  const raw = JSON.parse('[{"vendorId":"lab","modelTags":{"__proto__":["vision"]},"modelPricing":{"__proto__":{"input":0,"output":0}}}]') as unknown
  const vendors = coerceVendorsList(raw)
  assert.equal(vendors.length, 1)
  assert.equal(vendors[0]?.modelTags, undefined)
  assert.equal(vendors[0]?.modelPricing, undefined)
  assert.equal(({} as Record<string, unknown>).vision, undefined)
})

test('原型键：矩阵的请求头名是保留字时整份拒绝', () => {
  const result = parsePool({
    providers: [{
      provider_name: 'p',
      api_key: 'env:TEST_KEY',
      headers: JSON.parse('{"__proto__":"x"}') as unknown,
      models: [{
        id: 'm',
        capabilities: [],
        input_modalities: ['text'],
        cost_level: 'low',
        availability: 'direct',
        context_window: 8000,
      }],
    }],
  })
  assert.equal(result.ok, false)
})
