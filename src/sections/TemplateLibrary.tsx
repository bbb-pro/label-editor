// 模板库对话框：展示公开标签模板，点击即按模板新建标签
//
// 缩略图不是截图，而是**用模板数据现画 SVG** —— 数据是矢量定义（矩形/文字/
// 条码区域），直接映射成 SVG 基本图元即可，既零请求又永远与真实落盘结果一致。
// 缩略图只求"一眼认出是哪种标签"，所以条码/二维码用确定性的伪随机图案示意
// （seed 取自内容，同一模板每次渲染都一样），不真的去调 bwip-js 编码。
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { LayoutTemplate, Search } from 'lucide-react'
import { type LibTemplate, type TplNode } from '@/lib/templateLibrary'
import {
  loadY56yLibrary,
  type Y56yLibrary,
  type Y56yTemplate,
} from '@/lib/templateLibraryY56y'
import { mergeLibrary, type MergedItem } from '@/lib/templateLibraryMerged'

interface TemplateLibraryProps {
  open: boolean
  onOpenChange: (v: boolean) => void
  /** 选中内置行业模板（由 App 负责落盘 + 提示） */
  onPick: (tpl: LibTemplate) => void
  /** 选中「多零」通用模板（数据量大，需异步备图资源） */
  onPickY56y: (tpl: Y56yTemplate) => void
}

export default function TemplateLibrary({
  open,
  onOpenChange,
  onPick,
  onPickY56y,
}: TemplateLibraryProps) {
  const [lib, setLib] = useState<Y56yLibrary | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [catId, setCatId] = useState<number | 'all'>('all')
  const [q, setQ] = useState('')

  // 打开对话框时才拉通用模板（约 810KB，不进首屏）；载入后模块内有缓存，再打开即瞬时
  useEffect(() => {
    if (!open || lib) return
    let alive = true
    const run = async () => {
      try {
        const data = await loadY56yLibrary()
        if (alive) {
          setLib(data)
          setLoadErr(null)
        }
      } catch (e) {
        if (alive) setLoadErr(e instanceof Error ? e.message : '模板数据加载失败')
      }
    }
    void run()
    return () => {
      alive = false
    }
  }, [open, lib])

  // 两套模板源在这里合成一套分类 + 一个列表。
  // 通用模板还没 fetch 完时 items 只有 12 个内置模板 —— 对话框不至于空等。
  const { categories, items, counts } = useMemo(() => mergeLibrary(lib), [lib])

  const list = useMemo(() => {
    const kw = q.trim().toLowerCase()
    return items.filter(
      (t) =>
        (catId === 'all' || t.catId === catId) &&
        (!kw ||
          t.name.toLowerCase().includes(kw) ||
          t.key.toLowerCase().includes(kw) ||
          t.catName.toLowerCase().includes(kw)),
    )
  }, [items, catId, q])

  /** 分类按站点分组分栏呈现 —— 源站有两个同名分类「文字标识」，只有带分组才分得清；
   *  本项目新开的分类自成一栏。 */
  const groups = useMemo(() => {
    const out: { name: string; cats: { id: number; name: string }[] }[] = []
    for (const c of categories) {
      let g = out.find((x) => x.name === c.groupName)
      if (!g) {
        g = { name: c.groupName, cats: [] }
        out.push(g)
      }
      g.cats.push({ id: c.id, name: c.name })
    }
    return out
  }, [categories])

  /** 两套源的落盘路径不同，在这里分派 */
  const pickItem = (it: MergedItem) => {
    if (it.src === 'builtin' && it.builtin) onPick(it.builtin)
    else if (it.y56y) onPickY56y(it.y56y)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5 text-base">
            <LayoutTemplate className="h-4 w-4 text-blue-600" />
            模板库
          </DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            {lib
              ? `点选一个模板即按它的尺寸与版式新建标签（当前画布内容会被替换，可用 Ctrl+Z 撤销）。共 ${items.length} 个模板、${categories.length} 个分类，含矢量图标与条码占位，可一键套用后自行改文案。`
              : '点选一个模板即按它的尺寸与版式新建标签（当前画布内容会被替换，可用 Ctrl+Z 撤销）。正在载入模板库…'}
          </DialogDescription>
        </DialogHeader>

        {/* 搜索 + 分类筛选 */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索模板名称（如 GPSR、FBA、快递、洗涤、警示）"
              className="h-8 w-full rounded-md border bg-background pr-2 pl-7 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            />
          </div>
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {list.length} / {items.length}
          </span>
        </div>

        <div className="max-h-24 space-y-1 overflow-y-auto">
          <div className="flex flex-wrap gap-1">
            <Chip active={catId === 'all'} onClick={() => setCatId('all')}>
              全部分类 {items.length}
            </Chip>
          </div>
          {groups.map((g) => (
            <div key={g.name} className="flex flex-wrap items-center gap-1">
              <span className="w-20 shrink-0 truncate text-[10px] text-muted-foreground" title={g.name}>
                {g.name}
              </span>
              {g.cats.map((c) => (
                <Chip key={c.id} active={catId === c.id} onClick={() => setCatId(c.id)}>
                  {c.name} {counts.get(c.id) ?? 0}
                </Chip>
              ))}
            </div>
          ))}
        </div>

        <div className="-mx-1 max-h-[46vh] overflow-y-auto px-1 py-1">
          {loadErr ? (
            <div className="py-10 text-center text-xs text-destructive">{loadErr}</div>
          ) : (
            <>
              {!lib && (
                <div className="pb-2 text-center text-[11px] text-muted-foreground">
                  正在载入通用模板…以下为随程序内置的行业模板
                </div>
              )}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {list.map((it) => (
                  <button
                    key={it.key}
                    type="button"
                    onClick={() => pickItem(it)}
                    title={
                      it.y56y
                        ? `使用「${it.name}」（${it.y56y.id} · ${it.size}）`
                        : `使用「${it.name}」（${it.size}）`
                    }
                    className="group flex flex-col gap-1.5 rounded-lg border bg-card p-2 text-left transition-colors hover:border-blue-500 hover:bg-blue-50/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                  >
                    <div className="flex h-24 items-center justify-center rounded-md bg-slate-100 p-1.5">
                      {it.builtin ? (
                        <TemplateThumb tpl={it.builtin} />
                      ) : it.y56y ? (
                        <Y56yThumb tpl={it.y56y} />
                      ) : null}
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="truncate text-xs font-medium">{it.name}</span>
                      <span className="ml-auto shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                        {it.size}
                      </span>
                    </div>
                    <div className="truncate text-[10px] text-muted-foreground">{it.catName}</div>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** 分类筛选条上的小圆角按钮 */
function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'rounded-full border px-2.5 py-1 text-[11px] transition-colors ' +
        (active
          ? 'border-blue-600 bg-blue-600 font-medium text-white'
          : 'border-border bg-background text-muted-foreground hover:bg-accent')
      }
    >
      {children}
    </button>
  )
}

// ── 缩略图：模板数据 → SVG（坐标系与原站一致，1mm = 8 单位） ──────────

/** 确定性伪随机：同一字符串恒定产出同一序列（保缩略图稳定、不用 Math.random） */
function seedOf(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0 || 1
}
function makeRng(seed: number): () => number {
  let s = seed
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return s / 4294967296
  }
}

/** 一维条码示意：条空交替 +（可选）下方人读文字 */
function barcodePath(
  content: string,
  x: number,
  y: number,
  w: number,
  h: number,
  withText: boolean,
): string {
  const next = makeRng(seedOf(content))
  const bandH = withText ? h * 0.76 : h
  const modules = 68
  const mw = w / modules
  const dark: boolean[] = []
  for (let i = 0; i < modules; i++) dark.push(next() < 0.5)
  // 首尾各留一条黑，视觉上更像条码（起始/终止符）
  dark[0] = true
  dark[modules - 1] = true
  let d = ''
  let i = 0
  while (i < modules) {
    if (!dark[i]) {
      i++
      continue
    }
    let j = i
    while (j < modules && dark[j]) j++
    const x0 = x + i * mw
    const x1 = x + j * mw
    d += `M${x0.toFixed(2)} ${y.toFixed(2)}H${x1.toFixed(2)}V${(y + bandH).toFixed(2)}H${x0.toFixed(2)}Z`
    i = j
  }
  return d
}

/** 二维码示意：三个定位角 + 确定性散点 */
function qrPath(content: string, x: number, y: number, size: number): string {
  const n = 15
  const cell = size / n
  const next = makeRng(seedOf(content))
  let d = ''
  const finder = (fr: number, fc: number) => {
    // 5×5 定位角：外圈实 + 内圈空 + 中心实
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 5; c++) {
        const ring = r === 0 || r === 4 || c === 0 || c === 4
        const core = r >= 2 && r <= 2 && c >= 2 && c <= 2
        if (!ring && !core) continue
        const px = x + (fc + c) * cell
        const py = y + (fr + r) * cell
        d += `M${px.toFixed(2)} ${py.toFixed(2)}h${cell.toFixed(2)}v${cell.toFixed(2)}h${(-cell).toFixed(2)}Z`
      }
    }
  }
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const inFinder = (r < 5 && c < 5) || (r < 5 && c >= n - 5) || (r >= n - 5 && c < 5)
      if (inFinder) continue
      if (next() < 0.48) continue
      const px = x + c * cell
      const py = y + r * cell
      d += `M${px.toFixed(2)} ${py.toFixed(2)}h${cell.toFixed(2)}v${cell.toFixed(2)}h${(-cell).toFixed(2)}Z`
    }
  }
  finder(0, 0)
  finder(0, n - 5)
  finder(n - 5, 0)
  return d
}

const ANCHOR: Record<number, 'start' | 'middle' | 'end'> = {
  0: 'start',
  1: 'middle',
  2: 'end',
}

function TemplateThumb({ tpl }: { tpl: LibTemplate }) {
  const { width, height, elements } = tpl.label
  const clipId = `tpl-clip-${tpl.id}`
  const texts: ReactNode[] = []
  const shapes: ReactNode[] = []
  const paths: string[] = []

  elements.forEach((e, idx) => {
    const key = `${tpl.id}-${idx}`
    if (e.type === 'text' || e.type === 'time') {
      const isTime = e.type === 'time'
      const content = isTime ? '2026-01-01 08:00' : e.content
      const align = isTime ? 0 : e.textAlign ?? 0
      // 垂直居中 + 基线换算（与引擎里 textTopMm 的口径一致）
      const top = e.y + Math.max(0, (e.height - e.fontSize * 1.16) / 2)
      const ax = align === 1 ? e.x + e.width / 2 : align === 2 ? e.x + e.width : e.x
      texts.push(
        <text
          key={key}
          x={ax}
          y={top + e.fontSize * 0.85}
          fontSize={e.fontSize}
          fontWeight={e.type === 'text' && e.fontWeight ? 700 : 400}
          textAnchor={ANCHOR[align]}
          fill="#0f172a"
        >
          {content}
        </text>,
      )
    } else if (e.type === 'barcode') {
      const withText = e.barcodeType.toLowerCase() !== 'qrcode'
      paths.push(barcodePath(e.content, e.x, e.y, e.width, e.height, withText))
      if (withText) {
        texts.push(
          <text
            key={`${key}-t`}
            x={e.x + e.width / 2}
            y={e.y + e.height * 0.97}
            fontSize={Math.min(e.height * 0.2, 24)}
            textAnchor="middle"
            fill="#0f172a"
          >
            {e.content}
          </text>,
        )
      }
    } else if (e.type === 'qrcode') {
      paths.push(qrPath(tpl.id, e.x, e.y, Math.min(e.width, e.height)))
    } else if (e.type === 'shape') {
      shapes.push(
        <rect
          key={key}
          x={e.x}
          y={e.y}
          width={e.width}
          height={e.height}
          fill={e.fillMode === 1 ? '#0f172a' : 'none'}
          stroke={e.fillMode === 1 ? 'none' : '#0f172a'}
          strokeWidth={e.strokeWidth}
        />,
      )
    } else if (e.type === 'table') {
      const cw = e.width / e.tableCols
      const ch = e.height / e.tableRows
      shapes.push(
        <rect
          key={key}
          x={e.x}
          y={e.y}
          width={e.width}
          height={e.height}
          fill="none"
          stroke="#0f172a"
          strokeWidth={e.tableBorderWidth}
        />,
      )
      for (let c = 1; c < e.tableCols; c++) {
        shapes.push(
          <line
            key={`${key}-v${c}`}
            x1={e.x + c * cw}
            y1={e.y}
            x2={e.x + c * cw}
            y2={e.y + e.height}
            stroke="#0f172a"
            strokeWidth={e.tableBorderWidth}
          />,
        )
      }
      for (let r = 1; r < e.tableRows; r++) {
        shapes.push(
          <line
            key={`${key}-h${r}`}
            x1={e.x}
            y1={e.y + r * ch}
            x2={e.x + e.width}
            y2={e.y + r * ch}
            stroke="#0f172a"
            strokeWidth={e.tableBorderWidth}
          />,
        )
      }
      for (let r = 0; r < e.tableRows; r++) {
        for (let c = 0; c < e.tableCols; c++) {
          const cell = e.tableCellContents?.[r]?.[c]
          if (!cell) continue
          texts.push(
            <text
              key={`${key}-${r}-${c}`}
              x={e.x + c * cw + 8}
              y={e.y + r * ch + ch / 2 + e.fontSize * 0.35}
              fontSize={e.fontSize}
              fontWeight={r === 0 ? 700 : 400}
              fill="#0f172a"
            >
              {cell}
            </text>,
          )
        }
      }
    }
  })

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="max-h-full max-w-full"
      style={{ aspectRatio: `${width} / ${height}` }}
      role="img"
      aria-label={`${tpl.name} 缩略图`}
    >
      <defs>
        <clipPath id={clipId}>
          <rect x={0} y={0} width={width} height={height} />
        </clipPath>
      </defs>
      <rect x={0} y={0} width={width} height={height} fill="#ffffff" stroke="#e2e8f0" />
      <g clipPath={`url(#${clipId})`}>
        {shapes}
        <path d={paths.join('')} fill="#0f172a" />
        {texts}
      </g>
    </svg>
  )
}

// ── 缩略图（多零口径）：数据已是本项目原生单位（mm / pt / 度），直接映射 ──
//
// 与上面 TemplateThumb 的区别：那套是「原站单位换算」，这套不需要换算 ——
// mm 直接当 SVG 用户单位用（viewBox 就是纸张 mm 尺寸），字号 pt 按 pt→mm 折算。
// 图标节点用的是归一化后的真实 SVG 资源，直接 <image> 引进来，所见即所得。
const PT_TO_MM = 25.4 / 72

function Y56yThumb({ tpl }: { tpl: Y56yTemplate }) {
  const { widthMm: W, heightMm: H } = tpl
  const clipId = `y56-tpl-clip-${tpl.id}`

  const renderNode = (n: TplNode, i: number) => {
    const key = `${tpl.id}-${i}`
    const rot = (deg: number | undefined, cx: number, cy: number) =>
      deg ? `rotate(${deg} ${cx} ${cy})` : undefined
    switch (n.kind) {
      case 'text': {
        const fsMm = n.fontSizePt * PT_TO_MM
        const boxH = n.hMm ?? fsMm * 1.16
        const cx = n.xMm + n.wMm / 2
        const cy = n.yMm + boxH / 2
        return (
          <text
            key={key}
            x={n.align === 'center' ? cx : n.align === 'right' ? n.xMm + n.wMm : n.xMm}
            y={n.yMm + boxH / 2 + fsMm * 0.36}
            fontSize={fsMm}
            fontWeight={n.bold ? 700 : 400}
            fontStyle={n.italic ? 'italic' : undefined}
            textDecoration={n.underline ? 'underline' : undefined}
            letterSpacing={n.letterSpacingPt ? n.letterSpacingPt * PT_TO_MM : undefined}
            textAnchor={n.align === 'center' ? 'middle' : n.align === 'right' ? 'end' : 'start'}
            fill={n.color ?? '#000000'}
            transform={rot(n.rotateDeg, cx, cy)}
            style={{ whiteSpace: 'pre' }}
          >
            {n.text}
          </text>
        )
      }
      case 'barcode': {
        const is2d = /qrcode|datamatrix|pdf417|aztec|maxicode|hanxin|dotcode|codeone/i.test(n.barcodeType)
        const cx = n.xMm + n.wMm / 2
        const cy = n.yMm + n.hMm / 2
        return (
          <g key={key} transform={rot(n.rotateDeg, cx, cy)}>
            {is2d ? (
              <path
                d={qrPath(`${tpl.id}-${i}`, n.xMm, n.yMm, Math.min(n.wMm, n.hMm))}
                fill={n.fgColor ?? '#000000'}
              />
            ) : (
              <>
                <path
                  d={barcodePath(n.text, n.xMm, n.yMm, n.wMm, n.hMm, !!n.showText)}
                  fill={n.fgColor ?? '#000000'}
                />
                {n.showText && (
                  <text
                    x={cx}
                    y={n.yMm + n.hMm * 0.98}
                    fontSize={Math.min(n.hMm * 0.22, n.wMm * 0.12)}
                    textAnchor="middle"
                    fill={n.fgColor ?? '#000000'}
                  >
                    {n.text}
                  </text>
                )}
              </>
            )}
          </g>
        )
      }
      case 'rect':
        return (
          <rect
            key={key}
            x={n.xMm}
            y={n.yMm}
            width={n.wMm}
            height={n.hMm}
            rx={n.radiusMm || undefined}
            ry={n.radiusMm || undefined}
            fill={n.filled ? n.fillColor ?? '#000000' : 'none'}
            stroke={n.filled ? 'none' : n.strokeColor ?? '#000000'}
            strokeWidth={n.filled ? 0 : Math.max(0.15, n.strokeMm)}
            transform={rot(n.rotateDeg, n.xMm + n.wMm / 2, n.yMm + n.hMm / 2)}
          />
        )
      case 'ellipse':
        return (
          <ellipse
            key={key}
            cx={n.cxMm}
            cy={n.cyMm}
            rx={n.rxMm}
            ry={n.ryMm}
            fill={n.filled ? n.fillColor ?? '#000000' : 'none'}
            stroke={n.filled ? 'none' : n.strokeColor ?? '#000000'}
            strokeWidth={n.filled ? 0 : Math.max(0.15, n.strokeMm ?? 0.3)}
          />
        )
      case 'line':
        return (
          <line
            key={key}
            x1={n.x1Mm}
            y1={n.y1Mm}
            x2={n.x2Mm}
            y2={n.y2Mm}
            stroke={n.color ?? '#000000'}
            strokeWidth={Math.max(0.15, n.strokeMm)}
            strokeDasharray={n.dashed ? `${Math.max(0.3, n.strokeMm) * 3} ${Math.max(0.3, n.strokeMm) * 2}` : undefined}
          />
        )
      case 'image':
        return (
          <image
            key={key}
            href={n.src}
            x={n.xMm}
            y={n.yMm}
            width={n.wMm}
            height={n.hMm}
            preserveAspectRatio={n.keepAspect ? 'xMidYMid meet' : 'none'}
            transform={rot(n.rotateDeg, n.xMm + n.wMm / 2, n.yMm + n.hMm / 2)}
          />
        )
      default:
        return null
    }
  }

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="max-h-full max-w-full"
      style={{ aspectRatio: `${W} / ${H}` }}
      role="img"
      aria-label={`${tpl.name} 缩略图`}
    >
      <defs>
        <clipPath id={clipId}>
          <rect x={0} y={0} width={W} height={H} />
        </clipPath>
      </defs>
      <rect x={0} y={0} width={W} height={H} fill={tpl.bg || '#ffffff'} stroke="#e2e8f0" strokeWidth="0.25" />
      <g clipPath={`url(#${clipId})`}>{tpl.nodes.map(renderNode)}</g>
    </svg>
  )
}
