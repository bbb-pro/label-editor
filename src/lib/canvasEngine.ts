// 画布引擎：封装 fabric 生命周期与对象操作，便于 React 以命令式调用
import { fabric } from 'fabric'
import { mmToPx, pxToMm, roundMm } from '@/lib/mm'
import {
  is2dType,
  defaultSettingsFor,
  DEFAULT_BARCODE_SETTINGS,
  type BarcodeType,
  type BarcodeRenderSettings,
} from '@/lib/barcode'
import { renderBarcodeVectorRects } from '@/lib/barcodeVector'
import { pxToPt, ptToPx } from '@/lib/textStyles'
import type { PaperArea, PaperSize, DataRow, ElementKind, ShapeType } from '@/types/template'
import { DEFAULT_PAPER } from '@/types/template'
import { resolveContent } from '@/lib/content'
import type { ActiveObject, TextFormatSnapshot, TextStyle, BarcodeAlign } from '@/types/editor'
import type { SerialSpec } from '@/types/editor'
import type { TemplateSpec, TplBarcodeNode } from '@/lib/templateLibrary'

export type ActiveObjectSnapshot = ActiveObject

export interface ControllerEvents {
  onActiveChange(snap: ActiveObjectSnapshot | null): void
  /** 多选/编组状态（count≥2 为多对象，isGroup=true 为单个编组整体，isBarcodeGroup=true 为单个条码组） */
  onSelection?(info: { count: number; isGroup: boolean; isBarcodeGroup: boolean }): void
  onDirty(): void
  /** 撤销/重做栈变化时通知（供 UI 更新按钮可用态） */
  onHistoryChange?(): void
}

/** fabric 对象之外的自定义字段（不通过 extends 继承避免泛型 set 冲突） */
interface CustomFields {
  id?: string
  /** 用户可读名称，用于跨对象引用与图层辨识 */
  _name?: string
  /** 是否被锁定（锁定后不可拖动/缩放/旋转，但仍可点选以便解锁） */
  _locked?: boolean
  kind?: ElementKind
  _barcodeRaw?: string
  _barcodeType?: BarcodeType
  _barcodeTargetMm?: number
  _barcodeSettings?: BarcodeRenderSettings
  /**
   * 上次构建条码时「未缩放」的条码条区几何（px）。
   * 人读文字字号变化只会改变 fullHeight（文字带），条区 barH 不变；
   * 用它做缩放换算基准，可保证调整字号时条码条尺寸恒定。
   * `inkW` = 条码**墨迹宽**（左右静区之内，真正有黑条的横向跨度）。
   * 静区默认 4px×2 且可调，`w` 是含静区的栅格宽 ⇒ 判断「文字会不会比条码还宽」
   * 必须用 inkW（静区调大时才不会误判为「还有余量」）。
   */
  _barcodeUnit?: { w: number; barH: number; inkW?: number }
  /**
   * 人读文字在画布上的「绝对视觉缩放」（已含 group scale 的效果）。
   * 拉伸条码时保持它恒定 → 文字不随拉伸变化；只有改「可读文字字号」时才变。
   */
  _barcodeTextScale?: number
  /**
   * 条区下沿到人读文字中心的额外距离(mm)。>0 把文字往下推、拉开与条区间隙；
   * <0 把文字上移靠近条区。默认 0。
   */
  _barcodeTextOffsetMm?: number
  /**
   * 条码「对齐 / 生长锚点」：内容变长让条码变宽时以哪一侧为基准扩展。
   * 靠左（默认，= 历史行为）= 左边缘不动向右长；居中 = 向两侧均分；靠右 = 右边缘不动向左长。
   * 实现就是条码组的 `originX`（`left` 的含义随它变），因此改内容 / 改码制 / 手动拖拽
   * 都遵守同一锚点。缺省（老模板）按 'left' 处理，行为与以前完全一致。
   */
  _barcodeAlign?: BarcodeAlign
  /**
   * 上次真正渲染条码时用的「指纹」（码制 + 解析后文案 + 设置 + 文字偏移）。
   * 仅运行期缓存，不参与序列化：refreshAllContent 每次都会遍历所有条码，
   * 若内容没变就跳过重建 —— 否则每次刷新都会把画布上每个条码整组重建一次
   * （几十个矩形 + 一次 bwip-js 编码），既慢，又会在条码嵌于组/多选时引发坐标错乱。
   */
  _barcodeRendered?: string
  originalText?: string
  /**
   * 段落文本（kind='text' 的子类型）：一个定宽、自动换行的多行区域文本框。
   * 拖左右控制点改宽度 → 文字按新边界重排；高度默认贴合文字内容。
   * 外观与普通文本完全一致（无默认底色/边框），需要时可在属性面板开「区域框」。
   */
  _textParagraph?: boolean
  /**
   * 字间距的「pt 口径」存档值。fabric 实际用 charSpacing(1/1000 em)，随字号变化；
   * 这里额外记住用户输入的 pt 值，改字号时按新字号重算 charSpacing，视觉字距才不变。
   */
  _letterSpacingPt?: number
  /** 形状子类型（kind === 'shape' 时生效） */
  _shapeType?: ShapeType
  /** 内容对象：纯文本前缀（显示在内容前） */
  _prefix?: string
  /** 内容对象：纯文本后缀（显示在内容后） */
  _suffix?: string
  /** 内容对象：序列化配置（批量打印时 {{seq}} 逐张递增） */
  _serial?: SerialSpec
  /** SVG 素材：viewBox，如 "0 0 24 24" 或 "0 0 36 36" */
  _svgViewBox?: string
  /** SVG 素材：内部片段（不含外层 <svg>），与 viewBox 一起可在导出时重绘为矢量 */
  _svgInner?: string
  /** SVG 素材：true=线稿（靠 stroke 上色，可改色）；false=彩图（如 emoji，保持原色） */
  _svgIsStroke?: boolean
  /** SVG 素材：当前线稿颜色（仅 _svgIsStroke 时有意义） */
  _svgColor?: string
  /** SVG 素材：线稿粗细（仅线稿时有意义） */
  _svgStrokeWidth?: number
}

const isBarcodeKind = (k: ElementKind | undefined): boolean => k === 'barcode'
const isContentKind = (k: ElementKind | undefined): boolean => k === 'text' || k === 'barcode'
/** 是否有描边粗细（闭合形状 + 直线） */
const isStrokeKind = (k: ElementKind | undefined): boolean => k === 'rect' || k === 'shape' || k === 'line'

/** 「原子编组」：虽是 fabric.Group 但必须整体作为叶子处理，不可穿透成子图形。
 *  - barcode：穿透后 refreshAllContent 遍历不到条码本身，数据源/序列化递增时不跟随；
 *  - svg：素材由多个 path 组成，矢量导出按整段 SVG 重绘，拆开会丢失结构。 */
const isAtomicGroupKind = (k: ElementKind | undefined): boolean => k === 'barcode' || k === 'svg'

/** 条码渲染指纹：这四项不变时，重建出的条码组一定与现有一致（可安全跳过重建） */
const barcodeSignature = (
  type: BarcodeType,
  text: string,
  settings: BarcodeRenderSettings,
  offsetMm: number,
): string => `${type}\u0001${text}\u0001${offsetMm}\u0001${JSON.stringify(settings)}`

/** 工作区在标签四周多留的边距(mm)。对象可拖出标签"暂存"到这里；仅标签内对象会打印。
 *  画布会在对象被拖近边缘时自动向外扩张（等效"无限画布"），此值为初始留白。
 *  默认给很大的留白，让画布一上来就"近似无限"，拖动到更远处仍会自动续扩。 */
const WORKSPACE_MARGIN_MM = 600
/** 对象中心距边缘小于该值(px)时触发画布扩张 */
const GROW_TRIGGER_PX = 120
/** 每次向外扩张的增量(mm) */
const GROW_STEP_MM = 100
/** 多标签：相邻两张纸之间的间距(mm) */
const PAPER_GAP_MM = 20
/** 工作区底色（标签纸之外的部分） */
const WORKSPACE_BG = '#e2e8f0'
/** 模板库落盘时文本统一使用的字体：与 addText 保持一致，
 *  纯拉丁内容在 PDF 里会被映射成内置字体（矢量、免内嵌），中文走内嵌子集。 */
const TEMPLATE_FONT = 'Arial'

/**
 * 含 CJK 的模板文本专用字体。
 *
 * 为什么不能统一用 Arial：Arial 没有中文字形，画布上会静默回退到系统默认中文字体
 * （Windows 上是宋体），而 PDF 侧 `pdfFontFor` 对「拉丁字体 + 中文内容」会内嵌
 * simhei 子集 → 预览是宋体、打印是黑体，且属性面板显示 Arial，三者互不相同。
 * 这里按内容选字体：含 CJK 用 SimHei（黑体，与 PDF 内嵌字体同源），
 * 纯拉丁仍用 Arial（PDF 走内置矢量字体），属性面板 → 画布 → 打印完全一致。
 */
const TEMPLATE_CJK_FONT = 'SimHei'

/** 是否含 CJK / 日文假名 / 谚文 / 全角标点（这些字形 Arial 都没有） */
const CJK_RE = /[\u2E80-\u9FFF\u3000-\u303F\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]/

/** 按内容挑模板字体（含 CJK → 黑体，否则 Arial） */
function templateFontFor(text: string): string {
  return CJK_RE.test(text) ? TEMPLATE_CJK_FONT : TEMPLATE_FONT
}

/** 取自定义字段读写器（类型断言，绕开 fabric 泛型 set） */
function cf(o: fabric.Object): fabric.Object & CustomFields {
  return o as fabric.Object & CustomFields
}

/**
 * 用 fabric 的真实字体度量量一段文本的「单行宽度」(px)。
 * 模板库用它判断原设计稿给的框宽是否会让文字折行 —— 折行会破坏版式，
 * 所以宁可把框放宽一点。用 fabric.Text 而不是 Textbox：前者构造时就会
 * 算出自然宽度（= 不折行所需的最小宽度），后者按给定宽度折行。
 */
function measureSingleLinePx(text: string, fontSizePx: number, bold: boolean, fontFamily = TEMPLATE_FONT): number {
  const probe = new fabric.Text(text, {
    fontSize: fontSizePx,
    fontFamily,
    fontWeight: bold ? 'bold' : 'normal',
  })
  return probe.width ?? 0
}

/**
 * 一张文本框在不越出纸张的前提下「最大可放宽到多宽」（设计框宽 left/boxW 为基准）。
 * 放宽时对齐锚点必须保持：左对齐只向右长、右对齐只向左长、居中两侧对称长。
 */
function availableBoxWidth(
  align: string,
  left: number,
  boxW: number,
  paperLeft: number,
  paperRight: number,
): number {
  if (align === 'right') return left + boxW - paperLeft
  if (align === 'center') {
    const c = left + boxW / 2
    return 2 * Math.min(c - paperLeft, paperRight - c)
  }
  return paperRight - left
}

/** 对象的「工作区绝对」包围盒（逻辑坐标，不含视口变换）。
 *
 *  ⚠️ 不能直接用 obj.getBoundingRect(true)：该值只对**顶层对象**等于绝对坐标。
 *  编组 / 多选（ActiveSelection）里的子对象保留的是「父容器内的局部坐标」，
 *  直接拿去和纸张范围比较必然误判为纸外，表现为：
 *    · 多选拖动 / 编组时整组误变 0.35 半透明（"怎么突然变灰了"）；
 *    · 编组内的条码被导出过滤掉（PDF 里凭空消失）。
 *  这里沿 group 链把父容器变换逐级左乘（外层在左），把子对象的包围盒还原到工作区坐标。 */
function absoluteBounds(obj: fabric.Object): { left: number; top: number; width: number; height: number } {
  const b = obj.getBoundingRect(true)
  let m: number[] | null = null
  let p: fabric.Object | undefined = obj.group
  while (p) {
    const pm = p.calcTransformMatrix()
    m = m ? fabric.util.multiplyTransformMatrices(pm, m) : pm
    p = p.group
  }
  if (!m) return b
  const pts: Array<[number, number]> = [
    [b.left, b.top],
    [b.left + b.width, b.top],
    [b.left + b.width, b.top + b.height],
    [b.left, b.top + b.height],
  ]
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of pts) {
    const nx = m[0] * x + m[2] * y + m[4]
    const ny = m[1] * x + m[3] * y + m[5]
    if (nx < minX) minX = nx
    if (nx > maxX) maxX = nx
    if (ny < minY) minY = ny
    if (ny > maxY) maxY = ny
  }
  return { left: minX, top: minY, width: maxX - minX, height: maxY - minY }
}

/** 人类可读的对象类型名 */
function kindLabel(k: ElementKind): string {
  switch (k) {
    case 'text':
      return '文本'
    case 'barcode':
      return '条码'
    case 'rect':
      return '矩形'
    case 'line':
      return '直线'
    case 'shape':
      return '形状'
    case 'image':
      return '图片'
    case 'svg':
      return '素材'
  }
}

const nameCounters = new Map<string, number>()
function defaultName(kind: ElementKind): string {
  const base = kindLabel(kind)
  const n = (nameCounters.get(base) ?? 0) + 1
  nameCounters.set(base, n)
  return `${base}${n}`
}

const SHAPE_BASE: Record<ShapeType, string> = {
  ellipse: '椭圆',
  triangle: '三角形',
  diamond: '菱形',
  star: '五角星',
}

/** 段落文本默认宽度（mm）：比普通文本框宽，开箱即可承载多行内容 */
const PARAGRAPH_WIDTH_MM = 60
/** 段落文本占位文案（三行，直观展示自动换行效果） */
const PARAGRAPH_PLACEHOLDER = '段落文本示例\n拖左右控制点调整宽度，文字会自动换行'
/**
 * 文本「区域框」的默认配色（属性面板开启边框/底色时使用）。
 * 它只是画布上的排版参考，导出/打印前会被剥离（见 toPaperDataUrl），
 * 用户若手动改成别的颜色即视为有意输出，会原样保留。
 */
const REGION_DEFAULT = { stroke: '#444444', backgroundColor: '#f1f5f9' } as const

/** 字间距（pt）→ fabric charSpacing（千分之一 em）；字号为 0 时退回 0 */
function ptToCharSpacing(letterSpacingPt: number, fontSizePx: number): number {
  const fsPt = pxToPt(fontSizePx)
  if (!(fsPt > 0)) return 0
  return Math.round((letterSpacingPt / fsPt) * 1000 * 1000) / 1000
}

/** fabric charSpacing → 字间距（pt），用于属性面板回显 */
function charSpacingToPt(charSpacing: number | undefined, fontSizePx: number): number {
  if (!charSpacing) return 0
  return pxToPt((fontSizePx * charSpacing) / 1000)
}

/** 形状的友好默认名：椭圆1 / 五角星1 …（独立计数） */
function shapeBaseName(type: ShapeType): string {
  const base = SHAPE_BASE[type]
  const n = (nameCounters.get(base) ?? 0) + 1
  nameCounters.set(base, n)
  return `${base}${n}`
}

/** 生成五角星顶点：外接在 w×h 盒内，内凹半径 0.5× 外径 */
function starPolyPoints(w: number, h: number): Array<{ x: number; y: number }> {
  const cx = w / 2
  const cy = h / 2
  const outerR = Math.min(w, h) / 2
  const innerR = outerR * 0.5
  const pts: Array<{ x: number; y: number }> = []
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outerR : innerR
    const a = (Math.PI / 5) * i - Math.PI / 2
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
  }
  return pts
}

let uidSeq = 1
function newId(): string {
  return `obj_${Date.now().toString(36)}_${uidSeq++}`
}

/** 保留的序列号变量名：内容里写 {{seq}}（展示用别名「序号」） */
const SERIAL_TOKEN = /\{\{\s*seq\s*\}\}/gi
/** 仅用于“是否含 seq”的检测（非 global，避免 lastIndex 状态污染） */
const SERIAL_PROBE = /\{\{\s*seq\s*\}\}/i
/** 当画布上未运行批量打印时，{{seq}} 用一个示例值预览 */
export const DEFAULT_SEQ_LABEL = '1'

/** 按补零位数格式化序号（超出位数时自动扩展，不截断） */
export function formatSeq(value: number, minDigits: number): string {
  return String(value).padStart(Math.max(1, minDigits), '0')
}

export class CanvasController {
  canvas: fabric.Canvas
  private events: ControllerEvents
  /**
   * 工作区内的多张标签纸（多标签编辑：同一个文件里并排做几种标签）。
   * 单纸时 papers 只有一项，行为与历史版本完全一致。
   */
  papers: PaperArea[] = []
  private activePaperIdValue = ''
  /** 每张纸对应的「纸卡」背景矩形（渲染产物，不入模板） */
  private paperRects = new Map<string, fabric.Rect>()
  private workspaceW = 0
  private workspaceH = 0

  // ── 当前活动纸的便捷读取 ──
  // 这些 getter 让历史上「唯一纸张」的所有引用（插入居中/吸附/纸卡/导出裁剪）
  // 自动变成「对当前活动纸生效」，多纸改造无需逐处重写。
  private get activePaper(): PaperArea {
    return this.papers.find((p) => p.id === this.activePaperIdValue) ?? this.papers[0]
  }
  private get paperPxW(): number {
    return mmToPx(this.activePaper.widthMm)
  }
  private get paperPxH(): number {
    return mmToPx(this.activePaper.heightMm)
  }
  /** 活动纸左上角在工作区中的像素坐标（对象坐标减它 = 相对纸张原点） */
  private get paperOffsetX(): number {
    return this.activePaper.left
  }
  private get paperOffsetY(): number {
    return this.activePaper.top
  }
  private get paperRect(): fabric.Rect | null {
    return this.paperRects.get(this.activePaper.id) ?? null
  }
  /** 临时屏蔽 object:added/removed 的 onDirty 回调（构造期间/纸卡重建时） */
  private _suppressDirty = false
  previewRow: DataRow | null = null
  /** 已导入表格的表头（用于「文本框名称 = 表头」的自动列绑定） */
  headers: string[] = []
  /** 已导入表格的数据行 */
  dataRows: DataRow[] = []
  /** 批量打印当前副本的序列号显示值；null 表示用示例值预览 */
  seqValue: string | null = null
  /**
   * 批量打印当前页码(0 起)；null = 设计态。
   * 有值时每个序列化对象按**自己的** start/step/minDigits 计算序号，
   * 这样多张标签纸可以各自定义起始值（如纸1 从 1、纸2 从 100），互不串号。
   */
  seqIndex: number | null = null
  /** 撤销栈：每次编辑前 push 的画布 JSON（canvas.toJSON()） */
  private undoStack: Array<Record<string, unknown>> = []
  /**
   * 重做栈：undo 时被撤销的「当前状态」压入此处。
   * 任何新的编辑都会清空它 —— 一旦产生新分支，旧的重做路径就不再有效。
   */
  private redoStack: Array<Record<string, unknown>> = []
  /**
   * 拖拽/缩放/旋转开始（mouse:down）时采集的「操作前」快照。
   * object:modified 触发时若存在该快照则入撤销栈 —— 保证撤销回到操作前，
   * 且「点一下没拖动」不会污染历史。
   */
  private _pendingHistory: Record<string, unknown> | null = null
  /** 剪贴板：复制出的对象 JSON 列表 */
  private clipboard: Array<Record<string, unknown>> = []
  /** 内容连续输入的 coalesce 标识（同一对象同一编辑会话只入一次栈） */
  private _typingSeen = false
  /** 正在画布上原地编辑的文本对象（用于编辑退出时同步回原文） */
  private _inlineEditTarget: fabric.Object | null = null
  /** 进入编辑瞬间文本框显示内容（判断用户是否真的改动，避免误触破坏动态字段） */
  private _inlineStartText = ''

  /** 视口变换:z 缩放 + 屏幕平移(px)。替代 CSS transform 实现矢量重绘缩放,放大不再糊 */
  private vptZoom = 1
  private vptPan = { x: 0, y: 0 }
  /** 视口(可见区域)像素尺寸,由 App 在 mount/resize 时设置 */
  private viewW = 800
  private viewH = 600

  constructor(canvasEl: HTMLCanvasElement, paper: PaperSize, events: ControllerEvents) {
    this.events = events
    // 工作区外圈：四周多出 WORKSPACE_MARGIN_MM 像素，让对象可以"暂存"到标签外
    const first = this.makePaper(
      '标签 1',
      paper,
      mmToPx(WORKSPACE_MARGIN_MM),
      mmToPx(WORKSPACE_MARGIN_MM),
    )
    this.papers = [first]
    this.activePaperIdValue = first.id
    this.resizeWorkspace()

    this.canvas = new fabric.Canvas(canvasEl, {
      // 初始占位尺寸;App 在 mount 后调 setViewportSize 把 canvas 设为视口大小。
      // 缩放/平移改用 fabric 原生 viewportTransform(矢量重绘),不再用 CSS transform 拉伸位图。
      width: 800,
      height: 600,
      backgroundColor: '#ffffff',
      selectionColor: 'rgba(59,130,246,0.15)',
      selectionBorderColor: '#3b82f6',
      selectionLineWidth: 1.2,
      preserveObjectStacking: true,
      enableRetinaScaling: true,
    })
    // 画布背景 = 标签外的工作区底色；标签"纸卡"用一张白底矩形覆盖在中心
    this.canvas.backgroundColor = '#e2e8f0'

    this.canvas.on('selection:created', (opt) => {
      this.resetEdit()
      const t = (opt as unknown as { selected?: fabric.Object[]; target?: fabric.Object }).selected?.[0] ?? (opt as unknown as { target?: fabric.Object }).target ?? null
      this.emitActive(t ?? null)
    })
    this.canvas.on('selection:updated', (opt) => {
      this.resetEdit()
      const t = (opt as unknown as { selected?: fabric.Object[]; target?: fabric.Object }).selected?.[0] ?? (opt as unknown as { target?: fabric.Object }).target ?? null
      this.emitActive(t ?? null)
    })
    this.canvas.on('selection:cleared', () => {
      this.resetEdit()
      this.clearGuides()
      this.events.onActiveChange(null)
      this.events.onSelection?.({ count: 0, isGroup: false, isBarcodeGroup: false })
    })
    // 双击编组 → 解组（编辑体验贴近 PS/AI）；条码组 / 素材组是原子对象，不解组
    this.canvas.on('mouse:dblclick', (opt) => {
      const t = opt.target
      if (t && this.isGroup(t) && !isAtomicGroupKind(cf(t).kind)) this.ungroupSelection()
    })
    this.canvas.on('object:moving', (e) => {
      this.emitActiveThrottled()
      const t = (e as { target?: fabric.Object }).target ?? null
      this.updateOutsidePaperVisual(t)
      // 拖到边缘时画布自动向外扩张（无限画布）
      if (t) this.autoGrowForObject(t)
      this.applySnap(t)
    })
    this.canvas.on('object:scaling', (e) => {
      this.emitActiveThrottled()
      const t = (e as { target?: fabric.Object }).target ?? null
      // 文本框：拖角/拖边只改“盒宽”，字号恒定、文字自动重排（不拉伸文字）
      if (t instanceof fabric.Textbox) this.resizeTextboxBox(t)
      // 条码：拉伸只作用于条码条，抵消非等比部分，避免人读文字被拉变形。
      // 编组 / 多选（ActiveSelection）被缩放时，t 是父容器 —— 必须把里面的条码也刷一遍，
      // 文字才不会跟着组一起变大变小。
      else if (t) this.eachBarcode(t, (b) => this.applyBarcodeTextCompensation(b))
      this.updateOutsidePaperVisual(t)
      this.applySnap(t)
    })
    this.canvas.on('object:rotating', () => this.emitActiveThrottled())
    // ⚠️ 交互前的快照：拖动/缩放/旋转必须记录「操作之前」的状态，否则撤销等于回到原位。
    // mouse:down 时若命中了对象，先暂存一份快照（pending），待 object:modified 确认确有变换后再入栈。
    // 这样「点一下就松手」（无变换）不会污染历史栈，而真正的拖动可被 Ctrl+Z 还原。
    this.canvas.on('mouse:down', (opt) => {
      const t = (opt as { target?: fabric.Object }).target
      if (!t || cf(t).excludeFromExport) {
        this._pendingHistory = null
        return
      }
      this._pendingHistory = this.snapshot()
    })
    this.canvas.on('object:modified', () => {
      this.clearGuides()
      // 拖出/拖回后立即刷一次透明度视觉（编组/多选内也按最外层对象评估）
      this.refreshOutsidePaperAll()
      // 变换收尾：把画布上所有条码的人读文字再刷一遍。
      // 多选/编组缩放期间文字已按「父容器实时 scale」抵消过，而 fabric 在收尾时可能把父容器的
      // scale 结算进子对象 —— 累乘后的总量不变，这里再刷一次即可保证收尾后依然精确。
      for (const o of this.flattenTopLevel()) {
        if (isBarcodeKind(cf(o).kind)) this.applyBarcodeTextCompensation(o)
      }
      this.emitActive()
      // 提交「拖动前」的快照（在 mouse:down 时采集）—— 必须压入旧状态，撤销才会回到操作前。
      // 直接在 modified 里 pushHistory 会把「已变换后」的状态压栈，撤销看似生效实则原地不动。
      if (this._pendingHistory) {
        this._commitHistory(this._pendingHistory)
        this._pendingHistory = null
      }
      this.events.onDirty()
    })
    // 画布原地编辑文字 → 退出编辑时同步回原文，避免“面板/保存/刷新内容不一致”。
    // 注意：fabric 在 canvas 上派发的是 text:editing:entered / text:editing:exited，
    // 而非 editing:entered / editing:exited（后者是对象自身事件）。绑定错会导致回调从不触发。
    this.canvas.on('text:editing:entered', (e) => {
      const t = (e as { target?: fabric.Object }).target ?? null
      this._inlineEditTarget = t
      this._inlineStartText = (t as fabric.IText | null)?.text ?? ''
    })
    this.canvas.on('text:editing:exited', () => this.syncInlineTextEdit())
    this.canvas.on('object:added', () => { if (!this._suppressDirty) this.events.onDirty() })
    this.canvas.on('object:removed', () => { if (!this._suppressDirty) this.events.onDirty() })
    // 标签"纸卡"背景矩形 + 默认工作区底色
    this.canvas.backgroundColor = '#e2e8f0'
    this.recreatePaperRects()
  }

  // ── 异步渲染追踪 ─────────────────────────────────────────
  /**
   * 历史遗留字段：早期条码是位图（setSrc 异步），需要 markPending/markDone 追踪
   * 批量重绘落地后再截图。现条码改为矢量矩形组（同步替换），已不再调用这两个方法，
   * 仅保留 _pending/_waiters 计数供 whenIdle 兼容（始终为 0，立即 resolve）。
   */
  private _pending = 0
  private _waiters: Array<() => void> = []
  /** 导出/批量打印期间的临时只读标记（见 setReadOnly） */
  private _readOnly = false

  /** 等待一帧（让 fabric 的 requestRenderAll 真正把状态画到 canvas 元素） */
  private nextRenderFrame(): Promise<void> {
    return new Promise<void>((resolve) => {
      // 双 rAF：第一帧执行 fabric 调度的渲染，第二帧兜底确保稳定
      let left = 2
      const tick = () => {
        if (--left <= 0) resolve()
        else requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  }

  /**
   * 同步把当前对象状态强制绘制到 canvas 元素。绕开 fabric renderOnDemand 的
   * 异步 rAF 调度，确保紧接着的 toDataURL 一定拿到最新画面。
   */
  flushRender() {
    try {
      this.canvas.renderAll()
    } catch {
      // 极端兜底：若 renderAll 抛错（极少见），退化为 requestRenderAll
      this.canvas.requestRenderAll()
    }
  }

  /**
   * 等待「所有挂起的条码重绘完成」+「fabric 已把当前状态绘制到 canvas 元素」。
   * 现条码为矢量矩形组（同步替换），_pending 恒为 0，pending 段会立即 resolve；
   * 随后同步 renderAll 再等一帧兜底，确保随后同步 canvasToHighResDataUrl 截图
   * 不会拿到旧帧/空白。含超时兜底。
   */
  whenIdle(timeoutMs = 3000): Promise<void> {
    const pendingDone = new Promise<void>((resolve) => {
      if (this._pending === 0) return resolve()
      const timer = setTimeout(() => {
        const i = this._waiters.indexOf(done)
        if (i >= 0) this._waiters.splice(i, 1)
        resolve()
      }, timeoutMs)
      const done = () => {
        clearTimeout(timer)
        resolve()
      }
      this._waiters.push(done)
    })
    return pendingDone.then(() => {
      // 关键：pending 清空后立即同步渲染，绕开 fabric 的 rAF 异步调度
      this.flushRender()
      return this.nextRenderFrame()
    })
  }

  // ── 吸附（拖动/缩放时对齐纸张边/中线 + 其它对象边/中线） ───
  private _snapEnabled = true
  /** 吸附阈值（纸面像素，约 1.5mm） */
  private _snapTol = 6
  /** 当前显示中的吸附参考线（fabric.Line），用于随移动/缩放刷新 */
  private _guides: fabric.Line[] = []

  getSnapEnabled(): boolean {
    return this._snapEnabled
  }
  setSnapEnabled(on: boolean) {
    this._snapEnabled = on
    if (!on) this.clearGuides()
  }

  private clearGuides() {
    if (this._guides.length === 0) return
    for (const g of this._guides) this.canvas.remove(g)
    this._guides = []
  }

  /** 在 (x,y 坐标，画一条贯穿整张纸的参考线；横向或纵向由 x1=x2 或 y1=y2 决定 */
  private addGuide(x1: number, y1: number, x2: number, y2: number) {
    const line = new fabric.Line([x1, y1, x2, y2], {
      stroke: '#ec4899',
      strokeWidth: 1,
      selectable: false,
      evented: false,
      excludeFromExport: true,
      opacity: 0.85,
    })
    this.canvas.add(line)
    // 置于底层
    this.canvas.sendToBack(line)
    this._guides.push(line)
  }

  /** 取候选吸附线（X/Y 轴各一组）。`self` 为当前移动对象（需排除自身）。 */
  private collectCandidates(self: fabric.Object | fabric.ActiveSelection) {
    const left = this.paperOffsetX
    const top = this.paperOffsetY
    const right = left + this.paperPxW
    const bottom = top + this.paperPxH
    const cx = left + this.paperPxW / 2
    const cy = top + this.paperPxH / 2
    const paperX = [left, right, cx]
    const paperY = [top, bottom, cy]
    const objX: number[] = []
    const objY: number[] = []
    for (const o of this.flattenTopLevel()) {
      if (o === self) continue
      // 排除 self 内部的子对象（active selection / group 嵌套）
      if ((self as fabric.Object).type === 'activeSelection' || (self as fabric.Object).type === 'group') {
        // 简化：若 activeSelection 包含 o，则跳过
        const selObjs = (self as { getObjects?: () => fabric.Object[] }).getObjects?.()
        if (selObjs && selObjs.includes(o)) continue
      }
      const r = o.getBoundingRect(true)
      objX.push(r.left, r.left + r.width, r.left + r.width / 2)
      objY.push(r.top, r.top + r.height, r.top + r.height / 2)
    }
    return { x: [...paperX, ...objX], y: [...paperY, ...objY] }
  }

  /** 在 moving/scaling 期间调：根据当前对象几何找最近候选线，吸附并刷新参考线 */
  private applySnap(target: fabric.Object | fabric.ActiveSelection | null) {
    if (!this._snapEnabled || !target) return
    const rect = (target as fabric.Object).getBoundingRect(true)
    const cands = this.collectCandidates(target)
    const tol = this._snapTol
    const xVals = [rect.left, rect.left + rect.width / 2, rect.left + rect.width]
    const yVals = [rect.top, rect.top + rect.height / 2, rect.top + rect.height]
    // 找最近的 X 候选线（纸 + 其它对象）
    let bestDx = 0
    let bestDxAbs = Infinity
    let bestXLine: number | null = null
    for (const xv of xVals) {
      for (const cx of cands.x) {
        const d = cx - xv
        const ad = Math.abs(d)
        if (ad <= tol && ad < bestDxAbs) {
          bestDxAbs = ad
          bestDx = d
          bestXLine = cx
        }
      }
    }
    let bestDy = 0
    let bestDyAbs = Infinity
    let bestYLine: number | null = null
    for (const yv of yVals) {
      for (const cy of cands.y) {
        const d = cy - yv
        const ad = Math.abs(d)
        if (ad <= tol && ad < bestDyAbs) {
          bestDyAbs = ad
          bestDy = d
          bestYLine = cy
        }
      }
    }
    if (bestDx !== 0 || bestDy !== 0) {
      // 对 activeSelection 整体平移：对每个子对象偏移
      const sel = target as { type?: string; getObjects?: () => fabric.Object[] }
      if (sel.type === 'activeSelection' && sel.getObjects) {
        for (const o of sel.getObjects()) {
          o.set({ left: (o.left ?? 0) + bestDx, top: (o.top ?? 0) + bestDy })
          o.setCoords()
        }
      } else {
        const o = target as fabric.Object
        o.set({ left: (o.left ?? 0) + bestDx, top: (o.top ?? 0) + bestDy })
        o.setCoords()
      }
    }
    // 画参考线（清旧 → 画新）
    this.clearGuides()
    if (bestXLine !== null) this.addGuide(bestXLine, 0, bestXLine, this.paperPxH)
    if (bestYLine !== null) this.addGuide(0, bestYLine, this.paperPxW, bestYLine)
  }

  /**
   * 文本框被拖角/拖边缩放时：把 fabric 施加的 scaleX/scaleY 折算回真实的“盒宽高”，
   * 并把 scaleX/scaleY 复位为 1。这样字号恒定、文字只重排不拉伸，上下/左右拉伸
   * 都只改变文本框尺寸，不变字体大小。
   */
  private resizeTextboxBox(tb: fabric.Textbox) {
    const sx = tb.scaleX ?? 1
    const sy = tb.scaleY ?? 1
    const changedX = Math.abs(sx - 1) >= 0.001
    const changedY = Math.abs(sy - 1) >= 0.001
    // 拖左右边由 changeWidth 原生改 width（scaleX≈1）；仅当确有缩放时才折算
    if (!changedX && !changedY) return

    const minW = (tb.minWidth ?? 20) || 20
    const newW = changedX ? (tb.width ?? 0) * sx : tb.width ?? 0
    const newH = changedY ? (tb.height ?? 0) * sy : tb.height ?? 0

    if (changedX && newW < minW) {
      // 缩得太小：不折算，保持原尺寸并把缩放拉回（避免文本框塌成不可用）
      tb.set({ scaleX: 1, scaleY: 1 })
      tb.setCoords()
      return
    }

    // 段落文本：高度默认贴合文字 —— 上下拖可留白但不能压得比内容矮；
    // 拖四角（宽高同时变）时只认宽度，高度交给文字重新排版后自动撑开。
    const isParagraph = !!cf(tb)._textParagraph
    const updates: Record<string, number> = { scaleX: 1, scaleY: 1 }
    if (changedX) updates.width = Math.max(minW, newW)
    if (changedY && !(isParagraph && changedX)) {
      updates.height = Math.max(isParagraph ? tb.height ?? 0 : 10, newH)
    }
    tb.set(updates)
    tb.setCoords()
    this.events.onDirty?.()
  }

  // ── 内部工具 ──────────────────────────────────────────────
  private _raf: number | null = null
  private emitActiveThrottled() {
    if (this._raf) return
    this._raf = requestAnimationFrame(() => {
      this._raf = null
      this.emitActive()
    })
  }

  private getActiveObject(): fabric.Object | null {
    return this.canvas.getActiveObject()
  }

  /** 是否为编组容器（真实 Group；ActiveSelection 是临时交互对象，不在此列） */
  private isGroup(o: fabric.Object | null | undefined): o is fabric.Group {
    return !!o && (o as fabric.Object).type === 'group'
  }

  /** 递归取回所有“顶层可编辑元素”（组内子对象展开返回），供遍历/刷新/收集使用 */
  private flattenTopLevel(): fabric.Object[] {
    const out: fabric.Object[] = []
    const walk = (list: fabric.Object[]) => {
      for (const o of list) {
        // 条码 / SVG 素材虽是 fabric.Group，但都是「原子对象」，必须整体作为叶子返回。
        // 若被穿透成子矩形/子路径：条码会失去 refresh 链路导致不跟随数据源；
        // SVG 素材会被拆成不受支持的子 path，矢量导出直接丢失内容。
        if (this.isGroup(o) && !isAtomicGroupKind(cf(o).kind)) {
          walk((o as fabric.Group).getObjects())
        } else {
          out.push(o)
        }
      }
    }
    walk(this.canvas.getObjects())
    return out
  }

  /** 画布上当前生效的编组（顶层真实 Group）列表 */
  getGroups(): fabric.Group[] {
    return this.canvas.getObjects().filter((o) => this.isGroup(o)) as fabric.Group[]
  }

  /**
   * 取当前多选中的顶层元素：既可能是单对象/多对象（ActiveSelection），
   * 也可能是单个编组（选中组时返回该组）。
   * 返回 { targets: 顶层对象列表, count } —— count 仅统计顶层（组计为 1 个整体）。
   */
  private getSelectionTargets(): { targets: fabric.Object[]; kind: 'none' | 'objects' | 'group' } {
    const sel = this.canvas.getActiveObject()
    if (!sel) return { targets: [], kind: 'none' }
    if (this.isGroup(sel)) return { targets: [sel], kind: 'group' }
    const obj = sel as unknown as { getObjects?: () => fabric.Object[] }
    if (typeof obj.getObjects === 'function' && (obj.getObjects() ?? []).length > 0) {
      return { targets: obj.getObjects(), kind: 'objects' }
    }
    return { targets: [sel as fabric.Object], kind: 'objects' }
  }

  /** 当前多选中命中的顶层对象数（单选=1；编组=1；多对象=N） */
  getSelectionCount(): number {
    return this.getSelectionTargets().targets.length
  }

  /** 是否选中了≥2 个对象（可编组） */
  canGroupSelection(): boolean {
    return this.getSelectionTargets().kind === 'objects' && this.getSelectionTargets().targets.length >= 2
  }

  /** 当前选中的是否单个编组（可解组） */
  isActiveGroup(): boolean {
    return this.getSelectionTargets().kind === 'group'
  }

  /** 编组：把当前多选合并为一个 fabric.Group（保留子对象自定义字段，undo/load 往返不丢） */
  groupSelection(): boolean {
    const sel = this.canvas.getActiveObject()
    // fabric 多选时 active 是 ActiveSelection（有 toGroup）；单个普通对象则不能编组
    const activeSel = sel as unknown as { toGroup?: () => fabric.Group; getObjects?: () => fabric.Object[] }
    const isMulti = !!activeSel && typeof activeSel.toGroup === 'function' && (activeSel.getObjects?.().length ?? 0) >= 2
    if (!isMulti) return false
    this.pushHistory()
    try {
      const group = activeSel.toGroup!()
      // fabric 会把「选择容器」自身的 opacity 搬到新组上，而子对象各自还留着自己那份
      // （多选于纸外时是 0.35）→ 两者叠乘 ≈0.12，暗得不像话。统一约定：
      // 子对象一律 1，由「最外层对象」单独承担纸外半透明（随后 refreshOutsidePaperAll 定值）。
      group.set({ opacity: 1 })
      group.getObjects?.().forEach((o) => o.set({ opacity: 1 }))
      // 补打序列化，确保组对象自身 toJSON 携带子对象字段（children 各自已有 patch）
      ;(group as unknown as Record<string, unknown>).isGroupBox = true
      this.canvas.setActiveObject(group)
      this.refreshOutsidePaperAll()
      this.canvas.requestRenderAll()
      this.emitActive()
      this.events.onDirty()
      return true
    } catch {
      return false
    }
  }

  /** 解组：把单个编组拆回独立对象（保留各自自定义字段与内容功能），并把它们作为多选选中 */
  ungroupSelection(): boolean {
    const { kind, targets } = this.getSelectionTargets()
    if (kind !== 'group' || targets.length !== 1) return false
    const group = targets[0] as fabric.Group
    if (cf(group).kind === 'barcode') return false
    this.pushHistory()
    try {
      // fabric 官方把 group 拆回 = toActiveSelection()：子对象重新加回画布顶层并转为 ActiveSelection
      const activeSel = group.toActiveSelection() as fabric.ActiveSelection
      this.canvas.setActiveObject(activeSel)
      // 多选容器不是要打印的对象，自身不承担透明度；让每个子对象各自评估
      activeSel.set({ opacity: 1 })
      activeSel.getObjects().forEach((o) => o.set({ opacity: 1 }))
      this.canvas.requestRenderAll()
      this.refreshAllContent()
      // ⚠️ 必须在 refreshAllContent **之后**再按纸外定值：内容刷新（如条码重建）
      // 会产出 opacity=1 的新对象，顺序反了就会被覆盖回「标签内」的纯黑。
      this.refreshOutsidePaperAll()
      this.emitActive()
      this.events.onDirty()
      return true
    } catch {
      // 兜底：若 toActiveSelection 抛错则退化为 destroy + 手动加回
      const items = group.getObjects()
      try {
        group.destroy()
        items.forEach((o) => this.canvas.add(o))
      } catch {
        /* noop */
      }
      this.canvas.discardActiveObject()
      this.canvas.requestRenderAll()
      this.refreshAllContent()
      this.refreshOutsidePaperAll()
      this.emitActive()
      this.events.onDirty()
      return true
    }
  }

  /**
   * 图层操作：front=置于顶层 / back=置于底层 / up=上移一层 / down=下移一层。
   * 作用于当前选中的顶层对象（单对象 / 编组整体 / 多选容器均按整体移动）。
   * 关键不变量：纸卡(paperRect)始终留在最底层 —— back 只把对象沉到纸卡“之上”，
   * down 到纸卡之上即到底，不会把对象压到纸卡之下（否则打印时纸卡会盖住内容）。
   */
  layer(action: 'front' | 'back' | 'up' | 'down'): boolean {
    const obj = this.canvas.getActiveObject() as fabric.Object | null
    if (!obj) return false
    this.pushHistory()
    const objs = this.canvas.getObjects()
    const paperIdx = this.paperRect ? objs.indexOf(this.paperRect) : -1
    const cur = objs.indexOf(obj)
    if (cur < 0) {
      this.events.onDirty()
      return false
    }
    switch (action) {
      case 'front':
        this.canvas.bringToFront(obj)
        break
      case 'back':
        // 沉到纸卡之上（索引 = paperIdx+1），绝不低于纸卡
        this.canvas.moveTo(obj, paperIdx >= 0 ? paperIdx + 1 : 0)
        break
      case 'up':
        this.canvas.bringForward(obj)
        break
      case 'down':
        // 已处于“纸卡之上”这一层时不再下沉，避免压到纸卡下面
        if (paperIdx >= 0 && cur <= paperIdx + 1) {
          this.events.onDirty()
          return false
        }
        this.canvas.sendBackwards(obj)
        break
    }
    this.canvas.requestRenderAll()
    this.events.onDirty()
    return true
  }

  /** 对齐当前多选（含单个编组整体）到其外接包围盒的某一边/中心 */
  alignSelection(align: 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom'): boolean {
    const { targets } = this.getSelectionTargets()
    if (targets.length < 1) return false
    this.pushHistory()
    // 外接包围盒（考虑旋转的 aCoords 不够，用 getBoundingRect 更准）
    const rects = targets.map((o) => o.getBoundingRect(true))
    const minL = Math.min(...rects.map((r) => r.left))
    const minT = Math.min(...rects.map((r) => r.top))
    const maxR = Math.max(...rects.map((r) => r.left + r.width))
    const maxB = Math.max(...rects.map((r) => r.top + r.height))
    const cX = (minL + maxR) / 2
    const cY = (minT + maxB) / 2
    targets.forEach((o) => {
      const b = o.getBoundingRect(true)
      let dx = 0
      let dy = 0
      // 目标：把 o 的包围盒移动到对齐位；dx = 目标边 - o 当前边
      if (align === 'left') dx = minL - b.left
      else if (align === 'right') dx = maxR - (b.left + b.width)
      else if (align === 'hcenter') dx = cX - (b.left + b.width / 2)
      else if (align === 'top') dy = minT - b.top
      else if (align === 'bottom') dy = maxB - (b.top + b.height)
      else if (align === 'vcenter') dy = cY - (b.top + b.height / 2)
      if (dx !== 0 || dy !== 0) {
        // 仅在无旋转对象上用 left/top 精确对齐；含旋转对象时其包围盒偏移复杂，简化为平移包围盒中心
        if (Math.abs(o.angle ?? 0) < 0.5) {
          o.set({ left: (o.left ?? 0) + dx, top: (o.top ?? 0) + dy })
        } else {
          const center = o.getCenterPoint()
          o.setPositionByOrigin(
            new fabric.Point(center.x + dx, center.y + dy),
            'center',
            'center',
          )
        }
        o.setCoords()
      }
    })
    // 保留当前选择，便于连续使用多个对齐方向
    this.canvas.requestRenderAll()
    this.events.onDirty()
    return true
  }

  /**
   * 平均分布（等间距）：保持最外侧两个对象不动，把中间对象挪到"空隙相等"的位置。
   *
   * 与对齐的区别：对齐是按"边/中线"归位，分布是按"间隙"均分。
   * 间隙 = (整体跨度 − 所有对象总尺寸) ÷ (对象数 − 1)，
   * 对象有重叠时该值为负，仍按等重叠量均分（与设计软件行为一致）。
   *
   * @param axis 'h' 水平等间距 / 'v' 垂直等间距
   * @returns 是否执行。需 ≥3 个独立对象 —— 2 个对象的间距由位置唯一确定，无需分布；
   *          编组整体视为一个整体，内部子对象不参与分布。
   */
  distributeSelection(axis: 'h' | 'v'): boolean {
    const { targets, kind } = this.getSelectionTargets()
    if (kind !== 'objects' || targets.length < 3) return false
    this.pushHistory()
    const startKey = axis === 'h' ? 'left' : 'top'
    const sizeKey = axis === 'h' ? 'width' : 'height'
    // 沿分布方向按起始边排序：首、末两个对象保持原位，只挪中间
    const order = targets
      .map((o) => ({ o, r: o.getBoundingRect(true) }))
      .sort((a, b) => a.r[startKey] - b.r[startKey])
    const spanStart = order[0].r[startKey]
    const spanEnd = order[order.length - 1].r[startKey] + order[order.length - 1].r[sizeKey]
    const totalSize = order.reduce((s, it) => s + it.r[sizeKey], 0)
    const gap = (spanEnd - spanStart - totalSize) / (order.length - 1)

    let cursor = spanStart
    for (const it of order) {
      const delta = cursor - it.r[startKey]
      if (delta !== 0) {
        const o = it.o
        if (Math.abs(o.angle ?? 0) < 0.5) {
          // 无旋转：直接改 left/top 最精确
          if (axis === 'h') o.set({ left: (o.left ?? 0) + delta })
          else o.set({ top: (o.top ?? 0) + delta })
        } else {
          const c = o.getCenterPoint()
          o.setPositionByOrigin(
            new fabric.Point(axis === 'h' ? c.x + delta : c.x, axis === 'h' ? c.y : c.y + delta),
            'center',
            'center',
          )
        }
        o.setCoords()
      }
      cursor += it.r[sizeKey] + gap
    }
    this.canvas.requestRenderAll()
    this.events.onDirty()
    return true
  }

  /** 刷新画布上所有内容对象（递归含组内），用于变量/序列号切换后重绘 */
  refreshAllContent() {
    const objs = this.flattenTopLevel()
    // ⚠️ 原实现逐对象调用 displayContent → 每次都全量 buildContentMap（遍历全部对象），
    // 整体退化为 O(n²)。这里按「纸张」预构建一次 contentMap 供同纸对象复用。
    const mapCache = new Map<string, Map<string, string>>()
    const mapFor = (o: fabric.Object) => {
      const pid = this.paperFor(o).id
      let m = mapCache.get(pid)
      if (!m) {
        m = this.buildContentMap(pid)
        mapCache.set(pid, m)
      }
      return m
    }
    objs.forEach((o) => this.refreshContentObject(o, mapFor(o)))
    this.canvas.requestRenderAll()
  }

  private emitActive(explicit?: fabric.Object | null) {
    const active = this.getActiveObject()
    // 多选容器（ActiveSelection，type==='activeselection'）才是“真正”的当前选中：
    // selection:created/updated 传入的 explicit 往往只是首个子对象，若只用它，
    // multi/count 会误判为单对象，导致编组/对齐按钮被错误禁用。
    // 因此当当前选中确实是 ActiveSelection 时，强制以它为准来统计个数。
    let obj: fabric.Object | null = explicit ?? active
    // 多选容器是 fabric.ActiveSelection（区别于用户“编组”出来的 fabric.Group）。
    if (active instanceof fabric.ActiveSelection) {
      obj = active
    }
    if (!obj) {
      this.events.onActiveChange(null)
      this.events.onSelection?.({ count: 0, isGroup: false, isBarcodeGroup: false })
      return
    }
    const isGroupSel = this.isGroup(obj)
    const isBarcodeGroup = isGroupSel && cf(obj).kind === 'barcode'
    // 条码组 / SVG 素材组 都是 fabric.Group，但它们是「原子可编辑对象」，
    // 必须像单对象一样展示各自的属性面板（否则会被当成用户编组而清空面板）。
    const isAtomicGroup = isGroupSel && isAtomicGroupKind(cf(obj).kind)
    const sel = obj as unknown as { getObjects?: () => fabric.Object[] }
    const multi = typeof sel.getObjects === 'function' && (sel.getObjects() ?? []).length > 0
    // 容器分支：真实编组（用户编组）/ 多选(ActiveSelection) 进入“整体操作”状态，不展示单对象属性面板。
    if (!isAtomicGroup && (isGroupSel || multi)) {
      const cnt = isGroupSel ? 1 : (sel.getObjects?.().length ?? 0)
      this.events.onSelection?.({ count: cnt, isGroup: isGroupSel, isBarcodeGroup: false })
      this.events.onActiveChange(null)
      return
    }
    // 单对象 / 条码组：作为单个可编辑对象处理（条码组走 isBarcodeKind 分支展示条码属性）
    // isGroup 语义=「用户编组出来的、可解组的容器」；条码组/素材组是原子对象，不可解组
    this.events.onSelection?.({ count: 1, isGroup: isGroupSel && !isAtomicGroup, isBarcodeGroup })
    const c = cf(obj)
    const kind = (c.kind ?? 'text') as ElementKind
    let text: string | null = null
    let barcodeType: BarcodeType | undefined
    let barcodeSettings: BarcodeRenderSettings | undefined
    let barcodeTextOffsetMm: number | undefined
    let barcodeAlign: BarcodeAlign | undefined
    let textFormat: TextFormatSnapshot | undefined
    let textRegion: { border: boolean; bg: boolean } | undefined
    let strokeWidth: number | undefined
    let strokeColor: string | undefined
    let fillColor: string | null | undefined
    let cornerRadiusMm: number | undefined
    let shapeType: ShapeType | undefined
    let prefix = c._prefix ?? ''
    let suffix = c._suffix ?? ''
    let serial: SerialSpec | undefined = c._serial
    if (kind === 'text') {
      const it = obj as fabric.IText
      text = c.originalText ?? it.text ?? ''
      const itAny = it as fabric.IText
      const fsPx = itAny.fontSize ?? 12
      textFormat = {
        fontFamily: itAny.fontFamily ?? 'Arial',
        fontSizePt: Math.round(pxToPt(fsPx) * 10) / 10,
        bold: itAny.fontWeight === 'bold',
        italic: itAny.fontStyle === 'italic',
        color: (itAny.fill as string) ?? '#000000',
        textAlign: (itAny.textAlign ?? 'left') as string,
        // 优先回显用户输入的 pt 存档值（避免换算噪声），否则由 charSpacing 反推
        letterSpacingPt:
          c._letterSpacingPt ?? Math.round(charSpacingToPt(itAny.charSpacing, fsPx) * 10) / 10,
      }
      const hasBorder = !!(it as fabric.Object).stroke && (it as fabric.Object).stroke !== 'transparent'
      const hasBg = !!(it as fabric.Object).backgroundColor && (it as fabric.Object).backgroundColor !== 'transparent'
      if (hasBorder || hasBg) textRegion = { border: hasBorder, bg: hasBg }
    } else if (isBarcodeKind(kind)) {
      text = c._barcodeRaw ?? ''
      barcodeType = c._barcodeType
      barcodeSettings = c._barcodeSettings ?? (barcodeType ? defaultSettingsFor(barcodeType) : undefined)
      barcodeTextOffsetMm = c._barcodeTextOffsetMm ?? 0
      barcodeAlign = c._barcodeAlign ?? 'left'
    } else if (isStrokeKind(kind)) {
      strokeWidth = obj.strokeWidth ?? 1
      strokeColor = (obj.stroke as string) || '#000000'
      // 填充：闭合形状才可能填充；line 无填充概念
      if (kind !== 'line') {
        const f = (obj as fabric.Object).fill as string | null
        fillColor = f && f !== 'transparent' ? f : null
      }
      if (kind === 'rect') {
        const rect = obj as fabric.Rect
        // 显示圆角 = rx × scaleX（fabric 先画后缩放），回读为“显示 mm”
        cornerRadiusMm = roundMm(pxToMm((rect.rx ?? 0) * (rect.scaleX ?? 1)))
      }
      if (kind === 'shape') shapeType = c._shapeType ?? 'ellipse'
      prefix = ''
      suffix = ''
      serial = undefined
    } else if (kind === 'svg') {
      // 素材：线稿类可改色（_svgColor），彩绘类（emoji）不支持
      if (c._svgIsStroke) {
        strokeColor = c._svgColor ?? '#000000'
        strokeWidth = c._svgStrokeWidth ?? 2
      }
      prefix = ''
      suffix = ''
      serial = undefined
    } else {
      prefix = ''
      suffix = ''
      serial = undefined
    }
    this.events.onActiveChange({
      id: c.id ?? '',
      name: c._name ?? '',
      locked: !!c._locked,
      kind,
      // XY 相对「对象所属那张纸」的左上角（多标签时按归属纸计算，不是活动纸）
      x: roundMm(pxToMm((obj.left ?? 0) - this.paperFor(obj).left)),
      y: roundMm(pxToMm((obj.top ?? 0) - this.paperFor(obj).top)),
      width: roundMm(pxToMm(obj.getScaledWidth() ?? obj.width ?? 0)),
      height: roundMm(pxToMm(obj.getScaledHeight() ?? obj.height ?? 0)),
      angle: Math.round(obj.angle ?? 0),
      text,
      strokeWidth: strokeWidth != null ? Math.round(strokeWidth * 10) / 10 : undefined,
      strokeColor,
      fillColor,
      cornerRadiusMm,
      prefix: isContentKind(kind) ? prefix : undefined,
      suffix: isContentKind(kind) ? suffix : undefined,
      serial: isContentKind(kind) ? serial : undefined,
      barcodeType,
      barcodeSettings,
      barcodeTextOffsetMm,
      barcodeAlign,
      shapeType,
      textFormat,
      textRegion,
      isParagraph: kind === 'text' ? !!c._textParagraph : undefined,
    })
  }

  /** 应用文本格式到当前选中文本对象 */
  setTextStyle(patch: Partial<TextStyle>) {
    const obj = this.getActiveObject()
    if (!obj) return
    const c = cf(obj)
    if (c.kind !== 'text') return
    const it = obj as fabric.IText
    const set: Record<string, unknown> = {}
    if (patch.fontFamily) set.fontFamily = patch.fontFamily
    if (patch.fontSizePt != null) {
      set.fontSize = ptToPx(patch.fontSizePt)
      // 字间距按 pt 存档：字号变了要换算成新的 charSpacing，视觉字距才不被字号带跑
      if (c._letterSpacingPt) set.charSpacing = ptToCharSpacing(c._letterSpacingPt, set.fontSize as number)
    }
    if (patch.bold != null) set.fontWeight = patch.bold ? 'bold' : 'normal'
    if (patch.italic != null) set.fontStyle = patch.italic ? 'italic' : 'normal'
    if (patch.color) set.fill = patch.color
    if (patch.textAlign) set.textAlign = patch.textAlign
    if (patch.letterSpacingPt != null) {
      const fsPx = (set.fontSize as number | undefined) ?? it.fontSize ?? 12
      set.charSpacing = ptToCharSpacing(patch.letterSpacingPt, fsPx)
      c._letterSpacingPt = patch.letterSpacingPt
    }
    if (Object.keys(set).length) {
      it.set(set)
      it.initDimensions()
      it.setCoords()
      this.canvas.requestRenderAll()
      this.events.onDirty()
      this.emitActive()
    }
  }

  /**
   * 文本区域框：开启后给 Textbox 加上可见的边框+底色，类似"区域文本框"。
   * 默认边框 1px 深灰、底色浅灰；关闭则全部清除。
   */
  setActiveTextRegion(region: { border: boolean; bg: boolean }) {
    const obj = this.getActiveObject()
    if (!obj) return
    const c = cf(obj)
    if (c.kind !== 'text') return
    const it = obj as fabric.IText
    const set: Record<string, unknown> = {}
    set.stroke = region.border ? REGION_DEFAULT.stroke : 'transparent'
    set.strokeWidth = region.border ? 1 : 0
    set.strokeUniform = true
    set.backgroundColor = region.bg ? REGION_DEFAULT.backgroundColor : 'transparent'
    it.set(set)
    it.setCoords()
    this.canvas.requestRenderAll()
    this.events.onDirty()
    this.emitActive()
  }

  // ── 纸张 ────────────────────────────────────────────────
  /** 改当前活动纸的尺寸（面板的纸张宽/高） */
  applyPaper(paper: PaperSize) {
    const ap = this.activePaper
    // 先按**改之前**的几何快照绑定内容：等尺寸写进去后再判，缩小的那张纸会把
    // 原本在它上面的内容判成"纸外"，于是不搬 → 内容掉队（错位到邻居纸上）。
    const bindRects = this.paperRectsSnapshot()
    ap.widthMm = paper.widthMm
    ap.heightMm = paper.heightMm
    this.relayoutPapers(bindRects)
    this.resizeWorkspace()
    this.recreatePaperRects()
    this.canvas.requestRenderAll()
    this.events.onDirty()
  }

  /** 各张纸当前的矩形快照（给 relayoutPapers 做"改尺寸前"的绑定基准用） */
  private paperRectsSnapshot(): Array<{ id: string; left: number; top: number; w: number; h: number }> {
    return this.papers.map((p) => ({
      id: p.id,
      left: p.left,
      top: p.top,
      w: mmToPx(p.widthMm),
      h: mmToPx(p.heightMm),
    }))
  }

  // ── 多标签（多纸）管理 ──────────────────────────────────
  /**
   * 纵向重排：纸 0 保持位置不变，其后每张纸紧接上一张下沿 + 间距。
   * 改尺寸/增删纸后调用，避免高矮不一时互相重叠或留空。
   *
   * ⚠️ 内容必须**跟着自己的纸一起走**：纸的位置一变（前面那张改高、或删掉一张），
   * 后面所有纸都会上下平移，而对象坐标是绝对值 —— 不搬内容就会出现
   * 「标签 2 的内容留在原地、掉到标签 1 的纸上」（实测：改标签 1 高度后，
   * 「标签二内容」的归属纸从 标签 2 变成 标签 1）。所以：
   *   ① 重排前把内容绑定到纸上（重排后就判不准了）；
   *   ② 重排纸；
   *   ③ 按每张纸的位移量把绑在它上面的内容整体平移（横向不变：所有纸左对齐）。
   *
   * @param bindRects 「绑定内容」时该用的纸矩形。改尺寸场景必须传**改之前**的快照
   *   （见 applyPaper）：否则缩小的那张纸会把原本在它上面的内容判成纸外、不搬。
   */
  private relayoutPapers(bindRects?: Array<{ id: string; left: number; top: number; w: number; h: number }>) {
    if (this.papers.length === 0) return
    const gap = mmToPx(PAPER_GAP_MM)

    // ① 绑定：判据 = 与哪张纸的**重叠面积最大**就归哪张；完全不相交的不绑（例如
    //    用户拖到纸外"暂存"的元素，不该被莫名搬走）。
    //    ⚠️ 一律走 absoluteBounds()，getBoundingRect(true) 对编组/多选内的子对象给错坐标。
    const rects = bindRects ?? this.paperRectsSnapshot()
    const groups: Array<{ id: string; top: number; objs: fabric.Object[] }> = rects.map((r) => ({
      id: r.id,
      top: r.top,
      objs: [],
    }))
    const byId = new Map(rects.map((r) => [r.id, r]))
    for (const o of this.canvas.getObjects()) {
      if ((o as { excludeFromExport?: boolean }).excludeFromExport) continue
      const b = absoluteBounds(o)
      let bestId: string | null = null
      let bestArea = 0
      for (const r of rects) {
        const ow = Math.min(b.left + b.width, r.left + r.w) - Math.max(b.left, r.left)
        const oh = Math.min(b.top + b.height, r.top + r.h) - Math.max(b.top, r.top)
        if (ow <= 0 || oh <= 0) continue
        const area = ow * oh
        if (area > bestArea) {
          bestArea = area
          bestId = r.id
        }
      }
      if (bestId) groups.find((g) => g.id === bestId)!.objs.push(o)
    }

    // ② 重排纸
    for (let i = 1; i < this.papers.length; i++) {
      const prev = this.papers[i - 1]
      this.papers[i].top = prev.top + mmToPx(prev.heightMm) + gap
      this.papers[i].left = prev.left
    }

    // ③ 内容随纸平移
    for (const g of groups) {
      if (!g.objs.length) continue
      const paper = this.papers.find((p) => p.id === g.id)
      const prevTop = (byId.get(g.id) ?? { top: g.top }).top
      if (!paper) continue
      const dy = paper.top - prevTop
      if (!dy) continue
      for (const o of g.objs) {
        o.set({ top: (o.top ?? 0) + dy })
        o.setCoords()
      }
    }
  }

  private makePaper(name: string, size: PaperSize, left: number, top: number): PaperArea {
    return {
      id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name,
      widthMm: size.widthMm,
      heightMm: size.heightMm,
      left,
      top,
    }
  }

  /** 纸张列表（副本，供 UI 渲染） */
  listPapers(): PaperArea[] {
    return this.papers.map((p) => ({ ...p }))
  }

  /** 当前活动纸 id */
  activePaperId(): string {
    return this.activePaper.id
  }

  setActivePaper(id: string) {
    if (!this.papers.some((p) => p.id === id)) return
    if (this.activePaperIdValue === id) return
    this.activePaperIdValue = id
    // 切换标签时清掉选中：避免属性面板还停留在上一张纸的对象上
    this.canvas.discardActiveObject()
    this.canvas.requestRenderAll()
    this.events.onDirty()
    this.events.onActiveChange(null)
  }

  renamePaper(id: string, name: string) {
    const p = this.papers.find((x) => x.id === id)
    if (!p) return
    p.name = name
    this.events.onDirty()
  }

  /**
   * 在当前活动纸的下方追加一张新纸（尺寸沿用当前纸），并切换为活动纸。
   * 返回新纸 id；UI 可用它做后续定位。
   */
  addPaper(): string {
    const cur = this.activePaper
    const p = this.makePaper(
      `标签 ${this.papers.length + 1}`,
      { widthMm: cur.widthMm, heightMm: cur.heightMm },
      cur.left,
      cur.top + mmToPx(cur.heightMm) + mmToPx(PAPER_GAP_MM),
    )
    this.papers.push(p)
    this.activePaperIdValue = p.id
    this.relayoutPapers()
    this.resizeWorkspace()
    this.recreatePaperRects()
    this.canvas.requestRenderAll()
    this.events.onDirty()
    return p.id
  }

  /** 删除一张纸（连同纸内对象）。至少保留一张，最后一张不可删。 */
  removePaper(id: string): boolean {
    if (this.papers.length <= 1) return false
    const idx = this.papers.findIndex((p) => p.id === id)
    if (idx < 0) return false
    // 归属该纸的对象一并删除，避免残留在别处造成错乱
    const doomed = this.canvas
      .getObjects()
      .filter(
        (o) => !(o as { excludeFromExport?: boolean }).excludeFromExport && this.paperFor(o)?.id === id,
      )
    this._suppressDirty = true
    for (const o of doomed) this.canvas.remove(o)
    this._suppressDirty = false
    this.papers.splice(idx, 1)
    if (this.activePaperIdValue === id) {
      this.activePaperIdValue = this.papers[Math.min(idx, this.papers.length - 1)].id
    }
    this.relayoutPapers()
    this.resizeWorkspace()
    this.recreatePaperRects()
    this.canvas.requestRenderAll()
    this.events.onDirty()
    this.events.onActiveChange(null)
    return true
  }

  /**
   * 判断对象归属哪张纸：中心落在哪张纸内即归属它；
   * 都不在（拖到纸外暂存）时取相交面积最大的一张；仍无则归活动纸。
   */
  paperFor(obj: fabric.Object): PaperArea {
    const b = obj.getBoundingRect(true)
    const cx = b.left + b.width / 2
    const cy = b.top + b.height / 2
    for (const p of this.papers) {
      const w = mmToPx(p.widthMm)
      const h = mmToPx(p.heightMm)
      if (cx >= p.left && cx <= p.left + w && cy >= p.top && cy <= p.top + h) return p
    }
    let best: PaperArea | null = null
    let bestArea = 0
    for (const p of this.papers) {
      const w = mmToPx(p.widthMm)
      const h = mmToPx(p.heightMm)
      const ow = Math.min(b.left + b.width, p.left + w) - Math.max(b.left, p.left)
      const oh = Math.min(b.top + b.height, p.top + h) - Math.max(b.top, p.top)
      if (ow > 0 && oh > 0 && ow * oh > bestArea) {
        bestArea = ow * oh
        best = p
      }
    }
    return best ?? this.activePaper
  }

  /** 重新计算工作区尺寸 = 包住所有纸 + 四周留白(逻辑尺寸,canvas 实际尺寸由 setViewportSize 控制) */
  private resizeWorkspace() {
    const margin = mmToPx(WORKSPACE_MARGIN_MM)
    let maxR = 0
    let maxB = 0
    for (const p of this.papers) {
      maxR = Math.max(maxR, p.left + mmToPx(p.widthMm))
      maxB = Math.max(maxB, p.top + mmToPx(p.heightMm))
    }
    this.workspaceW = maxR + margin
    this.workspaceH = maxB + margin
    // canvas 尺寸 = 视口(由 setViewportSize 控制),不再随工作区增长;
    // 工作区仅作为逻辑坐标空间,显示缩放由 viewportTransform 承担。
  }

  /**
   * 画布向外扩张（等效"无限画布"）。
   * 向右/下扩张不需要移动任何东西；向左/上扩张时把所有对象和"纸卡"整体平移，
   * 保证画面视觉不动、只是多出可用空间。
   */
  private growWorkspace(side: 'left' | 'right' | 'top' | 'bottom') {
    const delta = mmToPx(GROW_STEP_MM)
    if (side === 'right' || side === 'bottom') {
      if (side === 'right') this.workspaceW += delta
      else this.workspaceH += delta
      // canvas 尺寸 = 视口,不随工作区增长
      return
    }
    // 左/上扩张：整体平移，保持视觉不变
    const dx = side === 'left' ? delta : 0
    const dy = side === 'top' ? delta : 0
    // 多纸：所有纸一起平移（相对关系保持不变）
    for (const p of this.papers) {
      p.left += dx
      p.top += dy
    }
    if (side === 'left') this.workspaceW += delta
    else this.workspaceH += delta
    this._suppressDirty = true
    for (const o of this.canvas.getObjects()) {
      o.set({ left: (o.left ?? 0) + dx, top: (o.top ?? 0) + dy })
      o.setCoords()
    }
    this._suppressDirty = false
    this.recreatePaperRects()
    this.canvas.requestRenderAll()
  }

  /** 对象被拖到边缘附近时自动扩张画布（返回是否扩张过） */
  private autoGrowForObject(obj: fabric.Object): boolean {
    const b = obj.getBoundingRect(true)
    let grew = false
    if (b.left < GROW_TRIGGER_PX) {
      this.growWorkspace('left')
      grew = true
    }
    if (b.top < GROW_TRIGGER_PX) {
      this.growWorkspace('top')
      grew = true
    }
    if (b.left + b.width > this.workspaceW - GROW_TRIGGER_PX) {
      this.growWorkspace('right')
      grew = true
    }
    if (b.top + b.height > this.workspaceH - GROW_TRIGGER_PX) {
      this.growWorkspace('bottom')
      grew = true
    }
    return grew
  }

  /** 标签"纸卡"：白底矩形带淡灰边，不可交互、不参与导出。多标签时每张纸各一张。 */
  private recreatePaperRects() {
    this._suppressDirty = true
    // 先清掉已有纸卡：包含 undo 快照/旧模板带回来的残留，否则会逐次叠加
    for (const [, rect] of this.paperRects) this.canvas.remove(rect)
    this.paperRects.clear()
    for (const o of [...this.canvas.getObjects()]) {
      if ((o as { excludeFromExport?: boolean }).excludeFromExport) this.canvas.remove(o)
    }
    for (const p of this.papers) {
      const rect = new fabric.Rect({
        left: p.left,
        top: p.top,
        width: mmToPx(p.widthMm),
        height: mmToPx(p.heightMm),
        fill: '#ffffff',
        stroke: '#cbd5e1',
        strokeWidth: 1,
        opacity: 1,
        selectable: false,
        evented: false,
        excludeFromExport: true,
        hoverCursor: 'default',
      })
      this.canvas.add(rect)
      this.paperRects.set(p.id, rect)
    }
    // 全部纸卡沉到最底
    for (const p of this.papers) {
      const r = this.paperRects.get(p.id)
      if (r) this.canvas.sendToBack(r)
    }
    this._suppressDirty = false
  }

  /** 判断对象是否在任意一张标签纸内（用于导出过滤 + 视觉提示）。
   *  经 absoluteBounds 还原绝对坐标，编组/多选内的子对象同样正确。 */
  isObjectInPaper(obj: fabric.Object): boolean {
    const b = absoluteBounds(obj)
    return this.papers.some((p) => {
      const right = p.left + mmToPx(p.widthMm)
      const bottom = p.top + mmToPx(p.heightMm)
      return b.left < right && b.left + b.width > p.left && b.top < bottom && b.top + b.height > p.top
    })
  }

  /** 对象是否落在指定纸内（按纸导出时用） */
  isObjectInPaperId(obj: fabric.Object, paperId: string): boolean {
    const p = this.papers.find((x) => x.id === paperId)
    if (!p) return false
    const b = absoluteBounds(obj)
    const right = p.left + mmToPx(p.widthMm)
    const bottom = p.top + mmToPx(p.heightMm)
    return b.left < right && b.left + b.width > p.left && b.top < bottom && b.top + b.height > p.top
  }

  /** 标签外对象降低不透明度：明确视觉提示"暂存/不打印"。
   *  对纸卡背景、群组整体不做处理；只对内容对象。 */
  private updateOutsidePaperVisual(obj: fabric.Object | fabric.ActiveSelection | null) {
    if (!obj) return
    const list: fabric.Object[] =
      obj.type === 'activeSelection' && (obj as { getObjects?: () => fabric.Object[] }).getObjects
        ? (obj as { getObjects: () => fabric.Object[] }).getObjects()
        : [obj]
    let dirty = false
    for (const o of list) {
      if ((o as { excludeFromExport?: boolean }).excludeFromExport || o === this.paperRect) continue
      const want = this.isObjectInPaper(o) ? 1 : 0.35
      if (Math.abs((o.opacity ?? 1) - want) > 0.01) {
        o.set({ opacity: want })
        dirty = true
      }
    }
    if (dirty) this.canvas.requestRenderAll()
  }

  /**
   * 全量重算「纸外半透明」：任何会改变对象树的操作之后都必须调用
   * （编组 / 解组 / 载入模板 / 撤销重做 / 拖动结束）。
   *
   * 为什么必须重算，而不是跟着操作顺手改一下：
   *  · opacity 是**顶层单位**的属性 —— 组内的子对象不该单独降透明度，
   *    否则会与组自身的 opacity 叠乘（0.35×0.35≈0.12，暗到看不清）；
   *  · 组从纸外拆回独立对象时，fabric 恢复的是子对象**自己的** opacity（1），
   *    若不再评估一次，解组出来的对象就会按「标签内」的纯黑显示，
   *    丢掉「纸外 · 不打印」的视觉提示（用户报的「拖到标签外解组后又变黑」）。
   *
   * 真编组内的子对象不在 canvas 顶层，所以这里天然只按「最外层对象」评估一次。
   */
  refreshOutsidePaperAll() {
    for (const o of this.canvas.getObjects()) {
      if ((o as { excludeFromExport?: boolean }).excludeFromExport) continue
      this.updateOutsidePaperVisual(o)
    }
  }

  /**
   * 中断 fabric 正在进行的拖拽/缩放/旋转，并把对象还原到**本次手势开始前**的几何。
   *
   * 用途：双指缩放的第二根手指落下时，第一根手指往往已经让 fabric 进入了拖拽状态
   * （fabric 收的是 touchstart，pointer 层面拦不住）。用户此刻的意图是缩放画布，
   * 不该顺带把对象拖走，更不该把这次「误拖」记进撤销栈。
   *
   * 所以：还原几何 → 丢弃 mouse:down 时暂存的快照 → 补发一次 object:modified
   * 让标尺高亮带 / 属性面板 / 纸外半透明重算。补发时 `_pendingHistory` 已清空，
   * 引擎的 modified handler 不会 commit，因此撤销栈里不会多出一条空记录。
   */
  abortActiveTransform(): void {
    const inner = this.canvas as unknown as {
      _currentTransform?: {
        target?: fabric.Object
        original?: { left?: number; top?: number; scaleX?: number; scaleY?: number; angle?: number }
      } | null
      _groupSelector?: unknown
    }
    const t = inner._currentTransform
    const target = t?.target
    if (t && target && t.original) {
      target.set({
        left: t.original.left,
        top: t.original.top,
        scaleX: t.original.scaleX,
        scaleY: t.original.scaleY,
        angle: t.original.angle,
      })
      target.setCoords()
    }
    inner._currentTransform = null
    inner._groupSelector = null
    this._pendingHistory = null
    this.canvas.requestRenderAll()
    // 补发 modified：刷新标尺 / 属性面板 / 纸外半透明（上面已清 pending，不会写历史）
    this.canvas.fire('object:modified', target ? { target } : {})
  }

  getCanvasSizePx() {
    // 视图适配按"标签"大小计算（让标签铺满视口）；画布 DOM 是更大的工作区
    return { w: this.paperPxW, h: this.paperPxH }
  }

  /** 设置可见视口尺寸(屏幕像素)。App 在 mount 与窗口 resize 时调用 */
  setViewportSize(w: number, h: number) {
    this.viewW = Math.max(1, w)
    this.viewH = Math.max(1, h)
    this.canvas.setDimensions({ width: this.viewW, height: this.viewH })
    this.canvas.calcOffset()
    this.applyViewportTransform(this.vptZoom, this.vptPan.x, this.vptPan.y)
  }

  /** 应用视口变换:屏幕像素 = 工作区坐标 * z + pan */
  applyViewportTransform(z: number, px: number, py: number) {
    this.vptZoom = z
    this.vptPan = { x: px, y: py }
    this.canvas.setViewportTransform([z, 0, 0, z, px, py])
    this.canvas.requestRenderAll()
  }

  getViewportSize(): { width: number; height: number } {
    return { width: this.viewW, height: this.viewH }
  }

  getZoomValue(): number { return this.vptZoom }
  getPanValue(): { x: number; y: number } { return { ...this.vptPan } }

  /** 标签中心在工作区中的画布坐标(像素) */
  paperCenter(): { x: number; y: number } {
    return {
      x: this.paperOffsetX + this.paperPxW / 2,
      y: this.paperOffsetY + this.paperPxH / 2,
    }
  }

  /** 标签在工作区中的像素矩形(供导出裁剪)：默认当前活动纸 */
  getPaperBoundsPx(): { left: number; top: number; width: number; height: number } {
    return { left: this.paperOffsetX, top: this.paperOffsetY, width: this.paperPxW, height: this.paperPxH }
  }

  /** 指定纸在工作区中的像素矩形（多标签按纸导出） */
  getPaperBoundsPxFor(paperId: string): { left: number; top: number; width: number; height: number } {
    const p = this.papers.find((x) => x.id === paperId) ?? this.activePaper
    return { left: p.left, top: p.top, width: mmToPx(p.widthMm), height: mmToPx(p.heightMm) }
  }

  /** 指定纸的毫米尺寸（多标签 PDF 每页可能不同尺寸） */
  paperSizeMm(paperId: string): PaperSize {
    const p = this.papers.find((x) => x.id === paperId) ?? this.activePaper
    return { widthMm: p.widthMm, heightMm: p.heightMm }
  }

  /** 工作区尺寸(像素)） */
  getWorkspaceSizePx(): { width: number; height: number } {
    return { width: this.workspaceW, height: this.workspaceH }
  }

  // ── 对象：几何/角度 ─────────────────────────────────────
  setActiveGeometry(patch: Partial<{ x: number; y: number; width: number; height: number; angle: number }>) {
    const obj = this.getActiveObject()
    if (!obj) return
    const c = cf(obj)
    const isText = c.kind === 'text'
    // 多标签：按「对象所属纸」的原点换算——先取归属再写入，避免先移动导致归属漂移
    const owner = this.paperFor(obj)
    if (patch.x !== undefined) obj.set({ left: mmToPx(patch.x) + owner.left })
    if (patch.y !== undefined) obj.set({ top: mmToPx(patch.y) + owner.top })
    if (patch.angle !== undefined) obj.set({ angle: patch.angle })
    if (patch.width !== undefined) {
      if (isText && obj instanceof fabric.Textbox) {
        // 文本框：宽度即盒宽，直接改 width，避免 scale 随 initDimensions 坍塌
        obj.set({ width: mmToPx(patch.width), scaleX: 1 })
        obj.initDimensions()
      } else {
        const baseW = obj.width ?? 1
        obj.set({ scaleX: mmToPx(patch.width) / baseW })
      }
    }
    if (patch.height !== undefined && !(isText && obj instanceof fabric.Textbox)) {
      const baseH = obj.height ?? 1
      obj.set({ scaleY: mmToPx(patch.height) / baseH })
    }
    obj.setCoords()
    this.canvas.requestRenderAll()
    this.emitActive()
    this.events.onDirty()
  }

  /** 设置选中闭合形状/直线的描边粗细（px，恒等不随缩放）；SVG 线稿素材走素材专用分支 */
  setActiveStrokeWidth(widthPx: number) {
    const obj = this.getActiveObject()
    if (!obj) return
    const c = cf(obj)
    if (c.kind === 'svg') {
      this.setActiveAssetStrokeWidth(widthPx)
      return
    }
    if (!isStrokeKind(c.kind)) return
    const w = Math.max(0, Math.min(100, Math.round(widthPx * 10) / 10))
    obj.set({ strokeWidth: w, strokeUniform: true })
    obj.setCoords()
    this.canvas.requestRenderAll()
    this.emitActive()
    this.events.onDirty()
  }

  /** 设置选中矩形的圆角半径（显示 mm）：换算成相对缩放的 rx/ry，保证拉大缩小后视觉圆角一致 */
  setActiveCornerRadius(radiusMm: number) {
    const obj = this.getActiveObject()
    if (!obj) return
    const c = cf(obj)
    if (c.kind !== 'rect') return
    const r = Math.max(0, Math.min(50, radiusMm)) // 上限 50mm 避免半径超尺寸
    const s = (obj.scaleX ?? 1) || 1
    const rect = obj as fabric.Rect
    rect.set({ rx: mmToPx(r) / s, ry: mmToPx(r) / s })
    rect.setCoords()
    this.canvas.requestRenderAll()
    this.emitActive()
    this.events.onDirty()
  }

  /** 设置选中矩形/形状的描边颜色 */
  setActiveStrokeColor(hex: string) {
    const obj = this.getActiveObject()
    if (!obj) return
    const c = cf(obj)
    // SVG 线稿素材：整组统一改色（并同步缓存色，保证矢量导出复用新颜色）
    if (c.kind === 'svg') {
      this.setActiveAssetColor(hex)
      return
    }
    if (!isStrokeKind(c.kind)) return
    obj.set({ stroke: hex, strokeUniform: true })
    this.canvas.requestRenderAll()
    this.emitActive()
    this.events.onDirty()
  }

  /** 设置选中矩形/形状的填充颜色；null=透明（无填充） */
  setActiveFillColor(color: string | null) {
    const obj = this.getActiveObject()
    if (!obj) return
    const c = cf(obj)
    if (c.kind !== 'rect' && c.kind !== 'shape') return
    obj.set({ fill: color ?? 'transparent' })
    this.canvas.requestRenderAll()
    this.emitActive()
    this.events.onDirty()
  }

  /** 画布上原地编辑文字退出后，把显示文本同步回设计原文 */
  private syncInlineTextEdit() {
    const obj = this._inlineEditTarget
    this._inlineEditTarget = null
    const startText = this._inlineStartText
    this._inlineStartText = ''
    if (!obj) return
    const c = cf(obj)
    if (c.kind !== 'text') return
    const it = obj as fabric.IText
    const typed = it.text ?? ''
    // 若用户真的改动了内容（非误触），就把输入写回为新的设计原文。
    // 画布上显示的就是该对象的原文标记（未解析列时标记原样可见），所见即所存，
    // 因此直接采纳 typed 即可——用户可能保留 {{变量}} 也可能删成纯文本，都尊重。
    if (typed !== startText) {
      c.originalText = typed
      this.pushHistory()
      this.refreshContentObject(obj)
      this.refreshDependents(obj)
    }
    this.canvas.requestRenderAll()
    this.emitActive()
    this.events.onDirty()
  }

  /** 内容变更：更新设计原文（不含前后缀），并按预览态刷新显示（不触发选中回填） */
  updateContent(text: string) {
    const obj = this.getActiveObject()
    if (!obj) return
    const c = cf(obj)
    if (!isContentKind(c.kind)) return
    // 一次“编辑会话”只压一次撤销栈（连续打字不刷屏）
    if (!this._typingSeen) {
      this.pushHistory()
      this._typingSeen = true
    }
    if (c.kind === 'text') {
      c.originalText = text
      this.refreshContentObject(obj)
      this.canvas.requestRenderAll()
      // 若其它对象引用了本对象名称，需级联刷新它们的显示
      this.refreshDependents(obj)
    } else if (isBarcodeKind(c.kind)) {
      c._barcodeRaw = text
      this.rerenderBarcode(obj)
      this.refreshDependents(obj)
    }
    this.events.onDirty()
  }

  // ── 对象：新增 ──────────────────────────────────────────
  /**
   * 段落文本：定宽、自动换行的多行区域文本框。
   * 与普通文本同属 kind='text'（导出 / 打印 / 数据绑定完全复用同一条链路），
   * 差异只在预置形态：更宽的默认宽度 + 多行占位文案。
   * 外观与普通文本一致（无底色/边框），需要可见边界时在属性面板开「区域框」。
   * 拖左右两侧控制点改宽度 → 文字按新边界重排；高度默认贴合文字内容。
   */
  addParagraphText(initial = PARAGRAPH_PLACEHOLDER) {
    // 窄标签上按纸宽收一档（留 10% 边距），避免段落一插入就超出纸面
    const boxW = Math.min(mmToPx(PARAGRAPH_WIDTH_MM), mmToPx(this.activePaper.widthMm) * 0.9)
    const cx = this.paperCenter().x
    const cy = this.paperCenter().y
    const obj = new fabric.Textbox(initial, {
      left: cx - boxW / 2,
      top: cy - mmToPx(9),
      width: boxW,
      fontSize: 20,
      fontFamily: 'Arial',
      fill: '#000000',
      originX: 'left',
      originY: 'top',
      splitByGrapheme: true,
      lineHeight: 1.35,
      // 与普通文本一致：默认无底色、无边框（需要可见边界时用属性面板的「区域框」）
    })
    const c = cf(obj)
    c._textParagraph = true
    // 先占位命名，finalizeObject 只在 _name 为空时才补默认名
    c._name = this.nextParagraphName(obj)
    this.finalizeObject(obj, 'text', initial)
  }

  /**
   * 段落文本命名：段落1 / 段落2 …
   * 载入模板后 nameCounters 不会回退，可能与模板里已有的「段落N」错位，
   * 因此生成后再查一次重，避免静默撞名（撞名会干扰数据打印的按列名绑定）。
   */
  private nextParagraphName(obj: fabric.Object): string {
    const base = '段落'
    let idx = (nameCounters.get(base) ?? 0) + 1
    let name = `${base}${idx}`
    while (!this.isNameAvailable(name, obj)) name = `${base}${++idx}`
    nameCounters.set(base, idx)
    return name
  }

  addText(initial = '文本') {
    const boxW = mmToPx(40)
    const cx = this.paperCenter().x
    const cy = this.paperCenter().y
    const obj = new fabric.Textbox(initial, {
      left: cx - boxW / 2,
      top: cy - mmToPx(3),
      width: boxW,
      fontSize: 22,
      fontFamily: 'Arial',
      fill: '#000000',
      originX: 'left',
      originY: 'top',
      splitByGrapheme: true,
    })
    this.finalizeObject(obj, 'text', initial)
  }

  addRect() {
    const w = mmToPx(25)
    const h = mmToPx(12)
    const cx = this.paperCenter().x
    const cy = this.paperCenter().y
    const rect = new fabric.Rect({
      left: cx - w / 2,
      top: cy - h / 2,
      width: w,
      height: h,
      fill: 'transparent',
      stroke: '#000000',
      strokeWidth: 1.5,
      // 描边不随整体缩放变粗/变细（拉大缩小线条粗细恒定）
      strokeUniform: true,
      rx: 0, // 默认直角（0 圆角）
    })
    this.finalizeObject(rect, 'rect', null)
  }

  addLine() {
    const w = mmToPx(30)
    const cx = this.paperCenter().x
    const cy = this.paperCenter().y
    const line = new fabric.Line(
      [cx - w / 2, cy, cx + w / 2, cy],
      {
        stroke: '#000000',
        strokeWidth: 1.5,
        // 描边不随整体缩放变粗/变细
        strokeUniform: true,
      },
    )
    this.finalizeObject(line, 'line', null)
  }

  /** 添加形状（椭圆/正三角/菱形/五角星）。形状统一用 kind='shape' + _shapeType 区分 */
  addShape(type: ShapeType) {
    const wMm = type === 'triangle' ? 24 : 22
    const hMm = type === 'triangle' ? 21 : 22
    const w = mmToPx(wMm)
    const h = mmToPx(hMm)
    const left = this.paperCenter().x - w / 2
    const top = this.paperCenter().y - h / 2
    const base = {
      left,
      top,
      fill: 'transparent',
      stroke: '#000000',
      strokeWidth: 1.5,
      strokeUniform: true,
    }
    let obj: fabric.Object
    if (type === 'ellipse') {
      obj = new fabric.Ellipse({ ...base, rx: w / 2, ry: h / 2 })
    } else if (type === 'triangle') {
      obj = new fabric.Triangle({ ...base, width: w, height: h })
    } else {
      // 菱形/五角星：用 Polygon，点坐标落在 [0..w]×[0..h]（左上原点），便于 scaleX/Y 改几何
      const pts =
        type === 'diamond'
          ? [
              { x: w / 2, y: 0 },
              { x: w, y: h / 2 },
              { x: w / 2, y: h },
              { x: 0, y: h / 2 },
            ]
          : starPolyPoints(w, h)
      obj = new fabric.Polygon(pts, { ...base })
    }
    const c = cf(obj)
    c._shapeType = type
    c._name = shapeBaseName(type) // 直接命名，finalizeObject 仅在无名称时才覆盖
    this.finalizeObject(obj, 'shape', null)
  }

  addBarcode(type: BarcodeType, raw = is2dType(type) ? 'HELLO-{{code}}' : '123456-{{code}}') {
    const is2d = is2dType(type)
    // 2D 以正方形边长(mm)为目标；一维码以「条区高度(mm)」为目标（文字带在条区之下叠加）
    const targetMm = is2d ? 18 : type === 'itf14' ? 12 : 8
    const settings = defaultSettingsFor(type)
    const design = this.resolveDesign(raw)
    const built = this.buildBarcodeGroup(type, design, settings)
    if (!built) return
    const { group, w, h } = built
    // 2D 码必须等比；一维码按「条区高度」锚定。
    // ⭐ 一次性定尺：一维码除「条区目标高」外，再为**基准字号**的人读文字留出文字带。
    //    注意这里用的是常量基准字号（DEFAULT_BARCODE_SETTINGS.textSizePt），**不是**用户设置值
    //    → 新增条码的默认大小与用户后来把字号调成多少无关，不会出现「改字号顺带改尺寸」的棘轮。
    let k = mmToPx(targetMm) / (is2d ? Math.max(w, h) : built.barH || h || 1)
    if (!is2d) {
      const bandUnit = h - built.barH
      if (bandUnit > 1) {
        const fit = ptToPx(DEFAULT_BARCODE_SETTINGS.textSizePt) / (bandUnit * 0.72)
        if (fit > k) k = fit
      }
    }
    group.set({ scaleX: k, scaleY: k })
    const c = cf(group)
    c._barcodeTargetMm = targetMm
    c._barcodeType = type
    c._barcodeSettings = settings
    c._barcodeUnit = { w: built.w, barH: built.barH, inkW: built.inkW }
    c._barcodeTextScale = k
    c._barcodeTextOffsetMm = 0
    // 默认「靠左」= 左边缘固定向右长，与历史行为一致（用户可在属性面板改成居中/靠右）
    c._barcodeAlign = 'left'
    // 记录渲染指纹：内容没变时 refreshAllContent 就不会再重建这个条码
    c._barcodeRendered = barcodeSignature(type, design, settings, 0)
    // 让新增条码的人读文字首帧就以「字号」清晰呈现（方正、不随组缩放被压小）
    if (!is2d) this.applyBarcodeTextCompensation(group)
    group.set({ left: this.paperCenter().x - (w * k) / 2, top: this.paperCenter().y - (h * k) / 2 })
    this.finalizeObject(group, 'barcode', raw)
  }

  /** 构建矢量条码组：黑模块矩形（+1D 人读文字），画布上真矢量、与 PDF 导出同一套几何 */
  private buildBarcodeGroup(
    type: BarcodeType,
    text: string,
    settings: BarcodeRenderSettings,
    textOffsetMm = 0,
  ): { group: fabric.Group; w: number; h: number; barH: number; inkW: number } | null {
    try {
      // ⚠️ 「人读文字带」的几何一律按**基准字号**量取（= DEFAULT_BARCODE_SETTINGS.textSizePt），
      // 不跟随用户设置的字号 —— 否则 built.h 会随字号变，整组尺寸（含宽度）跟着变。
      // 这样 built.h / built.barH 与 textSizePt 完全无关：字号只由 applyBarcodeTextCompensation
      // 作用到文字 child 上，代码本身几何保持不变。
      const vec = renderBarcodeVectorRects(type, text, {
        ...settings,
        textSizePt: DEFAULT_BARCODE_SETTINGS.textSizePt,
      })
      if (!vec.rects.length) return null
      const children: fabric.Object[] = vec.rects.map(
        (r) =>
          new fabric.Rect({
            left: r.x,
            top: r.y,
            width: r.w,
            height: r.h,
            fill: '#000000',
            selectable: false,
            evented: false,
          }),
      )
      let h = vec.height
      // 条码**墨迹宽**：黑条左右两端的实际跨度（不含静区）。人读文字的宽度上限看它 ——
      // 用含静区的 vec.width 会把「压进静区」误判成合法。
      const inkX0 = vec.rects.reduce((m, r) => Math.min(m, r.x), Infinity)
      const inkX1 = vec.rects.reduce((m, r) => Math.max(m, r.x + r.w), -Infinity)
      const inkW = Number.isFinite(inkX0) && inkX1 > inkX0 ? inkX1 - inkX0 : vec.width
      const showText =
        vec.showTextHint && settings.showText !== false && !!vec.fullHeight && vec.fullHeight > vec.height
      if (showText && vec.fullHeight) {
        const band = vec.fullHeight - vec.height
        h = vec.fullHeight
        // 文字 child 离条区下沿额外偏移(mm)：>0 拉开距离，<0 拉近
        const textOffsetPx = mmToPx(textOffsetMm || 0)
        const txt = new fabric.Text(text, {
          left: vec.width / 2,
          top: vec.height + band / 2 + textOffsetPx,
          originX: 'center',
          originY: 'center',
          fontFamily: 'Arial',
          // 下限只挡非法值（≥2）：旧值 6px 会在 band 变小后锁住文字大小，
          // 导致「可读文字字号」调小时文字不再变化
          fontSize: Math.max(2, band * 0.8),
          fill: '#000000',
          textAlign: 'center',
          selectable: false,
          evented: false,
        })
        // ⚠️ 预缩：文案很长时「基准字号量出的文字」会比条区还宽，fabric 在构造 Group 时会把
        //    这个宽度算进 group 的 bbox 并**冻结**。group bbox 是 PDF 导出的盒（box）来源 ——
        //    被撑大 ⇒ 打印出来条码比预览更宽（预览 60mm、打印 82mm 这类「预览/打印不一致」）。
        //    这里先按条区宽压一次，使 bbox 恒等于条区；真正的文字大小随后仍由
        //    applyBarcodeTextCompensation 按「可读文字字号 + 宽度上限」重算。
        const txtW = txt.width ?? 0
        if (inkW > 1 && txtW > inkW) txt.set({ scaleX: inkW / txtW, scaleY: inkW / txtW })
        children.push(txt)
      }
      const group = new fabric.Group(children, { subTargetCheck: false })
      return { group, w: vec.width, h, barH: vec.height, inkW }
    } catch {
      return null
    }
  }

  /**
   * 用新几何替换画布上的条码对象（保持 id/名称/元数据/选中态/位置角度）。
   * fabric Group 不支持原位整体换children，直接换对象最稳。
   */
  /**
   * 从条码组内的「模块矩形」反推未缩放的条码条区高度（不含人读文字带）。
   * 用于 _barcodeUnit 缺失时（旧模板）的兜底。注意 Group 子对象坐标是相对组中心的
   * 局部坐标，未乘组的 scaleY，正好是我们需要的单位几何。
   */
  private barcodeBarUnitHeight(obj: fabric.Object): number {
    const kids = (obj as unknown as { _objects?: fabric.Object[] })._objects
    if (!Array.isArray(kids)) return 0
    let top = Infinity
    let bottom = -Infinity
    for (const k of kids) {
      // 跳过人读文字（它的 scale 已被 applyBarcodeTextCompensation 改写）
      if (k.type === 'text' || k.type === 'textbox' || k.type === 'i-text') continue
      const y0 = k.top ?? 0
      const h0 = (k.height ?? 0) * (k.scaleY ?? 1)
      top = Math.min(top, y0)
      bottom = Math.max(bottom, y0 + h0)
    }
    return bottom > top ? bottom - top : 0
  }

  /**
   * 遍历「某对象及其所有后代」里的条码，逐个执行回调。
   * 条码是原子叶子（不再下钻它的模块矩形），编组 / 多选里的条码也能被找到。
   */
  private eachBarcode(obj: fabric.Object, cb: (b: fabric.Object) => void) {
    if (isBarcodeKind(cf(obj).kind)) {
      cb(obj)
      return
    }
    const kids = (obj as unknown as { _objects?: fabric.Object[] })._objects
    if (Array.isArray(kids)) for (const k of kids) this.eachBarcode(k, cb)
  }

  /**
   * 让条码「人读文字」完全不随拉伸变化 —— 文字大小只由「可读文字字号」决定。
   *
   * 原理：fabric Group 会把自身 scale 叠加到子对象。若给文字 child 设
   * scaleX = glyphPx/(fontSize·sx)、scaleY = glyphPx/(fontSize·sy)，则其
   * 在画布上的视觉字号 = fontSize×childScale×groupScale = glyphPx：
   *  - 与 group 拉伸（sx/sy）无关 → 拉伸/缩放条码时文字字号恒定、字形方正（不拉扁）；
   *  - glyphPx 以 ptToPx(textSizePt) 为**目标值**，再受「条区宽度」上限约束：
   *    ⭐ 文字可视宽 = 实测文字宽 × childScale × 组缩放 = (k.width/fs) × glyphPx，
   *    故「可视宽 ≤ 条区可视宽」等价于 glyphPx ≤ 条区可视宽 / (k.width/fs)。
   *    于是：① 把字号调大，超过条码宽度后就不再变宽（被宽度钳住）；
   *          ② 把条码拉窄，宽度上限同步变小，文字自动缩号（不会戳出条码两侧）。
   *    旧实现有 capPx 按**文字带高度**封顶：把条码缩到 0.2× 时 12px 的字被压成 8.2px
   *    （用户报过「拉伸缩放改变了字体大小」）。现在封顶只按**宽度**，与拉伸解耦。
   *
   * 文字带按**基准字号**预留空间（见 buildBarcodeGroup），故字号设得很大时文字会略微
   * 溢出文字带 —— 这是「字号/尺寸彻底解耦」的必然结果：需要更大边距就把条码整体拉高，
   * 或调「距条区距离 (mm)」。
   */
  private applyBarcodeTextCompensation(obj: fabric.Object) {
    // ⚠️ 必须累乘「父容器链」的缩放：条码可能被编组 / 多选（ActiveSelection）包着，
    //    父容器的 scale 同样会把文字放大。只算 obj.scaleX 会让编组内的条码文字跟着组缩放
    //    （即「拉伸缩小组 = 文字变大」）。多选时父层就是那个临时 ActiveSelection。
    let px = 1
    let py = 1
    let p = (obj as unknown as { group?: fabric.Object | null }).group ?? null
    for (let guard = 0; p && guard < 16; guard++) {
      px *= Math.abs(p.scaleX ?? 1)
      py *= Math.abs(p.scaleY ?? 1)
      p = (p as unknown as { group?: fabric.Object | null }).group ?? null
    }
    const sx = Math.abs(obj.scaleX ?? 1) * px
    const sy = Math.abs(obj.scaleY ?? 1) * py
    if (!sx || !sy) return
    const kids = (obj as unknown as { _objects?: fabric.Object[] })._objects
    if (!Array.isArray(kids)) return
    const c = cf(obj)
    const textPt = Math.max(1, c._barcodeSettings?.textSizePt ?? 9)
    const wantPx = ptToPx(textPt)
    c._barcodeTextScale = Math.min(sx, sy) // 保留字段(兼容旧模板读取/序列化)；不再驱动字号
    // 条区可视宽度(px) —— 人读文字可视宽度的上限
    const barPx = this.barcodeBarVisualWidth(obj, kids, sx)
    for (const k of kids) {
      // 只处理人读文字（条码条是 rect，保持随拉伸变化）
      if (k.type !== 'text' && k.type !== 'textbox' && k.type !== 'i-text') continue
      const fs = Math.max((k as fabric.Text).fontSize ?? 1, 1)
      let glyphPx = wantPx
      // 「单位字号的可视宽」= 实测字宽 / 字号（与字号成正比，故与 fs 取值无关）
      const perPx = ((k as fabric.Text).width ?? 0) / fs
      if (barPx > 0 && perPx > 0) {
        const cap = barPx / perPx
        if (cap < glyphPx) glyphPx = cap
      }
      // 兜底：条码窄到极限时也别把字号压成 0（否则文字直接消失，用户会以为出 bug）
      if (glyphPx < 1) glyphPx = 1
      k.set({ scaleX: glyphPx / (fs * sx), scaleY: glyphPx / (fs * sy) })
    }
  }

  /**
   * 条码条区的「可视宽度」(px) —— 人读文字宽度的上限。
   * 优先直接量组内黑条矩形（rect）的横向跨度：最可靠，且不会被文字自己撑大的 group bbox 误导。
   * 量不出（老模板 / 组内结构异常）时按 _barcodeUnit.inkW → w → group.width 逐级兜底。
   */
  private barcodeBarVisualWidth(obj: fabric.Object, kids: fabric.Object[], sx: number): number {
    let x0 = Infinity
    let x1 = -Infinity
    for (const k of kids) {
      if (k.type !== 'rect') continue
      const l = k.left ?? 0
      const w = (k.width ?? 0) * Math.abs(k.scaleX ?? 1)
      if (l < x0) x0 = l
      if (l + w > x1) x1 = l + w
    }
    const unit = cf(obj)._barcodeUnit
    const local =
      x1 > x0
        ? x1 - x0
        : unit?.inkW && unit.inkW > 0
          ? unit.inkW
          : unit?.w && unit.w > 0
            ? unit.w
            : Math.abs(obj.width ?? 0)
    return local * sx
  }

  private replaceBarcodeObject(
    old: fabric.Object,
    type: BarcodeType,
    text: string,
    settings: BarcodeRenderSettings,
  ): boolean {
    const oc = cf(old)
    const built = this.buildBarcodeGroup(
      type,
      text,
      settings,
      oc._barcodeTextOffsetMm || 0,
    )
    if (!built) return false
    const group = built.group
    const is2d = is2dType(type)
    const curW = old.getScaledWidth()
    const curH = old.getScaledHeight()
    // 旧对象有有效尺寸（正常重绘 / 手动缩放过）→ 沿用当前尺寸，保留手动缩放；
    // 否则（多为载入模板时 fabric 重建出的空组，尺寸为 0）按目标 mm 推算，避免缩成 0 不可见。
    const hasOld = curW > 0 && curH > 0
    // 旧对象记录的「单位几何」（未乘 scale 的栅格尺寸）。只有它与 built.w/built.barH 同口径，
    // 用 fabric bbox(getScaledWidth) 与 built 换算会混入静区误差（见 2D 分支注释）。
    const unit = oc._barcodeUnit
    const unitOk = !!unit && unit.w > 0 && unit.barH > 0
    let kx: number
    let ky: number
    if (is2d) {
      // 2D 码必须等比（否则无法扫描）。
      // ⚠️ 单位必须同口径：`getScaledWidth()` 是**内容外框**（fabric bbox，不含四周静区），
      //    而 `built.w/built.h` 是**栅格尺寸**（含静区）—— 两者之比恒 ≈0.85 ⇒ 旧写法
      //    `k = max(curW,curH)/max(built.w,built.h)` 会让二维码**每次重建都缩水 15%**
      //    （改内容 / 改容错等级 / 改静区 / 存档后重开都会触发，用户报过「二维码大小会变」）。
      //    现在优先「内容外框 ↔ 内容外框」对比：**可见尺寸逐次严格保持**（不再有静区占比漂移）；
      //    旧对象量不出外框（载入模板的空壳组）时，退回「栅格 ↔ 栅格」换算。
      const nextInk = Math.max(group.width ?? 0, group.height ?? 0)
      const nextRaster = Math.max(built.w, built.h)
      const targetMm = oc._barcodeTargetMm ?? 18
      let k: number
      if (hasOld && nextInk > 0) {
        k = Math.max(curW, curH) / nextInk
      } else if (unitOk) {
        k =
          Math.max(unit!.w * Math.abs(old.scaleX ?? 1), unit!.barH * Math.abs(old.scaleY ?? 1)) /
          (nextRaster || 1)
      } else {
        k = mmToPx(targetMm) / (built.w || 1)
      }
      kx = k
      ky = k
    } else {
      // 一维码：缩放必须按「条码条区」换算，绝不能按含人读文字的整高换算 ——
      // 否则调整「可读文字字号」→ fullHeight 变化 → ky 跟着变 → 整条码被压缩/放大。
      // 优先用记录的单位几何；缺失时（旧模板）从旧组的模块矩形反推。
      const prevBarH = unitOk ? unit!.barH : this.barcodeBarUnitHeight(old)
      const kBar =
        hasOld && prevBarH > 0 && built.barH > 0
          ? (Math.abs(old.scaleY ?? 1) * prevBarH) / built.barH
          : 0
      if (kBar > 0) {
        // 保留用户手动造成的非等比拉伸比（未拉伸时 ratio = 1，即等比）
        const syPrev = Math.abs(old.scaleY ?? 1)
        const ratio = syPrev > 1e-6 ? Math.abs(old.scaleX ?? 1) / syPrev : 1
        // ⭐ ky 只按「条区高」换算 —— 重建前后条区尺寸逐像素一致，改字号不动几何。
        // 旧实现还会按文字带需求抬高 ky（needSy），改一次大字号就把 scaleY 永久写大，
        // 之后把字号调回也回不到原尺寸（棘轮效应，用户报过「调整字体改变了条码大小」）。
        ky = kBar
        kx = ky * ratio
      } else if (hasOld) {
        // 兜底：反推不出条区高（极端旧模板）→ 沿用当前整高比例
        const k = curH / (built.h || 1)
        kx = k
        ky = k
      } else {
        // 载入模板时 fabric 重建出的空组（尺寸为 0）：按「条区目标高」+ 为**基准字号**
        // 留出文字带一次性定尺，与 addBarcode 同一套公式（同样只用常量基准字号）。
        const targetMm = oc._barcodeTargetMm ?? (type === 'itf14' ? 12 : 8)
        let k = mmToPx(targetMm) / (built.barH || built.h || 1)
        const bandUnit = built.h - built.barH
        if (bandUnit > 1) {
          const fit = ptToPx(DEFAULT_BARCODE_SETTINGS.textSizePt) / (bandUnit * 0.72)
          if (fit > k) k = fit
        }
        kx = k
        ky = k
      }
    }
    // 对齐档位决定 `left` 的含义（锚点）：靠左=左边缘、居中=中心、靠右=右边缘。
    // 直接沿用旧对象的 left ⇒ 锚点不动 ⇒ 内容变长时按用户选的方向扩展
    // （Code128 数据多了不会一味向右长；靠右时它向左长、居中时两侧均分）。
    const align: BarcodeAlign = oc._barcodeAlign ?? 'left'
    group.set({
      scaleX: kx,
      scaleY: ky,
      left: old.left,
      top: old.top,
      angle: old.angle ?? 0,
      originX: align,
    })
    const nc = cf(group)
    nc.id = oc.id
    nc.kind = oc.kind
    nc._name = oc._name
    nc._locked = oc._locked
    nc._barcodeRaw = oc._barcodeRaw
    nc._barcodeType = oc._barcodeType
    nc._barcodeTargetMm = oc._barcodeTargetMm
    nc._barcodeSettings = oc._barcodeSettings
    nc._barcodeUnit = { w: built.w, barH: built.barH, inkW: built.inkW }
    nc._barcodeTextOffsetMm = oc._barcodeTextOffsetMm || 0
    nc._barcodeAlign = align
    // 记录本次渲染指纹，供 rerenderBarcode 判断「内容没变就别重建」
    nc._barcodeRendered = barcodeSignature(type, text, settings, nc._barcodeTextOffsetMm)
    // 重建后按「可读文字字号」刷新人读文字视觉：文字不随拉伸/改码制变化，仅字号生效
    if (!is2d && settings.showText !== false) this.applyBarcodeTextCompensation(group)
    this.patchSerialize(group)
    this.applyLockState(group)
    this._suppressDirty = true
    // ⚠️ 替换必须区分「顶层对象」与「编组/多选里的子对象」：
    //   - 顶层：canvas.remove(old) + canvas.add(group)，left/top 即绝对坐标；
    //   - 嵌套：**绝不能走 canvas.add** —— 子对象的 left/top 是「父容器内的局部坐标」，
    //     挂到画布顶层会被当成绝对坐标，条码立刻飞到工作区原点附近（看起来就是"消失"）。
    //     正确做法是在父容器的 _objects 里原位替换：局部坐标、层序、与父容器的关系全部保留。
    const parent = ((old as { group?: fabric.Object | null }).group ?? null) as fabric.Object | null
    const siblings = parent
      ? ((parent as unknown as { _objects?: fabric.Object[] })._objects ?? null)
      : null
    const at = siblings ? siblings.indexOf(old) : -1
    if (siblings && at >= 0) {
      siblings[at] = group
      ;(group as { group?: fabric.Object | null }).group = parent
      ;(old as { group?: fabric.Object | null }).group = null
      parent!.dirty = true
      parent!.setCoords()
    } else {
      const wasActive = this.canvas.getActiveObject() === old
      this.canvas.remove(old)
      this.canvas.add(group)
      if (wasActive) this.canvas.setActiveObject(group)
    }
    this._suppressDirty = false
    group.setCoords()
    this.canvas.requestRenderAll()
    return true
  }

  /** 切换条码对象码制（并重新渲染） */
  setBarcodeType(type: BarcodeType) {
    const obj = this.getActiveObject()
    if (!obj) return
    const c = cf(obj)
    if (!isBarcodeKind(c.kind)) return
    if (c._barcodeType === type) return
    c._barcodeType = type
    // 2D/一维切换时重置合理目标尺寸
    c._barcodeTargetMm = is2dType(type) ? 18 : type === 'itf14' ? 12 : 8
    // 码制切换时按新码制初始化渲染设置（如零售码默认显示可读文字）
    c._barcodeSettings = defaultSettingsFor(type)
    this.rerenderBarcode(obj)
    this.emitActive()
    this.events.onDirty()
  }

  /** 重命名当前选中对象（内容对象允许被引用；自动去重兜底） */
  setActiveName(name: string) {
    const obj = this.getActiveObject()
    if (!obj) return
    const c = cf(obj)
    if (!isContentKind(c.kind)) return
    const trimmed = name.trim()
    if (trimmed === c._name) return
    if (trimmed === '') {
      // 允许清空名称，便于重新输入（不会被自动命名覆盖）
      c._name = ''
    } else if (!this.isNameAvailable(trimmed, obj)) {
      // 简单去重兜底：追加序号避免静默撞名
      let n = 2
      let candidate = `${trimmed}${n}`
      while (!this.isNameAvailable(candidate, obj)) candidate = `${trimmed}${++n}`
      c._name = candidate
    } else {
      c._name = trimmed
    }
    this.patchSerialize(obj)
    this.events.onDirty()
    this.emitActive()
    this.refreshDependents(obj)
  }

  /** 把锁定状态映射到 fabric 交互锁：锁定后不可移动/缩放/旋转，但保留可点选（便于解锁） */
  private applyLockState(o: fabric.Object) {
    const locked = !!cf(o)._locked
    o.set({
      lockMovementX: locked,
      lockMovementY: locked,
      lockScalingX: locked,
      lockScalingY: locked,
      lockRotation: locked,
      hasControls: !locked,
      hoverCursor: locked ? 'not-allowed' : 'move',
    } as never)
  }

  /** 锁定/解锁当前选中对象（锁定后不可拖动/缩放/旋转，但仍可点选以解锁） */
  setActiveLocked(locked: boolean) {
    const obj = this.getActiveObject()
    if (!obj) return
    cf(obj)._locked = locked
    this.applyLockState(obj)
    this.patchSerialize(obj)
    this.emitActive(obj)
    this.events.onDirty()
  }

  /**
   * 导出/批量打印期间把画布置为只读：批量渲染要 await 多帧，若用户此刻拖动/删除对象，
   * 截出来的就是半成品。置只读后 fabric 不再响应对象选择与变换，导出结束由调用方复位。
   * （不改变对象的 _locked 业务状态，仅临时关闭交互。）
   */
  setReadOnly(readOnly: boolean) {
    if (this._readOnly === readOnly) return
    this._readOnly = readOnly
    this.canvas.selection = !readOnly
    for (const o of this.canvas.getObjects()) {
      if ((o as { excludeFromExport?: boolean }).excludeFromExport) continue // 纸卡不参与
      o.selectable = !readOnly
      o.evented = !readOnly
      // 已业务锁定的对象在解除只读后仍需保持不可变换（由 applyLockState 统一恢复）
      if (!readOnly) this.applyLockState(o)
    }
    if (readOnly) this.canvas.discardActiveObject()
    this.canvas.requestRenderAll()
  }

  /** 解锁画布上全部对象 */
  unlockAll() {
    let changed = false
    for (const o of this.flattenTopLevel()) {
      if (cf(o)._locked) {
        cf(o)._locked = false
        this.applyLockState(o)
        this.patchSerialize(o)
        changed = true
      }
    }
    if (changed) {
      this.emitActive()
      this.events.onDirty()
    }
  }

  /** 设置当前条码对象的渲染设置并重绘 */
  setBarcodeSettings(patch: Partial<BarcodeRenderSettings>) {
    const obj = this.getActiveObject()
    if (!obj) return
    const c = cf(obj)
    if (!isBarcodeKind(c.kind)) return
    const type = c._barcodeType ?? 'code128'
    const cur = c._barcodeSettings ?? defaultSettingsFor(type)
    c._barcodeSettings = { ...cur, ...patch }
    this.patchSerialize(obj)
    this.rerenderBarcode(obj)
    this.emitActive()
    this.events.onDirty()
  }

  /** 设置当前条码对象的人读文字与条区的额外距离(mm)。>0 拉开，<0 拉近 */
  setBarcodeTextOffset(mm: number) {
    const obj = this.getActiveObject()
    if (!obj) return
    const c = cf(obj)
    if (!isBarcodeKind(c.kind)) return
    const next = Math.max(-10, Math.min(30, mm))
    if ((c._barcodeTextOffsetMm || 0) === next) return
    c._barcodeTextOffsetMm = next
    this.patchSerialize(obj)
    this.rerenderBarcode(obj)
    this.emitActive()
    this.events.onDirty()
  }

  /** 设置当前条码对象的「对齐 / 生长锚点」：内容变长条码变宽时以哪一侧为基准扩展 */
  setBarcodeAlign(align: BarcodeAlign) {
    const obj = this.getActiveObject()
    if (!obj) return
    const c = cf(obj)
    if (!isBarcodeKind(c.kind)) return
    if ((c._barcodeAlign ?? 'left') === align) return
    c._barcodeAlign = align
    this.setAlignOrigin(obj, align)
    this.patchSerialize(obj)
    this.canvas.requestRenderAll()
    this.emitActive(obj)
    this.events.onDirty()
  }

  /**
   * 把对象的水平原点切到对齐档位，**保持当前视觉位置不动**。
   *
   * fabric 里 `left` 指的是「原点」的位置：originX='left' 时是左边缘、'center' 时是中心、
   * 'right' 时是右边缘。所以换挡时必须把 left 补上两边原点偏移之差，否则对象会整体跳动
   * （靠左→靠右会瞬间左移一整个宽度）。换挡后锚点即生效：之后内容变长、条码变宽时，
   * 新的宽度按新原点展开 —— 靠右就是「右边缘钉住、向左长」。
   *
   * ⚠️ 用 `getScaledWidth()`（= width × scaleX）算偏移，不能用旋转后的包围盒宽度：
   *    originX 的偏移是在**对象自身坐标轴**上量的，与旋转无关。
   */
  private setAlignOrigin(obj: fabric.Object, align: BarcodeAlign) {
    const ratio = (o: string | undefined) => (o === 'center' ? 0.5 : o === 'right' ? 1 : 0)
    const delta = (ratio(align) - ratio(obj.originX)) * obj.getScaledWidth()
    obj.set({ originX: align, left: (obj.left ?? 0) + delta })
    obj.setCoords()
  }

  /** 设置当前内容对象的前缀/后缀（纯文本，拼在内容前后） */
  setContentDecor(patch: Partial<{ prefix: string; suffix: string }>) {
    const obj = this.getActiveObject()
    if (!obj) return
    const c = cf(obj)
    if (!isContentKind(c.kind)) return
    if (patch.prefix !== undefined) c._prefix = patch.prefix
    if (patch.suffix !== undefined) c._suffix = patch.suffix
    this.patchSerialize(obj)
    this.refreshContentObject(obj)
    this.refreshDependents(obj)
    this.canvas.requestRenderAll()
    this.emitActive()
    this.events.onDirty()
  }

  /** 设置当前内容对象的序列化配置（或清空）。开启时不改用户原文，渲染时自动让“末尾数字”逐张递增 */
  setActiveSerial(serial: SerialSpec | null) {
    const obj = this.getActiveObject()
    if (!obj) return
    const c = cf(obj)
    if (!isContentKind(c.kind)) return
    if (serial && serial.enabled) {
      // 补零位数默认以面板设定为准。
      // 仅当该对象此前【尚未启用】序列化时，才按文本末尾数字段的位数兜底一次，
      // 作为“初始值 = 文本框数字位数”的默认（原文 “001” → 3、“123” → 3、“1” → 1）。
      // 一旦已启用，用户后续改「补零位数」一律以其为准，绝不再被原文位数覆盖。
      let minDigits = Math.max(1, serial.minDigits)
      if (!c._serial?.enabled) {
        const run = /(\d+)\s*$/.exec(this.coreDesign(c))
        const digits = run ? run[1] : ''
        if (digits.length >= 1) minDigits = Math.max(1, digits.length)
      }
      // 起始值尊重用户在面板设定的值（默认 1）；step 照用
      c._serial = { enabled: true, start: Math.max(0, serial.start), step: Math.max(1, serial.step), minDigits }
    } else {
      c._serial = undefined
    }
    this.patchSerialize(obj)
    // 刷新显示（文本按预览态刷新；条码重绘）——原文保持不变，仅显示/导出按序号套用
    if (c.kind === 'text') this.refreshContentObject(obj)
    else this.rerenderBarcode(obj)
    this.refreshDependents(obj)
    this.canvas.requestRenderAll()
    this.emitActive()
    this.events.onDirty()
  }

  /**
   * 序列化的“末尾数字”落地：把对象的最终显示文案里末尾数字段换成当前序号。
   * - 若内容含 {{seq}} 走老路径（applySeq 已替换），此处不改；
   * - 否则若 serial 开启，把末尾数字段换成 formatSeq(当前值)；无数字段则末尾追加。
   * 预览态(seqValue=null)显示首张值 = formatSeq(spec.start)。
   */
  private finalizeSerial(o: fabric.Object, resolved: string): string {
    const c = cf(o)
    const spec = c._serial
    if (!spec?.enabled) return resolved
    if (SERIAL_PROBE.test(resolved)) return resolved // 已含 {{seq}}（老模板），applySeq 已处理
    // 批量打印中(seqIndex 有值)：按**本对象自己的** start/step 计算，
    // 这样多张纸各自定义起始值时不会互相串号（旧实现吃全局字符串，会导致纸2 显示纸1 的号）。
    const val =
      this.seqIndex != null
        ? formatSeq(spec.start + this.seqIndex * Math.max(1, spec.step), Math.max(1, spec.minDigits))
        : (this.seqValue ?? formatSeq(spec.start, Math.max(1, spec.minDigits)))
    const m = /^(.*?)(\d+)$/.exec(resolved)
    return m ? m[1] + val : resolved + val
  }


  /**
   * 名称是否可用：同一张纸内唯一（排除自身）。
   * 多标签下改为「纸内唯一」——否则第二张纸想绑定同一个表头名（如「商品名」）会被
   * 自动改名成「商品名1」，而 bindingHeader 要求名称与表头完全一致 → 数据绑定静默失效。
   */
  private isNameAvailable(name: string, self: fabric.Object): boolean {
    const pid = this.paperFor(self).id
    return !this.flattenTopLevel().some(
      (o) => o !== self && this.paperFor(o).id === pid && cf(o)._name === name,
    )
  }

  /** 内容对象的核心原文（不含前后缀） */
  private coreDesign(c: ReturnType<typeof cf>): string {
    return c.kind === 'text'
      ? (c.originalText ?? '')
      : (c._barcodeRaw ?? '')
  }

  /** 内容对象的前后缀 + 核心原文（序列变量 {{seq}} 仍保留，待解析） */
  private decoratedDesign(c: ReturnType<typeof cf>): string {
    const prefix = c._prefix ?? ''
    const suffix = c._suffix ?? ''
    return prefix + this.coreDesign(c) + suffix
  }

  /** 用当前批量序列值（或示例值）替换串里的 {{seq}} */
  private applySeq(s: string): string {
    // 用非 global 探针判断，避免全局正则 lastIndex 状态污染后续 replace
    if (!SERIAL_PROBE.test(s)) return s
    const val = this.seqValue ?? DEFAULT_SEQ_LABEL
    return s.replace(SERIAL_TOKEN, () => val)
  }

  /** 对象名称是否绑定到表格某列（表头同名且有数据）。绑定后整段内容由该列当前行单元格值替换。 */
  private bindingHeader(c: ReturnType<typeof cf>): string | null {
    if (!this.headers.length || !this.dataRows.length) return null
    const nm = c._name
    if (nm && this.headers.includes(nm)) return nm
    return null
  }

  /** 对象的“设计原文”，已处理「名称=表头」的列绑定（无需在内容里写 {{}}）。 */
  private rawDesign(c: ReturnType<typeof cf>): string {
    const h = this.bindingHeader(c)
    if (h) {
      // 绑定列：设计态显示列名（直观体现“名称=表头”的对应），预览/打印时显示该列具体数据
      const core = this.previewRow ? String(this.previewRow[h] ?? '') : h
      return (c._prefix ?? '') + core + (c._suffix ?? '')
    }
    return this.decoratedDesign(c)
  }

  /** 收集内容对象的“名称 -> 当前显示文案”映射，供跨对象引用解析。
   *  关键：对已命名且开启了序列化的对象，额外套用 finalizeSerial（末尾数字替换当前 seqValue），
   *  使 {{对象名}} 引用的对象（如条码引用序列化文本框）能逐张跟随递增。
   *  绑定到表格列的对象，其映射值取该列当前行单元格值（见 rawDesign），使跨对象引用也跟随数据。 */
  private buildContentMap(paperId?: string): Map<string, string> {
    const map = new Map<string, string>()
    this.flattenTopLevel().forEach((o) => {
      const c = cf(o)
      if (!isContentKind(c.kind)) return
      const nm = c._name
      if (!nm) return
      // 多标签：默认只收集「同一张纸」内的名称，避免跨纸同名互相顶掉
      if (paperId && this.paperFor(o).id !== paperId) return
      map.set(nm, this.finalizeSerial(o, this.applySeq(this.rawDesign(c))))
    })
    return map
  }

  /**
   * 解析某对象的显示内容：序列号 → 数据列 → 跨对象名称引用（递归）。
   * 多标签时跨对象引用只在同一张纸内查找（不同纸可以有同名对象，互不影响）。
   * @param prebuilt 批量刷新时由调用方预先构建好的 contentMap，避免逐对象重建导致 O(n²)
   */
  private resolveDesign(design: string, self?: fabric.Object, prebuilt?: Map<string, string>): string {
    const pid = self ? this.paperFor(self).id : undefined
    const map = prebuilt ?? this.buildContentMap(pid)
    return resolveContent(this.applySeq(design), this.previewRow, map, new Set())
  }

  /** 计算某内容对象要显示的最终文案（含前后缀/序列号/变量/跨对象/列绑定） */
  private displayContent(o: fabric.Object, prebuilt?: Map<string, string>): string {
    const c = cf(o)
    return this.finalizeSerial(o, this.resolveDesign(this.rawDesign(c), o, prebuilt))
  }

  /** 对外：取对象当前应显示的文案（已套用当前 seqValue/末尾数字序列化），供矢量导出使用 */
  contentStringFor(o: fabric.Object): string {
    const c = cf(o)
    if (isContentKind(c.kind)) return this.displayContent(o)
    return ''
  }

  /** 对外：取内容对象未套末尾数字序列化前的“原始设计（含 {{}} 标记）” */
  contentDesignFor(o: fabric.Object): string {
    const c = cf(o)
    if (!isContentKind(c.kind)) return ''
    return this.decoratedDesign(c)
  }

  /** 按对象当前设计原文刷新其显示内容 */
  private refreshContentObject(o: fabric.Object, prebuilt?: Map<string, string>) {
    const c = cf(o)
    if (isBarcodeKind(c.kind)) {
      if (c._barcodeRaw != null || c._prefix != null || c._suffix != null) this.rerenderBarcode(o)
    } else if (c.kind === 'text') {
      const next = this.displayContent(o, prebuilt)
      if (o instanceof fabric.Textbox) {
        const cur = o as fabric.Textbox
        cur.set({ text: next })
        cur.initDimensions()
        cur.setCoords()
      } else {
        ;(o as fabric.IText).set({ text: next })
      }
    }
  }

  /** 内容对象增删改/重命名后，级联刷新可能引用其名称的其它内容对象 */
  private refreshDependents(self: fabric.Object) {
    this.flattenTopLevel()
      .filter((o) => o !== self && isContentKind(cf(o).kind))
      .forEach((o) => this.refreshContentObject(o))
    this.canvas.requestRenderAll()
  }

  async addImageFile(file: File): Promise<void> {
    // 用内嵌 dataURL 而非临时 blob 链接：blob 仅在当前会话有效，
    // 写入模板(JSON)后再加载会因链接失效而丢图；dataURL 自包含、可持久化。
    const url = await fileToDataUrl(file)
    const imgEl = await loadImageEl(url)
    const img = new fabric.Image(imgEl)
    const maxW = this.paperPxW * 0.6
    const ratio = Math.min(1, maxW / (imgEl.width || 1))
    img.set({ scaleX: ratio, scaleY: ratio })
    img.set({
      left: this.paperCenter().x - ((imgEl.width || 0) * ratio) / 2,
      top: this.paperCenter().y - ((imgEl.height || 0) * ratio) / 2,
    })
    this.finalizeObject(img, 'image', null)
  }

  /**
   * 插入**位图素材**（扩展图标库里 PNG/JPG 的那部分，如 GHS/ADR 危险品标签、
   * 认证标、能效标 —— 这些只有位图版）。
   *
   * 与 addSvgAsset 的矢量对象分流：位图既不能换色、也没法矢量重绘，
   * 导出时由 jsPDF 以 `addImage` 嵌入（见 vectorExport.drawImageLeaf）。
   * 图源先转成内嵌 dataURL 再建对象 —— 与 addImageFile 同理，
   * 保证写进模板 JSON 之后重新打开时图源依然有效。
   */
  async addRasterAsset(p: { url: string; name?: string; targetMm?: number }): Promise<boolean> {
    try {
      const res = await fetch(p.url)
      if (!res.ok) return false
      const dataUrl = await blobToDataUrl(await res.blob())
      const imgEl = await loadImageEl(dataUrl)
      const w = imgEl.naturalWidth || imgEl.width || 1
      const h = imgEl.naturalHeight || imgEl.height || 1
      const img = new fabric.Image(imgEl)
      const ratio = mmToPx(p.targetMm ?? 15) / w
      img.set({ scaleX: ratio, scaleY: ratio })
      img.set({
        left: this.paperCenter().x - (w * ratio) / 2,
        top: this.paperCenter().y - (h * ratio) / 2,
      })
      this.finalizeObject(img, 'image', null)
      return true
    } catch {
      return false
    }
  }

  /** 把 SVG 内部片段按 viewBox / 配色拼成完整 SVG 字符串（插入与矢量导出共用） */
  composeAssetSvg(p: {
    inner: string
    viewBox: string
    isStroke: boolean
    color?: string
    strokeWidth?: number
  }): string {
    const vb = p.viewBox || '0 0 24 24'
    const c = p.color || '#000000'
    // 扩展图标库：图形自带线宽与坐标系（有的 viewBox 3200 见方、stroke-width 116），
    // 颜色靠编译期埋下的 `__C__` 占位符驱动 —— 只回填颜色，绝不套用本编辑器的线宽，
    // 否则細线稿会被 stroke-width=1.6 顶成一片黑。
    if (p.inner.includes('__C__')) {
      return (
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" fill="${c}" stroke="${c}">` +
        `${p.inner.replace(/__C__/g, c)}</svg>`
      )
    }
    const head = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}">`
    if (!p.isStroke) return head + p.inner + '</svg>'
    const sw = p.strokeWidth ?? 2
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" fill="none" stroke="${c}" ` +
      `stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${p.inner}</svg>`
    )
  }

  /** 取对象上的 SVG 素材数据（用于矢量导出整段重绘） */
  svgDataFor(obj: fabric.Object): { svg: string; isStroke: boolean } | null {
    const c = cf(obj)
    if (c.kind !== 'svg' || !c._svgInner) return null
    return {
      svg: this.composeAssetSvg({
        inner: c._svgInner,
        viewBox: c._svgViewBox ?? '0 0 24 24',
        isStroke: !!c._svgIsStroke,
        color: c._svgColor,
        strokeWidth: c._svgStrokeWidth,
      }),
      isStroke: !!c._svgIsStroke,
    }
  }

  /**
   * 插入素材（图标/表情）为矢量对象。
   * 与 addImageFile（位图）不同：素材以 fabric.Group + path 子对象保存，
   * 缩放不失真，PDF 导出时按整段 SVG 矢量重绘（见 vectorExport）。
   */
  async addSvgAsset(p: {
    inner: string
    viewBox: string
    isStroke: boolean
    color?: string
    strokeWidth?: number
    name?: string
    targetMm?: number
  }): Promise<boolean> {
    const full = this.composeAssetSvg(p)
    const parsed = await new Promise<{ objects: fabric.Object[]; options: Record<string, unknown> } | null>((resolve) => {
      try {
        fabric.loadSVGFromString(full, (objects, options) => resolve({ objects: objects ?? [], options: (options ?? {}) as Record<string, unknown> }))
      } catch {
        resolve(null)
      }
    })
    if (!parsed || parsed.objects.length === 0) return false

    let group: fabric.Object
    try {
      group = fabric.util.groupSVGElements(parsed.objects as fabric.Object[], parsed.options as unknown as never)
    } catch {
      return false
    }
    if (!group) return false

    const rawW = parsed.objects.reduce((mx, o) => Math.max(mx, o.getBoundingRect(true).width), 0)
    const rawH = parsed.objects.reduce((mx, o) => Math.max(mx, o.getBoundingRect(true).height), 0)
    const base = Math.max(rawW, rawH) || 24
    const target = mmToPx(p.targetMm ?? 15)
    const k = target / base
    group.set({ scaleX: k, scaleY: k, originX: 'left', originY: 'top' })

    const c = cf(group)
    c._svgInner = p.inner
    c._svgViewBox = p.viewBox
    c._svgIsStroke = p.isStroke
    c._svgColor = p.isStroke ? p.color ?? '#000000' : undefined
    c._svgStrokeWidth = p.isStroke ? p.strokeWidth ?? 2 : undefined
    if (p.name) c._name = p.name

    const w = group.getBoundingRect(true).width
    const h = group.getBoundingRect(true).height
    group.set({ left: this.paperCenter().x - w / 2, top: this.paperCenter().y - h / 2 })

    this.finalizeObject(group, 'svg', null)
    return true
  }

  /**
   * 重算 SVG 线稿组的包围盒并锁定中心：改描边宽度会增大子路径的渲染范围，
   * 若不刷新组的包围盒，内容会朝组的 left/top 锚点外扩（表现为「往右下角长」）。
   * 这里先记下中心，_calcBounds 重算尺寸后把中心还原，保证图标位置纹丝不动。
   */
  private relayoutSvgGroup(group: fabric.Group) {
    const ctr = group.getCenterPoint()
    ;(group as unknown as { _calcBounds: () => void })._calcBounds()
    group.setPositionByOrigin(ctr, 'center', 'center')
    group.setCoords()
  }

  /**
   * 修改当前 SVG 线稿素材的线条粗细（px）。
   * 值直接写进 viewBox 坐标（与 PDF 矢量导出的 stroke-width 同一套单位），
   * 画布上的视觉粗细 = 该值 × 素材缩放比 —— 放大图标时线条跟着变粗，与导出一致。
   * 描边保持 strokeUniform=false，使其随编组缩放；改完后重算包围盒并锁定中心，避免位移。
   */
  setActiveAssetStrokeWidth(widthPx: number): boolean {
    const obj = this.getActiveObject()
    if (!obj) return false
    const c = cf(obj)
    if (c.kind !== 'svg' || !c._svgIsStroke) return false
    const w = Math.max(0.1, Math.min(20, Math.round(widthPx * 10) / 10))
    c._svgStrokeWidth = w
    const grp = obj as fabric.Group
    const kids = grp.getObjects?.() ?? []
    for (const kid of kids) {
      if (!kid.stroke || kid.stroke === 'none') continue
      kid.set({ strokeWidth: w }) // 保持 strokeUniform 默认 false，描边随编组缩放
    }
    this.relayoutSvgGroup(grp)
    this.canvas.requestRenderAll()
    this.events.onDirty()
    this.emitActive(obj)
    return true
  }

  /** 修改当前素材对象的线稿颜色（仅线稿类图标有效）；彩绘 emoji 不支持改色 */
  setActiveAssetColor(color: string): boolean {
    const obj = this.getActiveObject()
    if (!obj) return false
    const c = cf(obj)
    if (c.kind !== 'svg' || !c._svgIsStroke) return false
    c._svgColor = color
    const grp = obj as fabric.Group
    const kids = grp.getObjects?.() ?? []
    for (const kid of kids) {
      const kCf = cf(kid)
      if (kCf.fill && kCf.fill !== 'none') continue // 保留原色填充
      // 只改颜色，不碰 strokeUniform：保持与「线条粗细」一致的缩放行为，避免改色后线条变细
      kid.set({ stroke: color })
    }
    this.canvas.requestRenderAll()
    this.events.onDirty()
    this.emitActive(obj)
    return true
  }

  /**
   * 收尾一个新对象：补自定义字段 + 序列化补丁 + 加进画布 + 选中。
   * @param activate 是否把新对象设为当前选中并广播（默认 true）。
   *   批量导入（模板库/成组元素）时传 false —— 否则每加一个对象都会
   *   重新设一次选中并 emitActive，既触发无谓的 React 重渲染，也会让
   *   属性面板在导入过程中反复闪现中间对象。
   */
  private finalizeObject(
    obj: fabric.Object,
    kind: ElementKind,
    text: string | null,
    activate = true,
  ) {
    const c = cf(obj)
    c.id = newId()
    c.kind = kind
    if (kind === 'text' && text != null) c.originalText = text
    if (isBarcodeKind(kind) && text != null) c._barcodeRaw = text
    // 默认命名；加载模板时若已有名称则沿用（见 loadFromJSON）
    if (c._name === undefined) c._name = defaultName(kind)
    this.patchSerialize(obj)
    this.applyLockState(obj)
    this.canvas.add(obj)
    if (!activate) return
    this.canvas.setActiveObject(obj)
    this.canvas.requestRenderAll()
    this.emitActive(obj)
  }

  /** 让 toJSON 携带自定义字段，保证模板往返不丢内容 */
  private patchSerialize(obj: fabric.Object) {
    const c = cf(obj)
    const base = obj.toObject.bind(obj)
    obj.toObject = (extraProps?: string[]) => {
      const props = (base(extraProps) as Record<string, unknown>) ?? {}
      props.id = c.id
      props.kind = c.kind
      props._name = c._name
      if (c._locked) props._locked = true
      if (isBarcodeKind(c.kind)) {
        props._barcodeRaw = c._barcodeRaw
        props._barcodeType = c._barcodeType
        props._barcodeTargetMm = c._barcodeTargetMm
        props._barcodeSettings = c._barcodeSettings
        if (c._barcodeUnit) props._barcodeUnit = c._barcodeUnit
        if (c._barcodeTextOffsetMm) props._barcodeTextOffsetMm = c._barcodeTextOffsetMm
        // 对齐/生长锚点：非默认（靠左）才写，老模板读不到该字段时按 'left' 处理
        if (c._barcodeAlign && c._barcodeAlign !== 'left') props._barcodeAlign = c._barcodeAlign
        if (typeof c._barcodeTextScale === 'number') props._barcodeTextScale = c._barcodeTextScale
        // 矢量条码组：模块矩形不写入 JSON（几百个对象太臃肿），载入时按元数据重建
        if (obj.type === 'group') delete (props as { objects?: unknown }).objects
      }
      if (c.kind === 'text') {
        props.originalText = c.originalText
        if (c._textParagraph) props._textParagraph = true
        if (c._letterSpacingPt) props._letterSpacingPt = c._letterSpacingPt
      }
      if (c.kind === 'shape') props._shapeType = c._shapeType ?? 'ellipse'
      if (c.kind === 'svg') {
        props._svgInner = c._svgInner
        props._svgViewBox = c._svgViewBox
        props._svgIsStroke = !!c._svgIsStroke
        if (c._svgColor) props._svgColor = c._svgColor
        if (typeof c._svgStrokeWidth === 'number') props._svgStrokeWidth = c._svgStrokeWidth
      }
      if (isContentKind(c.kind)) {
        if (c._prefix) props._prefix = c._prefix
        if (c._suffix) props._suffix = c._suffix
        if (c._serial) props._serial = c._serial
      }
      return props
    }
  }

  removeActive() {
    const active = this.canvas.getActiveObjects()
    if (active.length === 0) {
      this.events.onActiveChange(null)
      return
    }
    active.forEach((o) => this.canvas.remove(o))
    // 移除后刷新剩余内容对象（引用被删对象名的占位会更新）
    this.refreshAllContent()
    this.canvas.discardActiveObject()
    this.canvas.requestRenderAll()
    this.events.onActiveChange(null)
    this.events.onSelection?.({ count: 0, isGroup: false, isBarcodeGroup: false })
  }

  // ── 变量替换 / 预览 ─────────────────────────────────────
  /** 导入表格后登记表头与数据行，供「文本框名称 = 表头」的自动列绑定 */
  setSpreadsheet(headers: string[], rows: DataRow[]) {
    this.headers = headers
    this.dataRows = rows
    this.refreshAllContent()
    this.events.onDirty()
  }

  setPreviewRow(row: DataRow | null) {
    this.previewRow = row
    this.refreshAllContent()
    this.events.onDirty()
  }

  /** 供批量打印逐张切换序列号后重绘整张（老路径：直接给已格式化的字符串） */
  setSeqValue(value: string | null) {
    this.seqValue = value
    this.seqIndex = null
    this.refreshAllContent()
  }

  /**
   * 供批量打印逐张切换页码后重绘整张（新路径，多标签必须走这个）。
   * 传页码而非字符串：每个序列化对象按自己的 start/step/minDigits 计算显示值，
   * 于是不同纸可以有不同起始值而互不串号。
   */
  setSeqIndex(index: number | null) {
    this.seqIndex = index
    // {{seq}} 是全局占位符，仍用统一字符串（按首个序列化配置格式化）
    this.seqValue = index == null ? null : this.seqLabelFor(index)
    this.refreshAllContent()
  }

  private rerenderBarcode(obj: fabric.Object) {
    const c = cf(obj)
    const type = c._barcodeType ?? 'code128'
    const settings = c._barcodeSettings ?? defaultSettingsFor(type)
    // 显示文案 = 前后缀 + 原文 + 序列/列/跨对象解析（序列化对象再套末尾数字）
    const text = this.finalizeSerial(obj, this.resolveDesign(this.decoratedDesign(c), obj))
    // ⚠️ 内容指纹相同就不要再重建。refreshAllContent 会遍历画布上所有条码，
    // 无条件重建不仅白跑一次 bwip-js + 几十个矩形，更关键的是：条码若嵌在
    // 编组/多选里，重建会把新对象挂到画布顶层、并沿用「父容器内的局部坐标」，
    // 表现为解组/刷新后条码凭空消失（飞到工作区原点附近）。
    // getObjects().length 用于排除「载入模板后只剩空壳组」的情况。
    const hasRects = ((obj as fabric.Group).getObjects?.() ?? []).length > 0
    if (hasRects && c._barcodeRendered === barcodeSignature(type, text, settings, c._barcodeTextOffsetMm || 0)) {
      return
    }
    try {
      renderBarcodeVectorRects(type, text, settings) // 校验内容合法性（不合法则保留上一帧）
    } catch {
      return
    }
    // 矢量重建（同步完成，无 setSrc 异步等待）
    this.replaceBarcodeObject(obj, type, text, settings)
  }

  // ── 批量序列化 ────────────────────────────────────────────
  /** 画布上第一个「已启用」的序列化配置（内容可为末尾数字递增，也可含 {{seq}}） */
  firstSerial(): SerialSpec | null {
    for (const o of this.flattenTopLevel()) {
      const c = cf(o)
      if (!isContentKind(c.kind) || !c._serial?.enabled) continue
      return c._serial
    }
    return null
  }

  /** 是否存在需要批量递增的序列号 */
  hasActiveSerial(): boolean {
    return this.firstSerial() != null
  }

  /** 是否存在“名称与表头同名”的绑定对象（用于判断是否按表格行批量打印） */
  hasDataBindings(): boolean {
    if (!this.headers.length || !this.dataRows.length) return false
    return this.flattenTopLevel().some((o) => {
      const c = cf(o)
      return isContentKind(c.kind) && !!c._name && this.headers.includes(c._name)
    })
  }

  /** 第 index 张（0 起）应显示的序号串；无序列化配置则返回 null */
  seqLabelFor(index: number): string | null {
    const spec = this.firstSerial()
    if (!spec) return null
    const step = Math.max(1, spec.step)
    return formatSeq(spec.start + index * step, spec.minDigits)
  }

  // ── 序列化 / 导入导出 ───────────────────────────────────
  toJSON(): Record<string, unknown> {
    // 序列化时剔除 viewportTransform,避免把屏幕缩放/平移写进模板,导入后视图由 App 重新设定
    const data = this.canvas.toJSON() as Record<string, unknown>
    delete (data as { viewportTransform?: unknown }).viewportTransform
    // 纸卡是渲染产物：不进模板（载入时按 papers 重建），否则每次往返都会多叠一层白底
    const objs = Array.isArray(data.objects) ? (data.objects as Array<Record<string, unknown>>) : []
    data.objects = objs.filter((o) => !o.excludeFromExport)
    // 多标签：纸张布局（含各自尺寸与位置）随模板保存
    data._papers = this.papers.map((p) => ({ ...p }))
    // 当前选中的是第几张（撤销/重做要连「正在编辑哪张纸」一起回滚）
    data._activePaperId = this.activePaperIdValue
    return data
  }

  /**
   * 以指定倍率把"某张纸区域"导出为高清 PNG dataURL。
   *
   * 实现要点：走 fabric 的 `toCanvasElement(multiplier, cropping)` —— 它内部把
   * viewportTransform 的 zoom 乘上 multiplier 后**重新渲染**（矢量按目标分辨率重绘），
   * 而不是把屏幕分辨率位图拉大。
   *
   * 【根因记录】旧实现是「取屏幕画布 → drawImage 采样纸张区域 → 拉大成目标尺寸」：
   * 源画布物理分辨率 = 屏幕 CSS 尺寸 × devicePixelRatio，与导出倍率无关。
   * 实测：100mm 标签在 DPR=2 的屏幕上，可采样到的物理像素仅 ≈756px，
   * 却要输出 1512px（scale=4）→ 每输出像素仅 0.5 个源像素，纯插值放大，必然发虚。
   * 因此倍率调多高都没用，必须改成「按倍率矢量重绘」。
   *
   * 导出期间把视口变换清零（cropping 以工作区绝对坐标为准）并在结束后恢复。
   * 供栅格 PNG / 打印 / 批量序列化截图复用。
   */
  toPaperDataUrl(scale = 4, paperId?: string): string {
    const paper = paperId ? this.getPaperBoundsPxFor(paperId) : this.getPaperBoundsPx()
    const prevVpt = (this.canvas.viewportTransform ?? [1, 0, 0, 1, 0, 0]).slice() as unknown as number[]
    const prevW = this.viewW
    const prevH = this.viewH
    const prevSel = this.canvas.getActiveObject()
    this.canvas.discardActiveObject()

    const prevRetina = this.canvas.enableRetinaScaling
    // 画布尺寸临时设为整个工作区（裁剪坐标以工作区绝对坐标计），
    // 视口变换置为 identity，让 crop 矩形与纸张矩形一一对应。
    this.canvas.setViewportTransform([1, 0, 0, 1, 0, 0])
    this.canvas.setDimensions({ width: this.workspaceW, height: this.workspaceH })

    // 浏览器 canvas 单边上限约 16384px（部分环境 32767），超限会静默输出空白。
    // 对外输出尺寸做钳制，必要时等比降低 effectiveScale，保证大标签仍能导出。
    const MAX_DIM = 16384
    let effectiveScale = scale
    const maxSide = Math.max(paper.width, paper.height) * scale
    if (maxSide > MAX_DIM) {
      effectiveScale = scale * (MAX_DIM / maxSide)
      console.warn(
        `[canvasEngine] 标签过大，超出 canvas 上限，导出缩放 ${scale} → ${effectiveScale.toFixed(2)}`,
      )
    }

    // ⚠️ 关闭 retina 让 multiplier 成为唯一的缩放因子，
    // 否则最终倍率 = multiplier × devicePixelRatio，会因屏幕不同而输出尺寸不可控。
    this.canvas.enableRetinaScaling = false
    // 纸卡带 1px 灰描边（设计稿里用于区分纸张边界），导出时隐藏，改垫纯白底，
    // 避免 PNG 四边出现灰线。
    const hiddenCards: fabric.Object[] = []
    for (const [, r] of this.paperRects) {
      if (r.visible) {
        r.set('visible', false)
        hiddenCards.push(r)
      }
    }
    // 文本的「区域框」（边框 + 底色）只服务于画布排版，导出前剥离，否则 PNG 上会留下灰块。
    // 矢量 PDF / 打印走的 drawTextObject 本就不绘制文本的背景与描边，
    // 这里剥离后三条输出链路行为才一致。
    const strippedRegion: Array<{
      o: fabric.Object
      /** null = 该项未被剥离，恢复时跳过 */
      stroke: string | null
      strokeWidth: number
      bg: string | null
    }> = []
    for (const o of this.flattenTopLevel()) {
      const c = cf(o)
      if (c.kind !== 'text') continue
      const it = o as fabric.Object
      const rec = {
        o: it,
        stroke: null as string | null,
        strokeWidth: 0,
        bg: null as string | null,
      }
      // 只剥离「仍是默认区域框配色」的项；用户改过色（如真的要做有底色的标签块）说明是有意输出，保留
      if ((it.stroke as string) === REGION_DEFAULT.stroke) {
        rec.stroke = (it.stroke as string | null) ?? null
        rec.strokeWidth = it.strokeWidth ?? 0
        it.set({ stroke: 'transparent', strokeWidth: 0 })
      }
      if ((it.backgroundColor as string) === REGION_DEFAULT.backgroundColor) {
        rec.bg = (it.backgroundColor as string) ?? ''
        it.set({ backgroundColor: '' })
      }
      if (rec.stroke !== null || rec.bg !== null) strippedRegion.push(rec)
    }
    // ⚠️ 工作区底色是灰的（#e2e8f0）。隐藏纸卡后必须把 backgroundColor 也临时置白，
    // 否则导出的 PNG 会是灰底（而非白纸）。
    const prevBg = this.canvas.backgroundColor
    this.canvas.backgroundColor = '#ffffff'
    let url = ''
    try {
      const raw = this.canvas.toCanvasElement(effectiveScale, {
        left: paper.left,
        top: paper.top,
        width: paper.width,
        height: paper.height,
      })
      url = raw.toDataURL('image/png')
    } finally {
      this.canvas.backgroundColor = prevBg
      for (const s of strippedRegion) {
        if (s.stroke !== null) s.o.set({ stroke: s.stroke ?? undefined, strokeWidth: s.strokeWidth })
        if (s.bg !== null) s.o.set({ backgroundColor: s.bg ?? '' })
      }
      for (const r of hiddenCards) r.set('visible', true)
      this.canvas.enableRetinaScaling = prevRetina
      // 恢复视口与尺寸
      this.canvas.setDimensions({ width: prevW, height: prevH })
      this.canvas.setViewportTransform(
        prevVpt as unknown as [number, number, number, number, number, number],
      )
      if (prevSel) this.canvas.setActiveObject(prevSel)
      this.canvas.requestRenderAll()
    }
    return url
  }

  /** 单个对象：从源 JSON 恢复自定义字段并补打补丁（供 loadFromJSON 顶层与组内递归共用） */
  private restoreObjectFields(o: fabric.Object, s: Record<string, unknown>) {
    const c = cf(o)
    if (s.id) c.id = String(s.id)
    if (s.kind) c.kind = s.kind as ElementKind
    if (typeof s._name === 'string' && s._name) c._name = s._name
    if (s._locked) c._locked = true
    if (typeof s._barcodeRaw === 'string') {
      c._barcodeRaw = s._barcodeRaw
      c._barcodeType = (s._barcodeType as BarcodeType) ?? 'code128'
      c._barcodeTargetMm = (s._barcodeTargetMm as number) ?? undefined
      c._barcodeSettings = (s._barcodeSettings as BarcodeRenderSettings) ?? undefined
      c._barcodeUnit = (s._barcodeUnit as { w: number; barH: number; inkW?: number } | undefined) ?? undefined
      c._barcodeTextScale = (s._barcodeTextScale as number | undefined) ?? undefined
      c._barcodeTextOffsetMm = (s._barcodeTextOffsetMm as number | undefined) ?? 0
      // 对齐/生长锚点（老模板无此字段 → 'left'，行为与以前一致）
      c._barcodeAlign = (s._barcodeAlign as BarcodeAlign | undefined) ?? 'left'
      // ⚠️ originX 是**运行时**几何（不随 toJSON 的 left 自动还原到档位），必须显式同步：
      //    否则存档重开后 _barcodeAlign='right' 但 originX 仍是 'left'，条码会整体左移一个宽度，
      //    且之后改内容又变回「向右长」。这里**直接用 set 不补偿** —— 此时 left 来自 JSON，
      //    本身就是按该 originX 存下来的值，补偿反而会二次偏移。
      if (c._barcodeAlign !== 'left') {
        o.set({ originX: c._barcodeAlign })
        o.setCoords()
      }
    }
    if (c.kind === 'text' && typeof s.originalText === 'string') {
      c.originalText = s.originalText
    } else if (c.kind === 'text' && c.originalText === undefined) {
      c.originalText = (o as fabric.IText).text ?? ''
    }
    if (c.kind === 'text') {
      c._textParagraph = !!s._textParagraph
      if (typeof s._letterSpacingPt === 'number') c._letterSpacingPt = s._letterSpacingPt
    }
    if (isContentKind(c.kind)) {
      if (typeof s._prefix === 'string') c._prefix = s._prefix
      if (typeof s._suffix === 'string') c._suffix = s._suffix
      if (s._serial && typeof s._serial === 'object') c._serial = s._serial as SerialSpec
    }
    if (c.kind === 'shape') {
      c._shapeType = (s._shapeType as ShapeType) ?? 'ellipse'
      // fabric 重建 Polygon/Ellipse/Triangle 后重新补一个圆角为 0 的兜底
    }
    if (c.kind === 'svg') {
      if (typeof s._svgInner === 'string') c._svgInner = s._svgInner
      c._svgViewBox = (s._svgViewBox as string | undefined) ?? '0 0 24 24'
      c._svgIsStroke = !!s._svgIsStroke
      c._svgColor = (s._svgColor as string | undefined) ?? undefined
      c._svgStrokeWidth = (s._svgStrokeWidth as number | undefined) ?? 2
    }
    if (!c._name) c._name = defaultName((c.kind ?? 'text') as ElementKind) // 兼容无命名的旧模板
    // 还原锁定状态（载入模板后让锁定对象真正不可拖动/缩放）
    this.applyLockState(o)
    // 旧模板/历史对象：确保描边不随缩放变粗细
    if (isStrokeKind(c.kind)) {
      o.set({ strokeUniform: true } as never)
    }
    this.patchSerialize(o)
  }

  /** 递归恢复（含编组子对象）：srcObjs 与 canvasObjects 下标一一对应，遇 group 递归其子 */
  private restoreRecursive(canvasObjs: fabric.Object[], srcObjs: unknown[]) {
    canvasObjs.forEach((o, i) => {
      const s = (srcObjs[i] ?? {}) as Record<string, unknown>
      const srcIsGroup = s.type === 'group'
      const isGroupObj = this.isGroup(o)
      if (srcIsGroup && isGroupObj) {
        // 组自身也要恢复自定义字段（锁定态、命名、id、条码元数据…），
        // 早期只递归子对象、跳过原字段 → 锁定的用户编组保存后载入变可拖动。
        this.restoreObjectFields(o, s)
        const childSrc = Array.isArray(s.objects) ? (s.objects as unknown[]) : []
        this.restoreRecursive((o as fabric.Group).getObjects(), childSrc)
      } else {
        this.restoreObjectFields(o, s)
      }
    })
  }

  loadFromJSON(json: Record<string, unknown>) {
    const srcObjs = Array.isArray((json as { objects?: unknown[] }).objects)
      ? (json as { objects: unknown[] }).objects
      : []
    this._suppressDirty = true
    this.canvas.loadFromJSON(json, () => {
      const objs = this.canvas.getObjects()
      // 多标签：优先恢复模板里的纸张布局；旧模板无 _papers 时保持当前单纸不变
      const saved = (json as { _papers?: unknown })._papers
      if (Array.isArray(saved) && saved.length > 0) {
        const restored: PaperArea[] = []
        for (const raw of saved as Array<Record<string, unknown>>) {
          if (typeof raw.id !== 'string' || typeof raw.widthMm !== 'number') continue
          restored.push({
            id: raw.id,
            name: typeof raw.name === 'string' ? raw.name : '标签',
            widthMm: raw.widthMm,
            heightMm: typeof raw.heightMm === 'number' ? raw.heightMm : raw.widthMm,
            left: typeof raw.left === 'number' ? raw.left : mmToPx(WORKSPACE_MARGIN_MM),
            top: typeof raw.top === 'number' ? raw.top : mmToPx(WORKSPACE_MARGIN_MM),
          })
        }
        if (restored.length > 0) {
          this.papers = restored
          // 活动纸：旧模板/旧快照没有这个字段 → 退回第一张
          const act = (json as { _activePaperId?: unknown })._activePaperId
          this.activePaperIdValue =
            typeof act === 'string' && restored.some((p) => p.id === act) ? act : restored[0].id
          this.resizeWorkspace()
        }
      }
      this.restoreRecursive(objs, srcObjs)
      // 矢量条码组：JSON 里不含模块矩形，按元数据重建几何；
      // 旧模板的位图 Image 条码原样保留（兼容）。
      for (const o of [...objs]) {
        const c = cf(o)
        if (isBarcodeKind(c.kind) && o.type === 'group') {
          this.replaceBarcodeObject(o, c._barcodeType ?? 'code128', c._barcodeRaw ?? '', c._barcodeSettings ?? defaultSettingsFor(c._barcodeType ?? 'code128'))
        }
      }
      // 载入后重建"纸卡"背景 + 刷新纸外对象的半透明视觉
      this.recreatePaperRects()
      this.refreshOutsidePaperAll()
      this.refreshAllContent()
      // 导入后保持当前视口(避免模板里残留的视图变换影响显示)
      this.canvas.setViewportTransform([this.vptZoom, 0, 0, this.vptZoom, this.vptPan.x, this.vptPan.y])
      this.canvas.requestRenderAll()
      if (this.previewRow) this.setPreviewRow(this.previewRow)
      this._suppressDirty = false
      this.events.onDirty()
    })
  }

  /**
   * 新建标签（清空画布）：丢掉**全部**旧标签，回到「单张默认纸」。
   *
   * ⚠️ 旧实现只做了 canvas.clear() + 重建纸卡，`papers` 数组原样留着 ——
   * 于是「有 2 张标签、且第 2 张被改过尺寸」时点新建，画布上依旧留着那张
   * 改过尺寸的纸（而且它还是活动纸），面板显示的也是旧尺寸，与提示语
   * 「已新建空白标签，默认 150×100mm」自相矛盾，看着就是「画布跑偏了」。
   * 必须把多标签布局一并重置，才和「新建一个文件」的语义一致。
   */
  clearAll() {
    this.canvas.clear()
    // 清空后重建"纸卡"背景 + 恢复工作区底色
    this.canvas.backgroundColor = WORKSPACE_BG
    const margin = mmToPx(WORKSPACE_MARGIN_MM)
    const paper = this.makePaper('标签 1', DEFAULT_PAPER, margin, margin)
    this.papers = [paper]
    this.activePaperIdValue = paper.id
    this.resizeWorkspace()
    this.recreatePaperRects()
    this.canvas.requestRenderAll()
    this.events.onDirty()
    this.events.onActiveChange(null)
  }

  // ── 模板库：把公开模板落成画布内容 ──────────────────────
  /**
   * 载入「模板库」模板：重置为「单张纸 + 模板自带尺寸」，再按规格建出元素。
   *
   * 不复用 addText / addBarcode / addRect —— 那几个方法都按「纸张中心」摆放，
   * 而模板需要精确的绝对坐标。这里统一按「纸张左上角 + 规格偏移」定位；
   * 建好后与手工绘制的对象完全等价（可选中 / 编辑 / 编组 / 撤销 / 导出）。
   */
  loadTemplate(spec: TemplateSpec): void {
    // 撤销栈先记下"载入前"，Ctrl+Z 可退回原画布
    this.pushHistory()
    this.canvas.discardActiveObject()
    this._suppressDirty = true
    this.canvas.clear()
    this.canvas.backgroundColor = WORKSPACE_BG
    // 重置为单张纸：模板自带尺寸，清掉上一个文件残留的多标签布局
    const margin = mmToPx(WORKSPACE_MARGIN_MM)
    const paper = this.makePaper(
      spec.name || '标签 1',
      { widthMm: spec.widthMm, heightMm: spec.heightMm },
      margin,
      margin,
    )
    this.papers = [paper]
    this.activePaperIdValue = paper.id
    this.relayoutPapers()
    this.resizeWorkspace()
    this.recreatePaperRects()

    const ox = paper.left
    const oy = paper.top
    const paperRight = ox + mmToPx(spec.widthMm)

    for (const n of spec.nodes) {
      if (n.kind === 'text') {
        // ── 单行版式还原 ──────────────────────────────────────────────
        // 源模板的每个 text 元素都是单行标签（声明高度 ≈ 1 行），但框宽贴得很紧。
        // 我们的字体度量比原站略宽，且 fabric 折行是按「逐字符取整后的宽度」累加比较的，
        // 于是「框宽刚好等于自然宽度」也会折行 —— 实测 `IT-2024-0001`（自然 112.4px /
        // 框 113.4px）被折成 `IT-2024-000` + `1`，文本框高度翻倍后越出纸张下边界
        // （整块变半透明、且不进导出）。
        // 对策：① 量出真实单行宽度，留 2% + 2px 余量放宽框（对齐锚点不变）；
        //      ② 放宽不得越出纸张；纸面实在放不下时按比例微缩字号（幅度很小），
        //         而不是折行，也不是把文字推到纸外（纸外对象不导出）。
        const left = ox + mmToPx(n.xMm)
        const boxW = mmToPx(n.wMm)
        const topBase = oy + mmToPx(n.yMm)
        let fsPx = ptToPx(n.fontSizePt)
        let boxFinal = boxW
        let topAdj = 0
        // 字体按内容选：中文用黑体（与 PDF 内嵌 simhei 同源），纯拉丁用 Arial
        const font = templateFontFor(n.text)
        const natural = measureSingleLinePx(n.text, fsPx, n.bold, font)
        const wanted = natural * 1.02 + 2
        if (wanted > boxW) {
          const avail = availableBoxWidth(
            n.align,
            left,
            boxW,
            ox,
            paperRight,
          )
          if (wanted <= avail) {
            boxFinal = wanted
          } else {
            const k = Math.max(0.6, avail / wanted)
            fsPx *= k
            boxFinal = Math.max(boxW, wanted * k)
            // 原设计稿按原字号在块内垂直居中，缩字号后补回一半行高差
            topAdj = ((1 - k) * ptToPx(n.fontSizePt) * 1.16) / 2
          }
        }
        const leftFinal =
          n.align === 'center'
            ? left + (boxW - boxFinal) / 2
            : n.align === 'right'
              ? left + boxW - boxFinal
              : left
        const obj = new fabric.Textbox(n.text, {
          left: leftFinal,
          top: topBase + topAdj,
          width: boxFinal,
          fontSize: fsPx,
          fontFamily: font,
          fontWeight: n.bold ? 'bold' : 'normal',
          fill: '#000000',
          originX: 'left',
          originY: 'top',
          textAlign: n.align,
          splitByGrapheme: true,
        })
        this.finalizeObject(obj, 'text', n.text, false)
      } else if (n.kind === 'rect') {
        const obj = new fabric.Rect({
          left: ox + mmToPx(n.xMm),
          top: oy + mmToPx(n.yMm),
          width: mmToPx(n.wMm),
          height: mmToPx(n.hMm),
          // 实心块（表格分隔条/横线）用 fill；空心框用 stroke
          fill: n.filled ? '#000000' : 'transparent',
          stroke: n.filled ? '' : '#000000',
          strokeWidth: n.filled ? 0 : Math.max(0.5, mmToPx(n.strokeMm)),
          strokeUniform: true,
          originX: 'left',
          originY: 'top',
        })
        this.finalizeObject(obj, 'rect', null, false)
      } else {
        const group = this.buildBarcodeInto(n, ox, oy)
        if (group) this.finalizeObject(group, 'barcode', n.text, false)
      }
    }

    // 纸外半透明 / 内容刷新（相当于一次完整重载后的收尾）
    this.refreshOutsidePaperAll()
    this.refreshAllContent()
    this.canvas.requestRenderAll()
    this._suppressDirty = false
    this.events.onDirty()
    this.events.onActiveChange(null)
  }

  /**
   * 在模板给定的盒子里放下一个条码/二维码。
   * - 2D（二维码）：必须等比（否则扫不出来），按 min(盒宽/码宽, 盒高/码高) 缩放并水平居中；
   * - 1D：按框**拉伸填满** —— 原站把条码当「可拉伸的框」用（x/y/w/h 即元素的框），
   *   等比缩放会让它只占盒子的一小块（实测「货架位置标签」76mm 的框里条码仅 8mm 宽），
   *   与设计稿不符。横向拉伸不改变模块间的相对宽度，仍可正常扫描。
   * 返回条码组（未加入画布）。
   */
  private buildBarcodeInto(
    n: TplBarcodeNode,
    ox: number,
    oy: number,
  ): fabric.Group | null {
    let type = n.barcodeType
    let settings = defaultSettingsFor(type)
    let built = this.buildBarcodeGroup(type, n.text, settings)
    // 兜底：内容不符合该码制时（零售码位数/校验位不合规、含该码制不支持的字符…）
    // 退回 code128 渲染，保证「模板上有条码的位置一定有码」，而不是整块留白。
    // 属性面板会显示实际的码制，用户可自行改回。
    if (!built && type !== 'code128') {
      type = 'code128'
      settings = defaultSettingsFor(type)
      built = this.buildBarcodeGroup(type, n.text, settings)
    }
    if (!built) return null
    const { group, w, h, barH, inkW } = built
    const boxW = mmToPx(n.wMm)
    const boxH = mmToPx(n.hMm)
    const is2d = is2dType(type)
    let sx: number
    let sy: number
    if (is2d) {
      const k = Math.min(boxW / (w || 1), boxH / (h || 1))
      sx = sy = Number.isFinite(k) && k > 0 ? k : 1
    } else {
      const vx = boxW / (w || 1)
      const vy = boxH / (h || 1)
      sx = Number.isFinite(vx) && vx > 0 ? vx : 1
      sy = Number.isFinite(vy) && vy > 0 ? vy : 1
    }
    // 一维码：人读文字的字号是「绝对量」（不随拉伸/缩放变化），所以模板必须**一次性**定好合适的 pt，
    // 否则默认 9pt 会远大于这个小盒子里的文字带（模板里的小条码会被文字盖住）。
    // 按「文字带在设计比例下可容纳的字号」反算 pt —— 只在载入时算一次，
    // 之后「改字号」与「改尺寸」互不影响（这是解耦后的既定行为）。
    if (!is2d) {
      const bandUnit = h - barH
      if (bandUnit > 1) {
        settings.textSizePt = Math.max(4, Math.min(48, Math.round(pxToPt(bandUnit * sy * 0.8))))
      }
    }
    group.set({ scaleX: sx, scaleY: sy })

    const c = cf(group)
    c._barcodeType = type
    c._barcodeSettings = settings
    c._barcodeUnit = { w, barH, inkW }
    c._barcodeTextOffsetMm = 0
    c._barcodeTargetMm = roundMm(pxToMm(is2d ? Math.max(w, h) * sx : barH * sy))
    // 供 refreshAllContent 判断"内容没变就不用重建"
    c._barcodeRendered = barcodeSignature(type, n.text, settings, 0)
    // 一维码：人读文字按 pt 定标，避免被整组缩放压小
    if (!is2d) this.applyBarcodeTextCompensation(group)

    group.set({
      left: ox + mmToPx(n.xMm) + (is2d ? Math.max(0, (boxW - w * sx) / 2) : 0),
      top: oy + mmToPx(n.yMm),
    })
    return group
  }

  getObjectCount() {
    // 纸卡背景不计入"内容对象数"
    return this.canvas
      .getObjects()
      .filter((o) => !(o as { excludeFromExport?: boolean }).excludeFromExport).length
  }

  destroy() {
    // 取消挂起的 rAF，避免销毁后回调访问已 dispose 的 canvas
    if (this._raf) {
      cancelAnimationFrame(this._raf)
      this._raf = null
    }
    // 唤醒所有 whenIdle 等待者，避免其 Promise 永久挂起（导出流程卡死）
    this._pending = 0
    const waiters = this._waiters.slice()
    this._waiters.length = 0
    for (const w of waiters) w()
    this.canvas.dispose()
  }

  collectUsedVariables(): string[] {
    const set = new Set<string>()
    this.flattenTopLevel().forEach((o) => {
      const c = cf(o)
      const src =
        c.kind === 'text'
          ? c.originalText ?? ''
          : isBarcodeKind(c.kind)
            ? c._barcodeRaw ?? ''
            : ''
      ;(src.match(/\{\{\s*([^}]+?)\s*\}\}/g) ?? []).forEach((t) => {
        set.add(t.replace(/\{\{\s*|\s*\}\}/g, ''))
      })
    })
    return [...set]
  }

  /** 画布中已命名的内容对象名称列表（用于“插入引用”提示） */
  collectContentNames(): string[] {
    const names: string[] = []
    this.flattenTopLevel().forEach((o) => {
      const nm = cf(o)._name
      if (nm && isContentKind(cf(o).kind)) names.push(nm)
    })
    return names
  }

  // ── 撤销 / 复制粘贴 / 键盘微调 ───────────────────────────
  /**
   * 历史快照。
   *
   * ⚠️ 必须走 `this.toJSON()`（= canvas.toJSON + 写入 `_papers` / `_activePaperId`、剔除纸卡
   * 与视口变换），不能用裸的 `canvas.toJSON()`：后者不含纸张布局，撤销时只回滚对象、
   * 不回滚纸张尺寸 —— 「套用 100×70 模板 → 再套用 40×30 模板 → Ctrl+Z」会得到
   * 「100×70 的内容画在 40×30 的纸上」，对象整片落到纸外变灰且不进导出。
   * 纸卡本身是渲染产物，`loadFromJSON` 收尾会重建，绝不进快照（否则每次往返叠一层白底）。
   */
  private snapshot(): Record<string, unknown> {
    return JSON.parse(JSON.stringify(this.toJSON())) as Record<string, unknown>
  }

  /** 在产生一次“语义编辑”前调用：把当前画布压入撤销栈 */
  pushHistory() {
    this._commitHistory(this.snapshot())
  }

  /** 栈深上限，防止长会话内存无限增长 */
  private static readonly HISTORY_LIMIT = 40

  /** 压入撤销栈（不动重做栈）；redo 内部的反向入栈要走这条，否则会把 redo 清空 */
  private _pushUndo(snap: Record<string, unknown>) {
    this.undoStack.push(snap)
    if (this.undoStack.length > CanvasController.HISTORY_LIMIT) this.undoStack.shift()
  }

  /** 压入重做栈 */
  private _pushRedo(snap: Record<string, unknown>) {
    this.redoStack.push(snap)
    if (this.redoStack.length > CanvasController.HISTORY_LIMIT) this.redoStack.shift()
  }

  /** 把给定快照压入撤销栈（供交互前采集的 pending 快照提交） */
  private _commitHistory(snap: Record<string, unknown>) {
    // 任何一次新编辑都让此前的重做分支失效
    this.redoStack.length = 0
    this._pushUndo(snap)
    this.events.onHistoryChange?.()
  }

  canUndo(): boolean {
    return this.undoStack.length > 0
  }

  canRedo(): boolean {
    return this.redoStack.length > 0
  }

  /** Ctrl+Z：回到上一个快照；当前状态同步存入重做栈，保证 Ctrl+Shift+Z 能再回来 */
  undo(): boolean {
    const snap = this.undoStack.pop()
    if (!snap) return false
    this._pushRedo(this.snapshot())
    this._typingSeen = false
    this.canvas.discardActiveObject()
    this.loadFromJSON(snap)
    this.events.onActiveChange(null)
    this.events.onHistoryChange?.()
    return true
  }

  /** Ctrl+Shift+Z / Ctrl+Y：重做刚被撤销的一步 */
  redo(): boolean {
    const snap = this.redoStack.pop()
    if (!snap) return false
    // 反向：把撤销前的状态存回撤销栈。注意不能用 _commitHistory（它会清空 redo 栈）
    this._pushUndo(this.snapshot())
    this._typingSeen = false
    this.canvas.discardActiveObject()
    this.loadFromJSON(snap)
    this.events.onActiveChange(null)
    this.events.onHistoryChange?.()
    return true
  }

  /** 复制当前选中对象（支持多选）到内部剪贴板；无选中返回 0 */
  copyActive(): number {
    const sel = this.canvas.getActiveObjects()
    if (sel.length === 0) return 0
    this.clipboard = sel.map((o) => JSON.parse(JSON.stringify(o.toObject())))
    return this.clipboard.length
  }

  canPaste(): boolean {
    return this.clipboard.length > 0
  }

  /**
   * 粘贴剪贴板对象到画布（带偏移，避免与原件重叠）。
   * 复用 toJSON → 追加 → loadFromJSON 往返，保证自定义字段/条码正常重建。
   */
  pasteClipboard(offsetPx = mmToPx(4)): number {
    if (this.clipboard.length === 0) return 0
    const current = JSON.parse(JSON.stringify(this.canvas.toJSON())) as {
      objects: Array<Record<string, unknown>>
    }
    const objs = current.objects ?? []
    const added: Array<Record<string, unknown>> = []
    this.clipboard.forEach((src) => {
      const c = { ...src } as Record<string, unknown>
      delete c.id
      delete c._name // 名称不复制，避免撞名（会让新对象拿到默认名）
      const l = typeof c.left === 'number' ? (c.left as number) : 0
      const t = typeof c.top === 'number' ? (c.top as number) : 0
      c.left = Math.min(this.workspaceW - 10, Math.max(0, l + offsetPx))
      c.top = Math.min(this.workspaceH - 10, Math.max(0, t + offsetPx))
      added.push(c)
    })
    current.objects = objs.concat(added)
    this._typingSeen = false
    this.loadFromJSON(current)
    // 选中新粘贴的对象
    const all = this.canvas.getObjects()
    const pasted = all.slice(all.length - added.length)
    if (pasted.length > 0) {
      this.canvas.discardActiveObject()
      this.canvas.setActiveObject(pasted[0])
      this.canvas.requestRenderAll()
    }
    return added.length
  }

  /** 原位复制选中对象（面板“复制”按钮） */
  duplicateActive(): number {
    if (!this.canvas.getActiveObject()) return 0
    const n = this.copyActive()
    if (n === 0) return 0
    return this.pasteClipboard()
  }

  /** 方向键微调选中对象；首次按下时自动压入一条撤销历史（用 session 标记避免连按刷屏） */
  nudgeActive(dxPx: number, dyPx: number): boolean {
    const obj = this.getActiveObject()
    if (!obj) return false
    if (!this._nudging) {
      this.pushHistory()
      this._nudging = true
    }
    const step = mmToPx(1)
    const curW = obj.getScaledWidth()
    const curH = obj.getScaledHeight()
    obj.set({
      left: Math.max(-curW + 1, Math.min(this.workspaceW - 1, (obj.left ?? 0) + dxPx * step)),
      top: Math.max(-curH + 1, Math.min(this.workspaceH - 1, (obj.top ?? 0) + dyPx * step)),
    })
    obj.setCoords()
    this.canvas.requestRenderAll()
    this.events.onDirty()
    this.emitActive()
    return true
  }

  /** 连续 nudge 会话结束标记：由调用方在 keyup 或其它操作时清除 */
  private _nudging = false
  endNudge() {
    this._nudging = false
  }

  /** 选中变更/离散操作后调用：下一处字段编辑视为新会话（重新压栈） */
  resetEdit() {
    this._typingSeen = false
  }

  /** 字段连续输入（坐标/名称/前后缀/序列等每次键入）在一场会话里只压一次撤销栈 */
  beginFieldEdit() {
    if (!this._typingSeen) {
      this.pushHistory()
      this._typingSeen = true
    }
  }
}

function loadImageEl(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const im = new Image()
    im.onload = () => resolve(im)
    im.onerror = () => reject(new Error('图片加载失败'))
    im.src = url
  })
}

/** 把本地文件读成内嵌 dataURL（base64），用于序列化进模板后仍能还原 */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('读取图片文件失败'))
    reader.readAsDataURL(file)
  })
}

/** 把网络取回的二进制内容读成内嵌 dataURL（素材库位图入画布用） */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('读取素材图片失败'))
    reader.readAsDataURL(blob)
  })
}
