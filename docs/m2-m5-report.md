# M2–M5 交付报告

M1 结束时的话是「直到 M1 测试全绿再向我汇报」。这份报告覆盖从那之后到现在的全部工作：
文件层、网关、面板、接线与打包。

---

## 一、最终状态

| 项目 | 结果 |
|---|---|
| 测试 | **345 条断言，345 通过，0 失败**（`npm test`，含构建） |
| 类型 | **`tsc --noEmit` 零错误**，strict + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` |
| 产物 | `lib/index.js` 89.6 KB / `lib/client.js` 36.0 KB（含 9.1 KB 内联 CSS） |
| 外部服务 | 零。全部测试只碰临时目录与回环端口 |
| 示例配置 | `model_pool.example.yaml` 经宿主自带 yaml 解码后仍被 schema 接受 |

测试分布（15 个文件）：

```
pool-schema  38   router      39   health      18   scorers     17
ledger-doc   18   host-files  30   intent/classify 38
upstream     30   gateway     23   panel-api   23
format       11   panel-view  26   client-store 21
artifacts    10   built-host-e2e 3   →  合计 345
```

---

## 二、M2 · 文件层

四个模块，一条共同纪律：**用户的数据永不静默丢失**。

- `atomic-file.ts` — 临时文件 + `handle.sync()` + rename。Windows 上并发 rename
  同一目标会瞬时 `EPERM`，因此加了**有界重试**（8 次、递增退避）。这不是绕过错误，
  而是承认 Windows 与 POSIX 的语义差异：每次重试仍然是一次完整的原子替换。
- `pool-file.ts` — 读配置失败时**保留上一份有效矩阵**，把新错误挂在状态上。
  用户手滑存了个半截文件，不应该让整个矩阵瞬间消失。
- `pool-watch.ts` — 去抖 250ms，且**比对内容而不是相信事件类型**。
  编辑器保存不是一次事件：VS Code 先给 rename 再给 change，Vim 给 rename 后重建。
  内容没变就不打扰调用方；保存窗口中的瞬时缺失也不当作「配置被删」。
- `ledger-store.ts` — 去抖 1s 落盘，`flush()` 的合同是「回来时数据已落盘」
  （包括等掉正在进行的那次写）。损坏的台账**隔离留档**为 `.corrupt-<ISO>`，从不删除。

**一处发现的实现缺陷**：`flush()` 在没有待写内容时直接返回，不等待正在进行的那次写，
于是「flush 后立刻读文件」会读到旧内容。已修正并加了回归断言。

---

## 三、M3 · 网关

网关是这个插件的存在理由：DSH 的 `llm-pi-ai` 在构造 SDK 时就捕获了 `fetch`，
请求体深冻结，插件无法可靠改写「用哪个模型」。只有 HTTP 这一层能做到。

### 新增模块

| 模块 | 职责 | 为什么是纯函数 |
|---|---|---|
| `core/intent.ts` | 请求 → 路由意图 | 推断规则必须能被单测钉死，不能只在真机上试 |
| `core/classify.ts` | 上游失败 → `ErrorKind` | 分类决定后续动作，错一次就是错一路 |
| `host/credentials.ts` | `env:` / `file:` / `literal:` / `${NAME}` 展开 | 明文只进 Authorization 头 |
| `host/upstream.ts` | 决策 → 真实请求 → 降级 | 唯一有副作用的转发层，必须薄 |
| `host/gateway.ts` | 回环 HTTP 服务 | 只绑 127.0.0.1，每次启动生成随机令牌 |

### 两个设计决定

**1. 首字节已发出后不再降级。**
重发会让上游产生第二份副作用（工具调用、写文件），而客户端只看到半截流。
`AttemptResult.committed` 记录这件事，网关据此收口为 `committed-then-failed`。

**2. 分类顺序是「状态码优先，文本兜底」。**
状态码是协议事实，文本是各家供应商的不同措辞。但 400 里确实可能藏着真实原因：
`context length` / `rate limit` / `invalid api key` 都会在 400 的正文里出现，
因此 400 分支额外做一次文本判别。

### 安全边界

- 只绑 `127.0.0.1`，端口由系统分配（`0`），不会与任何已有服务抢端口；
- 令牌比较用常量时间，避免用长度差异探测；
- 凭据展开后的明文**不进日志、不进快照、不进任何过线 JSON**；
- 面板 API 一律拒绝非回环请求（`isLoopbackRequest`）。

### 实测

真实起服务、真实 fetch 打它：401 / 400 / 502 / 流式透传 / 降级重试全部覆盖。
`/v1/models` 返回 4 个虚拟 id + 矩阵全部模型，`steward:max_power` 能把模式切到最强火力，
`steward:pin/cheap/cheap-1` 能直通。

---

## 四、M4 · 面板

### 视觉基准

对着 `@linxin666/dsh-web-all` v0.4.12 做，但**没有**直接抄它的聚合层——因为
那只是包装。真正要看的是分量包：悬浮球的做法在 `dsh-pet`（挂在 `document.body`
+ 自己的 `createRoot`），设置页三件套在 `dsh-usage`（`PluginSettingsCard.tsx` +
`settings-form.ts` + `settings-card.module.css`）。

### 组件

`StewardBall` / `StewardPanel` / `ModeSwitch` / `SegmentGroup` / `CostDashboard` /
`ModelCard` / `ModelGrid` / `RouteMonitor` / `AgentLanes` / `SettingsPanel`。

两个席位：
- `shell.overlay`（官方 ui-layout 声明的 root 列表席位，已从 asar 里核实存在）；
- `settings.section`（带 `order: 140` 与 `label`，排在 dsh-usage 的 100 之后）。

### 样式纪律

- 只用 `--dsw-alias-*` 令牌，因此深浅色主题与 Skin Center 皮肤能直接接管配色；
- 语义属性（`data-dsh-plugin` / `data-dsh-part` / `data-health` / `data-tone`）
  是皮肤锚点，类名只是局部实现细节；
- 动效全部受 `prefers-reduced-motion` 降级——监控面板长时间挂在屏幕上，
  永不停歇的脉冲是干扰而不是科技感。

### 浏览器实测

用真实组件渲染出的 HTML + 编译后的 CSS，在 Chromium 里按亮/暗两套令牌各看一遍
（截图见会话记录）。发现并修掉一个真实问题：预览初版把 fixed 定位的球与面板
钉在同一处互相遮挡——这恰好说明「只在真浏览器里看」是必要的。

### 轮询纪律

面板收起、页面切到后台 → **完全停轮询**。常驻的球只显示最后一次快照。

---

## 五、M5 · 接线与打包

### 产物形状

与全家桶一致，因为宿主的加载器只认这一种：

```
lib/index.js   —— 普通 ESM，loader 行直接加载
lib/client.js  —— window.__ModuleLoader__.load({ id, factory: (require) => … })
                   CSS 以 <style data-plugin-css=…> 注入，幂等且带 data-plugin 标记
```

`package.json` 里 `dsh.client.platform: 'web'` + `inject` 列表 + `exports['./client']`
三者缺一不可：`dsh-client-modules` 按 loader 行的 `name` 定位 package.json，
读 `dsh.client`，再从 `exports['./client']` 找 bundle 路径。任何一环缺失，
面板就静默不出现（而网关照常工作）。

### 产物验收

10 条断言，全部走**行为**而不是文本 grep——产物是压缩过的，
`order: 140` 到这里已经变成 `order: ne`，grep 只会给假阴性。做法是：
用 `new Function` 造一个带 `window` / `document` 的作用域，把 `lib/client.js`
真的跑起来，用伪 `require` 注入 react，然后检查：

- 自己调用了 `loader.load`，导出 `name` / `inject` / `apply`；
- 只 require 宿主真的会注入的模块（多要一个就是启动时崩）；
- 插入了且只插入一个 style 标签，且样式里确实用了主题令牌；
- 两个席位都被 `inject`，设置页的注册选项带 `order: 140` 与函数型 `label`。

Host 侧另有 3 条端到端：真的用 `lib/index.js` 挂载、起网关、打面板 API，
并在配置损坏时确认「不挂网关但也不抛错」。

---

## 六、交付前修掉的两个真实缺陷

这两个都是**写完之后自查发现的**，不是测试报出来的：

### 缺陷 1：usage 记到了幽灵键上

`relay()` 里把用量记成 `recordUsage('upstream', 'stream', …)`。
后果：面板按 `provider/model` 取数时永远取不到，台账里还会堆一批
`upstream/stream` 这样的假模型行。已改成沿真实 `provider` / `model` 记账，
并加了回归断言（流式与非流式各一条）。

### 缺陷 2：计量被冻结在启动那一刻

`usageNow()` 只在 `apply` 里预热一次，之后再也不刷新。
后果：插件启动之后 `dsh-usage` 写入的任何数据**永远不可见**——面板一路显示
「计量不可用」，而用户明明在用。已改成每次取快照都按 `usagePollMs` 节流地刷一次，
并且 `snapshot` 变成可 `await`，保证首帧就是最新的。
回归断言：启动 → 断言不可用 → 写入台账 → 等节流窗口 → 断言可见且落到模型卡上。

---

## 七、刻意没做的事

- **没做 `agent/request` 身份注入。** 现在的代理归因靠请求体里的 `user` / `session_id`
  线索，拿不到就记 `unknown`。要做精确到「哪个子代理用了哪个模型」，
  需要在 `agent/request` 瀑布上注入身份——但那需要宿主侧的 hook 点，
  而当前探针没能确证它的形状。宁可让代理协作视图少几行，也不假装它是准的。
- **没做价格表。** 成本完全依赖 `dsh-usage` 的台账与 `model_pool.yaml` 的 `pricing`。
  没有第二套计价逻辑，就不会出现「两套算法对不上」。
- **没做多币种换算。** 混币时总额显示 `—`。汇率是需要维护的外部事实，
  猜一个只会让数字看起来可信而实际是错的。

---

## 八、已知限制

1. **需要重启服务。** 改 profile 的 `llm-pi-ai` 指向后必须重启 DSH，
   没有热切换入口。
2. **网关端口每次启动可能变。** 用 `gatewayPort: 0` 时端口由系统分配，
   每次读 `gateway.json` 拿最新值。想固定就显式给一个端口。
3. **SDK 类型是本地 shim。** `src/client/dsh-client-shim.d.ts` 只声明本插件用到的成员，
   每个成员都对照过已安装的 dsh-pet / dsh-usage 源码。真正的 SDK 包装进来后应删掉它。
4. **`settings.section` 的 order 是经验值（140）。** 若与其它插件撞位，改 `SETTINGS_SECTION_ORDER` 即可。

---

## 九、命令

```bash
npm install
npm run build      # lib/index.js + lib/client.js
npm test           # 构建 + 345 条断言
npm run typecheck  # tsc --noEmit
```
