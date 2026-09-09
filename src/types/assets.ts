/** 素材库数据类型 */

export type AssetSet = 'lucide' | 'emoji' | 'symbols'

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
  /** 可选：emoji 原字符，用于面板内以系统字体快速预览 */
  preview?: string
}

export interface AssetCat {
  id: string
  label: string
}
