/**
 * 静态加密：密文能回、明文不落盘、篡改必须被发现。
 *
 * 这些断言对应 1.2.0 的安全承诺，别删：
 *  - `enc:v1:` 前缀稳定（老文件靠它认）；
 *  - 同一明文两次加密得到不同密文（IV 随机），但都能解回；
 *  - 改一个字节就必须解不开，而不是「返回半截明文」；
 *  - 换一把钥匙也必须解不开；
 *  - 密钥文件 0600，且第二次打开用的是同一把钥匙。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createSecretVault,
  isSealed,
  isSealedBytes,
  SEALED_PREFIX,
} from '../src/host/secret-vault.ts'

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'steward-vault-'))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('文本：加密-解密往返，前缀正确，同一明文两次密文不同', async () => {
  await withDirectory(async (directory) => {
    const vault = await createSecretVault(directory, { env: {} })
    assert.equal(vault.available(), true)
    const plain = 'sk-live-abcdef1234567890'
    const first = vault.seal(plain)
    const second = vault.seal(plain)
    assert.ok(first.startsWith(SEALED_PREFIX))
    assert.equal(isSealed(first), true)
    assert.notEqual(first, second, 'IV 必须随机')
    assert.equal(vault.open(first), plain)
    assert.equal(vault.open(second), plain)
    // 明文原样进、原样出（兼容老文件）。
    assert.equal(vault.open('plain-text-key'), 'plain-text-key')
    // 空串保持空串，不要产生一个「加密过的空值」。
    assert.equal(vault.seal(''), '')
  })
})

test('文本：篡改一个字节就解不开，绝不返回半截明文', async () => {
  await withDirectory(async (directory) => {
    const vault = await createSecretVault(directory, { env: {} })
    const sealed = vault.seal('sk-secret-value')
    const marker = sealed.lastIndexOf('.') + 2
    const tampered = sealed.slice(0, marker) + (sealed[marker] === 'A' ? 'B' : 'A') + sealed.slice(marker + 1)
    assert.notEqual(tampered, sealed)
    assert.equal(vault.open(tampered), undefined)
    // 截断的密文同样拒绝。
    assert.equal(vault.open(sealed.slice(0, sealed.length - 4)), undefined)
  })
})

test('文本：换一把钥匙就解不开', async () => {
  await withDirectory(async (directory) => {
    const first = await createSecretVault(directory, { env: {} })
    const sealed = first.seal('sk-one')
    const other = await createSecretVault(directory, { env: { STEWARD_VAULT_KEY: Buffer.alloc(32, 7).toString('base64url') } })
    assert.equal(other.available(), true)
    assert.equal(other.open(sealed), undefined)
  })
})

test('字节：缓存正文往返，篡改返回 undefined', async () => {
  await withDirectory(async (directory) => {
    const vault = await createSecretVault(directory, { env: {} })
    const plain = Buffer.from('data: {"choices":[{"message":{"content":"你好"}}]}', 'utf8')
    const sealed = vault.sealBytes(plain)
    assert.equal(isSealedBytes(sealed), true)
    assert.equal(Buffer.from(vault.openBytes(sealed) ?? []).toString('utf8'), plain.toString('utf8'))
    const tampered = Buffer.from(sealed)
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff
    assert.equal(vault.openBytes(tampered), undefined)
    // 不是密文的字节原样返回（兼容升级前写下的缓存）。
    const legacy = Buffer.from('{"ok":true}', 'utf8')
    assert.equal(vault.openBytes(legacy), legacy)
  })
})

test('密钥文件：自动生成、0600、跨实例稳定', async () => {
  await withDirectory(async (directory) => {
    const first = await createSecretVault(directory, { env: {} })
    const keyPath = first.keyPath()
    const mode = (await stat(keyPath)).mode & 0o777
    if (process.platform !== 'win32') assert.equal(mode, 0o600)
    const raw = (await readFile(keyPath, 'utf8')).trim()
    assert.ok(raw.length >= 40, '32 字节 base64url')
    const sealed = first.seal('sk-stable')
    const second = await createSecretVault(directory, { env: {} })
    assert.equal(second.open(sealed), 'sk-stable', '第二次启动必须用同一把钥匙')
  })
})

test('密钥文件内容坏了：退化为不加密，但绝不覆盖用户的文件', async () => {
  await withDirectory(async (directory) => {
    const broken = join(directory, '.vault-key')
    await writeFile(broken, 'not-a-key\n', 'utf8')
    const vault = await createSecretVault(directory, { env: {} })
    assert.equal(vault.available(), false)
    // 退化实现：原样读写，功能不中断。
    assert.equal(vault.seal('plain'), 'plain')
    assert.equal(vault.open('plain'), 'plain')
    assert.equal(await readFile(broken, 'utf8'), 'not-a-key\n', '坏文件必须保持原样')
  })
})
