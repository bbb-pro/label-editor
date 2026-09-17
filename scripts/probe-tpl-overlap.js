// 全模板几何重叠体检：顶层对象两两相交检测（专找「文字压文字 / 文字压条码」）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ctrl = window.__appCtrl
const canvas = ctrl.canvas
const PX_PER_MM = canvas.getWidth ? null : null
const out = { rows: [] }

const { TEMPLATE_LIBRARY, buildTemplateSpec } = await import('/src/lib/templateLibrary.ts')

const label = (o) => {
  const k = o.kind || o.type
  if (k === 'text') return `T:"${String(o.text || '').slice(0, 12)}"`
  if (k === 'barcode') return `BC:${o._barcodeType || '?'}`
  return k
}

// 毫米换算：探针里用纸张尺寸反推（纸宽 mm / 纸宽 px）
const paperSizeOf = () => {
  const p = ctrl.listPapers()[0]
  return { wMm: p.widthMm ?? p.wMm ?? null, hMm: p.heightMm ?? p.hMm ?? null }
}

for (const tpl of TEMPLATE_LIBRARY) {
  ctrl.loadTemplate(buildTemplateSpec(tpl))
  await sleep(120)
  const objs = canvas.getObjects().filter((o) => !o.excludeFromExport)
  const boxes = objs.map((o) => {
    const r = o.getBoundingRect(true, true)
    return { name: label(o), left: r.left, top: r.top, w: r.width, h: r.height, kind: o.kind }
  })
  const ps = paperSizeOf()
  const rows = []
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]
      const b = boxes[j]
      const ix = Math.min(a.left + a.w, b.left + b.w) - Math.max(a.left, b.left)
      const iy = Math.min(a.top + a.h, b.top + b.h) - Math.max(a.top, b.top)
      if (ix <= 0 || iy <= 0) continue
      const inter = ix * iy
      const smaller = Math.min(a.w * a.h, b.w * b.h)
      const ratio = smaller > 0 ? inter / smaller : 0
      // 只在「小对象被压掉 25% 以上」时才报，忽略设计上的贴边/共线接触
      if (ratio > 0.25) {
        rows.push({
          a: a.name,
          b: b.name,
          overlapPct: Math.round(ratio * 100),
          ixPx: Math.round(ix),
          iyPx: Math.round(iy),
          aKind: a.kind,
          bKind: b.kind,
        })
      }
    }
  }
  out.rows.push({ id: tpl.id, objects: boxes.length, overlaps: rows })
}

out.totalOverlaps = out.rows.reduce((s, r) => s + r.overlaps.length, 0)
out.paperProbe = paperSizeOf()
return out
