# 《代码整合与升级方案》· dsh-token-steward 1.1

> **状态：已实施（1.1.0）。** 本文件是本次「终极整合」的施工图。基线：`tsc --noEmit` 零错误、`npm test` 372 条断言全绿、
> `npm run build` 可产出 `lib/index.js` + `lib/client.js`。
> 目标：在不推翻已验证架构的前提下，补齐 SRE（SQLite 缓存）、重写三模式语义、重做面板交互与视觉。

---

## 0. 现状盘点（读过全部 src/ 与 _archive/、_ref/）

| 分区 | 内容 | 结论 |
|---|---|---|
| `src/host/` | 本地 OpenAI 网关（回环 + 令牌）、上游转发/降级、健康熔断、配置热重载、路由台账、面板 HTTP | **架构正确，保留** |
| `src/core/` | 六维评分、意图推断、三模式打分、硬过滤、池校验、面板视图模型 | **骨架正确，模式语义要按新规格重写** |
| `src/client/` | `shell.overlay` 悬浮球 + 单页滚动面板、`settings.section` 设置页、SegmentGroup | **交互形态要改成四页签；补齐缺失样式与头像** |
| `tests/` | 20 个 spec、372 条断言，纯函数为主 | **保留，跟随语义变更同步改写** |
| `_archive/packages-dsh-umbra-budget` | 旧版 `dsh-umbra-budget`（ALS 进程内改写架构） | **已被网关架构取代，仅作参考，不并入** |
| `_ref/dsh-client-ui-pet` | 全家桶悬浮球/壁纸的挂载范式 | 挂载方式已吸收，**仅作参考** |
| `_ref/dsh-plugin-starter` | 插件模板 | 无新增价值 |
| `probes/` | M0 探针（asar、网关回路、usage 桶） | **保留**，可原样复跑 |

### 已确认的缺陷（本次必修）

1. **成本维度是空的**：目录里 30 个模型的 `costPer1kInput/Output` 全是 `null`，`frugal` 退化成
   「全部 medium 档 + 六维破平」，`balanced` 的「成本适中」无从谈起。
2. **三模式语义与规格不符**：`max_power` 选的是「主维度分」，不是「六维总和」；
   `balanced` 没有 A/A+ 准入门槛；`frugal` 没有 C/D 级限定。
3. **缓存不是 SQLite**：只有进程内 LRU，重启即失；命中不产出「省了多少钱」。
4. **面板不是四页签**：四块内容纵向堆在一个滚动容器里。
5. **能力标签没有按 `[REASONING: SSS]` 规格渲染**：现在是 `coding` / `reasoning` 小写裸词。
6. **模型卡没有头像**：`ModelCard` 只有文字。
7. **设置页缺「官方 URL 只读行 + 中转站 Override 输入框」的分层**；警告位置/强度需加强。
8. **样式选择器 bug**：`.ball[data-tone='efficiency']` 永远不会命中（实际值是 `balanced`），色环退化成黑色。
9. **样式缺失**：`SettingsPanel` 引用了 `.modelCardGrid` / `.modelSwitchCard` /
   `.modelSwitchHead` / `.modelSwitchName` / `.modelSwitchOn`，CSS 里都没有 → 运行时 className 为 `undefined`。
10. **标签丢失**：`vendor-store.coerceVendor` 没有读 `modelTags`，保存后重启即丢。

---

## 一、保留（Keep · 不动结构）

- `src/core/types.ts`：过线契约（只做**纯增量**字段：`ModelPricing`、`SavingsView`、`avatar` 等）。
- `src/host/gateway.ts`：OpenAI 兼容网关、`GET /v1/models`、SSE 直通、常量时间令牌、模型发现。
- `src/host/upstream.ts` + `src/core/{classify,health}.ts`：降级链与熔断状态机。
- `src/host/{pool-file,pool-watch,credentials,ledger-store,usage-bridge,atomic-file}.ts`。
- `src/host/routes.ts`：面板 HTTP 面（只增 `/cache` 统计端点）。
- `src/core/{intent,pool-schema,vendors,provider-templates,format,panel-view}.ts`（按需增补）。
- `src/client/store.ts` 的轮询纪律（revision 单调、不可见即停、错误不清空快照）。
- `scripts/build.mjs`、`tests/`、`probes/`、`cordis.patch.yml`。

---

## 二、重构（Refactor）

### 2.1 价格层 — 让「省钱」成为可计算的事实

- 目录每个模型新增 `listPrice: { input, output }`（USD / 1M tokens，榜单估算价，**可被用户覆盖**）。
- `VendorConfig` 新增 `modelPricing?: Record<modelId, { input, output }>`；设置页模型卡内可改。
- `src/core/pricing.ts`（新）：统一 `priceOf(model)`、`costOf(tokens, price)`、`savedBy(chosen, baseline, tokens)`。
- 未定价仍显示 `—`，绝不冒充 0；`unpricedModels` 计数保留。

### 2.2 三模式语义 — 严格按规格重写 `src/core/scorers.ts`

| 模式 | 新语义 | 排序实现 |
|---|---|---|
| **Max Power** | 无脑选六维总和最高；SSS/SS 优先 | `score = total6 * 100 + tierRank`，窗口/延迟只做同分微调 |
| **Balanced** | 任务对应维度达 **A/A+ 及以上**，且成本适中 | 先过 `gradeRank >= A` 门槛；门内 `0.6*主维度 + 0.4*成本分`；无达标者降级为「主维度最高 + 成本破平」并在 `reasons` 标注 |
| **Frugal** | 满足基础过滤的 **C/D 级**里最便宜 | 先筛 `tier ∈ {C,C+,D}`（无则放宽到全部）；按每 1k 输出价升序，主维度只做同价破平 |

- 硬过滤保持不变：图片请求 → 必须有 `vision` + `image` 模态；超长文本 → `context_window` 必须放得下。
- `reasons[]` 改为规格可读词：`SUM:472.3`、`TIER:SSS`、`DIM:coding A+`、`PRICE:$0.008/1K`、`FALLBACK:tier-widened`。

### 2.3 本地缓存 — 内存 LRU → SQLite（`node:sqlite`）

新文件 `src/host/sqlite-cache.ts`：

```sql
CREATE TABLE IF NOT EXISTS response_cache (
  key TEXT PRIMARY KEY,          -- SHA-256(prompt fingerprint)
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  content_type TEXT NOT NULL,
  body BLOB NOT NULL,            -- 原样字节（SSE 帧序列或 JSON）
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL, -- 估算，用于「省了多少 token」
  output_tokens INTEGER NOT NULL,
  saved_cost REAL,               -- 省下的金额（可空 = 未定价）
  currency TEXT
)
```

- 路径 `$DSH_HOME/token-steward/cache.sqlite`；`DatabaseSync`，WAL，`ctx.effect()` 里 `close()`。
- 动态 `import('node:sqlite')`；宿主 Node < 22.13 时**自动降级**为现有 `LruTtlCache`，不阻断挂载。
- 键：`sha256(JSON.stringify({prompt 定义性字段, modelId, mode, stream}))`，沿用三条硬规则（带 tools 不缓存 / 超长不缓存 / 不可序列化不缓存）。
- 命中：回放字节 + `router.noteCacheHit`，并把 `savedTokens` / `savedCost` 计入当日节省。
- 过期清理按 `ttl_ms` 惰性删 + 启动时一次 `DELETE`。
- 默认开启（`DEFAULT_CACHE.exact_match = true`），设置页提供开关。

### 2.4 面板 — 四页签

`StewardPanel` 增加页签条（复用 `SegmentGroup` 的滑动药丸）：

1. **成本看板**：今日 token / 今日花费 / **今日已省** / 降级次数 + 缓存命中构成。
2. **模型矩阵**：模型卡网格（头像 + Tier + 六维 + 极客标签）。
3. **路由日志**：降级链 `a → b`、缓存命中行、失败原因。
4. **代理协作**：子代理 → 模型归因，90s 闲置置灰。

保留 Esc 关闭、焦点陷阱、`prefers-reduced-motion` 降级、收起即停轮询。

### 2.5 极客标签（红线）

`ModelCard` 只渲染大写等宽、1px 实线、透明底的方括号标签：

```
[TIER: SSS] [REASONING: SSS] [CODING: A+] [LONG-CONTEXT: SS]
[AGENTIC: A] [PRO-WORK: B+] [FACTUALITY: A] [VISION] [TOOL-USE] [200K]
```

- 六维标签用 `[REASONING: <grade>]` 形式（字母评级是独立事实字段，不推导）。
- 能力标签 `[VISION]` `[TOOL-USE]` `[JSON-MODE]`；窗口 `[200K]` / `[1M]`。
- **禁止 Emoji**；不再输出小写裸词。

### 2.6 头像（40×40 + Tier 发光）

- `src/core/avatars.ts`：`avatarFor(provider, model)`，返回 `{ url?, letter, shape }`；**每家厂商一张**（用户决定），
  支持榜单图片 URL、`:vendor/model` 键覆盖、`data:` 内联图。
- `ModelAvatar.tsx`：40×40 六边形（`clip-path`）/ 圆形；`data-tier` 驱动发光边框
  （SSS 金、SS 紫、S 蓝、A 青、B 绿、C 灰、D 暗）；无图时用厂商首字母 + 确定性几何纹样兜底。
- 加载失败（`onError`）自动回落到字母形态，不出现裂图。

### 2.7 设置页

- **Anthropic 表单**：API Key 输入框**正上方**渲染红底红字警告（原文照录）：
  > ⚠️ 强烈不建议使用官方账号直连，极易封号。请填入您购买的第三方中转站地址（Base URL Override）
- **Base URL 分层**：只读显示「官方默认地址」，其下是「中转站 Base URL Override」输入框；
  留空 = 使用官方地址。
- 补齐缺失样式（模型勾选卡、网格、开关态）。
- 模型卡内增加价格覆盖输入（输入 / 输出，USD/1M）。
- 保留「让 Agent 帮我配置」入口与密钥掩码纪律。

### 2.8 修复清单

- `.ball[data-tone='efficiency']` → `balanced`。
- `vendor-store.coerceVendor` 读回 `modelTags`、`modelPricing`。
- `StewardPanel` 中 `t('panel.tab.*')` 四页签文案补齐中英。
- `Snapshot` 增加 `savings`、`cache` 统计；`MatrixTotals` 增加 `savedCost/savedTokens`。
- 每个路由事件记录 `tokens` / `cost`，让「相对最强模型的节省」可计算。

---

## 三、新增（New）

| 文件 | 作用 |
|---|---|
| `src/host/sqlite-cache.ts` | SQLite 响应缓存 + 统计 + 降级到 LRU |
| `src/core/pricing.ts` | 价格归一、每次调用成本、节省计算 |
| `src/core/avatars.ts` | 头像注册表（URL / 字母 / 几何兜底） |
| `src/client/components/ModelAvatar.tsx` | 40×40 头像 + Tier 发光 |
| `src/client/components/PanelTabs.tsx` | 四页签条 |
| `src/client/components/SavingsCard.tsx` | 成本看板内的「今日已省」 |
| `tests/sqlite-cache.spec.ts` | 命中/过期/容量/降级 |
| `tests/pricing.spec.ts` | 价格与节省计算（含未定价、混币） |
| `tests/avatars.spec.ts` | 映射与兜底 |
| `tests/scorers-v2.spec.ts` | 三模式新语义（总和 / A 门槛 / C-D 最便宜） |

---

## 四、验收

1. `npm run typecheck`（TS strict + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`）零错误。
2. `npm test` 全绿（旧断言按新语义改写，新增 SQLite / 价格 / 头像 / 模式断言）。
3. `npm run build` 产出 `lib/index.js` 与 `lib/client.js`。
4. 代码扫描：能力标签区**无 Emoji**；设置页警告原文一字不差。
5. `_archive/`、`_ref/` 保持不参与构建（已在 `.gitignore`）。

---

## 五、明确不做

- 不把 `_archive` 的 ALS 进程内改写架构并回来（与网关架构冲突）。
- 不在网关里做 Anthropic `/v1/messages` 协议转换（本期只保证 OpenAI 兼容；Anthropic 走其 OpenAI 兼容中转）。
- 不引入原生 sqlite3 依赖（只用 Node 内置 `node:sqlite`，避免 Electron ABI 问题）。
