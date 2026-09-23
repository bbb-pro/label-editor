// 下载 y56y 的模板预览 SVG 并校验「预览比例」规则
//
// 预览 SVG 的 viewBox 宽度 = 页面宽(mm) × s。实测 s = min(20, 800/页宽, 600/页高)，
// 本脚本对全部模板逐一验证该式（≥99% 命中即认为规则成立），并把 viewBox 落盘供
// 转换器做交叉校验（文字/线条在 SVG 里的实际数值 vs 我们换算出的 mm）。
//
// 用法：node scripts/y56y/fetch-preview.mjs [--delay 800]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dir, '../..')
const OUT_DIR = join(ROOT, '.tmp/y56y/preview')
const MANIFEST = join(ROOT, '.tmp/y56y/manifest.json')

const argv = process.argv.slice(2)
const argOf = (k) => (argv.indexOf(k) >= 0 ? argv[argv.indexOf(k) + 1] : null)
const DELAY = Number(argOf('--delay') || 800)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const scaleRule = (w, h) => Math.min(20, 800 / w, 600 / h)

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  const todo = manifest.items.filter((it) => !existsSync(join(OUT_DIR, it.id + '.svg')))
  console.log(`待下载 ${todo.length} 个预览（间隔 ${DELAY}ms）`)

  let ok = 0
  const failures = []
  for (const it of todo) {
    let done = false
    for (let attempt = 0; attempt < 4 && !done; attempt++) {
      try {
        const res = await fetch(`https://y56y.com/labeltemplate/image/${it.id}.svg`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36' },
        })
        const text = await res.text()
        if (!res.ok || !text.startsWith('<svg')) throw new Error(`HTTP ${res.status}`)
        writeFileSync(join(OUT_DIR, it.id + '.svg'), text, 'utf8')
        ok++
        done = true
      } catch (e) {
        if (attempt === 3) { failures.push(`${it.id}: ${e.message}`); console.log(`✗ ${it.id} ${e.message}`) }
        else await sleep(2000 * (attempt + 1))
      }
    }
    await sleep(DELAY)
    if (ok && ok % 40 === 0) console.log(`  …${ok}/${todo.length}`)
  }
  console.log(`\n下载完成：${ok}/${todo.length}${failures.length ? '，失败：' + failures.join(', ') : ''}`)

  // ── 校验比例规则 ──────────────────────────────────────────────
  let hit = 0, miss = 0
  const misses = []
  for (const it of manifest.items) {
    const p = join(OUT_DIR, it.id + '.svg')
    if (!existsSync(p)) continue
    const svg = readFileSync(p, 'utf8')
    const m = /viewBox="([-\d.]+)\s+([-\d.]+)\s+([\d.]+)\s+([\d.]+)"/.exec(svg)
    if (!m) continue
    const vw = Number(m[3])
    const [w, h] = it.size.replace('mm', '').split('×').map(Number)
    const want = w * scaleRule(w, h)
    const err = Math.abs(vw - want) / want
    if (err <= 0.02) hit++
    else { miss++; misses.push(`${it.id} ${it.size} viewBoxW=${vw} 期望≈${want.toFixed(1)} 偏差 ${(err * 100).toFixed(1)}%`) }
  }
  console.log(`比例规则校验：命中 ${hit}，偏差>2% ${miss}`)
  for (const s of misses.slice(0, 20)) console.log('  ' + s)
  writeFileSync(join(ROOT, '.tmp/y56y/scale-check.json'), JSON.stringify({ hit, miss, misses }, null, 2), 'utf8')
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1) })
