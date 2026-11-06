/**
 * 会话 Cookie 体检与清理。
 *
 * 这条故障链（宿主每次启动加一枚 dsh-auth-*，攒满后请求头 >16 KB → 431 →
 * 桌面端报 Web authentication failed）没法在单测里真跑一遍，但「数得准」
 * 与「删得干净、不动别的行」必须钉死。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AUTH_COOKIE_DANGER, AUTH_COOKIE_WARN, countAuthCookies } from '../src/core/auth-cookies.ts'
import { defaultCookieDbPath, pruneAuthCookiesFile } from '../src/host/auth-cookies.ts'

test('countAuthCookies 只数 dsh-auth-*', () => {
  const header = 'theme=dark; dsh-auth-abc=v1.sig; foo=1; dsh-auth-def=v1.sig'
  assert.equal(countAuthCookies(header), 2)
})

test('countAuthCookies 对空值/缺失给 0', () => {
  assert.equal(countAuthCookies(undefined), 0)
  assert.equal(countAuthCookies(''), 0)
  assert.equal(countAuthCookies('a=1; b=2'), 0)
})

test('countAuthCookies 容忍空格与空段，也认没有 = 的段', () => {
  assert.equal(countAuthCookies('  dsh-auth-a=1 ; ; dsh-auth-b=2 '), 2)
})

test('提醒线低于危险线，且都留了安全余量', () => {
  assert.ok(AUTH_COOKIE_WARN < AUTH_COOKIE_DANGER)
  assert.ok(AUTH_COOKIE_DANGER < 70, '70 枚左右就会撞上 16 KB 头上限')
})

test('pruneAuthCookiesFile 删掉该源的 dsh-auth-*，保留别的行', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cookies-'))
  const dbPath = join(dir, 'Cookies')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE cookies (host_key TEXT, name TEXT, path TEXT)')
  const insert = db.prepare('INSERT INTO cookies (host_key, name, path) VALUES (?, ?, ?)')
  insert.run('127.0.0.1', 'dsh-auth-one', '/')
  insert.run('127.0.0.1', 'dsh-auth-two', '/')
  insert.run('127.0.0.1', 'dsh-auth-three', '/')
  insert.run('127.0.0.1', 'keep-me', '/')
  insert.run('example.com', 'dsh-auth-other-host', '/')
  db.close()

  const result = await pruneAuthCookiesFile(dbPath, { keep: 1 })
  assert.equal(result?.before, 3)
  assert.equal(result?.after, 1)
  assert.ok(result?.backup !== undefined, '默认先备份')

  const after = new DatabaseSync(dbPath, { readOnly: true })
  const names = after
    .prepare('SELECT host_key, name FROM cookies ORDER BY name')
    .all() as Array<{ host_key: string, name: string }>
  after.close()
  const localAuth = names.filter((row) => row.host_key === '127.0.0.1' && row.name.startsWith('dsh-auth-'))
  assert.equal(localAuth.length, 1, '只保留 1 枚本机会话 Cookie')
  assert.ok(names.some((row) => row.name === 'keep-me'), '别的 Cookie 不能动')
  assert.ok(
    names.some((row) => row.host_key === 'example.com' && row.name === 'dsh-auth-other-host'),
    '别的源的同名 Cookie 不能动',
  )
  await rm(dir, { recursive: true, force: true })
})

test('pruneAuthCookiesFile 对不存在的库返回 undefined', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cookies-'))
  const result = await pruneAuthCookiesFile(join(dir, 'nope'), { keep: 0 })
  assert.equal(result, undefined)
  await rm(dir, { recursive: true, force: true })
})

test('defaultCookieDbPath 跟随 APPDATA', () => {
  const path = defaultCookieDbPath({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming' })
  assert.ok(path !== undefined)
  assert.ok(path.includes('dsh-desktop'))
  assert.equal(defaultCookieDbPath({}), undefined)
})
