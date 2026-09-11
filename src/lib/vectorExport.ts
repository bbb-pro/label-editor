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
import { pxToPt } from '@/lib/textStyles'
import { type BarcodeType, type BarcodeRenderSettings } from '@/lib/barcode'
import { renderBarcodeVectorRects } from '@/lib/barcodeVector'
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
 * 2) 中文字体 / 未知字体 → 内嵌 simhei 子集（唯一可用的中文字体资源）。
 *    纯中文内容用哪种中文字体差异有限，整段走子集可保证不出方框。
 */
const PDF_FONT_LATIN = {
  helvetica: 'helvetica',
  times: 'times',
  courier: 'courier',
} as const

/** 画布字体名（小写匹配）→ jsPDF 内置字体名；不在表内的走内嵌子集 */
const CANVAS_TO_PDF_FONT: Record<string, string> = {
  arial: PDF_FONT_LATIN.helvetica,
  helvetica: PDF_FONT_LATIN.helvetica,
  verdana: PDF_FONT_LATIN.helvetica,
  tahoma: PDF_FONT_LATIN.helvetica,
  'trebuchet ms': PDF_FONT_LATIN.helvetica,
  'ms sans serif': PDF_FONT_LATIN.helvetica,
  'microsoft sans serif': PDF_FONT_LATIN.helvetica,
  georgia: PDF_FONT_LATIN.times,
  'times new roman': PDF_FONT_LATIN.times,
  times: PDF_FONT_LATIN.times,
  'courier new': PDF_FONT_LATIN.courier,
  courier: PDF_FONT_LATIN.courier,
  impact: PDF_FONT_LATIN.helvetica,
}

/** 判断某段文本是否只需拉丁字形（决定能否用内置字体，避免中文变方框） */
function isLatinOnly(text: string): boolean {
  // 含中文（CJK 统一表意文字、扩展 A、兼容表意、全角标点等）则不能用内置字体
  return !/[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F]/.test(text)
}

/** 取某对象应使用的 PDF 字体名：拉丁字体且内容纯拉丁 → 内置字体，否则 → 内嵌子集 */
function pdfFontFor(obj: fabric.Object, content: string): string {
  const fam = String((obj as { fontFamily?: string }).fontFamily ?? '').toLowerCase().trim()
  const builtin = CANVAS_TO_PDF_FONT[fam]
  if (builtin && isLatinOnly(content)) return builtin
  return FONT_ALIAS
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
      const isAtomic = isBarcode || kind === 'svg'
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
  const angleDeg = ((o.angle ?? 0) % 360 + 360) % 360
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

function rot(cx: number, cy: number, x: number, y: number, deg: number): [number, number] {
  if (deg % 360 === 0) return [x, y]
  const r = (deg * Math.PI) / 180
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  const dx = x - cx
  const dy = y - cy
  return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos]
}

function rotPts(cx: number, cy: number, pts: Array<[number, number]>, deg: number): Array<[number, number]> {
  return pts.map(([x, y]) => rot(cx, cy, x, y, deg))
}

/* ── 各类对象绘制 ─────────────────────────────────── */

/** 文本对象 → 矢量逐行重建 */
function drawTextObject(doc: jsPDF, o: Leaf, content: string) {
  if (!content) return
  const it = o as unknown as fabric.Textbox
  const box = leafBox(o)

  const fontSizePx = (it.fontSize ?? 12) * (it.scaleY ?? 1)
  const fontSizePt = pxToPt(fontSizePx)
  const wrapWmm = pxToMm((it.width ?? 1) * (it.scaleX ?? 1))

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

  const rgb = parseColor((it.fill as string) ?? '#000000') ?? [0, 0, 0]
  doc.setTextColor(rgb[0], rgb[1], rgb[2])

  // 文本区域若有背景/描边盒，先画（若用户设置了 textBackgroundColor 由 fabric 用 styles 渲染，此简版忽略，
  // 仅处理全局 stroke 边框——多数文本无框）
  const lineH = fontSizePt / 72 * 25.4 // 单行 em 高度(mm)
  const lineLead = lineH * lineHeightF
  const ascent = lineH * 0.86

  const lines: string[] = []
  for (const para of content.split('\n')) {
    if (!para) {
      lines.push('')
      continue
    }
    const wrapped = doc.splitTextToSize(para, Math.max(wrapWmm, 0.5)) as string[]
    for (const l of wrapped) lines.push(l)
  }
  if (lines.length === 0) lines.push('')

  // 垂直锚点：fabric 文本以对象高为盒，一般顶部对齐。这里以盒顶为首行“字身顶”
  //（Textbox 无垂直对齐，文字贴顶渲染）
  const topY = box.top
  const rotDeg = box.angleDeg

  for (let li = 0; li < lines.length; li++) {
    const str = lines[li]
    if (!str) continue
    // baseline 第 li 行
    const baseY = topY + ascent + li * lineLead
    // x 依对齐：以盒左/中/右
    let x = box.left
    const aOpt = align === 'center' ? 1 : align === 'right' ? 2 : 0
    if (align === 'center') x = box.left + wrapWmm / 2
    else if (align === 'right') x = box.left + wrapWmm

    const textOpts: Record<string, unknown> = { align: aOpt as 0 | 1 | 2 }
    if (rotDeg % 360 !== 0) textOpts.angle = rotDeg
    // jsPDF 画字一次
    doc.text(str, n(x), n(baseY), textOpts)
    // 子集字体（中文）无真实字重，用极小的右偏重描一次近似加粗；
    // 内置拉丁字体已在 setFont 时选 bold，无需再描（否则会糊边）。
    if (isBold && !useBuiltinBold) {
      const off = MM_PER_PT * fontSizePt * 0.045
      doc.text(str, n(x + off), n(baseY), textOpts)
    }
  }
}

/** 矩形（含圆角，支持旋转：旋转时用闭合多边形近似圆角边） */
function drawRectObject(doc: jsPDF, o: Leaf) {
  const rect = o as unknown as fabric.Rect
  const box = leafBox(o)
  const fill = parseColor((rect.fill as string) ?? 'transparent')
  const stroke = parseColor((rect.stroke as string) ?? 'transparent')
  const swPx = (rect.strokeWidth ?? 0) * (rect.strokeUniform ? 1 : (rect.scaleX ?? 1))
  const hasFill = fill != null
  const hasStroke = stroke != null && swPx > 0
  if (!hasFill && !hasStroke) return
  const rxPx = (rect.rx ?? 0) * (rect.scaleX ?? 1)
  const swMm = pxToMm(swPx)

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
    doc.roundedRect(n(box.left), n(box.top), n(box.w), n(box.h), n(rxMm), n(rxMm), style)
    return
  }
  // 否则多边形路径（旋转 / 直角共用）
  const corners: Array<[number, number]> = [
    [box.left, box.top],
    [box.left + box.w, box.top],
    [box.left + box.w, box.top + box.h],
    [box.left, box.top + box.h],
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
  const fill = parseColor((obj.fill as string) ?? 'transparent')
  const stroke = parseColor((obj.stroke as string) ?? 'transparent')
  const swPx = (obj.strokeWidth ?? 0) * (obj.strokeUniform ? 1 : (obj.scaleX ?? 1))
  const hasFill = fill != null
  const hasStroke = stroke != null && swPx > 0
  if (!hasFill && !hasStroke) return
  const style: 'F' | 'S' | 'FD' = hasFill && hasStroke ? 'FD' : hasFill ? 'F' : 'S'
  if (hasFill) doc.setFillColor(fill![0], fill![1], fill![2])
  if (hasStroke) {
    doc.setDrawColor(stroke![0], stroke![1], stroke![2])
    doc.setLineWidth(pxToMm(swPx))
  }
  const rx = box.w / 2
  const ry = box.h / 2
  // 椭圆不支持旋转参数 → 若旋转则退化为在局部旋转后仍按轴对齐（fabric 里椭圆旋转较少，先按不旋转画）
  doc.ellipse(n(box.cx), n(box.cy), n(rx), n(ry), style)
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
  // 本地点(左上原点) → 世界 mm。先归一化到几何中心(本地 w/2,h/2)，按 scaleX/Y 缩放，
  // 再平移到盒中心，最后按角度旋转。
  const box = leafBox(o)
  const centerLocalX = wLocal / 2
  const centerLocalY = hLocal / 2
  const sx = o.scaleX ?? 1
  const sy = o.scaleY ?? 1
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
  const swPx = (line.strokeWidth ?? 0) * (line.strokeUniform ? 1 : (line.scaleX ?? 1))
  const box = leafBox(o)
  // fabric Line 对象坐标实际是 (x1,y1)=(0,0) 起点，(x2,y2) 在本地为相对或绝对——直接按其缓存角点不可靠。
  // 用“两角点连线”的约定：fabric 会把线对象角点定为线的两端(水平线默认)。这里用 x1/x2,y1/y2 相对差判断斜率，
  // 再放到盒内比例位置。
  const x1 = line.x1 ?? 0
  const x2 = line.x2 ?? (o.width ?? 0)
  const y1 = line.y1 ?? 0
  const y2 = line.y2 ?? 0
  let p0: [number, number]
  let p1: [number, number]
  if (Math.abs(x2 - x1) < 1e-6) {
    // 竖直：从盒顶中到盒底中
    p0 = [box.cx, box.top]
    p1 = [box.cx, box.top + box.h]
  } else if (Math.abs(y2 - y1) < 1e-6) {
    p0 = [box.left, box.cy]
    p1 = [box.left + box.w, box.cy]
  } else {
    // 斜线：两点落到盒对角
    p0 = [box.left, box.top]
    p1 = [box.left + box.w, box.top + box.h]
  }
  const [a, b] = rotPts(box.cx, box.cy, [p0, p1], box.angleDeg)
  doc.setDrawColor(stroke[0], stroke[1], stroke[2])
  doc.setLineWidth(pxToMm(Math.max(swPx, 0.01)))
  doc.line(n(a[0]), n(a[1]), n(b[0]), n(b[1]))
}

/** 图片/条码绘制：条码→矢量矩形；普通图片→位图嵌入 */
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
  }
  const type: BarcodeType = c._barcodeType ?? 'code128'
  const rawText = ctrl.contentStringFor(o) || ' '
  let vec: ReturnType<typeof renderBarcodeVectorRects>
  try {
    vec = renderBarcodeVectorRects(type, rawText, c._barcodeSettings ?? {})
  } catch {
    return // 内容不符合该码制 → 跳过（与位图路径一致）
  }
  if (!vec.rects.length || vec.width <= 0 || vec.height <= 0) return

  const settings = (c._barcodeSettings ?? {}) as { showText?: boolean }
  const showText = vec.showTextHint && settings.showText !== false

  // 一维码含人读文字：盒的高度 = 条区 + 文字条带。以「含文字整体高」为基准划分。
  const fullH = showText && vec.fullHeight ? vec.fullHeight : vec.height
  // 统一按“宽”定 px→mm 比例（条/字区宽度一致；盒宽本就对应 raster 宽，保留静区不变形）
  const k = box.w / vec.width
  // 条区高度(mm) → 条区占上、文字占下，用盒高均摊保证填满且不越界
  const scaleToBox = box.h / (fullH * k) // 若 on-canvas 高度与 width 比例非精确 1:1 时的补偿
  const kFinal = k * scaleToBox
  const barHmmF = vec.height * kFinal
  const ox = box.left + (box.w - vec.width * kFinal) / 2
  const oy = box.top // 条区从盒顶开始（raster 顶部含上静区）

  // 黑色矢量块
  doc.setFillColor(0, 0, 0)
  for (const r of vec.rects) {
    doc.rect(n(ox + r.x * kFinal), n(oy + r.y * kFinal), n(r.w * kFinal), n(r.h * kFinal), 'F')
  }

  // 一维码人读文字：画在条区下方、盒内的文字条带，水平居中
  if (showText) {
    const textPt = ((c._barcodeSettings ?? {}) as { textSizePt?: number }).textSizePt ?? 9
    // 文字条带高度(mm)
    const textBandH = box.h - barHmmF
    if (textBandH > 0.5) {
      const fontSizePt = Math.min(textPt, textBandH * 72 / 25.4 * 0.72)
      const textOffsetMm = c._barcodeTextOffsetMm ?? 0
      // 文字带中心 + 额外偏移（mm）：>0 把文字往下推拉开与条区距离，<0 拉近
      const cy = box.top + barHmmF + textBandH / 2 + textOffsetMm
      // 人读文字跟随该条码对象的字体：纯拉丁内容走内置字体，其余内嵌子集
      const barFont = pdfFontFor(o as unknown as fabric.Object, rawText)
      doc.setFont(barFont)
      doc.setFontSize(fontSizePt)
      doc.text(rawText, n(box.left + box.w / 2), n(cy + (fontSizePt / 72) * 25.4 * 0.35), { align: 'center' })
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
    if (kind !== 'text' && kind !== 'barcode') continue
    const content = ctrl.contentStringFor(o)
    if (!content) continue
    if (pdfFontFor(o, content) === FONT_ALIAS) parts.push(content)
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
