/**
 * SVG 路径简化（供素材编译期预处理用）。
 *
 * 背景：竞品站里有几个分类是**位图自动描摹**出来的剪影（如「树木形状」），
 * 单个 101×102 的图形塞了 4 万多个坐标点、路径数据 1MB，一个分类 20MB。
 * 这类数据有两个问题：体积离谱、而且 fabric 解析这种路径会明显卡顿。
 *
 * 做法：把贝塞尔曲线展平成折线后跑 Ramer–Douglas–Peucker 简化，
 * 再输出成等价的 `M/L/Z` 多段线。**逐条子路径独立处理**（剪影常带多段轮廓），
 * 并用「简化前后多边形面积差」做自动校验 —— 偏差超阈值就放弃简化、
 * 保留原路径，宁可体积大也不让图形走样。
 */

/** 把三次贝塞尔按弦长自适应采样成折线点 */
function flattenCubic(p0, p1, p2, p3, out) {
  const approx = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) +
    Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) +
    Math.hypot(p3[0] - p2[0], p3[1] - p2[1])
  const steps = Math.max(2, Math.min(16, Math.round(approx / 1.5)))
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    const u = 1 - t
    const x = u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0]
    const y = u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]
    out.push([x, y])
  }
}

/** Ramer–Douglas–Peucker（迭代实现，避免深递归爆栈） */
function rdp(points, eps) {
  const n = points.length
  if (n < 3) return points
  const keep = new Uint8Array(n)
  keep[0] = 1
  keep[n - 1] = 1
  const stack = [[0, n - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()
    const [ax, ay] = points[a]
    const [bx, by] = points[b]
    const dx = bx - ax
    const dy = by - ay
    const len = Math.hypot(dx, dy)
    let maxD = -1
    let idx = -1
    for (let i = a + 1; i < b; i++) {
      const [px, py] = points[i]
      const d = len === 0
        ? Math.hypot(px - ax, py - ay)
        : Math.abs(dy * px - dx * py + bx * ay - by * ax) / len
      if (d > maxD) { maxD = d; idx = i }
    }
    if (maxD > eps && idx > a) {
      keep[idx] = 1
      stack.push([a, idx], [idx, b])
    }
  }
  const out = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i])
  return out
}

/** 多边形面积（鞋带公式，取绝对值） */
function polyArea(pts) {
  let s = 0
  for (let i = 0, n = pts.length; i < n; i++) {
    const [x1, y1] = pts[i]
    const [x2, y2] = pts[(i + 1) % n]
    s += x1 * y2 - x2 * y1
  }
  return Math.abs(s) / 2
}

/** 点集的包围盒对角线长度（作为该子路径的尺度基准） */
function subDiagonal(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const [x, y] of pts) {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  return Math.hypot(maxX - minX, maxY - minY)
}

const fmt = (v) => {
  const r = Math.round(v * 100) / 100
  return String(r)
}

/**
 * 尝试简化一段 path 的 d 属性。
 * @returns {{d:string, ratio:number, areaDelta:number}|null} null = 不支持/不值得简化
 */
export function simplifyPathData(d, { epsRatio = 0.0025, minLen = 3000, maxAreaDelta = 0.01, maxRatio = 0.7 } = {}) {
  if (d.length < minLen) return null
  const tokens = d.match(/[MLCZmlcz]|-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g)
  if (!tokens) return null

  // 只认描摹工具产出的 M/L/C/Z 大写命令；出现别的（弧、二次贝塞尔、小写相对命令）就整体放弃
  const subs = []
  let cur = null
  let i = 0
  let nums = []
  let pending = 'M'
  const flush = () => {
    if (cur && cur.pts.length) subs.push(cur)
    cur = null
  }
  while (i < tokens.length) {
    const t = tokens[i]
    if (/^[A-Za-z]$/.test(t)) {
      if (!'MLCZ'.includes(t)) return null
      // M 可以一次带多组坐标（后续按 L 处理）
      if (t === 'Z') {
        if (!cur) return null
        cur.closed = true
        flush()
      } else if (t === 'M') {
        // 只有 M 才开新子路径；C / L 是延续当前子路径的一部分
        flush()
        cur = { pts: [], closed: false }
      } else if (!cur) {
        cur = { pts: [], closed: false }
      }
      pending = t
      nums = []
      i++
      continue
    }
    nums.push(Number(t))
    i++
    // 攒够一组就消费
    if (pending === 'C' && nums.length === 6) {
      const p0 = cur.pts.length ? cur.pts[cur.pts.length - 1] : [nums[0], nums[1]]
      flattenCubic(p0, [nums[0], nums[1]], [nums[2], nums[3]], [nums[4], nums[5]], cur.pts)
      nums = []
    } else if (pending === 'L' && nums.length === 2) {
      cur.pts.push([nums[0], nums[1]])
      nums = []
    } else if (pending === 'M' && nums.length === 2) {
      cur.pts.push([nums[0], nums[1]])
      nums = []
      pending = 'L' // 后续坐标对按直线处理（SVG 规范即如此）
    }
  }
  flush()
  if (!subs.length || subs.some((s) => s.pts.length < 3)) return null

  // ⚠️ 面积必须**逐条子路径**算再求和，不能把各子路径的点首尾相接当成一个多边形 ——
  // 剪影常是多段轮廓（外轮廓 + 内部空洞），拼接后的面积没有几何意义，
  // 会让「简化前后面积差」这个校验指标恒判失败。
  let before = 0
  for (const s of subs) before += polyArea(s.pts)

  const parts = []
  let after = 0
  for (const s of subs) {
    // ⚠️ 容差要按**这条子路径自己的尺度**取，不能用整图对角线：
    // 描摹剪影常是「一个大轮廓 + 一堆 2~3 单位的小叶片」，
    // 用整图尺度的容差去简化小叶片，等于把它揉变形（实测正是这么被面积校验拦下的）。
    const d = subDiagonal(s.pts) * epsRatio
    const simplified = s.pts.length < 3 ? s.pts : rdp(s.pts, Math.max(d, 0.01))
    if (simplified.length < 2) return null
    after += polyArea(simplified)
    // 同一命令的连续坐标可以省略命令字母：`L x1 y1 x2 y2 …`
    parts.push(
      'M' + fmt(simplified[0][0]) + ' ' + fmt(simplified[0][1]) +
      (simplified.length > 1
        ? 'L' + simplified.slice(1).map(([x, y]) => fmt(x) + ' ' + fmt(y)).join(' ')
        : '') +
      (s.closed ? 'Z' : ''),
    )
  }
  const areaDelta = before > 0 ? Math.abs(after - before) / before : 1
  if (areaDelta > maxAreaDelta) return null // 变形超阈值 → 放弃
  const out = parts.join('')
  if (out.length >= d.length * maxRatio) return null // 省得不够多就不折腾
  return { d: out, ratio: out.length / d.length, areaDelta }
}

/**
 * 对一段 SVG 内部片段整体做路径简化（逐条 path 独立判断）。
 * @returns {{inner:string, before:number, after:number, touched:number}}
 */
export function simplifySvgContent(inner, opts) {
  const before = inner.length
  let touched = 0
  const out = inner.replace(/<path\b([^>]*?)\sd="([^"]+)"/g, (m, attrs, d) => {
    const r = simplifyPathData(d, opts)
    if (!r) return m
    touched++
    return `<path${attrs} d="${r.d}"`
  })
  return { inner: out, before, after: out.length, touched }
}
