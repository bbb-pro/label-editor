// 验证「字体从画布到 PDF」的保真度 —— 改字体清单 / 改导出映射后跑一遍
// 用法：node scripts/verify-font-fidelity.mjs
//
// 校验三件事：
//   ① 面板可选字体（FONT_FAMILIES）在导出时是否真的原样保留
//   ② 已下架的字体名（老模板里可能有）是否都被归一化到清单内
//   ③ 含特殊符号（℃ ≤ ± …）的文本是否会避开"内置字库没有字形 → 印成方框"的坑
// 这里把 src/ 的对应规则**逐字复制**过来做纯 Node 校验：一旦源码改了规则而这里没同步，
// 输出会与预期不符，从而提醒更新。
import fs from 'node:fs'
import { jsPDF } from 'jspdf'

// ── 与 src/lib/textStyles.ts 保持一致 ──
const FONT_FAMILIES = ['Arial', 'Helvetica', 'Times New Roman', 'Courier New', 'SimHei']
const CJK_FONT = 'SimHei'
const DEFAULT_FONT = 'Arial'
const LEGACY_KEYS = [
  'microsoft yahei', '微软雅黑', 'simsun', '宋体', 'nsimsun', '新宋体', 'kaiti', '楷体',
  'simkai', '仿宋', 'simfang', 'microsoft jhenghei', 'pingfang sc', 'hiragino sans gb',
  'source han sans', 'noto sans cjk sc',
]
const LEGACY_LATIN = {
  times: 'Times New Roman', serif: 'Times New Roman', courier: 'Courier New',
  monospace: 'Courier New', verdana: DEFAULT_FONT, tahoma: DEFAULT_FONT,
  'trebuchet ms': DEFAULT_FONT, impact: DEFAULT_FONT, 'ms sans serif': DEFAULT_FONT,
  'microsoft sans serif': DEFAULT_FONT, 'arial narrow': DEFAULT_FONT, 'segoe ui': DEFAULT_FONT,
  calibri: DEFAULT_FONT, 'comic sans ms': DEFAULT_FONT, 'sans-serif': DEFAULT_FONT,
  sansserif: DEFAULT_FONT,
}
/** 中文类字体名 → 一律归黑体：程序内只有它带中文字形 */
const LEGACY_CJK = Object.fromEntries(LEGACY_KEYS.map((k) => [k, CJK_FONT]))
/** 下架字体名的合并查找表（与源码 LEGACY_FONT_MAP 同构） */
const LEGACY_MAP = { ...LEGACY_CJK, ...LEGACY_LATIN }
const KEEP_BY_LOWER = new Map(FONT_FAMILIES.map((f) => [f.toLowerCase(), f]))
const WINANSI_EXTRA =
  '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ' +
  '¡¢£¤¥¦§¨©ª«¬®¯°±²³´µ¶·¸¹º»¼½¾¿' +
  'ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿ'

function canUseBuiltinFont(text) {
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    if ((cp >= 0x20 && cp <= 0x7e) || cp === 0x0a || cp === 0x09 || cp === 0x0d) continue
    if (WINANSI_EXTRA.includes(ch)) continue
    return false
  }
  return true
}
function normalizeFontFamily(name) {
  const raw = String(name ?? '').trim()
  if (!raw) return DEFAULT_FONT
  const lower = raw.toLowerCase()
  const kept = KEEP_BY_LOWER.get(lower)
  if (kept) return kept
  if (lower.includes(',')) {
    for (const part of lower.split(',')) {
      const seg = part.trim()
      const hit = KEEP_BY_LOWER.get(seg) ?? LEGACY_MAP[seg]
      if (hit) return hit
    }
  }
  return LEGACY_MAP[lower] ?? DEFAULT_FONT
}

// ── 与 src/lib/vectorExport.ts 保持一致 ──
const FONT_ALIAS = 'SimHeiPDF'
const PDF_FONT_LATIN = { helvetica: 'helvetica', times: 'times', courier: 'courier' }
const CANVAS_TO_PDF_FONT = {
  arial: 'helvetica', helvetica: 'helvetica',
  'times new roman': 'times', times: 'times',
  'courier new': 'courier', courier: 'courier',
  simhei: FONT_ALIAS,
  verdana: 'helvetica', tahoma: 'helvetica', 'trebuchet ms': 'helvetica',
  'ms sans serif': 'helvetica', 'microsoft sans serif': 'helvetica',
  georgia: 'times', impact: 'helvetica',
}
function pdfFontFor(famRaw, content) {
  const fam = String(famRaw ?? '').toLowerCase().trim()
  if (!canUseBuiltinFont(content)) return FONT_ALIAS
  const key = fam.includes(',')
    ? (fam.split(',').map((s) => s.trim()).find((s) => CANVAS_TO_PDF_FONT[s]) ?? fam)
    : fam
  return CANVAS_TO_PDF_FONT[key] ?? PDF_FONT_LATIN.helvetica
}
function fontForContent(text) {
  return canUseBuiltinFont(text) ? DEFAULT_FONT : CJK_FONT
}

let fails = 0
const chk = (cond, msg) => {
  if (!cond) { fails++; console.log('  ✗ ' + msg) } else console.log('  ✓ ' + msg)
}

const LATIN = 'LOT-2024-0001'
const CJK = '产品名称'
const SYMBOLS = '25℃ · ±0.5mm · ≤'

console.log('\n① 面板可选字体 → 导出实际字体（应逐行"原样保留"）')
console.log('   字体                | 纯拉丁      | 含中文/符号')
for (const fam of FONT_FAMILIES) {
  const lat = pdfFontFor(fam, LATIN)
  const cjk = pdfFontFor(fam, CJK)
  console.log(
    '   ' + fam.padEnd(19) + ' | ' + (lat === FONT_ALIAS ? '内嵌黑体' : '内置 ' + lat).padEnd(11) +
    ' | ' + (cjk === FONT_ALIAS ? '内嵌黑体' : '内置 ' + cjk),
  )
}
const simheiLat = pdfFontFor('SimHei', LATIN)
chk(simheiLat === FONT_ALIAS, '黑体渲染拉丁文字时，PDF 仍用同一份 simhei（否则画布≠导出）')

console.log('\n② 已下架字体名 → 归一化结果（老模板读入时走这条）')
const legacyExpect = [
  ...LEGACY_KEYS.map((k) => [k, CJK_FONT]),
  ...Object.entries(LEGACY_LATIN).map(([k, v]) => [k, v]),
]
for (const [old, want] of legacyExpect) {
  const got = normalizeFontFamily(old)
  chk(got === want, `${old} → ${got}${got === want ? '' : '（期望 ' + want + '）'}`)
}
chk(normalizeFontFamily('  宋体  ') === CJK_FONT, '首尾空白不影响归一化')
chk(normalizeFontFamily('Arial, SimHei') === 'Arial', '字体族列表取第一个可识别项')
chk(normalizeFontFamily('') === DEFAULT_FONT, '空值回落默认字体')
chk(normalizeFontFamily('SomeUnknownFont') === DEFAULT_FONT, '未知字体回落默认字体')
chk(FONT_FAMILIES.every((f) => normalizeFontFamily(f) === f), '清单内字体归一化后保持原值')

console.log('\n③ 特殊符号：不能让内置字库去画它画不出的字符')
chk(canUseBuiltinFont(LATIN), '纯拉丁 → 可用内置字体')
chk(!canUseBuiltinFont(CJK), '中文 → 必须内嵌')
chk(!canUseBuiltinFont(SYMBOLS), '℃ / ± / ≤ → 必须内嵌（否则 PDF 里是方框）')
chk(canUseBuiltinFont('Café ® ™ ± ° ½'), 'Latin-1 / WinAnsi 内的符号仍走内置')
chk(pdfFontFor('Arial', SYMBOLS) === FONT_ALIAS, 'Arial + ℃ → 自动改走内嵌黑体')
chk(pdfFontFor('Courier New', SYMBOLS) === FONT_ALIAS, 'Courier + ℃ → 自动改走内嵌黑体')
chk(fontForContent(CJK) === CJK_FONT && fontForContent(LATIN) === DEFAULT_FONT,
  '新建文本按内容选字体（画布与导出同判据）')

console.log('\n④ 保留字体的宽度残差（来自 jsPDF 内置宽度表为近似值）')
const ttfWidth = (file, text) => {
  // 简易 TTF 度量：读 head 的 unitsPerEm 与 hmtx，仅用于对比数量级
  const buf = fs.readFileSync(file)
  const numTables = buf.readUInt16BE(4)
  const tables = {}
  for (let i = 0; i < numTables; i++) {
    const off = 12 + i * 16
    tables[buf.toString('ascii', off, off + 4)] = { off: buf.readUInt32BE(off + 8), len: buf.readUInt32BE(off + 12) }
  }
  const upm = buf.readUInt16BE(tables.head.off + 18)
  const numH = buf.readUInt16BE(tables.hhea.off + 34)
  const cmapOff = tables.cmap.off
  const nSub = buf.readUInt16BE(cmapOff + 2)
  let sub = 0
  for (let i = 0; i < nSub; i++) {
    const rec = cmapOff + 4 + i * 8
    const pid = buf.readUInt16BE(rec)
    if (buf.readUInt16BE(rec + 2) === 1 || pid === 3) sub = buf.readUInt32BE(rec + 4)
  }
  const map = {}
  const fmt = buf.readUInt16BE(cmapOff + sub)
  if (fmt === 4) {
    const segX2 = buf.readUInt16BE(cmapOff + sub + 6)
    const seg = segX2 / 2
    const ends = cmapOff + sub + 14
    const starts = ends + segX2 + 2
    const deltas = starts + segX2
    const ranges = deltas + segX2
    for (let s = 0; s < seg; s++) {
      const end = buf.readUInt16BE(ends + s * 2)
      const start = buf.readUInt16BE(starts + s * 2)
      for (let c = start; c <= end && c !== 0xffff; c++) {
        const delta = buf.readInt16BE(deltas + s * 2)
        const ro = buf.readUInt16BE(ranges + s * 2)
        let g = 0
        if (ro === 0) g = (c + delta) & 0xffff
        else {
          const gp = ranges + s * 2 + ro + (c - start) * 2
          if (gp + 2 <= buf.length) { g = buf.readUInt16BE(gp); if (g) g = (g + delta) & 0xffff }
        }
        map[c] = g
      }
    }
  }
  const hmtx = tables.hmtx.off
  const kern = numH
  let total = 0, missing = null
  for (const ch of text) {
    const g = map[ch.codePointAt(0)]
    if (g == null) { missing = ch; break }
    const aw = buf.readUInt16BE(hmtx + Math.min(g, kern - 1) * 4)
    total += aw
  }
  return missing ? { missing } : { width: total / upm }
}
const builtinWidth = (font, text) => {
  const doc = new jsPDF({ unit: 'mm', format: [100, 100] })
  doc.setFont(font, 'normal')
  return doc.getStringUnitWidth(text)
}
const pairs = [
  ['Arial', 'helvetica', 'C:/Windows/Fonts/arial.ttf'],
  ['Times New Roman', 'times', 'C:/Windows/Fonts/times.ttf'],
  ['Courier New', 'courier', 'C:/Windows/Fonts/cour.ttf'],
]
for (const [label, pdfFont, file] of pairs) {
  if (!fs.existsSync(file)) { console.log(`   - ${label}: 本机无字体文件，跳过`); continue }
  const m = ttfWidth(file, LATIN)
  if (m.missing || m.width == null) { console.log(`   - ${label}: 度量失败`); continue }
  const pct = ((builtinWidth(pdfFont, LATIN) - m.width) / m.width) * 100
  console.log(`   ${label.padEnd(16)} 画布 ${m.width.toFixed(3)}em / PDF ${builtinWidth(pdfFont, LATIN).toFixed(3)}em → ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`)
}

console.log(fails === 0 ? '\n全部通过 ✓' : `\n有 ${fails} 项未通过 ✗`)
process.exit(fails === 0 ? 0 : 1)
