// 纸张标尺（屏幕/视口空间）
// 旧实现把标尺挂进 .canvas-container 并依赖容器的 CSS transform 移动，
// 改用 fabric viewportTransform 后容器不再被 transform（尺寸=视口），标尺会被裁到视口外而"消失"。
// 新方案：标尺固定贴在视口上缘/左缘（不随画布变换），绘制时按当前
// viewportTransform(zoom/pan) 把「屏幕坐标」映射回「相对纸张的毫米」，
// 因此任意缩放/平移下都与纸张严格对齐，且刻度文字始终保持恒定可读大小。

import { mmToPx } from '@/lib/mm'

/** 标尺条厚度（屏幕 px） */
const RULER = 18

export interface RulerView {
  zoom: number
  panX: number
  panY: number
  /** 纸张左上角在工作区中的逻辑坐标(px)，用于把刻度原点对齐到标签而非工作区 */
  paperOffsetX: number
  paperOffsetY: number
}

export interface RulerHandle {
  /** 视口尺寸变化时调用 */
  resize: (w: number, h: number) => void
  /** zoom/pan 变化时调用 */
  redraw: (view: RulerView) => void
  destroy: () => void
}

/** 选一个"好看"的步长：{1,2,5,10}×10^n 中不小于 raw 的最小值 */
function niceStep(raw: number): number {
  const pow = Math.pow(10, Math.floor(Math.log10(Math.max(0.1, raw))))
  for (const m of [1, 2, 5, 10]) {
    if (m * pow >= raw - 1e-6) return m * pow
  }
  return 10 * pow
}

/** 按 DPR 设置位图尺寸，保证刻度/文字清晰 */
function setup(c: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D | null {
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  c.width = Math.max(1, Math.round(w * dpr))
  c.height = Math.max(1, Math.round(h * dpr))
  c.style.width = `${Math.max(1, w)}px`
  c.style.height = `${Math.max(1, h)}px`
  const ctx = c.getContext('2d')
  if (!ctx) return null
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return ctx
}

/** 在视口容器内创建上/左两条标尺，返回控制句柄 */
export function mountRulers(container: HTMLElement): RulerHandle {
  const mk = (z: number): HTMLCanvasElement => {
    const c = document.createElement('canvas')
    c.style.position = 'absolute'
    c.style.left = '0'
    c.style.top = '0'
    c.style.pointerEvents = 'none'
    c.style.zIndex = String(z)
    container.appendChild(c)
    return c
  }
  const hRuler = mk(6) // 上缘横尺（z 更高，其左上角方块会盖住竖尺顶端）
  const vRuler = mk(5) // 左缘竖尺

  let W = 1
  let H = 1

  const drawH = (view: RulerView) => {
    const ctx = setup(hRuler, W, RULER)
    if (!ctx) return
    ctx.clearRect(0, 0, W, RULER)
    // 左上角方块（与竖尺交叠处）
    ctx.fillStyle = '#f8fafc'
    ctx.fillRect(0, 0, RULER, RULER)
    ctx.strokeStyle = '#e2e8f0'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(RULER + 0.5, 0)
    ctx.lineTo(RULER + 0.5, RULER)
    ctx.moveTo(0, RULER + 0.5)
    ctx.lineTo(W, RULER + 0.5)
    ctx.stroke()

    const pxPerMm = mmToPx(1)
    const { zoom, panX, paperOffsetX } = view
    const stepMm = niceStep(70 / zoom / pxPerMm)
    // 可见范围（相对纸张的 mm）
    const mmStart = ((0 - panX) / zoom - paperOffsetX) / pxPerMm
    const mmEnd = ((W - panX) / zoom - paperOffsetX) / pxPerMm
    const first = Math.ceil(mmStart / stepMm) * stepMm

    ctx.fillStyle = '#8a94a6'
    ctx.strokeStyle = '#8a94a6'
    ctx.font = '9px system-ui, -apple-system, sans-serif'
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'center'

    for (let mm = first; mm <= mmEnd; mm += stepMm) {
      const sx = (paperOffsetX + mm * pxPerMm) * zoom + panX
      if (sx < RULER) continue
      const isZero = Math.abs(mm) < 1e-6
      const isBig = Math.abs(mm % (stepMm * 5)) < 1e-6
      ctx.beginPath()
      ctx.moveTo(Math.round(sx) + 0.5, isBig ? 2 : RULER / 2)
      ctx.lineTo(Math.round(sx) + 0.5, RULER)
      ctx.lineWidth = isZero ? 2 : 1
      ctx.stroke()
      if (isBig) ctx.fillText(String(Math.round(mm)), Math.round(sx), RULER / 2 - 1)
    }
  }

  const drawV = (view: RulerView) => {
    const ctx = setup(vRuler, RULER, H)
    if (!ctx) return
    ctx.clearRect(0, 0, RULER, H)
    ctx.strokeStyle = '#e2e8f0'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(RULER + 0.5, 0)
    ctx.lineTo(RULER + 0.5, H)
    ctx.stroke()

    const pxPerMm = mmToPx(1)
    const { zoom, panY, paperOffsetY } = view
    const stepMm = niceStep(70 / zoom / pxPerMm)
    const mmStart = ((0 - panY) / zoom - paperOffsetY) / pxPerMm
    const mmEnd = ((H - panY) / zoom - paperOffsetY) / pxPerMm
    const first = Math.ceil(mmStart / stepMm) * stepMm

    ctx.fillStyle = '#8a94a6'
    ctx.strokeStyle = '#8a94a6'
    ctx.font = '9px system-ui, -apple-system, sans-serif'
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'center'

    for (let mm = first; mm <= mmEnd; mm += stepMm) {
      const sy = (paperOffsetY + mm * pxPerMm) * zoom + panY
      if (sy < RULER) continue
      const isZero = Math.abs(mm) < 1e-6
      const isBig = Math.abs(mm % (stepMm * 5)) < 1e-6
      ctx.beginPath()
      ctx.moveTo(isBig ? 2 : RULER / 2, Math.round(sy) + 0.5)
      ctx.lineTo(RULER, Math.round(sy) + 0.5)
      ctx.lineWidth = isZero ? 2 : 1
      ctx.stroke()
      if (isBig) {
        ctx.save()
        ctx.translate(RULER / 2 - 1, Math.round(sy))
        ctx.rotate(-Math.PI / 2)
        ctx.fillText(String(Math.round(mm)), 0, 0)
        ctx.restore()
      }
    }
  }

  const resize = (w: number, h: number) => {
    W = Math.max(1, w)
    H = Math.max(1, h)
  }

  const redraw = (view: RulerView) => {
    drawH(view)
    drawV(view)
  }

  return {
    resize,
    redraw,
    destroy: () => {
      hRuler.remove()
      vRuler.remove()
    },
  }
}
