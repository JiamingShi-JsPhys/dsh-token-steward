/**
 * tsdown build — two bundles:
 *
 *   lib/index.js   host half (ESM, node) — external: @deepseek-ai/* (peer SDK), undici
 *   lib/client.js  browser half — the closure-factory shape the official client
 *                  module system loads via window.__ModuleLoader__
 *                  (`/plugins/dsh-umbra-budget/client.js`), external: react /
 *                  react-dom / @deepseek-ai/* (platform module table).
 */
import { defineConfig } from 'tsdown'

const PKG_NAME = 'dsh-umbra-budget'

export default defineConfig([
  {
    entry: ['src/index.ts'],
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'node22',
    dts: false,
    sourcemap: true,
    outExtensions: () => ({ js: '.js' }),
    external: [/^@deepseek-ai\//],
  },
  {
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    sourcemap: true,
    outExtensions: () => ({ js: '.js' }),
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PKG_NAME)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    external: [/^react/, /^react-dom/, /^@deepseek-ai\//],
  },
])
