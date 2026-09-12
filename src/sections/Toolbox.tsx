// 左侧工具箱：文本 / 条码（默认 Code128，42 种码制在属性面板切换）/ 形状（子菜单）/ 图片
import { useEffect, useRef, useState, type RefObject } from 'react'
import {
  Type,
  Barcode,
  Shapes,
  Square,
  Minus,
  Circle as CircleIcon,
  Triangle as TriangleIcon,
  Diamond as DiamondIcon,
  Star as StarIcon,
  ImageUp,
  Sparkles,
} from 'lucide-react'
import type { ToolType } from '@/types/template'
import { cn } from '@/lib/utils'

interface ToolboxProps {
  tool: ToolType | null
  onToolChange: (t: ToolType) => void
  onPickImage: (file: File) => void
  /** 打开素材库面板（本地 CC0 图标 / 表情） */
  onOpenAssets: () => void
}

/** 形状子项（对应 App 里的 tool 分支） */
const shapeItems: { key: ToolType; label: string; Icon: typeof Square }[] = [
  { key: 'rect', label: '矩形', Icon: Square },
  { key: 'line', label: '直线', Icon: Minus },
  { key: 'shape-ellipse', label: '椭圆', Icon: CircleIcon },
  { key: 'shape-triangle', label: '三角形', Icon: TriangleIcon },
  { key: 'shape-diamond', label: '菱形', Icon: DiamondIcon },
  { key: 'shape-star', label: '五角星', Icon: StarIcon },
]

/** 固定按钮：直接触发 add */
const fixedItems: { key: ToolType; label: string; Icon: typeof Type; hint?: string }[] = [
  { key: 'text', label: '文本', Icon: Type },
  {
    key: 'barcode-code128',
    label: '条码/二维码',
    Icon: Barcode,
    hint: '插入条码 / 二维码（默认 Code128，码制在属性面板切换）',
  },
]

function baseBtn(active: boolean) {
  return cn(
    'relative mb-1 flex h-11 w-11 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
    active && 'bg-primary/10 text-primary ring-1 ring-primary/30 hover:bg-primary/10 hover:text-primary',
  )
}

function ToolBtn({
  label,
  Icon,
  active = false,
  onClick,
  badge,
  hint,
  btnRef,
  triggerAttr,
}: {
  label: string
  Icon: typeof Type
  active?: boolean
  onClick: () => void
  badge?: string
  /** 悬浮提示；不传则用 label */
  hint?: string
  btnRef?: RefObject<HTMLButtonElement | null>
  /** 透传到按钮根元素的自定义属性（如 data-assets-trigger） */
  triggerAttr?: Record<string, string>
}) {
  return (
    <button
      type="button"
      title={hint ?? label}
      ref={btnRef}
      onClick={onClick}
      {...triggerAttr}
      className={cn(baseBtn(active), 'h-11')}
    >
      <Icon className="h-5 w-5" />
      {badge ? (
        <span className="absolute inset-x-0 bottom-0.5 whitespace-nowrap text-center text-[8px] font-semibold leading-none text-muted-foreground">
          {badge}
        </span>
      ) : (
        // 文字较长（如「条码/二维码」）时自动降到 8px，避免溢出 44px 宽的按钮
        <span
          className={
            'absolute inset-x-0 bottom-0.5 whitespace-nowrap text-center leading-none ' +
            (label.length >= 4 ? 'text-[8px]' : 'text-[9px] font-medium')
          }
        >
          {label}
        </span>
      )}
    </button>
  )
}

export default function Toolbox(props: ToolboxProps) {
  const { onToolChange, onPickImage, onOpenAssets } = props
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // 打开时计算弹出位置（相对视口 fixed，绕开 aside overflow 裁剪）；关/滚/Escape 关闭
  const openMenu = () => {
    const b = btnRef.current
    if (!b) return
    const r = b.getBoundingClientRect()
    setPos({ left: r.right + 4, top: r.top })
    setOpen(true)
  }
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return
      if (btnRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    const onScroll = () => setOpen(false)
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open])

  const pickShape = (key: ToolType) => {
    setOpen(false)
    onToolChange(key)
  }

  return (
    <>
      <aside className="flex w-14 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r bg-muted/40 py-2">
        {/* 固定工具：文本 / 条码 */}
        {fixedItems.map(({ key, label, Icon, hint }) => (
          <ToolBtn
            key={key}
            label={label}
            hint={hint}
            Icon={Icon}
            onClick={() => onToolChange(key)}
          />
        ))}

        {/* 形状：父按钮 → 子菜单（fixed 弹出，不被 rail 裁剪） */}
        <ToolBtn
          label="形状"
          Icon={Shapes}
          active={open}
          btnRef={btnRef}
          onClick={openMenu}
        />

        {/* 素材库：图标 / 表情 */}
        <ToolBtn label="素材" Icon={Sparkles} onClick={onOpenAssets} triggerAttr={{ 'data-assets-trigger': '' }} />

        {/* 图片上传 */}
        <ToolBtn label="图片" Icon={ImageUp} onClick={() => fileRef.current?.click()} />
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) onPickImage(f)
            e.target.value = ''
          }}
        />
      </aside>

      {/* 固定定位的形状菜单（置于 aside 之外，避免 overflow 裁剪） */}
      {open && pos && (
        <div
          ref={menuRef}
          style={{ left: pos.left, top: pos.top }}
          className="fixed z-50 flex flex-col rounded-lg border bg-background p-1 shadow-lg"
        >
          {shapeItems.map(({ key, label, Icon }) => (
            <button
              key={key}
              type="button"
              onClick={() => pickShape(key)}
              className="flex h-9 w-32 items-center gap-2 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </button>
          ))}
        </div>
      )}
    </>
  )
}
