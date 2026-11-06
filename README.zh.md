# dsh-umbra-budget · 模型矩阵调度中枢

把**任意** OpenAI 兼容的服务接进一个矩阵——官方 API、免费镜像、cc switch 转出来的
代理、贵但全能的顶配模型——然后按任务属性自动选路、失败自动换人、用量与成本一眼可见。

## 它解决什么问题

DSH 的 `llm-pi-ai` 适配器在构造 SDK 客户端时就捕获了 `fetch`，且发给它的请求体是
深冻结的（生态插件 `dsh-provider-proxy` 的架构文档有原文：github.com/apolenkov/dsh-provider-proxy）。这意味着
**插件无法可靠地改写「这次用哪个模型」**，更无法在上游 429 时换一个模型重发。

本插件因此走 HTTP 这一层：在 `127.0.0.1` 起一个 OpenAI 兼容网关，profile 里把
`llm-pi-ai` 的 `baseURL` 指过去。于是选路、降级、计量全部落在网关里，而宿主的
会话、子代理、工具调用一行都不用改。

```
agent loop / subagent ──► ctx.llm ──► llm-pi-ai ──► 127.0.0.1:<port>/v1
                                                        │
                                                  路由引擎 + 健康状态机
                                                        │
                              ┌─────────────┬───────────┴───────────┐
                          deepseek        agnes                  镜像 / 顶配
```

## 三种调度模式

| 模式 | 主序 | 破平 |
|---|---|---|
| **极致便宜** `frugal` | `cost_level`：free > low > medium > high | 延迟 → 空闲度 → 质量分 |
| **效率优先** `efficiency` | `fast` 标签 + 实测延迟 | 在飞请求数 → **同批并发打散** |
| **最强火力** `max_power` | `quality_rank` | 能力标签数量 → 上下文窗口 |

效率模式的打散是决定性的：同一批（如 `idea_swarm` 的 4 个代理同时开工）里
已被派过的模型会被压到后面，因此 4 个请求自然落到 4 个不同上游，不会一起撞 429。

## 容灾

| 上游状况 | 行为 |
|---|---|
| 429 | 指数退避冷却（上限 16 倍），本次立刻换下一个候选 |
| 连续超时 / 5xx / 传输失败 | 达到阈值熔断，到期半开试探，成功才彻底复位 |
| 401 / 403 | 一次即熔断（凭据坏了重试无意义） |
| 400 含上下文措辞 | 归类为「上下文超限」，换更大的窗口 |
| 首字节已发出后失败 | **不可降级**——重发会产生第二份副作用 |
| 全部候选失败 | 502 + 可读原因，不抛未捕获异常 |

## 本地精确缓存（可选开启）

`routing.cache.exact_match: true`（默认关闭）：同一份简单 prompt 在 TTL 内重复出现时，
直接回放上一次的响应字节——不出站、不计费，健康状态机也不收假样本。缓存键覆盖
prompt 定义性字段与虚拟 id、生效模式、流式形状，因此换模式、换流式形状天然失效。
三条硬规则：带 tools 的请求绝不缓存、超长 prompt 绝不缓存、模型被下线后其缓存条目作废。

## 计量

token 的唯一真相源是 `dsh-usage` 的按日台账；本插件另记一条**路由维度**台账
（谁被选中、降级几次、每模型延迟）。三条严谨性规则：

1. **未定价 ≠ 免费**：`model_pool.yaml` 里没写 `pricing` 的模型，成本显示 `—`，
   面板还会提示「N 个模型未定价」。
2. **混币不相加**：CNY 与 USD 同时存在时总额显示 `—`，不把 1.5 元和 2.5 美元加成 4。
3. **计量不可用就说不**：没装 `dsh-usage` 时该区块显示「计量不可用」，不是 0。

## 安装

```bash
# 1. 让 profile 依赖本包
cd ~/.dsh/profiles/desktop && pnpm add dsh-umbra-budget

# 2. 在 cordis.patch.yml 里插入本行（内容见包内 cordis.patch.yml）
```

首次启动后：

1. 编辑 `$DSH_HOME/umbra-budget/model_pool.yaml`（字段见 `model_pool.example.yaml`）；
2. 读 `$DSH_HOME/umbra-budget/gateway.json` 拿到 `baseUrl` 与 `token`；
3. 在 profile 里把 `llm-pi-ai` 指向网关：

```yaml
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      umbra:
        displayName: Umbra Matrix
        api: openai-completions
        apiKeyEnv: UMBRA_LOCAL_TOKEN      # 环境变量里放上一步的 token
        baseURL: http://127.0.0.1:<port>/v1
        models:
          - { id: 'umbra:auto', name: 'Umbra Auto' }
          - { id: 'umbra:frugal', name: 'Umbra Frugal' }
          - { id: 'umbra:efficiency', name: 'Umbra Efficiency' }
          - { id: 'umbra:max_power', name: 'Umbra Max Power' }
```

改完 profile 需要**重启 DSH 服务**才生效。

## 虚拟模型 id

| id | 含义 |
|---|---|
| `umbra:auto` | 按当前全局模式选路（面板切模式 = 切它） |
| `umbra:frugal` / `umbra:efficiency` / `umbra:max_power` | 钉死某个模式 |
| `umbra:pin/<provider>/<model>` | 直通某个具体模型（仍走熔断与计量） |
| `umbra:alias/<name>` | `routing.aliases` 里定义的自定义意图 |

也可以直接写矩阵里某个真实模型 id，网关会直通到它。

## 面板

- **悬浮球**（`shell.overlay`）：环的颜色是当前模式，角标是今日花费
  （未定价时退回 token 数，未计量时是 `—`）。点击展开，长按循环切模式。
- **展开面板**：四张数字卡（今日 token / 花费 / 缓存命中 / 降级数）、
  按成本档位分组的模型阵列、路由监控（降级链画成 `a → b`）、代理协作视图。
- **设置页**（`settings.section`）：配置文件路径与状态、网关地址与令牌一键复制、
  默认模式、台账保留天数。

收起面板或页面切到后台即停轮询，不产生后台流量。

## 安全边界

- 网关**只绑 127.0.0.1**，端口由系统分配；
- 每次启动生成随机本地令牌，客户端必须带 `Authorization: Bearer <token>`；
- 令牌写进 `gateway.json`，与模型配置同目录；
- 凭据（`api_key`）以 `env:` / `file:` / `literal:` 引用，展开后的明文**只在内存**，
  不进日志、不进快照、不进任何过线 JSON；
- 面板 API 一律拒绝非回环请求。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关闭则完全不挂载 |
| `poolPath` | `$DSH_HOME/umbra-budget/model_pool.yaml` | 矩阵配置路径 |
| `retainDays` | `180` | 路由台账保留天数 |
| `usagePollMs` | `15000` | 读 dsh-usage 台账的间隔（最小 2000） |
| `gatewayPort` | `0` | 网关端口，0 = 系统分配 |

## 产物结构

```
lib/index.js    Host 半区（ESM），由 loader 行直接加载
lib/client.js   Client 半区，window.__ModuleLoader__ 工厂形态，CSS 内联以 style 注入
src/            源码（保留，便于在 profile 里直接 link 调试）
```

## 开发

```bash
npm install
npm run build      # 产出 lib/index.js 与 lib/client.js
npm test           # 先构建，再跑全部断言（358 条，零外部服务）
npm run typecheck  # tsc --noEmit（strict + exactOptionalPropertyTypes + noUncheckedIndexedAccess）
```

`probes/` 里的 M0 探针可对真实 DSH 安装原样复跑（asar 抽取 / 网关回路 / 流式 usage 桶 /
含冒号的模型 id）；`probes/m0-rewrite-probe/` 是另一台独立的一次性探针插件，普查
`llm/stream` 瀑布形状——为规划中的 `agent/request` 身份注入提供事实（见 `docs/m0-probes.md`）。

架构与决策记录见 `docs/architecture.md`、`docs/m0-probes.md`、`docs/m1-report.md`、`docs/ui-plan.md`。
许可证 MIT（`LICENSE`）；版本历史见 `CHANGELOG.md`。
