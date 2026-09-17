// 轻量验证：画布宽度上限 + PDF 人读文字字号（只导出一次）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ctrl = window.__appCtrl
const canvas = ctrl.canvas
const out = {}
const LONG = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const ptToPx = (pt) => (pt * 96) / 72
const kidsOf = (o, kind) =>
  (o._objects || []).filter((k) =>
    kind === 'text' ? k.type === 'text' || k.type === 'textbox' || k.type === 'i-text' : k.type === kind,
  )
const absScale = (o) => {
  let sx = Math.abs(o.scaleX || 1)
  let p = o.group
  for (let g = 0; p && g < 16; g++) {
    sx *= Math.abs(p.scaleX || 1)
    p = p.group
  }
  return sx
}
const bcs = () => canvas.getObjects().filter((o) => !!o._barcodeType && o.type === 'group')
const info = (o) => {
  const t = kidsOf(o, 'text')[0]
  const sx = absScale(o)
  let x0 = Infinity
  let x1 = -Infinity
  for (const k of kidsOf(o, 'rect')) {
    const l = k.left || 0
    const w = (k.width || 0) * Math.abs(k.scaleX || 1)
    if (l < x0) x0 = l
    if (l + w > x1) x1 = l + w
  }
  return {
    px: t ? t.fontSize * Math.abs(t.scaleX || 1) * sx : 0,
    w: t ? t.width * Math.abs(t.scaleX || 1) * sx : 0,
    bar: (x1 - x0) * sx,
  }
}

ctrl.clearAll()
ctrl.addBarcode('code128')
await sleep(100)
let g = bcs().pop()
canvas.setActiveObject(g)
ctrl.updateContent(LONG)
await sleep(100)
g = bcs().pop()
canvas.setActiveObject(g)
ctrl.setBarcodeSettings({ textSizePt: 20 })
await sleep(120)
g = bcs().pop()
const i = info(g)
out.canvas = { px: +i.px.toFixed(3), textW: +i.w.toFixed(2), barW: +i.bar.toFixed(2), want: +ptToPx(20).toFixed(2) }
out.widthOK = i.w <= i.bar + 0.3
out.cappedOnCanvas = i.px < ptToPx(20) - 0.5

// PDF：读 jsPDF 内容流里的真实字号（本页只有这一个文本对象 → Tf 即它的字号）
const { buildVectorPdf } = await import('/src/lib/vectorExport.ts')
const pdfTf = (doc) => {
  const pages = (doc.internal && doc.internal.pages) || []
  const stream = pages
    .filter((_, idx) => idx > 0)
    .map(String)
    .join('\n')
  return (stream.match(/\/F\d+\s+([\d.]+)\s+Tf/g) || []).map((s) => Number(s.match(/([\d.]+)\s+Tf/)[1]))
}
const runExport = async () => pdfTf(await buildVectorPdf(ctrl, ctrl.listPapers()[0], {}))

const tfCapped20 = await runExport()
out.pdf = { tf: tfCapped20, expected: +((i.px * 72) / 96).toFixed(3) }
out.pdfCapped = tfCapped20.length === 1 && tfCapped20[0] < 19.5
out.pdfMatchesCanvas = tfCapped20.length === 1 && Math.abs(tfCapped20[0] - out.pdf.expected) <= out.pdf.expected * 0.1 + 0.15

// 长文案 + 40pt：上限由宽度决定 → 与 20pt 结果应完全一致
canvas.setActiveObject(g)
ctrl.setBarcodeSettings({ textSizePt: 40 })
await sleep(120)
g = bcs().pop()
const i40 = info(g)
const tfCapped40 = await runExport()
out.pdfTf40 = tfCapped40
out.capIndependentOfPt =
  tfCapped20.length === 1 && tfCapped40.length === 1 && Math.abs(tfCapped40[0] - tfCapped20[0]) < 0.05
out.canvasPx40 = +i40.px.toFixed(3)

// 短文案 + 9pt：不钳制 → PDF 字号原样 9pt
canvas.setActiveObject(g)
ctrl.updateContent('ABC-1234')
await sleep(120)
g = bcs().pop()
canvas.setActiveObject(g)
ctrl.setBarcodeSettings({ textSizePt: 9 })
await sleep(120)
g = bcs().pop()
const tfShort = await runExport()
out.pdfTfShort = tfShort
out.shortUncapped = tfShort.length === 1 && Math.abs(tfShort[0] - 9) < 0.01

// 内容流定位诊断
out.dbg = {
  internalKeys: null,
  nPages: 0,
  t1: 'n/a',
  isArr1: false,
  streamLen: 0,
}

ctrl.clearAll()
return out
