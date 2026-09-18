/**
 * 素材库运行时：把本地打包的两个数据集（Lucide 图标 / Twemoji 表情）
 * 统一为可搜索、可分类的列表，供素材面板使用。
 *
 * 数据集较大（合计 ~550KB），统一走动态 import 懒加载，避免拉高首屏体积。
 */
import type { AssetItem, AssetCat, AssetSet } from '@/types/assets'
import { ZH, CAT_RULES, DEFAULT_CAT, TRANSPORT_CAT, categorizeLucide } from '@/lib/assetMeta'
import { SYMBOLS } from '@/lib/assetSymbols'
import { MARKS, MARK_CATS } from '@/lib/assetMarks'

/** 线稿套壳：颜色与线宽在取用时替换。viewBox 逐项传入（各素材坐标系不同） */
const STROKE_WRAP = (viewBox: string, inner: string, color: string, strokeWidth: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`

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
/** UN GHS 危险品九类象形图（由 scripts/build-ghs-marks.mjs 生成） */
const GHS_MARKS_URL = `${import.meta.env.BASE_URL}assets/marks-ghs.json`

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
    fillStyle: 'line',
  }))
  return { items, license: '包装储运标志 · 自绘（GB/T 191 语义）' }
}

/**
 * 标准合规标志集合。
 *
 * - **UN GHS 危险品九类**：运行时 fetch（约 40KB 矢量路径），与 lucide / emoji 同一套做法，
 *   图形为 UN GHS 标准象形图，由 scripts/build-ghs-marks.mjs 从 MIT 许可的 npm 包抽取。
 * - **CE / ISO 3758 洗涤 / 回收 / 认证**：静态内联（体积极小）。
 *   CE 几何取自欧盟委员会官方矢量模型，'filled' 类原样输出不改色。
 */
export async function loadMarksSet(): Promise<{ items: AssetItem[]; license: string }> {
  const toItem = (
    id: string,
    name: string,
    keywords: string,
    cat: string,
    style: AssetItem['fillStyle'],
    inner: string,
    viewBox?: string,
  ): AssetItem => ({
    id: `mark:${id}`,
    name,
    search: `${name} ${keywords}`.toLowerCase(),
    set: 'marks',
    cat,
    inner,
    fillStyle: style,
    viewBox,
  })

  let ghs: AssetItem[] = []
  let ghsLicense = ''
  try {
    const lib = (await fetchAssetJson(GHS_MARKS_URL)) as {
      meta: { source?: string; license?: string }
      marks: [string, string, string, string, string][]
    }
    ghs = lib.marks.map(([id, name, kw, viewBox, inner]) =>
      toItem(id, name, kw, 'ghs', 'filled', inner, viewBox),
    )
    ghsLicense = `GHS 危险品标示 · ${lib.meta?.source ?? 'UN GHS'} · ${lib.meta?.license ?? 'MIT'}`
  } catch {
    // GHS 数据缺失不应连累整个素材面板：其余标志照常可用
  }

  const selfDrawn = MARKS.map(([id, name, keywords, cat, style, inner, viewBox]) =>
    toItem(id, name, keywords, cat, style, inner, viewBox),
  )

  return {
    items: [...ghs, ...selfDrawn],
    license: ['标准合规标志 · CE 用欧盟官方几何 · 其余自绘（ISO 3758 / 回收 / 认证）', ghsLicense]
      .filter(Boolean)
      .join(' · '),
  }
}

// ════════════════════════════════════════════════════════════════════
// 扩展图标库（81 类 / 4000+ 项，按分类分包，用到才下载）
// ════════════════════════════════════════════════════════════════════
const KTM_DIR = `${import.meta.env.BASE_URL}assets/ktm`

/** 扩展图标库的一个分类 */
export interface KtmCatInfo {
  /** 面板分类 id（带 ktm- 前缀，避免与内置分类撞名） */
  id: string
  label: string
  /** 该分类的数据文件名，形如 `c27.json` */
  file: string
  count: number
}

interface KtmIndex {
  cats: KtmCatInfo[]
  total: number
  license: string
}

/**
 * 读取扩展图标库的**分类索引**（很轻，几 KB）。
 *
 * 整库 30MB+，不可能一次拉全 —— 所以面板启动只拿索引（有哪些类、各多少项），
 * 用户点到某个分类再用 `loadKtmCat` 拉那一类（几百 KB）。
 */
export async function loadKtmIndex(): Promise<KtmIndex> {
  const lib = (await fetchAssetJson(`${KTM_DIR}/index.json`)) as {
    meta?: { source?: string; total?: number }
    cats: { id: string; label: string; file: string; count: number }[]
  }
  return {
    cats: (lib.cats ?? []).map((c) => ({ id: `ktm-${c.id}`, label: c.label, file: c.file, count: c.count })),
    total: lib.meta?.total ?? 0,
    license: lib.meta?.source ?? '扩展图标库',
  }
}

/**
 * 读取扩展图标库的某个分类。
 *
 * 数据里每项是 `[id, 名称, 检索串, 形态, viewBox, 内容]`：
 * - 形态 `line`：单色矢量，内容里的颜色已换成 `__C__` 占位符，取用时按当前颜色回填
 * - 形态 `filled`：多色矢量，保留原配色
 * - 形态 `raster`：位图，第五字段是像素尺寸、第六字段是图片相对路径
 */
export async function loadKtmCat(cat: KtmCatInfo): Promise<AssetItem[]> {
  const lib = (await fetchAssetJson(`${KTM_DIR}/${cat.file}`)) as {
    items: [string, string, string, string, string, string][]
  }
  return (lib.items ?? []).map(([id, name, kw, style, vb, body]) => {
    if (style === 'raster') {
      return {
        id,
        name,
        search: kw,
        set: 'ktm' as const,
        cat: cat.id,
        inner: '',
        rasterSrc: `${KTM_DIR}/${body}`,
        rasterSize: vb,
      }
    }
    return {
      id,
      name,
      search: kw,
      set: 'ktm' as const,
      cat: cat.id,
      inner: body,
      fillStyle: style as 'line' | 'filled',
      viewBox: vb,
    }
  })
}

/** 含固有配色的素材（GHS 红菱形、CE 黑字、能效彩条）原样输出，不覆盖颜色与线宽 */
const PLAIN_WRAP = (viewBox: string, inner: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${inner}</svg>`

/**
 * 扩展图标库套壳。
 *
 * 这批图形**自带线宽与各自坐标系**（有的 viewBox 是 3200 见方、stroke-width 116），
 * 所以只做一件事：把编译期埋下的颜色占位符 `__C__` 换成当前颜色。
 * 外层同时给 fill/stroke 兜底，让「没写颜色属性」的那些图形也能上色；
 * 子元素自带的 `fill="none"` / `stroke-width` 优先级更高，不受影响。
 */
const KTM_WRAP = (viewBox: string, inner: string, color: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" fill="${color}" stroke="${color}">${inner}</svg>`

/** 把素材渲染为完整 SVG 字符串（线稿类支持换色） */
export function assetToSvg(item: AssetItem, color = '#000000', strokeWidth = 2): string {
  const vb = item.viewBox ?? (item.set === 'emoji' ? '0 0 36 36' : '0 0 24 24')
  if (item.set === 'emoji') return EMOJI_WRAP(item.inner)
  if (item.set === 'ktm') {
    // 多色稿（安全标志的红+黑、能效彩条）保留原配色，换色会丢语义
    if (item.fillStyle === 'filled') return PLAIN_WRAP(vb, item.inner)
    return KTM_WRAP(vb, item.inner.replace(/__C__/g, color), color)
  }
  if (item.set === 'marks') {
    // 合规标志：filled 自带配色；line 用略粗线稿（合规符号普遍比 UI 图标描边重）
    return item.fillStyle === 'filled'
      ? PLAIN_WRAP(vb, item.inner)
      : STROKE_WRAP(vb, item.inner, color, 1.6)
  }
  if (item.set === 'symbols') return STROKE_WRAP(vb, item.inner, color, 1.5)
  return STROKE_WRAP(vb, item.inner, color, strokeWidth)
}

/** 生成用于 <img> 预览的 data URI（位图素材直接用它自己的地址） */
export function assetPreviewUri(item: AssetItem, color = '#111827', strokeWidth = 2): string {
  if (item.rasterSrc) return item.rasterSrc
  const svg = assetToSvg(item, color, strokeWidth)
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

/** 全部分类（去重，含 emoji 数据里自带的类别名） */
export function collectCategories(
  items: AssetItem[],
  set: AssetSet | 'all',
  extraLabels?: Map<string, string>,
): AssetCat[] {
  const map = new Map<string, AssetCat>()
  const labelById = new Map(CAT_RULES.map((r) => [r.id, r.label]))
  labelById.set(DEFAULT_CAT.id, DEFAULT_CAT.label)
  labelById.set(TRANSPORT_CAT.id, TRANSPORT_CAT.label)
  for (const c of MARK_CATS) labelById.set(c.id, c.label)
  for (const [k, v] of extraLabels ?? []) labelById.set(k, v)
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
