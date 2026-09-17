// 条码「对齐 / 生长锚点」验证（local dev，需 window.__appCtrl）
// 语义：靠左=左边缘钉住向右长；居中=中心钉住两侧均分；靠右=右边缘钉住向左长。
// 关键断言：① 切换对齐不移动对象（不跳动）② 改内容变宽时锚点那一侧保持不动
//          ③ 序列化往返后对齐档位与位置都不丢
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = { rows: [], fail: 0 }
const ctrl = window.__appCtrl
if (!ctrl) return { fatal: 'no __appCtrl' }

const assert = (name, ok, detail) => {
  out.rows.push({ name, pass: !!ok, detail })
  if (!ok) out.fail++
}
/** 画布坐标系（不含视口变换）下的包围盒 */
const box = (o) => {
  const b = o.getBoundingRect(false, true)
  return { l: b.left, r: b.left + b.width, c: b.left + b.width / 2, w: b.width, h: b.height }
}
const r1 = (v) => Math.round(v * 10) / 10
const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol

// ── 准备：新增一个 Code128（短内容）
ctrl.addBarcode('code128', '123456')
await sleep(200)
const bar = ctrl.getActiveObject()
if (!bar) return { fatal: 'no barcode created' }
out.type = ctrl.listPapers ? 'ok' : '?'
const b0 = box(bar)
out.afterAdd = { l: r1(b0.l), r: r1(b0.r), c: r1(b0.c), w: r1(b0.w) }

// ── 切到「靠右」：不应移动
ctrl.setBarcodeAlign('right')
await sleep(150)
const b1 = box(bar)
assert('切换靠右不移动对象', near(b1.l, b0.l) && near(b1.r, b0.r), `l ${r1(b0.l)}→${r1(b1.l)}, r ${r1(b0.r)}→${r1(b1.r)}`)
out.alignRight = {
  l: r1(b1.l),
  r: r1(b1.r),
  originX: bar.originX,
  snapshot: ctrl.getActiveSnapshot ? ctrl.getActiveSnapshot()?.barcodeAlign : undefined,
}

// ── 靠右：内容变长 4 倍 → 右边缘保持，向左长
ctrl.updateContent('123456789012345678901234')
await sleep(250)
const b2 = box(bar)
out.longRight = { l: r1(b2.l), r: r1(b2.r), c: r1(b2.c), w: r1(b2.w) }
assert('靠右：变宽后右边缘钉住', near(b2.r, b1.r, 2.5), `r ${r1(b1.r)}→${r1(b2.r)}（Δ=${r1(b2.r - b1.r)}）`)
assert('靠右：确实变宽了（内容生效）', b2.w > b1.w + 5, `w ${r1(b1.w)}→${r1(b2.w)}`)
assert('靠右：向左扩展（左边缘左移）', b2.l < b1.l - 3, `l ${r1(b1.l)}→${r1(b2.l)}`)

// ── 切到「居中」：不应移动
ctrl.setBarcodeAlign('center')
await sleep(150)
const b3 = box(bar)
assert('切换居中不移动对象', near(b3.l, b2.l) && near(b3.r, b2.r), `l ${r1(b2.l)}→${r1(b3.l)}, r ${r1(b2.r)}→${r1(b3.r)}`)

// ── 居中：再变长 → 两侧均分（中心不动）
const center3 = b3.c
ctrl.updateContent('12345678901234567890123456789012345678901234')
await sleep(250)
const b4 = box(bar)
out.longerCenter = { l: r1(b4.l), r: r1(b4.r), c: r1(b4.c), w: r1(b4.w) }
assert('居中：变宽后中心钉住', near(b4.c, center3, 2.5), `c ${r1(center3)}→${r1(b4.c)}`)
assert('居中：两侧都扩展', b4.l < b3.l - 3 && b4.r > b3.r + 3, `l ${r1(b3.l)}→${r1(b4.l)}, r ${r1(b3.r)}→${r1(b4.r)}`)

// ── 序列化往返：对齐档位 + 几何都要保住
const json = ctrl.toJSON ? ctrl.toJSON() : null
out.serializedAlign = json
  ? (json.objects || []).map((o) => o._barcodeAlign).filter(Boolean)
  : 'no-toJSON'
const before = box(bar)
await ctrl.loadFromJSON(json)
await sleep(300)
const restored = ctrl.canvas.getObjects().find((o) => o._barcodeType === 'code128')
if (!restored) {
  assert('往返后条码仍在', false, '找不到 code128 对象')
} else {
  const after = box(restored)
  out.roundTrip = {
    originX: restored.originX,
    align: restored._barcodeAlign,
    l: r1(after.l),
    r: r1(after.r),
    w: r1(after.w),
  }
  assert('往返后对齐档位保留', (restored._barcodeAlign ?? 'left') === 'center', String(restored._barcodeAlign))
  assert('往返后 originX = center', restored.originX === 'center', String(restored.originX))
  assert('往返后位置/宽度不变', near(after.l, before.l, 3) && near(after.w, before.w, 3), `l ${r1(before.l)}→${r1(after.l)}, w ${r1(before.w)}→${r1(after.w)}`)
}

out.total = out.rows.length
return out
