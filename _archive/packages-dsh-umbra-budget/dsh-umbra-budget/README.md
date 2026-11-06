# dsh-umbra-budget

**DSH 模型矩阵调度中枢** —— 不只是省钱工具。把顶配模型（Claude/GPT）、高性价比模型（DeepSeek/GLM）、免费源/镜像源全部接入一个矩阵，DSH 的每一次模型调用都按任务属性自动分发给最合适的模型，带动态容灾与实时控制台。

## 三种调度模式

| 模式 | 行为 |
|---|---|
| `frugal` 极致便宜 | free → low → medium → high 逐级匹配；只有能力/窗口不满足时才"降级"到更贵模型 |
| `efficiency` 效率优先 | `fast` 标签优先；同一模型在途请求 ≥ 阈值时自动把并发（如 idea_swarm 4 代理）打散到同能力集的低负载模型，规避 429 |
| `max_power` 最强火力 | 能力覆盖最全、窗口最大的模型优先 |

**动态容灾**：流式调用在产出第一个内容 chunk 之前失败（连接错误/429/5xx/超时）→ 自动换候选链中下一个健康模型重试，用户无感；已产出内容后的失败不吞错、只记健康度。连续失败触发熔断冷却（429 有 Retry-After 专属窗口），到期半开放行探测。

## 安装

```sh
dsh plugin --profile <profile> add /absolute/path/to/packages/dsh-umbra-budget
```

重启 DSH。首次启动会自动把示例矩阵播种到 `$DSH_HOME/umbra-budget/model_pool.yaml`，编辑保存即热重载。

## 配置矩阵（model_pool.yaml）

```yaml
version: 1
providers:
  deepseek:                    # A 轨：引用 DSH 设置里已配置的 provider（推荐）
    models:
      deepseek-chat:
        tags:
          capabilities: [coding, fast, agent, tool_use]
          cost_level: low
          context_window: 131072
        pricing: { currency: CNY, input: 2.0, output: 8.0 }
  school:                      # B 轨：直连任意 OpenAI 兼容端点（免费源/镜像源）
    models:
      glm-4-flash:
        tags: { capabilities: [fast, agent], cost_level: free, context_window: 128000 }
        endpoint: https://school-mirror.example/v1
        api_key_ref: env:SCHOOL_MIRROR_KEY   # 永不落明文密钥
routing:
  mode: frugal
```

完整字段说明见 [`model_pool.example.yaml`](./model_pool.example.yaml) 与[架构文档](../../docs/ARCHITECTURE.md)。

## 控制台

侧栏底部 **UMBRA** 按钮打开全屏面板：模式切换、模型阵列卡片（状态/标签/今日用量/预估成本）、实时路由监控（SSE）、代理协作视图、路由后端验证。数据接口（loopback 栅栏保护）：

- `GET /api/umbra-budget/overview` · `GET /api/umbra-budget/events` (SSE)
- `POST /api/umbra-budget/mode` · `POST /api/umbra-budget/model-toggle` · `POST /api/umbra-budget/verify`

## 工作原理（三层拦截栈）

1. **L1 路由决策**：`ctx.on('llm/stream')` 瀑布 —— 只读指纹 → O(1) 分类 → 模式化选路 → 候选链；AsyncLocalStorage 把路由归属带进每次流 pull。
2. **L2 请求改写**：undici 全局 dispatcher（provider-proxy 验证过的唯一可靠拦截点）—— B 轨端点/鉴权头/body.model 改写、per-model 代理、HTTP 状态码回传熔断器。A 轨目标在 options 可变时由瀑布就地改写 `{provider, model}`；options 深冻结时自动由 L2 强制。
3. **L3 观测台账**：流 chunk 的 usage 直接折叠（覆盖 one-shot 与子代理，补齐 dsh-usage 的盲区），日→模型→币种成本台账原子落盘 `$DSH_HOME/umbra-budget/usage-ledger.json`。

**路由后端自验证**：控制台「验证路由后端」发起一次廉价探测调用，dispatcher 侧对比"瀑布改写了什么"与"线上实际发出了什么"，无猜测地判定 `waterfall / dispatcher / mixed` 后端。矩阵无可用候选时 fail-open 按原请求直连，宿主永不中断。

## 开发

```sh
pnpm install
pnpm typecheck   # TypeScript strict（noUncheckedIndexedAccess）
pnpm test        # node:test，57 个测试（core 纯逻辑 + host 端到端契约 + 控制面）
pnpm build       # tsdown → lib/index.js (ESM) + lib/client.js (ModuleLoader 闭包)
```

M0 改写语义探针（真实 DSH 上一次性运行）：[`probes/m0-rewrite-probe`](../../probes/m0-rewrite-probe)。

## License

MIT。DeepSeek Harness 是 DeepSeek 的独立项目；本插件是社区作品，与官方无隶属关系。
