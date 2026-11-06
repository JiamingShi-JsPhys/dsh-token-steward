/**
 * 分段控件：一排按钮共享一个滑动高亮。
 *
 * 与 @linxin666 全家桶的 SegmentGroup 同构：调用方把当前项标成 data-active，
 * 本组件测量它的盒模型并写成四个自定义属性，样式表据此画高亮。
 * 用 ResizeObserver 重测，因此语言切换、字体加载、容器变宽都能跟上。
 */
import { Children, useLayoutEffect, useRef, type HTMLAttributes, type ReactNode } from 'react'
import css from '../steward.module.css'

/** 已放置高亮的标记属性。 */
const PILL_ATTR = 'data-pill'

/** 当前项的选择器（相对分组）。 */
const ACTIVE_SELECTOR = ':scope > [data-active="true"]'

/** 写进分组的四个自定义属性。 */
const PILL_PROPERTIES = ['--segment-pill-x', '--segment-pill-y', '--segment-pill-w', '--segment-pill-h'] as const

/** 把高亮放到当前项的位置上。 */
function placePill(group: HTMLElement): void {
  const item = group.querySelector<HTMLElement>(ACTIVE_SELECTOR)
  const box = group.getBoundingClientRect()
  if (item === null || group.offsetWidth === 0 || box.width === 0) {
    group.removeAttribute(PILL_ATTR)
    for (const property of PILL_PROPERTIES) group.style.removeProperty(property)
    return
  }
  const scale = box.width / group.offsetWidth
  const itemBox = item.getBoundingClientRect()
  const values = [
    (itemBox.left - box.left) / scale - group.clientLeft,
    (itemBox.top - box.top) / scale - group.clientTop,
    itemBox.width / scale,
    itemBox.height / scale,
  ]
  values.forEach((value, index) => {
    group.style.setProperty(PILL_PROPERTIES[index] as string, String(Math.round(value * 100) / 100) + 'px')
  })
  if (!group.hasAttribute(PILL_ATTR)) group.setAttribute(PILL_ATTR, '')
}

/** 分段控件。 */
export function SegmentGroup(props: HTMLAttributes<HTMLDivElement> & { children: ReactNode }): ReactNode {
  const { children, className, ...rest } = props
  const group = useRef<HTMLDivElement | null>(null)
  const count = Children.count(children)

  // 每一帧渲染后重放：按下时高亮与标记在同一帧内一起移动。
  useLayoutEffect(() => {
    if (group.current !== null) placePill(group.current)
  })

  useLayoutEffect(() => {
    const element = group.current
    if (element === null || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(() => { placePill(element) })
    observer.observe(element)
    for (const item of Array.from(element.children)) observer.observe(item)
    return () => { observer.disconnect() }
  }, [count])

  return (
    <div {...rest} ref={group} className={className === undefined ? css.segmentGroup : css.segmentGroup + ' ' + className}>
      {children}
    </div>
  )
}
