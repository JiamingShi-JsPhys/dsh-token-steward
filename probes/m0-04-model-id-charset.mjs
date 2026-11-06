// M0 探针 4：模型 id 字符集 — 在 asar 的主机端 bundle 里查 id 校验
import { openSync, readSync } from 'node:fs'
const fd = openSync(process.env.ASAR_PATH, 'r')
const head = Buffer.alloc(16); readSync(fd, head, 0, 16, 0)
const hs = head.readUInt32LE(12); const hb = Buffer.alloc(hs); readSync(fd, hb, 0, hs, 16)
const index = JSON.parse(hb.toString('utf8').replace(/\0+$/g, ''))
const base = 8 + head.readUInt32LE(4)
const entries = []
function walk(n, p) { for (const [k, c] of Object.entries(n.files || {})) { const q = p + '/' + k; if (c.files) walk(c, q); else entries.push({ path: q, size: c.size, offset: c.offset }) } }
walk(index, '')
const targets = entries.filter(e => /ui-settings-models|dsh-session\/lib|dsh-agent-default-model|dsh-llm\/lib\/index/.test(e.path) && /\.js$/.test(e.path))
console.log('targets:', targets.map(t => t.path + ' ' + t.size))
for (const t of targets.slice(0, 10)) {
  const buf = Buffer.alloc(Math.min(t.size, 4_000_000))
  readSync(fd, buf, 0, buf.length, base + Number(t.offset))
  const text = buf.toString('utf8')
  const lines = text.split('\n')
  const hits = []
  for (const line of lines) {
    if (hits.length >= 5) break
    if (/invalid model|model id|modelId.*pattern|UNKNOWN_MODEL|unknown model/i.test(line)) hits.push(line.trim().slice(0, 200))
  }
  if (hits.length) console.log('--- ' + t.path + '\n' + hits.map(h => '   ' + h).join('\n'))
}