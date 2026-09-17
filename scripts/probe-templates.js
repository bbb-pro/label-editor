// 模板库回归：逐个载入 12 个模板，断言「每个条码节点都真的建出了条码组（有模块矩形）」
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ctrl = window.__appCtrl
const canvas = ctrl.canvas
const tl = await import('/src/lib/templateLibrary.ts')
const specs = tl.TEMPLATE_LIBRARY.map((t) => ({ id: t.id, name: t.name, spec: tl.buildTemplateSpec(t) }))
const rows = []
const isBc = (o) => !!o._barcodeType
const countRects = (o) => ((o._objects || []).filter((k) => k.type === 'rect').length)
const walk = (list, out) => {
  for (const o of list) {
    if (isBc(o)) out.push(o)
    const kids = o._objects
    if (Array.isArray(kids)) walk(kids, out)
  }
}

for (const t of specs) {
  try {
    ctrl.loadTemplate(t.spec)
  } catch (e) {
    rows.push({ id: t.id, err: String((e && e.message) || e) })
    continue
  }
  await sleep(90)
  const bcs = []
  walk(canvas.getObjects(), bcs)
  const nodes = t.spec.nodes.filter((n) => n.kind === 'barcode').length
  const empty = bcs.filter((o) => countRects(o) === 0).map((o) => o._barcodeType)
  rows.push({
    id: t.id,
    name: t.name,
    nodes,
    groups: bcs.length,
    emptyGroups: empty.length,
    types: bcs.map((o) => o._barcodeType).join(','),
    ok: nodes === bcs.length && empty.length === 0,
    texts: t.spec.nodes.filter((n) => n.kind === 'text').length,
  })
}

const bad = rows.filter((r) => r.err || !r.ok)
ctrl.clearAll()
return { total: rows.length, bad: bad.length, badRows: bad, rows }
