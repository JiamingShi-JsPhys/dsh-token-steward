/**
 * Shared open/close store between the sidebar footer button and the
 * shell.overlay console (dsh-web-files' globalThis pattern, kept minimal).
 *
 * @module client/console-open
 */
type Listener = (open: boolean) => void

let open = false
const listeners = new Set<Listener>()

export function isConsoleOpen(): boolean {
  return open
}

export function setConsoleOpen(next: boolean): void {
  if (open === next) return
  open = next
  for (const listener of listeners) {
    try {
      listener(open)
    } catch {
      /* listener failures never break the store */
    }
  }
}

export function toggleConsole(): void {
  setConsoleOpen(!open)
}

export function subscribeConsoleOpen(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
