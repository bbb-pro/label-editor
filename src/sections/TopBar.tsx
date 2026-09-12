// 顶部工具栏
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import {
  FilePlus2,
  Upload,
  Download,
  Printer,
  ImageDown,
  FileDown,
  Undo2,
  Redo2,
} from 'lucide-react'

interface TopBarProps {
  zoom: number
  zoomIn: () => void
  zoomOut: () => void
  zoomFit: () => void
  onNew: () => void
  onImportJson: (file: File) => void
  onExportJson: () => void
  onUndo: () => void
  onRedo: () => void
  canUndo: boolean
  canRedo: boolean
  onPrint: () => void
  onExportPng: () => void
  onExportPdf: () => void
}

export default function TopBar(props: TopBarProps) {
  const {
    zoom,
    zoomIn,
    zoomOut,
    zoomFit,
    onNew,
    onImportJson,
    onExportJson,
    onUndo,
    onRedo,
    canUndo,
    canRedo,
    onPrint,
    onExportPng,
    onExportPdf,
  } = props

  return (
    <header className="flex h-12 shrink-0 items-center gap-1 border-b bg-background px-2">
      {/* 品牌 */}
      <div className="mr-1 flex items-center gap-2 px-2">
        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-primary text-[11px] font-bold text-primary-foreground">
          签
        </div>
        <span className="hidden text-sm font-semibold md:inline">标签编辑器</span>
      </div>

      <Separator orientation="vertical" className="mx-1 h-6" />

      {/* 历史操作：撤销 / 重做（无历史时禁用） */}
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onUndo}
        disabled={!canUndo}
        title="撤销（Ctrl+Z）"
        aria-label="撤销"
      >
        <Undo2 className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onRedo}
        disabled={!canRedo}
        title="重做（Ctrl+Shift+Z 或 Ctrl+Y）"
        aria-label="重做"
      >
        <Redo2 className="h-4 w-4" />
      </Button>

      <Separator orientation="vertical" className="mx-1 h-6" />

      {/* 文件组 */}
      <Button variant="ghost" size="sm" onClick={onNew} title="新建标签（清空画布）">
        <FilePlus2 className="mr-1 h-4 w-4" />
        <span className="hidden lg:inline">新建</span>
      </Button>
      <label className="cursor-pointer">
        <input
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) onImportJson(f)
            e.target.value = ''
          }}
        />
        <Button variant="ghost" size="sm" asChild>
          <span>
            <Upload className="mr-1 h-4 w-4" />
            <span className="hidden lg:inline">导入模板</span>
          </span>
        </Button>
      </label>
      <Button variant="ghost" size="sm" onClick={onExportJson} title="导出为 JSON 模板">
        <Download className="mr-1 h-4 w-4" />
        <span className="hidden lg:inline">导出模板</span>
      </Button>

      <div className="flex-1" />

      {/* 输出组 */}
      <Button
        variant="ghost"
        size="sm"
        onClick={onPrint}
        title="浏览器打印（请选无边距）"
      >
        <Printer className="mr-1 h-4 w-4" />
        打印
      </Button>
      <Button variant="ghost" size="sm" onClick={onExportPng} title="导出高清 PNG">
        <ImageDown className="mr-1 h-4 w-4" />
        PNG
      </Button>
      <Button variant="ghost" size="sm" onClick={onExportPdf} title="导出 PDF">
        <FileDown className="mr-1 h-4 w-4" />
        PDF
      </Button>

      <Separator orientation="vertical" className="mx-1 h-6" />

      {/* 缩放 */}
      <div className="flex items-center gap-0.5">
        <Button variant="ghost" size="icon-sm" onClick={zoomOut} title="缩小">
          −
        </Button>
        <button
          className="min-w-12 text-center text-xs tabular-nums text-muted-foreground hover:text-foreground"
          onClick={zoomFit}
          title="双击适应画布"
        >
          {Math.round(zoom * 100)}%
        </button>
        <Button variant="ghost" size="icon-sm" onClick={zoomIn} title="放大">
          +
        </Button>
      </div>
    </header>
  )
}
