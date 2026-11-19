// 日期选择对话框：双击画布上的日期对象 / 属性面板「选择日期」按钮打开。
// 用原生 <input type="date"> + 常用快捷按钮，兼容性好、移动端也能用；
// 不使用第三方日历库（依赖克制）。
import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { parseDateValue, todayValue, formatDate } from '@/lib/dateSpec'

interface DatePickerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 当前日期值 YYYY-MM-DD */
  value: string
  /** 确认选择 */
  onCommit: (value: string) => void
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

/** 生成当月日历格子（前后补空白对齐周一/周日） */
function monthGrid(year: number, month: number): Array<number | null> {
  const first = new Date(year, month, 1).getDay()
  const days = new Date(year, month + 1, 0).getDate()
  const cells: Array<number | null> = Array(first).fill(null)
  for (let d = 1; d <= days; d++) cells.push(d)
  while (cells.length % 7 !== 0) cells.push(null)
  return cells
}

export default function DatePickerDialog({ open, onOpenChange, value, onCommit }: DatePickerDialogProps) {
  const parsed = parseDateValue(value) ?? new Date()
  const [draft, setDraft] = useState(value || todayValue())
  const [viewY, setViewY] = useState(parsed.getFullYear())
  const [viewM, setViewM] = useState(parsed.getMonth())

  // 初值只在组件挂载时取一次。App 端用 key={targetId + value} 让每次打开都重新挂载，
  // 因此这里天然拿到最新值，且不在 effect 里 setState（本仓库 eslint 禁止）。
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n))
  const iso = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`
  const cells = monthGrid(viewY, viewM)
  const today = todayValue()

  const shiftMonth = (delta: number) => {
    const t = new Date(viewY, viewM + delta, 1)
    setViewY(t.getFullYear())
    setViewM(t.getMonth())
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[340px]">
        <DialogHeader>
          <DialogTitle className="text-sm">选择日期</DialogTitle>
          <DialogDescription className="text-xs">
            选好后日期对象按上方设定的格式显示；若设了关联公式，则以公式结果为准。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {/* 原生日期输入：移动端可直接调系统日期控件 */}
          <div className="flex items-center gap-2">
            <span className="w-12 shrink-0 text-[11px] text-muted-foreground">日期</span>
            <input
              type="date"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value)
                const d = parseDateValue(e.target.value)
                if (d) {
                  setViewY(d.getFullYear())
                  setViewM(d.getMonth())
                }
              }}
              className="h-9 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm"
            />
          </div>

          {/* 月历 */}
          <div className="rounded-md border p-2">
            <div className="mb-2 flex items-center justify-between">
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => shiftMonth(-1)}>
                ‹
              </Button>
              <span className="text-xs font-medium">
                {viewY} 年 {viewM + 1} 月
              </span>
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => shiftMonth(1)}>
                ›
              </Button>
            </div>
            <div className="grid grid-cols-7 gap-0.5 text-center">
              {WEEKDAYS.map((w) => (
                <span key={w} className="py-1 text-[10px] text-muted-foreground">
                  {w}
                </span>
              ))}
              {cells.map((d, i) => {
                if (d == null) return <span key={`e${i}`} />
                const isoDate = iso(viewY, viewM, d)
                const selected = isoDate === draft
                const isToday = isoDate === today
                return (
                  <Button
                    key={isoDate}
                    variant={selected ? 'default' : 'ghost'}
                    size="sm"
                    className={`h-8 w-full p-0 text-xs ${isToday && !selected ? 'ring-1 ring-primary/40' : ''}`}
                    onClick={() => setDraft(isoDate)}
                    title={formatDate(new Date(viewY, viewM, d), 'yyyy年M月d日 dddd')}
                  >
                    {d}
                  </Button>
                )
              })}
            </div>
          </div>

          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="h-8 flex-1 text-xs" onClick={() => setDraft(today)}>
              今天
            </Button>
            <Button variant="outline" size="sm" className="h-8 flex-1 text-xs" onClick={() => setDraft('')}>
              清空
            </Button>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button size="sm" onClick={() => { onCommit(draft); onOpenChange(false) }}>
            确定
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
