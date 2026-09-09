// 批量份数对话框：批量打印 / 批量导出 PDF 前询问份数
import { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Hash } from 'lucide-react'
import { formatSeq } from '@/lib/canvasEngine'
import type { SerialSpec } from '@/types/editor'

interface BatchDialogProps {
  open: boolean
  onOpenChange: (v: boolean) => void
  /** 标题，如「批量打印」/「批量导出 PDF」 */
  title: string
  /** 副标题说明 */
  description: string
  /** 默认份数 */
  defaultCopies: number
  /** 单份上限（防止一次渲染过大） */
  maxCopies?: number
  /** 确认按钮文案 */
  confirmLabel: string
  /** 画布上生效的序列化配置（用于实时预览首/末序号） */
  serial?: SerialSpec | null
  /** 渲染中：禁用确认并提示 */
  busy?: boolean
  /** 按表格行批量模式：询问打印行数（而非份数） */
  rowsMode?: boolean
  /** 数据总行数（rowsMode 时作为上限与预览用） */
  totalRows?: number
  onConfirm: (copies: number) => void
}

export default function BatchDialog({
  open,
  onOpenChange,
  title,
  description,
  defaultCopies,
  maxCopies = 2000,
  confirmLabel,
  serial,
  busy = false,
  rowsMode = false,
  totalRows = 0,
  onConfirm,
}: BatchDialogProps) {
  const [copies, setCopies] = useState(String(defaultCopies))

  // 每次打开按当前配置重置
  useEffect(() => {
    if (open) setCopies(String(defaultCopies))
  }, [open, defaultCopies])

  const ceiling = rowsMode ? Math.max(1, totalRows) : maxCopies
  const parsed = parseInt(copies, 10)
  const valid = Number.isFinite(parsed) && parsed >= 1 && parsed <= ceiling

  // 实时预览首/末序号（无序列化配置或不显示）
  const preview = (() => {
    if (rowsMode || !serial?.enabled || !valid) return null
    const step = Math.max(1, serial.step)
    const first = formatSeq(serial.start, serial.minDigits)
    const last = formatSeq(serial.start + (parsed - 1) * step, serial.minDigits)
    return { first, last, count: parsed }
  })()

  // 行模式预览：第 1 行 ~ 第 N 行
  const rowPreview =
    rowsMode && valid
      ? { from: 1, to: parsed, total: totalRows }
      : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5 text-base">
            <Hash className="h-4 w-4 text-amber-600" />
            {title}
          </DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            {description}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 py-2">
          <label className="flex items-center gap-2">
            <span className="w-16 shrink-0 text-xs text-muted-foreground">
              {rowsMode ? '打印行数' : '打印份数'}
            </span>
            <input
              type="number"
              min={1}
              max={ceiling}
              value={copies}
              onChange={(e) => setCopies(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && valid) onConfirm(parsed)
              }}
              autoFocus
              className="h-8 w-full rounded-md border bg-background px-2 text-xs tabular-nums focus:outline-none focus:ring-2 focus:ring-ring/40"
            />
          </label>
          {rowPreview && (
            <p className="rounded-md bg-amber-50 px-2 py-1.5 text-[11px] leading-relaxed text-amber-800">
              将打印第 <b className="font-mono">1</b> 行 ~ 第 <b className="font-mono">{rowPreview.to}</b> 行，共 {rowPreview.to} 张（共 {rowPreview.total} 行数据）。
            </p>
          )}
          {!rowsMode && preview && (
            <p className="rounded-md bg-amber-50 px-2 py-1.5 text-[11px] leading-relaxed text-amber-800">
              序号从 <b className="font-mono">{preview.first}</b> 开始，到{' '}
              <b className="font-mono">{preview.last}</b> 结束，共 {preview.count} 张。
            </p>
          )}
          {!valid && (
            <p className="text-[11px] text-destructive">
              请输入 1 – {ceiling} 之间的整数。
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button size="sm" disabled={!valid || busy} onClick={() => onConfirm(parsed)}>
            {busy ? '渲染中…' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
