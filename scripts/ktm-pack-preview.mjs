/**
 * 从**编译后的数据包**渲染网格预览页（用于肉眼核对 __C__ 回填、viewBox 是否正确）。
 * 与 ktm-grid-page.mjs 的区别：那个读原始下载文件，这个读 public/assets/ktm 的产物，
 * 验的是「最终上线的那份数据」。
 *
 * 用法：node scripts/ktm-pack-preview.mjs <packDir> <分类label或id> <out.html>
 */
import fs from 'node:fs'
import path from 'node:path'

const dir = process.argv[2]
const wanted = process.argv[3]
const outHtml = process.argv[4]

const idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'))
const cat = idx.cats.find((c) => c.id === wanted || c.label === wanted)
if (!cat) {
  console.error('找不到分类', wanted, '可用:', idx.cats.map((c) => c.label).join(' / '))
  process.exit(1)
}
const data = JSON.parse(fs.readFileSync(path.join(dir, cat.file), 'utf8'))

/** 复刻 assetsLib.assetToSvg 的 ktm 分支：回填占位符 + 外层兜底色 */
function toSvg(style, viewBox, body, color) {
  if (style === 'raster') return null
  if (style === 'filled') {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>`
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" fill="${color}" stroke="${color}">` +
    `${body.replace(/__C__/g, color)}</svg>`
  )
}

const cells = data.items.map(([id, name, , style, vb, body]) => {
  const src =
    style === 'raster'
      ? path.relative(path.dirname(outHtml), path.join(dir, body)).replace(/\\/g, '/')
      : 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(toSvg(style, vb, body, '#111827'))
  return { id, name, style, vb, src }
})

const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><style>
body{margin:0;background:#fff;font:11px/1.3 system-ui,sans-serif;color:#111}
h1{font-size:14px;margin:8px 12px}
.grid{display:grid;grid-template-columns:repeat(7,1fr);gap:6px;padding:0 12px 12px}
.cell{border:1px solid #e5e7eb;border-radius:6px;padding:4px;text-align:center}
.cell img{width:100%;height:74px;object-fit:contain;display:block}
.nm{margin-top:3px;font-size:10px;color:#111;word-break:break-all}
.mt{font-size:9px;color:#9ca3af}
</style></head><body>
<h1>${cat.label}（${data.items.length} 项）· 数据包预览</h1>
<div class="grid">
${cells
  .map(
    (c) =>
      `<div class="cell"><img src="${c.src}" alt=""><div class="nm">${c.name}</div><div class="mt">${c.style} ${c.vb}</div></div>`,
  )
  .join('\n')}
</div></body></html>`

fs.writeFileSync(outHtml, html)
console.log(`${cat.label}: ${cells.length} 项 → ${outHtml}`)
