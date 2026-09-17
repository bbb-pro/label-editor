// 视图/几何断言：改尺寸不再 fit、新建/删除按 1:1 居中、新建（清空）回到单张默认纸
// 全程驱动真实 UI（标签条 +、TopBar 新建、面板 mm 输入框），不插内容对象（内存友好）
const ctrl = window.__appCtrl
const canvas = ctrl.canvas
const rows = []
const out = {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rec = (name, pass, detail) => rows.push({ name, pass: !!pass, detail: detail || '' })

const vpt = () => canvas.viewportTransform || [1, 0, 0, 1, 0, 0]
const zoom = () => vpt()[0]
const pan = () => ({ x: vpt()[4], y: vpt()[5] })
const r1 = (n) => Math.round(n * 100) / 100

const btnOf = (title) =>
  [...document.querySelectorAll('button')].find((b) => (b.getAttribute('title') || '') === title)
const btnNewPaper = () => btnOf('在当前标签下方新建一张')
const btnNewFile = () => btnOf('新建标签（清空画布）')

const setMm = async (labelText, v, perChar) => {
  const lab = [...document.querySelectorAll('label')].find((l) => l.textContent.trim() === labelText)
  const inp = lab && lab.parentElement ? lab.parentElement.querySelector('input') : null
  if (!inp) return 'NO-INPUT'
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  inp.focus()
  setter.call(inp, '')
  inp.dispatchEvent(new Event('input', { bubbles: true }))
  await sleep(50)
  const s = String(v)
  if (perChar) {
    let acc = ''
    for (const ch of s) {
      acc += ch
      setter.call(inp, acc)
      inp.dispatchEvent(new Event('input', { bubbles: true }))
      await sleep(140)
    }
  } else {
    setter.call(inp, s)
    inp.dispatchEvent(new Event('input', { bubbles: true }))
  }
  await sleep(120)
  inp.blur()
  await sleep(260)
  return 'ok'
}

const geom = () =>
  ctrl.listPapers().map((p) => {
    const b = ctrl.getPaperBoundsPxFor(p.id)
    return {
      name: p.name,
      w: p.widthMm,
      h: p.heightMm,
      left: r1(b.left),
      top: r1(b.top),
      hpx: r1(b.height),
      wpx: r1(b.width),
    }
  })
const centerErr = (id) => {
  const b = ctrl.getPaperBoundsPxFor(id)
  const z = zoom()
  const p = pan()
  const vp = ctrl.getViewportSize()
  return {
    dx: r1((b.left + b.width / 2) * z + p.x - vp.width / 2),
    dy: r1((b.top + b.height / 2) * z + p.y - vp.height / 2),
  }
}
const activeId = () => ctrl.activePaperId()
const activeName = () => (ctrl.listPapers().find((p) => p.id === activeId()) || {}).name
/** 每张纸都必须在 1:1 下「宽高像素 = 毫米 × 3.7795」 */
const scaleOfPapers = () =>
  ctrl.listPapers().map((p) => {
    const b = ctrl.getPaperBoundsPxFor(p.id)
    return { name: p.name, kx: r1(b.width / (p.widthMm * 3.7795)), ky: r1(b.height / (p.heightMm * 3.7795)) }
  })
const paperPanel = () => {
  const gv = (t) => {
    const l = [...document.querySelectorAll('label')].find((x) => x.textContent.trim() === t)
    return l && l.parentElement ? l.parentElement.querySelector('input').value : '?'
  }
  return { w: gv('纸张宽 (mm)'), h: gv('纸张高 (mm)') }
}

// ── 0
out.v0 = { papers: ctrl.listPapers().length, zoom: zoom(), paper: paperPanel(), geom: geom() }
rec('V0 初始：1 张 · 100% · 居中', out.v0.papers === 1 && zoom() === 1 && !centerErr(activeId()).dx && !centerErr(activeId()).dy, JSON.stringify(out.v0))

// ── 1 新建第二张
btnNewPaper().click()
await sleep(450)
const p2 = ctrl.listPapers()[1]
out.v1 = { papers: ctrl.listPapers().length, zoom: zoom(), active: activeName(), err: centerErr(p2.id), geom: geom() }
rec(
  'V1 新建第二张：100% 且新纸居中',
  out.v1.papers === 2 && zoom() === 1 && !out.v1.err.dx && !out.v1.err.dy,
  `zoom=${out.v1.zoom} Δ=(${out.v1.err.dx},${out.v1.err.dy})`,
)

// ── 2 改第二张尺寸（逐字键入 180，模拟真实打字）
await setMm('纸张高 (mm)', 180, true)
await sleep(250)
out.v2 = { zoom: zoom(), err: centerErr(activeId()), geom: geom(), scale: scaleOfPapers(), paper: paperPanel() }
rec(
  'V2 改尺寸后仍是 100% 实际大小（回归：以前会掉到 0.877 = fit 撑满窗口）',
  zoom() === 1,
  `zoom=${r1(out.v2.zoom)}（<1 即被 fit）`,
)
rec('V3 改尺寸后当前标签仍居中', !out.v2.err.dx && !out.v2.err.dy, `Δ=(${out.v2.err.dx},${out.v2.err.dy})`)
const sc = out.v2.scale
rec('V4 改尺寸后各纸渲染比例都是 1:1', sc.every((s) => s.kx === 1 && s.ky === 1), JSON.stringify(sc))

await setMm('纸张宽 (mm)', 200, true)
await sleep(250)
out.v3 = { zoom: zoom(), err: centerErr(activeId()), geom: geom() }
rec('V5 连续改宽后仍是 100% 且居中', zoom() === 1 && !out.v3.err.dx && !out.v3.err.dy, `zoom=${r1(out.v3.zoom)} Δ=(${out.v3.err.dx},${out.v3.err.dy})`)

// ── 3 再新建第三张
btnNewPaper().click()
await sleep(500)
const p3 = ctrl.listPapers()[2]
const g3 = geom()
const gap23 = r1(g3[2].top - (g3[1].top + g3[1].hpx))
out.v4 = { papers: g3.length, zoom: zoom(), active: activeName(), err: centerErr(p3.id), gap23, geom: g3 }
rec(
  'V6 再新建第三张：100% 且新纸居中（用户报的「又跑偏」）',
  g3.length === 3 && zoom() === 1 && !out.v4.err.dx && !out.v4.err.dy,
  `zoom=${out.v4.zoom} Δ=(${out.v4.err.dx},${out.v4.err.dy}) active=${out.v4.active}`,
)
rec('V7 第三张按第二张新高度排布、间距正常', gap23 > 0 && gap23 < 400, `gap=${gap23}px`)
rec('V8 第三张尺寸继承第二张的 200×180', g3[2].w === 200 && g3[2].h === 180, `${g3[2].w}×${g3[2].h}`)

// ── 4 删除第三张 → 回到第二张，仍 100% 居中
window.confirm = () => true
const delBtn = btnOf('删除当前标签（该标签上的内容会一起删除）')
if (delBtn) delBtn.click()
await sleep(500)
const g4 = geom()
out.v5 = { papers: g4.length, zoom: zoom(), active: activeName(), err: centerErr(activeId()), geom: g4 }
rec(
  'V9 删除标签后：100% 且新活动纸居中',
  g4.length === 2 && zoom() === 1 && !out.v5.err.dx && !out.v5.err.dy,
  `zoom=${out.v5.zoom} Δ=(${out.v5.err.dx},${out.v5.err.dy})`,
)

// ── 5 TopBar「新建标签（清空画布）」：必须回到单张默认纸（以前会留着 2 张、含改过尺寸的那张）
const nf = btnNewFile()
out.hasNewFile = !!nf
nf.click()
await sleep(500)
const g5 = geom()
out.v6 = { papers: g5.length, zoom: zoom(), paper: paperPanel(), geom: g5, err: centerErr(activeId()) }
rec(
  'V10 新建（清空画布）后只剩 1 张标签',
  g5.length === 1,
  `papers=${g5.length}（>1 = 残留了改过尺寸的旧标签）`,
)
rec('V11 新建（清空画布）后尺寸回到默认 150×100', g5[0].w === 150 && g5[0].h === 100, `${g5[0].w}×${g5[0].h}`)
rec('V12 新建（清空画布）后 100% 且居中', zoom() === 1 && !out.v6.err.dx && !out.v6.err.dy, `zoom=${out.v6.zoom} Δ=(${out.v6.err.dx},${out.v6.err.dy})`)
rec('V13 面板尺寸同步为 150×100', out.v6.paper.w === '150' && out.v6.paper.h === '100', JSON.stringify(out.v6.paper))

const fails = rows.filter((r) => !r.pass)
return { total: rows.length, fail: fails.length, fails, rows, out }
