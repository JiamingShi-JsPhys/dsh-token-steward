
import { readFileSync } from 'node:fs'
const zh = readFileSync(process.env.ZH, 'utf8')
const en = readFileSync(process.env.EN, 'utf8')
const heads = (t) => [...t.matchAll(/^## (.+)$/gm)].map(m => m[1])
const zhH = heads(zh), enH = heads(en)
console.log('zh sections:', zhH.length, '| en sections:', enH.length)
console.log('same count:', zhH.length === enH.length)
console.log('zh:', zhH.join(' / '))
console.log('en:', enH.join(' / '))
const tables = (t) => (t.match(/^|/gm) || []).length
console.log('table rows zh/en:', tables(zh), '/', tables(en))
