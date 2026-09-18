/**
 * 探针 3：检查竞品站图标库的数据质量
 *  - 项数 vs 唯一 URL 数（是否有大量重复引用）
 *  - 无意义命名（纯英文代号、iso、数字）占比
 *  - 名字重复情况
 */
import fs from 'node:fs'

const items = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))

const urls = new Map()
for (const it of items) {
  if (!urls.has(it.image)) urls.set(it.image, [])
  urls.get(it.image).push(it.name)
}
console.log('项数:', items.length, ' 唯一 URL:', urls.size)

// 重复引用最多的 URL
const dup = [...urls].filter(([, v]) => v.length > 1).sort((a, b) => b[1].length - a[1].length)
console.log('\n被多个名字引用的文件数:', dup.length)
console.log('Top 10 重复引用:')
for (const [u, v] of dup.slice(0, 10)) console.log(`  ${u} ← ${v.length}次 [${v.slice(0, 4).join(' / ')}]`)

// 名字质量
const isMeaningfulCJK = (n) => /[\u4e00-\u9fa5]/.test(n)
const cat = new Map()
for (const it of items) {
  const c = it.image.split('/')[2] || '?'
  const o = cat.get(c) || { total: 0, cjk: 0 }
  o.total++
  if (isMeaningfulCJK(it.name)) o.cjk++
  cat.set(c, o)
}
console.log('\n分类 | 项数 | 带中文名')
let tt = 0, tc = 0
for (const [c, o] of [...cat].sort((a, b) => b[1].total - a[1].total)) {
  tt += o.total; tc += o.cjk
  const pct = ((o.cjk / o.total) * 100).toFixed(0)
  console.log(`${c} | ${o.total} | ${o.cjk} (${pct}%)`)
}
console.log(`\n合计 ${tt} 项，带中文名 ${tc} (${((tc / tt) * 100).toFixed(0)}%)`)

// 纯代号命名示例
console.log('\n无中文名示例（前 30）:')
console.log(items.filter((i) => !isMeaningfulCJK(i.name)).slice(0, 30).map((i) => i.name).join(' | '))
