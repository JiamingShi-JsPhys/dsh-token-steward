/**
 * umbra-budget client half — registers the console overlay + the footer
 * toggle button via the slot registry (declared by the official ui-layout).
 *
 * @module client/index
 */
import type { ClientContextLike } from './dsh-face.ts'
import { Console } from './Console.tsx'
import { injectConsoleStyle } from './console-css.ts'
import { FooterButton } from './FooterButton.tsx'

export const name = 'dsh-umbra-budget'

export const inject = ['slots'] as const

export function apply(ctx: ClientContextLike): void {
  ctx.inject(['slots'], (scope: ClientContextLike) => {
    const slots = scope.slots
    if (slots === undefined) return

    const disposeStyle = injectConsoleStyle()

    const disposeOverlay = slots.inject('shell.overlay', () => slots.register({ name: 'shell.overlay', id: 'umbra-budget' }, Console)) as
      | (() => void)
      | undefined
    const disposeFooter = slots.inject('sidebar.footer.action', () =>
      slots.register({ name: 'sidebar.footer.action', id: 'umbra-budget', order: 90 }, FooterButton),
    ) as (() => void) | undefined

    return () => {
      disposeStyle()
      disposeOverlay?.()
      disposeFooter?.()
    }
  })
}
