// 表格编辑器：内容 + 行高/列宽 两个页签
//
// 交互取向：
//   · 不做「双击画布单元格原地编辑」—— fabric 的 Group 内子对象编辑要处理
//     坐标系/焦点/缩放三重问题，收益不抵复杂度；标签里的表格主要是填数据，
//     用对话框按行列平铺编辑更快（Tab 还能顺着往下填）。
//   · 本地 state 持有草稿、每次修改立即回写画布：画布实时预览，但输入框的
//     value 始终来自本地草稿，不会被「父级异步回写」打断光标（本项目文本框
//     就踩过受控回跳的坑，这里从源头上避开）。
//   · 组件只在打开时挂载（App 用条件渲染），所以行列数据天然是新鲜的，
//     不需要 useEffect 同步 props → 也符合仓库「useEffect 内禁止 setState」的规则。
//   · 行高/列宽按**权重**存（见 lib/table.ts），这里只按 mm 输入输出；
//     改一条时总尺寸不变、其余条按比例让位 —— Word 拖分隔线的手感。
import { useState } from 'react'
import { Plus, Minus, Table as TableIcon, Rows3, Columns3, Equal } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  evenWeights,
  normalizeRows,
  resizeTableCols,
  resizeTableRows,
  resizedSpanWeights,
  tableColSpans,
  tableRowSpans,
  type TableSpec,
} from '@/lib/table'

export type TableEditorTab = 'content' | 'size'

interface TableEditorDialogProps {
  open: boolean
  onOpenChange: (v: boolean) => void
  spec: TableSpec
  /** 表格当前总宽/总高（mm）—— 行高列宽按它分配，改一条时总数保持不变 */
  widthMm: number
  heightMm: number
  /** 打开时的页签（面板两个按钮各自直达） */
  initialTab?: TableEditorTab
  /** 内容/尺寸变化时回写画布（会重建表格对象，保持尺寸与位置） */
  onChange: (patch: Partial<TableSpec>) => void
}

export default function TableEditorDialog({
  open,
  onOpenChange,
  spec,
  widthMm,
  heightMm,
  initialTab = 'content',
  onChange,
}: TableEditorDialogProps) {
  const [tab, setTab] = useState<TableEditorTab>(initialTab)
  const [rows, setRows] = useState<string[][]>(() => normalizeRows(spec.rows))

  const nR = rows.length
  const nC = rows[0]?.length ?? 0

  /** 行/列数量变化：内容与权重一起回写（否则新列会沿用旧权重、显得宽窄乱跳） */
  const commitSpec = (next: TableSpec) => {
    setRows(normalizeRows(next.rows))
    onChange({ rows: next.rows, rowWeights: next.rowWeights, colWeights: next.colWeights })
  }

  const commit = (next: string[][]) => {
    setRows(next)
    onChange({ rows: next })
  }

  const setCell = (r: number, c: number, value: string) => {
    const next = rows.map((line, ri) => (ri === r ? line.map((v, ci) => (ci === c ? value : v)) : line))
    commit(next)
  }

  const addRow = () => commitSpec(resizeTableRows(spec, nR + 1))
  const delRow = () => commitSpec(resizeTableRows(spec, nR - 1))
  const addCol = () => commitSpec(resizeTableCols(spec, nC + 1))
  const delCol = () => commitSpec(resizeTableCols(spec, nC - 1))

  const headerRow = spec.headerRow !== false
  const colSpans = tableColSpans(spec, widthMm)
  const rowSpans = tableRowSpans(spec, heightMm)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl gap-3">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5 text-base">
            <TableIcon className="h-4 w-4 text-emerald-600" />
            表格
          </DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            {tab === 'content'
              ? '直接改单元格文字，改完即同步到画布（尺寸与位置不变）。按 Tab 可逐个单元格往下填；空单元格不会打印任何内容。'
              : '改某一列宽/某一行高时，表格总尺寸不变，其余列行按比例让位（与 Word 拖分隔线一致）。最小 2mm。'}
          </DialogDescription>
        </DialogHeader>

        {/* 页签 */}
        <div className="flex items-center gap-1 rounded-md bg-muted/60 p-1">
          {(
            [
              ['content', '单元格内容'],
              ['size', '行高 / 列宽'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              className={
                'flex-1 rounded px-2 py-1 text-xs font-medium transition ' +
                (tab === k ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground')
              }
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'content' ? (
          <>
            {/* 单元格网格：table-fixed 让每列等宽，与画布上的「均分」一致 */}
            <div className="max-h-[52vh] overflow-auto rounded-md border p-1">
              <table className="w-full table-fixed border-collapse">
                <colgroup>
                  {colSpans.map((w, i) => (
                    <col key={i} style={{ width: `${(w / Math.max(0.01, widthMm)) * 100}%` }} />
                  ))}
                </colgroup>
                <tbody>
                  {rows.map((line, r) => (
                    <tr key={r}>
                      {line.map((v, c) => (
                        <td key={c} className="border p-0">
                          <input
                            value={v}
                            onChange={(e) => setCell(r, c, e.target.value)}
                            placeholder={headerRow && r === 0 ? `列 ${c + 1}` : ''}
                            className={
                              'h-9 w-full min-w-0 bg-transparent px-2 text-xs outline-none focus:bg-blue-50/60 ' +
                              (headerRow && r === 0 ? 'font-semibold' : '')
                            }
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <div className="space-y-3">
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  <Columns3 className="h-3.5 w-3.5" />
                  列宽 · 总宽 {widthMm.toFixed(1)}mm
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 px-1.5 text-[11px]"
                  onClick={() => onChange({ colWeights: evenWeights(nC) })}
                >
                  <Equal className="h-3 w-3" />
                  均分
                </Button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {colSpans.map((w, i) => (
                  <SpanField
                    key={`c${i}`}
                    label={`列 ${i + 1}`}
                    value={w}
                    total={widthMm}
                    onChange={(v) =>
                      onChange({ colWeights: resizedSpanWeights(spec.colWeights, nC, i, v, widthMm) })
                    }
                  />
                ))}
              </div>
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  <Rows3 className="h-3.5 w-3.5" />
                  行高 · 总高 {heightMm.toFixed(1)}mm
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 px-1.5 text-[11px]"
                  onClick={() => onChange({ rowWeights: evenWeights(nR) })}
                >
                  <Equal className="h-3 w-3" />
                  均分
                </Button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {rowSpans.map((h, i) => (
                  <SpanField
                    key={`r${i}`}
                    label={`行 ${i + 1}`}
                    value={h}
                    total={heightMm}
                    onChange={(v) =>
                      onChange({ rowWeights: resizedSpanWeights(spec.rowWeights, nR, i, v, heightMm) })
                    }
                  />
                ))}
              </div>
            </div>

            <p className="text-[10px] leading-relaxed text-muted-foreground">
              表格整体宽高仍在右侧「位置与尺寸」里改；改完各列行会按当前比例一起缩放。
              想把整表拉成 1:1 也可直接拖表格角上的控制点（字号不变）。
            </p>
          </div>
        )}

        {tab === 'content' && (
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <span className="tabular-nums">
              共 {nR} 行 × {nC} 列
            </span>
            <div className="flex-1" />
            <div className="flex items-center gap-1">
              <span className="text-[10px]">行</span>
              <Button variant="outline" size="icon-sm" onClick={delRow} disabled={nR <= 1} title="删一行（末尾）">
                <Minus className="h-3.5 w-3.5" />
              </Button>
              <Button variant="outline" size="icon-sm" onClick={addRow} title="加一行（末尾）">
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-[10px]">列</span>
              <Button variant="outline" size="icon-sm" onClick={delCol} disabled={nC <= 1} title="删一列（末尾）">
                <Minus className="h-3.5 w-3.5" />
              </Button>
              <Button variant="outline" size="icon-sm" onClick={addCol} title="加一列（末尾）">
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button size="sm" onClick={() => onOpenChange(false)}>
            完成
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * 一个「列宽 / 行高」数字框（mm）。
 *
 * 用「可归属草稿」而不是受控 value 直读：表格每次改尺寸都会**重建对象**并回写 props，
 * 直接受控会出现「输入 1 后想输 0，值被父级重算的 1.0 顶掉」。草稿只在
 * `forValue === value`（即这次显示的字面值正是自己造成的）时生效，外部改值自动联动。
 * 不依赖 useEffect 同步（本仓库 eslint 禁止 effect 内 setState）。
 */
function SpanField({
  label,
  value,
  total,
  onChange,
}: {
  label: string
  value: number
  total: number
  onChange: (mm: number) => void
}) {
  const [draft, setDraft] = useState<{ text: string; forValue: number } | null>(null)
  const shown = draft && draft.forValue === value ? draft.text : value.toFixed(1)
  const max = Math.max(2, total - 2)

  const commit = (raw: string, normalize: boolean) => {
    const n = parseFloat(raw)
    if (!Number.isFinite(n)) {
      setDraft(normalize ? null : { text: raw, forValue: value })
      return
    }
    const v = Math.min(max, Math.max(2, n))
    setDraft(normalize ? null : { text: raw, forValue: v })
    if (Math.abs(v - value) > 0.001) onChange(v)
  }

  return (
    <label className="flex w-[5.2rem] flex-col gap-0.5 rounded-md border px-1.5 py-1 focus-within:ring-2 focus-within:ring-ring/40">
      <span className="text-[10px] leading-none text-muted-foreground">{label}</span>
      <span className="flex items-baseline gap-0.5">
        <input
          type="number"
          min={2}
          step={0.5}
          value={shown}
          onChange={(e) => commit(e.target.value, false)}
          onBlur={(e) => commit(e.target.value, true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              commit((e.target as HTMLInputElement).value, true)
              ;(e.target as HTMLInputElement).blur()
            }
          }}
          className="w-full min-w-0 bg-transparent text-xs tabular-nums outline-none"
        />
        <span className="text-[10px] text-muted-foreground">mm</span>
      </span>
    </label>
  )
}
