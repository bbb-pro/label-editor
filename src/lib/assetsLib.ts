/**
 * 素材库运行时：把本地打包的两个数据集（Lucide 图标 / Twemoji 表情）
 * 统一为可搜索、可分类的列表，供素材面板使用。
 *
 * 数据集较大（合计 ~550KB），统一走动态 import 懒加载，避免拉高首屏体积。
 */
import type { AssetItem, AssetCat, AssetSet } from '@/types/assets'
import { ZH, CAT_RULES, DEFAULT_CAT, TRANSPORT_CAT, categorizeLucide } from '@/lib/assetMeta'
import { SYMBOLS } from '@/lib/assetSymbols'

/** Lucide / 储运标志共用的线稿套壳：颜色与线宽在取用时替换 */
const STROKE_WRAP = (viewBox: number, inner: string, color: string, strokeWidth: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewBox} ${viewBox}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`

/** Lucide 默认线稿样式。这里的颜色会在每次取用时被替换为目标色 */
const LUCIDE_WRAP = (inner: string, color: string, strokeWidth = 2) => STROKE_WRAP(24, inner, color, strokeWidth)

const EMOJI_WRAP = (inner: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36">${inner}</svg>`

function lucideLabel(id: string): string {
  return ZH[id] ?? id
}

/**
 * 读取素材数据。
 *
 * 数据放在 `public/assets/`（而非打包进 JS）：文件合计数百 KB，
 * 走运行时 fetch 既能懒加载、又不进入首屏包体。
 */
async function fetchAssetJson(url: string): Promise<unknown> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`素材数据加载失败：${res.status}`)
  return await res.json()
}

const LUCIDE_URL = `${import.meta.env.BASE_URL}assets/icons-lucide.json`
const EMOJI_URL = `${import.meta.env.BASE_URL}assets/emoji-twemoji.json`

/**
 * 加载 Lucide 图标集合。
 * `svgFor` 返回可直接喂给 fabric.loadSVGFromString 的完整 SVG（线稿可按色重绘）。
 */
export async function loadLucideSet(): Promise<{ items: AssetItem[]; license: string }> {
  const lib = (await fetchAssetJson(LUCIDE_URL)) as {
    meta: { license?: string; source?: string }
    icons: [string, string][]
    aliases?: Record<string, string>
  }
  const alias = lib.aliases ?? {}
  const items: AssetItem[] = []

  const push = (id: string, inner: string) => {
    items.push({
      id: `lucide:${id}`,
      name: lucideLabel(id),
      search: `${(ZH[id] ?? '')} ${id.replace(/-/g, ' ')}`.trim().toLowerCase(),
      set: 'lucide',
      cat: categorizeLucide(id),
      // 延迟到取用时才套壳，便于按颜色实时重绘
      inner,
    })
  }

  for (const [id, inner] of lib.icons) push(id, inner)
  // 别名也入库，便于按旧名搜索（如 alert-triangle）
  for (const [from, to] of Object.entries(alias)) {
    const target = lib.icons.find(([n]) => n === to)
    if (target) push(from, target[1])
  }

  return { items, license: `${lib.meta?.source ?? 'Lucide'} · ${lib.meta?.license ?? 'ISC'}` }
}

/** 加载 Twemoji 精选表情集合 */
export async function loadEmojiSet(): Promise<{ items: AssetItem[]; license: string }> {
  const lib = (await fetchAssetJson(EMOJI_URL)) as {
    meta: { source?: string; license?: string }
    emoji: [string, string, string, string, string][]
  }
  const items: AssetItem[] = lib.emoji.map(([id, name, cat, ch, inner]) => ({
    id: `emoji:${id}`,
    name,
    search: `${name} ${id}`.toLowerCase(),
    set: 'emoji',
    cat,
    inner,
    preview: ch,
  }))
  return { items, license: `${lib.meta?.source ?? 'Twemoji'} · ${lib.meta?.license ?? 'CC-BY 4.0'}` }
}

/** 储运标志集合：静态内联（体积极小），无需 fetch */
export function loadSymbolsSet(): { items: AssetItem[]; license: string } {
  const items: AssetItem[] = SYMBOLS.map(([id, name, keywords, inner]) => ({
    id: `symbol:${id}`,
    name,
    search: `${name} ${keywords}`.toLowerCase(),
    set: 'symbols',
    cat: TRANSPORT_CAT.id,
    inner,
  }))
  return { items, license: '包装储运标志 · 自绘（GB/T 191 语义）' }
}

/** 把素材渲染为完整 SVG 字符串（lucide/储运标志支持换色） */
export function assetToSvg(item: AssetItem, color = '#000000', strokeWidth = 2): string {
  if (item.set === 'emoji') return EMOJI_WRAP(item.inner)
  if (item.set === 'symbols') return STROKE_WRAP(24, item.inner, color, 1.5)
  return LUCIDE_WRAP(item.inner, color, strokeWidth)
}

/** 生成用于 <img> 预览的 data URI */
export function assetPreviewUri(item: AssetItem, color = '#111827', strokeWidth = 2): string {
  const svg = assetToSvg(item, color, strokeWidth)
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

/** 全部分类（去重，含 emoji 数据里自带的类别名） */
export function collectCategories(items: AssetItem[], set: AssetSet | 'all'): AssetCat[] {
  const map = new Map<string, AssetCat>()
  const labelById = new Map(CAT_RULES.map((r) => [r.id, r.label]))
  labelById.set(DEFAULT_CAT.id, DEFAULT_CAT.label)
  labelById.set(TRANSPORT_CAT.id, TRANSPORT_CAT.label)
  for (const it of items) {
    if (set !== 'all' && it.set !== set) continue
    if (map.has(it.cat)) continue
    map.set(it.cat, { id: it.cat, label: labelById.get(it.cat) ?? it.cat })
  }
  return [...map.values()]
}

/** 关键字过滤：同时命中中文名 / 英文名 / 别名 */
export function filterAssets(items: AssetItem[], query: string, cat: string, set: AssetSet | 'all'): AssetItem[] {
  const q = query.trim().toLowerCase()
  return items.filter((it) => {
    if (set !== 'all' && it.set !== set) return false
    if (cat && cat !== 'all' && it.cat !== cat) return false
    if (!q) return true
    return it.search.includes(q) || it.name.toLowerCase().includes(q)
  })
}
