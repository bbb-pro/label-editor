// 矢量 PDF 导出
// 把画布对象用 jsPDF 的矢量 API 重建，文字(含中文)通过“内嵌中文字体子集”输出为
// 真正可选中/可搜索的矢量文本，而非位图快照。
// - 中文字体：运行时 fetch public/fonts/simhei.ttf，用 fonteditor-core 按当前页用到
//   的字符子集化后 addFileToVFS + addFont 内嵌（子集通常只有几 KB ~ 几十 KB）。
// - 文本：逐行重建（拆 \n 与按盒宽折行），支持对齐/行高/字距/粗体(近似加粗)。
// - 形状：矩形(含圆角)/椭圆/三角形/菱形/五角星/直线全部走矢量；闭合多边形用 doc.lines。
// - 条码/图片：以位图嵌入（条码为高对比模块，位图在印刷/放大时足够清晰）。
// - 旋转：文本用 jsPDF text({angle})，图形绕中心旋转后描点。
import jsPDF from 'jspdf'
import { Font } from 'fonteditor-core'
import type { PaperSize } from '@/types/template'
import type { CanvasController } from '@/lib/canvasEngine'
import { pxToMm } from '@/lib/mm'
import { pxToPt } from '@/lib/textStyles'
import { type BarcodeType, type BarcodeRenderSettings } from '@/lib/barcode'
import { renderBarcodeVectorRects } from '@/lib/barcodeVector'
import type { fabric } from 'fabric'

const FONT_ALIAS = 'SimHeiPDF'
const FONT_URL = () => `${import.meta.env.BASE_URL}fonts/simhei.ttf`

export interface VectorPdfOptions {
  copies?: number
  name?: string
  onProgress?: (done: number, total: number) => void
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
  const walk = (list: fabric.Object[]) => {
    for (const o of list) {
      // 纸卡背景矩形(excludeFromExport)和标签外的暂存对象都跳过
      if ((o as { excludeFromExport?: boolean }).excludeFromExport) continue
      if (!ctrl.isObjectInPaper(o)) continue
      const children = (o as unknown as { _objects?: fabric.Object[] })._objects
      if (o.type === 'group' && Array.isArray(children)) walk(children)
      else out.push(o)
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

/** 传入需要包含的字符数组，生成可嵌入 jsPDF 的子集字体 */
async function subsetFont(chars: Iterable<number>): Promise<{ embed: (doc: jsPDF) => void }> {
  const cps = new Set<number>(chars)
  // 始终补全 ASCII 与常见标点，避免某些运行依赖
  for (let c = 0x20; c <= 0x7e; c++) cps.add(c)
  for (const ch of '，。、；：？！（）【】“”‘’·—…％‰＋－＝≤≥×÷㎡℃~№') cps.add(ch.codePointAt(0)!)
  const resp = await fetch(FONT_URL())
  const buf = await resp.arrayBuffer()
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

function leafBox(o: Leaf): Box {
  const rect = o.getBoundingRect(true)
  const angleDeg = ((o.angle ?? 0) % 360 + 360) % 360
  return {
    left: pxToMm(rect.left),
    top: pxToMm(rect.top),
    w: pxToMm(rect.width),
    h: pxToMm(rect.height),
    cx: pxToMm(rect.left + rect.width / 2),
    cy: pxToMm(rect.top + rect.height / 2),
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

  doc.setFont(FONT_ALIAS)
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
    // 粗体近似：以极小的右偏重描一次，得到视觉加粗（中文无字重子集时的通用做法）
    if (isBold) {
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

/** 条码 → 矢量：提取黑色矩形清单并逐块填充；可选人读文字用矢量字体画 */
function drawBarcodeVector(doc: jsPDF, o: Leaf, ctrl: CanvasController, box: Box) {
  const c = o as unknown as {
    _barcodeType?: BarcodeType
    _barcodeSettings?: Partial<BarcodeRenderSettings>
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
      const cy = box.top + barHmmF + textBandH / 2
      doc.setFont(FONT_ALIAS)
      doc.setFontSize(fontSizePt)
      doc.text(rawText, n(box.left + box.w / 2), n(cy + (fontSizePt / 72) * 25.4 * 0.35), { align: 'center' })
    }
  }
}

/* ── 分派：画一个叶子对象 ──────────────────────────── */

function drawLeaf(doc: jsPDF, o: Leaf, ctrl: CanvasController) {
  const kind = (o as unknown as { kind?: string }).kind
  const type = o.type
  if (kind === 'text') {
    drawTextObject(doc, o, ctrl.contentStringFor(o))
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

function pageChars(ctrl: CanvasController): string {
  const parts: string[] = []
  for (const o of flattenLeaves(ctrl)) {
    const kind = (o as unknown as { kind?: string }).kind
    if (kind === 'text' || kind === 'barcode') parts.push(ctrl.contentStringFor(o))
  }
  return parts.join('\n')
}

/* ── 主入口 ────────────────────────────────────────── */

export async function exportVectorPdf(
  controller: CanvasController,
  paper: PaperSize,
  options: VectorPdfOptions = {},
): Promise<void> {
  const { copies = 1, name = '标签', onProgress } = options
  const canvas = controller.canvas
  if (canvas.getObjects().length === 0) return

  const serialActive = controller.hasActiveSerial()
  const pageCount = serialActive ? Math.max(1, Math.floor(copies)) : 1
  const prevSeq = controller.seqValue

  // 收集全部页文本 → 一次性子集字体
  const textPool: string[] = []
  for (let p = 0; p < pageCount; p++) {
    if (serialActive) controller.setSeqValue(controller.seqLabelFor(p))
    textPool.push(pageChars(controller))
  }
  if (serialActive) controller.setSeqValue(prevSeq)

  const doc = new jsPDF({
    orientation: paper.widthMm >= paper.heightMm ? 'landscape' : 'portrait',
    unit: 'mm',
    format: [paper.widthMm, paper.heightMm],
    compress: true,
  })

  // 内嵌中文字体
  const allChars = new Set<number>()
  for (const s of textPool) for (const ch of s) allChars.add(ch.codePointAt(0)!)
  const font = await subsetFont(allChars)
  font.embed(doc)

  // 去掉选中框（捕获干净画面）
  const prevSel = canvas.getActiveObject()
  const hadSel = !!prevSel
  if (hadSel) canvas.discardActiveObject()
  try {
    for (let p = 0; p < pageCount; p++) {
      if (p > 0) {
        doc.addPage([paper.widthMm, paper.heightMm], paper.widthMm >= paper.heightMm ? 'landscape' : 'portrait')
      }
      if (serialActive) controller.setSeqValue(controller.seqLabelFor(p))
      flattenLeaves(controller).forEach((o) => drawLeaf(doc, o, controller))
      onProgress?.(p + 1, pageCount)
    }
  } finally {
    if (serialActive) controller.setSeqValue(prevSeq)
    if (hadSel && prevSel) {
      canvas.setActiveObject(prevSel)
      canvas.requestRenderAll()
    }
  }

  doc.save(`${name}.pdf`)
}
