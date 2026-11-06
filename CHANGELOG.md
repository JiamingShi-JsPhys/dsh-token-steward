# Changelog

## 1.0.0 — 2026-11-06

首个可发布版本。架构基于 M0 探针对真实宿主（app.asar 182 MB）的实测结论：
`llm-pi-ai` 适配器在构造 SDK 客户端时捕获 `fetch`、请求体深冻结，插件无法可靠
改写「用哪个模型」——因此执行层是本地 OpenAI 兼容网关（只绑 127.0.0.1，
随机端口 + 本地令牌），profile 里把 `llm-pi-ai` 的 `baseURL` 指过来即可。

### 网关（执行层）
- OpenAI 兼容端点：`/v1/chat/completions`（流式 SSE 直通）、`/v1/models`、`/health`；
- 虚拟模型 id：`umbra:auto` / `umbra:frugal` / `umbra:efficiency` / `umbra:max_power` /
  `umbra:pin/<provider>/<model>` / `umbra:alias/<name>`，真实模型 id 直通（仍走熔断与计量）；
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

### 本地精确响应缓存（1.0.0 新增）
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
- `lib/index.js`（ESM）+ `lib/client.js`（`window.__ModuleLoader__` 闭包，CSS 内联），
  产物验收走行为（`new Function` 伪 window 真跑 client bundle）而非文本 grep；
- `probes/` 保留全部 M0 探针（asar 抽取 / 网关回路 / usage 桶 / 冒号模型 id）可原样复跑，
  另含 `m0-rewrite-probe`（`llm/stream` 瀑布形状普查，为 `agent/request` 身份注入做准备）。
