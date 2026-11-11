/**
 * 从输入框里「模型选择」当前显示的模型名，立刻读出档位。
 *
 * 为什么要在前端读：网关只有在请求到达时才知道这一轮用的是哪个虚拟模型，
 * 于是「选了管家·免费档」到「面板显示免费档」之间要等一次对话。用户要的是点完立刻同步，
 * 所以这里直接看模型选择器上的字。
 *
 * 只认管家自己的模型名：设置页里也有「免费档」这种按钮，不能误判。
 */
import type { RoutingMode } from '../core/types.ts'

/** 管家模型名（中/英/虚拟 id 三种写法都认）。 */
const STEWARD_LABEL = /管家|steward/iu

/** 一个模型名对应哪一档；`自动` 与 `子代理` 都不改档（前者跟全局档位，后者不是模式）。 */
export function modeOfModelLabel(label: string): RoutingMode | undefined {
  const text = label.trim()
  if (text === '' || text.length > 32 || !STEWARD_LABEL.test(text)) return undefined
  if (/免费档|freeload/iu.test(text)) return 'free'
  if (/最强火力|max[\s_-]*power/iu.test(text)) return 'max_power'
  if (/效率优先|balanced/iu.test(text)) return 'balanced'
  if (/极致便宜|frugal/iu.test(text)) return 'frugal'
  return undefined
}

/**
 * 读输入框里当前选中的管家模型对应的档位。
 * @param doc - 便于测试注入；缺省用当前文档。
 * @returns 档位；选的是「自动 / 子代理 / 非管家模型」时是 undefined。
 */
export function readComposerMode(doc: Document = document): RoutingMode | undefined {
  // 极简宿主（测试里的假 DOM）没有 querySelectorAll，直接当作「读不到」。
  if (typeof doc?.querySelectorAll !== 'function') return undefined
  let best: { mode: RoutingMode, y: number } | undefined
  for (const button of Array.from(doc.querySelectorAll('button'))) {
    const label = (button.textContent ?? '').trim()
    const mode = modeOfModelLabel(label)
    if (mode === undefined) continue
    const rect = button.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) continue
    // 同一个名字可能在别处也出现（例如设置页的档位说明），取最靠下的那个——输入框在页面底部。
    if (best === undefined || rect.y > best.y) best = { mode, y: rect.y }
  }
  return best?.mode
}
