// 条码渲染辅助：码制清单、默认设置推断（真正的渲染见 barcodeVector.ts，输出矢量矩形组）

/** 可选的条码/二维码种类（bcid 需为 bwip-js 合法名） */
export type BarcodeType =
  // 二维码 / 矩阵
  | 'qrcode'
  | 'microqrcode'
  | 'azteccode'
  | 'azteccodecompact'
  | 'datamatrix'
  | 'datamatrixrectangular'
  | 'maxicode'
  | 'dotcode'
  | 'codeone'
  | 'hanxin'
  | 'ultracode'
  | 'swissqrcode'
  // 堆叠 2D
  | 'pdf417'
  // 一维 / 线性
  | 'code128'
  | 'code39'
  | 'code39ext'
  | 'code93'
  | 'code93ext'
  | 'code11'
  | 'code2of5'
  | 'interleaved2of5'
  | 'industrial2of5'
  | 'matrix2of5'
  | 'iata2of5'
  | 'coop2of5'
  | 'datalogic2of5'
  | 'rationalizedCodabar'
  | 'msi'
  | 'plessey'
  | 'pharmacode'
  // 零售 / EAN / UPC
  | 'ean13'
  | 'ean8'
  | 'upca'
  | 'upce'
  | 'itf14'
  | 'gs1-128'
  // 邮政 / 特殊
  | 'postnet'
  | 'planet'
  | 'kix'
  | 'telepen'
  | 'telepennumeric'
  | 'bc412'

interface BarcodeMeta {
  value: BarcodeType
  label: string
  group: string
}

/** 按组展示给用户 */
export const BARCODE_OPTIONS: BarcodeMeta[] = [
  // 二维码
  { value: 'qrcode', label: 'QR Code', group: '二维码' },
  { value: 'microqrcode', label: 'Micro QR', group: '二维码' },
  { value: 'datamatrix', label: 'DataMatrix', group: '二维码' },
  { value: 'datamatrixrectangular', label: 'DataMatrix Rect', group: '二维码' },
  { value: 'azteccode', label: 'Aztec Code', group: '二维码' },
  { value: 'azteccodecompact', label: 'Aztec Compact', group: '二维码' },
  { value: 'maxicode', label: 'MaxiCode', group: '二维码' },
  { value: 'dotcode', label: 'DotCode', group: '二维码' },
  { value: 'codeone', label: 'Code One', group: '二维码' },
  { value: 'hanxin', label: '汉信码 HanXin', group: '二维码' },
  { value: 'ultracode', label: 'Ultracode', group: '二维码' },
  { value: 'swissqrcode', label: 'Swiss QR', group: '二维码' },
  { value: 'pdf417', label: 'PDF417', group: '堆叠 2D' },
  // 线性一维
  { value: 'code128', label: 'Code128', group: '一维' },
  { value: 'code39', label: 'Code39', group: '一维' },
  { value: 'code39ext', label: 'Code39 Extended', group: '一维' },
  { value: 'code93', label: 'Code93', group: '一维' },
  { value: 'code93ext', label: 'Code93 Extended', group: '一维' },
  { value: 'code11', label: 'Code11', group: '一维' },
  { value: 'rationalizedCodabar', label: 'Codabar', group: '一维' },
  { value: 'msi', label: 'MSI Plessey', group: '一维' },
  { value: 'plessey', label: 'Plessey', group: '一维' },
  { value: 'pharmacode', label: 'Pharmacode', group: '一维' },
  // 2 of 5 家族
  { value: 'interleaved2of5', label: 'Interleaved 2/5', group: '2/5 码' },
  { value: 'industrial2of5', label: 'Industrial 2/5', group: '2/5 码' },
  { value: 'code2of5', label: 'Standard 2/5', group: '2/5 码' },
  { value: 'matrix2of5', label: 'Matrix 2/5', group: '2/5 码' },
  { value: 'iata2of5', label: 'IATA 2/5', group: '2/5 码' },
  { value: 'coop2of5', label: 'COOP 2/5', group: '2/5 码' },
  { value: 'datalogic2of5', label: 'Datalogic 2/5', group: '2/5 码' },
  // 零售 / EAN / UPC
  { value: 'ean13', label: 'EAN-13', group: '商品码' },
  { value: 'ean8', label: 'EAN-8', group: '商品码' },
  { value: 'upca', label: 'UPC-A', group: '商品码' },
  { value: 'upce', label: 'UPC-E', group: '商品码' },
  { value: 'itf14', label: 'ITF-14', group: '商品码' },
  { value: 'gs1-128', label: 'GS1-128', group: '商品码' },
  // 邮政 / 特殊
  { value: 'postnet', label: 'POSTNET', group: '邮政' },
  { value: 'planet', label: 'PLANET', group: '邮政' },
  { value: 'kix', label: 'KIX', group: '邮政' },
  { value: 'telepen', label: 'Telepen', group: '其他' },
  { value: 'telepennumeric', label: 'Telepen Numeric', group: '其他' },
  { value: 'bc412', label: 'BC412', group: '其他' },
]

/** 按“尺寸=正方形/矩阵”方式渲染的码制（不传 height/width，仅 scale） */
const BOX_2D: ReadonlySet<string> = new Set([
  'qrcode', 'microqrcode', 'azteccode', 'azteccodecompact', 'datamatrix',
  'datamatrixrectangular', 'maxicode', 'dotcode', 'codeone', 'hanxin',
  'ultracode', 'swissqrcode', 'pdf417',
])
export const is2dType = (t: BarcodeType): boolean => BOX_2D.has(t)

/**
 * 条码渲染设置（每条码对象可独立调整）
 */
export interface BarcodeRenderSettings {
  /** 是否显示人眼可读文字（一维码） */
  showText: boolean
  /** 可读文字字号(pt) */
  textSizePt: number
  /** 四周静区(padding, px) */
  quietZone: number
  /** 渲染倍率(越大越清晰/像素越高) */
  scale: number
  /** 二维码容错等级（QR 系码制：qrcode/microqrcode/swissqrcode/hanxin），仅该族生效 */
  eccLevel?: 'L' | 'M' | 'Q' | 'H'
}

/** QR 系：支持 4 级容错(L/M/Q/H)的码制 */
const QR_FAMILY: ReadonlySet<string> = new Set(['qrcode', 'microqrcode', 'swissqrcode', 'hanxin'])
export const isQrFamily = (t: BarcodeType | string): boolean => QR_FAMILY.has(t)

export const DEFAULT_BARCODE_SETTINGS: BarcodeRenderSettings = {
  showText: false,
  textSizePt: 9,
  quietZone: 4,
  scale: 2,
  eccLevel: 'M',
}

/** 一维码默认显示人眼可读文字（2D 码无此概念，保持 false） */
export function defaultShowText(type: BarcodeType): boolean {
  return !is2dType(type)
}

/** 某条码对象渲染设置的实际默认值（未存储时按码制推断，含零售默认显示文字） */
export function defaultSettingsFor(type: BarcodeType): BarcodeRenderSettings {
  return { ...DEFAULT_BARCODE_SETTINGS, showText: defaultShowText(type) }
}
