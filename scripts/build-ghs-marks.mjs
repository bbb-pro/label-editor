/**
 * 生成 public/assets/marks-ghs.json —— UN GHS 九类危险品象形图。
 *
 * 为什么单独抽成构建产物、而不内联进 TS：
 *   九张图合计约 40KB 矢量路径，内联会把它们压进 App 懒加载分包；
 *   放 public/assets 走运行时 fetch，与 lucide / twemoji 同一套做法。
 *
 * 来源（可复现）：
 *   npm 包 @ghs-hazard-pictograms/sprite v1.1.0（MIT）
 *   https://registry.npmjs.org/@ghs-hazard-pictograms/sprite/-/sprite-1.1.0.tgz
 *   其中的 SVG 图形即 UN GHS 标准象形图（红框菱形 + 白色底 + 黑色符号），
 *   图形本身由联合国 GHS 标准规定，属公有领域。
 *
 * 用法：node scripts/build-ghs-marks.mjs      （需要网络；结果落盘后即可离线使用）
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const SPRITE_PKG = '@ghs-hazard-pictograms/sprite'
const SPRITE_VER = '1.1.0'
/** npm 上 scoped 包的 tarball 地址形如 .../@scope/name/-/name-1.0.0.tgz */
const SPRITE_URL = `https://registry.npmjs.org/${SPRITE_PKG}/-/${SPRITE_PKG.split('/')[1]}-${SPRITE_VER}.tgz`

/** symbol id 片段 → [id, 中文名, 检索词]；顺序即 UN GHS 的类别顺序 */
const WANTED = [
  ['ghs01-explosive', 'ghs01', '爆炸物', '易爆 爆炸 explosive 烟花 爆竹 雷管 弹药'],
  ['ghs02-flammable', 'ghs02', '易燃', '易燃 可燃 flammable 火 火焰 酒精 气体'],
  ['ghs03-oxidizing', 'ghs03', '氧化剂', '氧化 助燃 oxidizing 过氧化物 强氧化'],
  ['ghs04-compressedgas', 'ghs04', '高压气体', '压缩气体 气瓶 compressed gas 液化 高压'],
  ['ghs05-corrosive', 'ghs05', '腐蚀性', '腐蚀 corrosive 酸碱 灼伤 金属 皮肤'],
  ['ghs06-toxic', 'ghs06', '剧毒', '剧毒 有毒 toxic 骷髅 致死 吞咽'],
  ['ghs07-healthhazard', 'ghs07', '有害刺激', '有害 刺激 注意 感叹号 irritant 臭氧层'],
  ['ghs08-serioushealthhazard', 'ghs08', '健康危害', '致癌 致敏 呼吸道 器官 serious health hazard'],
  ['ghs09-hazardoustotheenvironment', 'ghs09', '环境危害', '水生生物 污染 环境 environment 鱼类'],
]

// ── 极简 tar 读取（npm tarball 是 gzip + ustar，无需引入依赖）──
function untar(buf) {
  const files = new Map()
  let off = 0
  while (off + 512 <= buf.length) {
    const name = buf.subarray(off, off + 100).toString('utf8').replace(/\0.*$/, '')
    if (!name) break
    const size = parseInt(buf.subarray(off + 124, off + 136).toString('utf8').replace(/\0.*$/, '').trim() || '0', 8)
    const type = buf.subarray(off + 156, off + 157).toString('utf8')
    const prefix = buf.subarray(off + 345, off + 500).toString('utf8').replace(/\0.*$/, '')
    const full = prefix ? `${prefix}/${name}` : name
    const start = off + 512
    if (type === '0' || type === '\0' || type === '') files.set(full, buf.subarray(start, start + size))
    off = start + Math.ceil(size / 512) * 512
  }
  return files
}

/** 从 sprite.svg 里取出每个 <symbol> 的 viewBox 与内部片段 */
function parseSprite(svg) {
  const out = new Map()
  const re = /<symbol id="([^"]+)"[^>]*viewBox="([^"]+)"[^>]*>([\s\S]*?)<\/symbol>/g
  let m
  while ((m = re.exec(svg))) out.set(m[1], { viewBox: m[2], inner: m[3].trim() })
  return out
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

  console.log(`下载 ${SPRITE_PKG}@${SPRITE_VER} …`)
  const res = await fetch(SPRITE_URL)
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`)
  const tgz = Buffer.from(await res.arrayBuffer())
  const files = untar(zlib.gunzipSync(tgz))
  const spriteFile = [...files.keys()].find((k) => k.endsWith('/sprite.svg'))
  if (!spriteFile) throw new Error('压缩包里没找到 sprite.svg')
  const symbols = parseSprite(files.get(spriteFile).toString('utf8'))
  console.log(`sprite 共 ${symbols.size} 个 symbol`)

  const marks = []
  for (const [needle, id, name, kw] of WANTED) {
    // 同一张图可能在 sprite 里出现多次（物理危害 / 物理与健康危害分组），取第一个
    const key = [...symbols.keys()].find((k) => k.includes(needle))
    if (!key) throw new Error(`缺少 ${id}（未匹配到 "${needle}"）`)
    const { viewBox, inner } = symbols.get(key)
    marks.push([id, name, kw, viewBox, inner])
    console.log(`  ${id}  ${name.padEnd(6)} vb=${viewBox.padEnd(20)} ${(inner.length / 1024).toFixed(1)}KB`)
  }

  const out = {
    meta: {
      source: `${SPRITE_PKG}@${SPRITE_VER}`,
      license: 'MIT（npm 包） / 图形为 UN GHS 标准象形图',
      url: 'https://www.npmjs.com/package/@ghs-hazard-pictograms/sprite',
      note: '由 scripts/build-ghs-marks.mjs 生成，勿手改',
    },
    marks,
  }

  const dest = path.join(root, 'public', 'assets', 'marks-ghs.json')
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, JSON.stringify(out))
  console.log(`\n已写入 ${path.relative(root, dest)}  (${(fs.statSync(dest).size / 1024).toFixed(1)}KB)`)
}

main().catch((e) => {
  console.error('生成失败：' + (e instanceof Error ? e.message : String(e)))
  process.exit(1)
})
