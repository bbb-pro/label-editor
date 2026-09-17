// 模板库对话框：展示公开标签模板，点击即按模板新建标签
//
// 缩略图不是截图，而是**用模板数据现画 SVG** —— 数据是矢量定义（矩形/文字/
// 条码区域），直接映射成 SVG 基本图元即可，既零请求又永远与真实落盘结果一致。
// 缩略图只求"一眼认出是哪种标签"，所以条码/二维码用确定性的伪随机图案示意
// （seed 取自内容，同一模板每次渲染都一样），不真的去调 bwip-js 编码。
import { useMemo, useState, type ReactNode } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { LayoutTemplate } from 'lucide-react'
import {
  TEMPLATE_LIBRARY,
  TPL_CATEGORIES,
  categoryNameOf,
  type LibTemplate,
  type TplCategory,
} from '@/lib/templateLibrary'

interface TemplateLibraryProps {
  open: boolean
  onOpenChange: (v: boolean) => void
  /** 选中某个模板（由 App 负责落盘 + 提示） */
  onPick: (tpl: LibTemplate) => void
}

type Filter = 'all' | TplCategory

export default function TemplateLibrary({ open, onOpenChange, onPick }: TemplateLibraryProps) {
  const [filter, setFilter] = useState<Filter>('all')

  const list = useMemo(
    () => (filter === 'all' ? TEMPLATE_LIBRARY : TEMPLATE_LIBRARY.filter((t) => t.industry === filter)),
    [filter],
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5 text-base">
            <LayoutTemplate className="h-4 w-4 text-blue-600" />
            模板库
          </DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            点选一个模板即按它的尺寸与版式新建标签（当前画布内容会被替换，可用 Ctrl+Z 撤销）。
            共 {TEMPLATE_LIBRARY.length} 个行业模板。
          </DialogDescription>
        </DialogHeader>

        {/* 行业筛选 */}
        <div className="flex flex-wrap gap-1">
          <Chip active={filter === 'all'} onClick={() => setFilter('all')}>
            全部 {TEMPLATE_LIBRARY.length}
          </Chip>
          {TPL_CATEGORIES.map((c) => {
            const n = TEMPLATE_LIBRARY.filter((t) => t.industry === c.code).length
            return (
              <Chip key={c.code} active={filter === c.code} onClick={() => setFilter(c.code)}>
                {c.name} {n}
              </Chip>
            )
          })}
        </div>

        {/* 模板网格 */}
        <div className="-mx-1 max-h-[52vh] overflow-y-auto px-1 py-1">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {list.map((tpl) => (
              <button
                key={tpl.id}
                type="button"
                onClick={() => onPick(tpl)}
                title={`使用「${tpl.name}」（${tpl.size}）`}
                className="group flex flex-col gap-1.5 rounded-lg border bg-card p-2 text-left transition-colors hover:border-blue-500 hover:bg-blue-50/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <div className="flex h-24 items-center justify-center rounded-md bg-slate-100 p-1.5">
                  <TemplateThumb tpl={tpl} />
                </div>
                <div className="flex items-center gap-1">
                  <span className="truncate text-xs font-medium">{tpl.name}</span>
                  <span className="ml-auto shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                    {tpl.size}
                  </span>
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {categoryNameOf(tpl.industry)}
                </div>
              </button>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

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
