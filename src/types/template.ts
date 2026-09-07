// 标签编辑器 — 类型定义

/** 画布元素类型（条码统一为 barcode，具体码制见 _barcodeType） */
export type ElementKind = 'text' | 'barcode' | 'rect' | 'line' | 'image' | 'shape'

/** 形状子类型（kind === 'shape' 时的具体形状） */
export type ShapeType = 'ellipse' | 'triangle' | 'diamond' | 'star'

/** 纸张尺寸（mm） */
export interface PaperSize {
  widthMm: number
  heightMm: number
}

/** 工具类型（左侧工具条触发指令，与元素 kind 解耦） */
export type ToolType =
  | 'text'
  | 'barcode-code128'
  | 'barcode-qrcode'
  | 'rect'
  | 'line'
  | 'shape-ellipse'
  | 'shape-triangle'
  | 'shape-diamond'
  | 'shape-star'
  | 'upload'

/** 数据行（表头 -> 单元格值） */
export type DataRow = Record<string, string | number>

/** 一个对象在属性面板中暴露的通用几何 */
export interface ObjectProps {
  x: number
  y: number
  width: number
  height: number
  angle: number
}

/** 导出/导入模板结构：{ 元信息 + fabric toJSON 结果 } */
export interface LabelTemplate {
  version: 1
  paper: PaperSize
  canvas: Record<string, unknown> // fabric.Canvas#toJSON()
}

/** 从文本中抽取出的所有 {{字段}} 变量名 */
export function extractVariables(text: string): string[] {
  const vars: string[] = []
  const re = /\{\{\s*([^}]+?)\s*\}\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (!vars.includes(m[1])) vars.push(m[1])
  }
  return vars
}

/** 将某行数据渲染进含变量文本（未命中的变量回退为空串） */
export function renderText(text: string, row: DataRow | null): string {
  if (!row) return text
  return text.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, key: string) => {
    const v = row[key]
    return v === undefined || v === null ? '' : String(v)
  })
}
