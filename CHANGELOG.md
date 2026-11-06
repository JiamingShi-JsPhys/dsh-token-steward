# Changelog


## 1.1.1 — 2026-11-07

### 修：换过令牌后「API 密钥无效 AUTH」
- 真机故障：系统用户环境变量 `STEWARD_LOCAL_TOKEN` 里留着旧令牌，而网关的持久化
  令牌是新的。DSH 的 `llm-pi-ai` 可能在插件挂载之前就把 `apiKeyEnv` 读进凭据缓存，
  插件随后再写 `process.env` 已经来不及——每个请求都被网关 401，界面显示
  「API 密钥无效 AUTH」。
- 三道保障：
  1. **采用继承令牌**（`resolveStartupToken`）：环境变量是合法令牌形状就用它，
     持久化令牌只在环境变量缺失或形状不合法时使用，`gateway.json` 随之对齐；
  2. **漂移窗口双钥匙**：启动时两把不一致就把旧持久化令牌临时并入网关认的名单，
     DSH 手里那把旧钥匙发来的请求也不会 401；下次启动两边一致后窗口自然关闭；
  3. **令牌回写用户环境变量**（Windows，`src/host/token-env.ts`）：每次启动把当前
     令牌写回 `HKCU\Environment`，下次从任何方式启动继承到的都是正确的一把。
- 安全性不变：仍是常量时间比较；清单最多两把、都是本机用户目录里的令牌，范围仍只限回环。
- `shots/relaunch.ps1` 启动器读取 `gateway.json` 后再导出令牌，作为第四道兜底。
- README 的「两个踩过的坑」补上这一条与排查方式。
- 493 条断言全绿（新增启动令牌选择、漂移窗口、令牌回写用例）。


## 1.1.0 — 2026-11-07

### 子代理档位 `steward:subagent`
- 新增独立的选路档位（不是模式，不改全局档位）：`agentic` 质量 0.6 + 成本 0.4，
  窗口每 100k +4 分（封顶 40），延迟最多 +20 分，burst 打散仍是决定性的，
  再加上会话粘性 +300；agentic 维度 B+ 是硬门槛。
- `parseVirtualModel` 认得 `steward:subagent` / `Steward Subagent` / `管家·子代理`；
  `inferIntent` 对子代理请求强制按 `agentic` 打分（即使这一轮没带 tools）。
- 网关 `/v1/models` 发布 6 个虚拟 id（补上 `steward:free`），并给每个虚拟 id
  带上 `name` / `strengths` / `strength_tags`，模型发现与选择界面据此给出人话解释。
- 接线：把 `dsh-tool-subagent` 的 `agentOptions` 设为
  `{ provider: 'steward', model: 'steward:subagent' }`，之后所有子代理按这套规则选型。

### Agent 选模咨询 `recommend_model`
- `token_steward_manage` 新增动作：`action=recommend_model`，
  可带 `profile=subagent` 与 `task="一句话任务"`，返回按真实意图推断排好序的
  provider/model 与逐项理由；矩阵未加载时如实说明，不编造推荐。
- 路由引擎新增 `preview()`：只排名、不派发，不占并发、不记 burst、不动健康状态机。

### 换模型时的上下文继续
- **会话粘性**：同一会话（`session_id` / agent id）成功服务过的模型，下一轮获得
  小额加分（frugal +60 / balanced +300 / max_power +120），只在接近的候选之间生效；
  按档位分开记（主子代理共用会话 id 也不串味）；LRU 上限 512 个会话。
- **跨厂商请求归一化**：目标厂商 ≠ 上一轮服务的厂商时，剥掉助手消息上的
  `reasoning_content` / `reasoning` / `reasoning_details`、content 里的
  `thinking` / `redacted_thinking` 块与 `cache_control` 标记；系统提示与用户内容
  一字不动，同一厂商内换模型保持原样。消息日志本身始终完整保留。
- 窗口不够时仍是硬拒绝（`window-too-small`），绝不悄悄截断历史。
- 明确写进 README：跨模型 KV 状态迁移在公开协议下做不到，以上是 API 层能拿到的全部收益。

### 质量
- 485 条断言全绿（新增子代理打分 / 粘性 / 只读预览 / 跨厂商归一化 / 虚拟 id 自述 /
  `recommend_model`）；`tsc --noEmit` 零错误。


## 1.0.0 — 2026-11-06

### 终极整合（同日，仍为 1.0.0）

「终极整合」：在 1.0 的网关/降级/健康骨架上，把成本、缓存、三模式语义与面板交互
按产品规格重做。

### 设置页：接线信息可刷新、令牌默认打码
- **本地令牌默认打码**：设置页只显示一串圆点，点「显示」才展开；「复制」始终复制
  真实令牌。令牌进的是 `apiKeyEnv` 指向的环境变量，没必要时时挂在屏幕上。
- **「刷新」按钮重取三样东西**：配置文件、网关参数（端口与令牌随网关重启变化）、
  厂家列表。之前网关参数只在第一次取到时缓存，DSH 重启后照着旧值配 profile 只会
  得到 401。
- **每个字段补一行用途说明**：配置文件路径 / 网关地址 / 本地令牌 / 台账保留天数。
- **台账保留天数不再写死 180**：由宿主把真实配置随快照报上来。
- **白嫖页不再停在旧快照**：快照只在悬浮面板展开时轮询，设置页里的「白嫖」列的是
  快照里真正入池的零成本型号，所以保存厂家配置、打开设置页、切到白嫖页都会重取一次。
- **快照序号跨重建连续**：保存厂家配置 / 删厂家 / 重读配置都会重建路由引擎，引擎里的
  revision 从 0 重新数，面板客户端把「更小的 revision」当迟到响应丢掉——于是白嫖页与
  模型卡片永远停在重建前。宿主现在维护一个只增不减的游标，重建时传给新引擎。

### 路由三连修（真机复现后）
- **模型 id 不再被目录改写**：合成池只从目录取元数据，`id` 始终用用户配置的原始写法。
  之前 `agnes-3.0-flash` 被写成目录里的 `agnes-3-0-flash`，上游直接
  `model_not_found`，只能靠降级兜住（每次白等 15s）。
- **出站 `max_tokens` 压到 65536**：客户端会发远超上游能力的值，Agnes 直接 400
  `max_tokens 不能超过 65536`；现在统一压到 65536，正常请求不受影响。
- **新会话默认模型 = `Steward Auto`**：profile 里 `agent-default-model` 改指
  `steward / steward:auto`，选了 Agent 模式就不必再手选模型。

### 对话路由的硬修正
- 中转站 `/v1/models` 会把向量与重排模型一起列出来。合成池按 id 识别（embed / rerank）
  并标 `chat: false`，引擎以 `not-a-chat-model` 把它们挡在对话路由之外，面板挂 `[NO-CHAT]`；
- 「缓存命中」卡在上游不给 usage 缓存信息时，退回**本地缓存的真实命中次数**，不再显示 `—`。

### 价格层（新）
- 目录 36 个模型补齐 **榜单估算价**（USD / 1M tokens），标注为估算、可在面板逐模型覆盖；
- `VendorConfig.modelPricing` 与 `vendors.json` 往返（修复 `modelTags` 同一处被丢弃的 bug）；
- `src/core/pricing.ts`：未定价 = null、混币不相加、节省不为负。

### 三模式语义（重写）
- **Max Power**：六维**总和**最高，Tier 破平；不再只看主维度；
- **Balanced**：任务主维度 **A/A+ 门槛**先于价格，门内质量 0.6 + 成本 0.4，burst 打散仍决定性；
- **Frugal**：满足硬过滤的 **C/D 级**里最便宜；没有 C/D 才放宽（`FALLBACK:tier-widened`）。

### SQLite 缓存（新）
- `node:sqlite` + SHA-256 prompt 键，落 `$DSH_HOME/token-steward/cache.sqlite`，重启不丢；
- 命中即 0 token、原样回放字节；TTL / 容量 / 今日命中统计；
- 老宿主自动降级内存 LRU；默认开启，设置页可关。

### 面板（终极整合）
- 四个页签：成本看板 / 模型矩阵 / 路由日志 / 代理协作；
- 悬浮球角标改为**今日已省**（缓存 + 降配），成本看板同步展示来源；
- 极客标签统一为 `[TIER: SSS]` `[REASONING: A+]` `[VISION]` `[200K]` 大写等宽 1px 实线，无 Emoji；
- 40×40 AI 娘头像（从用户提供的榜单 PDF 裁切，**每家厂商一张**、取该厂商排名最高的立绘），Tier 发光边框，
  无图/加载失败回落字母几何；宿主新增 `api/token-steward/avatar?id=` 同源头像路由；
- 设置页：官方 URL 只读行 + 中转站 Base URL Override 输入框；Anthropic 红字防封警告
  固定在 API Key 正上方；模型勾选卡补价格覆盖；
- 修复 `.ball[data-tone='efficiency']` 永不命中、`modelCardGrid` 等 5 个 CSS 类缺失。

### 质量（终极整合）
- 403 条断言全绿（新增价格 / SQLite / 头像 / 极客标签 / 新三模式 / 头像路由 / 重启持久化）；
- `tsc --noEmit` 零错误；`npm run build` 正常产出。


首个可发布版本（原名 dsh-umbra-budget，同版本内更名 **dsh-token-steward · Token 管家**）。
架构基于 M0 探针对真实宿主（app.asar 182 MB）的实测结论：
`llm-pi-ai` 适配器在构造 SDK 客户端时捕获 `fetch`、请求体深冻结，插件无法可靠
改写「用哪个模型」——因此执行层是本地 OpenAI 兼容网关（只绑 127.0.0.1，
随机端口 + 本地令牌），profile 里把 `llm-pi-ai` 的 `baseURL` 指过来即可。

### 网关（执行层）
- OpenAI 兼容端点：`/v1/chat/completions`（流式 SSE 直通）、`/v1/models`、`/health`；
- 虚拟模型 id：`steward:auto` / `steward:frugal` / `steward:balanced` / `steward:max_power` /
  `steward:pin/<provider>/<model>` / `steward:alias/<name>`，真实模型 id 直通（仍走熔断与计量）；
- 只绑回环、系统分配端口、常量时间令牌比较、凭据明文不出内存。

### 路由引擎（纯函数，全量单测）
- 硬过滤（capabilities / modalities / 窗口 / offline / 熔断 / 并发闸门 / rpm 滑窗）
  → 三模式打分（frugal / efficiency / max_power，`reasons[]` 直接上面板）
  → 首选 + 有序降级链；效率模式按 burstKey 并发打散（idea_swarm 4 代理自然落到 4 个上游）。
- 容灾：429 指数退避冷却、连续失败熔断 + 半开试探、401/403 一次即熔断、
  400 文本判别上下文超限（唯一「升配」降级）、首字节已发出后不降级（committed-then-failed）。

### 配置与文件层
- `model_pool.yaml`：三层结构（defaults / routing / providers），逐字段诊断，整份拒绝绝不半应用；
- 凭据引用 `env:` / `file:` / `literal:` / `${NAME}`，展开后的明文不进日志、快照与过线 JSON；
- 热重载：内容比对去抖（编辑器 save 序列不误报）；原子写（Windows rename EPERM 有界重试）；
- 台账损坏隔离留档（`.corrupt-<ISO>`），从不删除用户数据。

### 本地精确响应缓存（初版，已被 SQLite 版取代）
- `routing.cache.exact_match`（默认关闭）：trivial 同 prompt 在 TTL 内直接回放上次响应
  字节，不出站、不计费、不进健康状态机（不收假延迟样本）；
- 键覆盖 prompt 定义性字段 + 虚拟 id + 生效模式 + 流式形状：换模式/换形状天然失效；
- 三条硬规则：带 tools 不缓存、超长不缓存、不可序列化不缓存；
- 路由监控的命中行带 `cached` 标记（「缓存命中（未出站）」），模型被下线后命中作废。

### 计量（诚实规则）
- token 真相源是 `dsh-usage` 台账（缺失时面板显示「计量不可用」，不显示 0）；
- 未定价显示 `—` 不冒充 0；混币总额显示 `—`，绝不把两种货币相加；
- 另记路由维度台账（谁被选中、降级链、每模型延迟）。

### 面板
- 悬浮球（模式色环 + 今日花费角标，长按循环切模式）+ 展开面板（四张数字卡 /
  模型阵列 / 路由监控 / 代理协作）+ 设置页（网关地址令牌一键复制）；
- 只用 `--dsw-alias-*` 令牌与语义属性，深浅色与皮肤直接接管；动效受 `prefers-reduced-motion` 降级；
- 收起或切后台即停轮询。

### 质量
- 358 条断言全绿（`npm test`，含构建，零外部服务）；`tsc --noEmit` 零错误
  （strict + exactOptionalPropertyTypes + noUncheckedIndexedAccess）；
- **厂家配置中心（vendors.json）**：面板厂家 Tab（Anthropic/OpenAI/Google/DeepSeek/Alibaba/Moonshot/Zhipu/Xiaomi/MiniMax + Custom），
  API Key + Base URL 表单，Anthropic 固定红字防封警告；「测试连接并拉取模型」经网关 GET /v1/models?vendor=|base_url= 探测上游，
  勾选启用后整表落 0600 的 vendors.json 并即时重建矩阵；
- **六维评分路由**：reasoning/longContext/coding/agentic/proWork/factuality 六维（数值 + 字母评级为独立事实字段，逐字录入 30 模型），
  intent 推断主维度（agentic/longContext/coding/reasoning），三模式以主维度分为主序（frugal 有够用线沉底）；
- 模型卡展示 [TIER] 徽标与 R/L/C/A/P/F 六维数值框；能力标签为大写等宽 + 1px 实线（无 Emoji）；
- `lib/index.js`（ESM）+ `lib/client.js`（`window.__ModuleLoader__` 闭包，CSS 内联），
  产物验收走行为（`new Function` 伪 window 真跑 client bundle）而非文本 grep；
- `probes/` 保留全部 M0 探针（asar 抽取 / 网关回路 / usage 桶 / 冒号模型 id）可原样复跑，
  另含 `m0-rewrite-probe`（`llm/stream` 瀑布形状普查，为 `agent/request` 身份注入做准备）。
