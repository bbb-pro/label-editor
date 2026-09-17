// 全模板 × 连续导出两次：找「第二次导出崩 text.split」的触发模板
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ctrl = window.__appCtrl
const canvas = ctrl.canvas
const out = { rows: [] }

const { TEMPLATE_LIBRARY, buildTemplateSpec } = await import('/src/lib/templateLibrary.ts')
const ve = await import('/src/lib/vectorExport.ts')

const scanBad = () => {
  const bad = []
  const walk = (list, path) => {
    for (const o of list || []) {
      const t = o.type
      if ((t === 'textbox' || t === 'text' || t === 'i-text') && typeof o.text !== 'string') {
        bad.push(`${path}/${o.kind || t}:${typeof o.text}:${JSON.stringify(o.text).slice(0, 40)}`)
      }
      if (o._objects) walk(o._objects, `${path}/${o.kind || o.type}`)
    }
  }
  walk(canvas.getObjects(), 'root')
  return bad
}

for (const tpl of TEMPLATE_LIBRARY) {
  ctrl.loadTemplate(buildTemplateSpec(tpl))
  await sleep(120)
  const row = { id: tpl.id }
  row.badBefore = scanBad().length
  const paper = ctrl.listPapers()[0]
  try {
    await ve.buildVectorPdf(ctrl, paper, {})
    row.e1 = 'ok'
  } catch (e) {
    row.e1 = String((e && e.message) || e).slice(0, 80)
  }
  row.badAfter1 = scanBad().length
  try {
    await ve.buildVectorPdf(ctrl, paper, {})
    row.e2 = 'ok'
  } catch (e) {
    row.e2 = String((e && e.message) || e).slice(0, 80)
  }
  row.badAfter2 = scanBad()
  out.rows.push(row)
}

out.failCount = out.rows.filter((r) => r.e1 !== 'ok' || r.e2 !== 'ok').length
out.badCount = out.rows.filter((r) => r.badBefore || r.badAfter1 || r.badAfter2.length).length
return out
