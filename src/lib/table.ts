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
  /**
   * 每列相对宽度权重（默认全 1 = 等宽）。
   * 实际列宽 = 表格总宽 × w[i] / Σw —— 存权重而不是存 mm，是为了「表格整体缩放/改尺寸」时
   * 各列按比例跟着变（存绝对 mm 的话一改尺寸就会溢出或留白）。
   */
  colWeights?: number[]
  /** 每行相对高度权重（默认全 1 = 等高），口径同 colWeights */
  rowWeights?: number[]
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

/* ── 行高 / 列宽 ─────────────────────────────────────
 * 存储用「相对权重」：表格总宽变了，各列按比例跟着变，不会溢出/留白。
 * 对外（面板/对话框）统一按 mm 显示与输入，换算只发生在下面这几个函数里。
 */

/** 每个格子的最小边长（mm）：再小就放不下字，拖动/输入都会被夹住 */
const MIN_CELL_MM = 2

/** 权重数组规整到长度 n：缺的补 1、非正数按 1 处理、多余的截断 */
export function normalizeWeights(w: number[] | undefined, n: number): number[] {
  const src = Array.isArray(w) ? w : []
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const v = Number(src[i])
    out.push(Number.isFinite(v) && v > 0 ? v : 1)
  }
  return out
}

/** 把总长按权重分配（单位随意：传 px 得 px、传 mm 得 mm） */
function distribute(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0)
  if (!(sum > 0)) return weights.map(() => total / Math.max(1, weights.length))
  return weights.map((v) => (total * v) / sum)
}

/** 各列实际宽度（与 total 同单位） */
export function tableColSpans(spec: TableSpec, total: number): number[] {
  return distribute(total, normalizeWeights(spec.colWeights, tableColsOf(spec)))
}

/** 各行实际高度（与 total 同单位） */
export function tableRowSpans(spec: TableSpec, total: number): number[] {
  return distribute(total, normalizeWeights(spec.rowWeights, tableRowsOf(spec)))
}

/** [0, s0, s0+s1, …] 每条分隔线的位置（长度 = spans.length + 1） */
export function spanOffsets(spans: number[]): number[] {
  const out = [0]
  for (const s of spans) out.push(out[out.length - 1] + s)
  return out
}

/**
 * 把第 i 条改成 target（与 total 同单位），**总长不变**。
 *
 * 让位规则 = 「瀑布式借还」：
 *   · 要变宽 → 先向**右边**的列依次借（借到最小格宽为止，不够再向更右的借，最后才向左边借）；
 *   · 要变窄 → 腾出来的空间先给右邻，再给左邻。
 * 好处：目标值**总能实现**，且只动「必须动」的那几条 —— 与 Word 里连续拖分隔线的结果一致
 * （例如 52mm/4 列，依次把第 1 列设 25、第 2 列设 9、第 3 列设 9，会自然收敛到 [25,9,9,9]）。
 *
 * 早期实现是「其余列按比例整体缩放」：拉一下第 2 列，1/3/4 列全跟着变，完全无法预期。
 * 而「只跟相邻一条互换」又会让目标值被邻居大小卡住（第 1 列最宽只能到 13+13−2 = 24mm）。
 *
 * @param count 条数（列数/行数）；weights 缺省时按等分起步
 */
export function resizedSpanWeights(
  weights: number[] | undefined,
  count: number,
  i: number,
  target: number,
  total: number,
): number[] {
  const n = Math.max(1, Math.min(60, Math.round(count)))
  const w = normalizeWeights(weights, n)
  if (n <= 1) return [1]
  const abs = distribute(total, w)
  const at = Math.max(0, Math.min(n - 1, i))
  const minCell = Math.min(MIN_CELL_MM, total / (n * 2))
  const t = Math.min(
    Math.max(Number.isFinite(target) ? target : abs[at], minCell),
    Math.max(minCell, total - minCell * (n - 1)),
  )
  const next = abs.slice()
  next[at] = t
  let diff = t - abs[at] // > 0 需要借，< 0 需要还

  // 借/还的优先顺序：右边的依次、再左边的依次
  const order: number[] = []
  for (let k = at + 1; k < n; k++) order.push(k)
  for (let k = at - 1; k >= 0; k--) order.push(k)

  for (const j of order) {
    if (Math.abs(diff) < 1e-9) break
    if (diff > 0) {
      const take = Math.min(diff, Math.max(0, next[j] - minCell))
      next[j] -= take
      diff -= take
    } else {
      // 腾出来的空间一次性给第一个邻居，避免被切成碎片
      next[j] += -diff
      diff = 0
    }
  }
  // 兜底：极端情况下（全部列都到最小格宽）仍要保证 Σ = total
  const s = next.reduce((a, b) => a + b, 0)
  return s > 0 ? next.map((v) => (v * total) / s) : next.map(() => total / n)
}

/** 均分（全 1 = 等宽/等高） */
export function evenWeights(n: number): number[] {
  return Array.from({ length: Math.max(1, n) }, () => 1)
}

/** 行权重跟随行数（末尾补 1 / 截断）；原存档没有权重时保持 undefined（等分） */
function fitRowWeights(spec: TableSpec, n: number): Pick<TableSpec, 'rowWeights'> {
  if (!Array.isArray(spec.rowWeights)) return {}
  return { rowWeights: normalizeWeights(spec.rowWeights, n) }
}

function fitColWeights(spec: TableSpec, n: number): Pick<TableSpec, 'colWeights'> {
  if (!Array.isArray(spec.colWeights)) return {}
  return { colWeights: normalizeWeights(spec.colWeights, n) }
}

/** 增/减行（末尾操作；n 下限 1） */
export function resizeTableRows(spec: TableSpec, nextRows: number): TableSpec {
  const rows = normalizeRows(spec.rows)
  const cols = rows[0].length
  const target = Math.max(1, Math.min(60, Math.round(nextRows)))
  if (target === rows.length) return { ...spec, rows }
  const w = fitRowWeights(spec, target)
  if (target > rows.length) {
    const added = Array.from({ length: target - rows.length }, () => Array.from({ length: cols }, () => ''))
    return { ...spec, rows: [...rows, ...added], ...w }
  }
  return { ...spec, rows: rows.slice(0, target), ...w }
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
    ...fitColWeights(spec, target),
  }
}

/** 在指定行之后插入一行（index = -1 表示插入到最前） */
export function insertTableRow(spec: TableSpec, index: number): TableSpec {
  const rows = normalizeRows(spec.rows)
  const cols = rows[0].length
  const at = Math.max(0, Math.min(rows.length, index + 1))
  const next = rows.slice()
  next.splice(at, 0, Array.from({ length: cols }, () => ''))
  // 新行沿用被插入位置的权重（插在末尾就跟最后一行一样高），观感比突然多一条等分线自然
  let rw: Pick<TableSpec, 'rowWeights'> = {}
  if (Array.isArray(spec.rowWeights)) {
    const w = normalizeWeights(spec.rowWeights, rows.length).slice()
    const donor = w[Math.max(0, Math.min(w.length - 1, at - 1))] ?? 1
    w.splice(at, 0, donor)
    rw = { rowWeights: w }
  }
  return { ...spec, rows: next, ...rw }
}

/** 删除指定行（至少保留 1 行） */
export function removeTableRow(spec: TableSpec, index: number): TableSpec {
  const rows = normalizeRows(spec.rows)
  if (rows.length <= 1) return { ...spec, rows }
  const at = Math.max(0, Math.min(rows.length - 1, index))
  const next = rows.slice()
  next.splice(at, 1)
  let rw: Pick<TableSpec, 'rowWeights'> = {}
  if (Array.isArray(spec.rowWeights)) {
    const w = normalizeWeights(spec.rowWeights, rows.length).slice()
    w.splice(at, 1)
    rw = { rowWeights: w }
  }
  return { ...spec, rows: next, ...rw }
}

/** 在指定列之后插入一列（index = -1 表示插入到最前） */
export function insertTableCol(spec: TableSpec, index: number): TableSpec {
  const rows = normalizeRows(spec.rows)
  const at = Math.max(0, Math.min(rows[0].length, index + 1))
  let cw: Pick<TableSpec, 'colWeights'> = {}
  if (Array.isArray(spec.colWeights)) {
    const w = normalizeWeights(spec.colWeights, rows[0].length).slice()
    const donor = w[Math.max(0, Math.min(w.length - 1, at - 1))] ?? 1
    w.splice(at, 0, donor)
    cw = { colWeights: w }
  }
  return {
    ...spec,
    rows: rows.map((r) => {
      const next = r.slice()
      next.splice(at, 0, '')
      return next
    }),
    ...cw,
  }
}

/** 删除指定列（至少保留 1 列） */
export function removeTableCol(spec: TableSpec, index: number): TableSpec {
  const rows = normalizeRows(spec.rows)
  if (rows[0].length <= 1) return { ...spec, rows }
  const at = Math.max(0, Math.min(rows[0].length - 1, index))
  let cw: Pick<TableSpec, 'colWeights'> = {}
  if (Array.isArray(spec.colWeights)) {
    const w = normalizeWeights(spec.colWeights, rows[0].length).slice()
    w.splice(at, 1)
    cw = { colWeights: w }
  }
  return { ...spec, rows: rows.map((r) => r.filter((_, i) => i !== at)), ...cw }
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

  const colSpans = tableColSpans(spec, w)
  const rowSpans = tableRowSpans(spec, h)
  const colX = spanOffsets(colSpans)
  const rowY = spanOffsets(rowSpans)
  const half = bw / 2
  const objs: fabric.Object[] = []

  // ① 表头底色（放在最下）
  if (headerRow && headerBg && headerBg !== 'transparent') {
    objs.push(
      new fabric.Rect({
        left: half,
        top: half,
        width: Math.max(0, w - bw),
        height: Math.max(0, rowSpans[0] - bw),
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
  for (let r = 1; r < nR; r++) addLine(half, rowY[r], w - half, rowY[r])
  for (let c = 1; c < nC; c++) addLine(colX[c], half, colX[c], h - half)

  // ③ 单元格文字（放最上，避免被网格线压住）
  for (let r = 0; r < nR; r++) {
    for (let c = 0; c < nC; c++) {
      const text = rows[r][c]
      if (!text) continue
      const isHeader = headerRow && r === 0
      objs.push(
        new fabric.Textbox(text, {
          left: colX[c] + padding,
          top: rowY[r] + rowSpans[r] / 2,
          width: Math.max(1, colSpans[c] - padding * 2),
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
