// 表格单元格内容编辑器
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
import { useState } from 'react'
import { Plus, Minus, Table as TableIcon } from 'lucide-react'
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
  normalizeRows,
  resizeTableCols,
  resizeTableRows,
  type TableSpec,
} from '@/lib/table'

interface TableEditorDialogProps {
  open: boolean
  onOpenChange: (v: boolean) => void
  spec: TableSpec
  /** 内容变化时回写画布（会重建表格对象，保持尺寸与位置） */
  onChange: (patch: Partial<TableSpec>) => void
}

export default function TableEditorDialog({ open, onOpenChange, spec, onChange }: TableEditorDialogProps) {
  const [rows, setRows] = useState<string[][]>(() => normalizeRows(spec.rows))

  const commit = (next: string[][]) => {
    setRows(next)
    onChange({ rows: next })
  }

  const setCell = (r: number, c: number, value: string) => {
    const next = rows.map((line, ri) => (ri === r ? line.map((v, ci) => (ci === c ? value : v)) : line))
    commit(next)
  }

  const addRow = () => commit(resizeTableRows({ rows }, rows.length + 1).rows)
  const delRow = () => commit(resizeTableRows({ rows }, rows.length - 1).rows)
  const addCol = () => commit(resizeTableCols({ rows }, rows[0].length + 1).rows)
  const delCol = () => commit(resizeTableCols({ rows }, rows[0].length - 1).rows)

  const nR = rows.length
  const nC = rows[0]?.length ?? 0
  const headerRow = spec.headerRow !== false

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl gap-3">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5 text-base">
            <TableIcon className="h-4 w-4 text-emerald-600" />
            编辑表格内容
          </DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            直接改单元格文字，改完即同步到画布（尺寸与位置不变）。按 <kbd className="rounded border px-1">Tab</kbd>{' '}
            可逐个单元格往下填；空单元格不会打印任何内容。
          </DialogDescription>
        </DialogHeader>

        {/* 单元格网格：table-fixed 让每列等宽，与画布上的「均分」一致 */}
        <div className="max-h-[52vh] overflow-auto rounded-md border p-1">
          <table className="w-full table-fixed border-collapse">
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

        <DialogFooter>
          <Button size="sm" onClick={() => onOpenChange(false)}>
            完成
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
