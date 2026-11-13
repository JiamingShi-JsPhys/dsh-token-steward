/**
 * 打包后的 Host 半区端到端。
 *
 * 与 host-gateway.spec.ts 的区别：那边测源码，这里测**产物**。内置的 index.js
 * 如果漏了某个依赖、或被 esbuild 的 tree-shaking 剪掉了副作用，源码测试仍然全绿，
 * 而插件在宿主里一启动就坏。因此这里用真实的 lib/index.js 跑一遍全链路。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 导入打包后的 Host 半区。 */
/**
 * 收尾删临时目录。
 *
 * Windows 上 SQLite 关闭 WAL 之后，文件句柄可能还会被系统多持有几十毫秒，
 * 立刻 rm 会 EBUSY；重试几次即可，这不是被测行为。
 */
async function removeTree(directory: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true })
      return
    } catch (error) {
      if ((error as { code?: string }).code !== 'EBUSY' || attempt === 19) throw error
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
}

async function loadHost(): Promise<Record<string, unknown>> {
  const url = new URL('file:///' + join(ROOT, 'lib/index.js').replace(/\\/g, '/'))
  return await import(url.href) as Record<string, unknown>
}

/** 一份最小可用的矩阵配置。 */
const POOL_YAML = [
  'version: 1',
  'routing:',
  '  mode: frugal',
  '  aliases:',
  '    analysis:',
  '      mode: max_power',
  '      require: [reasoning]',
  'providers:',
  '  - provider_name: cheap',
  '    endpoint: https://cheap.example/v1',
  '    api: openai-completions',
  '    api_key: env:STEWARD_TEST_KEY',
  '    models:',
  '      - id: cheap-1',
  '        capabilities: [fast, coding]',
  '        cost_level: free',
  '        context_window: 128000',
  '        availability: direct',
  '        quality_rank: 40',
  '        pricing: { currency: CNY, input_per_mtok: 0, output_per_mtok: 1 }',
  '  - provider_name: strong',
  '    endpoint: https://strong.example/v1',
  '    api: openai-completions',
  '    api_key: env:STEWARD_TEST_KEY',
  '    models:',
  '      - id: strong-1',
  '        capabilities: [coding, reasoning, tool-use]',
  '        cost_level: high',
  '        context_window: 1000000',
  '        availability: direct',
  '        quality_rank: 95',
].join('\n')

test('打包后的 Host 半区能挂载、起网关、注册面板路由', async () => {
  const home = await mkdtemp(join(tmpdir(), 'steward-built-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  process.env.STEWARD_TEST_KEY = 'sk-test-000'

  const routes: Array<{ path: string, handler: (req: never, res: never) => void }> = []
  const logs: string[] = []
  let teardown: (() => void | Promise<void>) | undefined

  try {
    await mkdir(join(home, 'token-steward'), { recursive: true })
    await writeFile(join(home, 'token-steward', 'model_pool.yaml'), POOL_YAML)

    const host = await loadHost()
    assert.equal(typeof host.apply, 'function')

    await (host.apply as (ctx: unknown, config?: unknown) => Promise<void>)({
      logger: () => ({
        info: (...args: unknown[]) => logs.push('info ' + args.join(' ')),
        warn: (...args: unknown[]) => logs.push('warn ' + args.join(' ')),
        error: (...args: unknown[]) => logs.push('error ' + args.join(' ')),
      }),
      webServer: {
        register(route: { path: string, handler: (req: never, res: never) => void }) {
          routes.push(route)
          return () => undefined
        },
      },
      effect(run: () => () => void) {
        teardown = run()
        return () => undefined
      },
    }, {})

    // 自诊断：apply 走完必须翻成 ready（以前永远停在 'mounting'）。
    const selfCheck = JSON.parse(await readFile(join(home, 'token-steward', 'state.json'), 'utf8')) as { status: string, pid: number }
    assert.equal(selfCheck.status, 'ready')
    assert.equal(selfCheck.pid, process.pid)

    // 网关状态文件必须真的写出来，且带端口与令牌。
    const statePath = join(home, 'token-steward', 'gateway.json')
    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      baseUrl: string
      token: string
      modelIds: string[]
      port: number
      host: string
    }
    assert.equal(state.host, '127.0.0.1')
    assert.ok(state.port > 0)
    // 1.2.0 起 gateway.json 里的令牌是密文，先解开再用。
    const { createSecretVault } = await import('../src/host/secret-vault.ts')
    const vault = await createSecretVault(join(home, 'token-steward'), { env: {} })
    const token = vault.available() ? vault.open(state.token) : state.token
    assert.ok(typeof token === 'string' && token.length >= 40)
    assert.ok(state.token.startsWith('enc:v1:'), '令牌必须加密落盘')
    assert.deepEqual(
      state.modelIds.slice(0, 4),
      ['steward:frugal', 'steward:balanced', 'steward:max_power', 'steward:free'],
    )
    assert.ok(state.modelIds.includes('cheap-1'))
    assert.ok(state.modelIds.includes('strong-1'))

    // 网关真的在监听：未经授权 401，带令牌 200。
    const denied = await fetch(state.baseUrl + '/models')
    assert.equal(denied.status, 401)

    const models = await fetch(state.baseUrl + '/models', {
      headers: { authorization: 'Bearer ' + String(token) },
    })
    assert.equal(models.status, 200)
    const list = await models.json() as { data: Array<{ id: string }> }
    assert.ok(list.data.some((entry) => entry.id === 'steward:free'))

    // 面板路由都注册了（含内置头像）。
    assert.deepEqual(routes.map((route) => route.path).sort(), [
      '/api/token-steward/avatar',
      '/api/token-steward/delete-vendor',
      '/api/token-steward/discover',
      '/api/token-steward/gateway',
      '/api/token-steward/import-harness',
      '/api/token-steward/mode',
      '/api/token-steward/reload',
      '/api/token-steward/snapshot',
      '/api/token-steward/sync-harness',
      '/api/token-steward/vendors',
    ])

    // 用一个真 HTTP 服务承载这些路由，验证快照内容。
    const server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
      const route = routes.find((entry) => entry.path === path)
      if (route === undefined) {
        res.writeHead(404).end()
        return
      }
      void Promise.resolve(route.handler(req as never, res as never))
    })
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        resolve(typeof address === 'object' && address !== null ? address.port : 0)
      })
    })

    try {
      const base = 'http://127.0.0.1:' + String(port) + '/api/token-steward'
      const snapshot = await fetch(base + '/snapshot')
      assert.equal(snapshot.status, 200)
      const body = await snapshot.json() as {
        snapshot: {
          mode: string
          pool: { status: string }
          models: Array<{ provider: string, model: string, costLevel: string }>
          usageAvailable: boolean
        }
      }
      assert.equal(body.snapshot.pool.status, 'ok')
      assert.equal(body.snapshot.mode, 'frugal')
      assert.equal(body.snapshot.models.length, 2)
      assert.equal(body.snapshot.models[0]?.costLevel, 'free')
      // 没有 dsh-usage 台账时必须如实报告不可用，而不是给 0。
      assert.equal(body.snapshot.usageAvailable, false)

      const gatewayInfo = await fetch(base + '/gateway')
      const gatewayBody = await gatewayInfo.json() as { gateway: { token: string } }
      assert.equal(gatewayBody.gateway.token, token, '面板拿到的是明文令牌，磁盘上的是密文')

      const mode = await fetch(base + '/mode', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'max_power' }),
      })
      assert.equal(mode.status, 200)

      // 模式要写回配置文件，重启后仍生效。
      const persisted = await readFile(join(home, 'token-steward', 'model_pool.yaml'), 'utf8')
      assert.match(persisted, /mode: max_power/)

      const beforeReload = await (await fetch(base + '/snapshot')).json() as { snapshot: { revision: number } }

      const reload = await fetch(base + '/reload', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      })
      const reloadBody = await reload.json() as { ok: boolean, status: string }
      assert.equal(reloadBody.ok, true)
      assert.equal(reloadBody.status, 'ok')

      const afterReload = await fetch(base + '/snapshot')
      const afterBody = await afterReload.json() as { snapshot: { mode: string, revision: number } }
      assert.equal(afterBody.snapshot.mode, 'max_power', '重载后应当沿用刚才的模式')
      // 重载会重建路由引擎；序号必须接着上一次往下走，否则面板客户端把它当成
      // 迟到的旧响应丢掉，免费档列表会一直停在重载前的入池结果。
      assert.ok(
        afterBody.snapshot.revision > beforeReload.snapshot.revision,
        '重建路由后快照序号必须继续增长（收到 ' + String(afterBody.snapshot.revision)
          + '，之前是 ' + String(beforeReload.snapshot.revision) + '）',
      )
    } finally {
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }

    // 收尾不能抛错，且要放掉端口。
    assert.equal(typeof teardown, 'function')
    await teardown?.()
    await new Promise((resolve) => setTimeout(resolve, 50))
  } finally {
    // 断言失败也要真的拆掉网关：否则后台连接会锁住临时目录，把真正的原因
    // （断言）盖成一条 EBUSY。
    await Promise.resolve(teardown?.()).catch(() => {})
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    delete process.env.STEWARD_TEST_KEY
    await removeTree(home)
  }
});

test('首次安装：没有可用配置也把网关拉起来，面板照常注册', async () => {
  const home = await mkdtemp(join(tmpdir(), 'steward-built-first-run-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home

  let teardown: (() => void | Promise<void>) | undefined
  try {
    await mkdir(join(home, 'token-steward'), { recursive: true })
    await writeFile(join(home, 'token-steward', 'model_pool.yaml'), 'version: 1\nproviders: []\n')

    const routes: Array<{ path: string }> = []
    const host = await loadHost()
    await (host.apply as (ctx: unknown, config?: unknown) => Promise<void>)({
      logger: () => ({ info: () => undefined, warn: () => undefined, error: () => undefined }),
      webServer: { register(route: { path: string }) { routes.push(route); return () => undefined } },
      effect: (run: () => () => void) => { teardown = run(); return () => undefined },
    }, {})

    // 配置非法也要把网关拉起来：面板的「测试连接并拉取模型」要先能点，
    // 否则首次安装会卡在「没配置 → 没网关 → 没法配置」的死循环里。
    assert.equal(routes.length, 10)
    const state = JSON.parse(await readFile(join(home, 'token-steward', 'gateway.json'), 'utf8')) as {
      port: number
      modelIds: string[]
    }
    assert.ok(state.port > 0)
    assert.deepEqual(state.modelIds.slice(0, 4), ['steward:frugal', 'steward:balanced', 'steward:max_power', 'steward:free'])
  } finally {
    await teardown?.()
    await new Promise((resolve) => setTimeout(resolve, 50))
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await removeTree(home)
  }
});

test('首次安装：启动时把四个档位自动写进 profile 的 llm-pi-ai', async () => {
  const home = await mkdtemp(join(tmpdir(), 'steward-built-wire-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home

  const profileDir = join(home, 'profiles', 'desktop')
  const patchFile = join(profileDir, 'cordis.patch.yml')
  let teardown: (() => void | Promise<void>) | undefined
  try {
    await mkdir(join(home, 'token-steward'), { recursive: true })
    await writeFile(join(home, 'token-steward', 'model_pool.yaml'), 'version: 1\nproviders: []\n')
    await mkdir(profileDir, { recursive: true })
    // 用户手写的 profile：有注释、有另一家上游，接线必须一字不动地留着它们。
    await writeFile(patchFile, [
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
    ].join('\n'))

    // 宿主凭据库的替身：DSH 的凭据层读的是启动快照，插件只能经这个入口回写。
    const stored = new Map<string, string>()
    const credentials = {
      resolve: async (ref: string) => (stored.has(ref) ? { value: stored.get(ref) } : undefined),
      set: async (ref: string, value: string) => { stored.set(ref, value) },
    }
    const host = await loadHost()
    await (host.apply as (ctx: unknown, config?: unknown) => Promise<void>)({
      logger: () => ({ info: () => undefined, warn: () => undefined, error: () => undefined }),
      webServer: { register() { return () => undefined } },
      effect: (run: () => () => void) => { teardown = run(); return () => undefined },
      get: (name: string) => (name === 'credentials' ? credentials : undefined),
    }, {})

    const text = await readFile(patchFile, 'utf8')
    const state = JSON.parse(await readFile(join(home, 'token-steward', 'gateway.json'), 'utf8')) as {
      baseUrl: string
      token: string
    }
    for (const id of ['steward:frugal', 'steward:balanced', 'steward:max_power', 'steward:free']) {
      assert.ok(text.includes(id), id + ' 应该被写进 profile')
    }
    assert.ok(text.includes('baseURL: ' + state.baseUrl), '地址要与真正在跑的网关一致')
    assert.ok(text.includes('apiKeyEnv: STEWARD_LOCAL_TOKEN'))
    assert.ok(text.includes('defaultMaxTokens: 65536'))
    // 既有内容不许动。
    assert.ok(text.includes('# 用户自己的注释'), '注释必须保留')
    assert.ok(text.includes('agnes-3.0-flash'), '别的上游不能动')
    // 令牌要进宿主凭据库：只写 process.env 的话，设置页永远显示「未检测到环境变量」。
    // gateway.json 里的令牌是密文（1.2.0 起），比对前先用同一个密钥库解开。
    const { createSecretVault } = await import('../src/host/secret-vault.ts')
    const vault = await createSecretVault(join(home, 'token-steward'), { env: {} })
    const onDiskToken = vault.available() ? vault.open(state.token) : state.token
    assert.equal(stored.get('STEWARD_LOCAL_TOKEN'), onDiskToken, '令牌应写进 credentials')
  } finally {
    await teardown?.()
    await new Promise((resolve) => setTimeout(resolve, 50))
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await removeTree(home)
  }
});

test('回归：启动之后写入的 dsh-usage 台账，面板立刻能看到（计量不冻结）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'steward-live-usage-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  process.env.STEWARD_LIVE_KEY = 'sk-live'

  const routes: Array<{ path: string, handler: (req: never, res: never) => void }> = []
  let teardown: (() => void | Promise<void>) | undefined
  try {
    await mkdir(join(home, 'token-steward'), { recursive: true })
    await writeFile(join(home, 'token-steward', 'model_pool.yaml'), POOL_YAML)

    const host = await loadHost()
    await (host.apply as (ctx: unknown, config?: unknown) => Promise<void>)({
      logger: () => ({ info: () => undefined, warn: () => undefined, error: () => undefined }),
      webServer: { register(route: { path: string, handler: (req: never, res: never) => void }) {
        routes.push(route)
        return () => undefined
      } },
      effect: (run: () => () => void) => { teardown = run(); return () => undefined },
    }, { usagePollMs: 2_000 })

    const server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
      const route = routes.find((entry) => entry.path === path)
      if (route === undefined) { res.writeHead(404).end(); return }
      void Promise.resolve(route.handler(req as never, res as never))
    })
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        resolve(typeof address === 'object' && address !== null ? address.port : 0)
      })
    })

    try {
      const base = 'http://127.0.0.1:' + String(port) + '/api/token-steward'
      const before = await (await fetch(base + '/snapshot')).json() as {
        snapshot: { usageAvailable: boolean, totals: { todayTokens: number } }
      }
      assert.equal(before.snapshot.usageAvailable, false, '一开始没有台账，必须如实报告不可用')

      // 插件启动之后，dsh-usage 才写出台账。
      const today = new Date()
      const key = String(today.getFullYear()) + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0')
      await mkdir(join(home, 'dsh-usage'), { recursive: true })
      await writeFile(join(home, 'dsh-usage', 'usage-ledger.json'), JSON.stringify({
        version: 1,
        days: { [key]: { cheap: { 'cheap-1': { inputTokens: 500, outputTokens: 100, cost: 2.5 } } } },
      }))

      // 节流窗口过后必须看得到。
      await new Promise((resolve) => setTimeout(resolve, 2_100))
      const after = await (await fetch(base + '/snapshot')).json() as {
        snapshot: {
          usageAvailable: boolean
          totals: { todayTokens: number, todayCost: { currency: string, amount: number } | null }
          models: Array<{ provider: string, model: string, todayTokens: number }>
        }
      }
      assert.equal(after.snapshot.usageAvailable, true, '台账出现后必须变为可用')
      assert.equal(after.snapshot.totals.todayTokens, 600)
      assert.deepEqual(after.snapshot.totals.todayCost, { currency: 'CNY', amount: 2.5 })
      const card = after.snapshot.models.find((entry) => entry.provider === 'cheap' && entry.model === 'cheap-1')
      assert.equal(card?.todayTokens, 600, '用量必须落到对应模型卡上')
    } finally {
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
  } finally {
    // 必须收尾：网关端口不关，node --test 会一直等到超时。
    await teardown?.()
    await new Promise((resolve) => setTimeout(resolve, 100))
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    delete process.env.STEWARD_LIVE_KEY
    await removeTree(home)
  }
});
