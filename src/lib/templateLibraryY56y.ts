// y56y 模板库（第二套模板源：y56y.com「多零标签」的公开标签模板）
//
// 与 buildTemplateSpec（transkoi 那套）的区别：
// · 数据不在 TS 里，而是构建期由 scripts/y56y/convert.mjs 生成、放在
//   public/assets/templates/y56y-index.json，**首次打开模板库时才 fetch**。
//   原因是 294 个模板约 700KB —— 按本仓库既有约定（大 JSON 不进 TS，避免类型推断 OOM）。
// · 数据已经是本项目的原生口径（mm / pt / 度），载入时无需再换算，
//   所以这里只做「取数据 + 补资源绝对路径 + 转成 TemplateSpec」。
// · 元素种类比 transkoi 多：带颜色、旋转、字距的文本，直线，椭圆，
//   矢量图标与位图（以相对文件名引用 public/assets/templates/assets/ 下的文件）。
//
// 换算口径的推导与验证见 scripts/y56y/convert.mjs 头部注释（含逐元素交叉校验）。

import type { TemplateSpec, TplNode } from '@/lib/templateLibrary'

export interface Y56yCategory {
  id: number
  name: string
  /** 站点分组：0 通用 1 跨境电商 2 GS1 */
  group?: number
  groupName?: string
}

export interface Y56yTemplate {
  id: string
  name: string
  /** 展示用尺寸文案（取自接口的 pageWidth/pageHeight，非列表页标题） */
  size: string
  catId: number | null
  catName: string
  widthMm: number
  heightMm: number
  bg: string
  nodes: (TplNode & { src?: string })[]
}

export interface Y56yLibrary {
  version: number
  source: string
  sourceNote: string
  categories: Y56yCategory[]
  templates: Y56yTemplate[]
}

const INDEX_URL = `${import.meta.env.BASE_URL}assets/templates/y56y-index.json`
const ASSET_BASE = `${import.meta.env.BASE_URL}assets/templates/`

/** 模板附带资源（矢量图标 / 位图）的绝对 URL */
export const y56yAssetUrl = (file: string): string => `${ASSET_BASE}assets/${file}`

let cache: Y56yLibrary | null = null
let inflight: Promise<Y56yLibrary> | null = null

/** 载入库（带缓存；并发调用共用同一个请求） */
export function loadY56yLibrary(): Promise<Y56yLibrary> {
  if (cache) return Promise.resolve(cache)
  if (inflight) return inflight
  inflight = (async () => {
    const res = await fetch(INDEX_URL)
    if (!res.ok) throw new Error(`模板数据加载失败（HTTP ${res.status}）`)
    const data = (await res.json()) as Y56yLibrary
    // 资源路径在数据里是「相对 assets/ 的文件名」，载入时补成绝对 URL，
    // 免得引擎和缩略图各自记一套规则。
    for (const t of data.templates) {
      for (const n of t.nodes) {
        if (n.kind === 'image' && n.src) n.src = y56yAssetUrl(n.src)
      }
    }
    cache = data
    inflight = null
    return data
  })().catch((e) => {
    inflight = null
    throw e
  })
  return inflight
}

/** 已载入的库（未载入时为 null，供同步渲染使用） */
export const peekY56yLibrary = (): Y56yLibrary | null => cache

/** 一个 y56y 模板 → 可直接落画布的规格 */
export function buildY56ySpec(t: Y56yTemplate): TemplateSpec {
  return {
    name: `${t.name}（${t.id}）`,
    categoryName: t.catName,
    widthMm: t.widthMm,
    heightMm: t.heightMm,
    // 原站纸张底色 → 本项目的纸张属性（黑底白字/黄底警示这类反色设计全靠它，
    // 丢掉就变成"白底白字"整个看不见）
    ...(t.bg && t.bg !== '#ffffff' ? { bgColor: t.bg } : {}),
    nodes: t.nodes,
  }
}
