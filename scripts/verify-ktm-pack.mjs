/**
 * 扩展图标库数据包自检（纯 Node，不启浏览器）。
 *
 * 校验项：
 *  ① index.json 与分类文件一一对应，项数一致
 *  ② 每项六元组结构合法、id 全局唯一
 *  ③ line 类不应残留具体颜色值（应已换成 __C__ 占位符或本就无色）
 *  ④ raster 类必须有对应的图片文件
 *  ⑤ viewBox 合法（四个数值、宽高为正）
 *
 * 用法：node scripts/verify-ktm-pack.mjs public/assets/ktm
 */
import fs from 'node:fs'
import path from 'node:path'

const dir = process.argv[2]
const idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'))

const problems = []
const ids = new Set()
const seenCats = new Set()
/** 位图落盘路径 → 引用它的素材 id 列表（用于抓「落盘名撞车」） */
const rasterRefs = new Map()
let total = 0
const perCat = []

for (const c of idx.cats) {
  if (seenCats.has(c.id)) problems.push(`分类 id 重复: ${c.id}`)
  seenCats.add(c.id)
  const fp = path.join(dir, c.file)
  if (!fs.existsSync(fp)) { problems.push(`缺少分类文件: ${c.file}`); continue }
  const data = JSON.parse(fs.readFileSync(fp, 'utf8'))
  if (data.label !== c.label) problems.push(`${c.file} label 不一致: ${data.label} vs ${c.label}`)
  if (data.items.length !== c.count) problems.push(`${c.file} 项数不符: ${data.items.length} vs ${c.count}`)

  let line = 0, filled = 0, raster = 0
  for (const it of data.items) {
    total++
    if (!Array.isArray(it) || it.length !== 6) { problems.push(`${c.file} 元组长度异常: ${JSON.stringify(it).slice(0, 60)}`); continue }
    const [id, name, kw, style, vb, body] = it
    if (ids.has(id)) problems.push(`id 重复: ${id}`)
    ids.add(id)
    if (!id || !name) problems.push(`${c.file} 缺少 id/name: ${id}`)
    if (!style || !['line', 'filled', 'raster'].includes(style)) problems.push(`${id} 形态非法: ${style}`)

    if (style === 'raster') {
      raster++
      const img = path.join(dir, body)
      if (!fs.existsSync(img)) problems.push(`${id} 图片缺失: ${body}`)
      if (!/^\d+x\d+$/.test(vb)) problems.push(`${id} 位图尺寸格式异常: ${vb}`)
      if (!rasterRefs.has(body)) rasterRefs.set(body, [])
      rasterRefs.get(body).push(id)
      continue
    }

    style === 'line' ? line++ : filled++
    // viewBox 必须四数值且宽高为正
    const nums = String(vb).trim().split(/[\s,]+/).map(Number)
    if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n)) || nums[2] <= 0 || nums[3] <= 0) {
      problems.push(`${id} viewBox 非法: ${vb}`)
    }
    if (typeof body !== 'string' || !/<(path|circle|rect|ellipse|polygon|polyline|line|text|image|use)\b/i.test(body)) {
      problems.push(`${id} 图形内容为空`)
    }
    // line 类若还残留具体颜色，说明参数化没生效（换色会失效）
    if (style === 'line') {
      const leftovers = [...body.matchAll(/(?:fill|stroke)="([^"]*)"/g)]
        .map((m) => m[1].trim().toLowerCase())
        .filter((v) => v && v !== 'none' && v !== 'transparent' && v !== 'currentcolor' && v !== '__c__' && !v.startsWith('url('))
      if (leftovers.length) problems.push(`${id} line 类残留颜色: ${[...new Set(leftovers)].join(',')}`)
    }
  }
  perCat.push({ ...c, line, filled, raster })
}

console.log(`分类 ${idx.cats.length} 个，素材 ${total} 项（索引声明 ${idx.meta?.total}）`)
const sum = perCat.reduce((a, c) => ({ line: a.line + c.line, filled: a.filled + c.filled, raster: a.raster + c.raster }), { line: 0, filled: 0, raster: 0 })
console.log(`  单色矢量 ${sum.line} · 多色矢量 ${sum.filled} · 位图 ${sum.raster}`)
if (total !== idx.meta?.total) problems.push(`总数不符: 实际 ${total} vs 索引 ${idx.meta?.total}`)

// 位图必须「一素材一文件」：多个素材指向同一张图，说明落盘名撞车（曾踩过，108 个素材指错图）
const shared = [...rasterRefs].filter(([, v]) => v.length > 1)
const rasterTotal = [...rasterRefs.values()].reduce((a, v) => a + v.length, 0)
console.log(`  位图文件 ${rasterRefs.size} 个，覆盖 ${rasterTotal} 个素材`)
if (shared.length) {
  problems.push(
    `位图落盘名撞车：${shared.length} 个文件被多个素材共享（共多出 ${rasterTotal - rasterRefs.size} 个素材指错图），` +
    `例 ${shared[0][0]} ← ${shared[0][1].length} 个素材`,
  )
}

if (problems.length) {
  console.log(`\n❌ 发现 ${problems.length} 个问题（前 25 条）：`)
  console.log(problems.slice(0, 25).join('\n'))
  process.exitCode = 1
} else {
  console.log('\n✅ 自检通过')
}
