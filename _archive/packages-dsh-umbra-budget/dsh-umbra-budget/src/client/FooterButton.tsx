/**
 * Sidebar footer action — the console toggle button (dsh-web-files pattern:
 * footer action opens a shell.overlay panel).
 *
 * @module client/FooterButton.tsx
 */
import { useEffect, useState } from 'react'
import { isConsoleOpen, subscribeConsoleOpen, toggleConsole } from './console-open.ts'
import type { FooterActionProps } from './dsh-face.ts'
import { styles } from './console-classes.ts'

export function FooterButton(props: FooterActionProps): JSX.Element {
  const [open, setOpen] = useState(isConsoleOpen())
  useEffect(() => subscribeConsoleOpen(setOpen), [])
  return (
    <button
      className={`${styles.footerButton} ${open ? styles.footerButtonActive : ''}`}
      title="模型矩阵调度中枢"
      onClick={() => toggleConsole()}
    >
      {props.wide === true ? 'UMBRA' : '◆'}
    </button>
  )
}
