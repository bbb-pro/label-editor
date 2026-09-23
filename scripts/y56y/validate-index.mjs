// 全量模板索引结构自检（Node 侧，秒级，不依赖浏览器）
//
// convert.mjs 的预校验是「与原站预览 SVG 逐元素对数值」，管的是"搬得准不准"；
// 这个脚本管的是"搬回来的东西能不能被画布引擎安全消费"：
//   · 坐标/尺寸是否有限、是否落在纸面附近（NaN / 负值 / 离谱越界都会让 fabric 出怪图）
//   · 字号、线宽、圆角是否为正
//   · image 节点引用的资源文件是否真实存在于 public/assets/templates/assets/
//   · barcode 节点的码制是否在本项目支持列表内、内容是否非空
//   · 每个模板至少有一个节点（空模板点了会像"没反应"）
// 用法：node scripts/y56y/validate-index.mjs
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const OUT_DIR = join(ROOT, 'public/assets/templates')
const ASSET_DIR = join(OUT_DIR, 'assets')

/** 从 barcode.ts 里抽码制清单，避免两处硬编码各自漂移 */
function supportedBarcodeTypes() {
  const src = readFileSync(join(ROOT, 'src/lib/barcode.ts'), 'utf8')
  const blk = src.slice(src.indexOf('BARCODE_OPTIONS'), src.indexOf('export const is2dType'))
  return new Set([...blk.matchAll(/value:\s*'([^']+)'/g)].map((m) => m[1]))
}

const KINDS = new Set(['text', 'barcode', 'rect', 'line', 'ellipse', 'image'])
const finite = (v) => typeof v === 'number' && Number.isFinite(v)

const problems = []
const warnings = []
const note = (id, msg) => problems.push(`${id} · ${msg}`)
const warn = (id, msg) => warnings.push(`${id} · ${msg}`)

function main() {
  const idx = JSON.parse(readFileSync(join(OUT_DIR, 'y56y-index.json'), 'utf8'))
  const types = supportedBarcodeTypes()
  const cats = new Set(idx.categories.map((c) => c.id))
  const stats = { templates: 0, nodes: 0, images: 0, byKind: {} }

  for (const t of idx.templates) {
    stats.templates++
    const W = t.widthMm
    const H = t.heightMm
    if (!finite(W) || !finite(H) || W <= 0 || H <= 0) note(t.id, `纸张尺寸非法 ${W}×${H}`)
    if (!cats.has(t.catId)) note(t.id, `分类 ${t.catId} 不存在`)
    if (!t.nodes.length) note(t.id, '没有任何节点')

    for (const n of t.nodes) {
      stats.nodes++
      stats.byKind[n.kind] = (stats.byKind[n.kind] || 0) + 1
      if (!KINDS.has(n.kind)) {
        note(t.id, `未知节点类型 ${n.kind}`)
        continue
      }
      // 判据只看「**整个**元素是否落在纸面之外」——那才是真正会出问题的状态
      // （纸外对象在画布上是半透明的、且不参与导出，等于这个元素白搬了）。
      // 不许用「只要有一点越界就报错」：设计稿里让色块/线条压着出血边、竖排文字
      // 的包围盒跨出纸外都是常态，那种"越界"是刻意的，报出来只会淹没真问题。
      //
      // ⚠️ 但「完全落在纸外」只是**提示**而非错误：已逐个比对原站预览 SVG 确认，
      // 原站设计稿本身就把这些元素放在画布外（作为备用文案/隐藏内容），预览 SVG 里
      // 这些 id 都存在、只是被纸张 viewBox 裁掉了。本项目的工作区是无限画布，
      // 纸外对象会以半透明呈现、不参与导出，用户可以把它们拖进纸内复用 —— 属于
      // 「原样搬运」而非搬运缺陷。（X6WY6 那种零长线已由 convert.mjs 的
      // isDegenerate 净化掉，不会再出现在这里。）
      const overlap = (x, y, w, h) =>
        x + w > 0.2 && y + h > 0.2 && x < W - 0.2 && y < H - 0.2
      const boxOf = (n) => {
        switch (n.kind) {
          case 'text':
            return [n.xMm, n.yMm, n.wMm, n.hMm ?? 3]
          case 'line':
            return [
              Math.min(n.x1Mm, n.x2Mm),
              Math.min(n.y1Mm, n.y2Mm),
              Math.abs(n.x2Mm - n.x1Mm) || 0.2,
              Math.abs(n.y2Mm - n.y1Mm) || 0.2,
            ]
          case 'ellipse':
            return [n.cxMm - n.rxMm, n.cyMm - n.ryMm, n.rxMm * 2, n.ryMm * 2]
          default:
            return [n.xMm, n.yMm, n.wMm, n.hMm]
        }
      }
      const [bx, by, bw, bh] = boxOf(n)
      if ([bx, by, bw, bh].every(finite) && !overlap(bx, by, bw, bh)) {
        warn(t.id, `${n.kind} 完全落在纸外 (${bx},${by},${bw}×${bh})`)
      }

      switch (n.kind) {
        case 'text': {
          if (!n.text) note(t.id, 'text 内容为空')
          if (!finite(n.fontSizePt) || n.fontSizePt <= 0) note(t.id, `字号非法 ${n.fontSizePt}`)
          if (!finite(n.wMm) || n.wMm <= 0) note(t.id, `文本框宽非法 ${n.wMm}`)
          if (!['left', 'center', 'right'].includes(n.align)) note(t.id, `对齐非法 ${n.align}`)
          if (n.rotateDeg && !finite(n.rotateDeg)) note(t.id, '旋转角非法')
          if (n.rotateDeg && !finite(n.hMm)) note(t.id, '带旋转但缺 hMm（旋转会以错误中心为轴）')
          if (n.multiline && n.lineHeight != null && !(n.lineHeight > 0))
            note(t.id, `行距非法 ${n.lineHeight}`)
          break
        }
        case 'barcode': {
          if (!types.has(n.barcodeType)) note(t.id, `不支持的码制 ${n.barcodeType}`)
          if (typeof n.text !== 'string' || !n.text.trim()) note(t.id, '条码内容为空')
          if (!finite(n.wMm) || n.wMm <= 0 || !finite(n.hMm) || n.hMm <= 0) note(t.id, '条码框非法')
          break
        }
        case 'rect': {
          if (!finite(n.wMm) || n.wMm <= 0 || !finite(n.hMm) || n.hMm <= 0) note(t.id, '矩形尺寸非法')
          if (!n.filled && !(n.strokeMm > 0)) note(t.id, '空心矩形没有描边宽度')
          break
        }
        case 'line': {
          if (![n.x1Mm, n.y1Mm, n.x2Mm, n.y2Mm].every(finite)) note(t.id, '直线端点非法')
          if (!(n.strokeMm > 0)) note(t.id, `直线粗细非法 ${n.strokeMm}`)
          // 零长线应已被 convert.mjs 的 isDegenerate 丢弃；再出现说明净化失效
          if (Math.abs(n.x1Mm - n.x2Mm) < 0.05 && Math.abs(n.y1Mm - n.y2Mm) < 0.05)
            note(t.id, '直线长度为 0（净化漏网）')
          break
        }
        case 'ellipse': {
          if (!(n.rxMm > 0) || !(n.ryMm > 0)) note(t.id, '椭圆半径非法')
          break
        }
        case 'image': {
          stats.images++
          if (!n.src) note(t.id, 'image 缺 src')
          else if (!existsSync(join(ASSET_DIR, n.src))) note(t.id, `资源文件缺失 ${n.src}`)
          if (!finite(n.wMm) || n.wMm <= 0 || !finite(n.hMm) || n.hMm <= 0) note(t.id, '图片尺寸非法')
          if (n.vector && !n.src.endsWith('.svg')) note(t.id, `vector 标记与扩展名不符 ${n.src}`)
          break
        }
      }
    }
  }

  console.log(`检查 ${stats.templates} 个模板 / ${stats.nodes} 个节点（其中图片节点 ${stats.images}）`)
  console.log('节点类型分布:', stats.byKind)
  if (warnings.length) {
    console.log(`\n⚠️ ${warnings.length} 处提示（原站设计稿即如此，非搬运缺陷）：`)
    for (const w of warnings.slice(0, 20)) console.log('   · ' + w)
    if (warnings.length > 20) console.log(`   … 其余 ${warnings.length - 20} 条从略`)
  }
  if (problems.length) {
    console.error(`\n❌ 发现 ${problems.length} 处问题：`)
    for (const p of problems.slice(0, 60)) console.error('   · ' + p)
    if (problems.length > 60) console.error(`   … 其余 ${problems.length - 60} 条从略`)
    process.exitCode = 1
  } else {
    console.log('✅ 结构自检全部通过')
  }
}

main()
