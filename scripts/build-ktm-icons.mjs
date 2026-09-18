/**
 * 把竞品站（ktm.xp06.com）拉下来的图标库编译成本站点可用的素材包。
 *
 * 产物（均落在 public/assets/ktm/，运行时按需 fetch，不进主包）：
 *   index.json      分类索引（含每类中文标签与文件名），很轻，打开面板即加载
 *   c<NN>.json      单个分类的素材数据
 *   raster/*.png    位图素材原文件（fabric.Image 可直接吃 URL，无需内联成 base64）
 *
 * 关键处理：
 *  ① **单色矢量参数化**：把 `fill="#262222"` / `stroke="#000"` 统一换成占位符 `__C__`，
 *     取用时按用户颜色回填 → 与 Lucide 一样可换色。多色稿（安全标志的红+黑）
 *     保持原色 (style='filled')，否则会丢掉「红色禁止」这类语义。
 *  ② **位图与矢量分流**：PNG 交给 fabric.Image 走位图插入，导出时 jsPDF addImage 嵌入。
 *  ③ **去 width/height 只留 viewBox**：原文件带 `width="33.2mm"` 这类物理尺寸，
 *     直接内联会让 fabric 按毫米建对象。
 *  ④ **空壳过滤**：站内有些文件只有 `<rect fill="transparent">` 之类的占位内容。
 *
 * 用法：node scripts/build-ktm-icons.mjs <allDir> <items.json> <outDir> [overrides.json]
 */
import fs from 'node:fs'
import path from 'node:path'
import { simplifySvgContent } from './lib/simplify-svg-path.mjs'

const allDir = process.argv[2]
const items = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'))
const outDir = process.argv[4]
const overridesPath = process.argv[5]
const overrides = overridesPath && fs.existsSync(overridesPath)
  ? JSON.parse(fs.readFileSync(overridesPath, 'utf8'))
  : {}

fs.mkdirSync(path.join(outDir, 'raster'), { recursive: true })

const localName = (image) => {
  const parts = image.split('/').filter(Boolean)
  return `${(parts[1] || '_').replace(/[/\\:]/g, '_')}__${parts.slice(2).join('_').replace(/[/\\:]/g, '_')}`
}

/** 会画东西的元素 —— 用来判定「空壳」 */
const DRAW_TAGS = /<(path|circle|rect|ellipse|polygon|polyline|line|text|image|use)\b/i

/**
 * 把 SVG 源码整理成「内部片段 + 元信息」。
 * @returns {{inner:string, viewBox:string, style:'line'|'filled', shapes:number}|null}
 */
function normalizeSvg(txt) {
  const m = txt.match(/<svg\b([^>]*)>([\s\S]*)<\/svg>/i)
  if (!m) return null
  const attrs = m[1]
  let inner = m[2]

  // viewBox 优先；没有就用 width/height 兜底（去掉单位）
  let viewBox = (attrs.match(/viewBox="([^"]+)"/i) || [])[1]
  if (!viewBox) {
    const w = (attrs.match(/width="([\d.]+)/i) || [])[1]
    const h = (attrs.match(/height="([\d.]+)/i) || [])[1]
    if (w && h) viewBox = `0 0 ${w} ${h}`
  }
  if (!viewBox) return null
  // 归一化分隔符（有些文件写成逗号）
  viewBox = viewBox.trim().replace(/\s*,\s*/g, ' ').replace(/\s+/g, ' ')

  // 去掉注释 / 元数据 / defs 之外的垃圾，压掉多余空白
  inner = inner
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<(metadata|title|desc)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/\s*\n\s*/g, '')
    .trim()

  if (!DRAW_TAGS.test(inner)) return null

  // 颜色统计（排除 none / 透明 / 渐变引用）
  const colors = new Set()
  for (const c of inner.matchAll(/(?:fill|stroke)="([^"]*)"/g)) {
    const v = c[1].trim().toLowerCase()
    if (!v || v === 'none' || v === 'transparent' || v === 'currentcolor' || v.startsWith('url(')) continue
    colors.add(v)
  }
  const shapes = (inner.match(/<(path|circle|rect|ellipse|polygon|polyline|line)\b/gi) || []).length

  let style = colors.size <= 1 ? 'line' : 'filled'
  if (style === 'line' && colors.size === 1) {
    // 单色 → 参数化：颜色值换成占位符，取用时按用户颜色回填
    const only = [...colors][0]
    inner = inner.replace(new RegExp(`(fill|stroke)="${only.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'gi'), '$1="__C__"')
  }

  // 体量异常的自动描摹剪影（单条路径 1MB、4 万个坐标点）先做几何简化：
  // 既压体积，也避免 fabric 解析这种路径时明显卡顿。简化带面积校验，变形超阈值会自行放弃。
  if (inner.length > 3000) {
    const r = simplifySvgContent(inner)
    if (r.after < r.before) inner = r.inner
  }
  return { inner, viewBox, style, shapes }
}

/**
 * 分类级检索词。
 *
 * 竞品站里合规标志的矢量版**没有名字**（name 一律是 "iso"），只有标准编号文件名
 * （iso_washing07 / iso_packaging18 …）。硬猜中文名风险大 —— 猜错比没名字更糟
 * （用户拿去做服装洗标、危险品运输标签，错一个符号就是实打实的合规问题）。
 *
 * 所以这里只做一件事：把「这个编号属于哪套标准」挂到检索串上。
 * 用户搜「洗涤 / 洗标 / 水洗」能命中整组 ISO 3758 符号，再照着图挑；
 * 显示名仍是原编号，不冒充精确名称。
 */
const CAT_KEYWORDS = {
  '纺织水洗': 'ISO 3758 洗涤护理 洗标 水洗 干洗 漂白 熨烫 晾干 washing care label',
  '包装储运': 'GB/T 191 包装储运图示标志 运输包装 提示标志 packaging transport handling',
  '禁止标识': 'ISO 7010 禁止标志 安全标志 prohibition safety sign',
  '安全指引': 'ISO 7010 安全条件标志 安全标志 safe condition safety sign',
  '强制执行': 'ISO 7010 强制性标志 必须佩戴 强制操作 mandatory action safety sign',
  '警示标识': 'ISO 7010 警告标志 安全标志 warning caution safety sign',
  '危险警示': '危险警示标志 安全警告 hazard warning',
  'GHS全球危险品标示': 'GHS UN ADR 危险货物 危险品 运输标签 象形图 hazard pictogram transport',
  '环保回收': '回收标志 可回收 再生 循环 recycling recyclable',
  '垃圾分类': '垃圾分类 投放指引 waste sorting',
  '西班牙环保': '西班牙 环保标志 包装回收 ecoembes',
  '法国标识': '法国 Triman 回收标识 包装标志',
  '法国修复': '法国 可修复性 维修指数 repairability',
  '欧盟能效': '欧盟能效标签 EU energy label 能效等级',
  '认证': '产品认证 认证标志 合格标志 certification mark',
  '医疗器械标': '医疗器械标识 ISO 15223 医疗符号 medical device symbol',
  '纽扣电池': '纽扣电池 电池警示 电池回收 battery warning',
  '鞋类': '鞋类标识 材质说明 shoe labelling',
  '通用': '通用标识 包装标识 商品标志 general mark',
  '警示标语': '警示标语 提示文字 warning label',
}

const byCat = new Map()
for (const it of items) {
  const cat = it.image.split('/').filter(Boolean)[1] || '_'
  if (!byCat.has(cat)) byCat.set(cat, [])
  byCat.get(cat).push(it)
}

const index = []
const usedIds = new Set()
const stats = { line: 0, filled: 0, raster: 0, skipped: 0, bytes: 0 }
let seq = 0

for (const [cat, list] of byCat) {
  seq++
  const catId = `c${String(seq).padStart(2, '0')}`
  const catItems = []

  for (const it of list) {
    const key = localName(it.image)
    const fp = path.join(allDir, key)
    if (!fs.existsSync(fp)) { stats.skipped++; continue }
    const short = key.split('__')[1].replace(/\.[a-z]+$/i, '')
    const ext = path.extname(it.image).toLowerCase()

    // 名字：优先外部覆盖表 → 站内中文名 → 短文件名
    const ov = overrides[key] || overrides[short]
    const rawName = (it.name || '').trim()
    const name = ov || (rawName && rawName !== 'iso' && rawName !== short ? rawName : short)
    // 检索串：中文名 + 文件名 + 站内原名，让「编号 / 英文 / 中文」都能搜到
    const kw = [ov, rawName, short, it.tags, CAT_KEYWORDS[cat]].filter(Boolean).join(' ').toLowerCase()
    // 同分类下同名不同格式（IC.svg / IC.png）会让 id 撞车 → 加序号后缀
    let idKey = short
    for (let n = 2; usedIds.has(`${catId}:${idKey}`); n++) idKey = `${short}-${n}`
    usedIds.add(`${catId}:${idKey}`)
    const id = `ktm:${catId}:${idKey}`

    if (ext === '.svg') {
      const norm = normalizeSvg(fs.readFileSync(fp, 'utf8'))
      if (!norm) { stats.skipped++; continue }
      stats[norm.style]++
      catItems.push([id, name, kw, norm.style, norm.viewBox, norm.inner])
    } else if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') {
      const buf = fs.readFileSync(fp)
      // 位图：只存相对路径，fabric.Image 自己按 URL 取
      const destName = `${catId}-${short.replace(/[^\w.-]/g, '_')}${ext}`
      fs.writeFileSync(path.join(outDir, 'raster', destName), buf)
      const isPng = ext === '.png'
      const w = isPng ? buf.readUInt32BE(16) : 0
      const h = isPng ? buf.readUInt32BE(20) : 0
      stats.raster++
      catItems.push([id, name, kw, 'raster', `${w}x${h}`, `raster/${destName}`])
    } else {
      stats.skipped++
      continue
    }
  }

  if (!catItems.length) continue
  const file = `${catId}.json`
  const payload = JSON.stringify({ cat: catId, label: cat, items: catItems })
  fs.writeFileSync(path.join(outDir, file), payload)
  stats.bytes += payload.length
  index.push({ id: catId, label: cat, file, count: catItems.length })
}

fs.writeFileSync(
  path.join(outDir, 'index.json'),
  JSON.stringify({
    meta: {
      source:
        '扩展图标库 · 取自公开在线编辑器 ktm.xp06.com 的素材清单（含 ISO 3758 洗涤护理、' +
        'ISO 7010 安全标志、GB/T 191 包装储运、回收环保、GHS/ADR 危险品、欧盟能效等）；' +
        '其中认证类多为第三方注册商标（如 UL / TÜV / FSC / FDA），用于实际产品前请自行确认授权',
      total: index.reduce((a, c) => a + c.count, 0),
    },
    cats: index,
  }),
)

console.log(`分类 ${index.length} 个，导出 ${stats.line + stats.filled} 个矢量 + ${stats.raster} 个位图，跳过 ${stats.skipped}`)
console.log(`  单色可换色 ${stats.line} · 多色原样 ${stats.filled} · 数据合计 ${(stats.bytes / 1048576).toFixed(1)}MB`)
console.log('  分类明细:')
for (const c of index) console.log(`   ${c.id} ${c.label} ${c.count}`)
