// 条码人读文字「宽度上限」验证（画布 + PDF 端到端）
// 修正版：absScale 必须含对象自身 scale，否则会得到「组缩放恒为 1」的错误度量。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ctrl = window.__appCtrl
const canvas = ctrl.canvas
const rows = []
const rec = (name, pass, detail) => rows.push({ name, pass: !!pass, detail })
const ptToPx = (pt) => (pt * 96) / 72
const pxToMm = (px) => (px * 25.4) / 96

const absScale = (o) => {
  let sx = Math.abs(o.scaleX || 1)
  let sy = Math.abs(o.scaleY || 1)
  let p = o.group
  for (let g = 0; p && g < 16; g++) {
    sx *= Math.abs(p.scaleX || 1)
    sy *= Math.abs(p.scaleY || 1)
    p = p.group
  }
  return { sx, sy }
}
const kidsOf = (o, kind) =>
  (o._objects || []).filter((k) =>
    kind === 'text' ? k.type === 'text' || k.type === 'textbox' || k.type === 'i-text' : k.type === kind,
  )
const barW = (o) => {
  let x0 = Infinity
  let x1 = -Infinity
  for (const k of kidsOf(o, 'rect')) {
    const l = k.left || 0
    const w = (k.width || 0) * Math.abs(k.scaleX || 1)
    if (l < x0) x0 = l
    if (l + w > x1) x1 = l + w
  }
  return x1 > x0 ? (x1 - x0) * absScale(o).sx : 0
}
const info = (o) => {
  const t = kidsOf(o, 'text')[0]
  const { sx } = absScale(o)
  return {
    px: t ? t.fontSize * Math.abs(t.scaleX || 1) * sx : 0,
    w: t ? t.width * Math.abs(t.scaleX || 1) * sx : 0,
    bar: barW(o),
    geomW: Math.abs(o.width || 0) * sx,
  }
}
const bcs = () => canvas.getObjects().filter((o) => !!o._barcodeType && o.type === 'group')
const cur = () => bcs().pop()
const clear = () => {
  canvas.discardActiveObject()
  for (const o of canvas.getObjects().slice()) if (!o.excludeFromExport) canvas.remove(o)
}
const setPt = async (o, pt) => {
  canvas.setActiveObject(o)
  ctrl.setBarcodeSettings({ textSizePt: pt })
  await sleep(70)
  return cur()
}
const setText = async (o, s) => {
  canvas.setActiveObject(o)
  ctrl.updateContent(s)
  await sleep(70)
  return cur()
}

const LONG = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const SHORT = 'ABC-1234'

// ── P. 预检：新增 → 清空 → 再新增（走应用自己的 clearAll），确认条码能正常新增
const seq = []
const step = async (label, fn) => {
  try {
    await fn()
  } catch (e) {
    seq.push(`${label}:ERR ${String((e && e.message) || e)}`)
    return
  }
  await sleep(120)
  seq.push(`${label}:${bcs().length}`)
}
await step('P1 add1D', async () => {
  ctrl.clearAll()
  ctrl.addBarcode('code128')
})
await step('P2 addQR', async () => ctrl.addBarcode('qrcode'))
await step('P3 clearAll+add1D', async () => {
  ctrl.clearAll()
  ctrl.addBarcode('code128')
})
await step('P4 clearAll+add1D again', async () => {
  ctrl.clearAll()
  ctrl.addBarcode('code128')
})
rec(
  'P 新增/清空/再新增 均能出条码',
  seq.join(' ').includes('P1 add1D:1') && seq.join(' ').includes('P3 clearAll+add1D:1') && seq.join(' ').includes('P4 clearAll+add1D again:1'),
  seq.join(' | '),
)

// ── A. 画布：字号阶梯（长文案强制触宽度上限）
clear()
ctrl.addBarcode('code128')
await sleep(60)
let g = cur()
g = await setText(g, LONG)
const baseGeom = info(g).geomW
const ladder = []
for (const pt of [6, 9, 12, 20, 32, 48]) {
  g = await setPt(g, pt)
  const i = info(g)
  ladder.push({
    pt,
    px: +i.px.toFixed(2),
    want: +ptToPx(pt).toFixed(2),
    w: +i.w.toFixed(2),
    bar: +i.bar.toFixed(2),
    geomW: +i.geomW.toFixed(2),
  })
}
rec('A1 每档字号都不宽于条区', ladder.every((r) => r.w <= r.bar + 0.3), JSON.stringify(ladder.map((r) => [r.pt, r.w, r.bar])))
rec('A2 字号永不超过用户设定值', ladder.every((r) => r.px <= r.want + 0.01), JSON.stringify(ladder.map((r) => [r.pt, r.px, r.want])))
rec('A3 大字被宽度钳住', ladder[5].px < ladder[5].want - 0.5, `48pt -> ${ladder[5].px}px (名义 ${ladder[5].want}px)`)
rec('A4 改字号不影响条码尺寸', ladder.every((r) => Math.abs(r.geomW - baseGeom) < 0.01), `base=${baseGeom.toFixed(2)}`)
rec('A5 字号随设定单调不减', ladder[1].px >= ladder[0].px, JSON.stringify(ladder.map((r) => r.px)))

// ── B. 画布：缩小 → 文字超宽 → 自动缩号；拉宽 → 回到设定值（用短文案，使上限可被触发/解除）
g = await setText(g, SHORT)
g = await setPt(g, 9)
const want9 = ptToPx(9)
const b0 = info(g)
rec('B1 短文案在默认宽度下不被钳制', Math.abs(b0.px - want9) < 0.3, `${b0.px.toFixed(2)}px vs ${want9.toFixed(2)}px`)

const s0 = Math.abs(g.scaleX || 1)
g.set({ scaleX: s0 * 0.1, scaleY: Math.abs(g.scaleY || 1) * 0.1 })
canvas.fire('object:scaling', { target: g })
await sleep(40)
const b1 = info(g)
rec('B2 缩小组后文字自动缩号', b1.px < b0.px - 0.01, `${b0.px.toFixed(2)}px -> ${b1.px.toFixed(2)}px`)
rec('B3 缩小后仍不宽于条区', b1.w <= b1.bar + 0.3, `textW=${b1.w.toFixed(2)} barW=${b1.bar.toFixed(2)}`)

g.set({ scaleX: s0 * 3, scaleY: Math.abs(g.scaleY || 1) * 3 })
canvas.fire('object:scaling', { target: g })
await sleep(40)
const b2 = info(g)
rec('B4 拉宽后字号回到设定值', Math.abs(b2.px - want9) < 0.3, `${b2.px.toFixed(2)}px vs ${want9.toFixed(2)}px`)
rec('B5 拉宽后也不宽于条区', b2.w <= b2.bar + 0.3, `textW=${b2.w.toFixed(2)} barW=${b2.bar.toFixed(2)}`)

let drift = 0
for (let i = 0; i < 3; i++) {
  ctrl.applyBarcodeTextCompensation(g)
  drift = Math.max(drift, Math.abs(info(g).px - b2.px))
}
rec('B6 反复刷新幂等无漂移', drift < 0.01, `maxDrift=${drift.toFixed(4)}px`)

// ── C. 二维码不受影响
ctrl.addBarcode('qrcode')
await sleep(60)
let q = bcs().find((o) => o !== g)
const q0 = { w: q.getScaledWidth(), h: q.getScaledHeight() }
canvas.setActiveObject(q)
ctrl.setBarcodeSettings({ textSizePt: 40 })
await sleep(80)
q = bcs().find((o) => o !== g) || q
rec(
  'C1 二维码改字号不改尺寸',
  Math.abs(q.getScaledWidth() - q0.w) < 0.01 && Math.abs(q.getScaledHeight() - q0.h) < 0.01,
  `${q0.w.toFixed(2)}x${q0.h.toFixed(2)} -> ${q.getScaledWidth().toFixed(2)}x${q.getScaledHeight().toFixed(2)}`,
)

// ── D. PDF 端到端：人读文字字号（读 jsPDF 内容流的 Tf；本页只有这一个文本对象）
const { buildVectorPdf } = await import('/src/lib/vectorExport.ts')
const paper = ctrl.listPapers()[0]
const pdfTf = (doc) => {
  const pages = (doc.internal && doc.internal.pages) || []
  const stream = pages
    .filter((_, i) => i > 0)
    .map(String)
    .join('\n')
  return (stream.match(/\/F\d+\s+([\d.]+)\s+Tf/g) || []).map((s) => Number(s.match(/([\d.]+)\s+Tf/)[1]))
}
const pxToPt = (px) => (px * 72) / 96

// D1：长文案 + 20pt（画布被宽度钳住）→ PDF 字号同步变小、且与画布一致
g.set({ scaleX: s0, scaleY: s0 })
g = await setText(g, LONG)
g = await setPt(g, 20)
const di = info(g)
const tfA = pdfTf(await buildVectorPdf(ctrl, paper, {}))
rec('D1 PDF 人读文字被宽度钳住（< 20pt）', tfA.length === 1 && tfA[0] < 19.5, JSON.stringify(tfA))
rec(
  'D2 PDF 字号与画布可视字号一致',
  tfA.length === 1 && Math.abs(tfA[0] - pxToPt(di.px)) <= pxToPt(di.px) * 0.1 + 0.15,
  `pdf=${tfA[0]?.toFixed(3)}pt canvas=${pxToPt(di.px).toFixed(3)}pt`,
)

// D3：短文案 + 9pt（不钳制）→ 原样输出 9pt
g = await setText(g, SHORT)
g = await setPt(g, 9)
const tfB = pdfTf(await buildVectorPdf(ctrl, paper, {}))
rec('D3 未钳制时 PDF 字号原样 9pt', tfB.length === 1 && Math.abs(tfB[0] - 9) < 0.01, JSON.stringify(tfB))

// ── E. 坐标哨兵
const near0 = canvas
  .getObjects()
  .filter((o) => !o.excludeFromExport)
  .filter((o) => Math.hypot(o.left || 0, o.top || 0) < 200)
rec('E1 无对象飞到工作区原点', near0.length === 0, `near0=${near0.length}`)

// ── F. 运行末段（画布经过大量改动后）再验一次「清空 → 新增」
const snap = () => canvas.getObjects().map((o) => o.kind || o.type)
const f = { before: snap() }
ctrl.clearAll()
f.afterClear = snap()
try {
  ctrl.addBarcode('code128')
} catch (e) {
  f.err = String((e && e.message) || e)
}
await sleep(150)
f.afterAdd = snap()
f.added = bcs().length
try {
  ctrl.addBarcode('qrcode')
} catch (e) {
  f.err2 = String((e && e.message) || e)
}
await sleep(150)
f.afterAddQr = bcs().length
rec('F1 长会话末段 清场后可新增条码', f.added === 1, JSON.stringify(f))

const fails = rows.filter((r) => !r.pass)
return { total: rows.length, fail: fails.length, fails, rows, ladder, diag: f }
