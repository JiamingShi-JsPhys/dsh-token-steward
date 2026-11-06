/**
 * Client-half structural faces of the DSH shell.
 *
 * The real SDK packages (`@deepseek-ai/dsh-client-runtime`,
 * `@deepseek-ai/dsh-client-ui-slots`) are platform externals — these minimal
 * declarations keep the client half strict-typed without importing them.
 *
 * @module client/dsh-face
 */

export interface SlotRegistration {
  readonly name: string
  readonly id: string
  readonly order?: number
}

export interface SlotsFace {
  inject(name: string, factory: () => unknown): unknown
  register(options: SlotRegistration, component: unknown): unknown
}

export interface ClientContextLike {
  slots?: SlotsFace
  inject(deps: readonly string[], cb: (scope: ClientContextLike) => void): unknown
  get<T = unknown>(name: string): T | undefined
  logger?(name: string): { info(fmt: string, ...args: unknown[]): void; warn(fmt: string, ...args: unknown[]): void }
}

/** `sidebar.footer.action` components receive `{ wide }` from the shell. */
export interface FooterActionProps {
  wide?: boolean
}
