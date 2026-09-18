/**
 * 分析竞品站 SVG 的颜色结构，为「能否参数化换色」提供依据。
 * 输出：单色稿 / 多色稿 / 无颜色属性 的占比，以及 viewBox 分布、无中文名样本。
 */
import fs from 'node:fs'
import path from 'node:path'

const dir = process.argv[2]
const items = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'))

const nameByFile = new Map()
for (const it of items) {
  const parts = it.image.split('/').filter(Boolean)
  const key = `${(parts[1] || '_').replace(/[/\\:]/g, '_')}__${parts.slice(2).join('_').replace(/[/\\:]/g, '_')}`
  nameByFile.set(key, it.name)
}

const files = fs.readdirSync(dir).filter((f) => f.endsWith('.svg'))
console.log('SVG 文件数:', files.length)

const stat = { mono: 0, multi: 0, noColor: 0, error: 0 }
const vbOdd = []
const noCjk = []
const colorCounts = new Map()

for (const f of files) {
  const txt = fs.readFileSync(path.join(dir, f), 'utf8')
  if (!/<svg/i.test(txt)) { stat.error++; continue }
  const colors = new Set()
  for (const m of txt.matchAll(/(?:fill|stroke)="([^"]*)"/g)) {
    const v = m[1].trim().toLowerCase()
    if (!v || v === 'none' || v === 'transparent' || v === 'currentcolor' || v.startsWith('url(')) continue
    colors.add(v)
  }
  colorCounts.set(colors.size, (colorCounts.get(colors.size) || 0) + 1)
  if (colors.size === 0) stat.noColor++
  else if (colors.size === 1) stat.mono++
  else stat.multi++

  const vb = (txt.match(/viewBox="([^"]+)"/) || ['', ''])[1]
  const name = nameByFile.get(f) ?? ''
  if (!/[\u4e00-\u9fa5]/.test(name)) noCjk.push(`${f} | name=${name} | vb=${vb} | colors=${colors.size}`)
  if (vb) {
    const [x, y, w, h] = vb.split(/[\s,]+/).map(Number)
    if (Math.abs(x) > 1 || Math.abs(y) > 1 || w <= 0 || h <= 0) vbOdd.push(`${f} | vb=${vb}`)
  }
}

console.log('\n颜色结构: 单色', stat.mono, '| 多色', stat.multi, '| 无颜色属性', stat.noColor, '| 无效', stat.error)
console.log('颜色数分布 (颜色数→文件数):', [...colorCounts].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`).join(' '))
console.log('\n非零原点 viewBox 数:', vbOdd.length)
console.log(vbOdd.slice(0, 10).join('\n'))
console.log('\n无中文名数:', noCjk.length)
fs.writeFileSync(dir + '/../no-cjk.txt', noCjk.join('\n'))
// 按分类看无中文名
const byCat = new Map()
for (const line of noCjk) {
  const c = line.split('__')[0]
  byCat.set(c, (byCat.get(c) || 0) + 1)
}
console.log('无中文名按分类:', [...byCat].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' '))
