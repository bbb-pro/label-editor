/**
 * 生成 docs/marks-preview.html —— 标准合规标志预览页。
 *
 * 用途：不用开浏览器就能一页核对所有标志的图形/比例是否画对。
 * 顺带做几何自检（见 assertGeometry）：
 *   - CE 的路径包围盒必须等于官方模型的 840×600（对不上说明路径或 transform 被改坏了）
 *   - 每个标志的坐标范围应落在自己的 viewBox 内（超出只告警，因为描边会自然溢出）
 *
 * 用法：node scripts/gen-marks-preview.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.cwd()

// ── 载入自绘 + CE（转译 TS 后 import）──
const tmpPath = path.join(root, 'scripts/_marks.tmp.mjs')
const esbuild = await import('esbuild')
const out = await esbuild.transform(fs.readFileSync(path.join(root, 'src/lib/assetMarks.ts'), 'utf8'), {
  loader: 'ts',
  format: 'esm',
})
fs.writeFileSync(tmpPath, out.code)
const { MARKS, MARK_CATS } = await import(pathToFileURL(tmpPath).href)
fs.rmSync(tmpPath, { force: true })

// ── 载入 GHS（构建产物）──
const ghsJson = JSON.parse(fs.readFileSync(path.join(root, 'public/assets/marks-ghs.json'), 'utf8'))
const ghs = ghsJson.marks.map(([id, name, kw, viewBox, inner]) => ({
  id,
  name,
  kw,
  cat: 'ghs',
  style: 'filled',
  inner,
  viewBox,
}))

const all = [
  ...ghs,
  ...MARKS.map(([id, name, kw, cat, style, inner, viewBox]) => ({ id, name, kw, cat, style, inner, viewBox })),
]

// ── 几何自检 ──
/**
 * 解析 path 的 `d`，估算坐标包围盒。
 * 只取 `d` 属性（避免把 `#1a1a1a` 之类颜色值里的数字当坐标），
 * 并正确处理相对命令（相对坐标一律相对**本段命令起点**，不是上一个控制点）。
 * 贝塞尔用控制点求界，是真实包围盒的上界 —— 做自检够用。
 */
function pathExtent(inner) {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  const see = (x, y) => {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  for (const m of inner.matchAll(/\sd="([^"]+)"/g)) {
    const tokens = m[1].match(/[a-zA-Z]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? []
    let i = 0
    let cmd = ''
    let cx = 0
    let cy = 0
    let sx = 0
    let sy = 0
    const num = () => Number(tokens[i++])
    while (i < tokens.length) {
      if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++]
      if (!cmd) break
      const rel = cmd === cmd.toLowerCase()
      const C = cmd.toUpperCase()
      const baseX = cx
      const baseY = cy
      const abs = (x, y) => (rel ? [baseX + x, baseY + y] : [x, y])
      if (C === 'M' || C === 'L' || C === 'T') {
        const [x, y] = abs(num(), num())
        cx = x
        cy = y
        see(cx, cy)
        if (C === 'M') {
          sx = cx
          sy = cy
          cmd = rel ? 'l' : 'L'
        }
      } else if (C === 'H') {
        const [x] = abs(num(), 0)
        cx = x
        see(cx, cy)
      } else if (C === 'V') {
        const [, y] = abs(0, num())
        cy = y
        see(cx, cy)
      } else if (C === 'C') {
        for (let k = 0; k < 3; k++) {
          const [x, y] = abs(num(), num())
          see(x, y)
          if (k === 2) {
            cx = x
            cy = y
          }
        }
      } else if (C === 'S' || C === 'Q') {
        for (let k = 0; k < 2; k++) {
          const [x, y] = abs(num(), num())
          see(x, y)
          if (k === 1) {
            cx = x
            cy = y
          }
        }
      } else if (C === 'A') {
        num(); num(); num(); num(); num()
        const [x, y] = abs(num(), num())
        cx = x
        cy = y
        see(cx, cy)
      } else if (C === 'Z') {
        cx = sx
        cy = sy
      } else {
        num()
      }
    }
  }
  return { minX, maxX, minY, maxY }
}

const problems = []
// CE：官方外框必须精确等于 840×600（路径用官方坐标，故直接量 111~951 / 149~749）
const ce = all.find((m) => m.id === 'ce')
if (!ce) problems.push('找不到 CE 标志')
else {
  const e = pathExtent(ce.inner)
  const w = e.maxX - e.minX
  const h = e.maxY - e.minY
  const gm = ce.inner.match(/translate\((-?[\d.]+) (-?[\d.]+)\)\s*scale\((-?[\d.]+) (-?[\d.]+)\)/)
  const ok =
    Math.abs(w - 840) < 0.01 &&
    Math.abs(h - 600) < 0.01 &&
    e.minX === 111 &&
    e.minY === 149 &&
    !!gm &&
    Number(gm[1]) === -111 &&
    Number(gm[2]) === 749
  if (!ok) {
    problems.push(
      `CE 几何异常：路径包围盒 x[${e.minX},${e.maxX}] y[${e.minY},${e.maxY}]，transform=${gm ? gm[0] : '缺失'}` +
        `（应为 x[111,951] y[149,749] + translate(-111 749)）`,
    )
  } else {
    console.log(`CE 几何自检通过：路径 ${w}×${h}，官方网格 20 格高 / 笔画 3 格 / 圆心距 17 格`)
    console.log(`  换算：1 格 = ${(w / 840 * 30).toFixed(0)} 单位 → 高 ${((h / (w / 840)) / 30).toFixed(2)} 格，宽 ${((w / 30)).toFixed(2)} 格`)
  }
}
// 其余（24 坐标系）：坐标应落在 viewBox 内
for (const m of all) {
  if (m.id === 'ce') continue
  const [vbx, vby, vbw, vbh] = (m.viewBox ?? '0 0 24 24').split(/\s+/).map(Number)
  const e = pathExtent(m.inner)
  if (!Number.isFinite(e.minX)) continue
  const tol = vbw * 0.05
  if (e.minX < vbx - tol || e.maxX > vbx + vbw + tol || e.minY < vby - tol || e.maxY > vby + vbh + tol) {
    problems.push(
      `${m.id} 坐标 x[${e.minX.toFixed(1)},${e.maxX.toFixed(1)}] y[${e.minY.toFixed(1)},${e.maxY.toFixed(1)}] 超出 viewBox ${m.viewBox ?? '0 0 24 24'}`,
    )
  }
}
if (problems.length) {
  console.log('\n⚠️ 几何自检发现问题：')
  for (const p of problems) console.log('  - ' + p)
} else {
  console.log(`其余 ${all.length - 1} 个标志坐标系自检通过`)
}

// ── 渲染 ──
const wrap = (m) => {
  const vb = m.viewBox ?? '0 0 24 24'
  if (m.style === 'filled') return `<svg viewBox="${vb}">${m.inner}</svg>`
  return `<svg viewBox="${vb}" fill="none" stroke="#111827" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${m.inner}</svg>`
}

const byCat = new Map(MARK_CATS.map((c) => [c.id, []]))
for (const m of all) {
  if (!byCat.has(m.cat)) byCat.set(m.cat, [])
  byCat.get(m.cat).push(m)
}

const sections = [...byCat.entries()]
  .filter(([, items]) => items.length)
  .map(([catId, items]) => {
    const label = MARK_CATS.find((c) => c.id === catId)?.label ?? catId
    const cells = items
      .map(
        (it) => `      <figure class="cell" title="${it.kw}">
        <div class="art${it.style === 'filled' ? ' art-filled' : ''}">${wrap(it)}</div>
        <figcaption>${it.name}</figcaption>
        <span class="tag">${it.id}</span>
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

const total = all.length
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
  .src { margin-top: 12px; padding: 12px 14px; background: #fff; border: 1px solid #e3e3df;
         border-radius: 10px; font-size: 12.5px; }
  .src dl { margin: 0; display: grid; grid-template-columns: 88px 1fr; gap: 4px 10px; }
  .src dt { color: #6b6b70; }
  .src dd { margin: 0; }
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
  .art svg { max-width: 100%; max-height: 100%; display: block; }
  .art-filled { background: #fafafa; border-radius: 8px; padding: 2px; }
  figcaption { font-size: 12px; text-align: center; line-height: 1.35; }
  .tag { font-size: 10px; color: #a0a0a6; font-family: ui-monospace, Consolas, monospace; }
</style>
</head>
<body>
<header>
  <h1>标准合规标志预览 · 共 ${total} 个</h1>
  <p class="sub">用于核对图形是否画得对。<b>看哪个比例/形状不对，把下面的 id 或名字发我即可。</b></p>
  <div class="src">
    <dl>
      <dt>CE 标志</dt><dd>欧盟委员会官方矢量模型（ec.europa.eu「CE marking - vector and bitmap images」），几何原样搬运，含比例</dd>
      <dt>GHS 危险品</dt><dd>${ghsJson.meta.source} · ${ghsJson.meta.license}（UN GHS 标准象形图，九个类别齐全）</dd>
      <dt>其余</dt><dd>按标准语义自绘线稿（ISO 3758 洗涤 / 回收环保 / 认证），可换色</dd>
    </dl>
  </div>
  <p class="warn">注意：CE 几何已与官方一致，但<strong>加贴位置、最小高度（默认 5mm）、颜色对比度</strong>等要求属使用环节，需自行确认。</p>
</header>
${sections}
</body>
</html>
`

const outPath = path.join(root, 'docs/marks-preview.html')
fs.writeFileSync(outPath, html)
console.log(`\n已生成预览：${outPath}`)
console.log(`标志总数 = ${total}`)
for (const c of MARK_CATS) {
  const n = byCat.get(c.id)?.length ?? 0
  if (n) console.log(`  ${c.label}  ${n}`)
}
