import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Toaster } from '@/components/ui/sonner'
import TopBar from '@/sections/TopBar'
import Toolbox from '@/sections/Toolbox'
import PropertyPanel from '@/sections/PropertyPanel'
import DataDock from '@/sections/DataDock'
import { CanvasController } from '@/lib/canvasEngine'
import { parseSpreadsheet } from '@/lib/spreadsheet'
import { mountRulers, type RulerHandle } from '@/lib/rulers'
import {
  exportJson,
  exportPng,
  exportPngPages,
  printCanvas,
  printBatch,
  renderSeqPages,
  canvasToHighResDataUrl,
} from '@/lib/export'
import { exportVectorPdf } from '@/lib/vectorExport'
import type { BarcodeType, BarcodeRenderSettings } from '@/lib/barcode'
import type { PaperSize, DataRow, ToolType } from '@/types/template'
import { DEFAULT_PAPER } from '@/types/template'
import type { ActiveObject } from '@/types/editor'
import type { TextStyle, SerialSpec } from '@/types/editor'
import BatchDialog from '@/components/editor/BatchDialog'
import { useIsCompact } from '@/hooks/use-compact'
import {
  Layers,
  Ungroup,
  Hand,
  SlidersHorizontal,
  ChevronDown,
  Maximize2,
  BringToFront,
  SendToBack,
  ArrowUp,
  ArrowDown,
} from 'lucide-react'

/** 批量渲染默认份数 */
const DEFAULT_COPIES = 10

export default function App() {
  // DOM / controller
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasElRef = useRef<HTMLCanvasElement>(null)
  const ctrlRef = useRef<CanvasController | null>(null)
  const zoomRef = useRef(1)
  const canvasWrapRef = useRef<HTMLElement | null>(null)
  const rulerHandleRef = useRef<RulerHandle | null>(null)

  // state
  const [paper, setPaper] = useState<PaperSize>(DEFAULT_PAPER)
  const [tool, setTool] = useState<ToolType | null>(null)
  const [active, setActive] = useState<ActiveObject | null>(null)
  const [zoom, setZoom] = useState(1)
  const [objectCount, setObjectCount] = useState(0)
  const [usedVariables, setUsedVariables] = useState<string[]>([])
  const [objectNames, setObjectNames] = useState<string[]>([])
  // dataset
  const [headers, setHeaders] = useState<string[]>([])
  const [rows, setRows] = useState<DataRow[]>([])
  const [fileName, setFileName] = useState<string | null>(null)
  const [currentIndex, setCurrentIndex] = useState(-1)
  // 批量序列化：'print' | 'pdf' | 'png' | null
  const [batchMode, setBatchMode] = useState<'print' | 'pdf' | 'png' | null>(null)
  const [batchBusy, setBatchBusy] = useState(false)
  /** 画布上生效的序列化配置（用于批量对话框预览） */
  const [activeSerial, setActiveSerial] = useState<SerialSpec | null>(null)
  /** 多选/编组状态（count≥2 多对象、isGroup 单个编组整体、isBarcodeGroup 单个条码组） */
  const [selection, setSelection] = useState<{ count: number; isGroup: boolean; isBarcodeGroup: boolean }>({ count: 0, isGroup: false, isBarcodeGroup: false })

  // ── 响应式布局 / 手抓平移 / 移动端属性抽屉 ─────────────
  const isCompact = useIsCompact()
  const [hand, setHand] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const panRef = useRef({ x: 0, y: 0 })

  // 移动端：单击选中即可（移动/拉伸由 fabric 原生处理），仅在「取消选中」时收起抽屉；
  // 属性抽屉的弹出改由「双击」触发（见下方 compact 双击监听），避免单选即遮挡画布。
  useEffect(() => {
    if (!isCompact) return
    if (!active) setSheetOpen(false)
  }, [active, isCompact])
  // 退出紧凑布局回到桌面时，关闭底部抽屉
  useEffect(() => {
    if (!isCompact) setSheetOpen(false)
  }, [isCompact])

  // ── 初始化 fabric 控制器 ────────────────────────────────
  useEffect(() => {
    const canvasEl = canvasElRef.current
    const stage = stageRef.current
    if (!canvasEl || !stage) return

    const ctrl = new CanvasController(canvasEl, DEFAULT_PAPER, {
      onActiveChange: (snap) => setActive(snap),
      onSelection: (info) => setSelection(info),
      onDirty: () => {
        setObjectCount(ctrl.getObjectCount())
        setUsedVariables(ctrl.collectUsedVariables())
        setObjectNames(ctrl.collectContentNames())
        setActiveSerial(ctrl.firstSerial())
      },
    })
    ctrlRef.current = ctrl
    if (import.meta.env.DEV) (window as unknown as { __appCtrl?: CanvasController }).__appCtrl = ctrl
    // 把 canvas 设为视口大小(替代旧方案"整张工作区 + CSS 缩放");缩放/平移改由 fabric viewportTransform 承担
    ctrl.setViewportSize(stage.clientWidth, stage.clientHeight)
    setObjectCount(0)
    setObjectCount(0)
    setObjectCount(0)

    // fabric 会把 canvas 包进 .canvas-container，保存引用用于 CSS 缩放
    const ctr = stage.querySelector<HTMLElement>('.canvas-container')
    if (ctr) {
      canvasWrapRef.current = ctr
      // canvas 现在就是视口大小,flex 不会压缩它;移除旧的 CSS 缩放干预
      ctr.style.transform = 'none'
    }
    zoomTo100() // 首次打开也默认显示 100% 实际大小

    return () => {
      ctrl.destroy()
      rulerHandleRef.current?.destroy()
      rulerHandleRef.current = null
      ctrlRef.current = null
      canvasWrapRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── 纸张标尺：屏幕空间覆盖层，挂在视口(stage)上，随 zoom/pan 重绘 ─────────────
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    rulerHandleRef.current?.destroy()
    rulerHandleRef.current = mountRulers(stage)
    syncRulers(zoomRef.current, panRef.current.x, panRef.current.y)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paper])

  // ── 视口缩放 + 平移（fabric viewportTransform，矢量重绘）────

  /** 同步标尺：视口尺寸 + 当前 zoom/pan。
   *  标尺是「屏幕空间覆盖层」，不随画布变换，故每次视图变化都要按
   *  屏幕坐标 → 纸张毫米的映射重算刻度，才能与纸张严格对齐。 */
  const syncRulers = useCallback((zz: number, px: number, py: number) => {
    const rh = rulerHandleRef.current
    const ctrl = ctrlRef.current
    const stage = stageRef.current
    if (!rh || !ctrl || !stage) return
    rh.resize(stage.clientWidth, stage.clientHeight)
    const pb = ctrl.getPaperBoundsPx()
    rh.redraw({
      zoom: zz,
      panX: px,
      panY: py,
      paperOffsetX: pb.left,
      paperOffsetY: pb.top,
    })
  }, [])

  const applyView = useCallback(
    (zz: number, px: number, py: number) => {
      const ctrl = ctrlRef.current
      // 改用 fabric 原生 viewportTransform:矢量重绘,放大不再糊
      if (ctrl) ctrl.applyViewportTransform(zz, px, py)
      syncRulers(zz, px, py)
    },
    [syncRulers],
  )

  const applyZoom = useCallback(
    (next: number) => {
      const zz = Math.min(6, Math.max(0.2, next))
      zoomRef.current = zz
      setZoom(zz)
      applyView(zz, panRef.current.x, panRef.current.y)
    },
    [applyView],
  )

  const setPanView = useCallback(
    (px: number, py: number) => {
      panRef.current = { x: px, y: py }
      applyView(zoomRef.current, px, py)
    },
    [applyView],
  )

  /** 一次性设定 zoom + pan（避免滚轮缩放时两次渲染造成抖动） */
  const setView = useCallback(
    (zz: number, px: number, py: number) => {
      const z = Math.min(6, Math.max(0.2, zz))
      zoomRef.current = z
      panRef.current = { x: px, y: py }
      setZoom(z)
      applyView(z, px, py)
    },
    [applyView],
  )

  /**
   * 让「纸张中心」对齐视口中心所需的 pan。
   * wrap 以 flex 居中于 stage 且 transform-origin 为 center，故
   * 屏幕偏移 = (纸心 - 工作区中心) * z + pan，令其为 0 即得。
   * 工作区向左侧/上方扩张后纸张不再居中于工作区，必须按此式补偿。
   */
  const panForCenteredPaper = useCallback((zz: number) => {
    const ctrl = ctrlRef.current
    if (!ctrl) return { x: 0, y: 0 }
    const vp = ctrl.getViewportSize()
    const pc = ctrl.paperCenter()
    // 视口中心对齐纸心:screen = pc*z + pan → pan = vCenter - pc*z
    return { x: vp.width / 2 - pc.x * zz, y: vp.height / 2 - pc.y * zz }
  }, [])

  /** 回到 100%（实际大小，1px=1px）：新建/导入标签的默认视图 */
  const zoomTo100 = useCallback(() => {
    const p = panForCenteredPaper(1)
    setPanView(p.x, p.y)
    applyZoom(1)
  }, [applyZoom, setPanView, panForCenteredPaper])

  const fitToView = useCallback(() => {
    const stage = stageRef.current
    const ctrl = ctrlRef.current
    if (!stage || !ctrl) return
    const { w, h } = ctrl.getCanvasSizePx()
    const vw = stage.clientWidth - 40
    const vh = stage.clientHeight - 40
    if (vw <= 0 || vh <= 0) return
    const zz = Math.min(vw / w, vh / h)
    const p = panForCenteredPaper(zz)
    setPanView(p.x, p.y)
    applyZoom(zz)
  }, [applyZoom, setPanView, panForCenteredPaper])

  const zoomIn = useCallback(() => applyZoom(zoomRef.current * 1.25), [applyZoom])
  const zoomOut = useCallback(() => applyZoom(zoomRef.current / 1.25), [applyZoom])

  // 滚轮缩放 + 窗口尺寸变化自动适配
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const delta = e.deltaY < 0 ? 1.15 : 1 / 1.15
      const z = zoomRef.current
      const zz = Math.min(6, Math.max(0.2, z * delta))
      if (zz === z) return
      // 以光标为锚点缩放：光标下的工作区坐标在缩放前后保持不动
      const rect = stage.getBoundingClientRect()
      // 光标相对视口左上角的偏移(视口变换原点 = 视口左上角)
      const dx = e.clientX - rect.left
      const dy = e.clientY - rect.top
      const pan = panRef.current
      const nx = dx - (dx - pan.x) * (zz / z)
      const ny = dy - (dy - pan.y) * (zz / z)
      setView(zz, nx, ny)
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    const mountedAt = Date.now()
    const ro = new ResizeObserver(() => {
      const ctrl = ctrlRef.current
      if (ctrl) ctrl.setViewportSize(stage.clientWidth, stage.clientHeight)
      syncRulers(zoomRef.current, panRef.current.x, panRef.current.y)
      // 初始挂载/刷新后的一小段时间内容器会因字体加载等发生多次 reflow，
      // 若此时自动 fit 会覆盖掉“首开/新建”设置的 100%。首段宽限期内忽略。
      if (Date.now() - mountedAt < 700) return
      fitToView()
    })
      ro.observe(stage)
    return () => {
      stage.removeEventListener('wheel', onWheel)
      ro.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitToView, setView])

  // 开启手抓平移时：临时禁用画布框选并取消选中，避免拖动画布时误选对象
  useEffect(() => {
    const ctrl = ctrlRef.current
    if (!ctrl) return
    ctrl.canvas.selection = !hand
    if (hand) {
      ctrl.canvas.discardActiveObject()
      ctrl.canvas.requestRenderAll()
      setActive(null)
    } else {
      ctrl.canvas.requestRenderAll()
    }
  }, [hand])

  // ── 手抓平移 / 双指缩放（hand 工具开启时接管画布指针）────
  useEffect(() => {
    const el = canvasWrapRef.current
    if (!hand || !el) return
    const pts = new Map<number, { x: number; y: number }>()
    let lastDist = 0
    let dragging = false

    const dist = () => {
      const p = Array.from(pts.values())
      if (p.length < 2) return 0
      return Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y)
    }
    const onDown = (e: PointerEvent) => {
      el.setPointerCapture(e.pointerId)
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
      dragging = true
      if (pts.size === 2) lastDist = dist()
    }
    const onMove = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return
      const prev = pts.get(e.pointerId)!
      const dx = e.clientX - prev.x
      const dy = e.clientY - prev.y
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (pts.size === 1) {
        if (dragging) setPanView(panRef.current.x + dx, panRef.current.y + dy)
      } else if (pts.size >= 2) {
        const d = dist()
        if (lastDist > 0) {
          const factor = d / lastDist
          applyZoom(zoomRef.current * factor)
        }
        lastDist = d
      }
    }
    const onUp = (e: PointerEvent) => {
      pts.delete(e.pointerId)
      el.releasePointerCapture?.(e.pointerId)
      if (pts.size === 0) dragging = false
    }
    el.style.touchAction = 'none'
    el.style.cursor = 'grab'
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
    return () => {
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
    }
  }, [hand, applyZoom, setPanView])

  // ── 按住滚轮（中键）拖动画布平移（与 hand 工具、滚轮缩放互不冲突）──
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    let panning = false
    let startX = 0
    let startY = 0
    let startPanX = 0
    let startPanY = 0

    let lastMid = 0
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 1) return // 仅响应鼠标中键（滚轮按下）
      e.preventDefault() // 阻止浏览器中键自动滚动
      // 双击滚轮 → 适应画布
      const now = Date.now()
      if (now - lastMid < 300) {
        lastMid = 0
        panning = false
        stage.style.cursor = ''
        fitToView()
        return
      }
      lastMid = now
      panning = true
      startX = e.clientX
      startY = e.clientY
      startPanX = panRef.current.x
      startPanY = panRef.current.y
      stage.style.cursor = 'grabbing'
    }
    const onMouseMove = (e: MouseEvent) => {
      if (!panning) return
      setPanView(startPanX + (e.clientX - startX), startPanY + (e.clientY - startY))
    }
    const onMouseUp = () => {
      if (!panning) return
      panning = false
      stage.style.cursor = ''
    }
    // 部分浏览器中键松开会触发 auxclick，阻止其默认（避免粘贴板/链接等操作）
    const onAuxClick = (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault()
    }
    stage.addEventListener('mousedown', onMouseDown)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    stage.addEventListener('auxclick', onAuxClick)
    return () => {
      stage.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      stage.removeEventListener('auxclick', onAuxClick)
      stage.style.cursor = ''
    }
  }, [setPanView, fitToView])

  // ── 移动端：双击（或双指轻点）弹出属性抽屉 ──────────────
  useEffect(() => {
    if (!isCompact) return
    const wrap = canvasWrapRef.current
    const upper = wrap?.querySelector('canvas.upper-canvas') as HTMLCanvasElement | null
    if (!upper) return
    let last = 0
    const open = () => {
      if (!hand) setSheetOpen(true)
    }
    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return // 桌面走原生 dblclick
      const now = Date.now()
      if (now - last < 320 && !hand) {
        open()
        last = 0
      } else {
        last = now
      }
    }
    const onDbl = () => open()
    upper.addEventListener('pointerdown', onPointerDown)
    upper.addEventListener('dblclick', onDbl)
    return () => {
      upper.removeEventListener('pointerdown', onPointerDown)
      upper.removeEventListener('dblclick', onDbl)
    }
  }, [isCompact, hand])

  // ── 添加元素（tool 触发）────────────────────────────────
  const safeAddBarcode = useCallback((ctrl: CanvasController, type: BarcodeType) => {
    try {
      ctrl.addBarcode(type)
    } catch (err) {
      toast.error('条码生成失败', {
        description: err instanceof Error ? err.message : '请检查内容是否符合该码制',
      })
    }
  }, [])

  useEffect(() => {
    if (!tool) return
    const ctrl = ctrlRef.current
    if (!ctrl) {
      setTool(null)
      return
    }
    ctrl.pushHistory()
    switch (tool) {
      case 'text':
        ctrl.addText()
        break
      case 'rect':
        ctrl.addRect()
        break
      case 'line':
        ctrl.addLine()
        break
      case 'shape-ellipse':
        ctrl.addShape('ellipse')
        break
      case 'shape-triangle':
        ctrl.addShape('triangle')
        break
      case 'shape-diamond':
        ctrl.addShape('diamond')
        break
      case 'shape-star':
        ctrl.addShape('star')
        break
      case 'barcode-code128':
        safeAddBarcode(ctrl, 'code128')
        break
      case 'barcode-qrcode':
        safeAddBarcode(ctrl, 'qrcode')
        break
    }
    setTool(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool])

  // ── 纸张变化应用到画布 ──────────────────────────────────
  const applyPaper = useCallback((p: PaperSize) => {
    const ctrl = ctrlRef.current
    if (!ctrl) return
    ctrl.applyPaper(p)
    setPaper(p)
    requestAnimationFrame(() => fitToView())
  }, [fitToView])

  const handlePaperChange = useCallback(
    (p: PaperSize) => {
      // 输入时只更新输入框；失焦后统一应用由 Panel 提交。此处直接应用以贴合“所见即所得”
      applyPaper(p)
    },
    [applyPaper],
  )

  // ── 属性操作 ────────────────────────────────────────────
  const onGeometry = useCallback(
    (patch: Partial<Pick<ActiveObject, 'x' | 'y' | 'width' | 'height' | 'angle'>>) => {
      const ctrl = ctrlRef.current
      if (!ctrl || !ctrl.canvas.getActiveObject()) return
      ctrl.beginFieldEdit()
      ctrl.setActiveGeometry(patch)
    },
    [],
  )
  /** 矩形/直线：修改描边粗细 */
  const onStrokeWidthChange = useCallback((px: number) => {
    const ctrl = ctrlRef.current
    if (!ctrl || !ctrl.canvas.getActiveObject()) return
    ctrl.beginFieldEdit()
    ctrl.setActiveStrokeWidth(px)
  }, [])
  /** 矩形：修改圆角半径 */
  const onCornerRadiusChange = useCallback((mm: number) => {
    const ctrl = ctrlRef.current
    if (!ctrl || !ctrl.canvas.getActiveObject()) return
    ctrl.beginFieldEdit()
    ctrl.setActiveCornerRadius(mm)
  }, [])
  /** 描边颜色 */
  const onStrokeColorChange = useCallback((hex: string) => {
    const ctrl = ctrlRef.current
    if (!ctrl || !ctrl.canvas.getActiveObject()) return
    ctrl.beginFieldEdit()
    ctrl.setActiveStrokeColor(hex)
  }, [])
  /** 填充颜色（null=透明） */
  const onFillColorChange = useCallback((color: string | null) => {
    const ctrl = ctrlRef.current
    if (!ctrl || !ctrl.canvas.getActiveObject()) return
    ctrl.beginFieldEdit()
    ctrl.setActiveFillColor(color)
  }, [])
  /** 文本区域框：边框+底色 */
  const onTextRegionChange = useCallback((r: { border: boolean; bg: boolean }) => {
    const ctrl = ctrlRef.current
    if (!ctrl || !ctrl.canvas.getActiveObject()) return
    ctrl.beginFieldEdit()
    ctrl.setActiveTextRegion(r)
  }, [])
  const onContentChange = useCallback((text: string) => {
    const ctrl = ctrlRef.current
    if (!ctrl) return
    try {
      ctrl.updateContent(text)
    } catch (err) {
      toast.error('内容无效', {
        description: err instanceof Error ? err.message : '该内容不符合当前码制',
      })
    }
  }, [])
  const onBarcodeTypeChange = useCallback((type: BarcodeType) => {
    const ctrl = ctrlRef.current
    if (!ctrl) return
    ctrl.pushHistory()
    try {
      ctrl.setBarcodeType(type)
    } catch (err) {
      toast.error('码制渲染失败', {
        description: err instanceof Error ? err.message : '请检查内容是否符合该码制',
      })
    }
  }, [])
  const onTextStyleChange = useCallback((patch: Partial<TextStyle>) => {
    const ctrl = ctrlRef.current
    if (!ctrl || !ctrl.canvas.getActiveObject()) return
    ctrl.beginFieldEdit()
    ctrl.setTextStyle(patch)
  }, [])
  const onNameChange = useCallback((name: string) => {
    const ctrl = ctrlRef.current
    if (!ctrl) return
    ctrl.beginFieldEdit()
    ctrl.setActiveName(name)
  }, [])
  const onBarcodeSettingsChange = useCallback((patch: Partial<BarcodeRenderSettings>) => {
    const ctrl = ctrlRef.current
    if (!ctrl) return
    ctrl.beginFieldEdit()
    try {
      ctrl.setBarcodeSettings(patch)
    } catch (err) {
      toast.error('条码属性更新失败', {
        description: err instanceof Error ? err.message : '请调整参数后重试',
      })
    }
  }, [])
  const onContentDecorChange = useCallback((patch: { prefix?: string; suffix?: string }) => {
    const ctrl = ctrlRef.current
    if (!ctrl) return
    ctrl.beginFieldEdit()
    ctrl.setContentDecor(patch)
  }, [])
  const onSerialChange = useCallback((serial: SerialSpec | null) => {
    const ctrl = ctrlRef.current
    if (!ctrl) return
    ctrl.beginFieldEdit()
    ctrl.setActiveSerial(serial)
  }, [])
  const onDeleteActive = useCallback(() => {
    const ctrl = ctrlRef.current
    if (!ctrl || !ctrl.canvas.getActiveObject()) return
    ctrl.pushHistory()
    ctrl.removeActive()
    setActive(null)
  }, [])
  const onDuplicate = useCallback(() => {
    const ctrl = ctrlRef.current
    if (!ctrl || !ctrl.canvas.getActiveObject()) return
    ctrl.pushHistory()
    ctrl.duplicateActive()
  }, [])

  /** 编组当前多选 */
  const onGroupSelection = useCallback(() => {
    const ctrl = ctrlRef.current
    if (!ctrl) return
    if (ctrl.groupSelection()) {
      toast.success('已编组，可整体移动/缩放；双击组可解组')
    }
  }, [])

  /** 解组当前选中的单个编组 */
  const onUngroupSelection = useCallback(() => {
    const ctrl = ctrlRef.current
    if (!ctrl) return
    if (ctrl.ungroupSelection()) toast.success('已解组')
  }, [])

  /** 对齐当前多选到包围盒某一边/中心 */
  const onAlignSelection = useCallback((align: 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom') => {
    const ctrl = ctrlRef.current
    if (!ctrl) return
    ctrl.alignSelection(align)
  }, [])

  /** 图层操作：front/back/up/down（作用于当前选中对象整体） */
  const onLayer = useCallback((action: 'front' | 'back' | 'up' | 'down') => {
    const ctrl = ctrlRef.current
    if (!ctrl) return
    if (!ctrl.layer(action)) toast('已到图层边界')
  }, [])

  const onPickImage = useCallback(async (file: File) => {
    const ctrl = ctrlRef.current
    if (!ctrl) {
      toast.error('画布未就绪')
      return
    }
    try {
      await ctrl.addImageFile(file)
      toast.success('图片已添加')
    } catch {
      toast.error('图片加载失败')
    }
  }, [])

  // ── 工具栏文件动作 ──────────────────────────────────────
  const onNew = useCallback(() => {
    const ctrl = ctrlRef.current
    if (!ctrl) return
    ctrl.clearAll()
    setActive(null)
    // 回到设计态
    setCurrentIndex(-1)
    setUsedVariables([])
    zoomTo100() // 新建空白标签 → 显示默认 100% 实际大小
    toast('已新建空白标签', {
      description: `画布已清空，默认 ${DEFAULT_PAPER.widthMm}×${DEFAULT_PAPER.heightMm}mm`,
    })
  }, [zoomTo100])

  const onImportJson = useCallback(
    (file: File) => {
      const reader = new FileReader()
      reader.onload = (e) => {
        try {
          const parsed = JSON.parse(String(e.target?.result))
          const paper = (parsed?.paper ?? DEFAULT_PAPER) as PaperSize
          const ctrl = ctrlRef.current
          if (!ctrl) throw new Error('画布未就绪')
          // 先应用纸张再载入对象
          ctrl.applyPaper(paper)
          ctrl.loadFromJSON(parsed?.canvas ?? {})
          setPaper(paper)
          setActive(null)
          requestAnimationFrame(() => zoomTo100())
          toast.success('模板导入成功')
        } catch {
          toast.error('模板导入失败', { description: 'JSON 格式有误，请检查文件' })
        }
      }
      reader.readAsText(file)
    },
    [zoomTo100],
  )

  const onExportJson = useCallback(() => {
    const ctrl = ctrlRef.current
    if (!ctrl) return
    if (ctrl.getObjectCount() === 0) {
      toast.warning('画布为空', { description: '请先添加内容再导出模板' })
      return
    }
    exportJson(paper, ctrl)
    toast.success('模板已导出为 JSON')
  }, [paper])

  /**
   * 批量渲染若干张（序号递增）后执行动作。
   * 未开启序列化时 copies 视为 1，只渲染当前画布。
   */
  const runBatch = useCallback(
    async (mode: 'print' | 'pdf' | 'png', copies: number) => {
      const ctrl = ctrlRef.current
      if (!ctrl) return
      setBatchBusy(true)
      try {
        // PDF：走矢量导出（文本可选中/搜索，中文内嵌子集字体），内部按份数分页
        if (mode === 'pdf') {
          await exportVectorPdf(ctrl, paper, {
            copies: ctrl.hasActiveSerial() ? copies : 1,
            onProgress: (done, total) => {
              if (done % 10 === 0 || done === total) toast.message(`正在生成矢量 PDF ${done}/${total}…`)
            },
          })
          toast.success('PDF 已导出（矢量）')
        } else {
          const pages = ctrl.hasActiveSerial()
            ? await renderSeqPages(ctrl, copies, 3, (done, total) => {
                if (done % 10 === 0 || done === total) {
                  toast.message(`正在渲染 ${done}/${total} 张…`)
                }
              })
            : [canvasToHighResDataUrl(ctrl, 3)]
          if (mode === 'print') {
            await printBatch(pages, paper)
            toast.success(`已提交 ${pages.length} 张到打印`)
          } else {
            exportPngPages(pages, '标签')
            toast.success(`已导出 ${pages.length} 张 PNG`)
          }
        }
      } catch (err) {
        toast.error('批量输出失败', {
          description: err instanceof Error ? err.message : '请减少份数后重试',
        })
      } finally {
        setBatchBusy(false)
        setBatchMode(null)
      }
    },
    [paper],
  )

  const onPrint = useCallback(() => {
    const ctrl = ctrlRef.current
    if (!ctrl || ctrl.getObjectCount() === 0) {
      toast.warning('画布为空', { description: '请先添加内容' })
      return
    }
    // 启用了序列化 → 先问份数；否则单张直打
    if (ctrl.hasActiveSerial()) {
      setBatchMode('print')
      return
    }
    void printCanvas(ctrl, paper)
  }, [paper])

  const onExportPng = useCallback(() => {
    const ctrl = ctrlRef.current
    if (!ctrl || ctrl.getObjectCount() === 0) {
      toast.warning('画布为空', { description: '请先添加内容' })
      return
    }
    // 启用了序列化 → 先问份数，导出多张递增 PNG
    if (ctrl.hasActiveSerial()) {
      setBatchMode('png')
      return
    }
    void exportPng(ctrl)
    toast.success('PNG 已导出')
  }, [])

  const onExportPdf = useCallback(() => {
    const ctrl = ctrlRef.current
    if (!ctrl || ctrl.getObjectCount() === 0) {
      toast.warning('画布为空', { description: '请先添加内容' })
      return
    }
    // 启用了序列化 → 先问份数，导出多页递增 PDF
    if (ctrl.hasActiveSerial()) {
      setBatchMode('pdf')
      return
    }
    void exportVectorPdf(ctrl, paper, { copies: 1 }).catch((err) =>
      toast.error('PDF 导出失败', {
        description: err instanceof Error ? err.message : '请重试',
      }),
    )
  }, [paper])

  // ── 数据导入与预览 ──────────────────────────────────────
  const onPickFile = useCallback(
    async (file: File) => {
      try {
        const res = await parseSpreadsheet(file)
        if (res.rows.length === 0) {
          toast.warning('未读取到数据行', { description: '请确认首行为表头' })
          return
        }
        setHeaders(res.headers)
        setRows(res.rows)
        setFileName(res.fileName)
        setCurrentIndex(-1) // 设计态，不自动替换
        toast.success(`已解析 ${res.rows.length} 行数据`)
      } catch (err) {
        toast.error('数据解析失败', {
          description: err instanceof Error ? err.message : '文件格式不支持',
        })
      }
    },
    [],
  )

  const selectRow = useCallback(
    (idx: number) => {
      const ctrl = ctrlRef.current
      if (!ctrl) return
      if (idx < 0 || idx >= rows.length) return
      setCurrentIndex(idx)
      ctrl.setPreviewRow(rows[idx])
    },
    [rows],
  )

  const clearData = useCallback(() => {
    const ctrl = ctrlRef.current
    if (!ctrl) return
    setHeaders([])
    setRows([])
    setFileName(null)
    setCurrentIndex(-1)
    ctrl.setPreviewRow(null) // 还原设计态占位符
    toast('已清空数据', { description: '画布已还原为 {{变量}} 原文' })
  }, [])

  // 全局快捷键：Delete 删除 / Ctrl+C 复制 / Ctrl+V 粘贴 / Ctrl+Z 撤销 / 方向键微调
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      // 在输入框/文本域内不劫持，保留原生编辑/复制粘贴/撤销
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      const ctrl = ctrlRef.current
      if (!ctrl) return
      const mod = e.ctrlKey || e.metaKey

      if (mod && (e.key === 'c' || e.key === 'C')) {
        if (ctrl.canvas.getActiveObject()) {
          e.preventDefault()
          const n = ctrl.copyActive()
          if (n > 0) toast.success(`已复制 ${n} 个对象`)
        }
        return
      }
      if (mod && (e.key === 'v' || e.key === 'V')) {
        if (ctrl.canPaste()) {
          e.preventDefault()
          ctrl.pushHistory()
          const n = ctrl.pasteClipboard()
          if (n > 0) toast.success(`已粘贴 ${n} 个对象`)
        }
        return
      }
      if (mod && (e.key === 'z' || e.key === 'Z')) {
        if (!e.shiftKey && ctrl.canUndo()) {
          e.preventDefault()
          ctrl.undo()
          toast('已撤销')
        }
        return
      }
      // 方向键微调（无对象则不拦截，避免挡住面板滚动）
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        if (ctrl.canvas.getActiveObject()) {
          e.preventDefault()
          const step = 1 // mm
          const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
          const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
          ctrl.nudgeActive(dx, dy)
        }
        return
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (ctrl.canvas.getActiveObject()) {
          e.preventDefault()
          ctrl.pushHistory()
          ctrl.removeActive()
          setActive(null)
        }
      }
    }
    const onUp = () => {
      ctrlRef.current?.endNudge()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onUp)
    }
  }, [])

  const currentRow = currentIndex >= 0 ? rows[currentIndex] ?? null : null

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <TopBar
        zoom={zoom}
        zoomIn={zoomIn}
        zoomOut={zoomOut}
        zoomFit={fitToView}
        onNew={onNew}
        onImportJson={onImportJson}
        onExportJson={onExportJson}
        onPrint={onPrint}
        onExportPng={onExportPng}
        onExportPdf={onExportPdf}
      />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <Toolbox tool={tool} onToolChange={setTool} onPickImage={onPickImage} />

        {/* 中间画布视口 */}
        <div
          ref={stageRef}
          className="relative flex flex-1 items-center justify-center overflow-hidden bg-slate-200/70 [background-image:radial-gradient(#cbd5e1_1px,transparent_1px)] [background-size:22px_22px]"
          onMouseDown={(e) => {
            // 左键点到空白处 → 取消选择（中键/右键不触发，避免干扰平移/右键菜单）
            if (e.button !== 0) return
            const ctrl = ctrlRef.current
            const t = e.target as HTMLElement
            if (ctrl && t === stageRef.current) {
              ctrl.canvas.discardActiveObject()
              ctrl.canvas.requestRenderAll()
              setActive(null)
            }
          }}
        >
          <canvas ref={canvasElRef} className="shadow-xl ring-1 ring-black/10" />

          {/* 画布视口浮层：手抓平移开关 */}
          <div className="absolute right-2 top-2 z-30 flex flex-col items-stretch gap-1 overflow-hidden rounded-lg border bg-white/95 p-1 shadow-md">
            <button
              type="button"
              onClick={() => setHand((v) => !v)}
              title={hand ? '手抓平移中（点选对象请关闭）' : '开启手抓平移 / 双指缩放'}
              className={
                'flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors ' +
                (hand ? 'bg-primary text-primary-foreground hover:bg-primary/90' : 'hover:bg-accent')
              }
            >
              <Hand className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => {
                setHand(false)
                fitToView()
              }}
              title="适应画布"
              className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
            >
              <Maximize2 className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => {
                setHand(false)
                zoomTo100()
              }}
              title="缩放到 100%（实际大小）"
              className="flex h-9 w-9 items-center justify-center rounded-md text-xs font-semibold tabular-nums text-muted-foreground hover:bg-accent"
            >
              1:1
            </button>
          </div>

          {/* 移动端浮层：手动打开属性抽屉 */}
          {isCompact && (
            <button
              type="button"
              onClick={() => setSheetOpen(true)}
              title="属性面板"
              className="absolute bottom-3 right-3 z-30 flex h-11 w-11 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg active:scale-95"
            >
              <SlidersHorizontal className="h-5 w-5" />
            </button>
          )}
          {/* 编组 / 对齐 / 层次 统一浮层：常显于画布顶部。
              无选中 → 整体黯淡且按钮禁用；有选中 → 高亮（ring）且可用。
              其中编组/对齐需多选(≥2)才可用，层次单个对象即可用。 */}
          <div className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center">
            <div
              className={
                'pointer-events-auto flex max-w-full items-center gap-1 overflow-x-auto rounded-lg border bg-white/95 p-1 shadow-md transition-all duration-150 ' +
                (selection.count === 0
                  ? 'opacity-40'
                  : 'opacity-100 ring-1 ring-primary/40')
              }
            >
              {/* 编组 / 解组 */}
              <button
                type="button"
                disabled={selection.count < 2}
                onClick={onGroupSelection}
                className={
                  'flex h-8 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium text-slate-600 transition-colors ' +
                  (selection.count < 2
                    ? 'cursor-not-allowed opacity-50'
                    : 'hover:bg-slate-100')
                }
                title="编组选中的多个对象"
              >
                <Layers className="h-4 w-4" />
                编组
              </button>
              <button
                type="button"
                disabled={!(selection.isGroup && !selection.isBarcodeGroup)}
                onClick={onUngroupSelection}
                className={
                  'flex h-8 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium text-slate-600 transition-colors ' +
                  (!(selection.isGroup && !selection.isBarcodeGroup)
                    ? 'cursor-not-allowed opacity-50'
                    : 'hover:bg-slate-100')
                }
                title="解组（拆回独立对象）"
              >
                <Ungroup className="h-4 w-4" />
                解组
              </button>

              <span className="mx-1 h-5 w-px shrink-0 bg-slate-200" />

              {/* 对齐 */}
              <span className="shrink-0 px-1 text-[10px] font-medium uppercase tracking-wide text-slate-400">对齐</span>
              <AlignBtn glyph="left" tip="左对齐（靠到包围盒左缘）" disabled={selection.count < 2} onClick={() => onAlignSelection('left')} />
              <AlignBtn glyph="hcenter" tip="水平居中（关于竖直中线）" disabled={selection.count < 2} onClick={() => onAlignSelection('hcenter')} />
              <AlignBtn glyph="right" tip="右对齐（靠到包围盒右缘）" disabled={selection.count < 2} onClick={() => onAlignSelection('right')} />
              <AlignBtn glyph="top" tip="顶对齐（靠到包围盒上缘）" disabled={selection.count < 2} onClick={() => onAlignSelection('top')} />
              <AlignBtn glyph="vcenter" tip="垂直居中（关于水平中线）" disabled={selection.count < 2} onClick={() => onAlignSelection('vcenter')} />
              <AlignBtn glyph="bottom" tip="底对齐（靠到包围盒下缘）" disabled={selection.count < 2} onClick={() => onAlignSelection('bottom')} />

              <span className="mx-1 h-5 w-px shrink-0 bg-slate-200" />

              {/* 层次 */}
              <span className="shrink-0 px-1 text-[10px] font-medium uppercase tracking-wide text-slate-400">层次</span>
              {([
                { a: 'front', Icon: BringToFront, t: '置于顶层' },
                { a: 'up', Icon: ArrowUp, t: '上移一层' },
                { a: 'down', Icon: ArrowDown, t: '下移一层' },
                { a: 'back', Icon: SendToBack, t: '置于底层' },
              ] as const).map(({ a, Icon, t }) => (
                <button
                  key={a}
                  type="button"
                  disabled={selection.count < 1}
                  onClick={() => onLayer(a)}
                  title={t}
                  className={
                    'flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-600 transition-colors ' +
                    (selection.count < 1
                      ? 'cursor-not-allowed opacity-50'
                      : 'hover:bg-slate-100')
                  }
                >
                  <Icon className="h-4 w-4" />
                </button>
              ))}
            </div>
          </div>

        </div>

        {/* 桌面布局：右侧固定属性面板（紧凑布局改用底部抽屉，见下方） */}
        {!isCompact && (
          <PropertyPanel
            paper={paper}
            onPaperChange={handlePaperChange}
            active={active}
            usedVariables={usedVariables}
            objectNames={objectNames}
            headers={headers}
            currentRow={currentRow}
            onGeometry={onGeometry}
            onContentChange={onContentChange}
            onTextStyleChange={onTextStyleChange}
            onBarcodeTypeChange={onBarcodeTypeChange}
            onNameChange={onNameChange}
            onBarcodeSettingsChange={onBarcodeSettingsChange}
            onContentDecorChange={onContentDecorChange}
            onSerialChange={onSerialChange}
            onDuplicate={onDuplicate}
            onDeleteActive={onDeleteActive}
            onStrokeWidthChange={onStrokeWidthChange}
            onCornerRadiusChange={onCornerRadiusChange}
            onStrokeColorChange={onStrokeColorChange}
            onFillColorChange={onFillColorChange}
            onTextRegionChange={onTextRegionChange}
            objectCount={objectCount}
          />
        )}
      </div>

      {/* 移动端 / 窄屏：属性底部抽屉（复用同一 PropertyPanel，bare 模式） */}
      {isCompact && sheetOpen && (
        <div className="fixed inset-0 z-40 flex flex-col justify-end">
          <div className="absolute inset-0 bg-black/30" onClick={() => setSheetOpen(false)} />
          <div className="relative z-10 flex max-h-[72vh] min-h-[40vh] flex-col rounded-t-xl border-t bg-background shadow-2xl">
            {/* 抽屉头：标题 + 收起 */}
            <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
              <button
                type="button"
                onClick={() => setSheetOpen(false)}
                className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
                title="收起"
              >
                <ChevronDown className="h-5 w-5" />
              </button>
              <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">
                {active ? `属性 · ${active.name || '对象'}` : '画布设置'}
              </span>
              <div className="flex-1" />
            </div>
            {/* 滚动内容区 */}
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-4">
              <PropertyPanel
                paper={paper}
                onPaperChange={handlePaperChange}
                active={active}
                usedVariables={usedVariables}
                objectNames={objectNames}
                headers={headers}
                currentRow={currentRow}
                onGeometry={onGeometry}
                onContentChange={onContentChange}
                onTextStyleChange={onTextStyleChange}
                onBarcodeTypeChange={onBarcodeTypeChange}
                onNameChange={onNameChange}
                onBarcodeSettingsChange={onBarcodeSettingsChange}
                onContentDecorChange={onContentDecorChange}
                onSerialChange={onSerialChange}
                onDuplicate={onDuplicate}
                onDeleteActive={onDeleteActive}
                onStrokeWidthChange={onStrokeWidthChange}
                onCornerRadiusChange={onCornerRadiusChange}
            onStrokeColorChange={onStrokeColorChange}
            onFillColorChange={onFillColorChange}
            onTextRegionChange={onTextRegionChange}
                objectCount={objectCount}
                bare
              />
            </div>
          </div>
        </div>
      )}

      <DataDock
        fileName={fileName}
        headers={headers}
        rows={rows}
        currentIndex={currentIndex}
        usedVariables={usedVariables}
        onPickFile={onPickFile}
        onSelectRow={selectRow}
        onClearData={clearData}
      />

      <BatchDialog
        open={batchMode !== null}
        onOpenChange={(v) => !v && setBatchMode(null)}
        title={
          batchMode === 'pdf'
            ? '批量导出 PDF'
            : batchMode === 'png'
              ? '批量导出 PNG'
              : '批量打印'
        }
        description="画布中使用了 {{seq}} 且已开启序列化，请选择要输出的份数，序号将逐张递增。"
        defaultCopies={DEFAULT_COPIES}
        confirmLabel={
          batchMode === 'pdf' ? '导出 PDF' : batchMode === 'png' ? '导出 PNG' : '打印'
        }
        serial={activeSerial}
        busy={batchBusy}
        onConfirm={(copies) => {
          if (batchMode) void runBatch(batchMode, copies)
        }}
      />

      <Toaster richColors position="top-center" />
    </div>
  )
}

/** 对齐工具小按钮：自绘示意图形，直观表达「对齐到哪里」 */
function AlignBtn({
  glyph,
  tip,
  onClick,
  disabled,
}: {
  glyph: 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom'
  tip: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={tip}
      className={
        'flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-500 transition-colors ' +
        (disabled
          ? 'cursor-not-allowed opacity-40'
          : 'hover:bg-slate-100 hover:text-slate-700')
      }
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        {glyphGlyph(glyph)}
      </svg>
    </button>
  )
}

/** 对齐图形内容：灰色点线 = 参考位置；实心方块 = 对齐后的对象 */
function glyphGlyph(g: 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom') {
  const line = { stroke: '#94a3b8', strokeWidth: 1.4, strokeDasharray: '2 2' }
  const rect = { fill: 'currentColor' }
  switch (g) {
    case 'left':
      return (
        <>
          <line x1="4" y1="4" x2="4" y2="20" {...line} />
          <rect x="4" y="6" width="8" height="6" rx="0.5" {...rect} />
          <rect x="4" y="14" width="6" height="5" rx="0.5" {...rect} />
        </>
      )
    case 'right':
      return (
        <>
          <line x1="20" y1="4" x2="20" y2="20" {...line} />
          <rect x="12" y="6" width="8" height="6" rx="0.5" {...rect} />
          <rect x="14" y="14" width="6" height="5" rx="0.5" {...rect} />
        </>
      )
    case 'hcenter':
      return (
        <>
          <line x1="12" y1="4" x2="12" y2="20" {...line} />
          <rect x="7" y="6" width="10" height="6" rx="0.5" {...rect} />
          <rect x="9" y="14" width="6" height="5" rx="0.5" {...rect} />
        </>
      )
    case 'top':
      return (
        <>
          <line x1="4" y1="4" x2="20" y2="4" {...line} />
          <rect x="6" y="4" width="6" height="8" rx="0.5" {...rect} />
          <rect x="14" y="4" width="5" height="6" rx="0.5" {...rect} />
        </>
      )
    case 'bottom':
      return (
        <>
          <line x1="4" y1="20" x2="20" y2="20" {...line} />
          <rect x="6" y="12" width="6" height="8" rx="0.5" {...rect} />
          <rect x="14" y="14" width="5" height="6" rx="0.5" {...rect} />
        </>
      )
    case 'vcenter':
    default:
      return (
        <>
          <line x1="4" y1="12" x2="20" y2="12" {...line} />
          <rect x="6" y="7" width="6" height="10" rx="0.5" {...rect} />
          <rect x="14" y="9" width="5" height="6" rx="0.5" {...rect} />
        </>
      )
  }
}
