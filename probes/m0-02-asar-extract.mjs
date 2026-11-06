// M0 探针 2：从 app.asar 按路径抽取 SDK 文件到本地 .cache/sdk，供只读研读
import { openSync, readSync, closeSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const ASAR = process.env.ASAR_PATH
const OUT = process.env.OUT_DIR
const WANT = (process.env.WANT || '').split('|').filter(Boolean)

const fd = openSync(ASAR, 'r')
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

let n = 0
for (const e of entries) {
  if (!WANT.some(w => e.path.includes(w))) continue
  const buf = Buffer.alloc(e.size)
  readSync(fd, buf, 0, e.size, baseOffset + Number(e.offset))
  const dest = join(OUT, e.path.replace(/^\/dsh\//, ''))
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, buf)
  n++
}
closeSync(fd)
console.log('extracted', n, 'files to', OUT)