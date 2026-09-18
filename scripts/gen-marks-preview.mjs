import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.cwd()
const srcPath = path.join(root, 'src/lib/assetMarks.ts')
const tmpPath = path.join(root, 'scripts/_marks.tmp.mjs')

const esbuild = await import('esbuild')
const out = await esbuild.transform(fs.readFileSync(srcPath, 'utf8'), {
  loader: 'ts',
  format: 'esm',
})
fs.writeFileSync(tmpPath, out.code)
const { MARKS, MARK_CATS } = await import(pathToFileURL(tmpPath).href)
fs.rmSync(tmpPath, { force: true })

const line = (inner) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="#111827" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`
const filled = (inner) => `<svg viewBox="0 0 24 24">${inner}</svg>`
const svgFor = (style, inner) => (style === 'filled' ? filled(inner) : line(inner))

const byCat = new Map(MARK_CATS.map((c) => [c.id, []]))
for (const [id, name, kw, cat, style, inner] of MARKS) {
  if (!byCat.has(cat)) byCat.set(cat, [])
  byCat.get(cat).push({ id, name, kw, style, inner })
}

const sections = [...byCat.entries()]
  .filter(([, items]) => items.length)
  .map(([catId, items]) => {
    const label = MARK_CATS.find((c) => c.id === catId)?.label ?? catId
    const cells = items
      .map(
        (it) => `      <figure class="cell" title="${it.kw}">
        <div class="art${it.style === 'filled' ? ' art-filled' : ''}">${svgFor(it.style, it.inner)}</div>
        <figcaption>${it.name}</figcaption>
        <span class="tag">${it.style === 'filled' ? '固有配色' : '线稿可换色'}</span>
      </figure>`,
      )
      .join('\n')
    return `  <section>
    <h2>${label} <span class="count">${items.length}</span></h2>
    <div class="grid">
${cells}
    </div>
  </section>`
  })
  .join('\n')

const total = MARKS.length
const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>标准合规标志预览 · ${total} 个</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 28px 64px; background: #f7f7f5; color: #17171a;
         font: 400 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  header { max-width: 1180px; margin: 0 auto 28px; }
  h1 { font-size: 20px; font-weight: 500; margin: 0 0 6px; }
  .sub { color: #6b6b70; font-size: 13px; }
  .sub b { color: #17171a; font-weight: 500; }
  .warn { margin-top: 14px; padding: 10px 12px; background: #fdf3e6; border: 1px solid #f0d5ac;
          border-radius: 8px; color: #7a4a12; font-size: 12.5px; }
  section { max-width: 1180px; margin: 0 auto 30px; }
  h2 { font-size: 15px; font-weight: 500; margin: 0 0 12px; padding-bottom: 7px;
       border-bottom: 1px solid #e3e3df; display: flex; align-items: center; gap: 8px; }
  .count { font-size: 12px; font-weight: 400; color: #6b6b70; background: #ecece8;
           border-radius: 10px; padding: 1px 8px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(122px, 1fr)); gap: 12px; }
  .cell { margin: 0; background: #fff; border: 1px solid #e3e3df; border-radius: 12px;
          padding: 14px 10px 10px; display: flex; flex-direction: column; align-items: center; gap: 7px; }
  .art { width: 64px; height: 64px; display: flex; align-items: center; justify-content: center; }
  .art svg { width: 100%; height: 100%; display: block; }
  .art-filled { background: #fafafa; border-radius: 8px; }
  figcaption { font-size: 12px; text-align: center; line-height: 1.35; }
  .tag { font-size: 10.5px; color: #85858b; }
</style>
</head>
<body>
<header>
  <h1>标准合规标志预览 · 共 ${total} 个</h1>
  <p class="sub">全部为<b>按标准语义自绘</b>（GHS / ISO 3758 / 回收 / 认证）。线稿类可换色，固有配色类保持原色。</p>
  <p class="warn">这是预览页，用于核对图形是否画得对。看下来哪个标志比例/形状不对，直接告诉我编号或名字，我改。</p>
</header>
${sections}
</body>
</html>
`

const outPath = path.join(root, 'docs/marks-preview.html')
fs.writeFileSync(outPath, html)
console.log(`已生成预览：${outPath}`)
console.log(`标志总数 = ${total}`)
for (const c of MARK_CATS) {
  const n = byCat.get(c.id)?.length ?? 0
  if (n) console.log(`  ${c.label}  ${n}`)
}
