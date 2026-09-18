/**
 * 从竞品站 ktm.xp06.com 拉取图标库文件到本地（用于一次性搬运分析）。
 *
 * 用法：node scripts/ktm-fetch-icons.mjs <items.json> <outDir> [concurrency]
 * items.json 形如 [{name, image, tags}]，image 为站内路径（含中文，需 encodeURI）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = 'https://ktm.xp06.com'
const itemsPath = process.argv[2]
const outDir = process.argv[3]
const CONC = Number(process.argv[4] || 8)

const items = JSON.parse(fs.readFileSync(itemsPath, 'utf8'))
fs.mkdirSync(outDir, { recursive: true })

/** 把站内路径映射为安全的本地文件名： 分类__文件名 */
function localName(image) {
  const parts = image.split('/').filter(Boolean) // ['icons', 分类, 文件]
  const cat = (parts[1] || '_').replace(/[/\\:]/g, '_')
  const file = parts.slice(2).join('_').replace(/[/\\:]/g, '_')
  return `${cat}__${file}`
}

const result = { ok: 0, fail: 0, bytes: 0, failed: [], byExt: {} }
let idx = 0

async function worker() {
  while (idx < items.length) {
    const i = idx++
    const it = items[i]
    const url = BASE + encodeURI(it.image)
    const dest = path.join(outDir, localName(it.image))
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(30000) })
      if (!r.ok) { result.fail++; result.failed.push(`${r.status} ${it.image}`); continue }
      const buf = Buffer.from(await r.arrayBuffer())
      fs.writeFileSync(dest, buf)
      result.ok++
      result.bytes += buf.length
      const ext = path.extname(it.image).slice(1).toLowerCase() || '?'
      result.byExt[ext] = (result.byExt[ext] || 0) + 1
    } catch (e) {
      result.fail++
      result.failed.push(`${e.message} ${it.image}`)
    }
  }
}

const t0 = Date.now()
await Promise.all(Array.from({ length: CONC }, worker))
console.log(`完成 ${result.ok} / 失败 ${result.fail}，共 ${(result.bytes / 1048576).toFixed(1)}MB，耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`)
console.log('按扩展名:', JSON.stringify(result.byExt))
if (result.failed.length) {
  console.log('失败样例(前 20):')
  console.log(result.failed.slice(0, 20).join('\n'))
  fs.writeFileSync(path.join(outDir, '_failed.txt'), result.failed.join('\n'))
}
