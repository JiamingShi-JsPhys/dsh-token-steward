/**
 * 本地响应缓存：SQLite 持久化 + 内存降级。
 *
 * 语义一句话：**同一份 prompt 的 SHA-256 在 TTL 内再次出现时，直接回放
 * 上次的响应字节——不出站、不计费、不产生第二笔账。**
 *
 * 后端选择：
 *  - 宿主 Node ≥ 22.13 时用内置 `node:sqlite`（`DatabaseSync`），数据落在
 *    `$DSH_HOME/token-steward/cache.sqlite`，重启不丢；
 *  - 取不到 `node:sqlite`（老宿主）时**自动降级**为进程内 LRU，
 *    行为一致，只是不跨重启。
 *
 * 三条不缓存的硬规则由 cacheKeyOf 保证（带 tools / 超长 / 不可序列化），
 * 本文件只负责存取，不重新解释请求。
 */
import { chmod, mkdir } from 'node:fs/promises'
import type { SecretVault } from './secret-vault.ts'
import { dirname } from 'node:path'
import type { CachePolicy } from '../core/types.ts'
import { LruTtlCache } from '../core/response-cache.ts'

/** 一条可回放的响应。 */
export interface CachedResponse {
  /** 原样字节（SSE 帧序列或 JSON 文本）。 */
  body: Uint8Array
  contentType: string
  provider: string
  model: string
  /** 估算的输入/输出 token：用于「省了多少 token」。 */
  inputTokens: number
  outputTokens: number
  /** 命中时可折算的金额；未定价为 null。 */
  savedCost: { currency: string, amount: number } | null
}

/** 缓存统计（面板与测试用）。 */
export interface CacheStatsView {
  backend: 'sqlite' | 'memory' | 'off'
  hits: number
  misses: number
  size: number
  evictions: number
  /** 今日（本地时区）缓存命中省下的 token。 */
  savedTokens: number
  /** 今日省下的金额；混币或全部未定价时为 null。 */
  savedCost: { currency: string, amount: number } | null
  /** 今日命中次数（跨重启累计）。 */
  cacheHitsToday: number
}

/** 响应缓存接口（同步实现被包成异步，网关只认这一层）。 */
export interface ResponseCache {
  backend(): 'sqlite' | 'memory'
  get(key: string, now: number): Promise<CachedResponse | undefined>
  put(key: string, value: CachedResponse, now: number): Promise<void>
  stats(now: number): Promise<CacheStatsView>
  close(): Promise<void>
}

/** 本地日键：YYYY-MM-DD（用户看到的「今日」是本地日，不是 UTC）。 */
export function localDayKey(now: number): string {
  const date = new Date(now)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return String(date.getFullYear()) + '-' + month + '-' + day
}

/** 建一个响应缓存；SQLite 不可用时静默降级到内存。 */
export async function createResponseCache(options: { directory: string, policy: CachePolicy, vault?: SecretVault }): Promise<ResponseCache> {
  const filePath = options.directory + '/cache.sqlite'
  try {
    await mkdir(dirname(filePath), { recursive: true })
    const module = await import('node:sqlite')
    const cache = new SqliteResponseCache(new module.DatabaseSync(filePath), options.policy, options.vault)
    // 缓存里是模型回复原文（可能夹带用户粘贴的密钥）；文件权限跟着收紧。
    // Windows 上 chmod 基本是空操作，失败不影响使用；不 await，避免拖慢首帧。
    chmod(filePath, 0o600).catch(() => {})
    return cache
  } catch {
    return new MemoryResponseCache(options.policy)
  }
}

/** SQLite 后端。 */
class SqliteResponseCache implements ResponseCache {
  private readonly db: import('node:sqlite').DatabaseSync
  private readonly policy: CachePolicy
  private readonly vault: SecretVault | undefined
  private misses = 0

  constructor(db: import('node:sqlite').DatabaseSync, policy: CachePolicy, vault?: SecretVault) {
    this.db = db
    this.policy = policy
    this.vault = vault !== undefined && vault.available() ? vault : undefined
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec('PRAGMA busy_timeout = 3000;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS response_cache (
        key TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        content_type TEXT NOT NULL,
        body BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL,
        hits INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        saved_cost REAL,
        currency TEXT
      );
      CREATE TABLE IF NOT EXISTS cache_daily (
        day TEXT NOT NULL,
        currency TEXT NOT NULL,
        hits INTEGER NOT NULL DEFAULT 0,
        saved_tokens INTEGER NOT NULL DEFAULT 0,
        saved_cost REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (day, currency)
      );
    `)
    // 启动时清一次过期条目：TTL 之外的缓存没有任何回放价值。
    this.db.prepare('DELETE FROM response_cache WHERE created_at < ?').run(Date.now() - this.policy.ttl_ms)
  }

  backend(): 'sqlite' { return 'sqlite' }

  async get(key: string, now: number): Promise<CachedResponse | undefined> {
    const row = this.db.prepare(
      'SELECT provider, model, content_type, body, created_at, input_tokens, output_tokens, saved_cost, currency FROM response_cache WHERE key = ?',
    ).get(key)
    if (row === undefined) {
      this.misses += 1
      return undefined
    }
    const createdAt = Number(row.created_at ?? 0)
    if (now - createdAt >= this.policy.ttl_ms) {
      this.db.prepare('DELETE FROM response_cache WHERE key = ?').run(key)
      this.misses += 1
      return undefined
    }
    // 先解密再记账：密钥换了（或密文被改过）就当没命中，不能既回放又计一笔「省了钱」。
    const rawBody = row.body instanceof Uint8Array ? row.body : new Uint8Array()
    const body = this.vault === undefined ? rawBody : this.vault.openBytes(rawBody)
    if (body === undefined) {
      this.db.prepare('DELETE FROM response_cache WHERE key = ?').run(key)
      this.misses += 1
      return undefined
    }
    this.db.prepare('UPDATE response_cache SET hits = hits + 1, last_used_at = ? WHERE key = ?').run(now, key)
    const inputTokens = Number(row.input_tokens ?? 0)
    const outputTokens = Number(row.output_tokens ?? 0)
    const currency = row.currency === null || row.currency === undefined ? '' : String(row.currency)
    const savedAmount = row.saved_cost === null || row.saved_cost === undefined ? null : Number(row.saved_cost)
    this.db.prepare(`
      INSERT INTO cache_daily (day, currency, hits, saved_tokens, saved_cost)
      VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(day, currency) DO UPDATE SET
        hits = hits + 1,
        saved_tokens = saved_tokens + excluded.saved_tokens,
        saved_cost = saved_cost + excluded.saved_cost
    `).run(localDayKey(now), currency, inputTokens + outputTokens, savedAmount ?? 0)
    return {
      body,
      contentType: String(row.content_type ?? 'application/json'),
      provider: String(row.provider ?? ''),
      model: String(row.model ?? ''),
      inputTokens,
      outputTokens,
      savedCost: savedAmount === null || currency === '' ? null : { currency, amount: savedAmount },
    }
  }

  async put(key: string, value: CachedResponse, now: number): Promise<void> {
    const body = this.vault === undefined ? value.body : this.vault.sealBytes(value.body)
    this.db.prepare(`
      INSERT OR REPLACE INTO response_cache
        (key, provider, model, content_type, body, created_at, last_used_at, hits, input_tokens, output_tokens, saved_cost, currency)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
    `).run(
      key,
      value.provider,
      value.model,
      value.contentType,
      body,
      now,
      now,
      value.inputTokens,
      value.outputTokens,
      value.savedCost === null ? null : value.savedCost.amount,
      value.savedCost === null ? '' : value.savedCost.currency,
    )
    this.db.prepare('DELETE FROM response_cache WHERE created_at < ?').run(now - this.policy.ttl_ms)
    const overflow = this.size() - this.policy.max_entries
    if (overflow > 0) {
      this.db.prepare(`
        DELETE FROM response_cache WHERE key IN (
          SELECT key FROM response_cache ORDER BY last_used_at ASC LIMIT ?
        )
      `).run(overflow)
    }
  }

  private size(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM response_cache').get()
    return Number(row?.n ?? 0)
  }

  async stats(now: number): Promise<CacheStatsView> {
    const totals = this.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(hits), 0) AS hits FROM response_cache').get()
    const rows = this.db.prepare(
      'SELECT currency, SUM(hits) AS hits, SUM(saved_tokens) AS tokens, SUM(saved_cost) AS cost FROM cache_daily WHERE day = ? GROUP BY currency',
    ).all(localDayKey(now))
    let savedTokens = 0
    let cacheHitsToday = 0
    const costs = new Map<string, number>()
    for (const row of rows) {
      const currency = String(row.currency ?? '')
      savedTokens += Number(row.tokens ?? 0)
      cacheHitsToday += Number(row.hits ?? 0)
      if (currency !== '') costs.set(currency, (costs.get(currency) ?? 0) + Number(row.cost ?? 0))
    }
    return {
      backend: 'sqlite',
      hits: Number(totals?.hits ?? 0),
      misses: this.misses,
      size: Number(totals?.n ?? 0),
      evictions: 0,
      savedTokens,
      savedCost: singleCurrency(costs),
      cacheHitsToday,
    }
  }

  async close(): Promise<void> {
    try {
      this.db.close()
    } catch {
      // 已关闭（或驱动拒绝重复关闭）：没有可回收的东西了。
    }
  }
}

/** 内存后端（老宿主降级用）。 */
class MemoryResponseCache implements ResponseCache {
  private readonly lru: LruTtlCache<CachedResponse>
  private savedTokens = 0
  private savedCosts = new Map<string, number>()
  private cacheHitsToday = 0
  private day = ''

  constructor(policy: CachePolicy) {
    this.lru = new LruTtlCache<CachedResponse>({ maxEntries: policy.max_entries, ttlMs: policy.ttl_ms })
  }

  backend(): 'memory' { return 'memory' }

  async get(key: string, now: number): Promise<CachedResponse | undefined> {
    this.rollDay(now)
    const hit = this.lru.get(key, now)
    if (hit === undefined) return undefined
    this.cacheHitsToday += 1
    this.savedTokens += hit.inputTokens + hit.outputTokens
    if (hit.savedCost !== null) {
      this.savedCosts.set(hit.savedCost.currency, (this.savedCosts.get(hit.savedCost.currency) ?? 0) + hit.savedCost.amount)
    }
    return hit
  }

  async put(key: string, value: CachedResponse, now: number): Promise<void> {
    this.lru.put(key, value, now)
  }

  async stats(now: number): Promise<CacheStatsView> {
    this.rollDay(now)
    const base = this.lru.stats()
    return {
      backend: 'memory',
      hits: base.hits,
      misses: base.misses,
      size: base.size,
      evictions: base.evictions,
      savedTokens: this.savedTokens,
      savedCost: singleCurrency(this.savedCosts),
      cacheHitsToday: this.cacheHitsToday,
    }
  }

  async close(): Promise<void> {}

  private rollDay(now: number): void {
    const day = localDayKey(now)
    if (this.day === '') {
      this.day = day
      return
    }
    if (day !== this.day) {
      this.day = day
      this.savedTokens = 0
      this.savedCosts = new Map()
      this.cacheHitsToday = 0
    }
  }
}

/** 只有单一币种时才给出总额；混币返回 null，绝不把两种货币相加。 */
function singleCurrency(costs: Map<string, number>): { currency: string, amount: number } | null {
  if (costs.size === 0) return null
  if (costs.size > 1) return null
  const [currency, amount] = [...costs.entries()][0] as [string, number]
  return { currency, amount: Math.round(amount * 1e6) / 1e6 }
}

/** 测试用：一个永远可用的内存缓存。 */
export function createMemoryCache(policy: CachePolicy): ResponseCache {
  return new MemoryResponseCache(policy)
}
