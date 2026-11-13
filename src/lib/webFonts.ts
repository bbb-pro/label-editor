// 画布侧字体加载：把「导出要内嵌的那几款 TTF」装进浏览器，让画布与 PDF 用同一份字形。
//
// 为什么不用 CSS @font-face：
//   字体文件放在 `public/fonts/`（原样拷贝、URL 固定），而 CSS 里的 url() 是相对
//   **CSS 文件位置**解析的（构建后在 assets/ 下），还可能被 Vite 当成待处理资源；
//   用 FontFace API + `import.meta.env.BASE_URL` 与导出侧 fetch 走同一套 URL 规则，
//   两边拿到的必然是同一个文件 —— 这正是「画布 = PDF」的前提。
import { EMBEDDED_FONTS } from '@/lib/textStyles'

let _loading: Promise<void> | null = null

/** 字体文件 URL（与 vectorExport 里的 FONT_URL 同一口径） */
export function fontFileUrl(file: string): string {
  return `${import.meta.env.BASE_URL}fonts/${file}`
}

/**
 * 加载全部内嵌字体（幂等：多次调用只真正下载一次）。
 *
 * ⚠️ 是异步的：调用方拿到 Promise 后应等它完成再重排文本（见 CanvasController.refreshTextMetrics）。
 *    在字体就绪之前，fabric 会用 fallback 字体算宽度 —— 盒宽、断行都会偏，
 *    所以必须补一次重算，否则「选了窄体但文本框宽度还是按 Arial 算的」。
 *
 * 任何一款失败只 console.warn：画布退回系统字体，不该因为字体挂掉就让编辑器不可用。
 */
export function ensureEmbeddedFonts(): Promise<void> {
  if (_loading) return _loading
  _loading = (async () => {
    if (typeof document === 'undefined' || typeof FontFace === 'undefined') return
    await Promise.all(
      EMBEDDED_FONTS.flatMap((def) =>
        def.variants.map(async ({ weight, file }) => {
          try {
            const face = new FontFace(def.family, `url("${fontFileUrl(file)}")`, { weight })
            await face.load()
            document.fonts.add(face)
          } catch (err) {
            console.warn(`[fonts] 加载失败：${def.family} ${weight} (${file})`, err)
          }
        }),
      ),
    )
  })()
  return _loading
}
