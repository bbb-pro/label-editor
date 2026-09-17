// 把从 label.transkoi.com 公开页面提取到的 12 个模板定义，注入 src/lib/templateLibrary.ts
// 的 TEMPLATE_LIBRARY 常量（占位符 // __RAW_TEMPLATES__）。
//
// 用法：node scripts/gen-template-library.mjs <原始模板 JSON 路径>
// 该 JSON 由抓取脚本产出（结构见 templateLibrary.ts 的 LibTemplate 注释）。
//
// 之所以用生成脚本而不是手工粘贴：这批数据有 12 个模板 / ~90 个元素，
// 手抄必然出错，且将来原站更新时可以直接重跑。

import fs from 'node:fs'
import path from 'node:path'

const src = process.argv[2]
if (!src) {
  console.error('用法：node scripts/gen-template-library.mjs <raw-templates.json>')
  process.exit(1)
}

const raw = JSON.parse(fs.readFileSync(src, 'utf8'))
if (!Array.isArray(raw) || raw.length === 0) {
  console.error('原始数据为空')
  process.exit(1)
}

// 只保留我们类型里声明的字段，丢弃原站的排版噪声（paper/sizePreset/columns/…）
const tpls = raw.map((t) => ({
  id: t.id,
  industry: t.industry,
  name: t.name,
  size: t.size,
  label: { width: t.label.width, height: t.label.height, elements: t.label.elements },
}))

const literal = JSON.stringify(tpls, null, 2)

const target = path.resolve('src/lib/templateLibrary.ts')
let ts = fs.readFileSync(target, 'utf8')
if (!ts.includes('// __RAW_TEMPLATES__')) {
  console.error('未找到占位符 // __RAW_TEMPLATES__（可能已生成过）：请勿重复注入')
  process.exit(1)
}
ts = ts.replace(
  '// __RAW_TEMPLATES__',
  `export const TEMPLATE_LIBRARY: LibTemplate[] = ${literal}`,
)
fs.writeFileSync(target, ts)
console.log(`已写入 ${tpls.length} 个模板 → ${target}`)

// ── 自检：字号/文本框宽度是否会导致意外换行，条码码制是否可识别 ──
const TK = 8
const tk2mm = (u) => u / TK
const tk2pt = (u) => ((u / TK) * 96) / 25.4 * 0.75
// 经验字宽：CJK 约 1.0em，拉丁约 0.55em
const estWidthMm = (txt, fsPt) => {
  const pxPerPt = 96 / 72
  const emMm = (fsPt * pxPerPt * 25.4) / 96
  let w = 0
  for (const ch of txt) w += /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F]/.test(ch) ? 1 : 0.55
  return w * emMm
}
let warn = 0
for (const t of tpls) {
  for (const e of t.label.elements) {
    if (e.type === 'text') {
      const box = tk2mm(e.width)
      const need = estWidthMm(e.content, tk2pt(e.fontSize))
      if (need > box) {
        warn++
        console.log(`  ⚠ 可能换行 [${t.id}] "${e.content}" 估算 ${need.toFixed(1)}mm > 框宽 ${box.toFixed(1)}mm`)
      }
    }
    if (e.type === 'barcode' && !['EAN13', 'code128', 'code39', 'upca'].includes(e.barcodeType)) {
      console.log(`  ⚠ 未识别码制 [${t.id}] ${e.barcodeType} → 将回落 code128`)
    }
  }
}
console.log(warn === 0 ? '文本宽度自检：全部在框内' : `文本宽度自检：${warn} 处需关注`)
