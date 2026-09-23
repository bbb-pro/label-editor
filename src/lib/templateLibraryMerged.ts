// 模板库「两源合一」
//
// 本项目有**两套模板源**，原本在对话框里用两个页签分开：
//   · 内置行业模板 —— src/lib/templateLibrary.ts，12 个 / 6 个行业分类（transkoi 口径）
//   · 通用模板     —— public/assets/templates/y56y-index.json，294 个 / 22 个分类（y56y 口径）
//
// 现在把它们合成**一个列表、一套分类**：行业模板按 INDUSTRY_CAT_MAP 归入通用模板里
// 语义相同的那几个分类；万一某个行业分类在通用模板里找不到对口的，就**单独开一个分类**
// （见 mergeCategories 里的 NEW_CAT_GROUP 分支），而不是硬塞进一个不贴切的分类。
//
// 之所以能在数据层真合并而不是只在 UI 上拼：buildTemplateSpec() 产出的 nodes 与
// 通用模板的 nodes 是**同一个类型**（TplNode，mm/pt 口径），缩略图与落画布都通用。
//
// 两套源仍各自保留自己的「落盘路径」（内置走 buildTemplateSpec、通用走 buildY56ySpec +
// 异步备图），所以合并项里带着 src 判别字段，由调用方分派 —— 这样零改动既有导出逻辑。

import { TEMPLATE_LIBRARY, TPL_CATEGORIES, categoryNameOf, type LibTemplate, type TplCategory } from '@/lib/templateLibrary'
import type { Y56yLibrary, Y56yTemplate } from '@/lib/templateLibraryY56y'

/**
 * 行业模板分类 → 通用模板（y56y）分类 id 的对接表。
 *
 * 每一条都是**逐项核对过通用模板里该分类下的模板名**之后才写的（依据见行末注释），
 * 不是按分类名望文生义。
 *
 * 没在这张表里的行业分类不会丢：mergeCategories() 会给它单开一个分类。
 */
export const INDUSTRY_CAT_MAP: Partial<Record<TplCategory, number>> = {
  // y56y[14] 里本来就有「营养成分标签」「食品配料信息标签」，与行业模板的「果汁饮料标签 / 营养成分标签」同类
  food: 14,
  // y56y[15] 含「快递运单标签」「物流快运单」「货运交货信息标签」，与「快递物流面单」同类
  ecommerce: 15,
  // y56y[18] 含「仓库物料标识标签」「物料标识卡」「轮胎入库标签」，与「货架位置标签 / 入库托盘标签」同类
  warehouse: 18,
  // y56y[24] 含「药品包装标签，包含生产商信息」「药品追溯码」，与「药品包装标签 / 检验合格标签」同类
  pharma: 24,
  // y56y[13] 含「固定资产标签」「电子设备管理标签」「资产信息标签」，与「固定资产标签 / IT 设备标签」同类
  asset: 13,
  // y56y[12] 含「服饰吊牌标签」「服饰水洗标签」「服饰信息挂牌，包含洗涤护理图标」，与「服装吊牌 / 洗涤说明标签」同类
  clothing: 12,
}

/** 新开分类用的分组名（行业模板里没有对口通用分类时） */
export const NEW_CAT_GROUP = '行业模板（新增）'

/** 新开分类的 id 基数：取负数，与通用模板的正数分类 id 天然不冲突 */
const NEW_CAT_ID_BASE = -1

export interface MergedCategory {
  id: number
  name: string
  /** 分组名（通用标签模板 / 跨境电商模板 / GS1系统标识 / 行业模板（新增）） */
  groupName: string
  /** 是否为本项目新开的分类 */
  isNew?: boolean
}

export interface MergedItem {
  /** 全局唯一键（跨两套源，`<src>:<id>`） */
  key: string
  name: string
  /** 展示用尺寸文案，如 60×40mm */
  size: string
  /** 归入的统一分类 id */
  catId: number
  catName: string
  /** 来自哪套源 —— 决定用哪个落盘函数 */
  src: 'builtin' | 'y56y'
  /** src === 'builtin' 时有值 */
  builtin?: LibTemplate
  /** src === 'y56y' 时有值 */
  y56y?: Y56yTemplate
}

/** 行业分类 → 统一分类 id（未对接上的走负数新分类） */
function catIdOfIndustry(code: TplCategory): number {
  const mapped = INDUSTRY_CAT_MAP[code]
  if (mapped != null) return mapped
  const idx = TPL_CATEGORIES.findIndex((c) => c.code === code)
  return NEW_CAT_ID_BASE - Math.max(0, idx)
}

export interface MergedLibrary {
  categories: MergedCategory[]
  items: MergedItem[]
  /** 分类 id → 模板数 */
  counts: Map<number, number>
}

/**
 * 合并两套模板源。
 * @param lib 已载入的通用模板库；为 null（还没 fetch 完）时只返回内置行业模板，
 *            让对话框能先把 12 个内置模板显示出来，不必空等那 800KB。
 */
export function mergeLibrary(lib: Y56yLibrary | null): MergedLibrary {
  const categories: MergedCategory[] = []
  const nameOfCat = new Map<number, string>()

  for (const c of lib?.categories ?? []) {
    categories.push({ id: c.id, name: c.name, groupName: c.groupName || '其他' })
    nameOfCat.set(c.id, c.name)
  }

  // 通用模板里没有对口的行业分类 → 单开一个分类
  for (const c of TPL_CATEGORIES) {
    if (INDUSTRY_CAT_MAP[c.code] != null) continue
    const id = catIdOfIndustry(c.code)
    categories.push({ id, name: c.name, groupName: NEW_CAT_GROUP, isNew: true })
    nameOfCat.set(id, c.name)
  }

  const items: MergedItem[] = []

  for (const t of lib?.templates ?? []) {
    items.push({
      key: `y56y:${t.id}`,
      name: t.name,
      size: t.size,
      catId: t.catId ?? NEW_CAT_ID_BASE,
      catName: t.catName,
      src: 'y56y',
      y56y: t,
    })
  }

  for (const t of TEMPLATE_LIBRARY) {
    const catId = catIdOfIndustry(t.industry)
    items.push({
      key: `builtin:${t.id}`,
      name: t.name,
      size: t.size,
      catId,
      // 通用模板库尚未载入时拿不到它的分类名，退回行业自己的分类名（载入后会被替换）
      catName: nameOfCat.get(catId) ?? categoryNameOf(t.industry),
      src: 'builtin',
      builtin: t,
    })
  }

  const counts = new Map<number, number>()
  for (const it of items) counts.set(it.catId, (counts.get(it.catId) ?? 0) + 1)

  return { categories, items, counts }
}
