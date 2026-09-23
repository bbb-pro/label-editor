// y56y.com 模板 → 本项目模板规格（mm / pt / 度）
//
// ── 坐标/单位口径（全部经原站预览 SVG 交叉验证，见文件末尾 verifyAgainstPreview）──
// · 页面：pageWidth / pageHeight 直接就是 mm。
// · 元素 x/y/width/height/cx/cy/rx/ry / line 的 x1..y2：**页面百分比**。
// · 字号 / 字距：api 值先 ×1.3 得预览 SVG 的 px，再 ÷ 预览比例 s 得 mm。
//   原站预览画布的比例 s = min(20, 800/页宽, 600/页高)（预览单位/mm），
//   即 viewBox 恒定落在 800×600 的框内。本脚本对 248 个模板逐一校验过该式。
//   文字还有 scaleX/scaleY（SVG 里是 transform="scale(sx,sy)"），字号取 scaleY。
// · 线宽 / 描边 / 圆角：api 值就是**百分比**（原站 SVG 直接写成 stroke-width="0.5%"），
//   按 SVG 的百分比解析规则对「归一化对角线」取基准：
//   mm = 值/100 × √(W²+H²)/√2。
// · 旋转：rotate 直接是角度；writingMode≠1 的竖排文字用 90° 近似。
//
// ── 输出 ──
//   public/assets/templates/y56y-index.json      模板与元素（除图片资源外全量）
//   public/assets/templates/assets/<sha1>.<ext>  内嵌图标/图片（按内容去重）
//   .tmp/y56y/convert-report.json                转换统计与预览 SVG 交叉校验结果
//
// 用法：node scripts/y56y/convert.mjs [--no-verify]
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dir, '../..')
const API_DIR = join(ROOT, '.tmp/y56y/api')
const PREVIEW_DIR = join(ROOT, '.tmp/y56y/preview')
const MANIFEST = join(ROOT, '.tmp/y56y/manifest.json')
const OUT_DIR = join(ROOT, 'public/assets/templates')
const ASSET_DIR = join(OUT_DIR, 'assets')

const VERIFY = !process.argv.includes('--no-verify')

// ── 颜色：原站有 #ff0000 这类「占位红」，实测页面里并不出现（预览 SVG 里全是黑）。
//    统一归一化：把明显的洋红/纯红占位色归到黑色，避免模板出现莫名的红框。
const DEFAULTS = new Set(['#ff0000', '#ff00ff', '#f00', '#f0f'])
const normColor = (c, fallback = '#000000') => {
  if (!c || typeof c !== 'string') return fallback
  const v = c.trim().toLowerCase()
  if (DEFAULTS.has(v)) return '#000000'
  return v
}

// ── 单位换算 ──────────────────────────────────────────────────────
const K_FONT = 1.3
/**
 * 预览比例 s（预览单位/mm）。原站预览的取景框是 800×600，但**只按一条边对齐**：
 *   · 横向（页宽 ≥ 页高）→ 铺满宽度：s = 800/页宽
 *   · 方形 / 竖向（页高 > 页宽）→ 铺满高度：s = 600/页高
 * 实测 248 个模板里 224 个与该式误差 <0.5%，其余 ≤1.3%（竖向那批预览左右轴
 * 比例本身略有非均匀，属原站生成器的取整）。
 * ⚠️ 我先前后错了两次，记在这里免得再犯：
 *   ① 误加「上限 20」→ 30×25、20×20 等 35 个模板全错；
 *   ② 误用 min(800/W, 600/H) 的等比内接 → 100×80、60×50 这类横向模板会被压到 750/720。
 * ⚠️ 另注意：列表页标题里的尺寸偶尔与接口 pageWidth/pageHeight 转置
 *   （L0027 列表写 40×30，接口是 30×40）——一律以**接口**为准。
 */
const previewScale = (W, H) => (H >= W ? 600 / H : 800 / W)

/** 字号/字距：api 值 → mm */
const fontMm = (v, s, scale = 1) => ((v || 0) * K_FONT * scale) / s
/** mm → pt（与模板里其它字号同一口径：96dpi 下 1px = 0.75pt） */
const mmToPt = (mm) => (mm / 25.4) * 96 * 0.75
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
/** 线宽/描边/圆角：api 的百分比 → mm（基准 = 归一化对角线） */
const pctStrokeMm = (v, W, H) => {
  if (!v) return 0
  const diag = Math.sqrt(W * W + H * H) / Math.SQRT2
  return clamp((v / 100) * diag, 0.08, 1.5)
}
const round = (v, n = 3) => Number(v.toFixed(n))

/** 文字自然宽度的保守估计（宁可偏小：引擎会在落盘时量真实宽度并自动放宽） */
function estTextWidthMm(text, fsMm) {
  let em = 0
  for (const ch of String(text)) {
    const c = ch.codePointAt(0)
    em += c > 0x2e7f ? 1.0 : 0.55
  }
  return em * fsMm
}

// ── 码制映射 ──────────────────────────────────────────────────────
const FORMAT_MAP = {
  CODE128: 'code128', CODE128A: 'code128', CODE128B: 'code128', CODE128C: 'code128',
  CODE39: 'code39', CODE93: 'code93',
  EAN13: 'ean13', EAN8: 'ean8', EAN2: 'ean2', EAN5: 'ean5',
  UPC: 'upca', UPCA: 'upca', UPCE: 'upce',
  ITF14: 'itf14', ITF: 'interleaved2of5', ITF16: 'itf14',
  'GS1-128': 'gs1-128', EAN128: 'gs1-128', GS1128: 'gs1-128',
  DATAMATRIX: 'datamatrix', PDF417: 'pdf417', QRCODE: 'qrcode',
  MSI: 'msi', PHARMACODE: 'pharmacode', CODABAR: 'rationalizedCodabar',
}
const mapFormat = (f) => FORMAT_MAP[String(f || '').trim().toUpperCase()] || 'code128'
/** QR 容错：原站存的是百分比（7/15/25/30） */
const ECC_MAP = { 7: 'L', 15: 'M', 25: 'Q', 30: 'H' }
const mapEcc = (v) => ECC_MAP[Number(v)] || undefined
/** textAnchor 1/2/3 → 左/中/右 */
const mapAnchor = (v) => (Number(v) === 2 ? 'center' : Number(v) === 3 ? 'right' : 'left')

// ── SVG 资源归一化 ────────────────────────────────────────────────
// 原站的内嵌图标 SVG 是「按视口百分比」写的坐标系（x="50%"、rx="44.62%"、
// stroke-width="8.74%"…），viewBox 也未必从 0 开始。直接搬进编辑器会踩两处：
//   ① fabric 的 SVG 解析与 jsPDF 的 svg2pdf **都不解析百分比**（fabric 5 会把
//      "50%" 当 0 处理）→ 图标整个塌成一点；
//   ② 导出链路是把「整段 SVG」重绘进对象的包围盒，若包围盒与 viewBox 不一致，
//      画布与 PDF 会互相错位。
// 所以这里做一次确定性改写：百分比 → 绝对用户单位、viewBox 平移到 0 0 W H、
// 去掉原站塞在 <title>/<description> 里的版权水印文本（署名统一放在索引的
// sourceNote 里，不往用户的成品里塞）。
// 实测 103 个资源的百分比属性只有 x/y/width/height/x1..y2/cx/cy/rx/ry/stroke-width，
// 无渐变、无 font-size 百分比、无 transform 百分比，故按属性名分派即可。
const SVG_PCT_BASE = new Map([
  // 百分比基准 = 视口宽度
  ['x', 'w'], ['width', 'w'], ['x1', 'w'], ['x2', 'w'], ['cx', 'w'], ['fx', 'w'], ['rx', 'w'],
  // 百分比基准 = 视口高度
  ['y', 'h'], ['height', 'h'], ['y1', 'h'], ['y2', 'h'], ['cy', 'h'], ['fy', 'h'], ['ry', 'h'],
  // 百分比基准 = 归一化对角线（SVG 1.1 对 stroke-width / r 的规定）
  ['stroke-width', 'd'], ['stroke-dashoffset', 'd'], ['r', 'd'], ['font-size', 'd'],
])

/** 从 <svg> 起始标签里读 viewBox（缺失时退回 width/height），返回 {x,y,w,h} */
function readSvgBox(svg) {
  const head = /<svg\b([^>]*)>/i.exec(svg)
  const attrs = head ? head[1] : ''
  const vb = /\bviewBox\s*=\s*"([^"]*)"/i.exec(attrs)
  if (vb) {
    const n = vb[1].trim().split(/[\s,]+/).map(Number)
    if (n.length === 4 && n.every(Number.isFinite) && n[2] > 0 && n[3] > 0) {
      return { x: n[0], y: n[1], w: n[2], h: n[3] }
    }
  }
  const mw = /\bwidth\s*=\s*"([\d.]+)/i.exec(attrs)
  const mh = /\bheight\s*=\s*"([\d.]+)/i.exec(attrs)
  return { x: 0, y: 0, w: Number(mw?.[1]) || 100, h: Number(mh?.[1]) || 100 }
}

/** 数字保留 4 位小数，去掉多余的 0（减小体积，且不损失可见精度） */
const num = (v) => String(Math.round(v * 10000) / 10000)

/** 百分比坐标 → 绝对用户单位；viewBox 归零；去掉版权水印节点 */
function normalizeAssetSvg(svg) {
  const box = readSvgBox(svg)
  const diag = Math.sqrt(box.w * box.w + box.h * box.h) / Math.SQRT2
  const base = { w: box.w, h: box.h, d: diag }
  // 先整段摘掉水印节点（<title>/<description> 及其文本内容）与注释 ——
  // 必须在属性改写之前做，否则只剩开始标签被摘掉、正文会漏出来。
  const stripped = svg
    .replace(/<title\b[^>]*>[\s\S]*?<\/title\s*>/gi, '')
    .replace(/<description\b[^>]*>[\s\S]*?<\/description\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
  // 逐个标签改写属性值
  const rewritten = stripped.replace(/<([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g, (all, tag, attrs, selfClose) => {
    const next = attrs.replace(/([\w:-]+)\s*=\s*"([^"]*)"/g, (whole, name, val) => {
      const kind = SVG_PCT_BASE.get(name.toLowerCase())
      if (!kind) return whole
      const pct = /^\s*([\d.+-]+)\s*%\s*$/.exec(val)
      if (!pct) return whole
      return `${name}="${num((Number(pct[1]) / 100) * base[kind])}"`
    })
    return `<${tag}${next}${selfClose}>`
  })

  // 内容整体平移，使 viewBox 从 0 0 起（导入侧就能把「元素框」1:1 映射到 viewBox）
  const inner = rewritten.replace(/^[\s\S]*?<svg\b[^>]*>/i, '').replace(/<\/svg\s*>\s*$/i, '')
  const shift = box.x || box.y ? ` transform="translate(${num(-box.x)},${num(-box.y)})"` : ''
  // 满 viewBox 的透明框架：让导入后 fabric 组的包围盒**严格等于 viewBox**
  // （否则包围盒只是图形内容的紧包围盒，而导出链路是按包围盒把整段 SVG 铺进去的，
  //  画布与 PDF 就会互相错位）。fill/stroke 皆 none，画布与导出都不产生任何可见像素。
  const frame = `<rect x="0" y="0" width="${num(box.w)}" height="${num(box.h)}" fill="none" stroke="none" stroke-width="0"/>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${num(box.w)} ${num(box.h)}" ` +
    `width="${num(box.w)}" height="${num(box.h)}"><g${shift}>${frame}${inner}</g></svg>`
  )
}

const isSvgText = (s) => /<svg[\s>]/i.test(s)

/** 图片/图标资源落盘（按内容 sha1 去重），返回文件名 */
const assetCache = new Map()
function saveAsset(dataUri) {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUri)
  if (!m) return null
  const mime = m[1]
  let buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8')
  if (mime.includes('svg')) buf = Buffer.from(normalizeAssetSvg(buf.toString('utf8')), 'utf8')
  const ext = mime.includes('svg') ? 'svg' : mime.includes('png') ? 'png' : mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : 'bin'
  const sha = createHash('sha1').update(buf).digest('hex').slice(0, 16)
  const name = `${sha}.${ext}`
  if (!assetCache.has(name)) {
    writeFileSync(join(ASSET_DIR, name), buf)
    assetCache.set(name, buf.length)
  }
  return name
}

/** 内嵌图标 SVG 字符串（原站 svgIconValue）→ 归一化后落盘为 .svg 文件 */
function saveSvgString(svg) {
  const buf = Buffer.from(normalizeAssetSvg(String(svg)), 'utf8')
  const sha = createHash('sha1').update(buf).digest('hex').slice(0, 16)
  const name = `${sha}.svg`
  if (!assetCache.has(name)) {
    writeFileSync(join(ASSET_DIR, name), buf)
    assetCache.set(name, buf.length)
  }
  return name
}

// ── 单个元素 → 节点 ───────────────────────────────────────────────
/**
 * 几何退化判定：这类节点在画布上完全不可见，但会被 fabric 当成真实对象参与
 * 包围盒/吸附/选中判定，等于往作品里塞隐形幽灵（实测原站设计稿里就有拖拽残留，
 * 例如 X6WY6 的 p4330482 是 x1=x2=1.2%、y1=y2=100% 的零长线，原站自己的
 * 预览 SVG 也照原样画了 `<line x1="1.2%" y1="100%" x2="1.2%" y2="100%">`）。
 * → 转换时直接丢弃，并计入 stats.degenerate 供报告核查。
 */
function isDegenerate(n) {
  switch (n.kind) {
    case 'line':
      return Math.abs(n.x1Mm - n.x2Mm) < 0.05 && Math.abs(n.y1Mm - n.y2Mm) < 0.05
    case 'rect':
      return !(n.wMm > 0.05) || !(n.hMm > 0.05)
    case 'ellipse':
      return !(n.rxMm > 0.05) || !(n.ryMm > 0.05)
    case 'image':
      return !(n.wMm > 0.05) || !(n.hMm > 0.05)
    case 'text':
      return !String(n.text || '').length
    default:
      return false
  }
}

function convertElement(el, W, H, s, stats) {
  const t = el.dataType
  const px = (v) => round((v / 100) * W)
  const py = (v) => round((v / 100) * H)
  const rot = Number(el.rotate) || 0
  const nodes = []

  switch (t) {
    case 'text': {
      const sy = Number(el.scaleY) || 1
      const sx = Number(el.scaleX) || 1
      const text = String(el.text ?? '')
      if (!text) { stats.emptyText++; return [] }
      const fsMm = fontMm(el.fontSize, s, sy)
      // 竖排（writingMode≠1）：用 90° 旋转近似；原站只有 20 个元素属于这类
      const vert = Number(el.writingMode) !== 1
      const xMm = px(el.x)
      const wMm = Math.max(1, Math.min(estTextWidthMm(text, fsMm), W - xMm))
      const deg = vert ? rot + 90 : rot
      nodes.push({
        kind: 'text',
        xMm,
        yMm: py(el.y),
        wMm: round(wMm),
        text,
        fontSizePt: round(mmToPt(fsMm), 2),
        bold: Number(el.fontWeight) === 1,
        align: 'left',
        color: normColor(el.color),
        rotateDeg: deg,
        letterSpacingPt: round(mmToPt(fontMm(el.letterSpacing, s, sx)), 2),
        italic: Number(el.fontStyle) === 1,
        underline: el.textDecoration === 'underline',
        // 只在有旋转时给 hMm：旋转要以「元素框中心」为轴（见 applyBoxRotation），
        // 无旋转的文本框不需要它，省得给 2200 个节点各加一个字段。
        ...(deg ? { hMm: round(fsMm * 1.16) } : {}),
      })
      if (vert) stats.verticalText++
      break
    }
    case 'textarea': {
      const sy = 1
      const fsMm = fontMm(el.fontSize, s, sy)
      const text = String(el.text ?? '')
      if (!text) { stats.emptyText++; return [] }
      const lh = Number(el.lineHeight)
      nodes.push({
        kind: 'text',
        xMm: px(el.x),
        yMm: py(el.y),
        wMm: Math.max(1, round(px(el.width))),
        text,
        fontSizePt: round(mmToPt(fsMm), 2),
        bold: Number(el.fontWeight) === 1,
        align: mapAnchor(el.textAnchor),
        color: normColor(el.color),
        rotateDeg: rot,
        letterSpacingPt: round(mmToPt(fontMm(el.letterSpacing, s, 1)), 2),
        italic: Number(el.fontStyle) === 1,
        underline: el.textDecoration === 'underline',
        multiline: true,
        // 原站 lineHeight 是倍数；>5 的当作百分比
        lineHeight: lh > 5 ? round(lh / 100, 2) : lh > 0 ? round(lh, 2) : 1.2,
        ...(rot ? { hMm: round(py(el.height)) } : {}),
      })
      break
    }
    case 'line': {
      nodes.push({
        kind: 'line',
        x1Mm: px(el.x1), y1Mm: py(el.y1), x2Mm: px(el.x2), y2Mm: py(el.y2),
        strokeMm: round(pctStrokeMm(el.lineWidth, W, H), 3),
        color: normColor(el.fillColor),
        dashed: Number(el.lineType) !== 0,
      })
      break
    }
    case 'rect': {
      const filled = Number(el.isTransparent) === 0
      nodes.push({
        kind: 'rect',
        xMm: px(el.x), yMm: py(el.y), wMm: px(el.width), hMm: py(el.height),
        filled,
        fillColor: normColor(el.fillColor),
        strokeMm: round(pctStrokeMm(el.borderWidth, W, H), 3),
        strokeColor: normColor(el.borderColor),
        radiusMm: round(pctStrokeMm(el.borderRadius, W, H), 3),
        rotateDeg: rot,
      })
      break
    }
    case 'circle': {
      const filled = Number(el.isTransparent) === 0
      nodes.push({
        kind: 'ellipse',
        cxMm: px(el.cx), cyMm: py(el.cy), rxMm: px(el.rx), ryMm: py(el.ry),
        filled,
        fillColor: normColor(el.fillColor),
        strokeMm: round(pctStrokeMm(el.borderWidth, W, H), 3),
        strokeColor: normColor(el.borderColor),
      })
      break
    }
    case 'svgicon': {
      const src = saveSvgString(el.svgIconValue)
      if (!src) { stats.badAsset++; break }
      nodes.push({
        kind: 'image',
        xMm: px(el.x), yMm: py(el.y), wMm: px(el.width), hMm: py(el.height),
        src, vector: true, rotateDeg: rot,
        keepAspect: Number(el.isAspectRatio) === 1,
      })
      stats.svgIcon++
      break
    }
    case 'image': {
      const src = saveAsset(el.image)
      if (!src) { stats.badAsset++; break }
      nodes.push({
        kind: 'image',
        xMm: px(el.x), yMm: py(el.y), wMm: px(el.width), hMm: py(el.height),
        src, vector: src.endsWith('.svg'), rotateDeg: rot,
        keepAspect: Number(el.isAspectRatio) === 1,
      })
      stats.image++
      break
    }
    case 'qrcode':
    case 'datamatrix':
    case 'pdf417': {
      const type = t === 'qrcode' ? 'qrcode'
        : t === 'pdf417' ? 'pdf417'
        : Number(el.isRectangle) === 1 ? 'datamatrixrectangular' : 'datamatrix'
      if (Number(el.isGS1FNC1Mode) === 1) stats.gs1Fnc1++
      nodes.push({
        kind: 'barcode',
        xMm: px(el.x), yMm: py(el.y), wMm: px(el.width), hMm: py(el.height),
        barcodeType: type,
        text: String(el.text ?? ''),
        fgColor: normColor(el.foreColor),
        bgColor: Number(el.isBgTransparent) === 1 ? undefined : normColor(el.bgColor, '#ffffff'),
        rotateDeg: rot,
        eccLevel: t === 'qrcode' ? mapEcc(el.correctLevel) : undefined,
      })
      stats.barcode2d++
      break
    }
    case 'barcode2':
    case 'barcode':
    case 'barcode3': {
      const fmt = mapFormat(el.format)
      const showText = t === 'barcode2' ? Number(el.displayValue) !== 0
        : t === 'barcode' ? true
        : Number(el.isFooterNote) !== 0
      nodes.push({
        kind: 'barcode',
        xMm: px(el.x), yMm: py(el.y), wMm: px(el.width), hMm: py(el.height),
        barcodeType: fmt,
        text: String(el.text ?? ''),
        showText,
        fgColor: normColor(el.lineColor ?? el.color),
        bgColor: Number(el.isTransparentBG ?? el.isBgTransparent) === 1
          ? undefined
          : normColor(el.background, '#ffffff'),
        rotateDeg: rot,
      })
      stats.barcode1d++
      break
    }
    case 'udi': {
      // 全站仅 1 个 UDI 元素（AVFC1）。原站把它展开成「DataMatrix + 5 组 AI 文本」，
      // 布局直接取自该模板的预览 SVG（已验证），字号按 30 api 单位反算。
      const digits = String(el.deviceIdentifier || '')
      const dm = `(01)${digits}(11)${el.productionDate || ''}(17)${el.expirationDate || ''}(10)${el.batchNumber || ''}(21)${el.serialNumber || ''}`
      nodes.push({
        kind: 'barcode',
        xMm: px(el.x), yMm: py(el.y), wMm: px(el.width), hMm: py(el.height),
        barcodeType: Number(el.isRectangle) === 1 ? 'datamatrixrectangular' : 'datamatrix',
        text: dm,
        fgColor: normColor(el.foreColor),
        bgColor: undefined,
        rotateDeg: rot,
      })
      const rows = [
        ['(01)', digits],
        ['(11)', String(el.productionDate || '')],
        ['(17)', String(el.expirationDate || '')],
        ['(10)', String(el.batchNumber || '')],
        ['(21)', String(el.serialNumber || '')],
      ].filter(([, val]) => val) // 原站有些 AI 值是空的；留下「标签在、内容空」的空文本框没有意义
      const fsPt = round(mmToPt(fontMm(30, s, 1)), 2)
      rows.forEach(([ai, val], i) => {
        const yPct = [6.4, 25.35, 44.23, 63.4, 82.22][i]
        nodes.push({
          kind: 'text', xMm: round(44.9 / 100 * W), yMm: round(yPct / 100 * H),
          wMm: round(10.5 / 100 * W), text: ai, fontSizePt: fsPt, bold: true,
          align: 'left', color: normColor(el.foreColor),
        })
        nodes.push({
          kind: 'text', xMm: round(56.31 / 100 * W), yMm: round(yPct / 100 * H),
          wMm: round(42 / 100 * W), text: val, fontSizePt: fsPt, bold: true,
          align: 'left', color: normColor(el.foreColor),
        })
      })
      stats.udi++
      break
    }
    case 'page':
      break
    default:
      stats.unknown[t] = (stats.unknown[t] || 0) + 1
  }
  return nodes
}

// ── 主流程 ────────────────────────────────────────────────────────
function main() {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  if (existsSync(ASSET_DIR)) rmSync(ASSET_DIR, { recursive: true, force: true })
  mkdirSync(ASSET_DIR, { recursive: true })

  const stats = { templates: 0, missing: [], nodes: 0, emptyText: 0, verticalText: 0,
    unknown: {}, badAsset: 0, svgIcon: 0, image: 0, barcode1d: 0, barcode2d: 0, udi: 0,
    gs1Fnc1: 0, pageBorder: 0, overflow: 0, degenerate: 0, bgFill: 0, kinds: {} }
  const templates = []
  const byId = new Map(manifest.items.map((it) => [it.id, it]))

  for (const it of manifest.items) {
    const p = join(API_DIR, it.id + '.json')
    if (!existsSync(p)) { stats.missing.push(it.id); continue }
    const raw = JSON.parse(readFileSync(p, 'utf8'))
    const page = raw.itemList.find((e) => e.dataType === 'page')
    if (!page) { stats.missing.push(it.id); continue }
    const W = Number(page.pageWidth)
    const H = Number(page.pageHeight)
    const s = previewScale(W, H)

    const nodes = []
    for (const el of raw.itemList) {
      if (el === page) continue
      const out = convertElement(el, W, H, s, stats)
      if (process.env.DEBUG_TPL === it.id) {
        console.error(`  [dbg] id=${el.id} dataType=${el.dataType} type=${el.type} → ${out.length} 节点 ${out.map((n) => n.kind).join(',')}`)
      }
      for (const n of out) {
        if (isDegenerate(n)) {
          stats.degenerate++
          if (process.env.DEBUG_TPL === it.id) console.error(`  [dbg] 丢弃退化节点 ${n.kind} ${JSON.stringify(n).slice(0, 120)}`)
          continue
        }
        n._src = el.id            // 仅用于校验配对，写盘前剔除
        n._srcType = el.dataType
        nodes.push(n)
        stats.nodes++
        stats.kinds[n.kind] = (stats.kinds[n.kind] || 0) + 1
        if (n.kind === 'text' && n.xMm + n.wMm > W + 0.01) stats.overflow++
      }
    }
    // 页面边框（borderWidth>0 时补一个描边框）
    // ⚠️ 这个节点在元素循环之外生成，必须自己补统计 —— 曾经漏掉统计计数，
    // 于是「自报节点数」比磁盘产物少 69（= 带边框的模板数），排查时极易误判成丢数据。
    if (Number(page.borderWidth) > 0) {
      stats.pageBorder++
      const border = {
        kind: 'rect', xMm: 0, yMm: 0, wMm: W, hMm: H, filled: false,
        strokeMm: round(pctStrokeMm(page.borderWidth, W, H), 3),
        strokeColor: normColor(page.borderColor),
      }
      nodes.unshift(border)
      stats.nodes++
      stats.kinds.rect = (stats.kinds.rect || 0) + 1
    }

    // 非白纸张底色：**不插背景矩形节点**，而是保留在模板的 `bg` 字段上，
    // 由前端 buildY56ySpec → TemplateSpec.bgColor → 纸张属性承载。
    // 走纸张属性的好处：不占图层、用户改底色只需动「纸张设置」，
    // 而且导出时由 PDF/PNG 链路按纸张铺底 —— 与手动设色的标签行为完全一致。
    const pageBg = normColor(page.backgroundColor, '#ffffff')
    if (pageBg !== '#ffffff') stats.bgFill++

    templates.push({
      id: it.id,
      name: it.name,
      size: `${W}×${H}mm`,
      catId: byId.get(it.id)?.typeid ?? null,
      widthMm: W,
      heightMm: H,
      bg: normColor(page.backgroundColor, '#ffffff'),
      nodes,
    })
    stats.templates++
  }

  // ⚠️ manifest.types 的字段名是 `id`（不是 items 上的 `typeid`）——
  // 早期写成 t.typeid 时 id 全是 undefined，被 JSON.stringify 直接丢掉，
  // 结果前端分类筛选条的计数全为 0、模板的 catName 全退化成「其他」。
  const typeNames = new Map(manifest.types.map((t) => [t.id, t.name]))
  // 校验用的「原始元素 id → 换算结果」索引（写盘前先把 _src 剔掉）
  const verifyIndex = new Map()
  for (const t of templates) {
    for (const n of t.nodes) {
      if (n._src) {
        const k = t.id + '|' + n._src
        if (!verifyIndex.has(k)) verifyIndex.set(k, [])
        verifyIndex.get(k).push({ tpl: t, node: n })
      }
      delete n._src
      delete n._srcType
    }
  }

  const out = {
    version: 1,
    source: 'https://y56y.com/labeltemplate',
    sourceNote: '模板几何数据取自 y56y.com 的公开标签模板（多零标签）。页面坐标为其站点公开接口的百分比口径，' +
      '由 scripts/y56y/convert.mjs 换算为 mm/pt。仅供本编辑器作为版式参考，模板内容与商标归原站所有。',
    convertedAt: new Date().toISOString(),
    categories: manifest.types.map((t) => ({
      id: t.id,
      name: t.name,
      group: t.group,
      groupName: t.groupName,
    })),
    typeNames: Object.fromEntries(typeNames),
    templates: templates.map((t) => ({ ...t, catName: typeNames.get(t.catId) ?? '其他' })),
  }
  writeFileSync(join(OUT_DIR, 'y56y-index.json'), JSON.stringify(out), 'utf8')
  const size = readFileSync(join(OUT_DIR, 'y56y-index.json')).length

  let assetBytes = 0
  for (const [name, len] of assetCache) assetBytes += len
  console.log(`模板 ${stats.templates} 个，节点 ${stats.nodes} 个`)
  console.log('节点类型:', stats.kinds)
  console.log(`索引 ${(size / 1024).toFixed(0)} KB，资源 ${assetCache.size} 个 / ${(assetBytes / 1024).toFixed(0)} KB`)
  console.log(`空文字跳过 ${stats.emptyText}，越界文字 ${stats.overflow}，竖排近似 ${stats.verticalText}`)
  console.log(`退化元素丢弃 ${stats.degenerate}（零长线/零面积框，原站设计稿残留）`)
  console.log(`非白底模板 ${stats.bgFill} 个（底色走纸张属性） / 页面边框 ${stats.pageBorder} 个`)
  console.log('条码：一维', stats.barcode1d, '/ 二维码矩阵', stats.barcode2d, '/ UDI', stats.udi)
  if (Object.keys(stats.unknown).length) console.log('未识别类型:', stats.unknown)
  if (stats.missing.length) console.log('缺失模板:', stats.missing)
  if (stats.badAsset) console.log('资源解析失败:', stats.badAsset)

  if (VERIFY) verifyAgainstPreview(verifyIndex)

  // ── 产物完整性自检（写入索引之前就该挡住的低级错，全部在这里收口） ──
  // 起因：categories 的 id 曾写成 manifest.types 上不存在的 `typeid`，
  // JSON.stringify 把 undefined 直接丢掉 → 前端分类计数全 0、catName 全「其他」，
  // 而构建与类型检查都不会报错。这类「字段名错配」只能靠产物自检发现。
  const problems = []
  const catIds = new Set(out.categories.map((c) => c.id))
  if (catIds.has(undefined)) problems.push('categories 有 id 缺失')
  if (out.categories.length !== manifest.types.length) problems.push('categories 数量与清单不符')
  const orphan = out.templates.filter((t) => t.catId == null || !catIds.has(t.catId))
  if (orphan.length) problems.push(`${orphan.length} 个模板的 catId 找不到对应分类`)
  const unnamed = out.templates.filter((t) => !t.catName || t.catName === '其他')
  if (unnamed.length) problems.push(`${unnamed.length} 个模板没解析出分类名`)
  const noNode = out.templates.filter((t) => !t.nodes.length)
  if (noNode.length) problems.push(`${noNode.length} 个模板没有任何节点`)
  const emptyAsset = out.templates
    .flatMap((t) => t.nodes)
    .filter((n) => n.kind === 'image' && !n.src)
  if (emptyAsset.length) problems.push(`${emptyAsset.length} 个 image 节点缺 src`)
  // 自报统计 vs 写盘产物必须逐项一致。
  // 起因：页面边框节点在元素循环外生成、漏了统计计数，于是「自报节点数」比磁盘少 69，
  // 排查时被误读成「有 69 个元素被静默丢弃」。统计漂移比数据漂移更难发现，必须钉死。
  const disk = JSON.parse(readFileSync(join(OUT_DIR, 'y56y-index.json'), 'utf8'))
  const diskNodes = disk.templates.flatMap((t) => t.nodes)
  if (diskNodes.length !== stats.nodes) {
    problems.push(`节点数不自洽：自报 ${stats.nodes} vs 写盘 ${diskNodes.length}`)
  }
  const diskKinds = {}
  for (const n of diskNodes) diskKinds[n.kind] = (diskKinds[n.kind] || 0) + 1
  for (const [k, v] of Object.entries(diskKinds)) {
    if ((stats.kinds[k] || 0) !== v) problems.push(`节点类型 ${k} 不自洽：自报 ${stats.kinds[k] || 0} vs 写盘 ${v}`)
  }

  if (problems.length) {
    console.error('❌ 产物自检未通过：')
    for (const p of problems) console.error('   · ' + p)
    process.exitCode = 1
  } else {
    const byCat = new Map()
    for (const t of out.templates) byCat.set(t.catName, (byCat.get(t.catName) ?? 0) + 1)
    console.log(`自检通过：${out.categories.length} 个分类 / ${out.templates.length} 个模板，分类分布：` +
      [...byCat].map(([k, v]) => `${k} ${v}`).join('、'))
  }

  writeFileSync(join(ROOT, '.tmp/y56y/convert-report.json'),
    JSON.stringify({ stats, assetCount: assetCache.size, assetBytes, indexBytes: size }, null, 2), 'utf8')
}

/**
 * 交叉校验：把「转换后的 mm」还原成预览 SVG 的口径，与站点自己的预览 SVG **按元素 id 逐条比对**。
 * 这是整套换算的硬证据 —— 覆盖文字（位置 + 字号，注意预览里字号还要乘 transform 的 scaleY）、
 * 线条、矩形、椭圆、嵌套条码框、描边宽度五类。
 */
function verifyAgainstPreview(verifyIndex) {
  if (!existsSync(PREVIEW_DIR)) { console.log('（无预览 SVG，跳过校验）'); return }
  let checked = 0
  const bad = { x: 0, y: 0, fs: 0, w: 0, h: 0, stroke: 0 }
  const samples = []
  const note = (k, msg) => { bad[k]++; if (samples.length < 14) samples.push(msg) }

  const tplIds = new Set([...verifyIndex.keys()].map((k) => k.split('|')[0]))
  for (const tid of tplIds) {
    const p = join(PREVIEW_DIR, tid + '.svg')
    if (!existsSync(p)) continue
    const svg = readFileSync(p, 'utf8')
    const head = svg.slice(svg.indexOf('<svg'), svg.indexOf('>') + 1)
    const vb = /viewBox="[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)"/.exec(head)
    if (!vb) continue
    const vw = Number(vb[1])

    // 预览里的元素按 id 建索引
    const prev = new Map()
    const attr = (tag) => {
      const o = {}
      for (const m of tag.matchAll(/([\w:-]+)="([^"]*)"/g)) o[m[1]] = m[2]
      return o
    }
    for (const m of svg.matchAll(/<(text|line|rect|ellipse|svg|image)\b[^>]*>/g)) {
      const tag = m[0]
      if (tag.includes('background1')) continue
      const a = attr(tag)
      if (!a.id) continue
      const rec = prev.get(a.id) || {}
      const kind = m[1]
      if (kind === 'text') {
        const tr = /scale\(\s*([-\d.]+)\s*[, ]\s*([-\d.]+)\s*\)/.exec(a.transform || '')
        const ty = tr ? Number(tr[2]) : 1
        rec.text = { x: parseFloat(a.x), y: parseFloat(a.y), fsPx: parseFloat(a['font-size']) * ty }
      } else if (kind === 'line') {
        rec.line = { x1: parseFloat(a.x1), y1: parseFloat(a.y1), x2: parseFloat(a.x2), y2: parseFloat(a.y2), sw: parseFloat(a['stroke-width']) }
      } else if (kind === 'rect') {
        rec.rect = { x: parseFloat(a.x), y: parseFloat(a.y), w: parseFloat(a.width), h: parseFloat(a.height), sw: parseFloat(a['stroke-width']) }
      } else if (kind === 'ellipse') {
        rec.ell = { cx: parseFloat(a.cx), cy: parseFloat(a.cy), rx: parseFloat(a.rx), ry: parseFloat(a.ry) }
      } else if (kind === 'svg' && a.datatype) {
        rec.box = { x: parseFloat(a.x), y: parseFloat(a.y), w: parseFloat(a.width), h: parseFloat(a.height) }
      }
      prev.set(a.id, rec)
    }

    for (const [key, arr] of verifyIndex) {
      if (!key.startsWith(tid + '|')) continue
      const elId = key.split('|')[1]
      const r = prev.get(elId)
      if (!r) continue
      const { tpl, node } = arr[0]
      const W = tpl.widthMm, H = tpl.heightMm
      const diag = Math.sqrt(W * W + H * H) / Math.SQRT2
      const pct = (mm, tot) => (mm / tot) * 100
      const near = (a, b, tol) => Math.abs(a - b) <= tol

      if (node.kind === 'text' && (r.text || r.rect)) {
        checked++
        // textarea 的 id 挂在包框 rect 上，位置口径相同
        const px = r.text ? r.text.x : r.rect.x
        const py = r.text ? r.text.y : r.rect.y
        if (!near(pct(node.xMm, W), px, 0.35)) note('x', `${tid} ${elId} text x 预览 ${px}% vs 我们 ${pct(node.xMm, W).toFixed(2)}%`)
        if (!near(pct(node.yMm, H), py, 0.35)) note('y', `${tid} ${elId} text y 预览 ${py}% vs 我们 ${pct(node.yMm, H).toFixed(2)}%`)
        if (r.text) {
          const fsPct = (r.text.fsPx / vw) * 100
          const mine = pct(node.fontSizePt / 0.75 / 96 * 25.4, W)
          if (!near(mine, fsPct, Math.max(0.06, fsPct * 0.02))) note('fs', `${tid} ${elId} 字号 预览 ${fsPct.toFixed(2)}% vs 我们 ${mine.toFixed(2)}%`)
        }
        if (node.multiline && r.rect) {
          if (!near(pct(node.wMm, W), r.rect.w, 0.4)) note('w', `${tid} ${elId} 文本框宽 预览 ${r.rect.w}% vs 我们 ${pct(node.wMm, W).toFixed(2)}%`)
        }
      } else if (node.kind === 'line' && r.line) {
        checked++
        if (!near(pct(node.x1Mm, W), r.line.x1, 0.2) || !near(pct(node.y1Mm, H), r.line.y1, 0.2) ||
            !near(pct(node.x2Mm, W), r.line.x2, 0.2) || !near(pct(node.y2Mm, H), r.line.y2, 0.2)) {
          note('x', `${tid} ${elId} line 端点不一致 预览(${r.line.x1},${r.line.y1})-(${r.line.x2},${r.line.y2}) vs 我们(${pct(node.x1Mm, W).toFixed(2)},${pct(node.y1Mm, H).toFixed(2)})-(${pct(node.x2Mm, W).toFixed(2)},${pct(node.y2Mm, H).toFixed(2)})`)
        }
      } else if (node.kind === 'rect' && r.rect) {
        checked++
        if (!near(pct(node.xMm, W), r.rect.x, 0.2) || !near(pct(node.yMm, H), r.rect.y, 0.2) ||
            !near(pct(node.wMm, W), r.rect.w, 0.25) || !near(pct(node.hMm, H), r.rect.h, 0.25)) {
          note('w', `${tid} ${elId} rect 不一致 预览(${r.rect.x},${r.rect.y},${r.rect.w},${r.rect.h}) vs 我们(${pct(node.xMm, W).toFixed(2)},${pct(node.yMm, H).toFixed(2)},${pct(node.wMm, W).toFixed(2)},${pct(node.hMm, H).toFixed(2)})`)
        }
        if (r.rect.sw && node.strokeMm) {
          const want = (r.rect.sw / 100) * diag
          if (!near(node.strokeMm, want, Math.max(0.02, want * 0.06))) note('stroke', `${tid} ${elId} 描边 预览 ${want.toFixed(3)}mm vs 我们 ${node.strokeMm}mm`)
        }
      } else if (node.kind === 'ellipse' && r.ell) {
        checked++
        if (!near(pct(node.cxMm, W), r.ell.cx, 0.2) || !near(pct(node.cyMm, H), r.ell.cy, 0.2) ||
            !near(pct(node.rxMm, W), r.ell.rx, 0.2) || !near(pct(node.ryMm, H), r.ell.ry, 0.2)) {
          note('w', `${tid} ${elId} ellipse 不一致`)
        }
      } else if (node.kind === 'barcode' && r.box) {
        checked++
        if (!near(pct(node.xMm, W), r.box.x, 0.3) || !near(pct(node.yMm, H), r.box.y, 0.3) ||
            !near(pct(node.wMm, W), r.box.w, 0.4) || !near(pct(node.hMm, H), r.box.h, 0.4)) {
          note('w', `${tid} ${elId} 条码框 预览(${r.box.x},${r.box.y},${r.box.w},${r.box.h}) vs 我们(${pct(node.xMm, W).toFixed(2)},${pct(node.yMm, H).toFixed(2)},${pct(node.wMm, W).toFixed(2)},${pct(node.hMm, H).toFixed(2)})`)
        }
      } else if (node.kind === 'image' && r.box) {
        checked++
        if (!near(pct(node.xMm, W), r.box.x, 0.3) || !near(pct(node.yMm, H), r.box.y, 0.3)) {
          note('x', `${tid} ${elId} 图标位置 预览(${r.box.x},${r.box.y}) vs 我们(${pct(node.xMm, W).toFixed(2)},${pct(node.yMm, H).toFixed(2)})`)
        }
      }
    }
  }
  const pctOf = (v) => ((v / Math.max(1, checked)) * 100).toFixed(2) + '%'
  console.log(`\n预览 SVG 逐元素校验：比对 ${checked} 项`)
  console.log(`  x 偏差 ${bad.x} (${pctOf(bad.x)}) · y 偏差 ${bad.y} (${pctOf(bad.y)}) · 字号偏差 ${bad.fs} (${pctOf(bad.fs)}) · 宽高偏差 ${bad.w} (${pctOf(bad.w)}) · 描边偏差 ${bad.stroke} (${pctOf(bad.stroke)})`)
  for (const s of samples) console.log('   · ' + s)
}

main()
