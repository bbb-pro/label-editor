// 输出：模板 JSON 下载、PNG、PDF、浏览器打印
import jsPDF from 'jspdf'
import type { PaperSize, LabelTemplate } from '@/types/template'
import type { CanvasController } from '@/lib/canvasEngine'

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
): string {
  return controller.toPaperDataUrl(scale)
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
    const dataUrl = canvasToHighResDataUrl(controller, 3)
    download(dataUrl, `${name}.png`)
  } finally {
    if (hadSel && prev) {
      canvas.setActiveObject(prev)
      canvas.requestRenderAll()
    }
  }
}

/** 批量把若干张 PNG 依次下载成独立文件（序列化多张场景） */
export function exportPngPages(pages: string[], name = '标签') {
  pages.forEach((src, i) => {
    // 逐个下载，稍延时以免浏览器拦截连续下载
    const n = i > 0 ? i + 1 : ''
    download(src, `${name}${n}.png`)
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
  scale = 3,
  onProgress?: (done: number, total: number) => void,
): Promise<string[]> {
  const pages: string[] = []
  const total = Math.max(1, copies)
  // 截图前临时脱开选中，避免把蓝色选择框/控制点截进 PDF
  const canvas = controller.canvas
  const prevActive = canvas.getActiveObject()
  const prevSelection = prevActive ? true : false
  if (prevSelection) canvas.discardActiveObject()
  try {
    for (let i = 0; i < total; i++) {
      controller.setSeqValue(controller.seqLabelFor(i))
      await controller.whenIdle()
      pages.push(canvasToHighResDataUrl(controller, scale))
      onProgress?.(i + 1, total)
    }
    // 还原：回到设计态预览
    controller.setSeqValue(null)
    await controller.whenIdle()
  } finally {
    // 恢复选中，避免破坏用户连续编辑流程
    if (prevSelection && prevActive) {
      canvas.setActiveObject(prevActive)
      canvas.requestRenderAll()
    }
  }
  return pages
}

export function exportPdf(controller: CanvasController, paper: PaperSize, name = '标签') {
  const canvas = controller.canvas
  const prev = canvas.getActiveObject()
  const hadSel = !!prev
  if (hadSel) canvas.discardActiveObject()
  // 同步截取（已脱开选中，避免蓝色选择框/控制点进 PDF）
  const dataUrl = canvasToHighResDataUrl(controller, 2)
  if (hadSel && prev) {
    canvas.setActiveObject(prev)
    canvas.requestRenderAll()
  }
  // jsPDF 默认单位 mm，按纸张实际 mm 建页
  const doc = new jsPDF({
    orientation: paper.widthMm >= paper.heightMm ? 'landscape' : 'portrait',
    unit: 'mm',
    format: [paper.widthMm, paper.heightMm],
    compress: true,
  })
  const img = new Image()
  img.onload = () => {
    doc.addImage(img, 'PNG', 0, 0, paper.widthMm, paper.heightMm)
    doc.save(`${name}.pdf`)
  }
  img.src = dataUrl
}

/**
 * 批量导出 PDF：pages 为每页高清图（序号已递增），一页一张。
 * 顺序加载图片并 addImage，避免并发 onload 导致页序错乱/空白。
 */
export async function exportBatchPdf(
  pages: string[],
  paper: PaperSize,
  name = '标签',
): Promise<void> {
  if (pages.length === 0) throw new Error('没有可导出的页')
  const doc = new jsPDF({
    orientation: paper.widthMm >= paper.heightMm ? 'landscape' : 'portrait',
    unit: 'mm',
    format: [paper.widthMm, paper.heightMm],
    compress: true,
  })
  for (let i = 0; i < pages.length; i++) {
    if (i > 0) doc.addPage([paper.widthMm, paper.heightMm], paper.widthMm >= paper.heightMm ? 'landscape' : 'portrait')
    await new Promise<void>((resolve) => {
      const img = new Image()
      img.onload = () => {
        doc.addImage(img, 'PNG', 0, 0, paper.widthMm, paper.heightMm)
        resolve()
      }
      img.onerror = () => resolve() // 失败跳过该页，避免整个导出阻塞
      img.src = pages[i]
    })
  }
  doc.save(`${name}.pdf`)
}

/** 动态注入 @page 尺寸，让浏览器打印纸型跟随标签实际大小 */
function applyPrintPageSize(paper: PaperSize) {
  const id = '__label-print-page-size'
  let el = document.getElementById(id) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = id
    document.head.appendChild(el)
  }
  el.textContent = `@page{size:${paper.widthMm}mm ${paper.heightMm}mm;margin:0}`
}

/** 取（或建）屏外打印容器 */
function printHost(sheetId: string): HTMLDivElement {
  let host = document.getElementById(sheetId) as HTMLDivElement | null
  if (!host) {
    host = document.createElement('div')
    host.id = sheetId
    // 屏幕上看不见：绝对定位到屏幕外（保持真实渲染，确保图片加载）
    host.style.cssText =
      'position:absolute;left:-99999px;top:0;width:0;height:0;overflow:visible;'
    document.body.appendChild(host)
  } else {
    host.innerHTML = ''
  }
  return host
}

/** 把若干张高清图放进屏外容器，等全部加载完再触发一次 window.print（每张一页） */
function printPages(pages: string[], paper: PaperSize, sheetId = 'print-area'): Promise<void> {
  // 关键：让打印对话框的纸型跟随标签实际尺寸（若用户选“适合页面/自动”）
  applyPrintPageSize(paper)
  const host = printHost(sheetId)
  return new Promise((resolve) => {
    let loaded = 0
    pages.forEach((src, i) => {
      const img = new Image()
      // 最后一张不加分页符，避免多打一张空白页
      const pageBreak = i === pages.length - 1 ? '' : 'break-after:page;'
      img.style.cssText = `width:${paper.widthMm}mm;height:${paper.heightMm}mm;display:block;${pageBreak}`
      img.onload = () => {
        loaded++
        if (loaded === pages.length) {
          window.print()
          resolve()
        }
      }
      img.onerror = () => {
        loaded++
        if (loaded === pages.length) {
          window.print()
          resolve()
        }
      }
      host.appendChild(img)
      img.src = src
    })
    if (pages.length === 0) resolve()
  })
}

/** 浏览器打印：把高清标签放进隐藏 DOM 容器并触发 window.print */
export function printCanvas(controller: CanvasController, paper: PaperSize, sheetId = 'print-area') {
  return printPages([canvasToHighResDataUrl(controller, 3)], paper, sheetId)
}

/** 批量打印：pages 为每页的高清图（序号已递增），一页一张 */
export function printBatch(pages: string[], paper: PaperSize, sheetId = 'print-area') {
  return printPages(pages, paper, sheetId)
}
