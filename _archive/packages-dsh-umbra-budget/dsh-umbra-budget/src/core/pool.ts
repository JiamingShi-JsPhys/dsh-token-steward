/**
 * model_pool.yaml → `ModelPool` normalization.
 *
 * Fail-closed: every problem is collected; ANY problem refuses the whole
 * document (the previous pool stays active) — a half-applied matrix must
 * never route traffic surprisingly. Mirrors dsh-provider-proxy's semantics.
 *
 * Pure module: the host passes the already-parsed YAML object and an env map.
 *
 * @module core/pool
 */
import { resolveEnvRef } from './keys.ts'
import {
  ALL_CAPABILITIES,
  COST_RANK,
  type AuthStyle,
  type Capability,
  type CostLevel,
  type ModelPool,
  type ModelPricing,
  type PoolModel,
  type RoutingPolicy,
  type ScheduleMode,
  SCHEDULE_MODES,
} from './types.ts'

export interface NormalizeResult {
  readonly pool?: ModelPool
  readonly errors: readonly string[]
}

const COST_LEVELS: readonly CostLevel[] = ['free', 'low', 'medium', 'high']
const AUTH_STYLES: readonly AuthStyle[] = ['bearer', 'x-api-key', 'api-key']

// ----------------------------------------------------------------------
// narrow helpers
// ----------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

// ----------------------------------------------------------------------
// defaults
// ----------------------------------------------------------------------

export function defaultPolicy(): RoutingPolicy {
  return {
    mode: 'frugal',
    classifier: { trivialMaxChars: 2_000, heavyMinChars: 60_000, heavyTools: true },
    fallback: { maxRetries: 2, cooldownMs: 30_000, rateLimitMs: 60_000 },
    scatter: { efficiencyMinInflight: 2 },
    cache: { exactMatch: false },
  }
}

// ----------------------------------------------------------------------
// normalization
// ----------------------------------------------------------------------

export function normalizePool(doc: unknown, env: Readonly<Record<string, string | undefined>>, now = Date.now()): NormalizeResult {
  const errors: string[] = []
  const fail = (message: string): void => {
    errors.push(message)
  }

  if (!isRecord(doc)) {
    return { errors: ['model_pool.yaml: 根节点必须是映射'] }
  }
  if (doc.version !== undefined && doc.version !== 1) {
    fail(`version: 仅支持 1，得到 ${JSON.stringify(doc.version)}`)
  }

  // ---- routing policy ----
  const defaults = defaultPolicy()
  let policy: RoutingPolicy = defaults
  const rawRouting = doc.routing
  if (rawRouting !== undefined) {
    if (!isRecord(rawRouting)) {
      fail('routing: 必须是映射')
    } else {
      const mode = asString(rawRouting.mode) as ScheduleMode | undefined
      if (mode !== undefined && !SCHEDULE_MODES.includes(mode)) {
        fail(`routing.mode: 必须是 ${SCHEDULE_MODES.join(' | ')}，得到 ${JSON.stringify(rawRouting.mode)}`)
      }
      const classifier = isRecord(rawRouting.classifier) ? rawRouting.classifier : {}
      const fallback = isRecord(rawRouting.fallback) ? rawRouting.fallback : {}
      const scatter = isRecord(rawRouting.scatter) ? rawRouting.scatter : {}
      const cache = isRecord(rawRouting.cache) ? rawRouting.cache : {}
      policy = {
        mode: mode ?? defaults.mode,
        classifier: {
          trivialMaxChars: asNumber(classifier.trivial_max_chars, defaults.classifier.trivialMaxChars),
          heavyMinChars: asNumber(classifier.heavy_min_chars, defaults.classifier.heavyMinChars),
          heavyTools: asBool(classifier.heavy_tools, defaults.classifier.heavyTools),
        },
        fallback: {
          maxRetries: Math.max(0, Math.floor(asNumber(fallback.max_retries, defaults.fallback.maxRetries))),
          cooldownMs: Math.max(0, asNumber(fallback.cooldown_ms, defaults.fallback.cooldownMs)),
          rateLimitMs: Math.max(0, asNumber(fallback.rate_limit_429_ms, defaults.fallback.rateLimitMs)),
        },
        scatter: {
          efficiencyMinInflight: Math.max(1, Math.floor(asNumber(scatter.efficiency_min_inflight, defaults.scatter.efficiencyMinInflight))),
        },
        cache: { exactMatch: asBool(cache.exact_match, defaults.cache.exactMatch) },
      }
    }
  }

  // ---- defaults block ----
  const rawDefaults = isRecord(doc.defaults) ? doc.defaults : {}
  const defaultCost = asString(rawDefaults.cost_level) as CostLevel | undefined
  if (defaultCost !== undefined && !COST_LEVELS.includes(defaultCost)) {
    fail(`defaults.cost_level: 必须是 ${COST_LEVELS.join(' | ')}`)
  }
  const defaultAvailability = asString(rawDefaults.availability)

  // ---- providers / models ----
  const models: PoolModel[] = []
  const seen = new Set<string>()
  const rawProviders = doc.providers
  if (!isRecord(rawProviders)) {
    fail('providers: 必须是映射（至少声明一个 provider）')
  } else {
    const providerNames = Object.keys(rawProviders)
    if (providerNames.length === 0) {
      fail('providers: 至少声明一个 provider')
    }
    for (const provider of providerNames) {
      const rawProvider = rawProviders[provider]
      if (!isRecord(rawProvider)) {
        fail(`providers.${provider}: 必须是映射`)
        continue
      }
      const rawModels = rawProvider.models
      if (!isRecord(rawModels)) {
        fail(`providers.${provider}.models: 必须是映射`)
        continue
      }
      for (const model of Object.keys(rawModels)) {
        const raw = rawModels[model]
        if (!isRecord(raw)) {
          fail(`providers.${provider}.models.${model}: 必须是映射`)
          continue
        }
        const notes: string[] = []
        const id = `${provider}/${model}`
        if (seen.has(id)) {
          fail(`模型 id 重复: ${id}`)
          continue
        }
        seen.add(id)

        // tags
        const rawTags = isRecord(raw.tags) ? raw.tags : {}
        const rawCaps = rawTags.capabilities
        const capabilities: Capability[] = []
        if (rawCaps === undefined) {
          notes.push('未声明 capabilities — 该模型不会参与任何能力匹配')
        } else if (Array.isArray(rawCaps)) {
          for (const cap of rawCaps) {
            if (typeof cap === 'string' && (ALL_CAPABILITIES as readonly string[]).includes(cap)) {
              capabilities.push(cap as Capability)
            } else {
              fail(`providers.${provider}.models.${model}.tags.capabilities: 未知能力 ${JSON.stringify(cap)}（可选: ${ALL_CAPABILITIES.join(', ')}）`)
            }
          }
        } else {
          fail(`providers.${provider}.models.${model}.tags.capabilities: 必须是数组`)
        }
        const costLevel = (asString(rawTags.cost_level) ?? asString(raw.cost_level) ?? defaultCost ?? 'medium') as CostLevel
        if (!COST_LEVELS.includes(costLevel)) {
          fail(`providers.${provider}.models.${model}: cost_level 必须是 ${COST_LEVELS.join(' | ')}，得到 ${JSON.stringify(costLevel)}`)
          continue
        }
        if (COST_RANK[costLevel] === undefined) {
          fail(`providers.${provider}.models.${model}: cost_level 内部错误`)
          continue
        }
        const contextWindow = asNumber(rawTags.context_window, 0)
        if (contextWindow <= 0) {
          fail(`providers.${provider}.models.${model}.tags.context_window: 必须是正数（token 数）`)
          continue
        }
        const availability = (asString(rawTags.availability) ?? defaultAvailability ?? 'direct') as 'direct' | 'proxy'
        if (availability !== 'direct' && availability !== 'proxy') {
          fail(`providers.${provider}.models.${model}: availability 必须是 direct | proxy`)
          continue
        }

        // B-track wiring
        const endpoint = asString(raw.endpoint)
        if (endpoint !== undefined) {
          try {
            const parsed = new URL(endpoint)
            if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
              fail(`providers.${provider}.models.${model}.endpoint: 仅支持 http(s)，得到 ${parsed.protocol}`)
              continue
            }
          } catch {
            fail(`providers.${provider}.models.${model}.endpoint: 不是合法 URL: ${JSON.stringify(endpoint)}`)
            continue
          }
        }
        const authStyleRaw = (asString(raw.auth_style) ?? 'bearer') as AuthStyle
        if (!AUTH_STYLES.includes(authStyleRaw)) {
          fail(`providers.${provider}.models.${model}.auth_style: 必须是 ${AUTH_STYLES.join(' | ')}`)
          continue
        }
        let apiKey: string | undefined
        const keyRef = asString(raw.api_key_ref)
        if (keyRef !== undefined) {
          apiKey = resolveEnvRef(keyRef, env)
          if (apiKey === undefined) notes.push(`环境变量未设置: ${keyRef}`)
        } else if (raw.api_key !== undefined) {
          fail(`providers.${provider}.models.${model}.api_key: 禁止明文密钥，使用 api_key_ref: env:NAME`)
          continue
        }
        if (endpoint !== undefined && apiKey === undefined) {
          notes.push('B 轨条目缺少可用密钥 — 路由将跳过该模型')
        }
        const proxy = asString(raw.proxy)
        if (proxy !== undefined) {
          try {
            const parsed = new URL(proxy)
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
              fail(`providers.${provider}.models.${model}.proxy: 仅支持 http(s) 代理`)
              continue
            }
          } catch {
            fail(`providers.${provider}.models.${model}.proxy: 不是合法 URL`)
            continue
          }
        }
        const headers: Record<string, string> = {}
        if (raw.headers !== undefined) {
          if (!isRecord(raw.headers)) {
            fail(`providers.${provider}.models.${model}.headers: 必须是映射`)
            continue
          }
          for (const [name, value] of Object.entries(raw.headers)) {
            if (typeof value !== 'string' || name.trim() === '') {
              fail(`providers.${provider}.models.${model}.headers.${name}: 必须是非空字符串`)
            } else {
              headers[name.trim()] = value
            }
          }
        }

        // pricing
        let pricing: ModelPricing | undefined
        if (raw.pricing !== undefined) {
          if (!isRecord(raw.pricing)) {
            fail(`providers.${provider}.models.${model}.pricing: 必须是映射`)
            continue
          }
          const input = asNumber(raw.pricing.input, Number.NaN)
          const output = asNumber(raw.pricing.output, Number.NaN)
          if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) {
            fail(`providers.${provider}.models.${model}.pricing: input/output 必须是非负数字（每百万 token 单价）`)
            continue
          }
          pricing = {
            currency: asString(raw.pricing.currency) ?? 'CNY',
            input,
            output,
            ...(asNumber(raw.pricing.cache_read, -1) >= 0 ? { cacheRead: asNumber(raw.pricing.cache_read, 0) } : {}),
            ...(asNumber(raw.pricing.cache_write, -1) >= 0 ? { cacheWrite: asNumber(raw.pricing.cache_write, 0) } : {}),
          }
        }

        const enabled = asBool(rawTags.enabled ?? raw.enabled, true)
        models.push({
          id,
          provider,
          model,
          tags: { capabilities, costLevel, contextWindow, availability },
          ...(pricing !== undefined ? { pricing } : {}),
          enabled,
          ...(endpoint !== undefined ? { endpoint } : {}),
          ...(apiKey !== undefined ? { apiKey } : {}),
          authStyle: authStyleRaw,
          ...(proxy !== undefined ? { proxy } : {}),
          headers,
          configured: endpoint === undefined ? true : apiKey !== undefined,
          configNotes: notes,
        })
      }
    }
  }

  if (errors.length > 0) {
    return { errors }
  }
  return {
    pool: {
      version: 1,
      models,
      policy,
      loadedAt: now,
    },
    errors: [],
  }
}

/** Models eligible for one call: enabled, configured, capability- and window-satisfying. */
export function eligibleModels(pool: ModelPool, required: readonly Capability[], minContextWindow: number): PoolModel[] {
  return pool.models.filter(
    (model) =>
      model.enabled &&
      model.configured &&
      required.every((cap) => model.tags.capabilities.includes(cap)) &&
      model.tags.contextWindow >= minContextWindow,
  )
}
