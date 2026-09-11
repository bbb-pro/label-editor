// 输出：模板 JSON 下载、PNG、PDF、浏览器打印
import type { PaperArea, PaperOrder, PaperSize, LabelTemplate, DataRow } from '@/types/template'
import type { CanvasController } from '@/lib/canvasEngine'

/** 渲染好的一页：图 + 该页实际毫米尺寸（多标签时每页尺寸可能不同） */
export interface RenderedPage {
  url: string
  widthMm: number
  heightMm: number
}

/**
 * PNG / 栅格导出倍率。
 * 画布基准 DPI = 96（见 lib/mm.ts），故输出等效 DPI = 96 × 该倍率。
 * 取 4 → 384 DPI，满足标签打印的高清要求，同时不给浏览器 canvas 上限带来压力
 * （100×150mm 标签约 1512×2268px）。若需再高一档可调到 6（576 DPI）。
 */
export const PNG_EXPORT_SCALE = 4

/**
 * 多标签页序换算：第 p 页（0 起）对应哪张纸 + 第几个序号。
 * - set 按套：[A1 B1 A2 B2]（打印出来天然成套，适合一箱货配多张）
 * - paper 按标签：[A1 A2 B1 B2]（先打完一种，适合尺寸不同要换纸 / 分批贴）
 */
function pageSlot(p: number, copies: number, paperCount: number, order: PaperOrder) {
  const c = Math.max(1, copies)
  const n = Math.max(1, paperCount)
  return order === 'set'
    ? { paperIdx: p % n, index: Math.floor(p / n) }
    : { paperIdx: Math.floor(p / c), index: p % c }
}

function download(dataUrlOrBlob: Blob | string, filename: string) {
  const url = typeof dataUrlOrBlob === 'string' ? dataUrlOrBlob : URL.createObjectURL(dataUrlOrBlob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  if (typeof dataUrlOrBlob !== 'string') setTimeout(() => URL.revokeObjectURL(url), 2000)
}

/** 画布 → 高清 PNG dataURL(委托给 CanvasController,内部临时切回工作区坐标系导出,不受屏幕缩放/视口影响) */
export function canvasToHighResDataUrl(
  controller: CanvasController,
  scale = 2,
  paperId?: string,
): string {
  return controller.toPaperDataUrl(scale, paperId)
}

/**
 * 参与输出的纸张列表。
 * - 全部标签：按工作区里的顺序
 * - 仅当前标签：只输出活动纸（用于「先只打这一张」）
 */
function pickPapers(controller: CanvasController, onlyActive: boolean): PaperArea[] {
  const all = controller.listPapers()
  if (!onlyActive || all.length <= 1) return all
  const active = all.find((p) => p.id === controller.activePaperId())
  return active ? [active] : all
}

/** 每张纸各渲染一页（多标签：无序列化/无数据绑定时的一次性输出） */
export function renderAllPapers(controller: CanvasController, scale = PNG_EXPORT_SCALE): RenderedPage[] {
  return controller.listPapers().map((p) => ({
    url: controller.toPaperDataUrl(scale, p.id),
    widthMm: p.widthMm,
    heightMm: p.heightMm,
  }))
}

/** 当前活动纸渲染成一页（单张导出用） */
export function renderCurrentPage(
  controller: CanvasController,
  scale = PNG_EXPORT_SCALE,
): RenderedPage {
  const p = controller.listPapers().find((x) => x.id === controller.activePaperId())
  return {
    url: controller.toPaperDataUrl(scale, p?.id),
    widthMm: p?.widthMm ?? 0,
    heightMm: p?.heightMm ?? 0,
  }
}

export function exportJson(
  paper: PaperSize,
  controller: CanvasController,
  filename = '标签模板.json',
) {
  const template: LabelTemplate = { version: 1, paper, canvas: controller.toJSON() }
  const blob = new Blob([JSON.stringify(template, null, 2)], {
    type: 'application/json',
  })
  download(blob, filename)
}

export async function exportPng(controller: CanvasController, name = '标签') {
  const canvas = controller.canvas
  const prev = canvas.getActiveObject()
  const hadSel = !!prev
  if (hadSel) canvas.discardActiveObject()
  try {
    const dataUrl = canvasToHighResDataUrl(controller, PNG_EXPORT_SCALE)
    download(dataUrl, `${name}.png`)
  } finally {
    if (hadSel && prev) {
      canvas.setActiveObject(prev)
      canvas.requestRenderAll()
    }
  }
}

/** 批量把若干张 PNG 依次下载成独立文件（序列化多张场景） */
export function exportPngPages(pages: RenderedPage[], name = '标签') {
  pages.forEach((pg, i) => {
    // 逐个下载，稍延时以免浏览器拦截连续下载；编号从 1 开始（此前 i>0 才加编号，导致缺「1」）
    download(pg.url, `${name}${i + 1}.png`)
  })
}

/**
 * 逐张渲染「批量序列化」页面。
 * 每一页：切换画布上的 {{seq}} 显示值 → 等条码异步重绘完成 → 截图。
 * 结束后把画布还原为设计态预览（seqValue = null）。
 * @param onProgress 已完成页数回调（0 起）
 */
export async function renderSeqPages(
  controller: CanvasController,
  copies: number,
  scale = PNG_EXPORT_SCALE,
  onProgress?: (done: number, total: number) => void,
  order: PaperOrder = 'set',
  onlyActive = false,
): Promise<RenderedPage[]> {
  const papers = pickPapers(controller, onlyActive)
  const paperCount = Math.max(1, papers.length)
  const copiesSafe = Math.max(1, copies)
  const pages: RenderedPage[] = []
  const total = copiesSafe * paperCount
  // 截图前临时脱开选中，避免把蓝色选择框/控制点截进 PDF
  const canvas = controller.canvas
  const prevActive = canvas.getActiveObject()
  const prevSelection = prevActive ? true : false
  if (prevSelection) canvas.discardActiveObject()
  // 导出期间锁定交互，避免 await 多帧时用户拖动/删除对象导致截到半成品
  controller.setReadOnly(true)
  try {
    for (let p = 0; p < total; p++) {
      const { paperIdx, index } = pageSlot(p, copiesSafe, paperCount, order)
      const paper = papers[Math.min(paperIdx, papers.length - 1)]
      // 传页码而非字符串：每个序列化对象按自己的 start/step 计算，多纸可各有起始值
      controller.setSeqIndex(index)
      await controller.whenIdle()
      pages.push({
        url: canvasToHighResDataUrl(controller, scale, paper?.id),
        widthMm: paper?.widthMm ?? 0,
        heightMm: paper?.heightMm ?? 0,
      })
      onProgress?.(p + 1, total)
    }
    // 还原：回到设计态预览
    controller.setSeqIndex(null)
    await controller.whenIdle()
  } finally {
    controller.setReadOnly(false)
    // 恢复选中，避免破坏用户连续编辑流程
    if (prevSelection && prevActive) {
      canvas.setActiveObject(prevActive)
      canvas.requestRenderAll()
    }
  }
  return pages
}

/**
 * 逐张渲染「按表格行」页面（文本框名称 = 表头 自动绑定列）。
 * 每一页：切换画布预览到对应数据行 → 等重绘完成 → 截图。
 * 结束后把画布还原为设计态（previewRow = null）。
 * @param onProgress 已完成页数回调（0 起）
 */
export async function renderRowPages(
  controller: CanvasController,
  rows: DataRow[],
  scale = PNG_EXPORT_SCALE,
  onProgress?: (done: number, total: number) => void,
  order: PaperOrder = 'set',
  onlyActive = false,
): Promise<RenderedPage[]> {
  const papers = pickPapers(controller, onlyActive)
  const paperCount = Math.max(1, papers.length)
  const rowCount = Math.max(1, rows.length)
  const pages: RenderedPage[] = []
  const total = rowCount * paperCount
  const canvas = controller.canvas
  const prevActive = canvas.getActiveObject()
  const prevSelection = prevActive ? true : false
  if (prevSelection) canvas.discardActiveObject()
  controller.setReadOnly(true)
  try {
    for (let p = 0; p < total; p++) {
      const { paperIdx, index } = pageSlot(p, rowCount, paperCount, order)
      const paper = papers[Math.min(paperIdx, papers.length - 1)]
      controller.setPreviewRow(rows[Math.min(index, rows.length - 1)] ?? null)
      await controller.whenIdle()
      pages.push({
        url: canvasToHighResDataUrl(controller, scale, paper?.id),
        widthMm: paper?.widthMm ?? 0,
        heightMm: paper?.heightMm ?? 0,
      })
      onProgress?.(p + 1, total)
    }
    controller.setPreviewRow(null)
    await controller.whenIdle()
  } finally {
    controller.setReadOnly(false)
    if (prevSelection && prevActive) {
      canvas.setActiveObject(prevActive)
      canvas.requestRenderAll()
    }
  }
  return pages
}
