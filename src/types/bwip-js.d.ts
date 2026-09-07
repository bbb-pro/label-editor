// 轻量类型声明：bwip-js（浏览器构建）本地类型，避免依赖其 exports 条件类型解析
declare module 'bwip-js' {
  interface RenderOptions {
    bcid: string
    text: string
    scale?: number
    height?: number
    width?: number
    includetext?: boolean
    paddingwidth?: number
    paddingheight?: number
    backgroundcolor?: string
    parse?: boolean
    [key: string]: unknown
  }

  export function toCanvas(
    canvas: string | HTMLCanvasElement,
    opts: RenderOptions,
  ): HTMLCanvasElement
}
