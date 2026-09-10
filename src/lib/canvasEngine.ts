// 画布引擎：封装 fabric 生命周期与对象操作，便于 React 以命令式调用
import { fabric } from 'fabric'
import { mmToPx, pxToMm, roundMm } from '@/lib/mm'
import { is2dType, defaultSettingsFor, type BarcodeType, type BarcodeRenderSettings } from '@/lib/barcode'
import { renderBarcodeVectorRects } from '@/lib/barcodeVector'
import { pxToPt, ptToPx } from '@/lib/textStyles'
import type { PaperArea, PaperSize, DataRow, ElementKind, ShapeType } from '@/types/template'
import { resolveContent } from '@/lib/content'
import type { ActiveObject, TextFormatSnapshot, TextStyle } from '@/types/editor'
import type { SerialSpec } from '@/types/editor'

export type ActiveObjectSnapshot = ActiveObject

export interface ControllerEvents {
  onActiveChange(snap: ActiveObjectSnapshot | null): void
  /** 多选/编组状态（count≥2 为多对象，isGroup=true 为单个编组整体，isBarcodeGroup=true 为单个条码组） */
  onSelection?(info: { count: number; isGroup: boolean; isBarcodeGroup: boolean }): void
  onDirty(): void
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
   */
  _barcodeUnit?: { w: number; barH: number }
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
  originalText?: string
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

/** 取自定义字段读写器（类型断言，绕开 fabric 泛型 set） */
function cf(o: fabric.Object): fabric.Object & CustomFields {
  return o as fabric.Object & CustomFields
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
      // 条码：拉伸只作用于条码条，抵消非等比部分，避免人读文字被拉变形
      else if (t && isBarcodeKind(cf(t).kind)) this.applyBarcodeTextCompensation(t)
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
      this._pendingHistory = JSON.parse(JSON.stringify(this.canvas.toJSON())) as Record<string, unknown>
    })
    this.canvas.on('object:modified', () => {
      this.clearGuides()
      // 拖出/拖回后立即刷一次透明度视觉
      for (const o of this.canvas.getObjects()) this.updateOutsidePaperVisual(o)
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

    const updates: Record<string, number> = { scaleX: 1, scaleY: 1 }
    if (changedX) updates.width = Math.max(minW, newW)
    if (changedY) updates.height = Math.max(10, newH)
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
      // 补打序列化，确保组对象自身 toJSON 携带子对象字段（children 各自已有 patch）
      ;(group as unknown as Record<string, unknown>).isGroupBox = true
      this.canvas.setActiveObject(group)
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
      this.canvas.requestRenderAll()
      this.refreshAllContent()
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
      textFormat = {
        fontFamily: (it as fabric.IText).fontFamily ?? 'Arial',
        fontSizePt: Math.round(pxToPt((it as fabric.IText).fontSize ?? 12) * 10) / 10,
        bold: (it as fabric.IText).fontWeight === 'bold',
        italic: (it as fabric.IText).fontStyle === 'italic',
        color: ((it as fabric.IText).fill as string) ?? '#000000',
        textAlign: ((it as fabric.IText).textAlign ?? 'left') as string,
      }
      const hasBorder = !!(it as fabric.Object).stroke && (it as fabric.Object).stroke !== 'transparent'
      const hasBg = !!(it as fabric.Object).backgroundColor && (it as fabric.Object).backgroundColor !== 'transparent'
      if (hasBorder || hasBg) textRegion = { border: hasBorder, bg: hasBg }
    } else if (isBarcodeKind(kind)) {
      text = c._barcodeRaw ?? ''
      barcodeType = c._barcodeType
      barcodeSettings = c._barcodeSettings ?? (barcodeType ? defaultSettingsFor(barcodeType) : undefined)
      barcodeTextOffsetMm = c._barcodeTextOffsetMm ?? 0
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
      shapeType,
      textFormat,
      textRegion,
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
    if (patch.fontSizePt != null) set.fontSize = ptToPx(patch.fontSizePt)
    if (patch.bold != null) set.fontWeight = patch.bold ? 'bold' : 'normal'
    if (patch.italic != null) set.fontStyle = patch.italic ? 'italic' : 'normal'
    if (patch.color) set.fill = patch.color
    if (patch.textAlign) set.textAlign = patch.textAlign
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
    set.stroke = region.border ? '#444444' : 'transparent'
    set.strokeWidth = region.border ? 1 : 0
    set.strokeUniform = true
    set.backgroundColor = region.bg ? '#f1f5f9' : 'transparent'
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
    ap.widthMm = paper.widthMm
    ap.heightMm = paper.heightMm
    this.relayoutPapers()
    this.resizeWorkspace()
    this.recreatePaperRects()
    this.canvas.requestRenderAll()
    this.events.onDirty()
  }

  // ── 多标签（多纸）管理 ──────────────────────────────────
  /**
   * 纵向重排：纸 0 保持位置不变，其后每张纸紧接上一张下沿 + 间距。
   * 改尺寸/增删纸后调用，避免高矮不一时互相重叠或留空。
   */
  private relayoutPapers() {
    if (this.papers.length === 0) return
    const gap = mmToPx(PAPER_GAP_MM)
    for (let i = 1; i < this.papers.length; i++) {
      const prev = this.papers[i - 1]
      this.papers[i].top = prev.top + mmToPx(prev.heightMm) + gap
      this.papers[i].left = prev.left
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

  /** 判断对象是否在任意一张标签纸内（用于导出过滤 + 视觉提示） */
  isObjectInPaper(obj: fabric.Object): boolean {
    const b = obj.getBoundingRect(true)
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
    const b = obj.getBoundingRect(true)
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
    const built = this.buildBarcodeGroup(type, this.resolveDesign(raw), settings)
    if (!built) return
    const { group, w, h } = built
    // 2D 码必须等比；一维码按条区锚定 + 「超高」保底容纳人读文字
    let k = mmToPx(targetMm) / (is2d ? Math.max(w, h) : built.barH || h || 1)
    if (!is2d) {
      const bandUnit = h - built.barH
      if (bandUnit > 1) {
        const needSy = ptToPx(Math.max(1, settings.textSizePt ?? 9)) / (bandUnit * 0.72)
        if (needSy > k) k = needSy
      }
    }
    group.set({ scaleX: k, scaleY: k })
    const c = cf(group)
    c._barcodeTargetMm = targetMm
    c._barcodeType = type
    c._barcodeSettings = settings
    c._barcodeUnit = { w: built.w, barH: built.barH }
    c._barcodeTextScale = k
    c._barcodeTextOffsetMm = 0
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
  ): { group: fabric.Group; w: number; h: number; barH: number } | null {
    try {
      const vec = renderBarcodeVectorRects(type, text, settings)
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
      const showText =
        vec.showTextHint && settings.showText !== false && !!vec.fullHeight && vec.fullHeight > vec.height
      if (showText && vec.fullHeight) {
        const band = vec.fullHeight - vec.height
        h = vec.fullHeight
        // 文字 child 离条区下沿额外偏移(mm)：>0 拉开距离，<0 拉近
        const textOffsetPx = mmToPx(textOffsetMm || 0)
        children.push(
          new fabric.Text(text, {
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
          }),
        )
      }
      const group = new fabric.Group(children, { subTargetCheck: false })
      return { group, w: vec.width, h, barH: vec.height }
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
   * 让条码「人读文字」完全不随拉伸变化 —— 文字大小只由「可读文字字号」决定。
   *
   * 原理：fabric Group 会把自身 scale 叠加到子对象。若给文字 child 设
   * scaleX = glyphPx/(fontSize·sx)、scaleY = glyphPx/(fontSize·sy)，则其
   * 在画布上的视觉字号 = fontSize×childScale×groupScale = glyphPx：
   *  - 与 group 拉伸（sx/sy）无关 → 拉伸条码条时文字字号恒定、字形方正（不拉扁）；
   *  - glyphPx 由「可读文字字号」换算成真实逻辑 px = ptToPx(textSizePt)，
   *    随字号线性、清晰可见（旧实现用固定小缩放 ≈0.3，把 9pt 压成亚像素 ~2.7px，
   *    故调字号只见空间变大、字几乎不变）。
   *
   * glyphPx 还会参考 band 的实际可用空间做宽松封顶，避免极端小码上文字溢出成叠印；
   * 正常尺寸的码（band 逻辑高 ≥ 目标字号）下不封顶，字号完全按设置生效。
   */
  private applyBarcodeTextCompensation(obj: fabric.Object) {
    const sx = obj.scaleX ?? 1
    const sy = obj.scaleY ?? 1
    if (!sx || !sy) return
    const kids = (obj as unknown as { _objects?: fabric.Object[] })._objects
    if (!Array.isArray(kids)) return
    const c = cf(obj)
    const textPt = Math.max(1, c._barcodeSettings?.textSizePt ?? 9)
    const wantPx = ptToPx(textPt)
    // 文字带可用逻辑高(px) = 整组逻辑高 − 条区逻辑高。小码时用它封顶防叠印，大码时不限。
    const barUnitH = c._barcodeUnit?.barH ?? this.barcodeBarUnitHeight(obj)
    const bandPx = (Math.abs(obj.height ?? 0) - Math.abs(barUnitH)) * Math.abs(sy)
    const capPx = bandPx > 1 ? bandPx * 1.1 : Infinity
    const glyphPx = Math.min(wantPx, capPx)
    c._barcodeTextScale = Math.min(sx, sy) // 保留字段(兼容旧模板读取/序列化)；不再驱动字号
    for (const k of kids) {
      // 只处理人读文字（条码条是 rect，保持随拉伸变化）
      if (k.type !== 'text' && k.type !== 'textbox' && k.type !== 'i-text') continue
      const fs = Math.max((k as fabric.Text).fontSize ?? 1, 1)
      k.set({ scaleX: glyphPx / (fs * Math.abs(sx)), scaleY: glyphPx / (fs * Math.abs(sy)) })
    }
  }

  private replaceBarcodeObject(old: fabric.Object, type: BarcodeType, text: string, settings: BarcodeRenderSettings) {
    const oc = cf(old)
    const built = this.buildBarcodeGroup(
      type,
      text,
      settings,
      oc._barcodeTextOffsetMm || 0,
    )
    if (!built) return
    const group = built.group
    const is2d = is2dType(type)
    const curW = old.getScaledWidth()
    const curH = old.getScaledHeight()
    // 旧对象有有效尺寸（正常重绘 / 手动缩放过）→ 沿用当前尺寸，保留手动缩放；
    // 否则（多为载入模板时 fabric 重建出的空组，尺寸为 0）按目标 mm 推算，避免缩成 0 不可见。
    const hasOld = curW > 0 && curH > 0
    let kx: number
    let ky: number
    if (is2d) {
      // 2D 码必须等比（否则无法扫描）
      const targetMm = oc._barcodeTargetMm ?? 18
      const k = hasOld
        ? Math.max(curW, curH) / Math.max(built.w, built.h)
        : mmToPx(targetMm) / (built.w || 1)
      kx = k
      ky = k
    } else if (!hasOld) {
      // 多为载入模板时 fabric 重建出的空组（尺寸为 0）。一维码按「条区目标高」定基缩放，
      // 再叠加文字带所需的「超高」——使新增/载入的一维码天然能容纳可读文字（字清晰）。
      const targetMm = oc._barcodeTargetMm ?? (type === 'itf14' ? 12 : 8)
      let k = mmToPx(targetMm) / (built.barH || built.h || 1)
      const bandUnit = built.h - built.barH
      if (bandUnit > 1) {
        const tsp = oc._barcodeSettings?.textSizePt ?? 9
        const needSy = ptToPx(Math.max(1, tsp)) / (bandUnit * 0.72)
        if (needSy > k) k = needSy
      }
      kx = k
      ky = k
    } else {
      // 一维码：缩放必须按「条码条区」换算，绝不能按含人读文字的整高换算。
      // 否则调整「可读文字字号」→ fullHeight 变化 → ky 跟着变 → 整条码被压缩/放大。
      // 优先用记录的单位几何；缺失时（旧模板）从旧组的模块矩形反推。
      const prevBarH = oc._barcodeUnit?.barH ?? this.barcodeBarUnitHeight(old)
      const kBar =
        prevBarH > 0 && built.barH > 0 ? ((old.scaleY ?? 1) * prevBarH) / built.barH : curH / (built.h || 1)
      // 保留用户手动造成的非等比拉伸比（未拉伸时 ratio = 1，即等比）
      const syPrev = old.scaleY ?? 1
      const ratio = Math.abs(syPrev) > 1e-6 ? (old.scaleX ?? 1) / syPrev : 1
      ky = kBar
      // 「超高再长」保底：人读文字带需要的纵向缩放若大于条区锚定值，则抬高 ky，
      // 让整码长高到能容纳目标字号（方案：默认整码高度固定，字号超出文字带才增高）。
      // band 栅格 = 整高 − 条区高（仅 1D 含文字时 > 0）。计算放在 ky 用前。
      const bandUnit = built.h - built.barH
      if (bandUnit > 1) {
        const tsp = oc._barcodeSettings?.textSizePt ?? 9
        const needSy = ptToPx(Math.max(1, tsp)) / (bandUnit * 0.72) // band 留 28% 上下间隙
        if (needSy > ky) ky = needSy
      }
      kx = ky * ratio
    }
    group.set({
      scaleX: kx,
      scaleY: ky,
      left: old.left,
      top: old.top,
      angle: old.angle ?? 0,
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
    nc._barcodeUnit = { w: built.w, barH: built.barH }
    nc._barcodeTextOffsetMm = oc._barcodeTextOffsetMm || 0
    // 重建后按「可读文字字号」刷新人读文字视觉：文字不随拉伸/改码制变化，仅字号生效
    if (!is2d && settings.showText !== false) this.applyBarcodeTextCompensation(group)
    const wasActive = this.canvas.getActiveObject() === old
    this._suppressDirty = true
    this.canvas.remove(old)
    this.patchSerialize(group)
    this.applyLockState(group)
    this.canvas.add(group)
    this._suppressDirty = false
    if (wasActive) this.canvas.setActiveObject(group)
    group.setCoords()
    this.canvas.requestRenderAll()
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

  /** 把 SVG 内部片段按 viewBox / 配色拼成完整 SVG 字符串（插入与矢量导出共用） */
  composeAssetSvg(p: {
    inner: string
    viewBox: string
    isStroke: boolean
    color?: string
    strokeWidth?: number
  }): string {
    const vb = p.viewBox || '0 0 24 24'
    const head = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}">`
    if (!p.isStroke) return head + p.inner + '</svg>'
    const sw = p.strokeWidth ?? 2
    const c = p.color || '#000000'
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

  private finalizeObject(obj: fabric.Object, kind: ElementKind, text: string | null) {
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
        if (typeof c._barcodeTextScale === 'number') props._barcodeTextScale = c._barcodeTextScale
        // 矢量条码组：模块矩形不写入 JSON（几百个对象太臃肿），载入时按元数据重建
        if (obj.type === 'group') delete (props as { objects?: unknown }).objects
      }
      if (c.kind === 'text') props.originalText = c.originalText
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
    return data
  }

  /**
   * 以工作区坐标系把"纸区域"导出为高清 PNG dataURL。
   * 导出时临时把画布切回工作区尺寸 + identity 视口变换(绕开屏幕缩放/视口裁剪),
   * 导出后恢复当前视口。供栅格 PNG / 打印 / 批量序列化截图复用。
   */
  toPaperDataUrl(scale = 3, paperId?: string): string {
    const paper = paperId ? this.getPaperBoundsPxFor(paperId) : this.getPaperBoundsPx()
    const prevVpt = (this.canvas.viewportTransform ?? [1, 0, 0, 1, 0, 0]).slice() as unknown as number[]
    const prevW = this.viewW
    const prevH = this.viewH
    const prevSel = this.canvas.getActiveObject()
    this.canvas.discardActiveObject()
    this.canvas.setViewportTransform([1, 0, 0, 1, 0, 0])
    this.canvas.setDimensions({ width: this.workspaceW, height: this.workspaceH })
    this.canvas.renderAll()
    const el = this.canvas.getElement() as HTMLCanvasElement
    const DPR = el.width / Math.max(1, this.workspaceW)
    const out = document.createElement('canvas')
    // 浏览器 canvas 单边上限约 16384px（部分环境 32767），超限会静默输出空白。
    // 这里对外输出尺寸做钳制，必要时等比降低 effectiveScale，保证大标签仍能导出。
    const MAX_DIM = 16384
    let effectiveScale = scale
    const maxSide = Math.max(paper.width, paper.height) * scale
    if (maxSide > MAX_DIM) {
      effectiveScale = scale * (MAX_DIM / maxSide)
      console.warn(
        `[canvasEngine] 标签过大，超出 canvas 上限，导出缩放 ${scale} → ${effectiveScale.toFixed(2)}`,
      )
    }
    out.width = Math.max(1, Math.round(paper.width * effectiveScale))
    out.height = Math.max(1, Math.round(paper.height * effectiveScale))
    const ctx = out.getContext('2d')!
    ctx.scale(effectiveScale, effectiveScale)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, paper.width, paper.height)
    ctx.drawImage(
      el,
      paper.left * DPR, paper.top * DPR, paper.width * DPR, paper.height * DPR,
      0, 0, paper.width, paper.height,
    )
    const url = out.toDataURL('image/png')
    // 恢复视口
    this.canvas.setDimensions({ width: prevW, height: prevH })
    this.canvas.setViewportTransform(prevVpt as unknown as [number, number, number, number, number, number])
    if (prevSel) this.canvas.setActiveObject(prevSel)
    this.canvas.requestRenderAll()
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
      c._barcodeUnit = (s._barcodeUnit as { w: number; barH: number } | undefined) ?? undefined
      c._barcodeTextScale = (s._barcodeTextScale as number | undefined) ?? undefined
      c._barcodeTextOffsetMm = (s._barcodeTextOffsetMm as number | undefined) ?? 0
    }
    if (c.kind === 'text' && typeof s.originalText === 'string') {
      c.originalText = s.originalText
    } else if (c.kind === 'text' && c.originalText === undefined) {
      c.originalText = (o as fabric.IText).text ?? ''
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
          this.activePaperIdValue = restored[0].id
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
      for (const o of this.canvas.getObjects()) if (!(o as { excludeFromExport?: boolean }).excludeFromExport) this.updateOutsidePaperVisual(o)
      this.refreshAllContent()
      // 导入后保持当前视口(避免模板里残留的视图变换影响显示)
      this.canvas.setViewportTransform([this.vptZoom, 0, 0, this.vptZoom, this.vptPan.x, this.vptPan.y])
      this.canvas.requestRenderAll()
      if (this.previewRow) this.setPreviewRow(this.previewRow)
      this._suppressDirty = false
      this.events.onDirty()
    })
  }

  clearAll() {
    this.canvas.clear()
    // 清空后重建"纸卡"背景 + 恢复工作区底色
    this.canvas.backgroundColor = '#e2e8f0'
    this.recreatePaperRects()
    this.canvas.requestRenderAll()
    this.events.onDirty()
    this.events.onActiveChange(null)
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
  /** 在产生一次“语义编辑”前调用：把当前画布压入撤销栈 */
  pushHistory() {
    this._commitHistory(JSON.parse(JSON.stringify(this.canvas.toJSON())) as Record<string, unknown>)
  }

  /** 把给定快照压入撤销栈（供交互前采集的 pending 快照提交） */
  private _commitHistory(snap: Record<string, unknown>) {
    this.undoStack.push(snap)
    // 限制栈深，防止长会话内存无限增长
    if (this.undoStack.length > 40) this.undoStack.shift()
  }

  canUndo(): boolean {
    return this.undoStack.length > 0
  }

  /** Ctrl+Z：回到上一个快照 */
  undo(): boolean {
    const snap = this.undoStack.pop()
    if (!snap) return false
    this._typingSeen = false
    this.canvas.discardActiveObject()
    this.loadFromJSON(snap)
    this.events.onActiveChange(null)
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
