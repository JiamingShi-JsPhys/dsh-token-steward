// M0 探针 1：从 app.asar 里定位 llm-pi-ai 的实现，检查模型 id 校验与 baseURL/SSE 处理
import { openSync, readSync, readFileSync, writeFileSync } from 'node:fs'

const ASAR = process.env.ASAR_PATH
const fd = openSync(ASAR, 'r')
// asar header: 8-byte pickle header
const head = Buffer.alloc(16)
readSync(fd, head, 0, 16, 0)
const headerSize = head.readUInt32LE(12)
const headerBuf = Buffer.alloc(headerSize)
readSync(fd, headerBuf, 0, headerSize, 16)
const index = JSON.parse(headerBuf.toString('utf8').replace(/\0+$/g, ''))
const baseOffset = 8 + head.readUInt32LE(4)
const entries = []
function walk(node, path) {
  for (const [name, child] of Object.entries(node.files || {})) {
    const p = path + '/' + name
    if (child.files) walk(child, p)
    else entries.push({ path: p, size: child.size, offset: child.offset })
  }
}
walk(index, '')
const hits = entries.filter(e => /llm-pi-ai|llm-openai|dsh-llm/.test(e.path))
console.log('TOTAL FILES:', entries.length)
console.log('llm-related entries (first 40):')
for (const h of hits.slice(0, 40)) console.log('  ', h.size, h.path)
require('node:fs').closeSync(fd)