// 表格对象：数据模型 + fabric 组构建
//
// 为什么做成「原子 fabric.Group」而不是一堆散对象：
//   · 表格必须整体拖动/整体缩放，散对象无法保证；
//   · 与条码组、SVG 素材组同一套模式（isAtomicGroupKind），双击不会被解组误拆；
//   · 序列化只存 `_table` 元数据、不存格线与单元格文字，载入时按元数据重建
//     （与条码组同理：几何全由数据决定，存档小且不会因为拆组而语义丢失）。
//
// 尺寸口径：group 的 width/height = 表格的「基几何」(px)；缩放走 scaleX/scaleY。
// 拖拽缩放结束后由 canvasEngine 把 scale 折算回基几何并重建 —— 字号恒定、单元格重排，
// 这是 Word 里拉表格边框的行为（而不是把字一起拉变形）。
import { fabric } from 'fabric'
import { mmToPx } from '@/lib/mm'
import { ptToPx, canUseBuiltinFont, DEFAULT_FONT, CJK_FONT, normalizeFontFamily } from '@/lib/textStyles'

/** 表格内容与样式。行列数据是唯一事实来源，格线/文字都由它生成 */
export interface TableSpec {
  /** 单元格文本，rows[r][c]；行数=rows.length，列数=各行最大长度 */
  rows: string[][]
  /** 边框粗细（canvas px，strokeUniform 恒定，不随缩放变粗） */
  borderWidth?: number
  borderColor?: string
  /** 字号（pt） */
  fontSizePt?: number
  /** 字体；不填则按内容自动选（含中文→黑体，纯拉丁→Arial） */
  fontFamily?: string
  bold?: boolean
  align?: 'left' | 'center' | 'right'
  /** 首行作为表头：加粗 + 浅底色 */
  headerRow?: boolean
  headerBg?: string
  /** 单元格内边距（mm） */
  paddingMm?: number
}

export const TABLE_DEFAULTS = {
  borderWidth: 1,
  borderColor: '#000000',
  fontSizePt: 9,
  align: 'left' as const,
  headerRow: true,
  headerBg: '#f1f5f9',
  paddingMm: 1.2,
}

/** 新建表格时的初始内容：首行给出「列 1/列 2…」占位，让人一眼看出这是可编辑的表格 */
export function defaultTableSpec(rows = 3, cols = 3): TableSpec {
  const r = Math.max(1, Math.min(30, rows))
  const c = Math.max(1, Math.min(20, cols))
  return {
    rows: Array.from({ length: r }, (_, ri) =>
      Array.from({ length: c }, (_, ci) => (ri === 0 ? `列 ${ci + 1}` : '')),
    ),
    borderWidth: TABLE_DEFAULTS.borderWidth,
    borderColor: TABLE_DEFAULTS.borderColor,
    fontSizePt: TABLE_DEFAULTS.fontSizePt,
    align: TABLE_DEFAULTS.align,
    headerRow: TABLE_DEFAULTS.headerRow,
    headerBg: TABLE_DEFAULTS.headerBg,
    paddingMm: TABLE_DEFAULTS.paddingMm,
  }
}

/** 规整矩阵：行数取实际行数、列数取各行最大宽度，缺失补空串（脏数据兜底） */
export function normalizeRows(rows: string[][]): string[][] {
  const safe = Array.isArray(rows) && rows.length > 0 ? rows : [['']]
  const cols = Math.max(1, ...safe.map((r) => (Array.isArray(r) ? r.length : 1)))
  return safe.map((r) => {
    const line = Array.isArray(r) ? r.slice(0, cols) : []
    while (line.length < cols) line.push('')
    return line
  })
}

export function tableRowsOf(spec: TableSpec): number {
  return normalizeRows(spec.rows).length
}

export function tableColsOf(spec: TableSpec): number {
  return normalizeRows(spec.rows)[0].length
}

/** 增/减行（末尾操作；n 下限 1） */
export function resizeTableRows(spec: TableSpec, nextRows: number): TableSpec {
  const rows = normalizeRows(spec.rows)
  const cols = rows[0].length
  const target = Math.max(1, Math.min(60, Math.round(nextRows)))
  if (target === rows.length) return { ...spec, rows }
  if (target > rows.length) {
    const added = Array.from({ length: target - rows.length }, () => Array.from({ length: cols }, () => ''))
    return { ...spec, rows: [...rows, ...added] }
  }
  return { ...spec, rows: rows.slice(0, target) }
}

/** 增/减列（末尾操作；n 下限 1） */
export function resizeTableCols(spec: TableSpec, nextCols: number): TableSpec {
  const rows = normalizeRows(spec.rows)
  const target = Math.max(1, Math.min(20, Math.round(nextCols)))
  const cur = rows[0].length
  if (target === cur) return { ...spec, rows }
  return {
    ...spec,
    rows: rows.map((r) =>
      target > cur ? [...r, ...Array.from({ length: target - cur }, () => '')] : r.slice(0, target),
    ),
  }
}

/** 在指定行之后插入一行（index = -1 表示插入到最前） */
export function insertTableRow(spec: TableSpec, index: number): TableSpec {
  const rows = normalizeRows(spec.rows)
  const cols = rows[0].length
  const at = Math.max(0, Math.min(rows.length, index + 1))
  const next = rows.slice()
  next.splice(at, 0, Array.from({ length: cols }, () => ''))
  return { ...spec, rows: next }
}

/** 删除指定行（至少保留 1 行） */
export function removeTableRow(spec: TableSpec, index: number): TableSpec {
  const rows = normalizeRows(spec.rows)
  if (rows.length <= 1) return { ...spec, rows }
  const next = rows.slice()
  next.splice(Math.max(0, Math.min(rows.length - 1, index)), 1)
  return { ...spec, rows: next }
}

/** 在指定列之后插入一列（index = -1 表示插入到最前） */
export function insertTableCol(spec: TableSpec, index: number): TableSpec {
  const rows = normalizeRows(spec.rows)
  const at = Math.max(0, Math.min(rows[0].length, index + 1))
  return {
    ...spec,
    rows: rows.map((r) => {
      const next = r.slice()
      next.splice(at, 0, '')
      return next
    }),
  }
}

/** 删除指定列（至少保留 1 列） */
export function removeTableCol(spec: TableSpec, index: number): TableSpec {
  const rows = normalizeRows(spec.rows)
  if (rows[0].length <= 1) return { ...spec, rows }
  const at = Math.max(0, Math.min(rows[0].length - 1, index))
  return { ...spec, rows: rows.map((r) => r.filter((_, i) => i !== at)) }
}

/** 单元格里是否含非拉丁字符（决定默认字体：中文必须走黑体，否则画布与 PDF 不一致） */
function needsCjkFont(rows: string[][]): boolean {
  return rows.some((r) => r.some((t) => t && !canUseBuiltinFont(t)))
}

/**
 * 构建表格 fabric 组。
 * @param wPx 表格基几何宽（px），hPx 高（px）
 */
export function buildTableGroup(spec: TableSpec, wPx: number, hPx: number): fabric.Group {
  const rows = normalizeRows(spec.rows)
  const nR = rows.length
  const nC = rows[0].length
  const w = Math.max(2, wPx)
  const h = Math.max(2, hPx)

  const bw = Math.max(0.2, Math.min(12, spec.borderWidth ?? TABLE_DEFAULTS.borderWidth))
  const borderColor = spec.borderColor ?? TABLE_DEFAULTS.borderColor
  const fontSizePt = spec.fontSizePt ?? TABLE_DEFAULTS.fontSizePt
  const padding = Math.max(0, mmToPx(spec.paddingMm ?? TABLE_DEFAULTS.paddingMm))
  const align = spec.align ?? TABLE_DEFAULTS.align
  const headerRow = spec.headerRow !== false
  const headerBg = spec.headerBg ?? TABLE_DEFAULTS.headerBg
  const fontFamily = spec.fontFamily
    ? normalizeFontFamily(spec.fontFamily)
    : needsCjkFont(rows)
      ? CJK_FONT
      : DEFAULT_FONT

  const colW = w / nC
  const rowH = h / nR
  const half = bw / 2
  const objs: fabric.Object[] = []

  // ① 表头底色（放在最下）
  if (headerRow && headerBg && headerBg !== 'transparent') {
    objs.push(
      new fabric.Rect({
        left: half,
        top: half,
        width: Math.max(0, w - bw),
        height: Math.max(0, rowH - bw),
        fill: headerBg,
        strokeWidth: 0,
        originX: 'left',
        originY: 'top',
        selectable: false,
        evented: false,
      }),
    )
  }

  // ② 网格线：外框 4 条 + 内线。用 Line + strokeUniform，缩放时线宽恒定（同 Word）
  const addLine = (x1: number, y1: number, x2: number, y2: number) => {
    objs.push(
      new fabric.Line([x1, y1, x2, y2], {
        stroke: borderColor,
        strokeWidth: bw,
        strokeUniform: true,
        selectable: false,
        evented: false,
      }),
    )
  }
  // 线向内缩半线宽 → 组包围盒精确等于 w×h（否则会多出 bw/2）
  addLine(half, half, w - half, half)
  addLine(half, h - half, w - half, h - half)
  addLine(half, half, half, h - half)
  addLine(w - half, half, w - half, h - half)
  for (let r = 1; r < nR; r++) addLine(half, r * rowH, w - half, r * rowH)
  for (let c = 1; c < nC; c++) addLine(c * colW, half, c * colW, h - half)

  // ③ 单元格文字（放最上，避免被网格线压住）
  for (let r = 0; r < nR; r++) {
    for (let c = 0; c < nC; c++) {
      const text = rows[r][c]
      if (!text) continue
      const isHeader = headerRow && r === 0
      objs.push(
        new fabric.Textbox(text, {
          left: c * colW + padding,
          top: r * rowH + rowH / 2,
          width: Math.max(1, colW - padding * 2),
          fontSize: ptToPx(fontSizePt),
          fontFamily,
          fontWeight: spec.bold || isHeader ? 'bold' : 'normal',
          fill: '#000000',
          textAlign: align,
          originX: 'left',
          originY: 'center',
          splitByGrapheme: true,
          lineHeight: 1.15,
          selectable: false,
          evented: false,
        }),
      )
    }
  }

  const group = new fabric.Group(objs, {
    left: 0,
    top: 0,
    originX: 'left',
    originY: 'top',
    // 单元格不是可交互子对象：整表作为一个对象选中/拖动
    subTargetCheck: false,
  })
  // 表格在标签里几乎不需要旋转；锁定后 PDF 矢量绘制也只走「无旋转」这一条确定路径
  group.set({ lockRotation: true })
  return group
}
