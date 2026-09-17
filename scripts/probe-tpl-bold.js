// 遍历全部模板：导出 PDF → 解析内容流，检测「同一串文字被画两次（近似同位置）」= 重描双影
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ctrl = window.__appCtrl
const out = { templates: [] }

const { TEMPLATE_LIBRARY, buildTemplateSpec } = await import('/src/lib/templateLibrary.ts')
const ve = await import('/src/lib/vectorExport.ts')

// 解析 PDF 内容流里的文字绘制：BT ... Td ... Tj ... ET
const parseDraws = (doc) => {
  const pages = (doc.internal && doc.internal.pages) || []
  const stream = pages
    .filter((_, i) => i > 0)
    .map(String)
    .join('\n')
  const draws = []
  const re = /BT([\s\S]*?)ET/g
  let m
  while ((m = re.exec(stream))) {
    const b = m[1]
    const tf = /\/F(\d+)\s+([\d.]+)\s+Tf/.exec(b)
    const td = /(-?[\d.]+)\s+(-?[\d.]+)\s+Td/.exec(b)
    const tj =
      /<([0-9a-fA-F]+)>\s*Tj/.exec(b) || /\(((?:\\.|[^)\\]|\\\))*)\)\s*Tj/.exec(b) || /\]\s*TJ/.exec(b)
    if (!tj) continue
    const rm = /(\d)\s+Tr/.exec(b)
    draws.push({
      font: tf ? tf[1] : null,
      pt: tf ? +Number(tf[2]).toFixed(2) : null,
      x: td ? +Number(td[1]).toFixed(3) : null,
      y: td ? +Number(td[2]).toFixed(3) : null,
      text: tj[1] ? String(tj[1]).slice(0, 40) : '(TJ)',
      render: rm ? rm[1] : '0',
    })
  }
  return draws
}

for (const tpl of TEMPLATE_LIBRARY) {
  ctrl.loadTemplate(buildTemplateSpec(tpl))
  await sleep(120)
  const doc = await ve.buildVectorPdf(ctrl, ctrl.listPapers()[0], {})
  const draws = parseDraws(doc)
  // 分组找「同内容 + 位置几乎相同」的重复绘制
  const dupes = []
  for (let i = 0; i < draws.length; i++) {
    for (let j = i + 1; j < draws.length; j++) {
      const a = draws[i]
      const b = draws[j]
      if (a.text !== b.text || !a.text) continue
      if (a.x == null || b.x == null) continue
      const dx = Math.abs(a.x - b.x)
      const dy = Math.abs(a.y - b.y)
      if (dx < 3 && dy < 1) dupes.push({ text: a.text.slice(0, 16), dx: +dx.toFixed(3), dy: +dy.toFixed(3) })
    }
  }
  // 该模板里的加粗中文与描边渲染数量
  const stripped = draws.filter((d) => d.render === '2').length
  out.templates.push({
    id: tpl.id,
    draws: draws.length,
    dupes: dupes.length,
    dupeSample: dupes.slice(0, 2),
    strokedBold: stripped,
  })
}

out.totalDupes = out.templates.reduce((s, t) => s + t.dupes, 0)
out.totalDraws = out.templates.reduce((s, t) => s + t.draws, 0)
return out
