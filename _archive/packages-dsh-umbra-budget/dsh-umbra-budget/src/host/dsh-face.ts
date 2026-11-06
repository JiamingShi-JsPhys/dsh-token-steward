/**
 * Structural faces of the DSH host the plugin talks to.
 *
 * The SDK packages (`@deepseek-ai/dsh-llm`, `@deepseek-ai/cordis`, …) are peer
 * runtime dependencies that are NOT vendored here; these minimal structural
 * declarations keep the host half strict-typed without importing them. Any
 * mismatch surfaces at runtime capability checks, not at compile time.
 *
 * @module host/dsh-face
 */

/** `LlmCallConfig` + `GenerateOptions` subset the harness passes through the waterfall. */
export interface GenerateOptionsLike {
  provider?: string
  model?: string
  messages?: unknown
  tools?: unknown
  system?: unknown
  reasoningEffort?: string
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
  [key: string]: unknown
}

/** Stream chunk shapes observed in reference code (verification-runner.ts). */
export type StreamChunkLike =
  | { type: 'text-delta'; text: string }
  | { type: 'usage'; usage: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } }
  | { type: 'finish'; reason: string }
  | { type: string; [key: string]: unknown }

/** The public `llm` service face (documented as replaceable instance property). */
export interface LlmServiceFace {
  stream(options: GenerateOptionsLike): AsyncIterable<StreamChunkLike>
  prepareCall?(config: { provider: string; model: string; reasoningEffort?: string; temperature?: number; maxTokens?: number }, signal?: AbortSignal): Promise<{
    config: Record<string, unknown>
    stream(request: Record<string, unknown>): AsyncIterable<StreamChunkLike>
  }>
  listProviders?(): Array<{ id: string; name: string }>
  listConfigurableProviders?(): Array<{ provider: string; displayName: string }>
}

export interface LoggerFace {
  info(fmt: string, ...args: unknown[]): void
  warn(fmt: string, ...args: unknown[]): void
  error(fmt: string, ...args: unknown[]): void
}

export interface IncomingMessageLike {
  method?: string
  url?: string
  headers: Record<string, string | string[] | undefined>
  socket?: { remoteAddress?: string }
  on(event: 'data' | 'end' | 'error' | 'close', cb: (chunk?: unknown) => void): unknown
}

export interface ServerResponseLike {
  writeHead(status: number, headers: Record<string, string>): unknown
  write(chunk: string): unknown
  end(chunk?: string): unknown
  on(event: 'close' | 'error', cb: () => void): unknown
  destroyed?: boolean
}

export interface WebRoute {
  kind: string
  path: string
  handler(req: IncomingMessageLike, res: ServerResponseLike): Promise<void> | void
}

export interface WebServerFace {
  register(route: WebRoute): unknown
}

/** Minimal cordis context face used by the host half. */
export interface HostContextFace {
  logger(name: string): LoggerFace
  on(event: string, listener: (...args: never[]) => unknown): unknown
  get<T = unknown>(name: string): T | undefined
  effect(fn: () => () => void): unknown
  inject?(deps: readonly string[], cb: (scope: HostContextFace) => void): unknown
}
