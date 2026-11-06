/**
 * 内置头像清单：每家厂商一张 AI 娘立绘。
 *
 * **素材致谢**：立绘来自 B 站 UP 主 **@zipzippipe** 的图文作品
 * （https://space.bilibili.com/ ，按其发布顺序对应各家模型）。
 * 版权归原作者所有；本项目只是本地展示，不再分发到其它渠道。
 *
 * 文件存于 assets/avatars/vendor-<id>.png，由宿主路由
 * api/token-steward/avatar?id=vendor-<id> 提供。
 */

export const BUNDLED_VENDOR_AVATARS: ReadonlySet<string> = new Set([
  'alibaba',
  'anthropic',
  'deepseek',
  'doubao',
  'google',
  'inkling',
  'meta',
  'minimax',
  'mistral',
  'moonshot',
  'openai',
  'stepfun',
  'xai',
  'xiaomi',
  'zhipu',
])

/** 一个厂商的内置头像 URL；没有时 undefined（组件走字母几何兜底）。 */
export function bundledAvatarUrl(vendorId: string): string | undefined {
  return BUNDLED_VENDOR_AVATARS.has(vendorId) ? 'api/token-steward/avatar?id=' + encodeURIComponent('vendor-' + vendorId) : undefined
}
