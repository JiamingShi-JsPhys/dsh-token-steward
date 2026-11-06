# dsh-umbra-budget · 架构设计（阶段一输出）

> 证据来自 DeepSeek Harness 生态参考源码（`dsh-provider-proxy`、`dsh-usage`、`dsh-client-ui-pet`，均可在 GitHub 与 npm 检索）与本机已安装插件，逐条标出处。

## 0. 一个必须先纠正的前提

原始指令写「重点看如何拦截 `globalThis.fetch`」。**这条路不通**，参考源码自己写了原因：

> Model-facing SDKs capture `fetch` at client construction and adapters cache those clients across requests, so wrapping `fetch` is unreliable after the first call. The undici global dispatcher is resolved per request and cannot be captured early, which makes it the only sound interception point.
> — 生态插件 `dsh-provider-proxy` 架构文档「Why not `globalThis.fetch`」（github.com/apolenkov/dsh-provider-proxy）

同时 `llm/stream` 的 options 是深冻结的：

> Loop-built requests arrive deep-frozen; extensions and adapters may read them but must not rewrite them.
> — 同上「Why not put the model id in `GenerateOptions`」

所以「改写请求体 + 重试 + 降级 + 子代理并发打散」这四件事，只有**本地网关**这一层能全做到。下面的方案按这个前提设计。

## 1. 三层结构

```
┌─────────────────────────────────────────────────────────────┐
│ DSH Host 进程                                                │
│                                                              │
│  agent loop / subagent ──► ctx.llm ──► llm-pi-ai 适配器      │
│                                        │ baseURL 指向 ↓      │
│                              ┌─────────▼──────────┐          │
│                              │ Umbra 网关         │ 127.0.0.1 │
│                              │ /v1/chat/completions│ 随机端口  │
│                              └─────────┬──────────┘          │
│                                        │ 路由引擎 + 健康状态机 │
│  umbra-budget host 插件 ───────────────┘                     │
│    · 读 model_pool.yaml（fs.watch 热重载）                    │
│    · RouterEngine.plan/report（纯逻辑，可单测）               │
│    · 计量台账 + HTTP 路由 api/umbra-budget/*                  │
└─────────────────────────────────────────────────────────────┘
                          ▲ 同源 JSON
┌─────────────────────────┴───────────────────────────────────┐
│ 浏览器 client 半区：悬浮球 + 展开面板 + 设置页               │
└─────────────────────────────────────────────────────────────┘
```

### 为什么网关而不是拦截 fetch

| 需求 | fetch 拦截 | undici dispatcher | `agent/request` 瀑布 | 本地网关 |
|---|---|---|---|---|
| 改写请求体（换模型 id） | 可以但会漏 | 不能 | **不能**（深冻结） | 可以 |
| 读响应体 429 细节并降级重试 | 半可行 | 不能（已 commit） | 不能 | 可以 |
| 并发打散到多个上游 | 不能（同一次调用） | 不能 | 不能 | 可以 |
| 按 agent 身份钉模型 | 无身份 | ALS 可带 | **有 agent 身份** | 需上游透传 |
| 覆盖 subagent 与后台单次调用 | 可以 | 可以 | 只覆盖 agent 循环 | 可以（都是 HTTP） |

结论：**网关是执行层，`agent/request` 是可选的身份注入层**（阶段二接），`undici` dispatcher 负责 `proxy_url` 出站。

## 2. 虚拟模型 id（网关如何被 DSH 使用）

网关对宿主暴露成**一个** OpenAI 兼容 provider（`umbra`），模型 id 用两段式命名：

```
umbra:auto               ← 按当前全局模式自动选路（默认，UI 切换模式即切它）
umbra:frugal             ← 钉死极致便宜
umbra:efficiency         ← 钉死效率优先
umbra:max_power          ← 钉死最强火力
umbra:alias/<name>       ← YAML 里 routing.aliases 的自定义意图，如 umbra:alias/analysis
umbra:pin/<provider>/<model>  ← 直通某具体模型（逃生门，仍走熔断与计量）
```

这样 profile 里只需要一行配置；同时保留「想钉就钉」的能力：

```yaml
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      umbra:
        displayName: Umbra Matrix
        api: openai-completions
        apiKeyEnv: UMBRA_LOCAL_TOKEN      # 网关自己签发的 loopback 令牌
        baseURL: http://127.0.0.1:<port>/v1
        models:
          - { id: 'umbra:auto', name: 'Umbra Auto' }
          - { id: 'umbra:frugal', name: 'Umbra Frugal' }
          - { id: 'umbra:efficiency', name: 'Umbra Efficiency' }
          - { id: 'umbra:max_power', name: 'Umbra Max Power' }
```

> **待验证 T1**：`llm-pi-ai` 是否接受含 `:` 的模型 id。若拒绝，退回下划线分段（`umbra__auto`）。一条 curl 探针即可定论。

## 3. 配置层：`model_pool.yaml`

完整示例见 `model_pool.example.yaml`，TypeScript 契约见 `src/core/types.ts`。设计要点：

1. **三层结构**：`defaults`（超时/重试/熔断）→ `routing`（模式与别名）→ `providers[]`（端点和模型）。
2. **凭据不落磁盘明文**：`api_key` 支持 `env:NAME` / `file:/abs/path` / `literal:xxx`，展开后的明文只在内存，永不进日志、快照或过线 JSON。
3. **标签即路由契约**：`capabilities` 是硬过滤（请求要求的标签必须是它的子集），`cost_level` / `quality_rank` / `max_concurrency` 是打分输入。
4. **`availability` 三态**：`direct` / `proxy` / `offline`；`proxy` 必填 `proxy_url`（undici ProxyAgent），`offline` 是用户手动的「别用它」。
5. **计价可选**：没有 `pricing` 就是「未定价」，面板显示 `—` 而不是假 0——这比编一个数更诚实。
6. **整份失败即整份拒绝**：任一字段非法 → 不半应用，沿用上一次有效矩阵，并在面板顶部挂红条（照 provider-proxy 的 `rejected` 语义）。

## 4. 路由引擎

```ts
interface RouterEngine {
  plan(intent: RouteIntent, now: number): RouteDecision      // 纯函数
  report(result: AttemptResult): void                        // 只动内存状态
  setMode(mode: RoutingMode): void
  snapshot(now: number): MatrixSnapshot
}
```

### 4.1 流水线

```
intent ──► ① 硬过滤 ──► ② 打分排序 ──► ③ 取首选 + 有序降级链 ──► ④ 尝试 ──► ⑤ report
```

**① 硬过滤**（任一不满足即淘汰）
- `capabilities ⊇ intent.requiredCapabilities`
- `input_modalities ⊇ intent.requiredModalities`
- `context_window ≥ estimatedInputTokens + expectedOutputTokens`
- `availability ≠ offline`
- 健康状态允许（`open` 且未到半开时间 → 淘汰）
- `inFlight < max_concurrency`，`rpm` 滑窗未满

**② 打分**（每个模式一个 `Scorer`，这是唯一扩展点）

| 模式 | 主序 | 破平 |
|---|---|---|
| `frugal` | `cost_level`: free > low > medium > high | `quality_rank` 升序（够用就好）→ 延迟 EWMA 升序 |
| `efficiency` | 有 `fast` 标签 +∞；再按 `ewmaLatencyMs` 升序 | `inFlight` 升序（天然打散）→ `quality_rank` 降序 |
| `max_power` | `quality_rank` 降序 | `capabilities.length` 降序 → `context_window` 降序 |

每张卡都带 `reasons[]`（如 `['cost:free +1.0','quality 48','inflight 0/4']`），面板直接展示**为什么选它**，不做事后解释。

**效率模式的打散**：`intent.burstKey` 由「同毫秒批次的并发组」生成；同 burstKey 内已派出的模型会被压低优先级（不是硬排除），于是 4 个 `idea_swarm` 请求自然落到 4 个不同模型，单一 API 不触发 429。

**③ 降级链**：排序后取前 `max_attempts` 个，去掉已被本轮尝试过的。

### 4.2 容灾（动态 Fallback）

| 上游返回 | ErrorKind | 处置 |
|---|---|---|
| 429 / `rate_limit*` | `rate-limit` | 指数退避冷却（`cooldown_ms × 2^n`）**且**立即换下一个候选 |
| 5xx / `server_error` | `server` | 计一次失败，换下一个候选 |
| 连接失败 / DNS / TLS | `transport` | 计一次失败，换下一个；`proxy_url` 可达性单独记 |
| 超时 | `timeout` | 换下一个；本次尝试的令牌预算直接丢弃 |
| 401/403 | `auth` | **不重试**，该 provider 全模型标 `open`，面板红条告警 |
| 400 且含 context 超限 | `context-overflow` | 换更大窗口的候选（这是唯一「升配」的降级） |
| 首字节已发出后失败 | `committed` | **不可降级**，向客户端以 `committed-then-failed` 收口（重发会造成重复副作用） |

「相同 capabilities 的备用模型顶上」由硬过滤天然保证：候选池本来就是同能力集，降级链只是排在后面的那些。

### 4.3 健康状态机（纯函数，可单测）

```
active ──(连续失败 ≥ threshold)──► open ──(half_open_after_ms)──► half-open
  ▲                                                                  │
  └────────────(试探成功)───────────────────────────────────────────┘
  │
  └──(429)──► cooling ──(resumeAt)──► active
offline 由用户手动置位，不参与自动恢复
```

## 5. 计量

- **token 唯一真相源是 `dsh-usage` 的台账** `$DSH_HOME/dsh-usage/usage-ledger.json`（按日/按 provider/按 model，含 input/output/cacheRead/cacheWrite/reasoning 五个桶）。本机已有真实文件，不是假想。
- 本插件**另记一条路由维度台账**（谁被选中、降级几次、每模型延迟），因为 usage 台账没有「路由事件」这个概念。
- 成本 = 台账 token × YAML `pricing`；网关自己也能拿到上游 `usage` 字段，用它做实时校验（两者偏差超 5% 时面板给出提示）。
- `dsh-usage` 缺席时：面板该区块显示「计量不可用」，**不显示 0**。

## 6. Host 半区文件划分

```
src/
  index.ts                 apply(ctx, config)：Config schema、路由注册、ctx.effect 清理
  core/
    types.ts               ★ 已写：全部契约类型（过线安全）
    pool-schema.ts         YAML → PoolConfig，逐字段诊断，整份拒绝
    credentials.ts         env:/file:/literal: 展开，明文不出内存
    router.ts              RouterEngine 实现（纯函数，无 IO）
    scorers.ts             frugal / efficiency / max_power 三个 Scorer
    health.ts              状态机 + rpm 滑窗 + 并发闸门
    classify.ts            HTTP 响应 → ErrorKind
    pricing.ts             token × pricing → 货币金额
  host/
    gateway.ts             loopback HTTP 服务、上游转发、SSE 直通、降级重试
    usage-bridge.ts        读 dsh-usage 台账（可选服务，缺席即降级）
    route-ledger.ts        路由事件环形缓冲 + 持久化
    routes.ts              api/umbra-budget/{snapshot,mode,pool,route-log}
    dsh-home.ts            ┐ shared/host 同步副本
    loopback.ts            ┘
```

## 7. M0 探针（写实现前必须先跑）

| # | 假设 | 探针 | 若不成立的退路 |
|---|---|---|---|
| T1 | `llm-pi-ai` 接受含 `:` 的模型 id | 临时 profile 加一条 `umbra__auto` / `umbra:auto` 对拍 | 改下划线分段 |
| T2 | 网关可作为 `baseURL` 被 `llm-pi-ai` 使用（含流式 SSE 解析） | 起最小 echo 网关，回一段假 SSE，跑一次会话 | 改用 `llm/stream` ALS 方案（只能覆盖模型轴，功能缩水） |
| T3 | 上游 `usage` 字段在流式末尾出现（`stream_options.include_usage`） | 对每个真实上游发一次带该参数的请求 | 计量退化为按字符估 |
| T4 | `dsh-usage` 台账结构稳定 | 直接读本机现有 `usage-ledger.json` | 自建台账（会双算，需明说） |
| T5 | `ctx.webServer.register` 可注册同源路由 | 注册一条 echo 路由 curl 一次 | 面板改走已有 SSE/轮询面 |

## 8. 分阶段落地

| 阶段 | 交付 | 验收 |
|---|---|---|
| M0 | 5 个探针脚本 + 结论表 | 每条假设有真实输出佐证 |
| M1 | `pool-schema` + `router` + `health` + 单测 | 三模式打分、容灾链、熔断状态机全部有测试 |
| M2 | 网关（非流式 + 流式 + 降级） | 手动 curl 矩阵：429 打散、超时降级、commit 后失败不重发 |
| M3 | 面板（球 + 大面板 + 设置页） | 真实数据下四区块可用，主题切换不破相 |
| M4 | `agent/request` 身份注入、按 agent 钉模型、并发打散调优 | `idea_swarm` 4 代理分散到 4 模型 |

## 9. 已有的产物

- `model_pool.example.yaml` — 完整字段演示（含镜像/代理/免费模型三类真实形态）
- `src/core/types.ts` — 全部 TypeScript 契约（配置层 / 路由层 / 健康 / 计量 / 面板视图 / 网关协议）
- `docs/ui-plan.md` — Client 端组件拆分与全家桶对齐结论
