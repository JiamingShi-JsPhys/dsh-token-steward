# dsh-umbra-budget 架构设计 —— DSH 模型矩阵调度中枢

> 状态：**已实现（v0.1.0）** —— M0 探针、路由引擎、拦截层、控制台全部落地；57 项测试全绿；TypeScript 严格模式 0 错误；tsdown 产物符合 DSH 双半区约定。
> 本设计的每一处关键机制均以 `_ref/` 参考源码为据，标注了出处文件；探针结论见 §6.4。

---

## 0. 参考源码阅读结论（设计的事实地基）

### 0.1 请求拦截的正道与死路（`_ref/dsh-provider-proxy`）

| 结论 | 依据 |
|---|---|
| ❌ **不能包装 `globalThis.fetch`**：模型 SDK 客户端在构造时捕获 fetch 引用，首个请求之后包装不可靠 | `dsh-provider-proxy/docs/architecture.md:61-63` |
| ❌ **不能改写 `GenerateOptions`**：loop 请求深冻结 | `dsh-provider-proxy/index.js:16-18` |
| ✅ **唯一可靠的底层拦截点：undici 全局 Dispatcher 替换**——`getGlobalDispatcher()` 捕获旧值 → `setGlobalDispatcher(自定义)` → dispose 时恢复 | `dsh-provider-proxy/index.js:118-134` |
| ✅ **`ctx.on('llm/stream', (options, next) => ...)` 瀑布是官方钦定扩展缝**：所有模型调用（agent loop 的 `prepareCall` 路径 + one-shot 直调）都经过；listener 可包装返回的 stream；`options` 携带 `{provider, model}` | `dsh-web/packages/dsh-task-board/src/host/llm-dispatch.ts:14-15` |
| ✅ **AsyncLocalStorage 包住 stream 的每次 pull**（next/return/throw），Dispatcher 在 dispatch 时刻读取 → 每个模型调用的并发隔离 | `dsh-provider-proxy/core.js:355-375` |
| ⚠️ 水瀑布中**没有任何带参 `next(payload)` 的先例**；能否就地改写 `options.provider/model` 需探针验证（见 §6.4） | 全库 grep `next(` 仅 `next()` 裸调用 |
| ✅ `llm.stream` 公开实例属性**官方文档明确允许插件替换**（但 agent loop 走 `prepareCall` 不经它） | `llm-dispatch.ts:10-11` |
| ✅ 失败语义：无效配置整体拒绝、apply 永不抛、诊断写 `$DSH_HOME/<plugin>/state.json`（Desktop 宿主无 stdout） | `dsh-provider-proxy/docs/architecture.md:69-74` |

### 0.2 Token 用量数据链路（`_ref/dsh-web/packages/dsh-usage`）

- 数据源 = cordis 事件 **`session/event`**，三类可用事件：
  - `request/header` → `event.data.header.config.{provider, model}`：会话→路由归因；
  - `request/context` → `event.data.{provider, model, contextWindow}`：当前路由 + 上下文窗口；
  - `assistant/message` → `event.data.usage`（`TokenUsage {inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?, reasoningTokens?}`）。
- **更直接的源头**：waterfall 包装层可直接观测流 chunk `{type:'usage', usage:{inputTokens, outputTokens, reasoningTokens}}` —— 天然覆盖 **one-shot 直调与子代理**（dsh-usage 的盲区：它只折 session 事件，one-shot 调用不进它的台账）。
- 子代理 = 独立 child session，各自广播 `request/header` + `assistant/message`；另有 `subagent/catalog` 事件。
- 台账模式：`日(YYYY-MM-DD) → provider → model → UsageTokenTotals`，3s debounce 原子落盘（临时文件 + fsync + rename），180 天保留。计费口径：billed input = input + cacheRead + cacheWrite。
- UI 取数模式：`ctx.webServer.register()` 挂 HTTP 路由 → 浏览器同源 fetch 轮询 → `defineStore`；实时推送用 SSE（EventSource + revision 帧 + onopen 再同步）。

### 0.3 UI 注入（`_ref/dsh-web` + `_ref/dsh-client-ui-pet`）

- client 半区 = tsdown 闭包工厂 bundle（`window.__ModuleLoader__.load({id, factory(require)})`），由 GUI 从 `/plugins/<pkg>/client.js` 运行时动态加载，支持原地热替换。
- manifest 声明：`package.json` 的 `dsh.client: { inject: [...官方运行时模块], platform: "web" }`。
- 槽位 API：`ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'umbra-budget' }, React组件))`，返回注销函数；未声明的槽直接 register 会抛错，`inject` 保证延迟到槽就绪。
- `shell.overlay` 是 list 槽（全屏浮层）；配套 `sidebar.footer.action`（组件收 `{wide}` props）作开关按钮——官方 dsh-web-files 的标准模式。
- React 18 + CSS Modules（lightningcss 编译内联）+ `--dsw-alias-*` design tokens（明暗两套，皮肤可整体换）+ `data-dsh-plugin` 语义属性；现成组件：`dsh-client-ui-primitives`（Button/Modal/Switch/图标）。
- 浏览器纯度门：`@deepseek-ai/*` 仅平台白名单可值导入（react、react-dom、@deepseek-ai/cordis、zod、dsh-client-store、dsh-client-ui-slots、dsh-client-ui-primitives、dsh-client-ui-dockkit 等）。

### 0.4 插件生命周期与 DI（`_ref/dsh-plugin-starter` + provider-proxy）

- 插件导出 `name` / `inject`（必需服务数组）/ `Config`（schemastery schema）/ `apply(ctx, config)`。
- 可选服务用 `ctx.get('xxx')` 探测，不进 `inject`（缺服务不阻断挂载）。
- **注册即效果**：一切 `register()` 的返回值都是 disposer；`apply` 返回清理函数，或用 `ctx.effect(() => cleanup)`。
- 配置热更新：schema 字段标 `.volatile()` → 设置页可编辑、写入运行中 fiber 的 live 引用并发 `loader/volatile-update` 事件；非 volatile 字段变更则整行重载（重跑 apply）。
- provider（endpoint/api_key）由 harness **settings 服务**管理（BFF：`settings/describe`、`settings/mutate`；枚举：`llm/listConfigurableProviders`、`llm/discoverModels`、`session/modelCatalog`）。

---

## 1. 总体架构

```
┌───────────────────────────────  DSH 宿主进程 (Node)  ───────────────────────────────┐
│                                                                                     │
│   agent loop / 子代理 / one-shot                                                     │
│        │ llm.prepareCall({provider, model}).stream(request)                          │
│        ▼                                                                            │
│   ┌─────────────────────────────────────────────────────────────┐                   │
│   │ L1 路由决策层  ctx.on('llm/stream', waterfall)               │                   │
│   │  · 观测 {provider, model, messages 特征, callerHint}         │                   │
│   │  · TaskClassifier → 模式化选路 → 候选链                       │                   │
│   │  · 就地改写目标 / 失败容灾换模（M0 探针定稿）                   │                   │
│   │  · ALS 标记调用归属；包装 stream 观测 usage/首字延迟/错误        │                   │
│   └──────────────┬──────────────────────────────────────────────┘                   │
│                  ▼                                                                  │
│   ┌─────────────────────────────────────────────────────────────┐                   │
│   │ L2 请求改写层  undici RoutingDispatcher（全局替换，可恢复）      │                   │
│   │  · 按 (provider, model) 注入鉴权头 / 走代理（availability）     │                   │
│   │  · 同协议镜像端点改写（cc-switch 式，兜底）                      │                   │
│   └──────────────┬──────────────────────────────────────────────┘                   │
│                  ▼                                                                  │
│   ┌─────────────────────────────────────────────────────────────┐                   │
│   │ L3 观测台账层  UsageLedger + HealthState + RouteJournal       │                   │
│   │  · session/event 双通道 + 流 chunk 直观测（覆盖 one-shot）      │                   │
│   │  · 日→provider→model 折叠；成本估算；熔断状态机；路由日志         │                   │
│   └──────────────┬──────────────────────────────────────────────┘                   │
│                  │ ctx.webServer.register('/api/umbra-budget/*') + SSE              │
└──────────────────┼──────────────────────────────────────────────────────────────────┘
                   ▼  同源 loopback HTTP
┌─────────────────────────────  浏览器 GUI (client 半区)  ──────────────────────────────┐
│  sidebar.footer.action 开关按钮 → shell.overlay 全屏控制台                            │
│  ├─ 模式切换栏（极致便宜 / 效率优先 / 最强火力）                                        │
│  ├─ 模型阵列网格（标签·状态·今日 Token·预估成本）                                       │
│  ├─ 路由监控图（实时流向 + 缓存命中率）                                                 │
│  └─ 代理协作视图（子代理 ↔ 模型映射）                                                   │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

**双半区包结构**（照官方 dsh.bundle 模板）：

```
packages/dsh-umbra-budget/
├── cordis.patch.yml            # - insert: - id: umbra-budget, name: dsh-umbra-budget
├── package.json                # dsh.bundle.patch + dsh.client{inject,platform:"web"}
├── src/
│   ├── index.ts                # host 半区：apply / Config / 三层引擎装配
│   ├── client/
│   │   └── index.tsx           # browser 半区：槽位注册 + 控制台 UI
│   └── core/                   # 两侧共享纯逻辑（类型、模式定义、标签工具）
│       ├── types.ts            # 全部接口定义（§4）
│       ├── pool-schema.ts      # model_pool.yaml zod schema
│       └── modes.ts            # 三模式的排序纯函数
├── model_pool.example.yaml
└── docs/
```

---

## 2. model_pool.yaml 完整 Schema

存放位置：`$DSH_HOME/umbra-budget/model_pool.yaml`（路径可由插件 config `poolPath` 覆盖）；`fs.watch` + 500ms debounce 热重载；校验失败**整体拒绝、保留旧池**（provider-proxy 的 fail-closed 语义）。

```yaml
# ====================================================================
# dsh-umbra-budget · 模型矩阵定义
# 每个条目 = 矩阵中的一个"矩阵单元"（逻辑模型）
# ====================================================================
version: 1

# ---- 全局默认（可被每个模型覆盖）----
defaults:
  cost_level: medium          # high | medium | low | free
  availability: direct        # direct | proxy
  enabled: true

providers:
  # provider_name 必须与 DSH 设置里的 provider 路由名一致
  # （DSH 侧已配 endpoint + api_key；本文件专注"矩阵元数据"）
  deepseek:
    display_name: DeepSeek 官方
    # ---- B 轨：自由接入 OpenAI 兼容端点（可选，见 §6.3）----
    # endpoint: https://api.deepseek.com/v1
    # api_key_ref: DEEPSEEK_API_KEY        # 环境变量名，避免明文
    # auth_style: bearer                   # bearer | x-api-key | custom
    models:
      deepseek-chat:
        tags:
          capabilities: [coding, fast, agent]   # coding|reasoning|vision|fast|agent|long_context|tool_use
          cost_level: low
          context_window: 131072
          availability: direct
        pricing:                                 # 每百万 token 单价，货币单位 currency
          currency: CNY
          input: 2.0
          output: 8.0
          cache_read: 0.5
          cache_write: 2.0
        role: general                            # general | judge | embed（预留）
      deepseek-reasoner:
        tags:
          capabilities: [reasoning, coding, agent]
          cost_level: medium
          context_window: 131072
        pricing: { currency: CNY, input: 4.0, output: 16.0 }

  glm:
    display_name: 智谱 GLM（镜像）
    models:
      glm-4.7-flash:
        tags:
          capabilities: [fast, agent, tool_use]
          cost_level: free
          context_window: 128000

  claude-via-proxy:
    display_name: Claude（需代理）
    models:
      claude-sonnet-4-5:
        tags:
          capabilities: [coding, reasoning, vision, agent, long_context, tool_use]
          cost_level: high
          context_window: 200000
          availability: proxy          # 走 L2 dispatcher 的代理规则
        proxy: http://127.0.0.1:7890   # 该模型专属出站代理
        headers:                       # 该模型专属注入头
          x-api-key-source: mirror-a

# ---- 路由策略 ----
routing:
  mode: frugal                  # frugal | efficiency | max_power（运行时可被 UI/config 覆盖）
  classifier:
    trivial_max_chars: 2000     # ≤ 此长度且无工具 → trivial
    heavy_min_chars: 60000      # ≥ 此长度或 reasoningEffort=high → heavy
    heavy_tools: true           # 携带工具定义默认升为 heavy？
  fallback:
    max_retries: 2              # 首 chunk 前失败的最大换模次数
    cooldown_ms: 30000          # 熔断冷却
    rate_limit_429_ms: 60000    # 429 专属冷却
  scatter:
    efficiency_min_inflight: 2  # 同模型在途 ≥2 时开始打散（idea_swarm 4 代理场景）
  cache:
    exact_match: false          # 本地精确响应缓存（trivial 任务专用，默认关）
```

**字段语义总表**：

| 字段 | 必填 | 说明 |
|---|---|---|
| `provider_name`（key） | ✅ | 与 DSH provider 路由名一致；路由改写目标 = `(provider, model)` |
| `models.<id>.tags.capabilities` | ✅ | 能力集，路由匹配的**主键**；含 `fast` 的模型参与效率模式打散 |
| `tags.cost_level` | ⬜（默认 medium） | 极致便宜模式的主排序键 |
| `tags.context_window` | ✅ | 长上下文任务降级判定依据 |
| `tags.availability` | ⬜（默认 direct） | `proxy` 时走 L2 的该模型专属代理 |
| `pricing.*` | ⬜ | 预估成本；缺省则该模型不参与成本统计 |
| `endpoint` / `api_key_ref` | ⬜ | 仅 B 轨自由接入；`api_key_ref` 指 env，永不明文落盘 |
| `headers` / `proxy` | ⬜ | L2 dispatcher 的注入头 / 专属出站代理 |

---

## 3. TypeScript 接口定义（`src/core/types.ts` 草案）

```ts
// ==================================================================
// 标签体系
// ==================================================================
export type Capability =
  | 'coding' | 'reasoning' | 'vision' | 'fast'
  | 'agent' | 'long_context' | 'tool_use'

export type CostLevel = 'free' | 'low' | 'medium' | 'high'
export type Availability = 'direct' | 'proxy'
export type ScheduleMode = 'frugal' | 'efficiency' | 'max_power'

export interface ModelTags {
  readonly capabilities: readonly Capability[]
  readonly cost_level: CostLevel
  readonly context_window: number
  readonly availability: Availability
}

export interface ModelPricing {
  readonly currency: string          // 'CNY' | 'USD' | ...
  readonly input: number             // 每百万 token
  readonly output: number
  readonly cache_read?: number
  readonly cache_write?: number
}

// ==================================================================
// 模型池（model_pool.yaml 的运行时形态）
// ==================================================================
export interface PoolModel {
  /** 逻辑 id：`${provider}/${model}`，如 `deepseek/deepseek-chat` */
  readonly id: string
  readonly provider: string          // DSH provider 路由名
  readonly model: string             // 原始模型 id
  readonly tags: ModelTags
  readonly pricing?: ModelPricing
  readonly enabled: boolean
  readonly proxy?: string            // 专属出站代理 URL
  readonly headers?: Readonly<Record<string, string>>
}

export interface ModelPool {
  readonly version: 1
  readonly providers: ReadonlyMap<string, PoolProviderMeta>
  readonly models: readonly PoolModel[]          // 展平后的矩阵
  readonly routing: RoutingPolicy
}

// ==================================================================
// 任务分类
// ==================================================================
export type TaskClass = 'trivial' | 'standard' | 'heavy'

/** waterfall 时刻可观测的请求特征（全部 O(1) 提取，不做深度扫描） */
export interface RequestFingerprint {
  readonly messageCount: number
  readonly totalChars: number        // 所有文本段长度求和
  readonly hasTools: boolean
  readonly reasoningEffort?: string
  readonly requestedProvider?: string
  readonly requestedModel?: string
  /** 调用方提示：子代理名 / one-shot 特征（M0 探针确认可得性） */
  readonly callerHint?: string
}

export interface TaskProfile {
  readonly taskClass: TaskClass
  readonly requiredCapabilities: ReadonlySet<Capability>
  /** 需要的上下文窗口下限（按 totalChars×系数 + 输出余量估算） */
  readonly minContextWindow: number
}

// ==================================================================
// 健康状态与容灾
// ==================================================================
export type HealthStatus = 'healthy' | 'cooling' | 'disabled'

export interface HealthState {
  readonly status: HealthStatus
  readonly failures: number          // 连续失败计数
  readonly coolUntil: number         // epoch ms；0 = 未熔断
  readonly inFlight: number          // 当前在途请求数（打散依据）
  readonly ewmaTtfbMs: number        // 首 chunk 指数加权平均
  readonly lastError?: string
}

export type FailureKind =
  | 'rate_limited' | 'auth' | 'server' | 'network'
  | 'timeout' | 'context_overflow' | 'unknown'

export interface RouteCandidate {
  readonly modelId: string           // PoolModel.id
  readonly score: number             // 模式内排序分
}

/** 一次完整选路的决策记录（喂 UI 路由监控图 + RouteJournal） */
export interface RouteDecision {
  readonly ts: number
  readonly mode: ScheduleMode
  readonly taskProfile: TaskProfile
  readonly chain: readonly RouteCandidate[]   // 完整候选链
  readonly chosen: string           // 实际首发的 modelId
  readonly finalModel?: string      // 容灾换模后的最终 modelId
  readonly fallbackOf?: string      // 从哪个模型换过来的
  readonly reason: string           // 人读决策理由（UI 悬浮展示）
}

// ==================================================================
// 用量台账
// ==================================================================
export interface UsageTotals {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  calls: number
  estimatedCost: number             // 按 pricing 折算，本币种
}

/** 台账键：本地日 → provider → model；另挂 agent 维度（dsh-usage 没有的） */
export interface LedgerDay {
  readonly day: string              // 'YYYY-MM-DD' 本地时区
  readonly byModel: Map<string, UsageTotals>
  readonly byAgent: Map<string, UsageTotals>   // 主会话 / 子代理名
}

/** 一次路由监控事件（SSE 帧载荷） */
export interface RouteEventFrame {
  readonly rev: number              // 幂等序号
  readonly kind: 'dispatch' | 'fallback' | 'cooldown' | 'recovery' | 'usage'
  readonly decision?: RouteDecision
  readonly modelId?: string
  readonly usage?: UsageTotals
}

// ==================================================================
// 缓存命中率
// ==================================================================
export interface CacheStats {
  /** provider 侧 prompt cache 命中率 = cacheRead / (input+cacheRead+cacheWrite) */
  readonly promptHitRate: number
  /** 本地精确缓存（可选开启） */
  readonly localHits: number
  readonly localMisses: number
}

// ==================================================================
// 宿主服务面（HTTP API）
// ==================================================================
export interface UmbraOverview {
  readonly mode: ScheduleMode
  readonly pool: readonly {
    model: PoolModel
    health: HealthState
    today: UsageTotals
  }[]
  readonly today: UsageTotals
  readonly cache: CacheStats
  readonly recentRoutes: readonly RouteDecision[]   // 最近 50 条
  readonly agents: readonly { agent: string; modelId: string; since: number }[]
}
```

---

## 4. 路由引擎：三模式与容灾

### 4.1 选路管线（纯函数，可单测）

```
RequestFingerprint ──classify──▶ TaskProfile ──select(mode, pool, health)──▶ 候选链
                                                                              │
                                    首个 healthy 候选 ◀───────────────────────┘
```

**分类器**（正则级 O(1)，符合「极致便宜」的自我要求——分类本身绝不调用 LLM）：

- `heavy`：`totalChars ≥ heavy_min_chars`，或 `hasTools && routing.classifier.heavy_tools`，或 `reasoningEffort ∈ {high}`；
- `trivial`：`totalChars ≤ trivial_max_chars && !hasTools`；
- `standard`：其余。
- requiredCapabilities 推导：`totalChars×4 > min(便宜模型窗口)` → 追加 `long_context`；`hasTools` → 追加 `tool_use`；等等。

**三模式排序函数**（对同一候选集给出不同 order）：

| 模式 | 排序规则 |
|---|---|
| `frugal` 极致便宜 | `cost_level: free → low → medium → high` 主排序；同价内 capabilities 覆盖数多者优先。heavy/trivial 降级规则：候选集为空（能力/窗口不满足）才允许更贵层级进入 |
| `efficiency` 效率优先 | `tags.fast` 者优先；`inFlight ≥ scatter 阈值` 的模型降权，把高并发请求（idea_swarm 4 代理）打散到同能力集的不同模型上（least-in-flight 次序），规避单 API 429 |
| `max_power` 最强火力 | capabilities 覆盖数 + context_window + cost_level 加权倒序，最顶配优先 |

三个函数都是 `core/modes.ts` 的纯函数：`(candidates: PoolModel[], profile: TaskProfile, health: ReadonlyMap<string, HealthState>, policy) => RouteCandidate[]`。

### 4.2 动态容灾（Fallback）

- **失败捕获点**：waterfall 包装层。流在**产出第一个内容 chunk 之前**失败（连接错误 / 429 / 5xx / 超时）→ 透明换模重试，用户无感；**已产出内容后**失败 → 不吞错，标记健康度后原样上抛（避免内容重复/错乱）。
- **健康状态机**：连续失败 → `cooling`（`cooldown_ms`）；429 专属冷却（尽量读 Retry-After）；冷却到期自动 `half-open` 放行一次探测请求，成功即恢复 `healthy`。
- **换模选择**：从候选链取下一个 `healthy` 且满足 `requiredCapabilities`/`minContextWindow` 的模型；换模动作写入 `RouteDecision.fallbackOf` 并 SSE 推送 `fallback` 帧。
- **换模执行**：经**捕获的原始 dispatch 通道**重新发起（携带 ALS 防重入标记，防止换模请求再次进入本插件路由逻辑造成死循环）。

### 4.3 高并发打散

per-model `inFlight` 计数（ALS 包装的 try/finally 维护）。`efficiency` 模式下，同一模型在途请求 ≥ 阈值时，候选排序自动偏向同能力集的低负载模型——4 个子代理并发时天然散开。

---

## 5. 用量台账与成本

- **双通道观测**：
  1. `ctx.on('session/event')`：`request/header` 归因会话→(provider, model)；`assistant/message` 取 `TokenUsage`（与 dsh-usage 同源，不冲突）；
  2. **waterfall 流 chunk 直观测** `{type:'usage'}`：覆盖 one-shot 直调（dsh-usage 的盲区），以流观测为主、session 事件为归因辅助。
- 折叠键：`日 → provider/model → UsageTotals`；另维护 `日 → agent → UsageTotals`（主会话 / 各子代理，来源 `subagent/catalog` + 会话归因），实现「代理协作视图」的用量归属。
- 成本：`pricing` 表按 billed input（input+cacheRead+cacheWrite）/ output 分列计价；多币种分开统计不混算。
- 落盘：`$DSH_HOME/umbra-budget/ledger.json`，3s debounce + 临时文件 fsync rename 原子写，默认保留 90 天。
- 缓存命中率主指标 = `cacheReadTokens / (input+cacheRead+cacheWrite)`（provider 侧 prompt cache）；本地精确响应缓存（trivial 任务，(system+messages) hash → LRU）默认关闭、可开。

---

## 6. 拦截层设计

### 6.1 L1 — waterfall 路由层（`ctx.on('llm/stream')`）

```
(options, next) =>
  1. fingerprint = 提取 {provider, model, messages 特征}（只读，深冻结安全）
  2. decision = Router.route(fingerprint)          // 纯函数 + 健康态
  3. [若改写生效] 就地改写 options.provider/model → 矩阵目标
  4. stream = next()
  5. return wrap(stream):
       · 首内容 chunk 前失败 → 容灾换模（§4.2）
       · ALS.run({modelId, ...}) 包住每次 pull → L2 可读
       · 观测 usage chunk / ttfb / finish → L3
```

### 6.2 L2 — undici RoutingDispatcher（照 provider-proxy 模式）

- `apply` 时 `getGlobalDispatcher()` 捕获 → `setGlobalDispatcher(RoutingDispatcher)`；`ctx.effect` 恢复并 close 自有 Pool/ProxyAgent。
- ALS 读出本次请求的矩阵模型 → 按 PoolModel 条目：注入 `headers`、`proxy` 走专属 ProxyAgent、（B 轨镜像场景）改写 origin。
- loopback 恒直连；per-origin 连接池缓存；配置变更 `prune()` 失效代理。
- **职责边界**：L2 不做模型选择，只做「选中模型的传输整形」。

### 6.3 矩阵接入的双轨制（重要设计决策）

OpenAI 兼容协议 ≠ 万能：请求体格式由 harness 的 **adapter 层**按 provider 协议生成，因此 dispatcher 级改写 origin 只适用于**同协议镜像**。矩阵接入走双轨：

- **A 轨（主道，零协议风险）**：每个矩阵成员先在 DSH 设置里注册为 provider（endpoint + api_key 一次性手工配置）→ `model_pool.yaml` 只负责打标签 + 策略。路由 = 改写 `{provider, model}` 二元组。
- **B 轨（自动接入，尽力而为）**：`model_pool.yaml` 带 `endpoint`/`api_key_ref` 的条目，插件启动时探测宿主 settings 服务 face 是否可编程写入（`ctx.get('settings')` 能力探测，M0 探针）；成功 → 自动注册 provider 并跳过重复项；失败 → UI 模型卡片显示「待接入」状态并给出手工配置指引，**绝不阻断**。

### 6.4 M0 探针：结论与双后端自适应（已交付）

**探针已实现**：[`probes/m0-rewrite-probe`](../probes/m0-rewrite-probe)（零构建纯 JS + 4 场景契约测试全绿 + 运行手册）。它用四种自调用（公开 `llm.stream` 路径 / `prepareCall` 路径 / 不存在的 provider / 二次 `next()` 实验）+ 自带 undici 观察器，把真实宿主的改写语义写进 `$DSH_HOME/umbra-probe/report.json`。

**比"先探针后定稿"更进一步：主插件把验证内建为运行时能力，三语义全覆盖、无需一次性定稿**：

| 真实宿主语义 | 探针判定 `rewriteBackend` | 主插件行为 |
|---|---|---|
| options 可变，改写流动 | `waterfall` | L1 就地改写 `(provider, model)`，adapter 按矩阵目标出站；dispatcher 观测到 `flow-ok` |
| options 深冻结，赋值抛 TypeError | `dispatcher` | L1 捕获异常 → 不改写；**L2 dispatcher 强制改写** origin/鉴权头/body.model（B 轨）——端到端测试证明请求被改到矩阵目标 |
| options 被运行时克隆（静默丢失，最危险） | `inconclusive` | 同上，按不可改写处理；dispatcher 观测到 `rewrite-ignored` 计数，UI 显示后端为 `dispatcher` |

关键工程事实（`host-e2e.test.ts` 验证）：
- **A 轨**（DSH 原生 provider）：瀑布改写生效时零 dispatcher 干预；被忽略时该请求按原目标出站——路由日志诚实标注，不谎报。
- **B 轨**（yaml 直带 endpoint）：**dispatcher 是确定性强制层**，无论瀑布语义如何都把请求改到池条目的 endpoint + 注入 `api_key_ref` 解析出的鉴权头 + 换掉 body.model（OpenAI 兼容操作路径白名单，其余路径拒绝改写，fail-closed）。
- **主动验证**：控制台 `POST /api/umbra-budget/verify` 发起一次廉价探测调用，对比 dispatcher 观测前后计数，把 `waterfall / dispatcher / mixed` 写进 runtime-state 并在面板展示。
- **fail-open**：矩阵无合格候选（未配置/全冷却/能力不满足）→ 按原请求直连并如实记账，宿主永不中断。

---

## 7. UI 控制台（client 半区）

**入口**：`sidebar.footer.action` 注册开关按钮（`{wide}` 响应式图标）→ 切换 `shell.overlay` 全屏面板（dsh-web-files 同款模式）。

```
┌─ UMBRA BUDGET ────────────────────────────────────────────────────┐
│  [◆ 极致便宜]  [⚡ 效率优先]  [🔥 最强火力]        今日 ¥12.40 · 3.2M tok │
├───────────────────────────────────────────────────────────────────┤
│  模型阵列（网格卡片）                                                │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐                 │
│  │ deepseek-chat │ │ glm-4.7-flash│ │ claude-4.5   │                 │
│  │ ●活跃  low    │ │ ●活跃  free  │ │ ⚠冷却  high  │                 │
│  │ 1.2M tok ¥3.1 │ │ 0.8M tok ¥0  │ │ 0.1M tok ¥8.2│                 │
│  │ [coding fast] │ │ [fast agent] │ │ [coding vis…]│                 │
│  └──────────────┘ └──────────────┘ └──────────────┘                 │
├───────────────────────────────────────────────────────────────────┤
│  路由监控（实时 SSE）                    缓存命中 34%                  │
│  14:02:11  主会话 ─→ deepseek/deepseek-chat   (frugal, standard)    │
│  14:02:09  idea_swarm#2 ─→ glm/glm-4.7-flash  (efficiency, 打散)    │
│  14:01:58  ⚠ claude-4.5 429 → 换模 deepseek-reasoner               │
├───────────────────────────────────────────────────────────────────┤
│  代理协作： visual_agent→glm-4.7-flash · analysis→deepseek-chat · …  │
└───────────────────────────────────────────────────────────────────┘
```

- 四区块全部组件化；模式切换 POST 回宿主并同步写 volatile config（重启保活）。
- 数据通道：`GET /api/umbra-budget/overview` 10s 轮询（模型卡片/汇总）+ `GET /api/umbra-budget/events` SSE 实时帧（路由监控/换模事件，rev 幂等 + onopen 再同步）。
- 样式：CSS Modules + `--dsw-alias-*` tokens（自动跟随明暗主题与皮肤），根容器打 `data-dsh-plugin="umbra-budget"`。

### 宿主 HTTP API（全部经 loopback 栅栏）

| 路由 | 方法 | 用途 |
|---|---|---|
| `/api/umbra-budget/overview` | GET | 总览（池卡片 + 健康 + 今日 + 最近路由 + 代理映射） |
| `/api/umbra-budget/events` | GET (SSE) | 实时路由/换模/用量帧 |
| `/api/umbra-budget/mode` | POST | 切换调度模式 |
| `/api/umbra-budget/models/:id/enabled` | POST | 启用/禁用矩阵单元 |

---

## 8. 工程规范

- **TypeScript 严格模式**（`strict: true`，`noUncheckedIndexedAccess`）；client 半区禁 `any` 出平台白名单边界。
- **资源清理**：所有 register 返回的 disposer 收进 `ctx.effect`；dispatcher 恢复、fs.watch 关闭、SSE 客户端断开、定时器清除，一概在 effect 内完成。
- **异步非阻塞**：所有 IO（台账落盘、yaml 读取、健康探测、HTTP 路由 handler）async；台账写用 debounce + 原子替换；绝不同步 fs。
- **fail-closed 配置**：yaml 校验失败整体拒绝、保留旧池、写 `state.json` 诊断（Desktop 无 stdout）。
- **防重入**：路由器自带 ALS 标记，换模重试与内部探测调用不二次路由。
- **纯逻辑与宿主解耦**：`core/` 不 import 任何 `@deepseek-ai/*` 值（类型除外），全部可 node:test 单测（分类器、三模式排序、健康状态机、台账折叠）。

---

## 9. 里程碑（全部完成）

| 里程碑 | 内容 | 状态 |
|---|---|---|
| **M0 探针** | 四个探针 + 三语义契约测试 + 运行手册 | ✅ `probes/m0-rewrite-probe`（4/4 绿） |
| M1 池与台账 | model_pool.yaml 加载/校验/热重载 + 台账 + 流观测 | ✅ `src/core/*`（45 测试绿） |
| M2 路由引擎 | 三模式 + 分类器 + 容灾状态机 + ALS/dispatcher 装配 | ✅ `src/host/router.ts` + `dispatcher.ts`（e2e 5/5 绿） |
| M3 API 面 | HTTP 路由 + SSE + 台账落盘 + runtime-state | ✅ `src/host/routes.ts` + `persistence.ts`（7/7 绿） |
| M4 控制台 UI | client 半区四区块 + footer 开关 + 样式注入 | ✅ `src/client/*` |
| M5 打磨 | 类型检查、构建、文档、示例矩阵 | ✅ tsc strict 0 错误 · tsdown 双产物 · 57/57 测试 |

## 10. 交付物清单

```
DSH-Umbra-Budget/
├── docs/ARCHITECTURE.md            本文档
├── probes/m0-rewrite-probe/        M0 改写语义探针（index.js + 契约测试 + 运行手册）
└── packages/dsh-umbra-budget/      主插件（可安装目录）
    ├── cordis.patch.yml            bundle patch（- insert: umbra-budget）
    ├── package.json                dsh.bundle.patch + dsh.client manifest
    ├── tsconfig.json / tsdown.config.ts
    ├── model_pool.example.yaml     矩阵示例（首次启动自动播种）
    ├── src/core/                   纯逻辑 8 模块（零 DSH 依赖，全量单测）
    │   ├── types.ts pool.ts classify.ts modes.ts
    │   ├── health.ts ledger.ts reroute.ts keys.ts
    ├── src/host/                   宿主半区
    │   ├── index.ts config.ts      装配 + schemastery volatile 配置
    │   ├── router.ts               FailoverStream 容灾循环 + waterfall 监听器
    │   ├── dispatcher.ts           undici 全局 dispatcher（B 轨强制 + 观测）
    │   ├── journal.ts signals.ts frames.ts stream-wrap.ts wire.ts store.ts
    │   ├── pool-file.ts persistence.ts routes.ts dsh-face.ts
    ├── src/client/                 浏览器半区
    │   ├── index.ts                槽位注册（shell.overlay + sidebar.footer.action）
    │   ├── Console.tsx FooterButton.tsx api.ts
    │   ├── console-css.ts console-classes.ts console-open.ts dsh-face.ts
    ├── tests/                      57 项 node:test（core 45 + host e2e 5 + shell 7）
    └── lib/                        tsdown 产物（index.js ESM + client.js ModuleLoader 闭包）
```

## 11. 剩余注意事项（真实 DSH 上的首次运行）

1. **跑一次 M0 探针**（scratch profile）拿到真实宿主的改写语义报告——主插件不依赖它也能工作（双后端自适应），但报告能确证 `prepareCall` 路径的瀑布行为（P1-B）与 `session/event` 事件族形状（P2），有助于把「代理协作视图」的归属做准。
2. **settings 服务编程写入（B 轨自动注册）**：主插件启动时已静默探测 settings 服务面（方法名写入 `$DSH_HOME/umbra-budget/state.json` 的 `settingsFace` 字段）——待真实宿主上确认 face 可写后，可作为后续增强把池条目自动注册为原生 provider；当前 B 轨由 dispatcher 层强制，功能不受损。
3. `session/event` 的 `assistant/message` usage 折叠目前以瀑布流观测为准（已覆盖 one-shot）；session 事件归因仅用于代理协作视图。
4. **本地精确响应缓存已实现**（`routing.cache.exact_match`，默认关闭）：trivial 调用按 SHA-256(prompt) 精确缓存，命中零出站零计费；LRU(500)+TTL(1h)+体积护栏；UI 显示本地缓存命中计数。prompt cache 命中率统计始终可用。
