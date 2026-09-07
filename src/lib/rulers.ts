// 纸张标尺：在 fabric 的 .canvas-container 内挂两条毫米刻度（上缘横尺、左缘竖尺）。
// 它们作为容器子元素，随容器的 CSS transform(缩放/平移) 一起移动，保证与纸张几何严格对齐；
// 刻度绘制时对字体做 1/zoom 反向缩放，使刻度文字在屏幕上保持恒定可读大小。

import { mmToPx } from '@/lib/mm'

const RULER = 18 // 标尺条厚度（px，容器本地坐标下，会被缩放）

export interface RulerHandle {
  redraw: (zoom: number) => void
  destroy: () => void
}

/** 在容器内创建上/左两条标尺，返回控制句柄 */
export function mountRulers(container: HTMLElement, paperPxW: number, paperPxH: number): RulerHandle {
  const create = (horizontal: boolean): HTMLCanvasElement => {
    const c = document.createElement('canvas')
    c.style.position = 'absolute'
    c.style.pointerEvents = 'none'
    if (horizontal) {
      c.style.left = '0'
      c.style.top = `${-RULER}px`
      c.width = Math.max(1, Math.ceil(paperPxW))
      c.height = RULER
    } else {
      c.style.left = `${-RULER}px`
      c.style.top = '0'
      c.width = RULER
      c.height = Math.max(1, Math.ceil(paperPxH))
    }
    c.style.zIndex = '5'
    container.appendChild(c)
    return c
  }

  const h = create(true)
  const v = create(false)

  const drawTicks = (c: HTMLCanvasElement, horizontal: boolean, zoom: number) => {
    const ctx = c.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, c.width, c.height)

    // 每像素对应 mm
    const mmPerPx = 1 / (96 / 25.4) // mmToPx(1)=1mm px 数 → 1px = 1/mmToPx(1) mm
    // 目标：屏幕上每个主刻度间隔 ~70px → 本地步长 px = 70/zoom，换算成 mm 取整为“好看”的步长
    const screenTarget = 70
    const localStepPx = screenTarget / Math.max(0.02, zoom)
    // 1 格 ≈ localStepPx px；用 mm 表达：stepMmNice
    const rawMm = localStepPx * mmPerPx
    // 从 {1,2,5,10,20,50,100}×10^n 选最接近的不小于 rawMm 的步长
    const nice = (raw: number): number => {
      const pow = Math.pow(10, Math.floor(Math.log10(Math.max(0.1, raw))))
      for (const m of [1, 2, 5, 10]) {
        if (m * pow >= raw - 1e-6) return m * pow
      }
      return 10 * pow
    }
    const stepMm = nice(rawMm)
    const stepPx = mmToPx(stepMm)

    const length = horizontal ? c.width : c.height
    const maxMm = length * mmPerPx

    ctx.fillStyle = '#8a94a6'
    ctx.strokeStyle = '#8a94a6'
    ctx.font = `${Math.max(6, Math.round(9 / zoom))}px system-ui, sans-serif`
    ctx.textBaseline = 'middle'

    const edgeGap = 2
    let mm = 0
    let px = 0
    while (px < length) {
      const big = mm > 0 && mm % (stepMm * 5) === 0
      const label = mm % stepMm === 0
      if (px >= 0) {
        if (horizontal) {
          ctx.beginPath()
          const len = label ? RULER - edgeGap : RULER / 2
          ctx.moveTo(Math.round(px) + 0.5, RULER - len)
          ctx.lineTo(Math.round(px) + 0.5, RULER)
          ctx.stroke()
          if (big) {
            ctx.textAlign = 'center'
            ctx.fillText(String(mm), Math.round(px) + 0.5, RULER / 2)
          }
        } else {
          ctx.beginPath()
          const len = label ? RULER - edgeGap : RULER / 2
          ctx.moveTo(RULER - len, Math.round(px) + 0.5)
          ctx.lineTo(RULER, Math.round(px) + 0.5)
          ctx.stroke()
          if (big) {
            ctx.save()
            ctx.translate(RULER / 2, Math.round(px) + 0.5)
            ctx.rotate(-Math.PI / 2)
            ctx.textAlign = 'center'
            ctx.fillText(String(mm), 0, 0)
            ctx.restore()
          }
        }
      }
      mm += stepMm
      px += stepPx
      if (mm > maxMm) break
    }
  }

  const redraw = (zoom: number) => {
    drawTicks(h, true, zoom)
    drawTicks(v, false, zoom)
  }

  return {
    redraw,
    destroy: () => {
      h.remove()
      v.remove()
    },
  }
}
