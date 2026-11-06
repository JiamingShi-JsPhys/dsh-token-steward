/**
 * DSH client SDK 的最小 ambient 声明。
 *
 * 真实的 `@deepseek-ai/cordis` / `dsh-client-ui-renderer` / `dsh-client-locale` /
 * `dsh-client-ui-slots` 由宿主在运行时提供（peerDependencies，与 @linxin666
 * 全家桶一致）。本仓库在离线环境里拿不到那几份 d.ts，因此这里只声明
 * 本插件实际用到的成员。
 *
 * 这不是「猜 API」：每个成员都对照过已安装的 dsh-pet / dsh-usage 源码——
 *   - `ctx.slots` 自 0.1.2 起由 ui-renderer 拥有（见 dsh-usage 的注释）；
 *   - `ctx.locale.register(NS, { zh, en })` / `ctx.locale.bind(NS)`；
 *   - `ctx.slots.inject(seat, run)` / `ctx.slots.register(options, component)`，
 *     settings 席位的 options 带 order / label / locale。
 * 一旦真正的 SDK 包装进来，这个文件就该删掉。
 */

declare module '@deepseek-ai/cordis' {
  /** cordis 的根上下文（只声明本插件用到的成员）。 */
  export interface Context {
    /** 登记一个副作用；返回的 disposer 在插件卸载时调用。 */
    effect(run: () => (() => void) | void, label?: string): () => void
    /** 取一个可选服务，不存在时返回 undefined。 */
    get?(name: string): unknown
    /** 该插件的日志器。 */
    logger: {
      info(...args: unknown[]): void
      warn(...args: unknown[]): void
      error(...args: unknown[]): void
    }
    /** 渲染器提供的席位注册表。 */
    slots: SlotRegistry
    /** 语言插件提供的词典服务。 */
    locale: LocaleService
    /** 每个 trial 都合并进来的服务接口表。 */
    [service: string]: unknown
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  /** 各插件通过 declaration merging 扩展它来声明自己的席位。 */
  export interface SlotMap {}
}

declare module '@deepseek-ai/dsh-client-ui-renderer/client' {
  /** 一个席位的注册选项。 */
  export interface SlotRegisterOptions {
    /** 席位名，如 'shell.overlay'。 */
    name: string
    /** 同一席位内的唯一 id。 */
    id?: string
    /** 同席位内的排序权重，小的在前。 */
    order?: number
    /** 导航条目文案（settings.section 用它渲染那一行）。 */
    label?: (() => string) | string
    /** 文案命名空间。 */
    locale?: string
  }

  /** 席位注册表。 */
  export interface SlotRegistry {
    /** 注册一个席位；返回解除注册的函数。 */
    register(options: SlotRegisterOptions, component?: unknown): () => void
    /** 等席位被声明之后再注册；返回解除注册的函数。 */
    inject(seat: string, run: () => () => void): () => void
    /** 读取某席位已登记的条目。 */
    entries(seat: string): Array<{ component: unknown, options: Record<string, unknown> }>
    /** 读取席位声明。 */
    spec(seat: string): unknown
  }
}

declare module '@deepseek-ai/dsh-client-locale/client' {
  /** 本地化服务。 */
  export interface LocaleService {
    /** 注册一个命名空间的两套词典；返回解除注册的函数。 */
    register(namespace: string, dictionaries: {
      zh: Record<string, string>
      en: Record<string, string>
    }): () => void
    /** 绑定一个命名空间，得到该命名空间的取词函数。 */
    bind(namespace: string): (key: string, params?: Record<string, unknown>) => string
    /** 当前语言。 */
    getLocale(): { active: string }
    /** 订阅语言切换。 */
    subscribe(listener: () => void): () => void
  }
}

declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}
