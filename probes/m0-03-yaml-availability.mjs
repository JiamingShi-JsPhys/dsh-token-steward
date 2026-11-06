// M0 探针 3：asar 内是否自带 YAML 解析库（决定 model_pool.yaml 用谁解析）
import { openSync, readSync, closeSync } from 'node:fs'
const fd = openSync(process.env.ASAR_PATH, 'r')
const head = Buffer.alloc(16); readSync(fd, head, 0, 16, 0)
const hs = head.readUInt32LE(12); const hb = Buffer.alloc(hs); readSync(fd, hb, 0, hs, 16)
const idx = JSON.parse(hb.toString('utf8').replace(/\0+$/g, ''))
closeSync(fd)
const names = []
function walk(node, path) {
  for (const [name, child] of Object.entries(node.files || {})) {
    const p = path + '/' + name
    if (child.files) walk(child, p)
    else if (/node_modules\/(yaml|js-yaml)\/package\.json$/.test(p)) names.push({ p, size: child.size })
  }
}
walk(idx, '')
console.log(JSON.stringify(names, null, 2))