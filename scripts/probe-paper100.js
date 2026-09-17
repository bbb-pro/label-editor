// 验证「在当前标签下方新建一张」→ 视图 100% 且新标签居中
// 断言点：① 缩放回到 1.0（旧实现 fitToView 会压到 <1）；② 新纸中心落在视口中心；③ 新纸为活动纸
const ctrl = window.__appCtrl
const canvas = ctrl.canvas
const out = {}
const rows = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rec = (name, pass, detail) => rows.push({ name, pass: !!pass, detail })

const vpt = () => canvas.viewportTransform || [1, 0, 0, 1, 0, 0]
const zoomOf = () => vpt()[0]
const panOf = () => ({ x: vpt()[4], y: vpt()[5] })

const centerOfPaper = (bounds) => ({
  x: bounds.left + bounds.width / 2,
  y: bounds.top + bounds.height / 2,
})

// 把「新纸中心」投到屏幕坐标：screen = 逻辑 * z + pan
const screenOfPaperCenter = (bounds) => {
  const c = centerOfPaper(bounds)
  const z = zoomOf()
  const p = panOf()
  return { x: c.x * z + p.x, y: c.y * z + p.y }
}

// ── 0. 前置：找到按钮
const btn = [...document.querySelectorAll('button')].find(
  (b) => (b.getAttribute('title') || '') === '在当前标签下方新建一张',
)
rec('P0 页面上能找到「下方新建」按钮', !!btn, btn ? 'found' : 'missing button')

const papersBefore = ctrl.listPapers()
out.papersBefore = papersBefore.length
out.zoomBefore = zoomOf()

// 先把视图人为改成一个「非 100% 且偏向别处」的状态，
// 这样如果新逻辑没生效，就会残留旧缩放 —— 断言才有区分度。
canvas.setViewportTransform([0.45, 0, 0, 0.45, -300, -300])
canvas.requestRenderAll()
await sleep(40)
out.zoomPre = zoomOf()

// ── 1. 点击按钮
if (btn) btn.click()
await sleep(320)

const papersAfter = ctrl.listPapers()
out.papersAfter = papersAfter.length
const created = papersAfter[papersAfter.length - 1]
const activeId = ctrl.activePaperId()
out.activeId = activeId
out.newId = created.id

rec('A1 新增了一张纸', papersAfter.length === papersBefore.length + 1, `${papersBefore.length} → ${papersAfter.length}`)
rec('A2 新纸成为活动纸', activeId === created.id, `active=${activeId} new=${created.id}`)

// ── 2. 缩放必须回到 100%
const z = zoomOf()
out.zoomAfter = z
rec('A3 视图回到 100%（zoom === 1）', Math.abs(z - 1) < 0.001, `zoom=${z}`)

// ── 3. 新纸中心必须落在视口中心
const bounds = ctrl.getPaperBoundsPxFor(created.id)
const scr = screenOfPaperCenter(bounds)
const vp = ctrl.getViewportSize()
out.center = { scr, vp }
const dx = scr.x - vp.width / 2
const dy = scr.y - vp.height / 2
rec('A4 新纸中心与视口中心对齐（|Δ| ≤ 2px）', Math.abs(dx) <= 2 && Math.abs(dy) <= 2, `Δ=(${dx.toFixed(2)}, ${dy.toFixed(2)}) px`)

// ── 4. 纸的显示尺寸必须是 1:1（可见宽 = 毫米 * 96/25.4）
const expectW = (created.widthMm * 96) / 25.4
out.paperVisW = bounds.width * z
rec('A5 纸显示尺寸 1:1（非适配缩放）', Math.abs(bounds.width * z - expectW) < 1, `vis=${(bounds.width * z).toFixed(1)} expect=${expectW.toFixed(1)}`)

// ── 5. 上一张纸没被动过（不该被平移/删对象）
rec('A6 原纸张尺寸未变', papersAfter[0].widthMm === papersBefore[0].widthMm && papersAfter[0].heightMm === papersBefore[0].heightMm, `${papersAfter[0].widthMm}×${papersAfter[0].heightMm}mm`)

// ── 6. 连点两次仍稳定在 100% 且居中（排除「第二次跑偏」）
if (btn) btn.click()
await sleep(320)
const papers3 = ctrl.listPapers()
const newest = papers3[papers3.length - 1]
const b3 = ctrl.getPaperBoundsPxFor(newest.id)
const s3 = screenOfPaperCenter(b3)
const vp3 = ctrl.getViewportSize()
rec(
  'A7 连点两次后仍是 100% + 新纸居中',
  Math.abs(zoomOf() - 1) < 0.001 && Math.abs(s3.x - vp3.width / 2) <= 2 && Math.abs(s3.y - vp3.height / 2) <= 2,
  `zoom=${zoomOf()} Δ=(${(s3.x - vp3.width / 2).toFixed(2)}, ${(s3.y - vp3.height / 2).toFixed(2)}) papers=${papers3.length}`,
)

const fails = rows.filter((r) => !r.pass)
return { total: rows.length, fail: fails.length, fails, rows, out }
