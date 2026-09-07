// 条码 → 矢量几何提取
// 用 bwip-js 渲染到离屏 canvas(不画人读文字)，读像素，把“黑色”提取为一张矩形清单。
// 所有码制（1D 条 / EAN guard / QR·DataMatrix·Aztec 等 2D 模块 / 邮政点式）在 bwip 输出里
// 都是轴对齐黑块，因此能统一提取成轴对齐矩形，交给 PDF 矢量绘制 —— 与 bwip 位图逐位一致、可正常扫码。
import * as bwipjs from 'bwip-js'
import { is2dType, isQrFamily, type BarcodeType, type BarcodeRenderSettings, DEFAULT_BARCODE_SETTINGS } from '@/lib/barcode'

export interface BarcodeRect {
  x: number // 左(px，raster 坐标)
  y: number
  w: number
  h: number
}

export interface BarcodeVector {
  width: number // raster 宽(px)
  height: number // raster 高(px，仅条/码区，不含人读文字)
  rects: BarcodeRect[]
  /** 码制是否需要/支持人读文字（一维码通常要） */
  showTextHint: boolean
  /** 若含人读文字时的整体高(px)；无则=height。用于在盒内给文字预留底部条带 */
  fullHeight?: number
}

/** 竖向黑色 run */
interface VRun {
  y0: number
  y1: number
  x0: number
  x1: number // 已合并的列区间（含 x1-1）
}

/**
 * 渲染 type+text 为矢量矩形几何。
 * @param type 码制
 * @param text 内容（可为已解析的最终文案）
 * @param settings 覆盖设置（quietZone/scale 影响 rasters 尺寸；此函数内部强制 includetext=false）
 */
export function renderBarcodeVectorRects(
  type: BarcodeType,
  text: string,
  settings?: Partial<BarcodeRenderSettings>,
): BarcodeVector {
  const s: BarcodeRenderSettings = { ...DEFAULT_BARCODE_SETTINGS, ...(settings ?? {}) }
  const canvas = document.createElement('canvas')
  const opts: Record<string, unknown> = {
    bcid: type,
    text: text || ' ',
    scale: s.scale,
    includetext: false, // 人读文字由上层用矢量字体单独画，避免在此变成像素块
    paddingwidth: s.quietZone,
    paddingheight: s.quietZone,
    backgroundcolor: 'FFFFFF',
  }
  if (!is2dType(type)) {
    opts.height = 14
    opts.width = 2
    if (type === 'itf14') opts.height = 22
    if (type === 'postnet' || type === 'planet' || type === 'kix') opts.height = 8
  } else if (isQrFamily(type) && s.eccLevel) {
    opts.eclevel = s.eccLevel
  }
  bwipjs.toCanvas(canvas, opts as Parameters<typeof bwipjs.toCanvas>[1])

  const ctx = canvas.getContext('2d')
  const width = canvas.width
  const height = canvas.height
  if (!ctx || width <= 0 || height <= 0) {
    return { width, height, rects: [], showTextHint: !is2dType(type) }
  }
  const img = ctx.getImageData(0, 0, width, height)
  const px = img.data
  const isBlack = (x: number, y: number): boolean => {
    const i = (y * width + x) * 4
    return px[i] < 128 // 暗像素视为条
  }

  // 每列纵向黑色 run
  const colRuns: VRun[][] = []
  for (let x = 0; x < width; x++) {
    const runs: VRun[] = []
    let y = 0
    while (y < height) {
      if (isBlack(x, y)) {
        let y1 = y
        while (y1 < height && isBlack(x, y1)) y1++
        runs.push({ y0: y, y1, x0: x, x1: x + 1 })
        y = y1
      } else {
        y++
      }
    }
    colRuns.push(runs)
  }

  // 把列 run 横向合并成矩形：相同 [y0,y1) 且相邻列连续 → 扩宽
  const rects: BarcodeRect[] = []
  const placed = new Set<string>() // 记录已归并的 run 序号，避免重复
  for (let x = 0; x < width; x++) {
    for (let ri = 0; ri < colRuns[x].length; ri++) {
      const run = colRuns[x][ri]
      const key = `${x}:${ri}`
      if (placed.has(key)) continue
      // 尝试向右扩张：列 x+1.. 中是否存在相同 [y0,y1) 且在最左未用 run
      let x1 = x + 1
      while (x1 < width) {
        const cand = colRuns[x1].find((r2) => r2.y0 === run.y0 && r2.y1 === run.y1)
        if (!cand) break
        // 标记 cand 已用（它在 colRuns[x1] 中下标）
        const idx = colRuns[x1].indexOf(cand)
        placed.add(`${x1}:${idx}`)
        // 注意：同一列可能有多个相同区段？一列内 [y0,y1) 唯一，所以只占该列一次
        x1++
      }
      rects.push({ x: run.x0, y: run.y0, w: x1 - run.x0, h: run.y1 - run.y0 })
    }
  }

  // 一维码若需人读文字：量一次“含文字”的整体高，供上层在盒内给文字预留底部条带
  const showTextHint = !is2dType(type)
  let fullHeight: number | undefined
  if (showTextHint) {
    try {
      const c2 = document.createElement('canvas')
      const o2: Record<string, unknown> = { ...opts, includetext: true }
      if ((settings as Partial<BarcodeRenderSettings> | undefined)?.showText !== false) {
        o2.textfont = 'OCR-B'
        o2.textsize = Math.max(8, Math.round(((settings?.textSizePt ?? 9) * 72) / 96 / (settings?.scale ?? s.scale) * 2))
        o2.textxalign = 'center'
        o2.textgaps = 3
      }
      bwipjs.toCanvas(c2, o2 as Parameters<typeof bwipjs.toCanvas>[1])
      fullHeight = c2.height || height
    } catch {
      fullHeight = height
    }
  }

  return { width, height, rects, showTextHint, fullHeight }
}
