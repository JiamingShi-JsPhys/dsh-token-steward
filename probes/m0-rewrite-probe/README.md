# dsh-steward-rewrite-probe — M0 改写语义探针

回答一个承重问题：**在 `llm/stream` 瀑布里就地改写 `options.provider/model`，改动能否真正到达出站 HTTP 请求？** 同时摸清瀑布交给插件的 payload 形状、`next()` 可否二次调用、`settings` 服务面、`session/event` 事件族。

> 诚实的边界：`test/probe.test.mjs` 用**文档化契约的假宿主**验证了探针自身逻辑在三种语义（可变 / 深冻结 / 运行时静默克隆）下的判定都正确；但真实宿主的行为只能靠本探针装进真实 DSH 跑一次来定论。

## 运行

1. 用一个**scratch profile**（别用主力配置）：准备一个已配置且便宜的 provider/model。
2. 修改 `cordis.patch.yml` 里 `config.provider` / `config.model` 指向它。
3. 安装并重启（探针启动后自动执行，共发起 4 次自调用，每次 ≤ 8 输出 token）：

   ```sh
   dsh plugin --profile <scratch-profile> add /absolute/path/to/probes/m0-rewrite-probe
   ```

4. 读报告：`$DSH_HOME/steward-probe/report.json`（Desktop 宿主无 stdout，报告是唯一出口）。
5. 读完即从 profile 移除本插件（一次性探针）。

## 判读：`report.conclusion.rewriteBackend`

| 判定 | 含义 | token-steward 主插件采取的后端 |
|---|---|---|
| `waterfall` | 公开路径**和** `prepareCall` 路径的改写都流到了出站请求（dispatcher 观测到 marker 模型，或 API 错误回显 marker 模型） | waterfall 就地改写为主，dispatcher 兜底 |
| `waterfall-public-only` | 只有公开 `llm.stream` 路径生效；`prepareCall`（官方 agent loop 走的路）不生效 | agent loop 流量由 dispatcher 层强制；one-shot 走瀑布 |
| `waterfall-prepare-only` | 反向情形 | 同上，主次互换 |
| `dispatcher` | `Object.isFrozen` 命中或赋值抛 TypeError（深冻结） | 放弃瀑布改写，**全部**路由强制在 undici dispatcher 层完成（origin/鉴权头/body.model 改写） |
| `inconclusive` | 赋值没抛但 dispatcher 没观测到 marker（典型：运行时把 options 克隆后传给监听器） | 同 `dispatcher`（静默丢失最危险，按不可改写处理） |

辅助信号：

- `probes.P1c_provider_flow.harnessReadProvider === true`：provider 字段也会被宿主重读（完整 `(provider, model)` 二元组改写可行）。
- `probes.P3_second_next`：`next()` 二次调用的行为（`threw` / `sameReference` / `returnedStream`）——决定容灾换模能否复用瀑布通道。
- `probes.P4_settings_face.methodNames`：settings 服务暴露的方法名（只有名字，永远不写值）——决定 B 轨「自动注册 provider」是否可行。
- `probes.P2`（`waterfallShapes` + `sessionEvents`）：瀑布 payload 的键清单/冻结状态，以及窗口期内流动的 session 事件类型——决定「调用方身份归因」的链路。

## 报告里有什么

- `dispatcher.observations[]`：探针自调用请求的 origin / path / **body.model** / 鉴权指纹（前 4 字符 + 长度，**永不落明文密钥**）。
- `waterfallShapes[]`：每次调用经过瀑布时的 `Object.isFrozen`、键清单、关键字段类型。
- `sessionEvents[]`：窗口期内 `session/event` 的事件类型与 data 键名。
- `probes.*`：P1/P1c/P2/P3/P4 各步骤原始证据。

## 契约测试

```sh
node --test test/probe.test.mjs   # 4 个场景：可变✓ 冻结✓ 静默克隆✓ 报告结构✓
```
