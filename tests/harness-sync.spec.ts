/**
 * harness-sync：管家 → DSH 系统模型设置的写回。
 *
 * 这段会改用户的 profile，所以每一步都要能被单测钉住：
 * 只动目标 provider、别的上游一个字不动、空密钥不清掉已有的。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveSyncVendorId, syncInputFromVendor, upsertHarnessProvider } from '../src/host/harness-sync.ts'
import type { VendorConfig } from '../src/core/types.ts'

function doc(): unknown {
  return {
    plugins: [
      { id: 'other', name: '@deepseek-ai/something' },
      {
        id: 'llm-pi-ai',
        name: '@deepseek-ai/dsh-llm-pi-ai',
        config: {
          providers: {
            agnes: { displayName: 'Agnes', baseURL: 'https://api.agnes-ai.cn/v1', apiKeyEnv: 'AGNES_API_KEY', models: [{ id: 'a1', name: 'a1' }] },
          },
        },
      },
    ],
  }
}

function providers(parsed: unknown): Record<string, Record<string, unknown>> {
  const entries = (parsed as { plugins: Array<Record<string, unknown>> }).plugins
  const entry = entries.find((item) => String(item.name).endsWith('llm-pi-ai')) as { config: { providers: Record<string, Record<string, unknown>> } }
  return entry.config.providers
}

test('新厂家被写进 llm-pi-ai，模型清单跟着走', () => {
  const result = upsertHarnessProvider(doc(), {
    vendorId: 'westlake',
    vendorName: '西湖 HPC',
    baseUrl: 'https://hpc-api.westlake.edu.cn/v1',
    apiKey: 'sk-test',
    models: [{ id: 'Qwen', name: 'Qwen' }],
  })
  const map = providers(result)
  assert.equal(map.westlake?.baseURL, 'https://hpc-api.westlake.edu.cn/v1')
  assert.equal(map.westlake?.apiKey, 'sk-test')
  assert.deepEqual(map.westlake?.models, [{ id: 'Qwen', name: 'Qwen' }])
})

test('已有的其他上游一个字都不动', () => {
  const result = upsertHarnessProvider(doc(), {
    vendorId: 'westlake',
    vendorName: '西湖 HPC',
    baseUrl: 'https://relay.example/v1',
    apiKey: '',
    models: [{ id: 'm', name: 'm' }],
  })
  const map = providers(result)
  assert.deepEqual(map.agnes, {
    displayName: 'Agnes',
    baseURL: 'https://api.agnes-ai.cn/v1',
    apiKeyEnv: 'AGNES_API_KEY',
    models: [{ id: 'a1', name: 'a1' }],
  })
})

test('密钥留空时保留已有的，不会被清成空字符串', () => {
  const withKey = upsertHarnessProvider(doc(), {
    vendorId: 'relay', vendorName: 'Relay', baseUrl: 'https://r.example/v1', apiKey: 'sk-old', models: [{ id: 'm', name: 'm' }],
  })
  const again = upsertHarnessProvider(withKey, {
    vendorId: 'relay', vendorName: 'Relay', baseUrl: 'https://r.example/v1', apiKey: '', models: [{ id: 'm2', name: 'm2' }],
  })
  const relay = providers(again).relay
  assert.equal(relay?.apiKey, 'sk-old')
  assert.deepEqual(relay?.models, [{ id: 'm2', name: 'm2' }])
})

test('同步输入取自重管家的配置：模型名用拉取快照里的名字', () => {
  const vendor: VendorConfig = {
    vendorId: 'relay',
    vendorName: 'Relay',
    officialUrl: '',
    customUrl: 'https://r.example/v1',
    endpointSource: 'relay',
    apiKey: 'sk-test',
    enabledModels: ['m1', 'm2'],
    pulledModels: [{ id: 'm1', name: 'Model One' }],
  }
  const input = syncInputFromVendor(vendor, 'https://r.example/v1')
  assert.deepEqual(input.models, [{ id: 'm1', name: 'Model One' }, { id: 'm2', name: 'm2' }])
  assert.equal(input.baseUrl, 'https://r.example/v1')
})


/* ───── 写回时按地址认领 provider 键 ───── */

test('同 id 已在 profile 里：就写它', () => {
  assert.equal(resolveSyncVendorId(doc(), 'agnes', 'https://api.agnes-ai.cn/v1'), 'agnes')
})

test('id 不同但地址相同：认领已有那条，不留第二份同一家上游', () => {
  const parsed = {
    plugins: [{ id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: {
      westlake: { displayName: 'Westlake', baseURL: 'https://hpc-api.westlake.edu.cn/v1', models: [] },
    } } }],
  }
  // 管家里的厂家叫 custom，地址写成带斜杠 / 大写，也要认出来。
  assert.equal(resolveSyncVendorId(parsed, 'custom', 'https://HPC-API.westlake.edu.cn/v1/'), 'westlake')
})

test('地址也对不上：用管家自己的 id 新建一条', () => {
  assert.equal(resolveSyncVendorId(doc(), 'relay', 'https://relay.example/v1'), 'relay')
})

test('写回时补 defaultMaxTokens：llm-pi-ai 的 128000 缺省会让 Agnes 这类上游直接 400', () => {
  const result = upsertHarnessProvider(doc(), {
    vendorId: 'agnes', vendorName: 'Agnes', baseUrl: 'https://api.agnes-ai.cn/v1', apiKey: '', models: [{ id: 'a1', name: 'a1' }],
  })
  assert.equal(providers(result).agnes?.defaultMaxTokens, 65_536)
})

test('用户自己设过 defaultMaxTokens 就保留，不被覆盖', () => {
  const parsed = {
    plugins: [{ id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: {
      relay: { baseURL: 'https://r.example/v1', defaultMaxTokens: 8_192, models: [] },
    } } }],
  }
  const result = upsertHarnessProvider(parsed, {
    vendorId: 'relay', vendorName: 'Relay', baseUrl: 'https://r.example/v1', apiKey: '', models: [{ id: 'm', name: 'm' }],
  })
  assert.equal(providers(result).relay?.defaultMaxTokens, 8_192)
})

test('写回明文密钥时保留 apiKeyEnv：DSH 只认这个凭据指针', () => {
  const withEnv = {
    plugins: [{ id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: {
      agnes: { displayName: 'Agnes', baseURL: 'https://api.agnes-ai.cn/v1', apiKeyEnv: 'AGNES_API_KEY', models: [] },
    } } }],
  }
  const result = upsertHarnessProvider(withEnv, {
    vendorId: 'agnes', vendorName: 'Agnes', baseUrl: 'https://api.agnes-ai.cn/v1', apiKey: 'sk-literal', models: [{ id: 'a', name: 'a' }],
  })
  const agnes = providers(result).agnes
  assert.equal(agnes?.apiKey, 'sk-literal')
  assert.equal(agnes?.apiKeyEnv, 'AGNES_API_KEY', '删掉它 DSH 会报 No API key for provider')
})
