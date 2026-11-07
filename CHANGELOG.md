# Changelog

## 1.1.1 — 2026-11-07

### 装好就能用：网关自动接进模型菜单
- **自动接线（`host/harness-wire.ts`）**：插件启动、网关就绪后检查 profile 的
  `llm-pi-ai.providers`，缺 `steward` 就补上——四个档位、`baseURL`、
  `apiKeyEnv: STEWARD_LOCAL_TOKEN`、`defaultMaxTokens: 65536` 一次填好。
  装完重启一次 DSH，输入框里直接能选「管家·极致便宜 / 效率优先 / 最强火力 / 白嫖」，
  不用再手抄 YAML。之前这一步漏了，装完菜单里什么也不会多出来。
- 写回走**文本拼接**而不是整体序列化：只插入/替换 `steward` 那一段，注释、空行、
  缩进风格、别的厂家原样保留；认不出结构（flow 写法的 `providers`）就什么都不做，
  只记一条日志——宁可这一轮不接，也不能把用户的 profile 重排坏。
- **幂等**：已经接好就一个字节都不写；端口变了才更新地址；用户改过的显示名、
  输出上限、自己加的旧档位都留着。
- 网关默认端口改为 **51741**（与 README 一致——地址要写进 profile，端口每次变
  就等于每重启一次接线就断一次）；被占用时自动退到系统分配，不让端口冲突
  把整个插件带下水。
- 设置页「个人网关」多一行：模型菜单里到底接上没有。

### 修好「第一次装好就该能用」
同学那台机器上新装 1.1.1 遇到的三连红，都是**首次安装没有 `model_pool.yaml`** 引起的：

- **面板不再把「还没配置」说成「配置坏了」。** 池文件不存在时，状态从 `rejected`
  改为 `empty`，横幅写「还没接入任何厂家：打开『管家设置 → 厂家设置』接一家」，
  不再甩一条 `not found: …\model_pool.yaml`。真正的语法错误仍然报红。
- **网关在没有配置时也启动。** 之前池为空就不起网关，于是「配置地址 → 重启 DSH →
  拉取模型」这条路自己把自己锁死（拉取模型要经过网关）。现在空矩阵也照常起网关、
  照常发布四个虚拟档位；接上厂家后热重载即可，不用再重启。
- **「测试连接并拉取模型」不再被网关状态拦住。** 拉取是宿主进程直接向上游发请求，
  跟网关在不在没关系，之前那条前置检查是纯粹的先有鸡还是先有蛋。

### 上游型号识别：别名 / 快照 / 同族
- 新增 `core/model-match.ts`：精确 id / 归一化 / 显示名之后，再按三层放宽——
  手工别名表（`deepseek-chat` → DeepSeek Flash）、发版快照（`deepseek-v4-pro` ↔
  `deepseek-v4-pro-0813`，只认日期样式的尾巴）、同族兜底
  （只要能认出 `gpt-6.1-terra` 是 GPT 族，就沿用 GPT 的能力与擅长标签）。
- 同族只借**能力与擅长标签**，评级仍是 NA、价目仍然未知：那是具体型号的事实。
  小版本（`claude-fable-5` vs `claude-fable-5-1`）不是快照，不会被认成同一个，
  也不会被改名——卡片上写的就是上游那个 id。
- 设置页不再给这些型号弹「自打标签」输入框——中转站拉来的 GPT / Claude、
  Westlake 那种自建端点上的 qwen / ds / glm 都能直接认出来。
- 价目按**用户实际写的那个 id** 取（`deepseek-v4-pro` 与 `-0813` 各拿各的公开价），
  查不到才退回认出来的那一条；输入价 / 输出价的占位与内置价目一致。

### Anthropic Messages 格式兼容
- `api` 新增 `anthropic-messages`：官方 Anthropic 端点自动按 `/v1/messages` 走，
  中转站仍按 OpenAI 兼容。界面不显示这个开关（地址已经说明问题），确有需要可在
  `vendors.json` 里按厂商写 `"api": "anthropic-messages"` 覆盖。
- 新增 `host/anthropic.ts`：请求方向把 OpenAI 请求翻成 Anthropic（system 抽出、
  tools / tool_choice / 图片 / stop 白名单拼接、max_tokens 必填）；响应方向把文本、
  工具调用、stop_reason 与 usage 翻回来；流式用 TransformStream 把 Anthropic SSE
  转成 `chat.completion.chunk` 并以 `[DONE]` 收尾。网关、路由、计量、缓存都不改。
- 流式 usage 合并：`message_start` 的 input_tokens 与 `message_delta` 的
  output_tokens 各占一半，后者覆盖前者会把输入侧的账抹成 0。

### 面板与设置页
- 输入框模型选择器只发布**四个档位**（极致便宜 / 效率优先 / 最强火力 / 白嫖）；
  「自动」「子代理」不再是可选模式（子代理专用模型仍由网关识别，供 `tool-subagent` 用）。
- 面板顶部只写「当前为哪一档」，并点完模型选择立刻跟着变（不再等下一轮对话）。
- 设置页新增「个人网关」页签，与厂家设置 / 免费池 / 白嫖模式并排；页头不再常驻接线信息。
- 切到「厂家设置」默认停在 OpenAI，切到「免费池」默认停在百度千帆（不再停在上次点过的那家）。
- 模型卡的徽标与模型 id 并成一行；画图 / 视频 / 向量模型标「非对话」，并且真的不进对话路由。
- 「厂家设置（含自定义）」去掉了括号；「还没选模型 · 未填密钥」与「官网 / 申请密钥」
  并成一行；「官方：国内直连」这类一句话说明不再单独占一行。
- 「求 Star」链接放在设置页头部，文案改为「如果你觉得好用，请给作者点个 Star」。

### 素材
- Claude 头像换成新立绘（B 站 UP 主 **@大只菠萝熊**），厂家头像从 32px 放大到 40px。


## 1.1.0 — 2026-11-07

### 子代理专用模型 `steward:subagent`（不是模式）
- 新增子代理专用的选路规则（不是模式，不改全局档位；只要在用管家开头的模型就生效）：`agentic` 质量 0.6 + 成本 0.4，
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

### 修：DSH 打不开——`desktop welcome: Web authentication failed`
真机故障：桌面版停在「应用无法启动或已意外停止」，崩溃日志只有一行
`Error: desktop welcome: Web authentication failed`。排查结论是**与插件、密钥、
账号都无关**的 DSH 自身缺陷：

- 宿主每次启动都下发一枚**新名字**的 `dsh-auth-<随机>` Cookie（HttpOnly、`Path=/`、
  30 天），却从不回收上一次的。本机实测积了 **71 枚**；
- 浏览器每发一次请求就把它们全带上，Cookie 头越过 Node 默认的 16 KB 请求头上限；
- 宿主对所有带凭证的请求回 **431 Request Header Fields Too Large**，桌面端
  `connectDesktopWelcome` 拿到的不是 2xx，就抛上面那句「认证失败」。
- 证据链：同一个宿主单独起、用 `fetch` 直连是 `303 → Set-Cookie` + `200`；
  从应用主进程用 `net.fetch(url, {credentials:'include'})` 请求是 **431**，
  `credentials:'omit'` 是 401——差别只在那一大串 Cookie。

防护：
- `snapshot` 会数本次请求携带的 `dsh-auth-*` 数量（宿主自己收得到 Cookie 头，
  不需要碰被 Chromium 独占的 Cookies 文件），面板据此挂横幅：
  **≥ 40 黄条提醒、≥ 55 红条警告**「下次启动会失败」。
- 新增 `src/core/auth-cookies.ts`（纯判定）与 `src/host/auth-cookies.ts`（离线清理）。
- 新增命令 **`npm run repair:cookies`**：**完全退出 DSH** 后运行，先备份 Cookies 库，
  再删掉本机 `127.0.0.1` 的 `dsh-auth-*`（别的源、别的 Cookie 一律不动）；
  DSH 还在运行时会明确提示「打不开 Cookies 库，请先退出」，不会写出半个库。
- 启动器 `shots/relaunch.ps1` 在拉起 DSH 前顺手清一次，失败不阻塞启动。
- README 的踩坑清单从两个坑补到四个坑（令牌一把钥匙、Cookie 堆积各一条）。

### 质量
- 536 条断言全绿（子代理打分 / 粘性 / 只读预览 / 跨厂商归一化 / 虚拟 id 自述 /
  `recommend_model` / Cookie 计数与清理边界 / 横幅阈值 / 面板透传 / 输入框模型名→档位 /
  型号别名·快照·同族 / Anthropic 请求与 SSE 翻译）；
  `tsc --noEmit` 零错误。


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
