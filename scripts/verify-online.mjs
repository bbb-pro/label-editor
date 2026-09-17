// 线上生效校验：抓 label-editor 的线上资源，确认新版本代码已上线。
// 用法：node scripts/verify-online.mjs [标识符...]
// 默认校验 barcodeBarVisualWidth（CanvasController 的方法名，压缩不会改属性名）
const BASE = process.env.SITE_BASE || 'https://057300.xyz/label-editor/'
const marks = process.argv.slice(2)
const NEEDLES = marks.length ? marks : ['barcodeBarVisualWidth', 'inkW']

const bust = `?t=${Date.now()}`
const res = await fetch(BASE + bust)
const html = await res.text()
const files = [...new Set([...html.matchAll(/assets\/[A-Za-z0-9_.-]+\.js/g)].map((m) => m[0]))]
console.log(`index.html: ${res.status}, 入口引用 ${files.length} 个 js`)

const seen = new Set(files)
let hitFound = false
// 入口里往往还有动态 import 的 chunk 名（canvasEngine/App/…），逐个抓来扫
const queue = [...files]
while (queue.length) {
  const f = queue.shift()
  let txt
  try {
    const r = await fetch(BASE + f + bust)
    if (!r.ok) continue
    txt = await r.text()
  } catch {
    continue
  }
  const hits = NEEDLES.filter((n) => txt.includes(n))
  if (hits.length) {
    hitFound = true
    console.log(`HIT ${f}  (${(txt.length / 1024).toFixed(0)}KB) -> ${hits.join(', ')}`)
  }
  // 发现新 chunk 名（懒加载分片不在 HTML 里；构建产物里是相对路径 "./xxx-hash.js"）
  for (const m of txt.matchAll(/["'`]\.?\/?assets\/([A-Za-z0-9_.-]+\.js)/g)) {
    const rel = `assets/${m[1]}`
    if (!seen.has(rel)) {
      seen.add(rel)
      queue.push(rel)
    }
  }
  for (const m of txt.matchAll(/["'`]\.\/([A-Za-z0-9_.-]+\.js)/g)) {
    const rel = `assets/${m[1]}`
    if (!seen.has(rel)) {
      seen.add(rel)
      queue.push(rel)
    }
  }
}
console.log(hitFound ? 'RESULT: 新版本已在线上生效' : 'RESULT: 未找到新标识符（可能仍是旧版本）')
