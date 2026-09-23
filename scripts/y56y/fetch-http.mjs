// y56y.com 模板设置 HTTP 抓取（接口已实测可用，无需浏览器）
//   POST https://y56y.com/labeltemplate/getlabeltemplatesetting?<随机数>
//   body: typeid=<分类id>&templateid=<模板id>     ← 参数名全小写，服务端区分大小写
//   headers: x-requested-with: XMLHttpRequest + Referer
// 响应：{ code:"000", data: "<JSON 字符串>" }，data 里是 { itemList: [...] }
//
// 用法：node scripts/y56y/fetch-http.mjs [--limit N] [--ids A,B] [--force]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dir, '../..')
const OUT_DIR = join(ROOT, '.tmp/y56y/api')
const MANIFEST = join(ROOT, '.tmp/y56y/manifest.json')

const argv = process.argv.slice(2)
const argOf = (k) => (argv.indexOf(k) >= 0 ? argv[argv.indexOf(k) + 1] : null)
const FORCE = argv.includes('--force')
const LIMIT = argOf('--limit') ? Number(argOf('--limit')) : 0
const IDS = argOf('--ids') ? argOf('--ids').split(',').map((s) => s.trim()).filter(Boolean) : null
const CONC = Number(argOf('--concurrency') || 1)
/** 每次请求之间的间隔（ms）：站点有频控，>1 并发立刻返回「频繁操作」 */
const DELAY = Number(argOf('--delay') || 1200)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function fetchOne(it) {
  const url = `https://y56y.com/labeltemplate/getlabeltemplatesetting?${Math.floor(Math.random() * 999999)}`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'x-requested-with': 'XMLHttpRequest',
      Referer: `https://y56y.com/labeltemplate/applylabeltemplate.html?typeid=${it.typeid}&id=${it.id}`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
    },
    body: `typeid=${it.typeid}&templateid=${it.id}`,
  })
  const text = await res.text()
  let env
  try { env = JSON.parse(text) } catch { throw new Error('响应不是 JSON: ' + text.slice(0, 120)) }
  if (env.code !== '000') throw new Error(`code=${env.code} ${env.message}`)
  let inner
  try { inner = JSON.parse(env.data) } catch { throw new Error('data 不是 JSON 字符串') }
  return { id: it.id, typeid: it.typeid, name: it.name, size: it.size, itemList: inner.itemList }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  let items = manifest.items
  if (IDS) items = items.filter((it) => IDS.includes(it.id))
  if (LIMIT) items = items.slice(0, LIMIT)
  if (!FORCE) items = items.filter((it) => !existsSync(join(OUT_DIR, it.id + '.json')))
  console.log(`待抓取 ${items.length} 个模板（并发 ${CONC}）`)

  let ok = 0
  const failures = []
  const queue = items.slice()
  async function worker() {
    while (queue.length) {
      const it = queue.shift()
      let done = false
      for (let attempt = 0; attempt < 6 && !done; attempt++) {
        try {
          const data = await fetchOne(it)
          writeFileSync(join(OUT_DIR, it.id + '.json'), JSON.stringify(data, null, 2), 'utf8')
          ok++
          done = true
          if (ok % 20 === 0) console.log(`  …已抓 ${ok}/${items.length}`)
        } catch (e) {
          // 频控：退避更久（站点提示 3 分钟，这里逐步拉长到 30s 足够放行）
          const throttled = /too fast|频繁/.test(e.message)
          const wait = throttled ? Math.min(30000, 4000 * (attempt + 1)) : 600 * (attempt + 1)
          if (attempt === 5) { failures.push(`${it.id}: ${e.message}`); console.log(`✗ ${it.id} ${e.message}`) }
          else await sleep(wait)
        }
      }
      await sleep(DELAY)
    }
  }
  await Promise.all(Array.from({ length: CONC }, () => worker()))
  console.log(`\n完成：成功 ${ok}/${items.length}${failures.length ? '\n失败：\n  ' + failures.join('\n  ') : ''}`)
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1) })
