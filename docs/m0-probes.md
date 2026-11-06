# M0 探针结果（真实输出，非推演）

运行环境：Node v24.22.2 / pnpm 12.15.0 / DSH 桌面版 app.asar 182,766,714 字节。
脚本在 `probes/`，可原样复跑；`.cache/sdk/` 是从 app.asar 里抽出的只读 SDK 副本（勿提交）。

## T2 · baseURL 指向本地网关是否可行 —— **PASS**

用 pi-ai 实际依赖的 `openai` SDK（从 asar 抽出，`@earendil-works/pi-ai/dist/api/openai-completions.js` 也用它）打了真实的一发：

```
gateway listening on 127.0.0.1:61321
--- 网关实际收到 ---
method : POST
url    : /v1/chat/completions
auth   : Bearer local-token-abc
--- 客户端收到 ---
text   : "pong"
usage  : {"prompt_tokens":11,"completion_tokens":2,"total_tokens":13,"prompt_tokens_details":{"cached_tokens":4}}
```

结论：`llm-pi-ai` → `openai` SDK → `baseURL + /chat/completions` → SSE 解析，整条链路对本地网关透明。**网关方案成立。**

## T3 · 流式 usage 桶 —— **PASS**

pi-ai 在 `compat.supportsUsageInStreaming !== false` 时会自动带 `stream_options: { include_usage: true }`（`openai-completions.js:581-583`），
实测网关收到的就是这个值，且终端帧的 `usage.prompt_tokens_details.cached_tokens` 被完整解析。
`mapUsage` 把它映射成 `cacheReadTokens`（`dsh-llm-pi-ai/lib/index.js:1439-1445`）。
**计量能拿到精确的五个桶，不需要按字符估算。**

## T6 · 含冒号的虚拟模型 id —— **PASS**

```
model  : "steward:auto"   <-- 原样透传
```

依据链：pi-ai 只校验 `id.length === 0`、重复 id、以及未声明（`UNKNOWN_MODEL`），**没有任何字符集正则**
（`dsh-llm-pi-ai/lib/index.js:685-687` / `:1875`）；请求体里 `model: model.id` 逐字发出（`openai-completions.js:572`）。
所以 `steward:auto` / `steward:frugal` / `steward:pin/<provider>/<model>` 这套命名**可以直接用**，无需退回下划线。

## T4 · dsh-usage 台账结构 —— **PASS**

直接读本机 `$DSH_HOME/dsh-usage/usage-ledger.json`，结构与 `src/core/types.ts` 的 `UsageTokenTotals` 完全对应：

```json
{"version":1,"days":{"2026-10-31":{"deepseek-official":{"deepseek-flash":{
  "inputTokens":228768128,"outputTokens":723639,"cacheReadTokens":189411392,
  "cacheWriteTokens":0,"reasoningTokens":0,"calls":928,"cost":235.45091399999978}}}}}
```

注意：`cost` 已经是 CNY 且官方路由有真实定价；非官方路由 `cost: 0` 表示**未定价**，不是免费。
我们的面板必须区分这两者（显示 `—` 而不是 `¥0`）。

## T5 · 同源 HTTP 路由注册 —— **PASS（源码级）**

`@linxin666/dsh-usage/src/host/routes.ts` 的真实写法：

```ts
{ kind: 'exact', path: '/api/dsh-usage/overview', handler: async (req, res) => { ... } }
ctx.webServer.register(route)  // 返回 disposer
```

`dsh-host-webserver` README 第 59-65 行确认：`register(route)` 支持 `exact`/`prefix`，返回解除注册的函数；重复 path 被拒。
我们的 `api/token-steward/*` 直接照抄这个形状。

## T1 · pi-ai profile 形状 —— **PASS（源码级）**

`profile` schema（`dsh-llm-pi-ai/lib/index.js:1049-1062`）接受：
`apiKeyEnv`（credential-ref 角色）/ `displayName` / `api` / `baseURL` / `models[]` / `headers` / `timeoutMs` / `streamIdleTimeoutMs` …
`models[]` 条目只需要 `id`，可选 `name` / `contextWindow` / `maxTokens` / `input` / `reasoningEfforts` / `compat`。

这与 `model_pool.yaml` 的 `providers[]` **一一对应**，编译是一层直译，不需要发明注册面。

## 顺带确认的三件事

1. **YAML 解析器已随宿主发货**：asar 内有 `/dsh/node_modules/yaml` 与 `/dsh/node_modules/js-yaml`，无需自带依赖。
2. **pi-ai 的 OpenAI 兼容实现要求有 key**：README 第 254 行明写无密钥本地服务器需要一个占位凭据——所以网关必须签发本地 token 并写进 `apiKeyEnv`，不能指望匿名。
3. **`getCompat` 按 baseUrl 字符串猜供应商**（`openai-completions.js:1216-1260`），`127.0.0.1` 不命中任何特例，走通用默认值——这正是我们要的干净基线。

## 结论

网关方案的全部前提假设成立，无需备选路线。可以进入 M1（配置解析 + 路由引擎 + 健康状态机）。

## 附：`llm/stream` 瀑布形状普查（probes/m0-rewrite-probe/）

上表的探针回答了网关方案自己的假设；`m0-rewrite-probe` 是另一台独立的
一次性探针插件，回答的是**瀑布扩展缝**的事实（网关方案不依赖它，但
M4 的 `agent/request` 身份注入需要这些事实）：

- P1：`llm/stream` 监听器就地改写 `options.{provider, model}`，改动是否真正到达
  出站 HTTP（公开 `llm.stream` 路径 + `prepareCall` 路径分别验证；marker 模型
  回显三重证据）；
- P1c：宿主是否重读 `options.provider`（改写到不可能存在的 provider）；
- P2：瀑布交给插件的 payload 形状（键清单、`Object.isFrozen`、调用方字段）
  与窗口期内流动的 `session/event` 事件族——**身份注入的数据源就在这里**；
- P3：waterfall `next()` 是否可二次调用；
- P4：settings 服务面（方法名普查，决定能否编程注册 provider）。

用法：装进 scratch profile，自动执行 4 次自调用（每次 ≤8 输出 token），
读 `$DSH_HOME/steward-probe/report.json`，然后移除。三种宿主语义
（可变 / 深冻结 / 静默克隆）都有判定矩阵，4 条契约测试覆盖探针自身逻辑。
