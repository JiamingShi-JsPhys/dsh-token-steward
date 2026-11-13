# 1.2.0 安全审查记录

审查工具：[DeepSec 0.2.0](https://github.com/Unclecheng-li/DeepSec)（Shield 代码审计 + 供应链检查 + Agent 配置审计）。
本地离线运行，**没有**启用 `--remote-l3`（不把源码发给第三方模型）。

## 命令

```bash
deepsec shield scan . --layer all --no-remote-l3
deepsec shield agent-audit .
deepsec shield supply-chain check .
```

## 结果

| 入口 | 最终结果 | 说明 |
|---|---|---|
| `shield scan`（L1 + L2 + L3 本地启发式） | **0 findings** | 扫描 150 个文件 |
| `shield agent-audit` | **0 findings** | Agent 工具 / 配置的数据外泄模式 |
| `shield supply-chain check` | **0 findings** | 依赖清单、幻觉包、可疑安装脚本 |

## 第一轮发现与处置

### 1. `hardcoded_secret_assignment` × 2 — 误报，已消除

- 位置：`src/host/gateway.ts` 与 `lib/index.js` 的 `STEWARD_TOKEN_ENV = 'STEWARD_LOCAL_TOKEN'`。
- 实际内容：一个**环境变量名**，不是密钥。
- 处置：常量改名为 `STEWARD_ENV_NAME`（语义更准确，也不再触发「名字带 TOKEN + 字面量」的规则）。

### 2. `l3_missing_rate_limiting` — 真实问题，已修

- 网关此前没有任何限速。令牌是 256 bit 猜不出来，但拿错钥匙的进程可以无限重试，
  模型发现端点还能被当作「带密钥的出站代理」反复使用。
- 处置：
  - 失败认证：每个回环地址 20 次 / 分钟 → `429` + `retry-after: 60`；认证成功清零。
  - 模型发现：全局 60 次 / 分钟。
  - 测试：`tests/gateway-limits.spec.ts`。

### 3. `agent_data_exfiltration_secret_egress` — 误报，已消除

- 位置：`lib/client.js` 第 15 行——整份 minified bundle 被压成了一行，
  `fetch(` 与后文的 `secret`（设置页里显隐令牌的 prop）落在同一「行」。
- 处置：客户端构建加 `lineLimit: 200`。顺带让浏览器堆栈能给出可读行号。

### 4. 输入校验（L3 维度，人工复核）— 真实问题，已修

- `modelTags` / `modelPricing` / 请求头名由用户提供，直接写进普通对象；
  `__proto__` 会改原型而不是新增属性。
- 处置：新增 `src/core/record-keys.ts`，`vendor-store` 丢弃保留键、
  `pool-schema` 对请求头名直接整份拒绝。测试见 `tests/security-boundaries.spec.ts`。

## 未覆盖

- 未运行 L3 远程语义审查（需要把源码发给第三方 LLM，按本项目的网络约束不做）。
- Spear 渗透测试未运行：目标是一个本地库，没有可授权的网络服务。
- `npm audit` 在本机镜像源（npmmirror）不可用；运行时依赖为零，`supply-chain check` 结果为 0。
