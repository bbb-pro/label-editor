// 画布引擎：封装 fabric 生命周期与对象操作，便于 React 以命令式调用
import { fabric } from 'fabric'
import { mmToPx, pxToMm, roundMm } from '@/lib/mm'
import { is2dType, defaultSettingsFor, type BarcodeType, type BarcodeRenderSettings } from '@/lib/barcode'
import { renderBarcodeVectorRects } from '@/lib/barcodeVector'
import { pxToPt, ptToPx } from '@/lib/textStyles'
import type { PaperSize, DataRow, ElementKind, ShapeType } from '@/types/template'
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
  originalText?: string
  /** 形状子类型（kind === 'shape' 时生效） */
  _shapeType?: ShapeType
  /** 内容对象：纯文本前缀（显示在内容前） */
  _prefix?: string
  /** 内容对象：纯文本后缀（显示在内容后） */
  _suffix?: string
  /** 内容对象：序列化配置（批量打印时 {{seq}} 逐张递增） */
  _serial?: SerialSpec
}

const isBarcodeKind = (k: ElementKind | undefined): boolean => k === 'barcode'
const isContentKind = (k: ElementKind | undefined): boolean => k === 'text' || k === 'barcode'
/** 是否有描边粗细（闭合形状 + 直线） */
const isStrokeKind = (k: ElementKind | undefined): boolean => k === 'rect' || k === 'shape' || k === 'line'

/** 工作区在标签四周多留的边距(mm)。对象可拖出标签"暂存"到这里；仅标签内对象会打印。
 *  画布会在对象被拖近边缘时自动向外扩张（等效"无限画布"），此值为初始留白。
 *  默认给很大的留白，让画布一上来就"近似无限"，拖动到更远处仍会自动续扩。 */
const WORKSPACE_MARGIN_MM = 600
/** 对象中心距边缘小于该值(px)时触发画布扩张 */
const GROW_TRIGGER_PX = 120
/** 每次向外扩张的增量(mm) */
const GROW_STEP_MM = 100

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
  private paperPxW: number
  private paperPxH: number
  /** 工作区在画布原点四周多留的边距(像素)，让对象可"暂存"到标签外 */
  private paperOffsetX = 0
  private paperOffsetY = 0
  private workspaceW = 0
  private workspaceH = 0
  /** 标签"纸卡"背景矩形：selectable:false 不可点选，excludeFromExport:true 不导出 */
  private paperRect: fabric.Rect | null = null
  /** 临时屏蔽 object:added/removed 的 onDirty 回调（构造期间/纸卡重建时） */
  private _suppressDirty = false
  previewRow: DataRow | null = null
  /** 批量打印当前副本的序列号显示值；null 表示用示例值预览 */
  seqValue: string | null = null
  /** 撤销栈：每次编辑前 push 的画布 JSON（canvas.toJSON()） */
  private undoStack: Array<Record<string, unknown>> = []
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
    this.paperPxW = mmToPx(paper.widthMm)
    this.paperPxH = mmToPx(paper.heightMm)
    // 工作区外圈：四周多出 WORKSPACE_MARGIN_MM 像素，让对象可以"暂存"到标签外
    this.paperOffsetX = mmToPx(WORKSPACE_MARGIN_MM)
    this.paperOffsetY = mmToPx(WORKSPACE_MARGIN_MM)
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
    // 双击编组 → 解组（编辑体验贴近 PS/AI）；条码组保持原子对象，不解组
    this.canvas.on('mouse:dblclick', (opt) => {
      const t = opt.target
      if (t && this.isGroup(t) && cf(t).kind !== 'barcode') this.ungroupSelection()
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
    this.canvas.on('object:modified', () => {
      this.clearGuides()
      // 拖出/拖回后立即刷一次透明度视觉
      for (const o of this.canvas.getObjects()) this.updateOutsidePaperVisual(o)
      this.emitActive()
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
    this.recreatePaperRect()
  }

  // ── 异步渲染追踪 ─────────────────────────────────────────
  /**
   * 历史遗留字段：早期条码是位图（setSrc 异步），需要 markPending/markDone 追踪
   * 批量重绘落地后再截图。现条码改为矢量矩形组（同步替换），已不再调用这两个方法，
   * 仅保留 _pending/_waiters 计数供 whenIdle 兼容（始终为 0，立即 resolve）。
   */
  private _pending = 0
  private _waiters: Array<() => void> = []

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
        // 条码虽是 fabric.Group，但它是「原子内容对象」，必须整体作为叶子返回：
        // 若被穿透成子矩形，refreshAllContent 就永远遍历不到条码本身，
        // rerenderBarcode 不会被调用 → 数据源/序列化递增时条码不跟随（一直停在首张值）。
        if (this.isGroup(o) && !isContentKind(cf(o).kind)) {
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
    this.flattenTopLevel().forEach((o) => this.refreshContentObject(o))
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
    const sel = obj as unknown as { getObjects?: () => fabric.Object[] }
    const multi = typeof sel.getObjects === 'function' && (sel.getObjects() ?? []).length > 0
    // 容器分支：真实编组（用户编组）/ 多选(ActiveSelection) 进入“整体操作”状态，不展示单对象属性面板。
    // 注意：条码组虽然是 fabric.Group，但它是一个“原子可编辑对象”，要像单对象一样展示条码属性面板，
    // 因此 isBarcodeGroup 时不走此分支。
    if (!isBarcodeGroup && (isGroupSel || multi)) {
      const cnt = isGroupSel ? 1 : (sel.getObjects?.().length ?? 0)
      this.events.onSelection?.({ count: cnt, isGroup: isGroupSel, isBarcodeGroup: false })
      this.events.onActiveChange(null)
      return
    }
    // 单对象 / 条码组：作为单个可编辑对象处理（条码组走 isBarcodeKind 分支展示条码属性）
    this.events.onSelection?.({ count: 1, isGroup: isGroupSel, isBarcodeGroup })
    const c = cf(obj)
    const kind = (c.kind ?? 'text') as ElementKind
    let text: string | null = null
    let barcodeType: BarcodeType | undefined
    let barcodeSettings: BarcodeRenderSettings | undefined
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
    } else {
      prefix = ''
      suffix = ''
      serial = undefined
    }
    this.events.onActiveChange({
      id: c.id ?? '',
      name: c._name ?? '',
      kind,
      x: roundMm(pxToMm(obj.left ?? 0)),
      y: roundMm(pxToMm(obj.top ?? 0)),
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
  applyPaper(paper: PaperSize) {
    this.paperPxW = mmToPx(paper.widthMm)
    this.paperPxH = mmToPx(paper.heightMm)
    this.resizeWorkspace()
    this.recreatePaperRect()
    this.canvas.requestRenderAll()
    this.events.onDirty()
  }

  /** 重新计算工作区尺寸 = 标签 + 四周留白(逻辑尺寸,canvas 实际尺寸由 setViewportSize 控制) */
  private resizeWorkspace() {
    this.workspaceW = this.paperPxW + this.paperOffsetX * 2
    this.workspaceH = this.paperPxH + this.paperOffsetY * 2
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
    this.paperOffsetX += dx
    this.paperOffsetY += dy
    if (side === 'left') this.workspaceW += delta
    else this.workspaceH += delta
    this._suppressDirty = true
    for (const o of this.canvas.getObjects()) {
      o.set({ left: (o.left ?? 0) + dx, top: (o.top ?? 0) + dy })
      o.setCoords()
    }
    this._suppressDirty = false
    this.recreatePaperRect()
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

  /** 标签"纸卡"：白底矩形带淡灰边，置于工作区中央，不可交互、不参与导出 */
  private recreatePaperRect() {
    this._suppressDirty = true
    if (this.paperRect) {
      this.canvas.remove(this.paperRect)
      this.paperRect = null
    }
    const rect = new fabric.Rect({
      left: this.paperOffsetX,
      top: this.paperOffsetY,
      width: this.paperPxW,
      height: this.paperPxH,
      fill: '#ffffff',
      stroke: '#cbd5e1',
      strokeWidth: 1,
      opacity: 1,
      selectable: false,
      evented: false,
      excludeFromExport: true,
      hoverCursor: 'default',
    })
    // 放到最底
    this.canvas.add(rect)
    this.canvas.sendToBack(rect)
    this.paperRect = rect
    this._suppressDirty = false
  }

  /** 判断对象是否在标签区域内（用于导出时过滤 + 视觉提示） */
  isObjectInPaper(obj: fabric.Object): boolean {
    const b = obj.getBoundingRect(true)
    const right = this.paperOffsetX + this.paperPxW
    const bottom = this.paperOffsetY + this.paperPxH
    const intersects =
      b.left < right &&
      b.left + b.width > this.paperOffsetX &&
      b.top < bottom &&
      b.top + b.height > this.paperOffsetY
    return intersects
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

  /** 标签在工作区中的像素矩形(供导出裁剪) */
  getPaperBoundsPx(): { left: number; top: number; width: number; height: number } {
    return { left: this.paperOffsetX, top: this.paperOffsetY, width: this.paperPxW, height: this.paperPxH }
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
    if (patch.x !== undefined) obj.set({ left: mmToPx(patch.x) })
    if (patch.y !== undefined) obj.set({ top: mmToPx(patch.y) })
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

  /** 设置选中闭合形状/直线的描边粗细（px，恒等不随缩放） */
  setActiveStrokeWidth(widthPx: number) {
    const obj = this.getActiveObject()
    if (!obj) return
    const c = cf(obj)
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
      rx: mmToPx(0.6),
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
    // 2D 以正方形边长(mm)为目标，一维码以高度(mm)为目标
    const targetMm = is2d ? 18 : type === 'itf14' ? 12 : 8
    const settings = defaultSettingsFor(type)
    const built = this.buildBarcodeGroup(type, this.resolveDesign(raw), settings)
    if (!built) return
    const { group, w, h } = built
    const k = mmToPx(targetMm) / (h || 1)
    group.set({ scaleX: k, scaleY: k })
    const c = cf(group)
    c._barcodeTargetMm = targetMm
    c._barcodeType = type
    c._barcodeSettings = settings
    c._barcodeUnit = { w: built.w, barH: built.barH }
    group.set({ left: this.paperCenter().x - (w * k) / 2, top: this.paperCenter().y - (h * k) / 2 })
    this.finalizeObject(group, 'barcode', raw)
  }

  /** 构建矢量条码组：黑模块矩形（+1D 人读文字），画布上真矢量、与 PDF 导出同一套几何 */
  private buildBarcodeGroup(
    type: BarcodeType,
    text: string,
    settings: BarcodeRenderSettings,
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
        children.push(
          new fabric.Text(text, {
            left: vec.width / 2,
            top: vec.height + band / 2,
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
   * 抵消缩放对条码「人读文字」的影响，使拉伸条码时只拉条码条、文字不变形。
   * 原理：group 的 scale 会叠加到子对象上，给文字设 1/scale 即可让其在屏幕上保持原始比例。
   * 但**等比**缩放时文字本就应该随之变大，因此只抵消「非等比」的那部分：
   * 取等比分量 u = min(sx, sy)，令文字视觉缩放恒为 u（等比时 u=sx=sy → 正常跟随放大）。
   */
  private applyBarcodeTextCompensation(obj: fabric.Object) {
    const sx = obj.scaleX ?? 1
    const sy = obj.scaleY ?? 1
    if (!sx || !sy) return
    const uniform = Math.min(Math.abs(sx), Math.abs(sy))
    const kids = (obj as unknown as { _objects?: fabric.Object[] })._objects
    if (!Array.isArray(kids)) return
    for (const k of kids) {
      // 只处理人读文字（条码条是 rect，保持随拉伸变化）
      if (k.type !== 'text' && k.type !== 'textbox' && k.type !== 'i-text') continue
      k.set({ scaleX: uniform / sx, scaleY: uniform / sy })
    }
  }

  private replaceBarcodeObject(old: fabric.Object, type: BarcodeType, text: string, settings: BarcodeRenderSettings) {
    const built = this.buildBarcodeGroup(type, text, settings)
    if (!built) return
    const oc = cf(old)
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
      // 多为载入模板时 fabric 重建出的空组（尺寸为 0），按目标 mm 推算，避免缩成 0 不可见
      const targetMm = oc._barcodeTargetMm ?? (type === 'itf14' ? 12 : 8)
      const k = mmToPx(targetMm) / (built.h || 1)
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
      kx = kBar * ratio
    }
    group.set({
      scaleX: kx,
      scaleY: ky,
      left: old.left,
      top: old.top,
      angle: old.angle ?? 0,
    })
    // 重建后重新抵消非等比部分，保证人读文字不变形
    this.applyBarcodeTextCompensation(group)
    const nc = cf(group)
    nc.id = oc.id
    nc.kind = oc.kind
    nc._name = oc._name
    nc._barcodeRaw = oc._barcodeRaw
    nc._barcodeType = oc._barcodeType
    nc._barcodeTargetMm = oc._barcodeTargetMm
    nc._barcodeSettings = oc._barcodeSettings
    nc._barcodeUnit = { w: built.w, barH: built.barH }
    const wasActive = this.canvas.getActiveObject() === old
    this._suppressDirty = true
    this.canvas.remove(old)
    this.patchSerialize(group)
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
    if (!trimmed || trimmed === c._name) return
    if (!this.isNameAvailable(trimmed, obj)) {
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
      // 补零位数：内容末尾数字带前导零时按其位数；否则用面板设定的补零位数
      const run = /(\d+)\s*$/.exec(this.coreDesign(c))
      const digits = run ? run[1] : ''
      const hasLeadingZero = digits.length > 1 && digits.startsWith('0')
      const minDigits = hasLeadingZero ? digits.length : Math.max(1, serial.minDigits)
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
    const val = this.seqValue ?? formatSeq(spec.start, Math.max(1, spec.minDigits))
    const m = /^(.*?)(\d+)$/.exec(resolved)
    return m ? m[1] + val : resolved + val
  }


  /** 名称是否可用（content 对象中唯一，排除自身） */
  private isNameAvailable(name: string, self: fabric.Object): boolean {
    return !this.flattenTopLevel().some((o) => o !== self && cf(o)._name === name)
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

  /** 收集内容对象的“名称 -> 当前显示文案”映射，供跨对象引用解析。
   *  关键：对已命名且开启了序列化的对象，额外套用 finalizeSerial（末尾数字替换当前 seqValue），
   *  使 {{对象名}} 引用的对象（如条码引用序列化文本框）能逐张跟随递增。
   *  其余保持原行为：只做 applySeq({{seq}})，数据列留待引用方 resolveContent 统一处理。 */
  private buildContentMap(): Map<string, string> {
    const map = new Map<string, string>()
    this.flattenTopLevel().forEach((o) => {
      const c = cf(o)
      if (!isContentKind(c.kind)) return
      const nm = c._name
      if (!nm) return
      map.set(nm, this.finalizeSerial(o, this.applySeq(this.decoratedDesign(c))))
    })
    return map
  }

  /** 解析某对象的显示内容：序列号 → 数据列 → 跨对象名称引用（递归） */
  private resolveDesign(design: string): string {
    return resolveContent(this.applySeq(design), this.previewRow, this.buildContentMap(), new Set())
  }

  /** 计算某内容对象要显示的最终文案（含前后缀/序列号/变量/跨对象） */
  private displayContent(o: fabric.Object): string {
    const c = cf(o)
    return this.finalizeSerial(o, this.resolveDesign(this.decoratedDesign(c)))
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
  private refreshContentObject(o: fabric.Object) {
    const c = cf(o)
    if (isBarcodeKind(c.kind)) {
      if (c._barcodeRaw != null || c._prefix != null || c._suffix != null) this.rerenderBarcode(o)
    } else if (c.kind === 'text') {
      const next = this.displayContent(o)
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
    const url = URL.createObjectURL(file)
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

  private finalizeObject(obj: fabric.Object, kind: ElementKind, text: string | null) {
    const c = cf(obj)
    c.id = newId()
    c.kind = kind
    if (kind === 'text' && text != null) c.originalText = text
    if (isBarcodeKind(kind) && text != null) c._barcodeRaw = text
    // 默认命名；加载模板时若已有名称则沿用（见 loadFromJSON）
    if (!c._name) c._name = defaultName(kind)
    this.patchSerialize(obj)
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
      if (isBarcodeKind(c.kind)) {
        props._barcodeRaw = c._barcodeRaw
        props._barcodeType = c._barcodeType
        props._barcodeTargetMm = c._barcodeTargetMm
        props._barcodeSettings = c._barcodeSettings
        if (c._barcodeUnit) props._barcodeUnit = c._barcodeUnit
        // 矢量条码组：模块矩形不写入 JSON（几百个对象太臃肿），载入时按元数据重建
        if (obj.type === 'group') delete (props as { objects?: unknown }).objects
      }
      if (c.kind === 'text') props.originalText = c.originalText
      if (c.kind === 'shape') props._shapeType = c._shapeType ?? 'ellipse'
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
  setPreviewRow(row: DataRow | null) {
    this.previewRow = row
    this.refreshAllContent()
    this.events.onDirty()
  }

  /** 供批量打印逐张切换序列号后重绘整张 */
  setSeqValue(value: string | null) {
    this.seqValue = value
    this.refreshAllContent()
  }

  private rerenderBarcode(obj: fabric.Object) {
    const c = cf(obj)
    const type = c._barcodeType ?? 'code128'
    const settings = c._barcodeSettings ?? defaultSettingsFor(type)
    // 显示文案 = 前后缀 + 原文 + 序列/列/跨对象解析（序列化对象再套末尾数字）
    const text = this.finalizeSerial(obj, this.resolveDesign(this.decoratedDesign(c)))
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
    return data
  }

  /**
   * 以工作区坐标系把"纸区域"导出为高清 PNG dataURL。
   * 导出时临时把画布切回工作区尺寸 + identity 视口变换(绕开屏幕缩放/视口裁剪),
   * 导出后恢复当前视口。供栅格 PNG / 打印 / 批量序列化截图复用。
   */
  toPaperDataUrl(scale = 3): string {
    const paper = this.getPaperBoundsPx()
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
    out.width = Math.round(paper.width * scale)
    out.height = Math.round(paper.height * scale)
    const ctx = out.getContext('2d')!
    ctx.scale(scale, scale)
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
    if (typeof s._barcodeRaw === 'string') {
      c._barcodeRaw = s._barcodeRaw
      c._barcodeType = (s._barcodeType as BarcodeType) ?? 'code128'
      c._barcodeTargetMm = (s._barcodeTargetMm as number) ?? undefined
      c._barcodeSettings = (s._barcodeSettings as BarcodeRenderSettings) ?? undefined
      c._barcodeUnit = (s._barcodeUnit as { w: number; barH: number } | undefined) ?? undefined
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
    if (!c._name) c._name = defaultName((c.kind ?? 'text') as ElementKind) // 兼容无命名的旧模板
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
      this.recreatePaperRect()
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
    this.recreatePaperRect()
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
    this.undoStack.push(JSON.parse(JSON.stringify(this.canvas.toJSON())))
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
