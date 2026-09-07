// 底部数据坞：上传数据表 + 变量预览表格（顶部可拖拽调整高度）
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { Button } from '@/components/ui/button'
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area'
import { FileSpreadsheet, Table2, ChevronLeft, ChevronRight, ChevronUp, ChevronDown, GripHorizontal } from 'lucide-react'
import type { DataRow } from '@/types/template'
import { cn } from '@/lib/utils'

interface DataDockProps {
  fileName: string | null
  headers: string[]
  rows: DataRow[]
  currentIndex: number
  usedVariables: string[]
  onPickFile: (f: File) => void
  onSelectRow: (idx: number) => void
  onClearData: () => void
}

const DOCK_H_KEY = 'label-editor.dockH'
const DOCK_COLLAPSED_KEY = 'label-editor.dockCollapsed'
const DEFAULT_H = 150
const MIN_H = 120
const MAX_H = 380

export default function DataDock(props: DataDockProps) {
  const { fileName, headers, rows, currentIndex, usedVariables, onPickFile, onSelectRow, onClearData } =
    props
  const hasData = rows.length > 0
  // 可拖拽高度（记忆上次值）
  const [dockH, setDockH] = useState<number>(() => {
    const saved = Number(localStorage.getItem(DOCK_H_KEY))
    return Number.isFinite(saved) ? Math.min(MAX_H, Math.max(MIN_H, saved)) : DEFAULT_H
  })
  const dragging = useRef(false)
  useEffect(() => {
    const store = () => localStorage.setItem(DOCK_H_KEY, String(dockH))
    store()
  }, [dockH])
  // 折叠/展开（默认收起成一条细条，需要时点开；用户手动改后记住状态）
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    const saved = localStorage.getItem(DOCK_COLLAPSED_KEY)
    return saved === null ? true : saved === '1'
  })
  useEffect(() => {
    localStorage.setItem(DOCK_COLLAPSED_KEY, collapsed ? '1' : '0')
  }, [collapsed])
  const toggle = useCallback(() => setCollapsed((v) => !v), [])

  const onDragStart = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    dragging.current = true
    e.currentTarget.setPointerCapture(e.pointerId)
  }, [])
  const onDragMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return
    // 用视口坐标差换算高度变化（指针在顶部拖动）
    const next = window.innerHeight - e.clientY
    setDockH(Math.min(MAX_H, Math.max(MIN_H, next)))
  }, [])
  const onDragEnd = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    dragging.current = false
    e.currentTarget.releasePointerCapture?.(e.pointerId)
  }, [])

  // 收起状态：只显示一条细条，需要时点开
  if (collapsed) {
    return (
      <footer className="flex h-9 shrink-0 items-center gap-2 border-t bg-background px-3">
        <button
          type="button"
          onClick={toggle}
          className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent"
          title="展开数据栏"
        >
          <ChevronUp className="h-4 w-4" />
          <span>数据栏</span>
        </button>
        {fileName && <span className="truncate text-xs text-muted-foreground">{fileName} · {rows.length} 行</span>}
        <div className="flex-1" />
        <button
          type="button"
          onClick={toggle}
          className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent"
          title="展开数据栏"
        >
          展开
          <ChevronUp className="h-4 w-4" />
        </button>
      </footer>
    )
  }

  return (
    <footer
      className="relative flex shrink-0 flex-col border-t bg-background"
      style={{ height: dockH }}
    >
      {/* 顶部拖拽把手 */}
      <div
        role="separator"
        aria-label="拖动调整数据栏高度"
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        className="group flex h-2.5 shrink-0 cursor-row-resize touch-none items-center justify-center border-b border-transparent transition-colors hover:border-slate-300"
        style={{ touchAction: 'none' }}
      >
        <GripHorizontal className="h-3 w-3 text-slate-300 transition-colors group-hover:text-slate-400" />
      </div>
      {/* 工具行 */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <FileSpreadsheet className="h-4 w-4 text-emerald-600" />
        <label className="cursor-pointer">
          <input
            type="file"
            accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) onPickFile(f)
              e.target.value = ''
            }}
          />
          <Button variant="outline" size="sm">
            上传 Excel / CSV
          </Button>
        </label>

        {fileName && (
          <span className="truncate text-xs text-muted-foreground">
            {fileName} · {rows.length} 行
          </span>
        )}
        {usedVariables.length > 0 && (
          <span className="hidden rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-600 md:inline">
            检测到 {usedVariables.length} 个变量
          </span>
        )}

        <div className="flex-1" />

        {/* 行导航 */}
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={!hasData || currentIndex <= 0}
            onClick={() => onSelectRow(currentIndex - 1)}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-16 text-center text-xs tabular-nums text-muted-foreground">
            {hasData ? `第 ${currentIndex + 1} / ${rows.length} 行` : '无数据'}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={!hasData || currentIndex >= rows.length - 1}
            onClick={() => onSelectRow(currentIndex + 1)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>

        {hasData && (
          <Button variant="ghost" size="sm" onClick={onClearData}>
            清空
          </Button>
        )}
        <Button variant="ghost" size="icon-sm" onClick={toggle} title="收起数据栏">
          <ChevronDown className="h-4 w-4" />
        </Button>
      </div>

      {/* 表格预览 */}
      <ScrollArea className="min-h-0 flex-1">
        {!hasData ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-muted-foreground">
            <Table2 className="h-5 w-5 opacity-40" />
            <p className="text-xs">
              上传数据表后点击行即可预览，画布中 {'{{字段}}'} 变量会自动替换
            </p>
          </div>
        ) : (
          <div className="h-full w-full min-w-max">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="sticky top-0 bg-muted/80 backdrop-blur">
                  <th className="w-10 border-b px-2 py-1.5 text-left font-medium text-muted-foreground">#</th>
                  {headers.map((h) => (
                    <th
                      key={h}
                      className="whitespace-nowrap border-b px-2 py-1.5 text-left font-medium text-muted-foreground"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr
                    key={i}
                    onClick={() => onSelectRow(i)}
                    className={cn(
                      'cursor-pointer border-b transition-colors',
                      i === currentIndex
                        ? 'bg-blue-50 text-blue-900'
                        : 'hover:bg-muted/40',
                    )}
                  >
                    <td className="px-2 py-1 tabular-nums text-muted-foreground">{i + 1}</td>
                    {headers.map((h) => (
                      <td key={h} className="whitespace-nowrap px-2 py-1">
                        {row[h] ?? ''}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    </footer>
  )
}
