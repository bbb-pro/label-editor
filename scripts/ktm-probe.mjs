/**
 * 探针：从竞品站 ktm.xp06.com 的编辑器 bundle 里提取「图标库 / 素材库」清单，
 * 统计分类规模与矢量(SVG)/位图(PNG)占比。仅用于评估可搬运范围，不改产物。
 *
 * 用法：node scripts/ktm-probe.mjs <bundle.js> [outPrefix]
 */
import fs from 'node:fs'

const src = process.argv[2]
const outPrefix = process.argv[3] || 'ktm-probe'
const s = fs.readFileSync(src, 'utf8')

// 匹配 {name:"...",image:"...",tags:[...]}
const re = new RegExp('\\{name:"((?:[^"\\\\]|\\\\.)*)",image:"((?:[^"\\\\]|\\\\.)*)"(?:,tags:\\[((?:[^\\]\\\\]|\\\\.)*)\\])?\\}', 'g')
const items = []
let m
while ((m = re.exec(s))) items.push({ name: m[1], image: m[2], tags: m[3] || '' })
console.log('总项数:', items.length)

const byCat = new Map()
for (const it of items) {
  const c = it.image.split('/')[2] || '?'
  if (!byCat.has(c)) byCat.set(c, { n: 0, svg: 0, png: 0, other: 0 })
  const o = byCat.get(c)
  o.n++
  const ext = (it.image.match(/\.(svg|png|jpe?g)$/i) || ['', '?'])[1].toLowerCase()
  if (ext === 'svg') o.svg++
  else if (ext === 'png') o.png++
  else o.other++
}

console.log('\n分类 | 总数 | svg | png | 其他')
let tn = 0, ts = 0, tp = 0
for (const [c, o] of [...byCat].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`${c} | ${o.n} | ${o.svg} | ${o.png} | ${o.other}`)
  tn += o.n; ts += o.svg; tp += o.png
}
console.log(`\n合计 ${tn} 项，SVG ${ts}，PNG ${tp}`)

fs.writeFileSync(`${outPrefix}-items.json`, JSON.stringify(items, null, 0))
console.log(`已写出 ${outPrefix}-items.json`)
