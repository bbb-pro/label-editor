// 底部数据坞：上传数据表 + 变量预览表格（顶部可拖拽调整高度）
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { Button } from '@/components/ui/button'
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area'
import { FileSpreadsheet, Table2, ChevronLeft, ChevronRight, ChevronUp, ChevronDown, GripHorizontal, Upload } from 'lucide-react'
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
const ACCEPT =
  '.csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel'

export default function DataDock(props: DataDockProps) {
  const { fileName, headers, rows, currentIndex, usedVariables, onPickFile, onSelectRow, onClearData } =
    props
  const hasData = rows.length > 0
  const inputRef = useRef<HTMLInputElement>(null)
  const dragging = useRef(false)
  const [isDragging, setIsDragging] = useState(false)

  // 统一触发文件选择（不依赖 <label> 转发：<button> 在 label 内会吞掉 click，
  // 导致文件框不弹出，这就是「点击上传没用」的根因。改用 ref.click() 可靠触发）
  const openPicker = useCallback(() => inputRef.current?.click(), [])
  const handleFiles = useCallback(
    (f: File | null | undefined) => {
      if (f) onPickFile(f)
    },
    [onPickFile],
  )

  // 可拖拽高度（记忆上次值）
  const [dockH, setDockH] = useState<number>(() => {
    const saved = Number(localStorage.getItem(DOCK_H_KEY))
    return Number.isFinite(saved) ? Math.min(MAX_H, Math.max(MIN_H, saved)) : DEFAULT_H
  })
  useEffect(() => {
    localStorage.setItem(DOCK_H_KEY, String(dockH))
  }, [dockH])
  // 折叠/展开（默认展开，确保上传入口始终可见）
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    const saved = localStorage.getItem(DOCK_COLLAPSED_KEY)
    return saved === null ? false : saved === '1'
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
    const next = window.innerHeight - e.clientY
    setDockH(Math.min(MAX_H, Math.max(MIN_H, next)))
  }, [])
  const onDragEnd = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    dragging.current = false
    e.currentTarget.releasePointerCapture?.(e.pointerId)
  }, [])

  // 拖拽文件上传（在展开态数据栏上松开即可）
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setIsDragging(false)
      const f = e.dataTransfer.files?.[0]
      handleFiles(f)
    },
    [handleFiles],
  )
  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    if (!isDragging) setIsDragging(true)
  }, [isDragging])
  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
  }, [])

  // 隐藏的文件输入：始终挂载，collapsed / 展开态共用同一 ref
  const fileInput = (
    <input
      ref={inputRef}
      type="file"
      accept={ACCEPT}
      className="hidden"
      onChange={(e) => {
        handleFiles(e.target.files?.[0])
        e.target.value = ''
      }}
    />
  )

  // 收起状态：只显示一条细条，需要时点开；同时保留快捷上传入口
  if (collapsed) {
    return (
      <>
        {fileInput}
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
          {fileName && (
            <span className="truncate text-xs text-muted-foreground">{fileName} · {rows.length} 行</span>
          )}
          <div className="flex-1" />
          <Button variant="ghost" size="sm" onClick={openPicker} title="上传 Excel / CSV">
            <Upload className="mr-1 h-4 w-4" />
            <span>上传数据</span>
          </Button>
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
      </>
    )
  }

  return (
    <>
      {fileInput}
      <footer
        className={cn(
          'relative flex shrink-0 flex-col border-t bg-background transition-shadow',
          isDragging && 'ring-2 ring-blue-400 ring-offset-1',
        )}
        style={{ height: dockH }}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
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
          <Button variant="outline" size="sm" onClick={openPicker}>
            <Upload className="mr-1 h-4 w-4" />
            上传 Excel / CSV
          </Button>

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
              <p className="text-[11px] text-muted-foreground/70">
                也可直接将文件拖拽到此处
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
    </>
  )
}
