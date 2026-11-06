/**
 * Fan-out bus for live control-panel frames (SSE payloads).
 * Host-side components publish; the routes layer fans out to subscribers.
 *
 * @module host/frames
 */
import type { RouteEventFrame, RouteEventKind } from '../core/types.ts'

export class FrameBus {
  private rev = 0
  private readonly subscribers = new Set<(frame: RouteEventFrame) => void>()

  publish(kind: RouteEventKind, extra: Partial<Omit<RouteEventFrame, 'rev' | 'kind'>> = {}): void {
    this.rev += 1
    const frame = { rev: this.rev, ts: Date.now(), kind, ...extra } as RouteEventFrame
    for (const send of this.subscribers) {
      try {
        send(frame)
      } catch {
        /* subscriber cleanup happens on disconnect */
      }
    }
  }

  subscribe(send: (frame: RouteEventFrame) => void): () => void {
    this.subscribers.add(send)
    return () => {
      this.subscribers.delete(send)
    }
  }

  get subscriberCount(): number {
    return this.subscribers.size
  }
}
