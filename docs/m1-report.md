# M1 交付报告 · 四个纯逻辑文件 + 112 条测试全绿

## 一、结果

```
ℹ tests 112
ℹ pass 112
ℹ fail 0
ℹ duration_ms 324
```

复跑：`node --test "tests/**/*.spec.ts"`（零依赖，Node 24 原生类型剥离，不装任何包）。

| 文件 | 行数 | 职责 | 测试 |
|---|---|---|---|
| `src/core/types.ts` | 401 | 全部契约类型，过线安全 | — |
| `src/core/pool-schema.ts` | 589 | YAML 校验与归一化 | 38 |
| `src/core/health.ts` | 167 | 熔断 / 冷却 / 并发 / rpm 状态机 | 18 |
| `src/core/router.ts` | 420 | 硬过滤 → 打分 → 降级链 → 事件 | 39 |
| `src/core/scorers.ts` | 146 | 三模式打分器 | 17 |

## 二、纯度验证（不是口头承诺）

```
health.ts: clean
pool-schema.ts: clean
router.ts: clean
scorers.ts: clean
types.ts: 42: * env:NAME → process.env.NAME   ← 仅注释
```

grep 模式：`node:fs|node:http|node:https|fetch\(|node:net|node:dns|Date.now|process.env|require\(`

四个核心文件**零 IO、零网络、零时钟读取**。时间一律由调用方以 `now: number` 带入，
所以「冷却 30 秒后恢复」这类断言不需要 sleep，直接传时间即可测。

## 三、四条设计决定（都有测试兜底）

### 1. 配置：拒得早，不半应用

```
defaults 坏 → 立刻返回，不再校验 providers
```

半应用的路由表比没有路由表更危险：用户看到「保存成功」，流量却走了没打算用的模型。
（`pool-schema.spec.ts`「拒绝要尽早」）

### 2. `capabilities` 缺失 ≠ `capabilities: []`

- 不写 → **报错**，因为能力标签是路由契约本身，漏写必须点名；
- 显式写 `[]` → 合法，表示「这个模型没有特殊能力」。

静默把缺失当成空数组，会让一个本该被路由选中的模型永远选不中，而且没有任何提示。

### 3. 降级链不含自身失败

```
chosen 失败 → 记进 history → 换 fallback → fallback 失败(final) → 收口
最终事件的 degradedFrom = [chosen]，不含 fallback 自己
```

第一版实现把最后这次失败也塞进了 `degradedFrom`，测试直接抓到（`2 !== 1`）。
语义上那是「我失败了」，不是「我从谁降级过来」。

### 4. 效率模式的 burst 扣分是决定性的，不是倾向

`BURST_PENALTY = 10_000`（其余项最大 ~1_000）。

第一版给的是 400，结果 4 个并发只摊到 3 个模型——因为 `premium/omni-pro` 的能力分
盖过了扣分，同一个模型被派了两次。测试断言 `new Set(picks).size === 4` 直接抓到。
「先用还没被派的模型」是效率模式的定义，不是可以被别的因子翻盘的偏好。

## 四、三模式的实际赢家（同一组模型）

| 模型 | cost | 标签 | 质量 | frugal | efficiency | max_power |
|---|---|---|---|---|---|---|
| cheap | free | coding | 20 | **赢** | | |
| quick | high | coding+fast | 60 | | **赢** | |
| strong | high | coding+reasoning | 99 | | | **赢** |

同一份输入、三个模式、三个不同赢家——这是「模式真的在起作用」最直接的证据
（`scorers.spec.ts` 最后一条）。

## 五、容灾矩阵（全部有测试）

| 上游状况 | 路由器行为 | 测试 |
|---|---|---|
| 429 限流 | 指数退避冷却（上限 2^4 倍），下一请求自动换人 | ✅ |
| 连续超时达阈值 | 熔断 open，到期半开试探，成功才彻底复位 | ✅ |
| 认证失败 | 一次即熔断（凭据坏了重试无意义） | ✅ |
| 客户端取消 | **不计入失败**，不冷却 | ✅ |
| 400 / 上下文超限 | **不污染健康分**（换模型才有用） | ✅ |
| 首字节已发出后失败 | 不可降级，直接收口 `committed: true` | ✅ |
| 候选耗尽 | `final` 标记收口为失败事件 | ✅ |
| 全部熔断 | 返回 `all-models-cooling`，不抛错 | ✅ |
| 无模型满足能力 | 返回 `no-capable-model` + 逐条淘汰原因 | ✅ |

## 六、计量严谨性（你特别强调的第 3 点）

三处硬约束，都有测试：

1. **未定价 ≠ 免费**：没有 `pricing` 表的模型，`todayCost` 是 `null`，面板显示 `—`；
   同时计入 `totals.unpricedModels`，面板可提示「N 个模型未定价」。
   配置解析时每个未定价模型还会产出一条警告，不是静默。
2. **混币绝不相加**：CNY 与 USD 同时存在时 `totals.todayCost` 返回 `null`，
   而不是把 1.5 元和 2.5 美元加成一个数字。
3. **`usageAvailable` 三态**：未装 dsh-usage 时该字段为 `false`，面板显示「计量不可用」，
   不是显示 0。

## 七、已按你的三个决策落实

| 你的决策 | 在 M1 的落点 |
|---|---|
| 网关实现 `/v1/models`，返回全量 + 4 个虚拟 ID | `GatewayState.modelIds` 字段已定；`/v1/models` 实现属 M2 |
| 网关启动生成本地占位 Token，profile 带上 | `GatewayState.token` 已定；M0 已证 pi-ai 必须有 key |
| 未定价一律显示 `—` | ✅ 已实现并有测试（第六节第 1 条） |

## 八、M2 的入口（下一步）

M1 的出口是四个纯函数模块，M2 要接的是它们外围的 IO：

- `pool-file.ts`：读 `$DSH_HOME/token-steward/model_pool.yaml`（用宿主自带的 `yaml`，M0 已证存在），失败即整份保留旧配置；
- 原子写：临时文件 + `rename`，写入前校验，写完才替换引用；
- `fs.watch` 热重载 + 去抖；
- 路由台账（路由事件之外的持久化部分）同样走原子写。

这四个文件的接口已经稳定（`parsePool` / `createRouter` / `report` / `snapshot`），
M2 只需要在它们外面套 IO，不会回头改契约。
