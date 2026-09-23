#!/usr/bin/env node
/**
 * 把 Label-editor 打包成一个「单 HTML 文件」，拷到没联网的电脑上双击即可使用。
 *
 * ── 为什么必须做这一层转换 ─────────────────────────────
 * 这个应用是 Web 应用而非静态网页：
 *   ① 代码是 ES module，且用了动态 import 做懒加载；
 *   ② 素材库（图标 / 合规标志 / 扩展图标库）与 PDF 中文字体都是运行时 fetch 读取。
 * 而浏览器在 `file://` 协议下会拦截这两类请求（CORS：origin 为 null），
 * 所以直接双击 index.html 是打不开的 —— 实测报错：
 *   "Access to fetch at 'file:///...' from origin 'null' has been blocked by CORS policy"
 *
 * ── 这里怎么解决 ───────────────────────────────────────
 *   ① 构建时关掉代码分割（见 vite.config.offline.ts）→ 只剩一个 app.js，消除动态 import；
 *   ② 把 JS / CSS 直接内联进 HTML；
 *   ③ 把所有被 fetch 的资源内联成数据，并在应用脚本**之前**注入一个 fetch 拦截器，
 *      对命中资源表的请求直接返回内存数据（Response 构造器支持 Uint8Array，
 *      二进制不会被 UTF-8 编坏，图片 MIME 也按要求给对，否则 <img> 不认）。
 *
 * ── 对源码的影响 ───────────────────────────────────────
 * 零。src/ 一个字都不用改，拦截发生在运行时外壳层。
 * 线上构建走的仍是 `vite.config.ts`，与这里互不干扰；
 * 源码更新后重新跑一次本脚本即可得到新的离线包。
 *
 * 用法：
 *   node scripts/build-offline.mjs            # 完整版（含扩展图标库）
 *   node scripts/build-offline.mjs --lite     # 精简版（不含扩展图标库，体积小一半）
 *   node scripts/build-offline.mjs --no-build # 跳过构建，用现有 offline-dist 重新组装
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT = path.resolve(import.meta.dirname, '..')
const DIST = path.join(ROOT, 'offline-dist')
const OUT_DIR = path.join(ROOT, 'offline')

const args = new Set(process.argv.slice(2))
const LITE = args.has('--lite')
const SKIP_BUILD = args.has('--no-build')

const log = (...a) => console.log(...a)
const kb = (n) => (n / 1024).toFixed(0) + 'KB'
const mb = (n) => (n / 1048576).toFixed(1) + 'MB'

/* ── 1. 构建 ─────────────────────────────────────────── */

if (!SKIP_BUILD) {
  log('▸ 构建单包产物（关闭代码分割）…')
  const viteBin = path.join(ROOT, 'node_modules/vite/bin/vite.js')
  execFileSync(process.execPath, [viteBin, 'build', '--config', 'vite.config.offline.ts'], {
    cwd: ROOT,
    stdio: 'inherit',
    // 本机内存紧张，给个明确的堆上限，避免无谓的 OOM 崩溃。
    //
    // ⚠️ `--no-experimental-require-module` 是必需的，不是可选项：
    // 本项目 postcss.config.js 是 ESM 写法、而 tailwind.config.js 是 CJS 写法，
    // package.json 又声明了 type: module。Node 22.12 起默认开启「require(ESM)」，
    // 于是 tailwind 内部 require 它的配置时，Node 会拿 ESM 语义去跑 CJS 文件 →
    // 报 `ReferenceError: module is not defined`，构建在配置阶段直接挂掉。
    // 关掉该特性后 Node 回落到旧的 require 行为，tailwind 能正常读取配置。
    env: {
      ...process.env,
      NODE_OPTIONS: [
        process.env.NODE_OPTIONS,
        '--no-experimental-require-module',
        '--max-old-space-size=1800',
      ]
        .filter(Boolean)
        .join(' '),
    },
  })
}

/* ── 2. 读取产物 ─────────────────────────────────────── */

const htmlPath = path.join(DIST, 'index.html')
if (!fs.existsSync(htmlPath)) {
  console.error(`✗ 找不到构建产物：${htmlPath}`)
  process.exit(1)
}

let html = fs.readFileSync(htmlPath, 'utf8')

// 从 HTML 里解析出实际的脚本 / 样式表引用，而不是写死路径 ——
// entryFileNames / assetFileNames 把它放在哪一层都能找得到。
const jsRefs = [...html.matchAll(/<script[^>]+src="([^"]+\.js)"[^>]*><\/script>/g)].map((m) => m[1])
const cssRefs = [...html.matchAll(/<link[^>]*href="([^"]+\.css)"[^>]*>/g)].map((m) => m[1])

if (jsRefs.length !== 1) {
  console.error(`✗ 期望只有 1 个 JS（代码分割没关干净），实际 ${jsRefs.length} 个：${jsRefs.join(', ')}`)
  process.exit(1)
}

const readRef = (ref) => fs.readFileSync(path.join(DIST, ref.replace(/^\.\//, '')), 'utf8')
const js = readRef(jsRefs[0])
const css = cssRefs.length ? readRef(cssRefs[0]) : ''
log(`  产物：JS ${mb(Buffer.byteLength(js))} · CSS ${kb(Buffer.byteLength(css))}`)

/* ── 3. 收集需要内联的资源 ───────────────────────────── */

/** 文本资源（JSON）：直接作为字符串内联 */
const TEXT = {}
/** 二进制资源（字体 / 位图）：base64 内联，取用时还原成 Uint8Array */
const BIN = {}

const EXT_BIN = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ttf', '.otf', '.woff', '.woff2'])

/** 递归收集一个目录下的资源，key 用「相对 dist 的 posix 路径」，与运行时 URL 尾巴一致 */
function collect(dir, shouldSkip) {
  if (!fs.existsSync(dir)) return
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    const st = fs.statSync(full)
    if (st.isDirectory()) {
      if (shouldSkip && shouldSkip(full)) continue
      collect(full, shouldSkip)
      continue
    }
    const ext = path.extname(name).toLowerCase()
    const key = path.relative(DIST, full).split(path.sep).join('/')
    if (EXT_BIN.has(ext)) {
      BIN[key] = fs.readFileSync(full).toString('base64')
    } else if (ext === '.json' || ext === '.svg') {
      // SVG 是 UTF-8 文本，按字符串内联即可（拦截器会按扩展名给出 image/svg+xml）。
      // ⚠️ 早期只收 .json，于是模板库里 103 个矢量图标在离线包中**静默消失** ——
      // 打开模板库时图标全空、还看不到任何报错（拦截器对未入表的 key 返回 404 空响应）。
      // 新增资源类型时必须同步 EXT_BIN / 这里 / 拦截器 typeOf 三处。
      TEXT[key] = fs.readFileSync(full, 'utf8')
    }
  }
}

const ktmDir = path.join(DIST, 'assets', 'ktm')
// 精简版：丢掉扩展图标库的大头（81 个分类数据 + 436 张位图，占全包约三分之二），
// 但**保留** 5KB 的分类索引 —— 面板照样能列出有哪些库，用户点进去发现为空，
// 也比整个库凭空消失、连入口都找不到要好理解。
collect(path.join(DIST, 'assets'), (d) => LITE && (d === ktmDir || d === path.join(ktmDir, 'raster')))
collect(path.join(DIST, 'fonts'))

if (LITE) {
  const idxFile = path.join(ktmDir, 'index.json')
  if (fs.existsSync(idxFile)) TEXT['assets/ktm/index.json'] = fs.readFileSync(idxFile, 'utf8')
  for (const k of Object.keys(TEXT)) {
    if (/^assets\/ktm\/c\d+\.json$/.test(k)) delete TEXT[k]
  }
}

const textBytes = Object.values(TEXT).reduce((a, s) => a + Buffer.byteLength(s), 0)
const binBytes = Object.values(BIN).reduce((a, s) => a + s.length, 0)
log(
  `  内联资源：文本 ${Object.keys(TEXT).length} 个/${mb(textBytes)}` +
    ` · 二进制 ${Object.keys(BIN).length} 个/${mb(binBytes)}${LITE ? '（精简版：已排除扩展图标库）' : ''}`,
)

/* ── 4. 组装单文件 ───────────────────────────────────── */

/**
 * 注入到应用之前的「离线资源拦截器」。
 *
 * 只做一件事：把对本地素材/字体的 fetch 换成读内存。
 * 用 Uint8Array 构造 Response —— 字体走 arrayBuffer()、位图走 blob()，
 * 若用字符串构造会按 UTF-8 编码，二进制当场损坏。
 */
const shim = `
(function () {
  var T = window.__OFFLINE_ASSETS__ || {};
  var B = window.__OFFLINE_BIN__ || {};

  function keyOf(u) {
    var s = String(u).split('#')[0].split('?')[0];
    var i = s.indexOf('assets/');
    if (i >= 0) return s.slice(i);
    var j = s.indexOf('fonts/');
    if (j >= 0) return s.slice(j);
    return null;
  }
  function typeOf(k) {
    if (/\\.png$/i.test(k)) return 'image/png';
    if (/\\.jpe?g$/i.test(k)) return 'image/jpeg';
    if (/\\.gif$/i.test(k)) return 'image/gif';
    if (/\\.webp$/i.test(k)) return 'image/webp';
    if (/\\.svg$/i.test(k)) return 'image/svg+xml';
    if (/\\.json$/i.test(k)) return 'application/json';
    if (/\\.ttf$/i.test(k)) return 'font/ttf';
    if (/\\.otf$/i.test(k)) return 'font/otf';
    return 'application/octet-stream';
  }
  function bytes(b64) {
    var bin = atob(b64), n = bin.length, out = new Uint8Array(n);
    for (var i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  var nativeFetch = window.fetch ? window.fetch.bind(window) : null;
  var hitKeys = [], misses = [];

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var k = keyOf(url);
    if (k) {
      if (Object.prototype.hasOwnProperty.call(T, k)) {
        hitKeys.push(k);
        return Promise.resolve(new Response(T[k], { status: 200, headers: { 'Content-Type': typeOf(k) } }));
      }
      if (Object.prototype.hasOwnProperty.call(B, k)) {
        hitKeys.push(k);
        return Promise.resolve(new Response(bytes(B[k]), { status: 200, headers: { 'Content-Type': typeOf(k) } }));
      }
      // 资源表里没有 → 说明打包时漏了，明确报出来而不是静默失败
      misses.push(k);
      return Promise.resolve(new Response('', { status: 404 }));
    }
    if (nativeFetch) return nativeFetch(input, init);
    return Promise.reject(new Error('offline: no network for ' + url));
  };

  // 便于自检：离线包是否真的把请求都吃掉了、都是哪些请求
  window.__offlineStats = function () {
    return { hits: hitKeys.length, hitKeys: hitKeys, misses: misses };
  };
})();
`.trim()

/** JSON 字面量注入时需要转义 `</script`，否则会提前闭合标签 */
const asLiteral = (obj) => JSON.stringify(obj).replace(/<\/(script)/gi, '<\\/$1')

// ⚠️⚠️ 这里的顺序是硬要求：所有针对 HTML 的清理都必须排在「内联 JS」**之前**。
//
// 踩过的坑：内联 JS 之后，HTML 里就含有整个应用源码，而源码中也含首屏文案、
// 站内链接等与模板一模一样的文本 —— 基于文本的替换会连 JS 一起改掉。
// 实测 `.replace(/正在加载编辑器…[^<]*/, …)` 放在内联后执行，贪婪匹配吞掉了
// JS 中紧随其后的 23KB 代码，产物报 `SyntaxError: Unexpected string`、页面白屏。
// 结论：文本级替换只在「纯模板」阶段做；内联之后只允许动标签，不许动文本。
//
// 正确顺序：清理外链 → 图标内联 → 文案调整 → 内联 CSS → 内联 JS → 注入数据

// ① 清掉单文件里没意义的外链：预加载提示、manifest、canonical
html = html.replace(/<link[^>]+rel="modulepreload"[^>]*>/g, '')
html = html.replace(/<link[^>]+rel="manifest"[^>]*>/g, '')
html = html.replace(/<link[^>]+rel="canonical"[^>]*>/g, '')
// ② 图标改内联（避免 file:// 下再发本地请求）
const faviconSvg = path.join(DIST, 'favicon.svg')
if (fs.existsSync(faviconSvg)) {
  const dataUri = `data:image/svg+xml,${encodeURIComponent(fs.readFileSync(faviconSvg, 'utf8'))}`
  html = html.replace(/<link[^>]+rel="icon"[^>]*>/g, '')
  html = html.replace('</title>', `</title>\n    <link rel="icon" href="${dataUri}" />`)
}
// ③ 首屏静态块里的站内链接在离线包中点不开，去掉以免误导（锚定 class，别裸匹配文本）
html = html.replace(/<p class="seo-links">[\s\S]*?<\/p>/, '')
// ④ 在线版提示语不适用于离线包：同样锚定到具体元素，并写清整段替换内容
html = html.replace(
  /<p class="seo-loading">[\s\S]*?<\/p>/,
  '<p class="seo-loading">正在加载编辑器…（离线单文件版）</p>',
)
// ⑤ 内联 CSS
html = html.replace(
  /<link[^>]*href="[^"]+\.css"[^>]*>/g,
  () => `<style>\n${css.replace(/<\/(style)/gi, '<\\/$1')}\n</style>`,
)
// ⑥ 内联 JS（保留 module 语义：产物里含 import.meta 等 ESM 语法）
html = html.replace(
  /<script[^>]+src="[^"]+\.js"[^>]*><\/script>/g,
  () => `<script type="module">\n${js.replace(/<\/(script)/gi, '<\\/$1')}\n</script>`,
)

const dataTags =
  `<script>window.__OFFLINE_ASSETS__=${asLiteral(TEXT)};</script>\n` +
  `<script>window.__OFFLINE_BIN__=${asLiteral(BIN)};</script>\n` +
  `<script>${shim}</script>\n`

// 数据与拦截器必须排在应用脚本之前
html = html.replace(/<script type="module">/, dataTags + '<script type="module">')

/* ── 5. 写出 ─────────────────────────────────────────── */

fs.mkdirSync(OUT_DIR, { recursive: true })
const outName = LITE ? '标签编辑器-离线版-精简.html' : '标签编辑器-离线版.html'
const outPath = path.join(OUT_DIR, outName)
fs.writeFileSync(outPath, html, 'utf8')

const size = fs.statSync(outPath).size
log('')
log(`✓ 已生成：offline/${outName}`)
log(`  体积：${mb(size)}`)

/* ── 6. 产物自检 ─────────────────────────────────────── */

const problems = []
if (/<script[^>]+src="[^"]*\.js"/.test(html)) problems.push('仍有外链 JS 未内联')
if (/<link[^>]+rel="stylesheet"/.test(html)) problems.push('仍有外链 CSS 未内联')
if (!/__OFFLINE_ASSETS__/.test(html)) problems.push('资源数据未注入')
if (!/window\.fetch\s*=/.test(html)) problems.push('fetch 拦截器未注入')

// 关键门禁：内联进 HTML 的脚本必须与源文件逐字符一致。
// 这类"被某步文本替换顺手改坏"的问题浏览器只会抛一句 SyntaxError、白屏，
// 极难定位（真踩过一次，丢 23KB 代码），所以在这里卡死。
{
  const open = '<script type="module">'
  const s0 = html.indexOf(open)
  const e0 = html.indexOf('</script>', s0 + open.length)
  let inner = html.slice(s0 + open.length, e0)
  if (inner.startsWith('\n')) inner = inner.slice(1)
  if (inner.endsWith('\n')) inner = inner.slice(0, -1)
  if (inner !== js) {
    problems.push(
      `内联脚本与源文件不一致（提取 ${inner.length} 字符 vs 源 ${js.length} 字符）` +
        ` —— 某步替换误伤了 JS`,
    )
  }
}

// 应用脚本必须排在拦截器之后
const shimAt = html.indexOf('window.fetch = function')
const appAt = html.indexOf('window.__OFFLINE_ASSETS__')
if (shimAt >= 0 && appAt >= 0 && shimAt > html.indexOf('<script type="module">', appAt)) {
  problems.push('拦截器注入顺序错误')
}

// 资源覆盖：dist 里**每个**运行时可能被 fetch 的文件都必须进资源表。
// 起因：collect 曾只认 .json，模板库的 103 个 .svg 图标静默消失，而拦截器对
// 未入表的 key 只返回 404 空响应 —— 界面表现为"图标全空但不报错"，极难反查。
{
  const RUNTIME_EXT = new Set([...EXT_BIN, '.json', '.svg'])
  const real = []
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name)
      if (fs.statSync(full).isDirectory()) {
        if (LITE && (full === ktmDir || full === path.join(ktmDir, 'raster'))) continue
        walk(full)
        continue
      }
      if (RUNTIME_EXT.has(path.extname(name).toLowerCase())) {
        real.push(path.relative(DIST, full).split(path.sep).join('/'))
      }
    }
  }
  walk(path.join(DIST, 'assets'))
  walk(path.join(DIST, 'fonts'))
  const missing = real.filter((k) => {
    if (LITE && /^assets\/ktm\/c\d+\.json$/.test(k)) return false // 精简版有意剔除
    return !(k in TEXT) && !(k in BIN)
  })
  if (missing.length) {
    problems.push(`有 ${missing.length} 个资源未内联（示例：${missing.slice(0, 3).join(', ')}）`)
  } else {
    log(`  资源覆盖：dist 下 ${real.length} 个可 fetch 文件全部入表`)
  }
}

if (problems.length) {
  log('')
  log('✗ 自检未通过：')
  for (const p of problems) log('  · ' + p)
  process.exit(1)
}
log('  自检：外链已清零 · 数据已注入 · 拦截器顺序正确 · 内联脚本与源文件逐字符一致')
