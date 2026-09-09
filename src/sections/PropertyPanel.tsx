// 右侧属性面板：纸张 / 选中对象几何 / 内容 / 文本格式
import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Toggle } from '@/components/ui/toggle'
import { Switch } from '@/components/ui/switch'
import {
  Trash2,
  Braces,
  ScanBarcode,
  Type as TypeIcon,
  Square as SquareIcon,
  Minus as MinusIcon,
  Image as ImageIcon,
  Layers,
  Circle as CircleIcon,
  Triangle as TriangleIcon,
  Diamond as DiamondIcon,
  Star as StarIcon,
  Shapes as ShapesIcon,
  Sparkles as SparklesIcon,
  Bold,
  Italic,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Tag as TagIcon,
  ScanText,
  ShieldCheck,
  Lock,
  Unlock,
  ChevronDown,
  Hash,
  Copy,
} from 'lucide-react'
import type { PaperSize, ShapeType } from '@/types/template'
import { DEFAULT_PAPER } from '@/types/template'
import type { ActiveObject, DataRow, ElementKind, TextStyle, TextFormatSnapshot, SerialSpec } from '@/types/editor'
import { BARCODE_OPTIONS, is2dType, isQrFamily, type BarcodeType, type BarcodeRenderSettings } from '@/lib/barcode'
import { FONT_FAMILIES, FONT_SIZES_PT } from '@/lib/textStyles'
import MmField from '@/components/editor/MmField'
import { cn } from '@/lib/utils'

interface PropertyPanelProps {
  paper: PaperSize
  onPaperChange: (p: PaperSize) => void
  active: ActiveObject | null
  usedVariables: string[]
  /** 画布中其它内容对象的名称（用于插入引用） */
  objectNames: string[]
  headers: string[]
  currentRow: DataRow | null
  onGeometry: (patch: Partial<Pick<ActiveObject, 'x' | 'y' | 'width' | 'height' | 'angle'>>) => void
  onContentChange: (text: string) => void
  onTextStyleChange: (patch: Partial<TextStyle>) => void
  onBarcodeTypeChange: (t: BarcodeType) => void
  onNameChange: (name: string) => void
  /** 锁定/解锁当前选中对象 */
  onToggleLock: () => void
  onBarcodeSettingsChange: (patch: Partial<BarcodeRenderSettings>) => void
  /** 条码：人读文字与条区距离(mm) */
  onBarcodeTextOffsetChange?: (mm: number) => void
  /** 内容对象：前缀/后缀 */
  onContentDecorChange: (patch: { prefix?: string; suffix?: string }) => void
  /** 内容对象：序列化配置（null=关闭） */
  onSerialChange: (serial: SerialSpec | null) => void
  onDeleteActive: () => void
  /** 复制/原位复制当前对象 */
  onDuplicate: () => void
  /** 矩形/直线：描边粗细 (px) */
  onStrokeWidthChange: (px: number) => void
  /** 矩形：圆角半径 (显示 mm) */
  onCornerRadiusChange: (mm: number) => void
  /** 矩形/形状/直线：描边颜色 */
  onStrokeColorChange: (hex: string) => void
  /** 矩形/形状：填充颜色（null=透明无填充） */
  onFillColorChange: (color: string | null) => void
  /** 文本：区域框开关（边框+底色） */
  onTextRegionChange: (r: { border: boolean; bg: boolean }) => void
  objectCount: number
  /** 仅内容模式：供移动端底部抽屉复用（自行包裹滚动） */
  bare?: boolean
}

const kindMeta: Record<ElementKind, { label: string; Icon: typeof Layers; color: string }> = {
  text: { label: '文本', Icon: TypeIcon, color: 'text-blue-600 bg-blue-50' },
  barcode: { label: '条码 / 二维码', Icon: ScanBarcode, color: 'text-violet-600 bg-violet-50' },
  rect: { label: '矩形', Icon: SquareIcon, color: 'text-slate-600 bg-slate-100' },
  line: { label: '直线', Icon: MinusIcon, color: 'text-slate-600 bg-slate-100' },
  image: { label: '图片', Icon: ImageIcon, color: 'text-amber-600 bg-amber-50' },
  shape: { label: '形状', Icon: ShapesIcon, color: 'text-slate-600 bg-slate-100' },
  svg: { label: '矢量素材', Icon: SparklesIcon, color: 'text-teal-600 bg-teal-50' },
}

/** 形状子类型的图标与中文名 */
const SHAPE_META: Record<ShapeType, { label: string; Icon: typeof Layers }> = {
  ellipse: { label: '椭圆', Icon: CircleIcon },
  triangle: { label: '三角形', Icon: TriangleIcon },
  diamond: { label: '菱形', Icon: DiamondIcon },
  star: { label: '五角星', Icon: StarIcon },
}

export default function PropertyPanel(props: PropertyPanelProps) {
  const { paper, active, bare } = props
  const inner = (
    <>
      <Section title="纸张设置">
        <div className="grid grid-cols-2 gap-2">
          <MmField
            label="纸张宽 (mm)"
            value={paper.widthMm}
            suffix="mm"
            step={1}
            onChange={(w) => props.onPaperChange({ ...paper, widthMm: w })}
          />
          <MmField
            label="纸张高 (mm)"
            value={paper.heightMm}
            suffix="mm"
            step={1}
            onChange={(h) => props.onPaperChange({ ...paper, heightMm: h })}
          />
        </div>
        <p className="pt-1 text-[11px] leading-relaxed text-muted-foreground">
          默认 {DEFAULT_PAPER.widthMm} × {DEFAULT_PAPER.heightMm} mm · 提示：修改后立即应用到画布。
        </p>
      </Section>

      {active ? (
        <SelectedObjectPanel
          active={active}
          usedVariables={props.usedVariables}
          objectNames={props.objectNames}
          headers={props.headers}
          onGeometry={props.onGeometry}
          onContentChange={props.onContentChange}
          onTextStyleChange={props.onTextStyleChange}
          onBarcodeTypeChange={props.onBarcodeTypeChange}
          onNameChange={props.onNameChange}
          onToggleLock={props.onToggleLock}
          onBarcodeSettingsChange={props.onBarcodeSettingsChange}
          onBarcodeTextOffsetChange={props.onBarcodeTextOffsetChange}
          onContentDecorChange={props.onContentDecorChange}
          onSerialChange={props.onSerialChange}
          onDuplicate={props.onDuplicate}
          onDeleteActive={props.onDeleteActive}
          onStrokeWidthChange={props.onStrokeWidthChange}
          onCornerRadiusChange={props.onCornerRadiusChange}
          onStrokeColorChange={props.onStrokeColorChange}
          onFillColorChange={props.onFillColorChange}
          onTextRegionChange={props.onTextRegionChange}
        />
      ) : (
        <EmptySelection objectCount={props.objectCount} />
      )}
    </>
  )
  // bare：内容由调用方（移动端底部抽屉）自行包裹滚动区；否则为桌面右侧固定面板
  if (bare) {
    return <div className="space-y-5 p-3">{inner}</div>
  }
  return (
    <aside className="flex w-[290px] shrink-0 flex-col border-l bg-background">
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-5 p-3">{inner}</div>
      </ScrollArea>
    </aside>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  )
}

function EmptySelection({ objectCount }: { objectCount: number }) {
  return (
    <div className="rounded-lg border border-dashed bg-muted/30 p-4 text-center">
      <Layers className="mx-auto mb-2 h-6 w-6 text-muted-foreground/50" />
      <p className="text-xs text-muted-foreground">
        {objectCount === 0
          ? '画布为空，从左侧工具箱添加元素'
          : '未选中对象 · 点选画布元素以编辑属性'}
      </p>
    </div>
  )
}

/** 文本格式工具条：字体 / 字号 / 加粗 / 斜体 / 对齐 / 颜色 */
function TextFormatSection({
  fmt,
  keySeed,
  region,
  onChange,
  onRegionChange,
}: {
  fmt: TextFormatSnapshot
  keySeed: string
  region?: { border: boolean; bg: boolean }
  onChange: (patch: Partial<TextStyle>) => void
  onRegionChange: (r: { border: boolean; bg: boolean }) => void
}) {
  return (
    <Section title="字体">
      <div className="space-y-2">
        <div className="grid grid-cols-2 gap-2">
          {/* 字体 */}
          <Select value={fmt.fontFamily} onValueChange={(v) => onChange({ fontFamily: v })}>
            <SelectTrigger className="col-span-2 h-8 text-xs">
              <SelectValue placeholder="字体" />
            </SelectTrigger>
            <SelectContent>
              {FONT_FAMILIES.map((f) => (
                <SelectItem key={f.value} value={f.value} className="text-xs">
                  {f.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/* 字号(pt)：自由输入 + 预设（数字框自带上下微调箭头，省去独立步进按钮） */}
          <div className="flex h-8 items-center gap-1">
            <FontSizeField
              value={fmt.fontSizePt}
              resetKey={keySeed}
              onCommit={(v) => onChange({ fontSizePt: v })}
            />
            <FontPresetSelect
              current={fmt.fontSizePt}
              onPick={(v) => onChange({ fontSizePt: v })}
            />
          </div>
          {/* 颜色 */}
          <label className="flex h-8 items-center gap-1.5 rounded-md border bg-background px-2">
            <input
              type="color"
              value={/^#[0-9a-f]{6}$/i.test(fmt.color) ? fmt.color : '#000000'}
              onChange={(e) => onChange({ color: e.target.value })}
              className="h-5 w-6 cursor-pointer border-0 bg-transparent p-0"
            />
            <span className="text-[10px] text-muted-foreground">颜色</span>
          </label>
        </div>
        {/* 粗/斜 + 对齐 */}
        <div className="flex items-center gap-1">
          <Toggle
            size="sm"
            pressed={fmt.bold}
            onPressedChange={(p) => onChange({ bold: p })}
            aria-label="加粗"
            title="加粗"
          >
            <Bold className="h-4 w-4" />
          </Toggle>
          <Toggle
            size="sm"
            pressed={fmt.italic}
            onPressedChange={(p) => onChange({ italic: p })}
            aria-label="斜体"
            title="斜体"
          >
            <Italic className="h-4 w-4" />
          </Toggle>
          <div className="mx-1 h-5 w-px bg-border" />
          {(
            [
              { key: 'left', Icon: AlignLeft, title: '左对齐' },
              { key: 'center', Icon: AlignCenter, title: '居中' },
              { key: 'right', Icon: AlignRight, title: '右对齐' },
            ] as const
          ).map(({ key, Icon, title }) => (
            <Toggle
              key={key}
              size="sm"
              pressed={fmt.textAlign === key}
              onPressedChange={() => onChange({ textAlign: key })}
              title={title}
              aria-label={title}
            >
              <Icon className="h-4 w-4" />
            </Toggle>
          ))}
        </div>
        {/* 区域框（开启后文本像一块可视的"区域文本框"，可整体拖/缩放） */}
        <div className="rounded-md border bg-muted/20 p-2">
          <p className="mb-1 text-[10px] font-medium text-muted-foreground">区域框</p>
          <div className="flex items-center gap-1">
            <Toggle
              size="sm"
              pressed={!!region?.border}
              onPressedChange={(p) => onRegionChange({ border: p, bg: !!region?.bg })}
              aria-label="显示边框"
              title="显示边框"
            >
              边框
            </Toggle>
            <Toggle
              size="sm"
              pressed={!!region?.bg}
              onPressedChange={(p) => onRegionChange({ border: !!region?.border, bg: p })}
              aria-label="显示底色"
              title="显示底色"
            >
              底色
            </Toggle>
            <span className="ml-1 text-[10px] text-muted-foreground">
              {(region?.border || region?.bg) ? '已开启' : '关闭'}
            </span>
          </div>
        </div>
      </div>
    </Section>
  )
}


function SelectedObjectPanel({
  active,
  usedVariables,
  objectNames,
  headers,
  onGeometry,
  onContentChange,
  onTextStyleChange,
  onBarcodeTypeChange,
  onNameChange,
  onToggleLock,
  onBarcodeSettingsChange,
  onBarcodeTextOffsetChange,
  onContentDecorChange,
  onSerialChange,
  onDuplicate,
  onDeleteActive,
  onStrokeWidthChange,
  onCornerRadiusChange,
  onStrokeColorChange,
  onFillColorChange,
  onTextRegionChange,
}: Omit<PropertyPanelProps, 'active' | 'paper' | 'onPaperChange' | 'objectCount' | 'currentRow'> & {
  active: ActiveObject
}) {
  const meta = kindMeta[active.kind]
  const isText = active.kind === 'text'
  const isBarcode = active.kind === 'barcode'
  const isStroke = active.kind === 'rect' || active.kind === 'shape' || active.kind === 'line'
  // 矢量素材：线稿类（图标）可改描边色；彩绘类（emoji）保持原色，故不显示改色控件
  const isSvgAsset = active.kind === 'svg'
  const canEditContent = isText || isBarcode
  // 选中对象头部显示用：kind==='shape' 时展示具体形状（椭圆/三角…）
  const HeaderShapeIcon = active.kind === 'shape' ? (SHAPE_META[active.shapeType ?? 'ellipse'].Icon) : meta.Icon
  const headerLabel =
    active.kind === 'shape' ? SHAPE_META[active.shapeType ?? 'ellipse'].label : meta.label
  const typeLabel =
    isBarcode && active.barcodeType
      ? BARCODE_OPTIONS.find((o) => o.value === active.barcodeType)?.label
      : undefined
  // 内容输入用“非受控 + key 重置”：避免受控 value 未随输入更新导致每次键入被回退
  const contentRef = useRef<HTMLTextAreaElement>(null)
  const contentKey = isText
    ? `text:${active.id}:s${active.serial?.enabled ? 1 : 0}`
    : `bc:${active.id}:s${active.serial?.enabled ? 1 : 0}`

  const handleInsert = (v: string) => {
    const ta = contentRef.current
    const cur = ta ? ta.value : (active.text ?? '')
    const next = cur + `{{${v}}}`
    if (ta) ta.value = next
    onContentChange(next)
  }

  return (
    <div className="space-y-4">
      <Section title="选中对象">
        <div className="flex items-center gap-2">
          <span className={cn('flex h-7 w-7 items-center justify-center rounded-md', meta.color)}>
            <HeaderShapeIcon className="h-4 w-4" />
          </span>
          <span className="text-sm font-medium">{headerLabel}</span>
          {typeLabel && (
            <span className="truncate rounded bg-violet-50 px-1.5 py-0.5 text-[10px] font-medium text-violet-600">
              {typeLabel}
            </span>
          )}
          <div className="flex-1" />
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onToggleLock}
            title={active.locked ? '已锁定（点此解锁）' : '锁定（防止误拖动/缩放）'}
            className={active.locked ? 'text-amber-600 hover:text-amber-600' : ''}
          >
            {active.locked ? <Lock className="h-4 w-4" /> : <Unlock className="h-4 w-4" />}
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onDuplicate} title="复制">
            <Copy className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon-sm" className="text-destructive hover:text-destructive" onClick={onDeleteActive} title="删除">
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
        {canEditContent && (
          <NameField value={active.name} onChange={onNameChange} headers={headers} />
        )}
      </Section>

      <Section title="位置与尺寸">
        <div className="grid grid-cols-2 gap-2">
          <MmField label="X (mm)" value={active.x} onChange={(v) => onGeometry({ x: v })} />
          <MmField label="Y (mm)" value={active.y} onChange={(v) => onGeometry({ y: v })} />
          <MmField
            label="宽 (mm)"
            value={active.width}
            disabled={active.kind === 'line'}
            onChange={(v) => onGeometry({ width: v })}
          />
          <MmField
            label="高 (mm)"
            value={active.height}
            disabled={active.kind === 'line'}
            onChange={(v) => onGeometry({ height: v })}
          />
        </div>
        <MmField
          label="旋转角度 (°)"
          value={active.angle}
          suffix="°"
          step={1}
          onChange={(v) => onGeometry({ angle: v })}
        />
      </Section>

      {isSvgAsset && (
        <Section title="外观">
          {active.strokeColor ? (
            <>
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <ColorField
                    label="图标颜色"
                    color={active.strokeColor}
                    onPick={(c) => onStrokeColorChange(c ?? '#000000')}
                  />
                </div>
                <div className="flex-1">
                  <MmField
                    label="线条粗细"
                    value={active.strokeWidth ?? 2}
                    suffix="px"
                    step={0.25}
                    onChange={(v) => onStrokeWidthChange(v)}
                  />
                </div>
              </div>
              <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                线稿图标可改色与粗细；放大时线条会按比例一起变粗，打印效果与屏幕一致。
              </p>
            </>
          ) : (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              彩色素材（如表情）保留原印制色，不支持改色；可用下方位置与尺寸调整大小。
            </p>
          )}
        </Section>
      )}

      {isStroke && (
        <Section title={active.kind === 'line' ? '线条' : '外观'}>
          {/* 填充（闭合形状才有）：开关 + 颜色 */}
          {active.kind !== 'line' && (
            <div className="flex items-center gap-2">
              <div className="flex-1">
                <ColorField
                  label="填充"
                  color={active.fillColor}
                  emptyLabel="透明"
                  empty
                  onPick={(c) => onFillColorChange(c)}
                />
              </div>
              <span className="pb-0.5 text-[10px] text-muted-foreground">
                {active.fillColor ? '实心' : '无填充'}
              </span>
            </div>
          )}
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <ColorField
                label={active.kind === 'line' ? '线条颜色' : '描边颜色'}
                color={active.strokeColor ?? '#000000'}
                onPick={(c) => onStrokeColorChange(c ?? '#000000')}
              />
            </div>
          </div>
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <MmField
                label="粗细 (px)"
                value={active.strokeWidth ?? 1.5}
                suffix="px"
                step={0.5}
                onChange={(v) => onStrokeWidthChange(v)}
              />
            </div>
            {/* 粗细预览 */}
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border">
              <div
                className="rounded"
                style={{
                  width: `${Math.max(1, Math.min(18, active.strokeWidth ?? 1.5))}px`,
                  height: `${Math.max(1, Math.min(18, active.strokeWidth ?? 1.5))}px`,
                  background: active.strokeColor ?? '#000',
                }}
              />
            </div>
          </div>
          {active.kind === 'rect' && (
            <div className="mt-2">
              <MmField
                label="圆角半径 (mm)"
                value={active.cornerRadiusMm ?? 0}
                step={0.5}
                onChange={(v) => onCornerRadiusChange(v)}
              />
              <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                设 0 为直角；数值越大四角越圆。
              </p>
            </div>
          )}
          <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
            {active.kind === 'line'
              ? '拉大或缩小时线条粗细保持不变，仅此处可调。'
              : '拉大或缩小时线条粗细保持不变；填充会随整体一起缩放。'}
          </p>
        </Section>
      )}

      {isText && active.textFormat && (
        <TextFormatSection
          fmt={active.textFormat}
          keySeed={active.id}
          region={active.textRegion}
          onChange={onTextStyleChange}
          onRegionChange={onTextRegionChange}
        />
      )}

      {isBarcode && (
        <Section title="码制类型">
          <Select
            value={active.barcodeType ?? 'code128'}
            onValueChange={(v) => onBarcodeTypeChange(v as BarcodeType)}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="选择条码类型" />
            </SelectTrigger>
            <SelectContent>
              {BARCODE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value} className="text-xs">
                  {o.group} · {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[10px] leading-relaxed text-muted-foreground">
            切换码制后立即重新渲染；不同码制对内容长度/格式有要求。
          </p>
        </Section>
      )}

      {isBarcode && active.barcodeSettings && (
        <Section title="条码属性">
          <BarcodeSettingsControls
            settings={active.barcodeSettings}
            is2d={active.barcodeType ? is2dType(active.barcodeType) : false}
            qrFamily={active.barcodeType ? isQrFamily(active.barcodeType) : false}
            onChange={onBarcodeSettingsChange}
            textOffsetMm={active.barcodeTextOffsetMm}
            onTextOffsetChange={onBarcodeTextOffsetChange}
          />
        </Section>
      )}

      {canEditContent && (
        <Section title="内容">
          <textarea
            key={contentKey}
            ref={contentRef}
            defaultValue={active.text ?? ''}
            rows={isText ? 4 : 2}
            onChange={(e) => onContentChange(e.target.value)}
            placeholder={
              isText
                ? '支持 {{字段名}} 变量'
                : '输入内容，支持 {{字段名}}，如 123456-{{code}}'
            }
            className="w-full resize-y rounded-md border bg-background px-2.5 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring/40"
            style={{ fontFamily: 'ui-monospace,monospace' }}
          />
          <VariableHint
            headers={headers}
            usedVariables={usedVariables}
            objectNames={objectNames}
            onInsert={handleInsert}
          />
          <p className="text-[10px] leading-relaxed text-muted-foreground">
            用 <code className="rounded bg-muted px-1">{"{{字段}}"}</code> 引用表格列，或{' '}
            <code className="rounded bg-muted px-1">{"{{对象名}}"}</code> 引用其它文本/条码内容。
          </p>
        </Section>
      )}

      {canEditContent && (
        <DecorSection
          key={`decor:${active.id}`}
          prefix={active.prefix ?? ''}
          suffix={active.suffix ?? ''}
          serial={active.serial}
          onDecorChange={onContentDecorChange}
          onSerialChange={onSerialChange}
          onInsertSeq={(name) => onContentChange((contentRef.current?.value ?? '') + `{{${name}}}`)}
        />
      )}
    </div>
  )
}

/** 对象名称输入：作为跨对象引用标识（文本/条码）。
 *  用「本地输入态 + 聚焦守卫」：输入过程中不被父级重渲染覆盖，可彻底删空重输；
 *  仅在失焦或外部值变化（切对象）时回同步，避免受控输入把已删内容回写回来。 */
function NameField({
  value,
  onChange,
  headers,
}: {
  value: string
  onChange: (name: string) => void
  headers: string[]
}) {
  const [text, setText] = useState(value)
  const focusedRef = useRef(false)
  useEffect(() => {
    if (!focusedRef.current) setText(value)
  }, [value])
  const bound = text.trim() && headers.includes(text.trim())
  return (
    <div className="pt-2">
      <label className="flex items-center gap-1.5">
        <TagIcon className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[11px] text-muted-foreground">名称</span>
        {bound && (
          <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600">
            已关联列：{text.trim()}
          </span>
        )}
      </label>
      <Input
        value={text}
        onFocus={() => {
          focusedRef.current = true
        }}
        onBlur={() => {
          focusedRef.current = false
          setText(value)
        }}
        onChange={(e) => {
          setText(e.target.value)
          onChange(e.target.value)
        }}
        placeholder="如：商品名"
        className="mt-1 h-8 text-xs"
      />
      <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
        {headers.length > 0 ? (
          bound ? (
            <>
              此文本框当前行将自动填充「<b className="font-mono">{text.trim()}</b>」列的数据。
            </>
          ) : (
            <>
              把名称设为与表格表头一致（如{' '}
              <code className="rounded bg-muted px-1">{headers[0]}</code>），即可整框取该列数据，无需在内容里写{' '}
              <code className="rounded bg-muted px-1">{'{{ }}'}</code>。
            </>
          )
        ) : (
          <>
            命名后可在其它文本/条码内容中引用，如{' '}
            <code className="rounded bg-muted px-1">{"{{商品名}}"}</code>。
          </>
        )}
      </p>
    </div>
  )
}

/** 条码渲染设置：可读文字开关 / 字号 / 静区 */
function BarcodeSettingsControls({
  settings,
  is2d,
  qrFamily,
  onChange,
  textOffsetMm,
  onTextOffsetChange,
}: {
  settings: BarcodeRenderSettings
  is2d: boolean
  qrFamily?: boolean
  onChange: (patch: Partial<BarcodeRenderSettings>) => void
  textOffsetMm?: number
  onTextOffsetChange?: (mm: number) => void
}) {
  const eccLevels: Array<'L' | 'M' | 'Q' | 'H'> = ['L', 'M', 'Q', 'H']
  const eccLabels: Record<'L' | 'M' | 'Q' | 'H', string> = { L: '7%', M: '15%', Q: '25%', H: '30%' }
  const curEcc = settings.eccLevel ?? 'M'
  return (
    <div className="space-y-2">
      {qrFamily && (
        <div className="rounded-md border px-2.5 py-2">
          <span className="mb-1.5 flex items-center gap-2 text-xs">
            <ShieldCheck className="h-4 w-4 text-muted-foreground" />
            容错等级
          </span>
          <div className="grid grid-cols-4 gap-1">
            {eccLevels.map((lv) => (
              <button
                key={lv}
                onClick={() => onChange({ eccLevel: lv })}
                title={`可恢复 ${eccLabels[lv]} 损坏`}
                className={`rounded-md border px-1 py-1 text-center text-xs transition-colors ${
                  curEcc === lv
                    ? 'border-primary bg-primary/10 font-semibold text-primary'
                    : 'text-muted-foreground hover:bg-accent'
                }`}
              >
                {lv}
                <span className="block text-[9px] opacity-70">{eccLabels[lv]}</span>
              </button>
            ))}
          </div>
          <p className="mt-1 text-[10px] text-muted-foreground">容错越高越耐脏污/破损，但同内容点阵越密。</p>
        </div>
      )}
      <label className="flex items-center justify-between gap-2 rounded-md border px-2.5 py-2">
        <span className="flex items-center gap-2 text-xs">
          <ScanText className="h-4 w-4 text-muted-foreground" />
          人眼可读文字
        </span>
        <Switch
          checked={settings.showText}
          disabled={is2d}
          onCheckedChange={(v) => onChange({ showText: v })}
        />
      </label>
      {!is2d && settings.showText && (
        <MmField
          label="可读文字字号 (pt)"
          value={settings.textSizePt}
          suffix="pt"
          step={1}
          onChange={(v) => onChange({ textSizePt: Math.max(4, Math.min(48, v)) })}
        />
      )}
      {!is2d && settings.showText && onTextOffsetChange && (
        <MmField
          label="距条区距离 (mm)"
          value={textOffsetMm ?? 0}
          step={0.5}
          onChange={(v) => onTextOffsetChange(v)}
        />
      )}
      <p className="text-[10px] leading-relaxed text-muted-foreground">
        2D 码（二维码/矩阵）不含可读文字；字号仅在开启时生效。
      </p>
    </div>
  )
}

function VariableHint({
  headers,
  usedVariables,
  objectNames,
  onInsert,
}: {
  headers: string[]
  usedVariables: string[]
  objectNames: string[]
  onInsert: (v: string) => void
}) {
  const available = headers.length > 0 ? headers : usedVariables
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="mt-1.5 h-7 text-xs">
          <Braces className="mr-1 h-3.5 w-3.5" />
          插入变量 / 引用
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-60 p-1" align="start">
        <p className="px-2 py-1 text-[11px] text-muted-foreground">
          {headers.length > 0 ? '从表格列选择（数据变量）' : '画布中已使用的变量'}
        </p>
        <div className="max-h-36 overflow-auto">
          {available.length === 0 && headers.length === 0 && (
            <p className="px-2 py-2 text-xs text-muted-foreground">
              暂无变量，请先在底部上传数据表
            </p>
          )}
          {available.map((v) => (
            <button
              key={`v-${v}`}
              onClick={() => onInsert(v)}
              className="block w-full rounded px-2 py-1.5 text-left text-xs font-mono hover:bg-accent"
            >
              {'{{'} {v} {'}}'}
            </button>
          ))}
        </div>
        {objectNames.length > 0 && (
          <>
            <div className="mt-1 border-t px-2 py-1 text-[11px] text-muted-foreground">
              引用其它对象
            </div>
            <div className="max-h-28 overflow-auto">
              {objectNames.map((n) => (
                <button
                  key={`o-${n}`}
                  onClick={() => onInsert(n)}
                  className="block w-full rounded px-2 py-1.5 text-left text-xs font-mono text-violet-600 hover:bg-accent"
                >
                  {'{{'} {n} {'}}'}
                </button>
              ))}
            </div>
          </>
        )}
        <div className="mt-1 border-t px-2 py-1 text-[11px] text-muted-foreground">
          特殊
        </div>
        <button
          onClick={() => onInsert('seq')}
          className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs hover:bg-accent"
        >
          <span className="font-mono">{'{{seq}}'}</span>
          <span className="text-[10px] text-amber-600">批量打印序号(自动递增)</span>
        </button>
      </PopoverContent>
    </Popover>
  )
}

function clampFontSize(v: number): number {
  if (!Number.isFinite(v)) return 12
  return Math.min(500, Math.max(0.5, Math.round(v * 100) / 100))
}

/**
 * 字号(pt) 数字输入框。
 * 旧实现用 `defaultValue` + 含当前值的 `key`，且只在 blur/回车时提交，有两个问题：
 * 1. 点数字框自带的上下微调箭头只触发 input 事件、不会失焦 → 永远不生效；
 *    输入后直接看画布（不失焦）同样不生效，表现为「输入数字调大小失效」。
 * 2. 每次提交后 `key` 变化会让 input 重新挂载 → 输入焦点/光标丢失。
 * 现改为「受控草稿值 + 实时提交」：打字或点箭头即时生效，
 * 失焦/回车时才把输入框内容规范化（clamp），外部值变化（切换对象/点预设）时同步。
 */
function FontSizeField({
  value,
  resetKey,
  onCommit,
}: {
  value: number
  resetKey: string
  onCommit: (pt: number) => void
}) {
  const [draft, setDraft] = useState(() => String(value))
  const focused = useRef(false)

  // 外部值变化且当前未聚焦时同步显示（切换选中对象、点预设下拉等）
  useEffect(() => {
    if (!focused.current) setDraft(String(value))
    // resetKey 用于「切到另一个对象但字号恰好相同」时也要重置草稿
  }, [value, resetKey])

  const commit = (raw: string, normalize: boolean) => {
    const n = parseFloat(raw)
    if (!Number.isFinite(n)) {
      if (normalize) setDraft(String(value))
      return
    }
    const v = clampFontSize(n)
    // 实时输入时保留用户输入的字面值（不被 clamp 打断），仅在失焦/回车时规范化
    if (normalize) setDraft(String(v))
    if (v !== value) onCommit(v)
  }

  return (
    <div className="flex h-8 min-w-0 flex-1 items-center rounded-md border bg-background focus-within:ring-2 focus-within:ring-ring/40">
      <input
        type="number"
        min={0.5}
        max={500}
        step={0.5}
        value={draft}
        onFocus={() => {
          focused.current = true
        }}
        onChange={(e) => {
          setDraft(e.target.value)
          commit(e.target.value, false)
        }}
        onBlur={(e) => {
          focused.current = false
          commit(e.target.value, true)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit((e.target as HTMLInputElement).value, true)
            ;(e.target as HTMLInputElement).blur()
          }
        }}
        className="h-8 w-full min-w-0 bg-transparent px-2 text-center text-sm font-medium tabular-nums focus:outline-none"
      />
      <span className="pr-2 text-[11px] text-muted-foreground">pt</span>
    </div>
  )
}

/** 字号预设下拉（最常用 + 自由值） */
function FontPresetSelect({
  current,
  onPick,
}: {
  current: number
  onPick: (v: number) => void
}) {
  const [open, setOpen] = useState(false)
  const presets = FONT_SIZES_PT
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex h-8 items-center gap-0.5 rounded-md border px-1.5 text-xs text-muted-foreground hover:bg-accent"
        title="字号预设"
      >
        pt
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-1 grid max-h-56 w-24 grid-cols-3 overflow-auto rounded-md border bg-background p-1 shadow-md">
            {[...presets]
              .sort((a, b) => a - b)
              .map((s) => (
                <button
                  key={s}
                  onClick={() => {
                    onPick(s)
                    setOpen(false)
                  }}
                  className={`rounded px-1 py-1 text-center text-[11px] tabular-nums hover:bg-accent ${
                    Math.abs(s - current) < 0.01 ? 'bg-primary/10 text-primary' : ''
                  }`}
                >
                  {s}
                </button>
              ))}
          </div>
        </>
      )}
    </div>
  )
}

/** 前后缀 + 序列化配置（内容对象） */
function DecorSection({
  prefix,
  suffix,
  serial,
  onDecorChange,
  onSerialChange,
  onInsertSeq,
}: {
  prefix: string
  suffix: string
  serial?: SerialSpec
  onDecorChange: (patch: { prefix?: string; suffix?: string }) => void
  onSerialChange: (serial: SerialSpec | null) => void
  onInsertSeq: (name: string) => void
}) {
  const s = serial
  const [localStart, setLocalStart] = useState(s ? String(s.start) : '1')
  const [localStep, setLocalStep] = useState(s ? String(s.step) : '1')
  const [localDigits, setLocalDigits] = useState(s ? String(s.minDigits) : '4')
  const enabled = !!s?.enabled
  // 补零位数显示始终跟随“真实生效值”：
  // 引擎在首次开启序列化时，可能按文本末尾数字位数改写 minDigits（如原文 “001”→3），
  // 若 UI 只靠本地 state 会与真实渲染位数脱节（框里显示 4 实际 3，用户以为没生效）。
  // 这里：仅当用户正聚焦输入框时保留本地草稿，其余时刻跟随 serial.minDigits。
  const digitsFocused = useRef(false)
  useEffect(() => {
    if (!digitsFocused.current) {
      const nd = serial?.minDigits
      if (typeof nd === 'number' && nd >= 1) setLocalDigits(String(nd))
    }
  }, [serial?.minDigits])
  const num = (v: string, def: number) => {
    const n = parseFloat(v)
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : def
  }
  const clampDigits = (v: string) => Math.max(1, Math.min(9, num(v, 4)))
  // ov：让某字段「实时键入即提交」时显式传最新 raw（本地 state 异步滞后，
  // 直接读 localXxx 会拿到上一次旧值）。未传的字段回落到对应 localState
  // （供其它字段失焦提交 / Switch 首次开启时用整套当前值）。
  const commitSerial = (ov: { start?: string; step?: string; digits?: string } = {}) => {
    const startStr = ov.start != null ? ov.start : localStart
    const stepStr = ov.step != null ? ov.step : localStep
    const digitsStr = ov.digits != null ? ov.digits : localDigits
    onSerialChange({
      enabled: true,
      start: Math.max(0, num(startStr, 0)),
      step: Math.max(1, num(stepStr, 1)),
      minDigits: clampDigits(digitsStr),
    })
  }
  return (
    <Section title="前后缀与序列">
      {/* 前后缀 */}
      <div className="space-y-2">
        <Field label="前缀">
          <Input
            value={prefix}
            onChange={(e) => onDecorChange({ prefix: e.target.value })}
            placeholder="如 SKU-"
            className="h-8 text-xs"
          />
        </Field>
        <Field label="后缀">
          <Input
            value={suffix}
            onChange={(e) => onDecorChange({ suffix: e.target.value })}
            placeholder="如 -01"
            className="h-8 text-xs"
          />
        </Field>
      </div>

      {/* 序列化 */}
      <div className="mt-3 space-y-2 rounded-md border bg-muted/20 p-2">
        <div className="flex items-center justify-between">
          <label className="flex items-center gap-1.5 text-xs font-medium">
            <Hash className="h-3.5 w-3.5 text-amber-600" />
            批量打印递增序号
          </label>
          <Switch
            checked={enabled}
            onCheckedChange={(v) => {
              if (v) {
                commitSerial()
              } else {
                onSerialChange(null)
              }
            }}
          />
        </div>
        {enabled && (
          <div className="grid grid-cols-3 gap-2">
            <Field label="起始">
              <input
                type="number"
                min={0}
                value={localStart}
                onChange={(e) => {
                  const raw = e.target.value
                  setLocalStart(raw)
                  // 实时提交：键入即刷新首张预览序号，不必等失焦。
                  if (/^\d+$/.test(raw)) commitSerial({ start: raw })
                }}
                onBlur={() => commitSerial({ start: localStart })}
                className="h-7 w-full rounded border bg-background px-1.5 text-xs tabular-nums focus:outline-none"
              />
            </Field>
            <Field label="步长">
              <input
                type="number"
                min={1}
                value={localStep}
                onChange={(e) => {
                  const raw = e.target.value
                  setLocalStep(raw)
                  // 实时提交：避免失焦依赖；首张预览不变，但引擎 step 已更新（批量打印递增幅度）。
                  if (/^[1-9]\d*$/.test(raw)) commitSerial({ step: raw })
                }}
                onBlur={() => commitSerial({ step: localStep })}
                className="h-7 w-full rounded border bg-background px-1.5 text-xs tabular-nums focus:outline-none"
              />
            </Field>
            <Field label="补零位数">
              <input
                type="number"
                min={1}
                max={9}
                value={localDigits}
                onChange={(e) => {
                  const raw = e.target.value
                  setLocalDigits(raw)
                  // 实时提交：键入即刷新画布（改 3→5 立刻变 00001），不必等失焦。
                  // 仅当已是合法正整数才提交，避免清空/半输入中间态误触发（如清空变 4）。
                  if (/^[1-9]\d*$/.test(raw)) commitSerial({ digits: raw })
                }}
                onFocus={() => {
                  digitsFocused.current = true
                }}
                onBlur={() => {
                  digitsFocused.current = false
                  commitSerial({ digits: localDigits })
                }}
                className="h-7 w-full rounded border bg-background px-1.5 text-xs tabular-nums focus:outline-none"
              />
            </Field>
          </div>
        )}
        {/* 用法引导（Bartender 式分步） */}
        <div className="rounded border border-dashed border-amber-300/60 bg-amber-50/40 px-2 py-1.5">
          <p className="text-[10px] leading-relaxed text-amber-800">
            <span className="font-semibold">做法（模拟 Bartender 序列）：</span>
          </p>
          <ol className="mt-0.5 list-decimal space-y-0.5 pl-4 text-[10px] leading-relaxed text-amber-800/90">
            <li>
              在上方【内容】框加{' '}
              <button
                type="button"
                onClick={() => onInsertSeq('seq')}
                className="rounded bg-amber-200/70 px-1 font-mono text-amber-800 hover:bg-amber-300/70"
              >
                {'{{seq}}'}
              </button>{' '}
              —— 这是会递增的序号占位
            </li>
            <li>设置上面的【起始】= 第 1 张的数字，【步长】= 每次加几</li>
            <li>
              打印 / 导出时在弹出的对话框里填【份数】（要 1→10 就填 10）
            </li>
          </ol>
          {enabled && (
            <p className="mt-1 text-[10px] text-amber-700">
              示例：起始 {num(localStart, 1)}、步长 {Math.max(1, num(localStep, 1))}、
              补零 {Math.max(1, num(localDigits, 4))} 位 →{' '}
              <code className="rounded bg-amber-100 px-1 font-mono">
                {previewSeq(num(localStart, 1), Math.max(1, num(localStep, 1)), Math.max(1, num(localDigits, 4)))}
              </code>
            </p>
          )}
        </div>
      </div>
    </Section>
  )
}

/** 预览序号序列：取前 4 个 + 省略号 */
function previewSeq(start: number, step: number, minDigits: number): string {
  const pad = (n: number) => String(n).padStart(minDigits, '0')
  const n = 4
  const list = Array.from({ length: n }, (_, i) => pad(start + i * step)).join(', ')
  return `${list}, …`
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}

/** 颜色选择：色块 + 输入；empty 时可选“透明”(null)，否则纯色 */
function ColorField({
  label,
  color,
  empty = false,
  emptyLabel = '透明',
  onPick,
}: {
  label: string
  color: string | null | undefined
  empty?: boolean
  emptyLabel?: string
  onPick: (c: string | null) => void
}) {
  const hex = color && /^#[0-9a-f]{6}$/i.test(color) ? color : '#000000'
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-14 shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <label className="flex h-8 flex-1 cursor-pointer items-center gap-1.5 rounded-md border bg-background px-1.5">
        <input
          type="color"
          value={hex}
          onChange={(e) => onPick(e.target.value)}
          className="h-5 w-6 cursor-pointer border-0 bg-transparent p-0"
        />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">
          {color ?? emptyLabel}
        </span>
      </label>
      {empty && color && (
        <button
          type="button"
          onClick={() => onPick(null)}
          className="shrink-0 rounded-md border px-1.5 py-1 text-[10px] text-muted-foreground hover:bg-accent"
          title="设为无填充（透明）"
        >
          透明
        </button>
      )}
    </div>
  )
}
