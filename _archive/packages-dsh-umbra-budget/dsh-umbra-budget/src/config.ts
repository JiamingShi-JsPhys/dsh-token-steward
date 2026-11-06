/**
 * Cordis config schema (schemastery, provider-proxy style).
 *
 * Volatile fields are editable from the Plugins settings page and commit into
 * the running fiber (`loader/volatile-update`); non-volatile changes remount
 * the row. Runtime mode changes from the console UI additionally persist to
 * `runtime-state.json` so they survive restarts independently.
 *
 * @module config
 */
import z from '@deepseek-ai/schemastery'

export interface UmbraConfig {
  enabled: boolean
  mode: 'frugal' | 'efficiency' | 'max_power'
  poolPath: string
}

export const Config = z
  .object({
    enabled: z.boolean().default(true).description('总开关：关闭后宿主流量完全不经矩阵'),
    mode: z
      .union([z.const('frugal'), z.const('efficiency'), z.const('max_power')])
      .default('frugal')
      .description('全局调度模式（控制台切换会覆盖并持久化）'),
    poolPath: z
      .string()
      .default('')
      .description('model_pool.yaml 绝对路径；留空使用 $DSH_HOME/umbra-budget/model_pool.yaml'),
  })
  .description('DSH 模型矩阵调度中枢')
