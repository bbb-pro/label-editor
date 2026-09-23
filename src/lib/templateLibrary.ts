// 模板库 —— 公开标签模板（数据来源：https://label.transkoi.com/zh/ 的公开模板）
//
// 【数据口径】下方 TEMPLATE_LIBRARY 是原站模板定义的**原样拷贝**，坐标/尺寸/字号
// 一律沿用原站单位：1mm = 8 单位（见 TK_PER_MM）。之所以不在这里手工换算成 mm，
// 是为了让「数据」与「换算」彻底分离 —— 数据保持可核对，换算集中在一处（buildTemplateSpec），
// 将来原站数据更新时可以直接替换数组而不必重新心算每个数字。
//
// 【支持的元素】原站 6 种：text / barcode / qrcode / shape / table / time。
// 其中 table 与 time 我们没有对应元素类型，由 buildTemplateSpec 展开为等价的原生元素：
//   · table → 外框矩形 + 分隔条矩形 + 每格一个文本框（都是顶层普通对象，可各自改样式）
//   · time  → 一个普通文本框，内容取载入时刻的日期时间

import type { BarcodeType } from '@/lib/barcode'
import { mmToPx } from '@/lib/mm'
import { pxToPt } from '@/lib/textStyles'

/** 原站坐标单位：每毫米 8 单位 */
export const TK_PER_MM = 8

/** 行业分类（与原站的筛选项一一对应） */
export type TplCategory = 'food' | 'ecommerce' | 'warehouse' | 'pharma' | 'asset' | 'clothing'

export const TPL_CATEGORIES: { code: TplCategory; name: string }[] = [
  { code: 'food', name: '食品标签' },
  { code: 'ecommerce', name: '电商快递' },
  { code: 'warehouse', name: '仓储物流' },
  { code: 'pharma', name: '医药标签' },
  { code: 'asset', name: '资产标签' },
  { code: 'clothing', name: '服装吊牌' },
]

const CATEGORY_NAME = new Map(TPL_CATEGORIES.map((c) => [c.code, c.name]))
export const categoryNameOf = (code: TplCategory): string => CATEGORY_NAME.get(code) ?? '其他'

// ── 原站元素定义（只列实际用到的字段） ──────────────────────
interface RawBase {
  /** 原站元素 id，仅作数据溯源，落画布时不使用（我们的对象 id 由引擎生成） */
  id: string
}
interface RawText extends RawBase {
  type: 'text'
  x: number
  y: number
  width: number
  height: number
  content: string
  fontSize: number
  fontWeight?: boolean
  /** 0=左 1=中 2=右 */
  textAlign?: 0 | 1 | 2
}
interface RawBarcode extends RawBase {
  type: 'barcode'
  x: number
  y: number
  width: number
  height: number
  content: string
  barcodeType: string
}
interface RawQrcode extends RawBase {
  type: 'qrcode'
  x: number
  y: number
  width: number
  height: number
}
/** 分隔线/装订线：原站用「高度仅几单位的 rect」表达，fillMode=1 表示实心 */
interface RawShape extends RawBase {
  type: 'shape'
  x: number
  y: number
  width: number
  height: number
  shapeType: string
  lineStyle?: string
  strokeWidth: number
  fillMode?: number
}
interface RawTable extends RawBase {
  type: 'table'
  x: number
  y: number
  width: number
  height: number
  tableCols: number
  tableRows: number
  tableBorderWidth: number
  fontSize: number
  tableCellContents: string[][]
}
interface RawTime extends RawBase {
  type: 'time'
  x: number
  y: number
  width: number
  height: number
  fontSize: number
}
type RawElement = RawText | RawBarcode | RawQrcode | RawShape | RawTable | RawTime

export interface LibTemplate {
  id: string
  industry: TplCategory
  name: string
  /** 供展示的尺寸文案，如 60×40mm */
  size: string
  label: { width: number; height: number; elements: RawElement[] }
}

export const TEMPLATE_LIBRARY: LibTemplate[] = [
  {
    "id": "food-juice",
    "industry": "food",
    "name": "果汁饮料标签",
    "size": "60×40mm",
    "label": {
      "width": 480,
      "height": 320,
      "elements": [
        {
          "id": "e1",
          "type": "text",
          "x": 16,
          "y": 16,
          "width": 448,
          "height": 64,
          "content": "蓝莓果汁",
          "fontSize": 56,
          "fontWeight": true
        },
        {
          "id": "e2",
          "type": "text",
          "x": 16,
          "y": 88,
          "width": 448,
          "height": 40,
          "content": "净含量 330ml · 产地云南",
          "fontSize": 32
        },
        {
          "id": "e3",
          "type": "barcode",
          "x": 16,
          "y": 144,
          "width": 448,
          "height": 128,
          "content": "6901234567890",
          "barcodeType": "EAN13"
        },
        {
          "id": "e4",
          "type": "text",
          "x": 16,
          "y": 280,
          "width": 448,
          "height": 32,
          "content": "保质期：12个月",
          "fontSize": 24
        }
      ]
    }
  },
  {
    "id": "food-nutrition",
    "industry": "food",
    "name": "营养成分标签",
    "size": "80×60mm",
    "label": {
      "width": 640,
      "height": 480,
      "elements": [
        {
          "id": "e1",
          "type": "text",
          "x": 16,
          "y": 16,
          "width": 608,
          "height": 56,
          "content": "营养成分表",
          "fontSize": 48,
          "fontWeight": true,
          "textAlign": 1
        },
        {
          "id": "e2",
          "type": "table",
          "x": 16,
          "y": 80,
          "width": 608,
          "height": 280,
          "tableCols": 2,
          "tableRows": 5,
          "tableBorderWidth": 8,
          "fontSize": 24,
          "tableCellContents": [
            [
              "项目",
              "每100g"
            ],
            [
              "能量",
              "252kJ"
            ],
            [
              "蛋白质",
              "2.1g"
            ],
            [
              "脂肪",
              "0g"
            ],
            [
              "碳水化合物",
              "13.2g"
            ]
          ]
        },
        {
          "id": "e3",
          "type": "barcode",
          "x": 16,
          "y": 376,
          "width": 608,
          "height": 80,
          "content": "6901234567890",
          "barcodeType": "EAN13"
        },
        {
          "id": "e4",
          "type": "text",
          "x": 16,
          "y": 440,
          "width": 608,
          "height": 32,
          "content": "保质期：18个月  产地：云南省昆明市",
          "fontSize": 24
        }
      ]
    }
  },
  {
    "id": "ecom-waybill",
    "industry": "ecommerce",
    "name": "快递物流面单",
    "size": "100×70mm",
    "label": {
      "width": 800,
      "height": 560,
      "elements": [
        {
          "id": "e1",
          "type": "text",
          "x": 16,
          "y": 16,
          "width": 80,
          "height": 80,
          "content": "收",
          "fontSize": 80,
          "fontWeight": true
        },
        {
          "id": "e2",
          "type": "text",
          "x": 112,
          "y": 20,
          "width": 672,
          "height": 48,
          "content": "张三  138-0000-0000",
          "fontSize": 40,
          "fontWeight": true
        },
        {
          "id": "e3",
          "type": "text",
          "x": 112,
          "y": 76,
          "width": 672,
          "height": 40,
          "content": "上海市浦东新区XX路XX号XX室",
          "fontSize": 32
        },
        {
          "id": "e4",
          "type": "shape",
          "x": 16,
          "y": 128,
          "width": 768,
          "height": 8,
          "shapeType": "rect",
          "lineStyle": "solid",
          "strokeWidth": 8,
          "fillMode": 1
        },
        {
          "id": "e5",
          "type": "text",
          "x": 16,
          "y": 148,
          "width": 768,
          "height": 40,
          "content": "寄：李四  |  深圳市南山区科技园",
          "fontSize": 28
        },
        {
          "id": "e6",
          "type": "barcode",
          "x": 16,
          "y": 208,
          "width": 504,
          "height": 136,
          "content": "SF1234567890",
          "barcodeType": "code128"
        },
        {
          "id": "e7",
          "type": "qrcode",
          "x": 536,
          "y": 208,
          "width": 248,
          "height": 248
        },
        {
          "id": "e8",
          "type": "text",
          "x": 16,
          "y": 364,
          "width": 504,
          "height": 36,
          "content": "SF1234567890",
          "fontSize": 28,
          "textAlign": 1
        },
        {
          "id": "e9",
          "type": "text",
          "x": 16,
          "y": 408,
          "width": 768,
          "height": 36,
          "content": "付款方式：货到付款  重量：1.5KG",
          "fontSize": 28
        }
      ]
    }
  },
  {
    "id": "ecom-price-tag",
    "industry": "ecommerce",
    "name": "商品价签",
    "size": "40×25mm",
    "label": {
      "width": 320,
      "height": 200,
      "elements": [
        {
          "id": "e1",
          "type": "text",
          "x": 8,
          "y": 8,
          "width": 304,
          "height": 48,
          "content": "蓝牙耳机 BT-X5",
          "fontSize": 40,
          "fontWeight": true
        },
        {
          "id": "e2",
          "type": "text",
          "x": 8,
          "y": 64,
          "width": 200,
          "height": 56,
          "content": "¥ 299",
          "fontSize": 56,
          "fontWeight": true
        },
        {
          "id": "e3",
          "type": "barcode",
          "x": 8,
          "y": 128,
          "width": 304,
          "height": 64,
          "content": "6921234567890",
          "barcodeType": "EAN13"
        }
      ]
    }
  },
  {
    "id": "wh-shelf",
    "industry": "warehouse",
    "name": "货架位置标签",
    "size": "80×40mm",
    "label": {
      "width": 640,
      "height": 320,
      "elements": [
        {
          "id": "e1",
          "type": "text",
          "x": 16,
          "y": 16,
          "width": 608,
          "height": 144,
          "content": "A-03-07",
          "fontSize": 128,
          "fontWeight": true,
          "textAlign": 1
        },
        {
          "id": "e2",
          "type": "text",
          "x": 16,
          "y": 168,
          "width": 608,
          "height": 48,
          "content": "仓储区 · 3排 · 7号位",
          "fontSize": 36,
          "textAlign": 1
        },
        {
          "id": "e3",
          "type": "barcode",
          "x": 16,
          "y": 232,
          "width": 608,
          "height": 72,
          "content": "WH-A0307",
          "barcodeType": "code128"
        }
      ]
    }
  },
  {
    "id": "wh-pallet",
    "industry": "warehouse",
    "name": "入库托盘标签",
    "size": "100×70mm",
    "label": {
      "width": 800,
      "height": 560,
      "elements": [
        {
          "id": "e1",
          "type": "text",
          "x": 16,
          "y": 16,
          "width": 768,
          "height": 56,
          "content": "入库托盘标签",
          "fontSize": 48,
          "fontWeight": true,
          "textAlign": 1
        },
        {
          "id": "e2",
          "type": "table",
          "x": 16,
          "y": 80,
          "width": 768,
          "height": 256,
          "tableCols": 2,
          "tableRows": 4,
          "tableBorderWidth": 8,
          "fontSize": 28,
          "tableCellContents": [
            [
              "品名",
              "蓝莓果汁 330ml"
            ],
            [
              "数量",
              "1200 瓶"
            ],
            [
              "批次",
              "B20240101"
            ],
            [
              "仓位",
              "A-03-07"
            ]
          ]
        },
        {
          "id": "e3",
          "type": "barcode",
          "x": 16,
          "y": 352,
          "width": 600,
          "height": 120,
          "content": "PLT20240001",
          "barcodeType": "code128"
        },
        {
          "id": "e4",
          "type": "time",
          "x": 16,
          "y": 488,
          "width": 400,
          "height": 56,
          "fontSize": 40
        }
      ]
    }
  },
  {
    "id": "pharma-medicine",
    "industry": "pharma",
    "name": "药品包装标签",
    "size": "60×40mm",
    "label": {
      "width": 480,
      "height": 320,
      "elements": [
        {
          "id": "e1",
          "type": "text",
          "x": 16,
          "y": 16,
          "width": 448,
          "height": 64,
          "content": "阿莫西林胶囊",
          "fontSize": 56,
          "fontWeight": true
        },
        {
          "id": "e2",
          "type": "text",
          "x": 16,
          "y": 88,
          "width": 448,
          "height": 40,
          "content": "规格：0.25g × 24粒",
          "fontSize": 32
        },
        {
          "id": "e3",
          "type": "text",
          "x": 16,
          "y": 136,
          "width": 288,
          "height": 40,
          "content": "批号：BZ20240101",
          "fontSize": 32
        },
        {
          "id": "e4",
          "type": "barcode",
          "x": 16,
          "y": 192,
          "width": 448,
          "height": 104,
          "content": "6901011234567",
          "barcodeType": "EAN13"
        }
      ]
    }
  },
  {
    "id": "pharma-inspection",
    "industry": "pharma",
    "name": "检验合格标签",
    "size": "50×30mm",
    "label": {
      "width": 400,
      "height": 240,
      "elements": [
        {
          "id": "e1",
          "type": "text",
          "x": 16,
          "y": 8,
          "width": 368,
          "height": 88,
          "content": "检验合格",
          "fontSize": 72,
          "fontWeight": true,
          "textAlign": 1
        },
        {
          "id": "e2",
          "type": "text",
          "x": 16,
          "y": 104,
          "width": 368,
          "height": 40,
          "content": "批号：BZ20240101",
          "fontSize": 32
        },
        {
          "id": "e3",
          "type": "text",
          "x": 16,
          "y": 152,
          "width": 368,
          "height": 36,
          "content": "检验日期：2024-01-01",
          "fontSize": 28
        },
        {
          "id": "e4",
          "type": "barcode",
          "x": 16,
          "y": 196,
          "width": 368,
          "height": 36,
          "content": "BZ20240101",
          "barcodeType": "code128"
        }
      ]
    }
  },
  {
    "id": "asset-fixed",
    "industry": "asset",
    "name": "固定资产标签",
    "size": "60×30mm",
    "label": {
      "width": 480,
      "height": 240,
      "elements": [
        {
          "id": "e1",
          "type": "text",
          "x": 16,
          "y": 16,
          "width": 240,
          "height": 48,
          "content": "固定资产",
          "fontSize": 40,
          "fontWeight": true
        },
        {
          "id": "e2",
          "type": "text",
          "x": 16,
          "y": 72,
          "width": 240,
          "height": 40,
          "content": "笔记本电脑",
          "fontSize": 32
        },
        {
          "id": "e3",
          "type": "text",
          "x": 16,
          "y": 120,
          "width": 240,
          "height": 36,
          "content": "资产编号:",
          "fontSize": 28
        },
        {
          "id": "e4",
          "type": "text",
          "x": 16,
          "y": 160,
          "width": 240,
          "height": 48,
          "content": "IT-2024-0001",
          "fontSize": 40,
          "fontWeight": true
        },
        {
          "id": "e5",
          "type": "qrcode",
          "x": 264,
          "y": 16,
          "width": 200,
          "height": 208
        }
      ]
    }
  },
  {
    "id": "asset-it",
    "industry": "asset",
    "name": "IT 设备标签",
    "size": "70×40mm",
    "label": {
      "width": 560,
      "height": 320,
      "elements": [
        {
          "id": "e1",
          "type": "text",
          "x": 16,
          "y": 16,
          "width": 320,
          "height": 48,
          "content": "服务器 Dell R740",
          "fontSize": 40,
          "fontWeight": true
        },
        {
          "id": "e2",
          "type": "text",
          "x": 16,
          "y": 72,
          "width": 320,
          "height": 36,
          "content": "SN: SRV-20240001",
          "fontSize": 28
        },
        {
          "id": "e3",
          "type": "text",
          "x": 16,
          "y": 116,
          "width": 320,
          "height": 36,
          "content": "IP: 192.168.1.100",
          "fontSize": 28
        },
        {
          "id": "e4",
          "type": "text",
          "x": 16,
          "y": 160,
          "width": 320,
          "height": 36,
          "content": "机房: IDC-A",
          "fontSize": 28
        },
        {
          "id": "e5",
          "type": "barcode",
          "x": 16,
          "y": 208,
          "width": 320,
          "height": 96,
          "content": "SRV-20240001",
          "barcodeType": "code128"
        },
        {
          "id": "e6",
          "type": "qrcode",
          "x": 352,
          "y": 16,
          "width": 192,
          "height": 192
        }
      ]
    }
  },
  {
    "id": "clothing-hangtag",
    "industry": "clothing",
    "name": "服装吊牌",
    "size": "50×80mm",
    "label": {
      "width": 400,
      "height": 640,
      "elements": [
        {
          "id": "e1",
          "type": "text",
          "x": 16,
          "y": 16,
          "width": 368,
          "height": 72,
          "content": "BRAND NAME",
          "fontSize": 64,
          "fontWeight": true,
          "textAlign": 1
        },
        {
          "id": "e2",
          "type": "shape",
          "x": 32,
          "y": 96,
          "width": 336,
          "height": 8,
          "shapeType": "rect",
          "lineStyle": "solid",
          "strokeWidth": 8,
          "fillMode": 1
        },
        {
          "id": "e3",
          "type": "text",
          "x": 16,
          "y": 112,
          "width": 368,
          "height": 52,
          "content": "休闲夹克 秋季款",
          "fontSize": 44,
          "textAlign": 1
        },
        {
          "id": "e4",
          "type": "text",
          "x": 16,
          "y": 172,
          "width": 368,
          "height": 48,
          "content": "SIZE: L  颜色: 深蓝",
          "fontSize": 40,
          "textAlign": 1
        },
        {
          "id": "e5",
          "type": "text",
          "x": 16,
          "y": 228,
          "width": 368,
          "height": 40,
          "content": "面料: 100% 棉",
          "fontSize": 32,
          "textAlign": 1
        },
        {
          "id": "e6",
          "type": "qrcode",
          "x": 120,
          "y": 288,
          "width": 160,
          "height": 160
        },
        {
          "id": "e7",
          "type": "text",
          "x": 80,
          "y": 456,
          "width": 240,
          "height": 36,
          "content": "扫码查看洗涤说明",
          "fontSize": 28,
          "textAlign": 1
        },
        {
          "id": "e8",
          "type": "barcode",
          "x": 16,
          "y": 508,
          "width": 368,
          "height": 112,
          "content": "5901234567890",
          "barcodeType": "EAN13"
        }
      ]
    }
  },
  {
    "id": "clothing-care",
    "industry": "clothing",
    "name": "洗涤说明标签",
    "size": "40×30mm",
    "label": {
      "width": 320,
      "height": 240,
      "elements": [
        {
          "id": "e1",
          "type": "text",
          "x": 8,
          "y": 8,
          "width": 304,
          "height": 40,
          "content": "成分说明",
          "fontSize": 32,
          "fontWeight": true
        },
        {
          "id": "e2",
          "type": "text",
          "x": 8,
          "y": 56,
          "width": 304,
          "height": 36,
          "content": "棉 80% · 涤纶 20%",
          "fontSize": 28
        },
        {
          "id": "e3",
          "type": "text",
          "x": 8,
          "y": 100,
          "width": 304,
          "height": 36,
          "content": "机洗 ≤30°C  不可漂白",
          "fontSize": 28
        },
        {
          "id": "e4",
          "type": "text",
          "x": 8,
          "y": 144,
          "width": 304,
          "height": 36,
          "content": "低温熨烫  悬挂晾干",
          "fontSize": 28
        },
        {
          "id": "e5",
          "type": "barcode",
          "x": 8,
          "y": 188,
          "width": 304,
          "height": 44,
          "content": "CARE-001",
          "barcodeType": "code128"
        }
      ]
    }
  }
]

// ── 转换后的「可落画布」规格（我们的原生口径：mm / pt / 度） ──────
//
// 可选字段都是**为兼容第二套模板源（y56y.com 通用模板）而加**的：那一套模板
// 带颜色、旋转、字距、线宽与图形，原 transkoi 模板只用黑白色与轴对齐，所以
// 这些字段全部可选、缺省即原行为，老模板与老序列化数据不受影响。

export type TplTextAlign = 'left' | 'center' | 'right'

export interface TplTextNode {
  kind: 'text'
  xMm: number
  yMm: number
  wMm: number
  text: string
  fontSizePt: number
  bold: boolean
  align: TplTextAlign
  /** 元素声明高度(mm)。仅旋转节点需要：旋转绕「元素框中心」，须知道框高 */
  hMm?: number
  /** 文字颜色，缺省黑色 */
  color?: string
  /** 旋转角（度，顺时针），缺省 0 */
  rotateDeg?: number
  /** 字距（pt），缺省 0 */
  letterSpacingPt?: number
  /** 多行文本框（原站 textarea）：按框宽自动折行，行高为字号的倍数 */
  multiline?: boolean
  lineHeight?: number
  /** 斜体 */
  italic?: boolean
  /** 下划线 */
  underline?: boolean
}
export interface TplBarcodeNode {
  kind: 'barcode'
  xMm: number
  yMm: number
  wMm: number
  hMm: number
  barcodeType: BarcodeType
  text: string
  /** 是否显示一维码的人读文字，缺省按码制推断 */
  showText?: boolean
  fgColor?: string
  bgColor?: string
  /** QR 系码制的容错等级 */
  eccLevel?: 'L' | 'M' | 'Q' | 'H'
  rotateDeg?: number
}
/** 矩形：filled=true 为实心色块（表格分隔条），否则为描边空心框 */
export interface TplRectNode {
  kind: 'rect'
  xMm: number
  yMm: number
  wMm: number
  hMm: number
  /** 描边宽(mm)；filled 时忽略 */
  strokeMm: number
  filled: boolean
  fillColor?: string
  strokeColor?: string
  /** 圆角半径(mm) */
  radiusMm?: number
  rotateDeg?: number
}
/** 直线：x1/y1 → x2/y2（mm） */
export interface TplLineNode {
  kind: 'line'
  x1Mm: number
  y1Mm: number
  x2Mm: number
  y2Mm: number
  strokeMm: number
  color?: string
  /** 点线（原站 lineType≠0 / type=2） */
  dashed?: boolean
}
/** 椭圆：圆心 + 半径（mm） */
export interface TplEllipseNode {
  kind: 'ellipse'
  cxMm: number
  cyMm: number
  rxMm: number
  ryMm: number
  filled: boolean
  fillColor?: string
  strokeMm?: number
  strokeColor?: string
}
/**
 * 位图 / 矢量图标：`src` 是相对 `assets/templates/` 的文件名，
 * 由引擎在载入前预解析（见 CanvasController.prepareTemplateAssets）。
 */
export interface TplImageNode {
  kind: 'image'
  xMm: number
  yMm: number
  wMm: number
  hMm: number
  /** 文件名，相对 public/assets/templates/ */
  src: string
  /** true → 走矢量（fabric.loadSVGFromString），false → 位图 */
  vector?: boolean
  rotateDeg?: number
  /** 按原始宽高比缩放（不拉伸） */
  keepAspect?: boolean
}
export type TplNode =
  | TplTextNode
  | TplBarcodeNode
  | TplRectNode
  | TplLineNode
  | TplEllipseNode
  | TplImageNode


export interface TemplateSpec {
  /** 模板名（同时用作纸张名称） */
  name: string
  categoryName: string
  widthMm: number
  heightMm: number
  /** 纸张底色（缺省 / '#ffffff' = 白底）。反色、警示底等彩底模板用它而非背景矩形节点。 */
  bgColor?: string
  nodes: TplNode[]
}

/** 原站单位 → mm */
const tk2mm = (u: number): number => u / TK_PER_MM
/** 原站字号单位 → pt（原站字号是「像素高度」，按 1mm=8 单位换算回物理尺寸再转 pt） */
const tk2pt = (u: number): number => pxToPt(mmToPx(tk2mm(u)))

const ALIGN: Record<number, TplTextAlign> = { 0: 'left', 1: 'center', 2: 'right' }

/** 原站码制名 → bwip-js 的 bcid（原站用 EAN13 / code128，这里大小写不敏感） */
function toBarcodeType(raw: string): BarcodeType {
  const t = raw.toLowerCase()
  if (t === 'ean13' || t === 'code128' || t === 'code39' || t === 'upca') {
    return t as BarcodeType
  }
  return 'code128'
}

/**
 * GS1 模 10 校验位（EAN-13 / UPC-A 通用）：从右往左交替 3/1 加权。
 * @param data 校验位之前的数字串（EAN-13 → 12 位；UPC-A → 11 位）
 */
function gs1CheckDigit(data: string): number {
  let sum = 0
  for (let i = 0; i < data.length; i++) {
    const d = data.charCodeAt(data.length - 1 - i) - 48
    sum += i % 2 === 0 ? d * 3 : d
  }
  return (10 - (sum % 10)) % 10
}

/**
 * 零售码（EAN-13 / UPC-A）的**校验位修正**。
 *
 * 原站模板里的零售码是设计稿的示例数字，末位校验位并不满足 GS1 模 10 校验，
 * 而 bwip-js 会**直接拒绝**渲染校验位错误的 EAN-13 —— 表现为整条码不出现：
 * 实测「果汁饮料标签 / 营养成分标签 / 药品包装标签」三个模板的条码完全消失，
 * 「服装吊牌」也只剩一个二维码。
 *
 * 校验位只用于防错（与图案无关），这里按前 N-1 位重算末位，让模板能正常出码。
 * 仅当内容是「纯数字 + 位数正确」时才动手，其余情况（含字母、位数不符）原样返回，
 * 交给渲染层按原有逻辑处理。
 */
function fixRetailCheckDigit(type: BarcodeType, content: string): string {
  const need = type === 'ean13' ? 13 : type === 'upca' ? 12 : 0
  if (!need || content.length !== need || !/^\d+$/.test(content)) return content
  const head = content.slice(0, need - 1)
  const check = gs1CheckDigit(head)
  return check === content.charCodeAt(need - 1) - 48 ? content : head + String(check)
}

/**
 * 文本框的垂直定位：原站把文字放在 (y, height) 的块里，
 * 该块高度通常略大于字号 → 这里按「块内垂直居中」还原，避免与设计稿错位。
 */
const textTopMm = (y: number, height: number, fontSize: number): number =>
  tk2mm(y) + Math.max(0, (tk2mm(height) - tk2mm(fontSize) * 1.16) / 2)

/** 二维码没有给定内容 → 退回该模板的条码内容，再退回模板名 */
function qrPayload(tpl: LibTemplate): string {
  for (const e of tpl.label.elements) {
    if (e.type === 'barcode' && e.content) return e.content
  }
  return tpl.name
}

/** 原站 time 元素 → 文本。内容取载入时刻，格式 YYYY-MM-DD HH:mm */
function nowText(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 表格 → 外框 + 分隔条 + 单元格文本（全部为顶层普通对象，可各自编辑样式） */
function tableNodes(e: RawTable): TplNode[] {
  const x = tk2mm(e.x)
  const y = tk2mm(e.y)
  const w = tk2mm(e.width)
  const h = tk2mm(e.height)
  const cols = Math.max(1, Math.round(e.tableCols))
  const rows = Math.max(1, Math.round(e.tableRows))
  // 分隔条粗细：原站边框宽很小（1mm），设 0.2mm 下限防止细到看不见
  const line = Math.max(tk2mm(e.tableBorderWidth), 0.2)
  const fsPt = tk2pt(e.fontSize)
  const cw = w / cols
  const ch = h / rows
  const out: TplNode[] = []

  out.push({ kind: 'rect', xMm: x, yMm: y, wMm: w, hMm: h, strokeMm: line, filled: false })
  for (let c = 1; c < cols; c++) {
    out.push({ kind: 'rect', xMm: x + c * cw - line / 2, yMm: y, wMm: line, hMm: h, strokeMm: 0, filled: true })
  }
  for (let r = 1; r < rows; r++) {
    out.push({ kind: 'rect', xMm: x, yMm: y + r * ch - line / 2, wMm: w, hMm: line, strokeMm: 0, filled: true })
  }
  // 单元格：左侧内缩 1mm，垂直居中；首行视为表头加粗
  const pad = Math.min(1, cw * 0.2)
  const textH = tk2mm(e.fontSize) * 1.16
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const content = e.tableCellContents?.[r]?.[c]
      if (content == null || content === '') continue
      out.push({
        kind: 'text',
        xMm: x + c * cw + pad,
        yMm: y + r * ch + Math.max(0, (ch - textH) / 2),
        wMm: Math.max(cw - pad * 2, 2),
        text: String(content),
        fontSizePt: fsPt,
        bold: r === 0,
        align: 'left',
      })
    }
  }
  return out
}

/**
 * 把原站模板定义展开为可直接落画布的节点列表（mm / pt 口径）。
 * @param now 供 time 元素取「当前时间」，默认取调用时刻；测试可注入固定值
 */
export function buildTemplateSpec(tpl: LibTemplate, now: Date = new Date()): TemplateSpec {
  const nodes: TplNode[] = []
  for (const e of tpl.label.elements) {
    switch (e.type) {
      case 'text':
        nodes.push({
          kind: 'text',
          xMm: tk2mm(e.x),
          yMm: textTopMm(e.y, e.height, e.fontSize),
          wMm: tk2mm(e.width),
          text: e.content,
          fontSizePt: tk2pt(e.fontSize),
          bold: !!e.fontWeight,
          align: ALIGN[e.textAlign ?? 0] ?? 'left',
        })
        break
      case 'barcode': {
        const barType = toBarcodeType(e.barcodeType)
        nodes.push({
          kind: 'barcode',
          xMm: tk2mm(e.x),
          yMm: tk2mm(e.y),
          wMm: tk2mm(e.width),
          hMm: tk2mm(e.height),
          barcodeType: barType,
          // 零售码的示例数字末位校验位常常不合规（bwip-js 会拒绝渲染）→ 载入时补齐
          text: fixRetailCheckDigit(barType, e.content),
        })
        break
      }
      case 'qrcode':
        nodes.push({
          kind: 'barcode',
          xMm: tk2mm(e.x),
          yMm: tk2mm(e.y),
          wMm: tk2mm(e.width),
          hMm: tk2mm(e.height),
          barcodeType: 'qrcode',
          text: qrPayload(tpl),
        })
        break
      case 'shape':
        nodes.push({
          kind: 'rect',
          xMm: tk2mm(e.x),
          yMm: tk2mm(e.y),
          wMm: tk2mm(e.width),
          hMm: tk2mm(e.height),
          strokeMm: tk2mm(e.strokeWidth),
          // 原站 fillMode=1 → 实心块（用于横线/分隔条）
          filled: e.fillMode === 1,
        })
        break
      case 'table':
        nodes.push(...tableNodes(e))
        break
      case 'time':
        nodes.push({
          kind: 'text',
          xMm: tk2mm(e.x),
          yMm: textTopMm(e.y, e.height, e.fontSize),
          wMm: tk2mm(e.width),
          text: nowText(now),
          fontSizePt: tk2pt(e.fontSize),
          bold: false,
          align: 'left',
        })
        break
    }
  }
  return {
    name: tpl.name,
    categoryName: categoryNameOf(tpl.industry),
    widthMm: tk2mm(tpl.label.width),
    heightMm: tk2mm(tpl.label.height),
    nodes,
  }
}

/** 按 id 取模板 */
export const findTemplate = (id: string): LibTemplate | undefined =>
  TEMPLATE_LIBRARY.find((t) => t.id === id)
