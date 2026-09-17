// 属性面板使用的共享类型
import type { DataRow, ElementKind, ShapeType } from '@/types/template'
import type { BarcodeType, BarcodeRenderSettings } from '@/lib/barcode'

/** 文本元素格式（顶层属性，可整段应用） */
export interface TextStyle {
  fontFamily: string
  fontSizePt: number
  bold: boolean
  italic: boolean
  color: string
  textAlign: 'left' | 'center' | 'right'
  /**
   * 字间距，单位 pt（与字号同口径，负数收紧、正数拉开）。
   * 内部会换算成 fabric 的 charSpacing（千分之一 em），
   * 因此改字号时会按新字号重算，视觉字距保持恒定。
   */
  letterSpacingPt?: number
}

/** 文本元素在属性面板中展示的格式快照（仅 kind==='text' 时存在） */
export interface TextFormatSnapshot {
  fontFamily: string
  fontSizePt: number
  bold: boolean
  italic: boolean
  color: string
  textAlign: string
  /** 字间距(pt)，0=默认 */
  letterSpacingPt: number
}

/**
 * 条码「对齐 / 生长锚点」：内容变长使条码变宽时，以哪一侧为基准扩展。
 * 与文本的左/中/右是同一套语义 —— 靠左=左边缘固定向右长、居中=向两侧均分、
 * 靠右=右边缘固定向左长（Code128 数据一多最容易右溢，靠右即可让它往左长）。
 * 实现 = 条码组的 `originX`，因此「改内容」与「手动拖拽」都遵守同一锚点。
 */
export type BarcodeAlign = 'left' | 'center' | 'right'

/** 序列化配置：批量打印时 {{seq}} 从 start 开始，每张 +step，补零到 minDigits 位 */
export interface SerialSpec {
  enabled: boolean
  start: number
  step: number
  /** 补零位数，如 4 → 0001 */
  minDigits: number
}

/** 当前选中对象的属性快照（mm 单位） */
export interface ActiveObject {
  id: string
  /** 用户命名（用于跨对象引用） */
  name: string
  /** 是否被锁定（锁定后不可拖动/缩放/旋转，但仍可点选以解锁） */
  locked: boolean
  kind: ElementKind
  x: number
  y: number
  width: number
  height: number
  angle: number
  /** 文本/条码原文（含 {{变量}}），图片为 null */
  text: string | null
  /** 矩形/直线：描边粗细（px，strokeUniform 恒定不随缩放） */
  strokeWidth?: number
  /** 矩形/直线/形状：描边颜色 */
  strokeColor?: string
  /** 仅矩形/形状：填充颜色（null 表示透明无填充） */
  fillColor?: string | null
  /** 仅矩形：圆角半径（显示 mm） */
  cornerRadiusMm?: number
  /** 仅 kind==='shape'：形状子类型 */
  shapeType?: ShapeType
  /** 内容对象：显示前缀（纯文本） */
  prefix?: string
  /** 内容对象：显示后缀（纯文本） */
  suffix?: string
  /** 内容对象：序列化配置 */
  serial?: SerialSpec
  /** 仅条码对象：当前码制 */
  barcodeType?: BarcodeType
  /** 仅条码对象：渲染设置 */
  barcodeSettings?: BarcodeRenderSettings
  /** 仅条码对象：人读文字相对条区的额外距离(mm)。>0 拉开，<0 拉近；默认 0。 */
  barcodeTextOffsetMm?: number
  /** 仅条码对象：对齐/生长锚点（内容变长条码变宽时向哪一侧扩展），默认 'left' */
  barcodeAlign?: BarcodeAlign
  /** 仅文本对象：文本格式 */
  textFormat?: TextFormatSnapshot
  /** 仅文本对象：区域框（开启后显示边框+底色，类似"区域文本框"） */
  textRegion?: { border: boolean; bg: boolean }
  /** 仅文本对象：段落文本（定宽自动换行的多行区域框） */
  isParagraph?: boolean
}

export type { DataRow, ElementKind }
