/**
 * M1 端到端探针：用宿主机自带的 yaml 解析 model_pool.example.yaml，
 * 再过一遍 pool-schema。验证「示例文件就是合法配置」，而不是文档里的口头承诺。
 */
import { readFileSync } from 'node:fs'
import { parsePool } from '../src/core/pool-schema.ts'

const YAML_PATH = process.env.YAML_LIB
const { parse } = await import(YAML_PATH)

const raw = readFileSync(process.env.POOL_FILE, 'utf8')
const decoded = parse(raw)
const result = parsePool(decoded)

if (!result.ok) {
  console.log('REJECTED:')
  for (const d of result.diagnostics) console.log('  ' + d.path + ': ' + d.message)
  process.exit(1)
}

const cfg = result.config
console.log('PASS — 示例文件是合法配置')
console.log('  version:', cfg.version, '| mode:', cfg.routing.mode, '| aliases:', Object.keys(cfg.routing.aliases).length, '| agent_overrides:', Object.keys(cfg.routing.agent_overrides).length)
console.log('  defaults:', JSON.stringify(cfg.defaults))
for (const p of cfg.providers) {
  console.log('  provider:', p.provider_name, '| endpoint:', p.endpoint, '| models:', p.models.length)
  for (const m of p.models) {
    const price = m.pricing === undefined ? '未定价 —' : m.pricing.currency + ' ' + m.pricing.input_per_mtok + '/' + m.pricing.output_per_mtok
    console.log('     ', m.id, '| cost:', m.cost_level, '| caps:', m.capabilities.join('+'), '| window:', m.context_window, '| avail:', m.availability, '| rank:', m.quality_rank, '| price:', price)
  }
}
console.log('  warnings:')
for (const w of result.warnings) console.log('   -', w)
