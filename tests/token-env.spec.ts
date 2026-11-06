/**
 * token-env.ts：令牌回写用户环境变量。
 *
 * 这是「API 密钥无效 AUTH」的第三道保障——网关会采用继承来的令牌，也会
 * 在漂移窗口接住旧令牌；这里保证下次启动继承到的就是当前那把。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { persistUserTokenEnv } from '../src/host/token-env.ts'

test('令牌回写：Windows 上写入用户环境变量', async () => {
  const calls: Array<[string, string]> = []
  const written = await persistUserTokenEnv('T'.repeat(43), 'STEWARD_LOCAL_TOKEN', {
    platform: 'win32',
    write: (name, value) => { calls.push([name, value]) },
  })
  assert.equal(written, true)
  assert.deepEqual(calls, [['STEWARD_LOCAL_TOKEN', 'T'.repeat(43)]])
})

test('令牌回写：非 Windows 不越界改写用户环境', async () => {
  let called = false
  const written = await persistUserTokenEnv('T'.repeat(43), 'STEWARD_LOCAL_TOKEN', {
    platform: 'linux',
    write: () => { called = true },
  })
  assert.equal(written, false)
  assert.equal(called, false)
})

test('令牌回写：同步抛错只返回 false，不把启动打断', async () => {
  const written = await persistUserTokenEnv('T'.repeat(43), 'STEWARD_LOCAL_TOKEN', {
    platform: 'win32',
    write: () => { throw new Error('denied') },
  })
  assert.equal(written, false)
})

test('令牌回写：异步失败同样只返回 false', async () => {
  const written = await persistUserTokenEnv('T'.repeat(43), 'STEWARD_LOCAL_TOKEN', {
    platform: 'win32',
    write: async () => { throw new Error('denied') },
  })
  assert.equal(written, false)
})
