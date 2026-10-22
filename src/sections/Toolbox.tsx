// 左侧工具箱：文本 / 条码（默认 Code128，42 种码制在属性面板切换）/ 形状（子菜单）/ 图片
import { useEffect, useRef, useState, type RefObject } from 'react'
import {
  Type,
  Pilcrow,
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
  Table as TableIcon,
} from 'lucide-react'
import type { ToolType } from '@/types/template'
import { cn } from '@/lib/utils'

interface ToolboxProps {
  tool: ToolType | null
  onToolChange: (t: ToolType) => void
  onPickImage: (file: File) => void
  /** 打开素材库面板（本地 CC0 图标 / 表情） */
  onOpenAssets: () => void
  /** 插入表格（行列数由工具栏的网格选择器决定，像 Word 那样） */
  onInsertTable: (rows: number, cols: number) => void
}

/** 表格选择器的网格规模（行 × 列），与 Word「插入表格」的悬浮面板同一交互 */
const TABLE_PICKER_ROWS = 5
const TABLE_PICKER_COLS = 6

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
    key: 'text-paragraph',
    label: '段落',
    Icon: Pilcrow,
    hint: '插入段落文本（多行自动换行，拖左右控制点调宽度，文字自动适应边界）',
  },
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
  const { onToolChange, onPickImage, onOpenAssets, onInsertTable } = props
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // 表格网格选择器（像 Word「插入表格」那样 hover 出 N×M）
  const [tableOpen, setTableOpen] = useState(false)
  const [tablePos, setTablePos] = useState<{ left: number; top: number } | null>(null)
  const [pick, setPick] = useState<{ r: number; c: number } | null>(null)
  const tableBtnRef = useRef<HTMLButtonElement>(null)
  const tableMenuRef = useRef<HTMLDivElement>(null)

  // 打开时计算弹出位置（相对视口 fixed，绕开 aside overflow 裁剪）；关/滚/Escape 关闭
  const openMenu = () => {
    const b = btnRef.current
    if (!b) return
    const r = b.getBoundingClientRect()
    setPos({ left: r.right + 4, top: r.top })
    setOpen(true)
  }

  const openTableMenu = () => {
    const b = tableBtnRef.current
    if (!b) return
    const r = b.getBoundingClientRect()
    setTablePos({ left: r.right + 4, top: r.top })
    setPick(null)
    setTableOpen(true)
  }

  useEffect(() => {
    if (!open && !tableOpen) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (menuRef.current?.contains(t) || btnRef.current?.contains(t)) {
        // 形状菜单内部的点击自行处理
      } else {
        setOpen(false)
      }
      if (tableMenuRef.current?.contains(t) || tableBtnRef.current?.contains(t)) {
        // 表格面板内部点击自行处理
      } else {
        setTableOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      setTableOpen(false)
    }
    const onScroll = () => {
      setOpen(false)
      setTableOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open, tableOpen])

  const pickShape = (key: ToolType) => {
    setOpen(false)
    onToolChange(key)
  }

  const insertTable = (rows: number, cols: number) => {
    setTableOpen(false)
    onInsertTable(rows, cols)
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

        {/* 表格：点开是 Word 式网格，拖选行列数 */}
        <ToolBtn
          label="表格"
          hint="插入表格（像 Word 一样拖选行列数，插入后可在属性面板增删行列）"
          Icon={TableIcon}
          active={tableOpen}
          btnRef={tableBtnRef}
          onClick={openTableMenu}
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

      {/* 表格：Word 式行列网格选择器 */}
      {tableOpen && tablePos && (
        <div
          ref={tableMenuRef}
          style={{ left: tablePos.left, top: tablePos.top }}
          className="fixed z-50 rounded-lg border bg-background p-2 shadow-lg"
          onMouseLeave={() => setPick(null)}
        >
          <div className="mb-1.5 text-center text-[11px] tabular-nums text-muted-foreground">
            {pick ? `${pick.r} 行 × ${pick.c} 列` : '插入表格'}
          </div>
          <div
            className="grid gap-0.5"
            style={{ gridTemplateColumns: `repeat(${TABLE_PICKER_COLS}, 1.125rem)` }}
          >
            {Array.from({ length: TABLE_PICKER_ROWS * TABLE_PICKER_COLS }, (_, i) => {
              const r = Math.floor(i / TABLE_PICKER_COLS) + 1
              const c = (i % TABLE_PICKER_COLS) + 1
              const activePick = !!pick && r <= pick.r && c <= pick.c
              return (
                <button
                  key={i}
                  type="button"
                  aria-label={`${r} 行 ${c} 列`}
                  onMouseEnter={() => setPick({ r, c })}
                  onClick={() => insertTable(r, c)}
                  className={cn(
                    'h-[1.125rem] w-[1.125rem] rounded-[3px] border transition-colors',
                    activePick
                      ? 'border-blue-500 bg-blue-100'
                      : 'border-border bg-muted/40 hover:border-blue-400',
                  )}
                />
              )
            })}
          </div>
          <div className="mt-1.5 text-center text-[10px] text-muted-foreground">
            点选行列数即插入
          </div>
        </div>
      )}
    </>
  )
}
