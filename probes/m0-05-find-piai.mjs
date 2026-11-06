import { openSync, readSync, closeSync } from 'node:fs'
const fd = openSync(process.env.ASAR_PATH, 'r')
const head = Buffer.alloc(16); readSync(fd, head, 0, 16, 0)
const hs = head.readUInt32LE(12); const hb = Buffer.alloc(hs); readSync(fd, hb, 0, hs, 16)
const index = JSON.parse(hb.toString('utf8').replace(/\0+$/g, ''))
closeSync(fd)
const hits = []
function walk(n, p) { for (const [k, c] of Object.entries(n.files || {})) { const q = p + '/' + k; if (c.files) walk(c, q); else if (/pi-ai|ai-sdk|openai/i.test(q) && /\.js$/.test(q) && c.size > 1000) hits.push({ path: q, size: c.size }) } }
walk(index, '')
const byPkg = new Map()
for (const h of hits) { const m = h.path.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//); const k = m ? m[1] : '?'; byPkg.set(k, (byPkg.get(k) || 0) + 1) }
console.log([...byPkg.entries()].sort((a,b)=>b[1]-a[1]).slice(0,25))