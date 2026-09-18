/** 素材库数据类型 */

export type AssetSet = 'lucide' | 'emoji' | 'symbols' | 'marks' | 'ktm'

export interface AssetItem {
  /** 唯一 id，形如 `lucide:package` / `emoji:1f600` */
  id: string
  /** 展示名（有中文则用中文，否则回落英文名） */
  name: string
  /** 已小写的检索串：中文名 + 英文原名（含拆开的空格） */
  search: string
  set: AssetSet
  /** 分类 id */
  cat: string
  /** SVG 内部片段；完整 SVG 由 assetToSvg 按需套壳 */
  inner: string
  /**
   * 可选：素材形态。
   * 'line' = 线稿，stroke 跟随调用方给的颜色（可换色）；
   * 'filled' = 内含固有配色（如 GHS 红菱形、能效彩条），换色无意义。
   * 缺省按 'line' 处理。
   */
  fillStyle?: 'line' | 'filled'
  /**
   * 可选：素材自带的坐标系，缺省 `0 0 24 24`。
   * GHS 象形图与官方 CE 模型的原始 viewBox 各不相同（579/735/5790/840×600…），
   * 套壳时必须用它，否则图形会被拉伸变形。
   */
  viewBox?: string
  /** 可选：emoji 原字符，用于面板内以系统字体快速预览 */
  preview?: string
  /**
   * 可选：位图素材的站内相对路径（扩展图标库里 PNG/JPG 那部分）。
   * 位图不能进 `inner`（那是矢量片段），插入时交给 fabric.Image 走位图通道。
   */
  rasterSrc?: string
  /** 可选：位图原始像素尺寸，形如 `240x240`，仅用于面板角标提示清晰度 */
  rasterSize?: string
}

export interface AssetCat {
  id: string
  label: string
}
