/**
 * 生成 Lucide 图标素材库（本地打包，零运行时网络依赖）。
 *
 * 数据来源：已安装的 `lucide-react`（dist/esm/icons/*.js），每个图标文件导出
 * `__iconNode`，即 [tag, attrs][] 形式的原始几何。本脚本将其序列化为可直接
 * 喂给 fabric.loadSVGFromString 的 SVG 片段，输出 src/assets/icons-lucide.json。
 *
 * 许可：Lucide 采用 ISC 许可（宽松，允许商用+再分发），署名信息随产物一并写入。
 *
 * 用法： node scripts/gen-lucide.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const ICON_DIR = path.join(ROOT, 'node_modules/lucide-react/dist/esm/icons')
const OUT_DIR = path.join(ROOT, 'public/assets')
const OUT_FILE = path.join(OUT_DIR, 'icons-lucide.json')

/** Lucide 标准画布：24x24，线性风格（stroke），圆头圆角 */
const VIEWBOX = '0 0 24 24'

function main() {
  if (!fs.existsSync(ICON_DIR)) {
    console.error('[gen-lucide] 未找到 lucide-react 图标目录：', ICON_DIR)
    process.exit(1)
  }

  const files = fs.readdirSync(ICON_DIR).filter((f) => f.endsWith('.js') && !f.endsWith('.map'))
  const icons = []
  const aliases = {}
  const pendingAliases = []
  const skipped = []

  for (const file of files) {
    const name = path.basename(file, '.js')
    const src = fs.readFileSync(path.join(ICON_DIR, file), 'utf8')

    // 废弃别名文件：export { default } from './xxx.js' —— 记录别名，稍后指向目标图标
    const aliasTo = extractReExport(src)
    if (aliasTo) {
      pendingAliases.push([name, aliasTo])
      continue
    }

    const nodes = extractIconNode(src)
    if (!nodes || !Array.isArray(nodes) || nodes.length === 0) {
      skipped.push(name)
      continue
    }
    const inner = nodes.map(serializeNode).filter(Boolean).join('')
    if (!inner) {
      skipped.push(name)
      continue
    }
    icons.push([name, inner])
  }

  icons.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))

  // 解析别名链（可能多级转发），仅保留能落到真实图标的别名
  const byName = new Map(icons.map(([n, s]) => [n, s]))
  const resolve = (target, depth = 0) => {
    if (depth > 5) return null
    if (byName.has(target)) return target
    const next = pendingAliases.find(([n]) => n === target)
    return next ? resolve(next[1], depth + 1) : null
  }
  for (const [name, target] of pendingAliases) {
    const real = resolve(target)
    if (real) aliases[name] = real
    else skipped.push(name)
  }

  const version = readLucideVersion()
  const payload = {
    meta: {
      source: 'Lucide',
      homepage: 'https://lucide.dev',
      license: 'ISC',
      licenseUrl: 'https://opensource.org/licenses/ISC',
      version,
      viewBox: VIEWBOX,
      count: icons.length,
      aliasCount: Object.keys(aliases).length,
      generatedAt: new Date().toISOString().slice(0, 10),
    },
    // [名称(kebab), SVG 内部片段]；外层 svg 属性由运行时按配色拼装，便于改色
    icons,
    // { 废弃别名: 现行图标名 }，提升搜索命中率
    aliases,
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload), 'utf8')

  const kb = (fs.statSync(OUT_FILE).size / 1024).toFixed(1)
  console.log(
    `[gen-lucide] 已生成 ${icons.length} 个图标 + ${Object.keys(aliases).length} 个别名 → ${path.relative(ROOT, OUT_FILE)} (${kb} KB)`,
  )
  if (skipped.length) console.log(`[gen-lucide] 跳过 ${skipped.length} 个：${skipped.slice(0, 10).join(', ')}`)
}

/** 从图标模块源码中安全提取 __iconNode 数组字面量 */
function extractIconNode(src) {
  const m = src.match(/const\s+__iconNode\s*=\s*(\[[\s\S]*?\]);/)
  if (!m) return null
  try {
    // 源码来自受信任的本地依赖；用 Function 求值是解析 JS 字面量最稳妥的方式
    // eslint-disable-next-line no-new-func
    return new Function(`return ${m[1]}`)()
  } catch {
    return null
  }
}

/** 从别名文件中提取转发目标：explicit-default re-export */
function extractReExport(src) {
  const m = src.match(/export\s*\{\s*default\s*\}\s*from\s*['"]\.\/([\w-]+)\.js['"]/)
  return m ? m[1] : null
}

/** 把 [tag, attrs] 序列化为 SVG 元素字符串（丢弃 React 专用的 key 字段） */
function serializeNode(node) {
  if (!Array.isArray(node) || node.length < 2) return ''
  const [tag, attrs] = node
  if (typeof tag !== 'string' || !attrs || typeof attrs !== 'object') return ''
  const parts = []
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'key') continue
    if (v === undefined || v === null) continue
    parts.push(`${kebabAttr(k)}="${escapeAttr(String(v))}"`)
  }
  return `<${tag}${parts.length ? ' ' + parts.join(' ') : ''}/>`
}

const CAMEL_OVERRIDE = {
  strokeWidth: 'stroke-width',
  strokeLinecap: 'stroke-linecap',
  strokeLinejoin: 'stroke-linejoin',
  strokeDasharray: 'stroke-dasharray',
  fillOpacity: 'fill-opacity',
  strokeOpacity: 'stroke-opacity',
  fillRule: 'fill-rule',
  clipRule: 'clip-rule',
}

function kebabAttr(k) {
  if (CAMEL_OVERRIDE[k]) return CAMEL_OVERRIDE[k]
  return k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())
}

function escapeAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function readLucideVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/lucide-react/package.json'), 'utf8'))
    return pkg.version ?? ''
  } catch {
    return ''
  }
}

main()
