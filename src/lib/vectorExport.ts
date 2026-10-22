// 矢量 PDF 导出
// 把画布对象用 jsPDF 的矢量 API 重建，文字(含中文)通过“内嵌中文字体子集”输出为
// 真正可选中/可搜索的矢量文本，而非位图快照。
// - 中文字体：运行时 fetch public/fonts/simhei.ttf，用 fonteditor-core 按当前页用到
//   的字符子集化后 addFileToVFS + addFont 内嵌（子集通常只有几 KB ~ 几十 KB）。
// - 文本：逐行重建（拆 \n 与按盒宽折行），支持对齐/行高/字距/粗体(近似加粗)。
// - 形状：矩形(含圆角)/椭圆/三角形/菱形/五角星/直线全部走矢量；闭合多边形用 doc.lines。
// - 条码/图片：以位图嵌入（条码为高对比模块，位图在印刷/放大时足够清晰）。
// - SVG 素材：整段 SVG 交给 svg2pdf 重绘为矢量路径，放大印刷不失真。
// - 旋转：文本用 jsPDF text({angle})，图形绕中心旋转后描点。
import jsPDF from 'jspdf'
import { Font } from 'fonteditor-core'
import type { PaperOrder, PaperSize, DataRow } from '@/types/template'
import type { CanvasController } from '@/lib/canvasEngine'
import { pxToMm } from '@/lib/mm'
import { pxToPt, canUseBuiltinFont } from '@/lib/textStyles'
import { type BarcodeType, type BarcodeRenderSettings, DEFAULT_BARCODE_SETTINGS } from '@/lib/barcode'
import { renderBarcodeVectorRects } from '@/lib/barcodeVector'
import {
  normalizeRows,
  tableColSpans,
  tableRowSpans,
  spanOffsets,
  type TableSpec,
} from '@/lib/table'
import type { fabric } from 'fabric'
// 引入后会给 jsPDF 原型挂上 .svg()，用于把完整 SVG 绘制为矢量路径
import 'svg2pdf.js'

const FONT_ALIAS = 'SimHeiPDF'
const FONT_URL = () => `${import.meta.env.BASE_URL}fonts/simhei.ttf`

/**
 * 画布字体 → PDF 字体映射。
 *
 * 背景：网络上没有任何"画布字体=PDF 字体"的自动对应关系，必须显式建立映射。
 * 策略分两类：
 * 1) 拉丁字体 → jsPDF 内置标准字体（Helvetica / Times / Courier），
 *    它们是 PDF 基础 14 字体，**无需内嵌**、跨平台字面稳定，且是矢量。
 *    字面保真度：Helvetica / Times / Courier 与同名 Windows 字体的**度量基本一致**
 *    （Courier 完全一致，Times 约 -2%，Helvetica 约 -3% —— 残差来自 jsPDF 内置宽度表
 *    是近似值，与字体本身无关）。
 * 2) 中文字体 / 未知字体 → 内嵌 simhei 子集（唯一可用的中文字体资源）。
 *
 * ⚠️ 可选的画布字体清单已收敛为「能保真的那几款」（见 `lib/textStyles.ts` 的 FONT_FAMILIES），
 *    这里保留已下架字体的映射仅作兼容兜底：万一有旧数据绕过归一化直接进来，
 *    仍然映射到最接近的字体，而不是掉进"未知字体全用黑体"的坑。
 */
const PDF_FONT_LATIN = {
  helvetica: 'helvetica',
  times: 'times',
  courier: 'courier',
} as const

/** 画布字体名（小写匹配）→ jsPDF 内置字体名；不在表内的按无衬线兜底 */
const CANVAS_TO_PDF_FONT: Record<string, string> = {
  arial: PDF_FONT_LATIN.helvetica,
  helvetica: PDF_FONT_LATIN.helvetica,
  'times new roman': PDF_FONT_LATIN.times,
  times: PDF_FONT_LATIN.times,
  'courier new': PDF_FONT_LATIN.courier,
  courier: PDF_FONT_LATIN.courier,
  // 黑体：PDF 侧内嵌同一份 simhei 子集 → 画布是 simhei、PDF 也是 simhei，字形完全一致。
  // ⚠️ 即使内容是纯拉丁也必须走子集：否则画布（SimHei 的拉丁字形）与
  //    PDF（内置 Helvetica）两边不一样，又变成"字体变了"。
  simhei: FONT_ALIAS,
  // ↓ 已从面板下架（导出时字形/字宽变化明显），保留映射以兼容旧数据
  verdana: PDF_FONT_LATIN.helvetica,
  tahoma: PDF_FONT_LATIN.helvetica,
  'trebuchet ms': PDF_FONT_LATIN.helvetica,
  'ms sans serif': PDF_FONT_LATIN.helvetica,
  'microsoft sans serif': PDF_FONT_LATIN.helvetica,
  georgia: PDF_FONT_LATIN.times,
  impact: PDF_FONT_LATIN.helvetica,
}

/**
 * fabric 的「行高换算系数」（`fabric.Text._fontSizeMult`，fabric 5 里固定 1.13）。
 *
 * ⚠️ 画布上「基线到基线」的距离**不是** `fontSize × lineHeight`：
 *    `getHeightOfLine(i) = fontSize × lineHeight × 1.13`
 *    首行基线距文字盒顶 = `getHeightOfLine / lineHeight = fontSize × 1.13`
 *    （见 fabric `_getHeightOfLine` / `_renderTextCommon`：`top + lineHeights + maxHeight`）
 *
 * 早期 PDF 只按 `fontSize × lineHeight` 排行 → 行距比画布小 13%：
 * 20px/1.35 的文本画布行距 30.51px、PDF 只有 27px，每行差 3.5px，
 * 5 行文本累计偏 14px（≈3.7mm）→ 越往下越往"上"跑，最终压在表格线/下划线上。
 * 首行基线也用了 0.86em（≈17.2px）而非 1.13em（22.6px）→ 整体再高 1.4mm。
 * 这两处必须与 fabric 同口径，导出才真正"所见即所得"。
 */
const FABRIC_LINE_MULT = 1.13

/**
 * 取某对象应使用的 PDF 字体名。
 * 判据：内容能安全交给内置字体 **且** 画布用的是拉丁字体 → 内置字体，否则 → 内嵌子集。
 * ⚠️ 兜底方向很关键：**含中文/特殊符号一律内嵌子集**（唯一不会出方框的解），
 *    而"未知字体 + 纯拉丁"按无衬线兜底 —— 拿黑体去画拉丁文字，字宽与字形都差得远。
 * 判据函数 canUseBuiltinFont 与属性面板提示共用（见 lib/textStyles.ts）。
 */
function pdfFontFor(obj: fabric.Object, content: string): string {
  const fam = String((obj as { fontFamily?: string }).fontFamily ?? '').toLowerCase().trim()
  if (!canUseBuiltinFont(content)) return FONT_ALIAS
  // 字体族列表（"Arial, SimHei"）取第一个能识别的
  const key = fam.includes(',')
    ? (fam.split(',').map((s) => s.trim()).find((s) => CANVAS_TO_PDF_FONT[s]) ?? fam)
    : fam
  return CANVAS_TO_PDF_FONT[key] ?? PDF_FONT_LATIN.helvetica
}

/** 条码组里的「人读文字」child（只有一维码有） */
function hrtTextChild(o: fabric.Object): fabric.Object | null {
  const kids = (o as unknown as { _objects?: fabric.Object[] })._objects
  if (!Array.isArray(kids)) return null
  return kids.find((k) => k.type === 'text' || k.type === 'textbox' || k.type === 'i-text') ?? null
}

/**
 * 取某个叶子对象在 PDF 里**实际使用**的字体。
 * ⚠️ 条码必须看它的「人读文字 child」：fabric.Group 自身没有 fontFamily，直接取会判成
 *    「非拉丁字体」→ 走内嵌中文字体画数字/字母 —— 与画布 Arial 的字形、字宽都不一致，
 *    还会让 PDF 的体积无谓变大（子集里塞进一堆用不到的字符）。
 */
function leafFontFor(o: fabric.Object, content: string): string {
  const kind = (o as unknown as { kind?: string }).kind
  return pdfFontFor(kind === 'barcode' ? (hrtTextChild(o) ?? o) : o, content)
}

export interface VectorPdfOptions {
  copies?: number
  name?: string
  onProgress?: (done: number, total: number) => void
  /** 按表格行批量导出：传入要打印的数据行，每页切换一次预览行（文本框名称=表头时自动取该列值） */
  rows?: DataRow[]
  /** 多标签页序：set=按套(A1 B1 A2 B2)，paper=按标签(A1 A2 B1 B2) */
  order?: PaperOrder
  /** 打印范围：true=只输出当前活动标签，false/缺省=全部标签 */
  onlyActive?: boolean
}

/** fabric 自带的辅助：1/1000 em → 毫米的缩放系数由字号决定，见使用处 */
const MM_PER_PT = 25.4 / 72

type Leaf = fabric.Object

/** 数值精度：避免 PDF 里出现超长小数 */
function n(v: number): number {
  return Math.round((v + Number.EPSILON) * 1000) / 1000
}

/** 展开顶层对象成“叶子”（穿透 fabric.Group，统一矢量绘制）。
 *  仅保留落在标签区域内的对象；纸外的临时摆放不导出/不打印。 */
function flattenLeaves(ctrl: CanvasController): Leaf[] {
  const out: Leaf[] = []
  // insideGroup：子对象是相对 group 的局部坐标，不能再按「是否在纸内」判定，否则会被误过滤
  const walk = (list: fabric.Object[], insideGroup = false) => {
    for (const o of list) {
      // 纸卡背景矩形(excludeFromExport)和标签外的暂存对象都跳过
      if ((o as { excludeFromExport?: boolean }).excludeFromExport) continue
      const kind = (o as unknown as { kind?: string }).kind
      const children = (o as unknown as { _objects?: fabric.Object[] })._objects
      // 条码、SVG 素材都是 Group 形态的「原子对象」，必须整体交给各自的绘制分支。
      // 若穿透成子矩形/子路径：①子对象是 group 局部坐标 → isObjectInPaper 误判纸外而丢失；
      // ②子 path 没有对应绘制分支 → 直接导出为空。
      const isBarcode = kind === 'barcode'
      const isAtomic = isBarcode || kind === 'svg' || kind === 'table'
      if (!isAtomic && o.type === 'group' && Array.isArray(children)) {
        if (!insideGroup && !ctrl.isObjectInPaper(o)) continue
        walk(children, true)
        continue
      }
      if (!insideGroup && !ctrl.isObjectInPaper(o)) continue
      out.push(o)
    }
  }
  walk(ctrl.canvas.getObjects())
  return out
}

/* ── 颜色 ─────────────────────────────────────────── */

function parseColor(color: string | null | undefined): [number, number, number] | null {
  if (!color) return null
  const c = String(color).trim().toLowerCase()
  if (c === 'transparent' || c === 'rgba(0, 0, 0, 0)') return null
  if (c.startsWith('#')) {
    const h = c.slice(1)
    if (/^[0-9a-f]{3}$/.test(h))
      return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)]
    if (/^[0-9a-f]{6}$/.test(h))
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
    return null
  }
  const m = c.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/)
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])]
  return null
}

/* ── 中文字体子集化 + 内嵌 ─────────────────────────── */

/** TTF 原始字节的内存缓存：避免每次导出都重新 fetch 字体文件 */
let _ttfCache: ArrayBuffer | null = null
async function loadTtf(): Promise<ArrayBuffer> {
  if (_ttfCache) return _ttfCache
  const resp = await fetch(FONT_URL())
  if (!resp.ok) throw new Error(`字体加载失败 HTTP ${resp.status}`)
  _ttfCache = await resp.arrayBuffer()
  return _ttfCache
}

/**
 * 传入需要包含的字符数组，生成可嵌入 jsPDF 的子集字体。
 * 任何一步失败（网络 / 字体内不含目标字形 / 子集化异常）都返回 null，
 * 由调用方降级为内置 Helvetica —— 保证图表/形状/条码等非文本内容仍能导出，
 * 而不是整份 PDF 直接失败。
 */
async function subsetFont(chars: Iterable<number>): Promise<{ embed: (doc: jsPDF) => void } | null> {
  try {
    const cps = new Set<number>(chars)
    // 始终补全 ASCII 与常见标点，避免某些运行依赖
    for (let c = 0x20; c <= 0x7e; c++) cps.add(c)
    for (const ch of '，。、；：？！（）【】“”‘’·—…％‰＋－＝≤≥×÷㎡℃~№') cps.add(ch.codePointAt(0)!)
    const buf = await loadTtf()
    const font = Font.create(buf, { type: 'ttf', subset: [...cps], compound2simple: true })
    const out = font.write({ type: 'ttf' })
    const u8: Uint8Array = out instanceof Uint8Array ? out : new Uint8Array(out as ArrayBuffer)
    let bin = ''
    const CHUNK = 0x4000
    for (let i = 0; i < u8.length; i += CHUNK) bin += String.fromCharCode(...Array.from(u8.subarray(i, i + CHUNK)))
    const b64 = btoa(bin)
    return {
      embed(doc: jsPDF) {
        doc.addFileToVFS(`${FONT_ALIAS}.ttf`, b64)
        doc.addFont(`${FONT_ALIAS}.ttf`, FONT_ALIAS, 'normal')
      },
    }
  } catch (err) {
    console.warn('[vectorExport] 中文字体子集化失败，降级为 Helvetica（中文可能显示为方框）', err)
    return null
  }
}

/* ── 几何（世界 mm，左上原点，y 向下） ─────────────── */

interface Box {
  left: number
  top: number
  w: number
  h: number
  cx: number
  cy: number
  angleDeg: number
}

/**
 * 纸张原点（工作区坐标,px）：getBoundingRect(true) 返回的是「工作区」坐标，
 * 而 PDF 页面尺寸只等于纸张大小，绘制前必须减去该原点，
 * 否则所有内容都被画到 ~600mm 之外的页面外 → 表现为「导出空白 PDF」。
 *
 * ⚠️ 用「模块级变量 + 每页覆写」在并发导出时会互相污染（两路 buildVectorPdf 交错）。
 * 现改为随 buildVectorPdf 的 drawPage 闭包传递；此处仅保留当前原点，供叶子绘制函数读取。
 */
let originX = 0
let originY = 0

/** 设置当前绘制页的纸张原点（仅在 buildVectorPdf 的单页绘制临界区内使用） */
function setOrigin(x: number, y: number) {
  originX = x
  originY = y
}

function leafBox(o: Leaf): Box {
  const rect = o.getBoundingRect(true)
  const angleDeg = totalAngleOf(o)
  const left = rect.left - originX
  const top = rect.top - originY
  return {
    left: pxToMm(left),
    top: pxToMm(top),
    w: pxToMm(rect.width),
    h: pxToMm(rect.height),
    cx: pxToMm(left + rect.width / 2),
    cy: pxToMm(top + rect.height / 2),
    angleDeg,
  }
}

/**
 * 对象「含父容器」的累计缩放：编组 / 多选（ActiveSelection）里的子对象保留的是
 * 父容器内的局部坐标，其 scaleX/scaleY 也只是相对父容器的，必须沿 group 链累乘，
 * 否则「缩放整个编组」时内部条码的换算比例会漏掉父级缩放。
 */
function totalScaleOf(o: Leaf): { x: number; y: number } {
  let x = o.scaleX ?? 1
  let y = o.scaleY ?? 1
  let p = (o as unknown as { group?: fabric.Object | null }).group ?? null
  let depth = 0
  while (p && depth++ < 16) {
    x *= p.scaleX ?? 1
    y *= p.scaleY ?? 1
    p = (p as unknown as { group?: fabric.Object | null }).group ?? null
  }
  return { x, y }
}

function rot(cx: number, cy: number, x: number, y: number, deg: number): [number, number] {
  if (deg % 360 === 0) return [x, y]
  const r = (deg * Math.PI) / 180
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  const dx = x - cx
  const dy = y - cy
  return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos]
}

/**
 * 对象「未旋转」的自身尺寸（含父链缩放，mm）。
 *
 * ⚠️ **不要**用 `leafBox(o).w/h` 当几何尺寸：`getBoundingRect` 返回的是**旋转后**的
 * 轴对齐包围盒，转 90° 时 w/h 会被互换、转 45° 时会被放大 √2 倍；再绕中心转一次
 * 就画成了「更大的框转一次」。典型的两个灾难：
 *   · 竖线（width=113, height=0, angle=90°）→ 包围盒宽≈线宽 1.5px → 导出成 0.4mm 的点，肉眼「没了」；
 *   · 多行文本 → 首行锚点取包围盒顶，整体朝对角线方向漂移。
 * 自身尺寸 + `leafBox().cx/cy`（旋转不改变中心）才是正确基准。
 */
function ownSizeMm(o: Leaf): { w: number; h: number } {
  const s = totalScaleOf(o)
  return { w: pxToMm((o.width ?? 0) * s.x), h: pxToMm((o.height ?? 0) * s.y) }
}

/**
 * 「含父容器」的累计旋转角度。
 *
 * fabric 里组内子对象的 `angle` 是**相对组**的，最终朝向 = 子角度 + 父链角度之和
 * （仅在缩放均匀时严格成立；非均匀缩放会变成剪切，本导出器不支持剪切，见文末说明）。
 * 只取 `o.angle` 会让「把整个编组转 30°」后组内文字/线条在 PDF 里**没转**，
 * 位置却按包围盒算对了 —— 看起来就是「转过的编组导出后打散错位」。
 */
function totalAngleOf(o: Leaf): number {
  let a = o.angle ?? 0
  let p = (o as unknown as { group?: fabric.Object | null }).group ?? null
  let depth = 0
  while (p && depth++ < 16) {
    a += p.angle ?? 0
    p = (p as unknown as { group?: fabric.Object | null }).group ?? null
  }
  return ((a % 360) + 360) % 360
}

function rotPts(cx: number, cy: number, pts: Array<[number, number]>, deg: number): Array<[number, number]> {
  return pts.map(([x, y]) => rot(cx, cy, x, y, deg))
}

/* ── 各类对象绘制 ─────────────────────────────────── */

/**
 * 复用 fabric 自己算好的断行结果（含字间距、中文逐字断行、宽度约束），
 * 让 PDF 的换行与画布逐行一致。仅当对象当前文本与待导出内容完全一致时才采用，
 * 否则返回 null，退回 jsPDF 自行断行（保底，不会画错内容）。
 */
function fabricWrappedLines(it: fabric.Textbox, content: string): string[] | null {
  const tl = (it as unknown as { textLines?: unknown }).textLines
  if (!Array.isArray(tl) || tl.length === 0) return null
  const lines = tl.filter((l): l is string => typeof l === 'string')
  if (lines.length !== tl.length) return null
  const norm = (s: string) => s.replace(/\r\n?/g, '\n')
  return norm(lines.join('\n')) === norm(content) ? lines : null
}

/** 用 jsPDF 自测文本宽度(mm)：getStringUnitWidth 返回 em 数 */
function measureTextMm(doc: jsPDF, s: string, fontSizePt: number): number {
  return doc.getStringUnitWidth(s) * fontSizePt * MM_PER_PT
}

/**
 * 文本对象 → 矢量逐行重建。
 * 断行优先复用 fabric 的 textLines，逐行宽度也用它（含字间距），
 * 这样居中/右对齐的锚点与画布一致——jsPDF 自身的 align 不计 charSpace。
 */
function drawTextObject(doc: jsPDF, o: Leaf, content: string) {
  if (!content) return
  const it = o as unknown as fabric.Textbox
  const box = leafBox(o)
  // 含父链缩放：编组里的文本也按真实比例出字号/行宽
  const scl = totalScaleOf(o)

  const fontSizePx = (it.fontSize ?? 12) * scl.y
  const fontSizePt = pxToPt(fontSizePx)
  const wrapWmm = pxToMm((it.width ?? 1) * scl.x)
  const charSpacing = it.charSpacing ?? 0

  const isBold =
    (it.fontWeight ?? '') === 'bold' || (typeof it.fontWeight === 'number' && it.fontWeight >= 600)
  const align = ((it.textAlign as string) || 'left') as 'left' | 'center' | 'right' | 'justify'
  const lineHeightF = it.lineHeight ?? 1.16

  // 字体：拉丁字体走 jsPDF 内置字体（字面与画布一致，如 Arial→Helvetica），
  // 中文/未知字体走内嵌子集。粗体用内置字体时可交给 PDF 用真实 bold 字重。
  const pdfFont = pdfFontFor(it as unknown as fabric.Object, content)
  const useBuiltinBold = pdfFont !== FONT_ALIAS && isBold
  doc.setFont(pdfFont, useBuiltinBold ? 'bold' : 'normal')
  doc.setFontSize(fontSizePt)
  // 字间距：fabric 的 charSpacing 与 PDF 的 Tc 同为「千分之一 em」，
  // 而 jsPDF 的 charSpace 按用户单位写入 Tc（mm 单位下会被乘 scaleFactor），
  // 故这里做一次 mm 换算即可等价（已实测）。
  doc.setCharSpace(charSpacing * MM_PER_PT)

  const rgb = parseColor((it.fill as string) ?? '#000000') ?? [0, 0, 0]
  doc.setTextColor(rgb[0], rgb[1], rgb[2])

  // 文本区域若有背景/描边盒，先画（若用户设置了 textBackgroundColor 由 fabric 用 styles 渲染，此简版忽略，
  // 仅处理全局 stroke 边框——多数文本无框）
  // 行距与首行基线：必须与 fabric 的排版同口径（含 1.13 的行高系数），
  // 否则行距会比画布小 13%，多行文本逐行上漂、压到线条上。详见 FABRIC_LINE_MULT。
  const emMm = pxToMm(fontSizePx) // 1em 的字身高度(mm)
  const lineLead = emMm * lineHeightF * FABRIC_LINE_MULT // 基线到基线
  const ascent = emMm * FABRIC_LINE_MULT // 首行基线距文字盒顶

  // 断行：优先复用 fabric 的换行结果（与画布逐行一致），并取它算好的行宽
  const fabricLines = fabricWrappedLines(it, content)
  const lines: string[] = []
  /** 每行宽度(mm，含字间距)；NaN = 待用 jsPDF 兜底测量 */
  const lineWmm: number[] = []
  const pushLine = (s: string, w: number) => {
    lines.push(s)
    lineWmm.push(w)
  }
  if (fabricLines) {
    for (let i = 0; i < fabricLines.length; i++) {
      const raw = typeof it.getLineWidth === 'function' ? it.getLineWidth(i) : NaN
      pushLine(fabricLines[i], Number.isFinite(raw) ? pxToMm(raw * scl.x) : NaN)
    }
  } else {
    for (const para of content.split('\n')) {
      const wrapped = para
        ? (doc.splitTextToSize(para, Math.max(wrapWmm, 0.5)) as string[])
        : ['']
      for (const l of wrapped) pushLine(l, NaN)
    }
  }
  if (lines.length === 0) lines.push('')

  // 垂直锚点：以「未旋转」盒顶为首行字身顶（Textbox 无垂直对齐，文字贴顶渲染）。
  // ⚠️ 旋转后必须回到「中心 + 自身尺寸」重建：
  //    getBoundingRect 的 left/top 是旋转后包围盒的角点（转 45° 时离真实盒顶差 (√2−1)·尺寸/2），
  //    拿它当锚点会让整块文字沿对角线漂移；再对每行套 angle 就变成「斜着排的一摞」。
  //    旋转不改变中心，所以：盒顶左 = 中心 − 尺寸/2，每行落点算好后再绕中心转。
  const boxW = pxToMm((it.width ?? 0) * scl.x)
  const boxH = pxToMm((it.height ?? 0) * scl.y)
  const cx = box.cx
  const cy = box.cy
  const left0 = cx - boxW / 2
  const top0 = cy - boxH / 2
  const rotDeg = box.angleDeg
  const needRot = rotDeg % 360 !== 0

  for (let li = 0; li < lines.length; li++) {
    const str = lines[li]
    if (!str) continue
    // baseline 第 li 行
    const baseY = top0 + ascent + li * lineLead
    // x 依对齐：以盒左/中/右定位。⚠️ jsPDF 的 align 用它自己的宽度（不计 charSpace），
    // 字间距下会偏，故这里用行宽自己算锚点、以左对齐绘制。
    let w = lineWmm[li]
    if (!Number.isFinite(w)) w = measureTextMm(doc, str, fontSizePt)
    let x = left0
    if (align === 'center') x = left0 + Math.max(wrapWmm - w, 0) / 2
    else if (align === 'right') x = left0 + Math.max(wrapWmm - w, 0)

    const [dx, dy] = needRot ? rot(cx, cy, x, baseY, rotDeg) : [x, baseY]
    const textOpts: Record<string, unknown> = {}
    if (needRot) textOpts.angle = rotDeg
    // 粗体：中文走内嵌子集，没有真实 bold 字重。
    // ⚠️ 绝不能用「同一行画两遍、第二遍右偏一点」的土办法 —— PDF 里那就是两串字形叠在
    //    一起（实测「蓝莓果汁」被画 2 次、两次 x 相差 0.89mm，肉眼看到的就是「文字重叠」）。
    //    改用 PDF 原生的「填充 + 描边」渲染模式一次成稿：字形沿轮廓均匀外扩，是真正的加粗，
    //    只有一份字形数据。描边宽度取 0.05em（≈ 每边加粗 2.5% 字号）。
    if (isBold && !useBuiltinBold) {
      doc.setDrawColor(rgb[0], rgb[1], rgb[2])
      doc.setLineWidth(fontSizePt * MM_PER_PT * 0.05)
      textOpts.renderingMode = 'fillThenStroke'
    }
    doc.text(str, n(dx), n(dy), textOpts)
  }
  // 复位字间距，避免影响后续文本（如条码人读文字）
  doc.setCharSpace(0)
}

/** 矩形（含圆角，支持旋转：旋转时用闭合多边形近似圆角边） */
function drawRectObject(doc: jsPDF, o: Leaf) {
  const rect = o as unknown as fabric.Rect
  const box = leafBox(o)
  const scl = totalScaleOf(o)
  const fill = parseColor((rect.fill as string) ?? 'transparent')
  const stroke = parseColor((rect.stroke as string) ?? 'transparent')
  const swPx = (rect.strokeWidth ?? 0) * (rect.strokeUniform ? 1 : scl.x)
  const hasFill = fill != null
  const hasStroke = stroke != null && swPx > 0
  if (!hasFill && !hasStroke) return
  const rxPx = (rect.rx ?? 0) * scl.x
  const swMm = pxToMm(swPx)

  // 几何盒 =「未旋转自身尺寸」+ 中心（旋转不改中心）。⚠️ 别用 boundingBox：
  // 它把描边宽度也算进 w/h，且旋转后 w/h 已互换 → 画出来的框既偏大又被转了第二次。
  const { w, h } = ownSizeMm(o)
  if (w <= 0 || h <= 0) return
  const left = box.cx - w / 2
  const top = box.cy - h / 2

  const style: 'F' | 'S' | 'FD' = hasFill && hasStroke ? 'FD' : hasFill ? 'F' : 'S'
  const isRotated = box.angleDeg % 360 !== 0
  // 无旋转 + 有圆角 → roundedRect
  if (!isRotated && rxPx > 0) {
    if (hasFill) doc.setFillColor(fill![0], fill![1], fill![2])
    if (hasStroke) {
      doc.setDrawColor(stroke![0], stroke![1], stroke![2])
      doc.setLineWidth(swMm)
    }
    const rxMm = pxToMm(rxPx)
    doc.roundedRect(n(left), n(top), n(w), n(h), n(rxMm), n(rxMm), style)
    return
  }
  // 否则多边形路径（旋转 / 直角共用）
  const corners: Array<[number, number]> = [
    [left, top],
    [left + w, top],
    [left + w, top + h],
    [left, top + h],
  ]
  const pts = rotPts(box.cx, box.cy, corners, box.angleDeg)
  if (hasFill) {
    doc.setFillColor(fill![0], fill![1], fill![2])
    fillPoly(doc, pts)
  }
  if (hasStroke) {
    doc.setDrawColor(stroke![0], stroke![1], stroke![2])
    doc.setLineWidth(swMm)
    strokePoly(doc, pts)
  }
}

/** 椭圆 */
function drawEllipseObject(doc: jsPDF, o: Leaf) {
  const obj = o as unknown as fabric.Ellipse
  const box = leafBox(o)
  const scl = totalScaleOf(o)
  const fill = parseColor((obj.fill as string) ?? 'transparent')
  const stroke = parseColor((obj.stroke as string) ?? 'transparent')
  const swPx = (obj.strokeWidth ?? 0) * (obj.strokeUniform ? 1 : scl.x)
  const hasFill = fill != null
  const hasStroke = stroke != null && swPx > 0
  if (!hasFill && !hasStroke) return
  const style: 'F' | 'S' | 'FD' = hasFill && hasStroke ? 'FD' : hasFill ? 'F' : 'S'
  if (hasFill) doc.setFillColor(fill![0], fill![1], fill![2])
  if (hasStroke) {
    doc.setDrawColor(stroke![0], stroke![1], stroke![2])
    doc.setLineWidth(pxToMm(swPx))
  }
  // 半径用自身尺寸（不含描边、不受旋转影响），和矩形同一口径
  const { w, h } = ownSizeMm(o)
  const rx = w / 2
  const ry = h / 2
  if (rx <= 0 || ry <= 0) return
  if (box.angleDeg % 360 === 0) {
    doc.ellipse(n(box.cx), n(box.cy), n(rx), n(ry), style)
    return
  }
  // jsPDF 的 ellipse() 没有旋转参数 → 采样成折线，绕中心转后再画（48 段足够平滑）
  const SEG = 48
  const pts: Array<[number, number]> = []
  for (let i = 0; i < SEG; i++) {
    const a = (Math.PI * 2 * i) / SEG
    pts.push([box.cx + rx * Math.cos(a), box.cy + ry * Math.sin(a)])
  }
  const world = rotPts(box.cx, box.cy, pts, box.angleDeg)
  if (hasFill) fillPoly(doc, world)
  if (hasStroke) strokePoly(doc, world)
}

/** 任意闭合多边形：填充 + 描边 */
function drawClosedPoly(doc: jsPDF, o: Leaf, worldPts: Array<[number, number]>) {
  const fill = parseColor((o.fill as string) ?? 'transparent')
  const stroke = parseColor((o.stroke as string) ?? 'transparent')
  const swPx = (o.strokeWidth ?? 0) * (o.strokeUniform ? 1 : (o.scaleX ?? 1))
  const hasFill = fill != null
  const hasStroke = stroke != null && swPx > 0
  if (!hasFill && !hasStroke) return
  if (hasFill) {
    doc.setFillColor(fill![0], fill![1], fill![2])
    fillPoly(doc, worldPts)
  }
  if (hasStroke) {
    doc.setDrawColor(stroke![0], stroke![1], stroke![2])
    doc.setLineWidth(pxToMm(swPx))
    strokePoly(doc, worldPts)
  }
}

/** 用 doc.lines 填充闭合多边形（正确处理凹多边形如五角星） */
function fillPoly(doc: jsPDF, pts: Array<[number, number]>) {
  if (pts.length < 3) return
  const segs: Array<[number, number]> = []
  for (let i = 0; i < pts.length; i++) {
    const next = pts[(i + 1) % pts.length]
    segs.push([next[0] - pts[i][0], next[1] - pts[i][1]])
  }
  doc.lines(segs, pts[0][0], pts[0][1], [1, 1], 'F', true)
}

function strokePoly(doc: jsPDF, pts: Array<[number, number]>) {
  if (pts.length < 2) return
  const nPts = pts.length
  const segs: Array<[number, number]> = []
  for (let i = 0; i < nPts; i++) {
    const next = pts[(i + 1) % nPts]
    segs.push([next[0] - pts[i][0], next[1] - pts[i][1]])
  }
  doc.lines(segs, pts[0][0], pts[0][1], [1, 1], 'S', true)
}

/** 形状：三角形/菱形/五角星（ellipse 单独） */
function drawShapeObject(doc: jsPDF, o: Leaf) {
  const shapeType = (o as unknown as { _shapeType?: string })._shapeType
  if (o.type === 'ellipse' || shapeType === 'ellipse') {
    drawEllipseObject(doc, o)
    return
  }
  const wLocal = o.width ?? 1
  const hLocal = o.height ?? 1
  let local: Array<[number, number]> = []
  if (o.type === 'triangle' || shapeType === 'triangle') {
    local = [
      [wLocal / 2, 0],
      [wLocal, hLocal],
      [0, hLocal],
    ]
  } else if (shapeType === 'diamond') {
    local = [
      [wLocal / 2, 0],
      [wLocal, hLocal / 2],
      [wLocal / 2, hLocal],
      [0, hLocal / 2],
    ]
  } else if (shapeType === 'star') {
    local = starLocal(wLocal, hLocal)
  } else if ((o as unknown as { points?: Array<{ x: number; y: number }> }).points) {
    local = (o as unknown as { points: Array<{ x: number; y: number }> }).points.map((p) => [p.x, p.y] as [number, number])
  }
  if (local.length < 3) return
  // 本地点(左上原点) → 世界 mm。先归一化到几何中心(本地 w/2,h/2)，按 scale 缩放（含父链），
  // 再平移到中心，最后按角度旋转 —— 这个「中心 + 自身尺寸」口径与线/矩形/文本一致。
  const box = leafBox(o)
  const centerLocalX = wLocal / 2
  const centerLocalY = hLocal / 2
  const scl = totalScaleOf(o)
  const sx = scl.x
  const sy = scl.y
  const PX2MM = 25.4 / 96
  let world = local.map(([lx, ly]) => {
    const dx = (lx - centerLocalX) * sx
    const dy = (ly - centerLocalY) * sy
    return [box.cx + dx * PX2MM, box.cy + dy * PX2MM] as [number, number]
  })
  world = rotPts(box.cx, box.cy, world, box.angleDeg)
  drawClosedPoly(doc, o, world)
}

function starLocal(w: number, h: number): Array<[number, number]> {
  const cx = w / 2
  const cy = h / 2
  const outerR = Math.min(w, h) / 2
  const innerR = outerR * 0.5
  const pts: Array<[number, number]> = []
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outerR : innerR
    const a = (Math.PI / 5) * i - Math.PI / 2
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)])
  }
  return pts
}

/** 直线 */
function drawLineObject(doc: jsPDF, o: Leaf) {
  const line = o as unknown as fabric.Line
  const stroke = parseColor((line.stroke as string) ?? '#000000')
  if (!stroke) return
  const scl = totalScaleOf(o)
  const swPx = (line.strokeWidth ?? 0) * (line.strokeUniform ? 1 : scl.x)
  const box = leafBox(o)
  // ⭐ 端点重建：fabric 的 Line 在「以对象中心为原点」的本地坐标里，两端永远是
  //    ±(width/2, height/2)（见 `calcLinePoints`），方向只由 x1/x2、y1/y2 的**大小关系**决定；
  //    而 width/height 是**未旋转**时的尺寸，角度只是绕中心转。
  // ⚠️ 旧实现用 `getBoundingRect` 的 left/top + w/h 当线段两端，转 90° 的竖线就成了
  //    「包围盒宽度 ≈ 线宽(1.5px)」的水平小线段 —— 导出后 0.4mm、肉眼等于消失。
  //    （同一份模板里 angle=90.47 的那条竖线就是这种情况：宽 113.39、高 0。）
  const wMm = pxToMm((line.width ?? 0) * scl.x)
  const hMm = pxToMm((line.height ?? 0) * scl.y)
  const xDir = (line.x1 ?? 0) <= (line.x2 ?? 0) ? -1 : 1
  const yDir = (line.y1 ?? 0) <= (line.y2 ?? 0) ? -1 : 1
  const halfW = (wMm / 2) * xDir
  const halfH = (hMm / 2) * yDir
  const p0: [number, number] = [box.cx + halfW, box.cy + halfH]
  const p1: [number, number] = [box.cx - halfW, box.cy - halfH]
  const [a, b] =
    box.angleDeg % 360 !== 0 ? rotPts(box.cx, box.cy, [p0, p1], box.angleDeg) : [p0, p1]
  // 退化（两端重合）时宽度仍要画出一个点，别让 setLineWidth(0) 变成「不可见」
  doc.setDrawColor(stroke[0], stroke[1], stroke[2])
  doc.setLineWidth(pxToMm(Math.max(swPx, 0.01)))
  doc.line(n(a[0]), n(a[1]), n(b[0]), n(b[1]))
}

/**
 * 图片/条码绘制：条码→矢量矩形；普通图片→位图嵌入。
 * ⚠️ 已知局限：这两类仍是**轴对齐**绘制（addImage / 矩形不套旋转变换），
 *    所以「旋转过的图片或条码」在 PDF 里位置按包围盒走、朝向不转。
 *    条码本身旋转后也扫不出来，实际很少用；要做需套 PDF 变换矩阵（见 toPdfMatrix）。
 */
function drawImageLeaf(doc: jsPDF, o: Leaf, ctrl: CanvasController, asBarcode: boolean) {
  const box = leafBox(o)
  if (asBarcode) {
    drawBarcodeVector(doc, o, ctrl, box)
    return
  }
  // 普通图片：直接用对象缓存图源
  const img = o as unknown as fabric.Image & { _element?: { src?: string } }
  if (!img._element?.src) return
  const url = img._element.src
  doc.addImage(url, 'PNG', n(box.left), n(box.top), n(box.w), n(box.h), undefined, 'FAST')
}

/** 把 SVG 字符串解析为可用的 SVG 元素（svg2pdf 只接受元素不接受字符串） */
function parseSvgElement(svg: string): SVGSVGElement | null {
  try {
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    if (doc.getElementsByTagName('parsererror').length) return null
    return doc.documentElement as unknown as SVGSVGElement
  } catch {
    return null
  }
}

/** DOMMatrix → jsPDF Matrix（jsPDF 自有 Matrix 形状与 DOMMatrix 结构不兼容，仅取 a-f） */
function toPdfMatrix(m: DOMMatrix): Parameters<jsPDF['setCurrentTransformationMatrix']>[0] {
  return { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f } as unknown as Parameters<
    jsPDF['setCurrentTransformationMatrix']
  >[0]
}

/**
 * SVG 素材（图标 / 表情）→ 矢量嵌入。
 * 与图片不同：素材在画面上由多个 path 组成，这里按缓存的整段 SVG 交给 svg2pdf 重绘，
 * 得到真正的矢量路径，放大/印刷均不失真，且支持后续改色。
 */
async function drawSvgAssetLeaf(doc: jsPDF, o: Leaf, ctrl: CanvasController) {
  const data = ctrl.svgDataFor(o)
  if (!data) return
  const box = leafBox(o)
  if (box.w <= 0 || box.h <= 0) return
  const el = parseSvgElement(data.svg)
  if (!el) return

  const angle = box.angleDeg
  let rotated = false
  try {
    if (angle) {
      // 绕自身中心旋转：平移到中心 → 旋转 → 平移回去
      const cx = box.left + box.w / 2
      const cy = box.top + box.h / 2
      const m = new DOMMatrix().translateSelf(cx, cy).rotateSelf(angle).translateSelf(-cx, -cy)
      doc.setCurrentTransformationMatrix(toPdfMatrix(m))
      rotated = true
    }
    await doc.svg(el, { x: n(box.left), y: n(box.top), width: n(box.w), height: n(box.h) })
  } catch {
    // 个别素材解析/重绘失败时静默跳过，不影响整页其余内容
  } finally {
    if (rotated) {
      const reset = new DOMMatrix()
      doc.setCurrentTransformationMatrix(toPdfMatrix(reset))
    }
  }
}

/** 条码 → 矢量：提取黑色矩形清单并逐块填充；可选人读文字用矢量字体画 */
function drawBarcodeVector(doc: jsPDF, o: Leaf, ctrl: CanvasController, box: Box) {
  const c = o as unknown as {
    _barcodeType?: BarcodeType
    _barcodeSettings?: Partial<BarcodeRenderSettings>
    _barcodeTextOffsetMm?: number
    _barcodeUnit?: { w: number; barH: number; inkW?: number }
  }
  const type: BarcodeType = c._barcodeType ?? 'code128'
  const rawText = ctrl.contentStringFor(o) || ' '
  let vec: ReturnType<typeof renderBarcodeVectorRects>
  try {
    // ⚠️ 与画布（canvasEngine.buildBarcodeGroup）保持一致：文字带的几何按**基准字号**量取，
    // 不跟随 textSizePt —— 否则 PDF 里「条区/文字带」的高度分配会随字号变，
    // 而画布已固定为基准比例（画布与 PDF 会出现条区高矮不一致的预览偏差）。
    vec = renderBarcodeVectorRects(type, rawText, {
      ...(c._barcodeSettings ?? {}),
      textSizePt: DEFAULT_BARCODE_SETTINGS.textSizePt,
    })
  } catch {
    return // 内容不符合该码制 → 跳过（与位图路径一致）
  }
  if (!vec.rects.length || vec.width <= 0 || vec.height <= 0) return

  const settings = (c._barcodeSettings ?? {}) as { showText?: boolean }
  const showText = vec.showTextHint && settings.showText !== false

  // 一维码含人读文字：盒的高度 = 条区 + 文字条带。以「含文字整体高」为基准划分。
  const fullH = showText && vec.fullHeight ? vec.fullHeight : vec.height

  // ⚠️ 水平与垂直**必须分开换算**。
  //    旧写法把两轴揉成一个比例：kFinal = k × (box.h / (fullH × k)) ≡ box.h / fullH
  //    —— 与盒宽完全无关！于是「横向拉伸条码」（画布上把条码拉满设计框的常规操作）
  //    在 PDF 里被整个丢掉，打印出来仍是原始宽度（用户报「拉伸之后打印还是原来默认的样子」）。
  //
  //    横向：贴合「内容外框」（box 已是画布上的真实外框，与静区/栅格口径无关）。
  //    纵向：有 _barcodeUnit 时用「栅格 px → mm」的真实比例 —— 画布上 1 个栅格 px 被缩放了
  //         |scale| 个画布 px，而画布 px → mm 就是 pxToMm，因此与画布逐像素同源、非等比拉伸
  //         也原样保留；口径明显不符（条区比整盒还高）时退回「整体高贴合」。
  const inkX0 = vec.rects.reduce((m, r) => Math.min(m, r.x), Infinity)
  const inkX1 = vec.rects.reduce((m, r) => Math.max(m, r.x + r.w), -Infinity)
  const inkY0 = vec.rects.reduce((m, r) => Math.min(m, r.y), Infinity)
  const unit = c._barcodeUnit
  const ts = totalScaleOf(o)
  const kx = box.w / Math.max(1e-6, inkX1 - inkX0)
  const kyFit = box.h / (fullH || vec.height)
  let ky = unit && unit.barH > 0 && Math.abs(ts.y) > 1e-6 ? pxToMm(Math.abs(ts.y)) : kyFit
  if (!(vec.height * ky <= box.h + 0.01)) ky = kyFit
  // 栅格原点（世界 mm）：由内容外框反推（box 是轴对齐包围盒，旋转对象按原逻辑不参与）
  const rx = box.left - inkX0 * kx
  const ry = box.top - inkY0 * ky
  const barHmmF = vec.height * ky

  // 黑色矢量块
  doc.setFillColor(0, 0, 0)
  for (const r of vec.rects) {
    doc.rect(n(rx + r.x * kx), n(ry + r.y * ky), n(r.w * kx), n(r.h * ky), 'F')
  }

  // 一维码人读文字：画在条区下方、盒内的文字条带，水平居中
  if (showText) {
    const textPt = ((c._barcodeSettings ?? {}) as { textSizePt?: number }).textSizePt ?? 9
    // 文字条带高度(mm)
    const textBandH = box.h - barHmmF
    if (textBandH > 0.2) {
      // ⚠️ 字号按「可读文字字号」**原样**输出，不再按文字带高度封顶 —— 与画布一致：
      //    画布的人读文字是「绝对字号」（拉伸/缩放不改字号），旧写法
      //    `min(textPt, textBandH*72/25.4*0.72)` 会让 PDF 的字号只由条码高度决定
      //    （实测 9pt/20pt 都被压成 8.36pt），与预览不一致。
      let fontSizePt = Math.max(1, textPt)
      const textOffsetMm = c._barcodeTextOffsetMm ?? 0
      // 人读文字跟随该条码对象的字体（取人读文字 child 的 fontFamily）：纯拉丁内容走内置字体，其余内嵌子集
      const barFont = leafFontFor(o, rawText)
      doc.setFont(barFont)
      doc.setFontSize(fontSizePt)
      // ⚠️ 与画布同口径的**宽度上限**：人读文字宽度不得超过条区宽度（box.w）。
      //    画布侧在 applyBarcodeTextCompensation 里按「实测字宽 / 条区可视宽」压字号，
      //    这里用同一判据（jsPDF 实测文本宽 vs box.w）等比压回去，
      //    否则「内容很长 + 条码很窄」时 PDF 的文字会横向戳出条码（预览/打印不一致）。
      const textWmm = doc.getTextWidth(rawText)
      if (textWmm > 0 && box.w > 0 && textWmm > box.w) {
        fontSizePt = Math.max(1, (fontSizePt * box.w) / textWmm)
        doc.setFontSize(fontSizePt)
      }
      // 文字带中心 + 额外偏移（mm）：>0 把文字往下推拉开与条区距离，<0 拉近
      const cy = box.top + barHmmF + textBandH / 2 + textOffsetMm
      doc.text(rawText, n(box.left + box.w / 2), n(cy + (fontSizePt / 72) * 25.4 * 0.35), { align: 'center' })
    }
  }
}

/**
 * 表格 → 矢量：外框 / 内网格线 / 表头底色 / 单元格文字全部按 `_table` 重建。
 *
 * 为什么不像普通编组那样穿透成子对象：group 内的格线与文字是**局部坐标**，
 * 穿透后每条线都要重新累乘父级变换，且表格的语义（行列/表头/对齐）本来就在
 * `_table` 里 —— 直接用元数据重画，坐标与样式都只有一处真相。
 */
function drawTableVector(doc: jsPDF, o: Leaf) {
  const spec = (o as unknown as { _table?: TableSpec })._table
  if (!spec) return
  const rows = normalizeRows(spec.rows)
  const nR = rows.length
  const nC = rows[0].length
  const box = leafBox(o)
  const angle = box.angleDeg
  // 自身尺寸 + 中心（不含描边、不受旋转影响）；表格锁定旋转，但编组里的表格仍可能被带着转
  const { w, h } = ownSizeMm(o)
  if (w <= 0.01 || h <= 0.01) return

  const x0 = box.cx - w / 2
  const y0 = box.cy - h / 2
  // 线宽：borderWidth 是画布 px，且画布上设了 strokeUniform（不随缩放变粗）→
  // 这里也用「画布 px → mm」的恒等换算，预览与打印才一致。
  const bwMm = Math.max(0.02, pxToMm(Math.max(0.2, spec.borderWidth ?? 1)))
  const border = parseColor(spec.borderColor) ?? [0, 0, 0]
  // 行高/列宽按权重分配 —— 必须与 buildTableGroup 用同一组函数，否则预览与打印会错位
  const colSpans = tableColSpans(spec, w)
  const rowSpans = tableRowSpans(spec, h)
  const colX = spanOffsets(colSpans)
  const rowY = spanOffsets(rowSpans)
  const padMm = Math.max(0, Math.min(10, spec.paddingMm ?? 1.2))
  const headerRow = spec.headerRow !== false
  const headerBg = parseColor(spec.headerBg ?? '#f1f5f9')
  const align = spec.align ?? 'left'

  /** 表格局部坐标(mm) → 世界坐标(mm)（表格锁定旋转，正常 angle=0；这里仍按通用逻辑处理） */
  const at = (lx: number, ly: number): [number, number] =>
    angle ? rot(box.cx, box.cy, x0 + lx, y0 + ly, angle) : [x0 + lx, y0 + ly]

  // ① 表头底色
  if (headerRow && headerBg) {
    doc.setFillColor(headerBg[0], headerBg[1], headerBg[2])
    fillPoly(doc, [at(0, 0), at(w, 0), at(w, rowSpans[0]), at(0, rowSpans[0])])
  }

  // ② 外框 + 内网格线
  doc.setDrawColor(border[0], border[1], border[2])
  doc.setLineWidth(bwMm)
  const line = (ax: number, ay: number, bx: number, by: number) => {
    const [p1x, p1y] = at(ax, ay)
    const [p2x, p2y] = at(bx, by)
    doc.line(n(p1x), n(p1y), n(p2x), n(p2y))
  }
  line(0, 0, w, 0)
  line(0, h, w, h)
  line(0, 0, 0, h)
  line(w, 0, w, h)
  for (let r = 1; r < nR; r++) line(0, rowY[r], w, rowY[r])
  for (let c = 1; c < nC; c++) line(colX[c], 0, colX[c], h)

  // ③ 单元格文字（按列宽折行、垂直居中；与画布 Textbox 的排版规则一致）
  const sample = hrtTextChild(o)
  const fontSizePt = Math.max(1, spec.fontSizePt ?? 9)
  // 单元格多行时同样要按 fabric 的 1.13 行高系数排（table.ts 里单元格 lineHeight 固定 1.15）
  const lineHMm = (fontSizePt / 72) * 25.4 * 1.15 * FABRIC_LINE_MULT
  for (let r = 0; r < nR; r++) {
    for (let c = 0; c < nC; c++) {
      const text = rows[r][c]
      if (!text) continue
      const isBoldCell = !!spec.bold || (headerRow && r === 0)
      const pdfFont = pdfFontFor(sample ?? o, text)
      const useBuiltinBold = pdfFont !== FONT_ALIAS && isBoldCell
      doc.setFont(pdfFont, useBuiltinBold ? 'bold' : 'normal')
      doc.setFontSize(fontSizePt)
      doc.setTextColor(0, 0, 0)
      const cellW = colSpans[c]
      const maxTextW = Math.max(0.5, cellW - padMm * 2)
      const lines = doc.splitTextToSize(text, maxTextW) as string[]
      const cellL = colX[c]
      const cellCenterY = rowY[r] + rowSpans[r] / 2
      const startY = cellCenterY - ((lines.length - 1) * lineHMm) / 2
      const lx =
        align === 'center' ? cellL + cellW / 2 : align === 'right' ? cellL + cellW - padMm : cellL + padMm
      for (let i = 0; i < lines.length; i++) {
        const [px, py] = at(lx, startY + i * lineHMm)
        const opts: Record<string, unknown> = {
          align,
          baseline: 'middle',
          ...(angle ? { angle: -angle } : {}),
        }
        // 粗体：与 drawTextObject 同一套 —— 内置字体用真实 bold 字重，
        // 内嵌黑体没有 bold 版，用 PDF 原生「填充+描边」一次成稿（绝不重复绘制两遍）。
        if (isBoldCell && !useBuiltinBold) {
          doc.setDrawColor(0, 0, 0)
          doc.setLineWidth(fontSizePt * MM_PER_PT * 0.05)
          opts.renderingMode = 'fillThenStroke'
        }
        doc.text(lines[i], n(px), n(py), opts)
      }
    }
  }
}

/* ── 分派：画一个叶子对象 ──────────────────────────── */

async function drawLeaf(doc: jsPDF, o: Leaf, ctrl: CanvasController) {
  const kind = (o as unknown as { kind?: string }).kind
  const type = o.type
  if (kind === 'text') {
    drawTextObject(doc, o, ctrl.contentStringFor(o))
    return
  }
  if (kind === 'svg') {
    await drawSvgAssetLeaf(doc, o, ctrl)
    return
  }
  if (kind === 'barcode') {
    drawImageLeaf(doc, o, ctrl, true)
    return
  }
  if (kind === 'table') {
    drawTableVector(doc, o)
    return
  }
  if (kind === 'rect' || type === 'rect') {
    drawRectObject(doc, o)
    return
  }
  if (type === 'ellipse') {
    drawEllipseObject(doc, o)
    return
  }
  if (kind === 'shape') {
    drawShapeObject(doc, o)
    return
  }
  if (kind === 'line' || type === 'line') {
    drawLineObject(doc, o)
    return
  }
  if (type === 'image') {
    drawImageLeaf(doc, o, ctrl, false)
    return
  }
  // 未知类型（文本类 IText 等）兜底
  if (type === 'text' || type === 'textbox' || type === 'i-text') {
    const t = o as unknown as fabric.IText
    const raw = (t.text ?? '') as string
    if (raw) drawTextObject(doc, o, raw)
  }
}

/* ── 收集一页所有文本字符 ──────────────────────────── */

/**
 * 收集一页中「需要内嵌子集字体」的字符。
 * 只有会用 FONT_ALIAS 渲染的文本才需要内嵌——拉丁字体且内容纯拉丁的对象
 * 走 jsPDF 内置字体（无需内嵌），把它们排除可显著减小 PDF 体积。
 */
function pageChars(ctrl: CanvasController): string {
  const parts: string[] = []
  for (const o of flattenLeaves(ctrl)) {
    const kind = (o as unknown as { kind?: string }).kind
    // 表格的文字在 _table 里（组内子对象不参与导出），必须单独收进来，
    // 否则含中文的表格导出时子集字体里没有这些字 → 打印成空白/方框。
    if (kind === 'table') {
      const spec = (o as unknown as { _table?: TableSpec })._table
      if (!spec) continue
      const sample = hrtTextChild(o) ?? o
      for (const row of normalizeRows(spec.rows)) {
        for (const t of row) {
          if (t && pdfFontFor(sample, t) === FONT_ALIAS) parts.push(t)
        }
      }
      continue
    }
    if (kind !== 'text' && kind !== 'barcode') continue
    const content = ctrl.contentStringFor(o)
    if (!content) continue
    if (leafFontFor(o, content) === FONT_ALIAS) parts.push(content)
  }
  return parts.join('\n')
}

/* ── 主入口 ────────────────────────────────────────── */

/**
 * 构建矢量 PDF（但不保存）：供「导出 PDF」与「矢量打印」共用。
 * 返回已完成所有页绘制、尚未 save/output 的 jsPDF 实例。
 */
export async function buildVectorPdf(
  controller: CanvasController,
  paper: PaperSize,
  options: VectorPdfOptions = {},
): Promise<jsPDF> {
  const { copies = 1, onProgress, rows, order = 'set', onlyActive = false } = options
  const canvas = controller.canvas
  if (canvas.getObjects().length === 0) {
    return new jsPDF({ unit: 'mm', format: [paper.widthMm, paper.heightMm] })
  }

  const all = controller.listPapers()
  // onlyActive：只输出当前活动标签
  const papers = onlyActive && all.length > 1
    ? (() => {
        const a = all.find((p) => p.id === controller.activePaperId())
        return a ? [a] : all
      })()
    : all
  const paperCount = Math.max(1, papers.length)

  const rowMode = !!(rows && rows.length > 0)
  const serialActive = !rowMode && controller.hasActiveSerial()
  const seqCount = Math.max(1, Math.floor(copies))
  const rowCount = Math.max(1, rows?.length ?? 1)
  // 每张纸要出的份数（数据行模式=行数，序列化模式=份数，都没有=1）
  const perPaper = rowMode ? rowCount : serialActive ? seqCount : 1
  const pageCount = perPaper * paperCount
  const prevSeq = controller.seqValue

  /** 第 p 页 → 哪张纸 + 第几个值。set=按套(A1 B1 A2 B2)，paper=按标签(A1 A2 B1 B2) */
  const slotOf = (p: number) =>
    order === 'set'
      ? { paperIdx: p % paperCount, index: Math.floor(p / paperCount) }
      : { paperIdx: Math.floor(p / perPaper), index: p % perPaper }
  const applyState = (index: number) => {
    if (rowMode) controller.setPreviewRow(rows![Math.min(index, rows!.length - 1)] ?? null)
    else if (serialActive) controller.setSeqIndex(index)
  }

  // 收集全部页文本 → 一次性子集字体
  const textPool: string[] = []
  for (let p = 0; p < pageCount; p++) {
    applyState(slotOf(p).index)
    textPool.push(pageChars(controller))
  }
  if (rowMode) controller.setPreviewRow(null)
  else if (serialActive) controller.setSeqValue(prevSeq)

  // 首页尺寸用第一张纸（后续每页按各自纸张尺寸 addPage）
  const firstSize: PaperSize = papers[0]
    ? { widthMm: papers[0].widthMm, heightMm: papers[0].heightMm }
    : paper
  const doc = new jsPDF({
    orientation: firstSize.widthMm >= firstSize.heightMm ? 'landscape' : 'portrait',
    unit: 'mm',
    format: [firstSize.widthMm, firstSize.heightMm],
    compress: true,
  })

  // 内嵌中文字体（失败时降级 Helvetica，不影响图形/条码导出）
  // 仅当确有待用 FONT_ALIAS 渲染的字符时才内嵌子集，纯拉丁文档可跳过（体积更小）
  const allChars = new Set<number>()
  for (const s of textPool) for (const ch of s) allChars.add(ch.codePointAt(0)!)
  const font = allChars.size > 0 ? await subsetFont(allChars) : null
  if (font) font.embed(doc)

  // 去掉选中框（捕获干净画面）
  const prevSel = canvas.getActiveObject()
  const hadSel = !!prevSel
  if (hadSel) canvas.discardActiveObject()
  // 逐页绘制含 await（SVG 素材），期间锁交互，防止用户改动画布导致某一页错位
  controller.setReadOnly(true)
  try {
    for (let p = 0; p < pageCount; p++) {
      const { paperIdx, index } = slotOf(p)
      const pa = papers[Math.min(paperIdx, papers.length - 1)]
      const sizeMm: PaperSize = pa ? { widthMm: pa.widthMm, heightMm: pa.heightMm } : paper
      // 坐标原点平移到「本页这张纸」的左上角（leafBox 用的是工作区坐标）
      const pb = pa ? controller.getPaperBoundsPxFor(pa.id) : controller.getPaperBoundsPx()
      setOrigin(pb.left, pb.top)
      if (p > 0) {
        doc.addPage([sizeMm.widthMm, sizeMm.heightMm], sizeMm.widthMm >= sizeMm.heightMm ? 'landscape' : 'portrait')
      }
      applyState(index)
      // 纸张底色（黑底白字 / 黄底警示等彩底标签）：作为该页最底层铺满整张纸。
      // 白底与透明底直接跳过 —— 不产生多余绘图指令，普通标签的 PDF 保持精简。
      // 注意此刻坐标原点已被 setOrigin 移到本页纸张左上角，所以是 (0,0,W,H)。
      const bgHex = pa?.bgColor
      if (bgHex && bgHex !== '#ffffff' && bgHex !== 'transparent') {
        const rgb = parseColor(bgHex)
        if (rgb) {
          doc.setFillColor(rgb[0], rgb[1], rgb[2])
          doc.rect(0, 0, sizeMm.widthMm, sizeMm.heightMm, 'F')
        }
      }
      for (const o of flattenLeaves(controller)) {
        // 只画落在本页这张纸内的对象，避免把别的标签内容画进来
        if (pa && !controller.isObjectInPaperId(o, pa.id)) continue
        await drawLeaf(doc, o, controller)
      }
      onProgress?.(p + 1, pageCount)
    }
  } finally {
    controller.setReadOnly(false)
    if (rowMode) controller.setPreviewRow(null)
    else if (serialActive) controller.setSeqValue(prevSeq)
    if (hadSel && prevSel) {
      canvas.setActiveObject(prevSel)
      canvas.requestRenderAll()
    }
  }

  return doc
}

/** 导出矢量 PDF（文本可选中/搜索、中文内嵌子集字体；形状/条码/素材均为矢量）。 */
export async function exportVectorPdf(
  controller: CanvasController,
  paper: PaperSize,
  options: VectorPdfOptions = {},
): Promise<void> {
  const doc = await buildVectorPdf(controller, paper, options)
  doc.save(`${options.name ?? '标签'}.pdf`)
}

// 注：原 fallbackIframePrint 已并入 printVectorPdf（统一使用隐藏 iframe + autoPrint），此处删除。


/**
 * 矢量打印：复用同一套矢量 PDF 构建，在屏外隐藏 iframe 内加载 PDF（自带 autoPrint 动作）。
 * 浏览器在隐藏 iframe 内渲染完 PDF 后自动弹出打印对话框 —— 内容已就绪（不会先弹空白页），
 * 且用户不会看到任何独立的 PDF 标签页（只有打印对话框本身，其左侧即为 PDF 预览）。
 * 与「先渲染 PNG 位图再 window.print()」有本质区别（位图会被拉伸糊化）。
 */
export async function printVectorPdf(
  controller: CanvasController,
  paper: PaperSize,
  options: VectorPdfOptions = {},
): Promise<void> {
  const doc = await buildVectorPdf(controller, paper, options)
  doc.autoPrint()
  const blobUrl = doc.output('bloburl')
  const url = blobUrl.toString()
  await new Promise<void>((resolve) => {
    const iframe = document.createElement('iframe')
    // 移出视口但仍保持渲染：display:none 会导致部分浏览器的 PDF 查看器不渲染 / 不触发 autoPrint
    iframe.style.cssText =
      'position:fixed;left:-10000px;top:0;width:800px;height:1000px;border:0;background:#fff;'
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    let settled = false
    const cleanup = () => {
      if (settled) return
      settled = true
      if (idleTimer) {
        clearTimeout(idleTimer)
        idleTimer = null
      }
      setTimeout(() => {
        URL.revokeObjectURL(url)
        iframe.remove()
      }, 1500)
      resolve()
    }
    iframe.onload = () => {
      const w = iframe.contentWindow
      if (!w) return cleanup()
      // autoPrint 已在 PDF 渲染完后自动触发 print()；此处仅负责对话框关闭后清理
      const done = () => {
        w.removeEventListener('afterprint', done)
        cleanup()
      }
      w.addEventListener('afterprint', done)
      // 兜底：用户始终未关闭对话框也最终回收（cleanup 会清掉本定时器，不残留）
      idleTimer = setTimeout(() => {
        w.removeEventListener('afterprint', done)
        cleanup()
      }, 60000)
    }
    iframe.onerror = cleanup
    document.body.appendChild(iframe)
    iframe.src = url
  })
}
