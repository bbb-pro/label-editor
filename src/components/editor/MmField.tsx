// 通用 mm 数值输入（带后缀与失焦提交）
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
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <div className="relative">
        <Input
          type="number"
          step={step}
          value={Number.isFinite(value) ? value : ''}
          disabled={disabled}
          onChange={(e) => {
            const n = parseFloat(e.target.value)
            if (!Number.isNaN(n)) onChange(n)
          }}
          onBlur={() => {}}
          className="h-8 pr-9 text-xs tabular-nums"
        />
        <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-[11px] text-muted-foreground">
          {suffix}
        </span>
      </div>
    </div>
  )
}
