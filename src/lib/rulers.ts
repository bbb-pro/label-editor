// 纸张标尺（屏幕/视口空间）
//
// 旧实现把标尺挂进 .canvas-container 并依赖容器的 CSS transform 移动，
// 改用 fabric viewportTransform 后容器不再被 transform（尺寸=视口），标尺会被裁到视口外而"消失"。
// 现方案：标尺固定贴在视口上缘/左缘（不随画布变换），绘制时按当前
// viewportTransform(zoom/pan) 把「屏幕坐标」映射回「相对纸张的毫米」，
// 因此任意缩放/平移下都与纸张严格对齐，且刻度文字始终保持恒定可读大小。
//
// 视觉与交互对标开源项目 OpenPrint（https://gitee.com/haiming236/openprint）的 RulerOverlay：
//   · 用 SVG 而非 canvas 绘制（矢量清晰、可用固定配色跟随主题）
//   · 厚度 20px，左上角有遮挡方块
//   · 步长按缩放分级：zoom≥2→1mm / ≥1→5mm / ≥0.5→10mm / 否则 20mm
//   · 标签始终带毫米数字，间距不足时自动按 1/2/5/10 倍步长抽稀
//   · 竖尺数字水平排布不旋转
//   · 选中对象时，在两条标尺上以琥珀色「高亮带」投影出对象范围，并标注宽/高毫米数

import { mmToPx, pxToMm } from '@/lib/mm'

/** 标尺条厚度（屏幕 px） */
export const RULER = 20

/** 标签至少需要的横向空间（px）；据此决定每隔几格标一次数字 */
const LABEL_MIN_PX = 24

/** 深色主题配色（与 OpenPrint dark theme 一致） */
const DARK = {
  bg: '#1e1e1e',
  tick: '#555555',
  label: '#999999',
  edge: '#333333',
  band: 'rgba(245, 158, 11, 0.38)',
  bandBorder: 'rgba(251, 191, 36, 0.9)',
  bandText: '#fff7ed',
} as const

/** 浅色主题配色 */
const LIGHT = {
  bg: '#ffffff',
  tick: '#c0c4cc',
  label: '#909399',
  edge: '#e2e8f0',
  band: 'rgba(245, 158, 11, 0.30)',
  bandBorder: 'rgba(217, 119, 6, 0.85)',
  bandText: '#7c2d12',
} as const

const SVG_NS = 'http://www.w3.org/2000/svg'
const FONT_FAMILY = 'Inter, "PingFang SC", system-ui, sans-serif'

/** 选中对象在工作区坐标系下的包围盒 */
export interface RulerSelection {
  left: number
  top: number
  width: number
  height: number
}

export interface RulerView {
  zoom: number
  panX: number
  panY: number
  /** 纸张左上角在工作区中的逻辑坐标(px)，用于把刻度原点对齐到标签而非工作区 */
  paperOffsetX: number
  paperOffsetY: number
  /** 当前选中对象范围（工作区坐标）；无选中传 null */
  selection?: RulerSelection | null
}

export interface RulerHandle {
  /** 视口尺寸变化时调用 */
  resize: (w: number, h: number) => void
  /** zoom/pan/选中变化时调用 */
  redraw: (view: RulerView) => void
  destroy: () => void
}

/** 每格代表的毫米数：随缩放分级，保证相邻刻度间距落在可读区间 */
function stepMmForZoom(zoom: number): number {
  return zoom >= 2 ? 1 : zoom >= 1 ? 5 : zoom >= 0.5 ? 10 : 20
}

/** 把 raw 向上取整到 {1,2,5,10} 一档 */
function niceStride(raw: number): number {
  for (const s of [1, 2, 5, 10]) if (s >= raw - 1e-9) return s
  return 10
}

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag)
  if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v))
  return node
}

function setAttrs(node: SVGElement, attrs: Record<string, string | number>) {
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v))
}

/**
 * 把一组子节点同步到目标数量：少了补，多了裁。
 * 平移时每帧重绘，复用节点可避免反复创建/销毁造成 GC 抖动。
 */
function syncChildren<T extends SVGElement>(
  parent: SVGElement,
  pool: T[],
  count: number,
  factory: () => T,
): void {
  while (pool.length < count) {
    const node = factory()
    pool.push(node)
    parent.appendChild(node)
  }
  while (pool.length > count) {
    const node = pool.pop()
    node?.parentNode?.removeChild(node)
  }
}

export function mountRulers(container: HTMLElement): RulerHandle {
  const root = svg('svg', {
    class: 'pointer-events-none absolute inset-0 select-none',
    width: 1,
    height: 1,
  })
  root.style.position = 'absolute'
  root.style.left = '0'
  root.style.top = '0'
  root.style.zIndex = '10'

  // 绘制顺序（后者覆盖前者）：横尺底 → 横刻度 → 横数字 → 底边线
  //   → 竖尺底 → 竖刻度 → 竖数字 → 右边线 → 高亮带 → 左上角方块
  const hBg = svg('rect', { x: 0, y: 0, width: 1, height: RULER })
  const hTicks = svg('g')
  const hLabels = svg('g')
  const hEdge = svg('line', { x1: 0, y1: RULER - 0.5, y2: RULER - 0.5, x2: 1 })

  const vBg = svg('rect', { x: 0, y: 0, width: RULER, height: 1 })
  const vTicks = svg('g')
  const vLabels = svg('g')
  const vEdge = svg('line', { x1: RULER - 0.5, y1: 0, y2: 1, x2: RULER - 0.5 })

  const band = svg('g')
  const hBandRect = svg('rect', { x: 0, y: 0, width: 0, height: RULER, 'stroke-width': 1 })
  const vBandRect = svg('rect', { x: 0, y: 0, width: RULER, height: 0, 'stroke-width': 1 })
  const hBandSize = svg('text', {
    y: RULER - 6,
    'font-size': 10,
    'font-family': FONT_FAMILY,
    'text-anchor': 'middle',
  })
  const vBandSize = svg('text', {
    x: RULER / 2,
    'font-size': 10,
    'font-family': FONT_FAMILY,
    'text-anchor': 'middle',
  })
  band.append(hBandRect, vBandRect, hBandSize, vBandSize)

  const corner = svg('rect', { x: 0, y: 0, width: RULER, height: RULER })

  root.append(hBg, hTicks, hLabels, hEdge, vBg, vTicks, vLabels, vEdge, band, corner)
  container.appendChild(root)

  const poolHTick: SVGLineElement[] = []
  const poolHLabel: SVGTextElement[] = []
  const poolVTick: SVGLineElement[] = []
  const poolVLabel: SVGTextElement[] = []

  let W = 1
  let H = 1

  /**
   * 求出一条标尺上的可见刻度。
   * 第 i 格：毫米 = i × stepMm，屏幕坐标 = originPx + i × unitPx
   * （originPx 即"纸张左上角"投影到屏幕的位置，故 i<0 会显示负数，与 OpenPrint 一致）
   */
  function ticksFor(originPx: number, lengthPx: number, zoom: number) {
    const stepMm = stepMmForZoom(zoom)
    const unitPx = mmToPx(1) * zoom * stepMm
    const empty = { stepMm: stepMm, unitPx: unitPx, stride: 1, list: [] as Array<{ coord: number; mm: number }> }
    if (!(unitPx > 0.5)) return empty
    // 只保留落在标尺可见段内的刻度：coord ≥ RULER（躲开左上角方块）且 ≤ lengthPx
    const firstIdx = Math.ceil((RULER - originPx) / unitPx - 1e-9)
    const lastIdx = Math.floor((lengthPx - originPx) / unitPx + 1e-9)
    if (lastIdx < firstIdx) return empty
    // 防御超大标签/极小缩放下的超长遍历
    const safeLast = Math.min(lastIdx, firstIdx + 4000)
    const list: Array<{ coord: number; mm: number }> = []
    for (let i = firstIdx; i <= safeLast; i++) {
      list.push({ coord: originPx + i * unitPx, mm: i * stepMm })
    }
    // 相邻刻度太挤时按比例抽稀标签，保证数字之间有空隙
    const stride = niceStride(LABEL_MIN_PX / unitPx)
    return { stepMm, unitPx, stride, list }
  }

  /** 判断该格是否要显示数字 */
  function wantLabel(mm: number, stepMm: number, stride: number): boolean {
    if (stride <= 1) return true
    const k = mm / (stepMm * stride)
    return Math.abs(k - Math.round(k)) < 1e-6
  }

  const redraw = (view: RulerView) => {
    setAttrs(root, { width: W, height: H })
    setAttrs(hBg, { width: W })
    setAttrs(hEdge, { x2: W })
    setAttrs(vBg, { height: H })
    setAttrs(vEdge, { y2: H })

    const dark = document.documentElement.classList.contains('dark')
    const pal = dark ? DARK : LIGHT
    setAttrs(hBg, { fill: pal.bg })
    setAttrs(vBg, { fill: pal.bg })
    setAttrs(corner, { fill: pal.bg })
    setAttrs(hEdge, { stroke: pal.edge })
    setAttrs(vEdge, { stroke: pal.edge })
    setAttrs(hTicks, { stroke: pal.tick })
    setAttrs(vTicks, { stroke: pal.tick })
    setAttrs(hLabels, { fill: pal.label })
    setAttrs(vLabels, { fill: pal.label })
    setAttrs(hBandRect, { fill: pal.band, stroke: pal.bandBorder })
    setAttrs(vBandRect, { fill: pal.band, stroke: pal.bandBorder })
    setAttrs(hBandSize, { fill: pal.bandText })
    setAttrs(vBandSize, { fill: pal.bandText })

    const originX = view.paperOffsetX * view.zoom + view.panX
    const originY = view.paperOffsetY * view.zoom + view.panY

    // ── 横尺 ──
    const hs = ticksFor(originX, W, view.zoom)
    syncChildren(hTicks, poolHTick, hs.list.length, () => svg('line', { 'stroke-width': 1 }))
    hs.list.forEach((t, i) => {
      const x = Math.round(t.coord) + 0.5
      setAttrs(poolHTick[i], { x1: x, x2: x, y1: 12, y2: RULER })
    })
    const hShown = hs.list.filter((t) => wantLabel(t.mm, hs.stepMm, hs.stride))
    syncChildren(hLabels, poolHLabel, hShown.length, () =>
      svg('text', { 'font-size': 10, 'font-family': FONT_FAMILY, y: RULER - 6 }),
    )
    hShown.forEach((t, i) => {
      setAttrs(poolHLabel[i], { x: t.coord + 2 })
      poolHLabel[i].textContent = String(Math.round(t.mm))
    })

    // ── 竖尺 ──
    const vs = ticksFor(originY, H, view.zoom)
    syncChildren(vTicks, poolVTick, vs.list.length, () => svg('line', { 'stroke-width': 1 }))
    vs.list.forEach((t, i) => {
      const y = Math.round(t.coord) + 0.5
      setAttrs(poolVTick[i], { x1: 12, x2: RULER, y1: y, y2: y })
    })
    // 竖尺数字水平排布，只在 20px 宽的条里放得下时才标
    const vShown = vs.list.filter(
      (t) => wantLabel(t.mm, vs.stepMm, vs.stride) && String(Math.round(t.mm)).length <= 3,
    )
    syncChildren(vLabels, poolVLabel, vShown.length, () =>
      svg('text', { 'font-size': 9, 'font-family': FONT_FAMILY, x: 3 }),
    )
    vShown.forEach((t, i) => {
      setAttrs(poolVLabel[i], { y: t.coord + 8 })
      poolVLabel[i].textContent = String(Math.round(t.mm))
    })

    // ── 选中高亮带 ──
    const sel = view.selection
    if (!sel || sel.width <= 0 || sel.height <= 0) {
      setAttrs(band, { display: 'none' })
      return
    }
    setAttrs(band, { display: '' })
    const x1 = sel.left * view.zoom + view.panX
    const y1 = sel.top * view.zoom + view.panY
    const wPx = sel.width * view.zoom
    const hPx = sel.height * view.zoom
    setAttrs(hBandRect, { x: x1, width: Math.max(0, wPx) })
    setAttrs(vBandRect, { y: y1, height: Math.max(0, hPx) })
    if (wPx >= 26) {
      setAttrs(hBandSize, { display: '', x: x1 + wPx / 2 })
      hBandSize.textContent = `${pxToMm(sel.width).toFixed(1)}`
    } else {
      setAttrs(hBandSize, { display: 'none' })
    }
    if (hPx >= 26) {
      const cy = y1 + hPx / 2
      setAttrs(vBandSize, { display: '', y: cy, transform: `rotate(-90 ${RULER / 2} ${cy})` })
      vBandSize.textContent = `${pxToMm(sel.height).toFixed(1)}`
    } else {
      setAttrs(vBandSize, { display: 'none' })
    }
  }

  const resize = (w: number, h: number) => {
    W = Math.max(1, w)
    H = Math.max(1, h)
  }

  return {
    resize,
    redraw,
    destroy: () => {
      root.remove()
    },
  }
}
