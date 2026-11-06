/**
 * 测试夹具：一棵覆盖三种模式差异的矩阵。
 *
 * 刻意让「便宜但慢」「快但弱」「贵但全能」三类同时存在，
 * 这样任一模式选错了都能立刻被断言抓到。
 */
import type { ModelEntry, PoolConfig, ProviderEntry, RouteIntent } from '../src/core/types.ts'
import { DEFAULT_CACHE } from '../src/core/pool-schema.ts'

/** 一个模型的缺省字段，测试里只写关心差异的部分。 */
export function model(overrides: Partial<ModelEntry> & Pick<ModelEntry, 'id'>): ModelEntry {
  return {
    id: overrides.id,
    display_name: overrides.display_name ?? overrides.id,
    capabilities: overrides.capabilities ?? ['coding'],
    cost_level: overrides.cost_level ?? 'medium',
    context_window: overrides.context_window ?? 128_000,
    max_output_tokens: overrides.max_output_tokens ?? 8_192,
    availability: overrides.availability ?? 'direct',
    input_modalities: overrides.input_modalities ?? ['text'],
    max_concurrency: overrides.max_concurrency ?? 4,
    quality_rank: overrides.quality_rank ?? 50,
    tags: overrides.tags ?? {},
    ...(overrides.proxy_url === undefined ? {} : { proxy_url: overrides.proxy_url }),
    ...(overrides.rpm === undefined ? {} : { rpm: overrides.rpm }),
    ...(overrides.pricing === undefined ? {} : { pricing: overrides.pricing }),
  }
}

/** 一个 provider 的缺省字段。 */
export function provider(name: string, models: ModelEntry[], overrides: Partial<ProviderEntry> = {}): ProviderEntry {
  return {
    provider_name: name,
    endpoint: overrides.endpoint ?? 'https://' + name + '.example/v1',
    api: 'openai-completions',
    api_key: overrides.api_key ?? 'env:' + name.toUpperCase() + '_API_KEY',
    headers: overrides.headers ?? {},
    models,
    ...(overrides.timeout_ms === undefined ? {} : { timeout_ms: overrides.timeout_ms }),
  }
}

/** 一棵四模型矩阵：free 慢、fast 中、全能贵、超大窗口贵。 */
export function matrix(): PoolConfig {
  return {
    version: 1,
    defaults: {
      timeout_ms: 60_000,
      max_attempts: 3,
      cooldown_ms: 30_000,
      failure_threshold: 3,
      half_open_after_ms: 60_000,
    },
    routing: { mode: 'frugal', aliases: {}, agent_overrides: {}, cache: { ...DEFAULT_CACHE } },
    providers: [
      provider('freebox', [
        model({
          id: 'free-slow',
          capabilities: ['coding'],
          cost_level: 'free',
          quality_rank: 30,
        }),
      ]),
      provider('midbox', [
        model({
          id: 'fast-mid',
          capabilities: ['coding', 'fast', 'tool-use'],
          cost_level: 'medium',
          quality_rank: 55,
        }),
      ]),
      provider('premium', [
        model({
          id: 'omni-pro',
          capabilities: ['coding', 'reasoning', 'vision', 'tool-use', 'long-context'],
          cost_level: 'high',
          quality_rank: 100,
          context_window: 1_000_000,
          input_modalities: ['text', 'image'],
        }),
      ]),
      provider('huge', [
        model({
          id: 'huge-window',
          capabilities: ['coding', 'long-context'],
          cost_level: 'high',
          quality_rank: 70,
          context_window: 2_000_000,
        }),
      ]),
    ],
  }
}

/** 一份最小的路由意图：只要求 coding。 */
export function intent(overrides: Partial<RouteIntent> = {}): RouteIntent {
  return {
    requiredCapabilities: overrides.requiredCapabilities ?? ['coding'],
    requiredModalities: overrides.requiredModalities ?? ['text'],
    estimatedInputTokens: overrides.estimatedInputTokens ?? 1_000,
    expectedOutputTokens: overrides.expectedOutputTokens ?? 1_000,
    needsTools: overrides.needsTools ?? false,
    stream: overrides.stream ?? true,
    burstKey: overrides.burstKey ?? 'burst-0',
    ...(overrides.aliasName === undefined ? {} : { aliasName: overrides.aliasName }),
  }
}
