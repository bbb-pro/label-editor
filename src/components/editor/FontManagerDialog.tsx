// 字体管理：上传本机 .ttf → 画布立即能用、导出 PDF 内嵌同一份字形
//
// 界面取舍：
//   · 上传后**不做确认弹窗**，直接生效并给出结果行 —— 字体是可撤销的（删掉即可），
//     而"选完文件还要再点一次确定"会让人以为没生效。
//   · 每个字体用**它自己的字形**预览一行文字：这是唯一能一眼判断"是不是我要的字体"的方式，
//     靠字体名（尤其西文字体名）经常看不出来。
//   · 删除做成两步点击（删除 → 确认删除），不用系统 confirm：系统弹窗会阻塞主线程、
//     在某些内嵌浏览器里还会被拦掉。
import { useRef, useState, useSyncExternalStore } from 'react'
import { Upload, Trash2, Type, Loader2, CheckCircle2, AlertTriangle, Info } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  importFontFiles,
  removeUserFont,
  subscribeUserFonts,
  getUserFontsSnapshot,
  type ImportResult,
} from '@/lib/userFonts'

interface FontManagerDialogProps {
  open: boolean
  onOpenChange: (v: boolean) => void
  /** 字体集合变化后回调（App 用来重排画布文本：盒宽/断行依赖字体的字宽度量） */
  onChanged: () => void
}

export default function FontManagerDialog({ open, onOpenChange, onChanged }: FontManagerDialogProps) {
  const fonts = useSyncExternalStore(subscribeUserFonts, getUserFontsSnapshot, getUserFontsSnapshot)
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<ImportResult[]>([])
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)

  const handleFiles = async (files: FileList | File[] | null) => {
    if (!files || files.length === 0) return
    setBusy(true)
    setResults([])
    const res = await importFontFiles(files)
    setBusy(false)
    setResults(res)
    if (res.some((r) => r.ok)) onChanged()
    if (inputRef.current) inputRef.current.value = ''
  }

  const handleDelete = async (id: string) => {
    setConfirmId(null)
    await removeUserFont(id)
    // 用到这款字体的文本要重新量宽度，否则盒宽还按旧字体算
    onChanged()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg gap-3">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5 text-base">
            <Type className="h-4 w-4 text-indigo-600" />
            本机字体
          </DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            选一个电脑里的 .ttf 字体文件，就能在字体下拉框里选它。画布显示与导出 PDF 用的是同一份字形，
            所以打印出来和屏幕上完全一致。字体存在本机浏览器里，换设备需要重新上传。
          </DialogDescription>
        </DialogHeader>

        {/* 上传区 */}
        <div
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(false)
            void handleFiles(e.dataTransfer.files)
          }}
          className={`rounded-lg border-2 border-dashed px-3 py-4 text-center transition-colors ${
            dragOver ? 'border-indigo-400 bg-indigo-50/60' : 'border-muted-foreground/25 bg-muted/30'
          }`}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".ttf,font/ttf"
            multiple
            className="hidden"
            onChange={(e) => void handleFiles(e.target.files)}
          />
          <Button
            size="sm"
            variant="secondary"
            className="h-8 gap-1.5 text-xs"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
            {busy ? '正在读取…' : '选择字体文件'}
          </Button>
          <p className="mt-1.5 text-[10px] text-muted-foreground">
            支持 .ttf，可一次选多个（同一字体的常规 + 粗体各选一次即可合成一款）
          </p>
        </div>

        {/* 导入结果 */}
        {results.length > 0 && (
          <div className="space-y-1">
            {results.map((r, i) => (
              <div
                key={`${r.fileName}-${i}`}
                className={`flex items-start gap-1.5 rounded border px-2 py-1 text-[10px] leading-relaxed ${
                  r.ok
                    ? 'border-emerald-200 bg-emerald-50/60 text-emerald-800'
                    : 'border-amber-200 bg-amber-50/60 text-amber-800'
                }`}
              >
                {r.ok ? (
                  <CheckCircle2 className="mt-px h-3 w-3 shrink-0" />
                ) : (
                  <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                )}
                <span className="break-all">
                  {r.fileName}：{r.message}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* 已安装列表 */}
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[10px] font-medium text-muted-foreground">
              已安装 {fonts.length > 0 ? `(${fonts.length})` : ''}
            </span>
            {fonts.length > 0 && (
              <span className="text-[10px] text-muted-foreground">在「字体」下拉框最下方可选</span>
            )}
          </div>
          <div className="max-h-[240px] space-y-1 overflow-y-auto pr-0.5">
            {fonts.length === 0 ? (
              <div className="rounded-md border border-dashed px-3 py-6 text-center text-[11px] text-muted-foreground">
                还没有上传字体。上传后可在这里预览每一款的实际字形。
              </div>
            ) : (
              fonts.map((rec) => {
                const size = rec.variants.reduce((s, v) => s + v.data.byteLength, 0)
                const hasBold = rec.variants.some((v) => v.weight === '700')
                return (
                  <div
                    key={rec.id}
                    className="flex items-center gap-2 rounded-md border bg-background px-2 py-1.5"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-xs font-medium">{rec.family}</span>
                        {hasBold && (
                          <span className="shrink-0 rounded bg-slate-100 px-1 text-[9px] text-slate-600">
                            含粗体
                          </span>
                        )}
                        <span
                          className={`shrink-0 rounded px-1 text-[9px] ${
                            rec.cjk ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'
                          }`}
                        >
                          {rec.cjk ? '含中文' : '仅西文'}
                        </span>
                      </div>
                      {/* 用该字体自己的字形预览：判断"是不是我要的字体"最直接 */}
                      <div
                        className="truncate text-[13px] leading-tight text-slate-700"
                        style={{ fontFamily: rec.canvasFamily }}
                      >
                        标签打印 Aa Bb 123 ¥ 25℃
                      </div>
                      <div className="text-[9px] text-muted-foreground">
                        {(size / 1024).toFixed(0)}KB
                        {rec.glyphCount > 0 && ` · ${rec.glyphCount} 字形`}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant={confirmId === rec.id ? 'destructive' : 'ghost'}
                      className="h-7 shrink-0 px-2 text-[10px]"
                      onClick={() => {
                        if (confirmId === rec.id) void handleDelete(rec.id)
                        else setConfirmId(rec.id)
                      }}
                    >
                      {confirmId === rec.id ? (
                        '确认删除'
                      ) : (
                        <>
                          <Trash2 className="h-3 w-3" />
                        </>
                      )}
                    </Button>
                  </div>
                )
              })
            )}
          </div>
        </div>

        <div className="flex items-start gap-1.5 rounded border border-dashed px-2 py-1.5">
          <Info className="mt-px h-3 w-3 shrink-0 text-muted-foreground" />
          <p className="text-[10px] leading-relaxed text-muted-foreground">
            字体只存在你自己的浏览器里，不会上传到服务器。请确认你有该字体的使用授权（商业字体通常只授权
            本机使用，商用印刷前请核对授权范围）。
          </p>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
