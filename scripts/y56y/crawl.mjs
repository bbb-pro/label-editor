// y56y.com 模板数据爬取器（无头 Edge + 原生 CDP，零依赖）
//
// 背景：模板设置接口 /labeltemplate/getlabeltemplatesetting 带请求签名（自定义头 + 随机参数），
// 直接 curl 只会得到「参数 templateId 为空」。
// 关键教训：用「注入脚本钩 XHR」抓不到 —— 应用页拿到响应后会立刻 location.href='/label'，
// 文档已换、注入的数组随之清空。**必须走 CDP 的 Network 域**（协议层，不随文档销毁）。
//
// 用法：
//   node scripts/y56y/crawl.mjs                     # 全量（跳过已存在产物）
//   node scripts/y56y/crawl.mjs --limit 3           # 只跑前 3 个
//   node scripts/y56y/crawl.mjs --ids L0029,L0026   # 指定模板
//   node scripts/y56y/crawl.mjs --force             # 忽略已存在产物
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dir, '../..')
const OUT_DIR = join(ROOT, '.tmp/y56y/raw')
const MANIFEST = join(ROOT, '.tmp/y56y/manifest.json')

const PORT = Number(process.env.CDP_PORT || 9411)
const EDGE_CANDIDATES = [
  process.env.CDP_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean)

const argv = process.argv.slice(2)
const argOf = (k) => {
  const i = argv.indexOf(k)
  return i >= 0 ? argv[i + 1] : null
}
const FORCE = argv.includes('--force')
const LIMIT = argOf('--limit') ? Number(argOf('--limit')) : 0
const IDS = argOf('--ids') ? argOf('--ids').split(',').map((s) => s.trim()).filter(Boolean) : null
const MATCH = 'getlabeltemplatesetting'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 极简 CDP 客户端 ────────────────────────────────────────────────
class CDP {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.frames = []
    this.hits = []            // { requestId, url, method, headers, postData }
    this.bodies = new Map()   // requestId -> { status, body }
    this.onLoadingDone = null
    ws.addEventListener('message', (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)
        return
      }
      const p = msg.params
      switch (msg.method) {
        case 'Page.javascriptDialogOpening':
          this.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {})
          break
        case 'Page.frameNavigated':
          try { this.frames.push(p.frame.url) } catch {}
          break
        case 'Network.requestWillBeSent':
          if (p.request && p.request.url && p.request.url.indexOf(MATCH) >= 0) {
            this.hits.push({
              requestId: p.requestId,
              url: p.request.url,
              method: p.request.method,
              headers: p.request.headers,
              postData: p.request.postData || null,
              type: p.type,
            })
          }
          break
        case 'Network.loadingFinished':
          if (this.onLoadingDone) this.onLoadingDone(p.requestId)
          break
        default:
          break
      }
    })
  }
  send(method, params = {}, timeout = 60000) {
    const id = ++this.id
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error('CDP 超时: ' + method)) }, timeout)
      this.pending.set(id, { res: (v) => { clearTimeout(t); res(v) }, rej: (e) => { clearTimeout(t); rej(e) } })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
}

async function waitJSON(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url)
      if (r.ok) return await r.json()
    } catch {}
    await sleep(300)
  }
  throw new Error('等不到 ' + url)
}

async function pickBrowser() {
  for (const p of EDGE_CANDIDATES) if (existsSync(p)) return p
  throw new Error('找不到 Edge/Chrome，可设 CDP_BROWSER 指定路径')
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  let items = manifest.items
  if (IDS) items = items.filter((it) => IDS.includes(it.id))
  if (LIMIT) items = items.slice(0, LIMIT)
  if (!FORCE) items = items.filter((it) => !existsSync(join(OUT_DIR, it.id + '.json')))
  if (!items.length) { console.log('没有待处理模板。'); return }
  console.log(`待处理 ${items.length} 个模板`)

  const exe = await pickBrowser()
  const userDir = mkdtempSync(join(tmpdir(), 'y56y-crawl-'))
  const child = spawn(exe, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-gpu',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--mute-audio', '--window-size=1200,800',
    'about:blank',
  ], { stdio: 'ignore' })

  let ws
  let ok = 0, fail = 0
  const failures = []
  try {
    const ver = await waitJSON(`http://127.0.0.1:${PORT}/json/version`)
    console.log('浏览器:', ver.Browser)
    const list = await waitJSON(`http://127.0.0.1:${PORT}/json/list`)
    const page = list.find((t) => t.type === 'page')
    ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
    const cdp = new CDP(ws)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Network.enable', { maxTotalBufferSize: 200 * 1024 * 1024, maxResourceBufferSize: 40 * 1024 * 1024 })

    // 响应体必须在 loadingFinished 的第一时间取（导航后可能被淘汰）
    cdp.onLoadingDone = async (requestId) => {
      if (!cdp.hits.some((h) => h.requestId === requestId)) return
      try {
        const b = await cdp.send('Network.getResponseBody', { requestId }, 20000)
        cdp.bodies.set(requestId, { base64: b.base64Encoded, body: b.body })
      } catch (e) {
        cdp.bodies.set(requestId, { error: e.message })
      }
    }

    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      const tag = `[${i + 1}/${items.length}] ${it.id} ${it.name}`
      const url = `https://y56y.com/labeltemplate/applylabeltemplate.html?typeid=${it.typeid}&id=${it.id}`
      cdp.hits = []
      cdp.frames = []
      try {
        await cdp.send('Page.navigate', { url }, 45000)
        // 等命中，最多 12s
        for (let t = 0; t < 48 && cdp.hits.length === 0; t++) await sleep(250)
        // 再等响应体落地
        for (let t = 0; t < 40; t++) {
          if (cdp.hits.length && cdp.hits.every((h) => cdp.bodies.has(h.requestId))) break
          await sleep(250)
        }
        const requests = cdp.hits.map((h) => ({
          method: h.method, url: h.url, headers: h.headers, postData: h.postData,
          response: cdp.bodies.get(h.requestId) || null,
        }))
        const textOf = (r) => (r.response && r.response.body) || ''
        const best = requests.map(textOf).sort((a, b) => b.length - a.length)[0] || ''

        writeFileSync(join(OUT_DIR, it.id + '.json'), JSON.stringify({
          id: it.id, typeid: it.typeid, name: it.name, size: it.size,
          applyUrl: url, navigations: cdp.frames.slice(),
          capturedAt: new Date().toISOString(), requests,
        }, null, 2), 'utf8')

        if (requests.length && best.length > 0) {
          ok++
          console.log(`${tag} ✓ ${requests.length} 请求 / 响应 ${best.length} B`)
        } else {
          fail++
          failures.push(it.id)
          console.log(`${tag} ✗ 未捕获（请求 ${requests.length} 条）`)
        }
      } catch (e) {
        fail++
        failures.push(it.id)
        console.log(`${tag} ✗ 异常: ${e.message}`)
      }
    }
  } finally {
    try { ws && ws.close() } catch {}
    try { child.kill() } catch {}
    await sleep(400)
    try { rmSync(userDir, { recursive: true, force: true }) } catch {}
  }
  console.log(`\n完成：成功 ${ok}，失败 ${fail}${failures.length ? '（' + failures.join(',') + '）' : ''}`)
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1) })
