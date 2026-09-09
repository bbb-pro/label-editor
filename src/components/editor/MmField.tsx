// 通用 mm 数值输入（带后缀与失焦提交）
// 使用本地输入态：仅在失焦/外部值变更且未聚焦时同步 props，避免受控输入在逐键提交时被
// 父级 re-render 覆盖，导致“输入 90 却跳成别的数字”的抖动。
import { useEffect, useRef, useState } from 'react'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'

interface MmFieldProps {
  label: string
  value: number
  suffix?: string
  onChange: (v: number) => void
  step?: number
  disabled?: boolean
}

export default function MmField({
  label,
  value,
  suffix = 'mm',
  onChange,
  step = 0.1,
  disabled,
}: MmFieldProps) {
  const focused = useRef(false)
  const [text, setText] = useState<string>(() =>
    Number.isFinite(value) ? String(value) : '',
  )

  // 外部值变化且当前未聚焦时，跟随同步（例如选择其它对象、撤销后回显）
  useEffect(() => {
    if (!focused.current) setText(Number.isFinite(value) ? String(value) : '')
  }, [value])

  const commit = (raw: string) => {
    const n = parseFloat(raw)
    if (!Number.isNaN(n)) onChange(n)
  }

  return (
    <div className="flex flex-col gap-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <div className="relative">
        <Input
          type="number"
          step={step}
          value={text}
          disabled={disabled}
          onFocus={() => {
            focused.current = true
          }}
          onChange={(e) => {
            const v = e.target.value
            setText(v)
            commit(v)
          }}
          onBlur={() => {
            focused.current = false
            // 失焦后回显为实际生效值（去掉多余的“9.”之类中间态）
            setText(Number.isFinite(value) ? String(value) : '')
          }}
          className="h-8 pr-9 text-xs tabular-nums"
        />
        <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-[11px] text-muted-foreground">
          {suffix}
        </span>
      </div>
    </div>
  )
}
