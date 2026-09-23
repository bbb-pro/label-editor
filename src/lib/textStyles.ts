// 文本样式：字体与常用字号清单（标签打印常用）

/**
 * 可选字体清单 —— **只收录导出 PDF 时能真正保真的字体**。
 *
 * 背景：导出 / 打印 PDF 走 jsPDF 重建矢量文本，程序内可用的字体资源只有两类：
 *   ① jsPDF 内置的 Helvetica / Times / Courier（PDF 基础 14 字体，无需内嵌，任何设备一致）
 *   ② 内嵌的 `public/fonts/simhei.ttf` 子集（**唯一带中文字形**的资源）
 * 所以「画布上选什么 → PDF 里就是什么」只对下面这些成立：
 *   - Arial / Helvetica  → 内置 Helvetica（Arial 本就是 Helvetica 的度量兼容设计）
 *   - Times New Roman    → 内置 Times（度量兼容）
 *   - Courier New        → 内置 Courier（度量兼容）
 *   - 黑体 SimHei         → 内嵌 simhei 子集（同一份字体数据，字形/字宽完全一致）
 *
 * ⚠️ 其余字体一律不再提供，因为它们在 PDF 里会被**换成别的字体**，字形和文字宽度都会变：
 *   Verdana / Tahoma / Trebuchet MS / Impact → 被换成 Helvetica（实测 Verdana 窄 17%、
 *   Impact 宽 8%，字形也完全不同），Georgia → Times（窄 13%），
 *   微软雅黑 / 宋体 / 楷体 / 仿宋 → 被换成黑体（这几种在程序内根本没有字形数据）。
 * 老模板 / 老标签里若存着这些字体名，读入时由 `normalizeFontFamily()` 归一到最接近的一款，
 * 保证「打开时看到的」与「导出的」一致。
 *
 * 已知固有误差（来自 jsPDF 的内置宽度表是近似值，与字体本身无关）：
 *   Arial → Helvetica 约 -3.2%、Times New Roman → Times 约 -2.0%、Courier New → Courier 0%。
 *   量级 = 12pt 字每 10mm 宽差 0.3mm，肉眼不可辨、不影响对齐（对齐按文本框算，不累计）。
 */
export const FONT_FAMILIES: { value: string; label: string }[] = [
  { value: 'Arial', label: 'Arial' },
  { value: 'Helvetica', label: 'Helvetica' },
  { value: 'Times New Roman', label: 'Times New Roman' },
  { value: 'Courier New', label: 'Courier New' },
  { value: 'SimHei', label: '黑体' },
]

/** 唯一带中文字形的可导出字体（内嵌 simhei）：含中文的文本只有它能做到「所见即所得」 */
export const CJK_FONT = 'SimHei'

/** 兜底字体：未知 / 已下架的拉丁字体名归到这里 */
export const DEFAULT_FONT = 'Arial'

/**
 * 已下架字体名（小写）→ 保留清单里最接近的一款。
 * 中文类一律归黑体（其余中文都没有字形数据）；拉丁类归到度量/字形最近的。
 */
const LEGACY_FONT_MAP: Record<string, string> = {
  'microsoft yahei': CJK_FONT,
  微软雅黑: CJK_FONT,
  simsun: CJK_FONT,
  宋体: CJK_FONT,
  nsimsun: CJK_FONT,
  新宋体: CJK_FONT,
  kaiti: CJK_FONT,
  楷体: CJK_FONT,
  simkai: CJK_FONT,
  仿宋: CJK_FONT,
  simfang: CJK_FONT,
  'microsoft jhenghei': CJK_FONT,
  'pingfang sc': CJK_FONT,
  'hiragino sans gb': CJK_FONT,
  'source han sans': CJK_FONT,
  'noto sans cjk sc': CJK_FONT,
  // 拉丁
  times: 'Times New Roman',
  serif: 'Times New Roman',
  courier: 'Courier New',
  monospace: 'Courier New',
  verdana: DEFAULT_FONT,
  tahoma: DEFAULT_FONT,
  'trebuchet ms': DEFAULT_FONT,
  impact: DEFAULT_FONT,
  'ms sans serif': DEFAULT_FONT,
  'microsoft sans serif': DEFAULT_FONT,
  'arial narrow': DEFAULT_FONT,
  'segoe ui': DEFAULT_FONT,
  calibri: DEFAULT_FONT,
  'comic sans ms': DEFAULT_FONT,
  'sans-serif': DEFAULT_FONT,
  sansserif: DEFAULT_FONT,
}

const KEEP_BY_LOWER = new Map(FONT_FAMILIES.map((f) => [f.value.toLowerCase(), f.value]))

/**
 * 把任意字体名归一到保留清单内的值。
 * 用途：① 读老模板 / 老标签（里面可能存着已下架的字体名）；
 *      ② 外部导入的数据；③ 未知字体兜底。
 * 已经是保留清单内的字体则原样返回（大小写按清单统一）。
 */
export function normalizeFontFamily(name: unknown): string {
  const raw = String(name ?? '').trim()
  if (!raw) return DEFAULT_FONT
  const lower = raw.toLowerCase()
  const kept = KEEP_BY_LOWER.get(lower)
  if (kept) return kept
  // 兼容 "Arial, SimHei" 这类字体族列表：取第一个能识别的
  if (lower.includes(',')) {
    for (const part of lower.split(',')) {
      const seg = part.trim()
      const hit = KEEP_BY_LOWER.get(seg) ?? LEGACY_FONT_MAP[seg]
      if (hit) return hit
    }
  }
  return LEGACY_FONT_MAP[lower] ?? DEFAULT_FONT
}

/** 该字体名（归一到清单后）是否是「含中文字形」的那一款 */
export function fontSupportsCjk(name: unknown): boolean {
  return normalizeFontFamily(name) === CJK_FONT
}

export const FONT_SIZES_PT: number[] = [
  6, 7, 8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 32, 36, 40, 48,
]

/**
 * PDF 内置字体（jsPDF 的 Helvetica / Times / Courier，WinAnsi 编码）能否安全表示这段文本。
 *
 * ⚠️ 判据必须严格：内置字体只带 WinAnsi 字形，一旦混入它没有的字符（中文、日文、韩文、
 * emoji、℃ ≤ ≥ …），PDF 里就会印成乱码或方框 —— 而标签上「25℃」「±0.5mm」恰恰很常见。
 * 凡返回 false 的文本，导出时会退回内嵌黑体子集（simhei 覆盖 GB2312，这些符号都有字形）。
 *
 * 白名单 = 可打印 ASCII + WinAnsi 的 Latin-1 / Windows-1252 补充区。
 * 导出侧（lib/vectorExport.ts）与属性面板提示共用此判据，保证「面板说的」= 「实际做的」。
 */
const WINANSI_EXTRA =
  '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ' +
  '¡¢£¤¥¦§¨©ª«¬®¯°±²³´µ¶·¸¹º»¼½¾¿' +
  'ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿ'

export function canUseBuiltinFont(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    // 可打印 ASCII + 换行/制表/回车（排版用）
    if ((cp >= 0x20 && cp <= 0x7e) || cp === 0x0a || cp === 0x09 || cp === 0x0d) continue
    if (WINANSI_EXTRA.includes(ch)) continue
    return false
  }
  return true
}

/** px（fabric 使用）→ pt（展示给用户） */
export const pxToPt = (px: number): number => (px * 72) / 96
/** pt → px */
export const ptToPx = (pt: number): number => (pt * 96) / 72

export function clampPt(pt: number): number {
  if (!Number.isFinite(pt)) return 12
  return Math.min(200, Math.max(2, pt))
}
