/**
 * 把某分类下的 SVG/PNG 素材排成网格页，便于截图肉眼核对图形与命名。
 *
 * 用法：node scripts/ktm-grid-page.mjs <allDir> <items.json> <分类名> <out.html> [每页数]
 */
import fs from 'node:fs'
import path from 'node:path'

const allDir = process.argv[2]
const items = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'))
const cat = process.argv[4]
const outHtml = process.argv[5]

const localName = (image) => {
  const parts = image.split('/').filter(Boolean)
  return `${(parts[1] || '_').replace(/[/\\:]/g, '_')}__${parts.slice(2).join('_').replace(/[/\\:]/g, '_')}`
}

const cells = []
for (const it of items) {
  const key = localName(it.image)
  if (key.split('__')[0] !== cat) continue
  const fp = path.join(allDir, key)
  if (!fs.existsSync(fp)) continue
  const ext = path.extname(it.image).toLowerCase()
  const short = key.split('__')[1]
  if (ext === '.svg') {
    cells.push({ label: short, src: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(fs.readFileSync(fp, 'utf8')), name: it.name })
  } else if (ext === '.png') {
    cells.push({ label: short, src: 'data:image/png;base64,' + fs.readFileSync(fp).toString('base64'), name: it.name })
  }
}
cells.sort((a, b) => a.label.localeCompare(b.label, 'en', { numeric: true }))
console.log(`${cat}: ${cells.length} 项`)

const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><style>
body{margin:0;background:#fff;font:11px/1.3 system-ui,sans-serif;color:#111}
h1{font-size:14px;margin:8px 12px}
.grid{display:grid;grid-template-columns:repeat(7,1fr);gap:6px;padding:0 12px 12px}
.cell{border:1px solid #e5e7eb;border-radius:6px;padding:4px;text-align:center}
.cell img{width:100%;height:74px;object-fit:contain;display:block}
.lbl{margin-top:3px;font-size:10px;color:#6b7280;word-break:break-all}
.nm{font-size:10px;color:#059669;font-weight:600;word-break:break-all}
</style></head><body>
<h1>${cat} · 共 ${cells.length} 项</h1>
<div class="grid">
${cells.map((c) => `<div class="cell"><img src="${c.src}" alt=""><div class="lbl">${c.label.replace(/\.[a-z]+$/, '')}</div>${c.name && c.name !== c.label.replace(/\.[a-z]+$/, '') ? `<div class="nm">${c.name}</div>` : ''}</div>`).join('\n')}
</div></body></html>`

fs.writeFileSync(outHtml, html)
console.log('已写出', outHtml)
