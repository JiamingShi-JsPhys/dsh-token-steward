/**
 * 构建产物验收。
 *
 * 单元测试证明的是源码对；这里证明的是**打包出来的东西能在宿主的加载器里跑起来**。
 * 差别是真实存在的：client 半区必须是 window.__ModuleLoader__.load 的工厂形态，
 * react 必须由宿主注入而不是打进第二份，CSS 必须以 style 标签注入。
 * 任何一条错了，源码测试全绿而插件在浏览器里一片空白。
 *
 * 一条方法论：所有断言都走**行为**，不走文本 grep —— 产物是压缩过的，
 * `order: 140` 到这里已经变成 `order: ne`，grep 只会给出假阴性。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 读构建产物；不存在时给出可读的失败（先跑 npm run build）。 */
async function artifact(relative: string): Promise<string> {
  try {
    return await readFile(join(ROOT, relative), 'utf8')
  } catch {
    throw new Error(relative + ' is missing — run `npm run build` first')
  }
}

/** 一次伪宿主挂载的观察结果。 */
interface MountObservation {
  /** 传给 slots.register 的选项对象。 */
  registered: Array<Record<string, unknown>>
  /** 请求挂载的席位名。 */
  injections: string[]
  /** 登记的 effect 标签。 */
  effects: string[]
  /** 注册的文案命名空间。 */
  localeNamespaces: string[]
  /** 插入的 style 标签。 */
  styleTags: Array<{ dataset: Record<string, string>, textContent: string }>
  /** 向宿主 require 的模块。 */
  required: string[]
  /** 模块导出。 */
  exports: Record<string, unknown>
}

/**
 * 在伪宿主里真的加载一次 lib/client.js 并调用 apply。
 * @returns 观察结果；任何一步失败都抛错。
 */
async function mountAgainstFakeHost(): Promise<MountObservation> {
  const text = await artifact('lib/client.js')

  const styleTags: Array<{ dataset: Record<string, string>, textContent: string }> = []
  const document = {
    head: { appendChild: (node: { dataset: Record<string, string>, textContent: string }) => { styleTags.push(node); return node } },
    body: { appendChild: () => undefined },
    querySelector: () => null,
    createElement: (tag: string) => ({
      tag,
      dataset: {} as Record<string, string>,
      textContent: '',
      style: {},
      setAttribute: () => undefined,
    }),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    visibilityState: 'visible',
  }

  const registered: Array<Record<string, unknown>> = []
  const injections: string[] = []
  const effects: string[] = []
  const localeNamespaces: string[] = []

  const context = {
    effect(run: () => (() => void) | void, label?: string) {
      effects.push(label ?? '')
      const dispose = run()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    logger: { info() {}, warn() {}, error() {} },
    slots: {
      register(options: Record<string, unknown>) {
        registered.push(options)
        return () => undefined
      },
      inject(seat: string, run: () => () => void) {
        injections.push(seat)
        return run()
      },
      entries: () => [],
      spec: () => undefined,
    },
    locale: {
      register(namespace: string) { localeNamespaces.push(namespace); return () => undefined },
      bind: () => (key: string) => key,
      getLocale: () => ({ active: 'zh' }),
      subscribe: () => () => undefined,
    },
  }

  // 宿主注入的模块替身。
  const modules: Record<string, unknown> = {
    react: await import('react'),
    'react-dom/client': { createRoot: () => ({ render: () => undefined, unmount: () => undefined }) },
    'react/jsx-runtime': await import('react/jsx-runtime'),
  }
  const required: string[] = []
  const require = (specifier: string): unknown => {
    required.push(specifier)
    const found = modules[specifier]
    if (found === undefined) throw new Error('the host does not inject ' + specifier)
    return found
  }

  let exports: Record<string, unknown> | undefined
  const window = {
    __ModuleLoader__: {
      load(entry: { id: string, factory: (require: (s: string) => unknown) => unknown }) {
        exports = entry.factory(require) as Record<string, unknown>
      },
    },
  }

  // 用 Function 构造一个带 window / document 的作用域，模拟浏览器里的全局。
  const run = new Function('window', 'document', 'setInterval', 'clearInterval', 'fetch', 'AbortSignal', text)
  run(window, document, () => 0, () => undefined, async () => { throw new Error('no network in this test') }, AbortSignal)

  assert.ok(exports !== undefined, 'client 半区必须自己调用 loader.load')
  ;(exports.apply as (ctx: unknown) => void)(context)

  return { registered, injections, effects, localeNamespaces, styleTags, required, exports }
}

/* ────────────────────────── Host 半区 ────────────────────────── */

test('Host 半区是普通 ESM，导出 name / inject / apply / default', async () => {
  // Windows 上动态 import 绝对路径必须转成 file:// URL。
  const url = new URL('file:///' + join(ROOT, 'lib/index.js').replace(/\\/g, '/'))
  const module = await import(url.href) as Record<string, unknown>
  assert.equal(module.name, 'umbra-budget')
  assert.deepEqual(module.inject, ['webServer'])
  assert.equal(typeof module.apply, 'function')
  assert.equal(typeof module.default, 'object')
})

test('Host 半区不把 yaml 打进来（由宿主提供）', async () => {
  const text = await artifact('lib/index.js')
  assert.ok(text.includes('"yaml"') || text.includes("'yaml'"), '应当以 import 形式引用宿主提供的 yaml')
  assert.equal(text.includes('YAMLException'), false, 'yaml 应当被外置')
})

/* ────────────────────────── Client 半区外壳 ────────────────────────── */

test('Client 半区是 __ModuleLoader__ 工厂形态', async () => {
  const text = await artifact('lib/client.js')
  assert.ok(text.startsWith('window.__ModuleLoader__.load({'), '外壳必须是 loader.load')
  assert.ok(text.includes('id: "dsh-umbra-budget"'))
  assert.ok(text.includes('factory: (require) =>'))
  assert.ok(text.trimEnd().endsWith('});'))
})

test('Client 半区不打包 react，而是 require 宿主注入', async () => {
  const observation = await mountAgainstFakeHost()
  assert.ok(observation.required.includes('react'), 'react 必须由宿主注入')
  assert.ok(observation.required.includes('react-dom/client'), 'react-dom/client 必须由宿主注入')
  // 打进第二份 React 的特征串不会出现在产物里。
  const text = await artifact('lib/client.js')
  assert.equal(text.includes('REACT_ELEMENT_TYPE'), false, '不应打进第二份 react')
  assert.equal(text.includes('Warning: Each child in a list'), false, '不应打进第二份 react')
})

test('Client 半区只 require 宿主提供的模块', async () => {
  const observation = await mountAgainstFakeHost()
  const hostProvided = new Set(['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'])
  const unexpected = observation.required.filter((specifier) => !hostProvided.has(specifier))
  assert.deepEqual(unexpected, [], '多要一个模块就是宿主启动时崩：' + unexpected.join(', '))
})

test('Client 半区把 CSS 以 style 标签注入且幂等', async () => {
  const observation = await mountAgainstFakeHost()
  assert.equal(observation.styleTags.length, 1, '应当插入且只插入一个 style 标签')
  const tag = observation.styleTags[0]
  assert.ok(tag !== undefined)
  assert.equal(tag.dataset.plugin, 'dsh-umbra-budget')
  assert.equal(tag.dataset.pluginCss, 'dsh-umbra-budget/src/client/umbra.module.css')
  assert.ok(tag.textContent.includes('.umbra_ball'), '样式表里应当有 .umbra_ball')
  assert.ok(tag.textContent.includes('--dsw-alias-'), '样式必须走主题令牌，否则皮肤换不了色')
})

/* ────────────────────────── Client 半区行为 ────────────────────────── */

test('Client 半区导出正确的 name / inject / apply', async () => {
  const observation = await mountAgainstFakeHost()
  assert.equal(observation.exports.name, '@linxin666/dsh-client-ui-umbra-budget')
  assert.deepEqual(observation.exports.inject, ['slots', 'locale'])
  assert.equal(typeof observation.exports.apply, 'function')
})

test('注册文案命名空间，且取词失败时退回中文键源', async () => {
  const observation = await mountAgainstFakeHost()
  assert.deepEqual(observation.localeNamespaces, ['umbra-budget'])
  assert.ok(observation.effects.some((label) => label.includes('locale')), 'locale 注册必须可回收')
})

test('两个席位都被请求挂载', async () => {
  const observation = await mountAgainstFakeHost()
  assert.deepEqual(observation.injections.slice().sort(), ['settings.section', 'shell.overlay'])
  assert.ok(observation.effects.length >= 3, 'locale / overlay / settings 三个 effect 都应登记')
})

test('设置页注册带上 order 与 label：设置导航要靠它们渲染那一行', async () => {
  const observation = await mountAgainstFakeHost()
  const settings = observation.registered.find((entry) => entry.name === 'settings.section')
  assert.ok(settings !== undefined, '必须注册到 settings.section')
  assert.equal(settings.order, 140, '必须给出排序权重（排在 dsh-usage 的 100 之后）')
  assert.equal(typeof settings.label, 'function', 'label 必须是函数，随语言切换重取')
  assert.equal(settings.locale, 'umbra-budget')
  assert.equal(settings.id, 'umbra-budget')
})
