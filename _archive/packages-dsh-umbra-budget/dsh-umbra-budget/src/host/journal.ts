/**
 * Route journal — the routing monitor's data source.
 *
 * Keeps a ring of recent `RouteDecision`s (mutated in place when failover
 * swaps models mid-call), a best-effort session→model attribution map fed by
 * `session/event`, and a change callback for SSE fan-out.
 *
 * @module host/journal
 */
import type { AgentAssignmentView, RouteDecision, ScheduleMode, TaskClass } from '../core/types.ts'

interface MutableDecision {
  readonly ts: number
  readonly mode: ScheduleMode
  readonly taskClass: TaskClass
  readonly totalChars: number
  readonly requested: { provider?: string; model?: string }
  readonly chain: RouteDecision['chain']
  chosen: string
  finalModel?: string
  fallbackOf?: string
  fallbacks: number
  reason: string
}

export class RouteJournal {
  private readonly limit: number
  private readonly decisions = new Map<number, MutableDecision>()
  private order: number[] = []
  private counter = 0
  private readonly listeners = new Set<(decision: RouteDecision) => void>()
  private readonly sessionRoutes = new WeakMap<object, { provider: string; model: string }>()
  private readonly agentAssignments = new Map<string, { modelId: string; since: number }>()

  constructor(limit = 50) {
    this.limit = limit
  }

  /** Allocate an id, store the initial decision, emit it. */
  open(params: {
    ts: number
    mode: ScheduleMode
    taskClass: TaskClass
    totalChars: number
    requested: { provider?: string; model?: string }
    chain: RouteDecision['chain']
    chosen: string
    reason: string
  }): number {
    const id = ++this.counter
    this.decisions.set(id, { ...params, fallbacks: 0 })
    this.pushOrder(id)
    this.emit(id)
    return id
  }

  update(id: number, patch: Partial<Pick<MutableDecision, 'chosen' | 'finalModel' | 'fallbackOf' | 'fallbacks' | 'reason'>>): void {
    const decision = this.decisions.get(id)
    if (decision === undefined) return
    Object.assign(decision, patch)
    this.emit(id)
  }

  recent(limit = 50): RouteDecision[] {
    return this.order
      .slice(-limit)
      .reverse()
      .map((id) => this.decisions.get(id))
      .filter((decision): decision is MutableDecision => decision !== undefined)
      .map(freezeDecision)
  }

  onUpdate(listener: (decision: RouteDecision) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  // ---- session attribution (best effort; probe P2 decides the final shape) ----

  noteRequestRoute(session: unknown, provider: string | undefined, model: string | undefined): void {
    if (session === null || typeof session !== 'object') return
    if (provider === undefined || model === undefined) return
    this.sessionRoutes.set(session, { provider, model })
    const key = `session:${this.sessionLabel(session)}`
    const modelId = `${provider}/${model}`
    const existing = this.agentAssignments.get(key)
    if (existing === undefined || existing.modelId !== modelId) {
      this.agentAssignments.set(key, { modelId, since: Date.now() })
    }
  }

  noteSubagentCatalog(data: unknown): void {
    // Best effort: accept `Agent[]` or `{agents: Agent[]}` with id/sessionId + name/agent.
    const list = Array.isArray(data) ? data : (data as Record<string, unknown> | null)?.agents
    if (!Array.isArray(list)) return
    for (const entry of list) {
      if (entry === null || typeof entry !== 'object') continue
      const record = entry as Record<string, unknown>
      const name = typeof record.name === 'string' ? record.name : typeof record.agent === 'string' ? record.agent : undefined
      const sessionId = typeof record.sessionId === 'string' ? record.sessionId : typeof record.id === 'string' ? record.id : undefined
      if (name === undefined || sessionId === undefined) continue
      const key = `agent:${sessionId}`
      if (!this.agentAssignments.has(key)) {
        this.agentAssignments.set(key, { modelId: name, since: Date.now() })
      }
    }
  }

  assignments(limit = 12): AgentAssignmentView[] {
    return [...this.agentAssignments.entries()]
      .sort((left, right) => right[1].since - left[1].since)
      .slice(0, limit)
      .map(([key, value]) => ({ agent: key.split(':', 2)[1] ?? key, modelId: value.modelId, since: value.since }))
  }

  private sessionLabel(session: object): string {
    const id = (session as { id?: unknown }).id
    return typeof id === 'string' && id !== '' ? id.slice(0, 12) : Object.prototype.toString.call(session).slice(8, -1)
  }

  private pushOrder(id: number): void {
    this.order.push(id)
    if (this.order.length > this.limit) {
      const dropped = this.order.splice(0, this.order.length - this.limit)
      for (const key of dropped) this.decisions.delete(key)
    }
  }

  private emit(id: number): void {
    const decision = this.decisions.get(id)
    if (decision === undefined) return
    const frozen = freezeDecision(decision)
    for (const listener of this.listeners) {
      try {
        listener(frozen)
      } catch {
        /* listener failures never break the journal */
      }
    }
  }
}

function freezeDecision(decision: MutableDecision): RouteDecision {
  return {
    ts: decision.ts,
    mode: decision.mode,
    taskClass: decision.taskClass,
    totalChars: decision.totalChars,
    requested: decision.requested,
    chain: decision.chain,
    chosen: decision.chosen,
    ...(decision.finalModel !== undefined ? { finalModel: decision.finalModel } : {}),
    ...(decision.fallbackOf !== undefined ? { fallbackOf: decision.fallbackOf } : {}),
    fallbacks: decision.fallbacks,
    reason: decision.reason,
  }
}
