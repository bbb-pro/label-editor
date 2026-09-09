/**
 * 素材面板：本地 CC0 / 宽松许可素材库（Lucide 图标 + Twemoji 表情）。
 *
 * 点击素材即插入到标签画布中心。数据首次打开时才 fetch（放在 public/assets，
 * 不进主包），网格采用「渲染上限 + 滚动到底继续加载」，避免一次性铺 2000 个矢量节点卡顿。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { X, Search, Loader2, Sparkles, LockKeyhole } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { AssetCat, AssetItem } from '@/types/assets'
import { assetPreviewUri, collectCategories, filterAssets, loadEmojiSet, loadLucideSet, loadSymbolsSet } from '@/lib/assetsLib'

/** 每批渲染数量：够铺满一屏即可，滚动到底再追加，避免首屏卡顿 */
const PAGE_SIZE = 80

interface AssetsPanelProps {
  open: boolean
  onClose: () => void
  onInsert: (item: AssetItem) => void
}

export default function AssetsPanel({ open, onClose, onInsert }: AssetsPanelProps) {
  const [items, setItems] = useState<AssetItem[]>([])
  const [licenses, setLicenses] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cat, setCat] = useState('all')
  const [query, setQuery] = useState('')
  const [visible, setVisible] = useState(PAGE_SIZE)
  const scrollRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  // 点击面板外部（空白处）关闭；工具栏「素材」按钮带 data-assets-trigger，由其自身 toggle 处理
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Element | null
      if (!t) return
      if (panelRef.current?.contains(t)) return
      if (t.closest('[data-assets-trigger]')) return
      onClose()
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open, onClose])

  // 首次打开时懒加载数据
  useEffect(() => {
    if (!open || items.length) return
    let alive = true
    const run = async () => {
      setLoading(true)
      setError(null)
      try {
        const [lucide, emoji] = await Promise.all([loadLucideSet(), loadEmojiSet()])
        const symbols = loadSymbolsSet()
        if (!alive) return
        setItems([...symbols.items, ...lucide.items, ...emoji.items])
        setLicenses([lucide.license, symbols.license, emoji.license])
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : '素材数据加载失败')
      } finally {
        if (alive) setLoading(false)
      }
    }
    void run()
    return () => {
      alive = false
    }
  }, [open, items.length])

  // 切换筛选后回到顶部并重置渲染量
  useEffect(() => {
    setVisible(PAGE_SIZE)
    scrollRef.current?.scrollTo({ top: 0 })
  }, [cat, query])

  const cats = useMemo<AssetCat[]>(() => collectCategories(items, 'all'), [items])
  const filtered = useMemo<AssetItem[]>(() => filterAssets(items, query, cat, 'all'), [items, query, cat])
  const shown = filtered.slice(0, visible)

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 120) {
      setVisible((v) => (v < filtered.length ? Math.min(filtered.length, v + PAGE_SIZE) : v))
    }
  }

  if (!open) return null

  return (
    <div
      ref={panelRef}
      className="fixed left-[4.25rem] top-16 bottom-4 z-40 flex w-[340px] max-w-[calc(100vw-5.5rem)] flex-col overflow-hidden rounded-xl border bg-background shadow-2xl"
    >
      {/* 头部 */}
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Sparkles className="h-4 w-4 shrink-0 text-teal-600" />
        <span className="flex-1 text-sm font-medium">素材库</span>
        <span className="text-[10px] text-muted-foreground">{items.length || '…'}</span>
        <button
          type="button"
          onClick={onClose}
          title="关闭"
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* 搜索 */}
      <div className="relative px-3 pt-2">
        <Search className="pointer-events-none absolute left-5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索中文名，如 包裹 / 笑脸"
          className="h-8 pl-7 text-xs"
        />
      </div>

      {/* 分类 */}
      <div className="flex gap-1 overflow-x-auto px-3 py-2" style={{ scrollbarWidth: 'thin' }}>
        <Chip active={cat === 'all'} onClick={() => setCat('all')} label="全部" />
        {cats.map((c) => (
          <Chip key={c.id} active={cat === c.id} onClick={() => setCat(c.id)} label={c.label} />
        ))}
      </div>

      {/* 结果网格 */}
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
        {loading && (
          <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在加载素材…
          </div>
        )}
        {error && <div className="py-8 text-center text-xs text-destructive">{error}</div>}
        {!loading && !error && filtered.length === 0 && (
          <div className="py-10 text-center text-[11px] text-muted-foreground">没有匹配的素材</div>
        )}
        <div className="grid grid-cols-4 gap-1.5">
          {shown.map((item) => (
            <AssetTile key={item.id} item={item} onClick={() => onInsert(item)} />
          ))}
        </div>
        {shown.length < filtered.length && (
          <div className="py-3 text-center text-[10px] text-muted-foreground">下滑加载更多（{shown.length}/{filtered.length}）</div>
        )}
      </div>

      {/* 许可署名 */}
      <div className="flex items-start gap-1.5 border-t px-3 py-2 text-[10px] leading-tight text-muted-foreground">
        <LockKeyhole className="mt-px h-3 w-3 shrink-0" />
        <span>{licenses.length ? licenses.join(' · ') : '本地素材'}</span>
      </div>
    </div>
  )
}

function Chip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'shrink-0 rounded-full border px-2 py-0.5 text-[10px] transition-colors',
        active ? 'border-primary/40 bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent',
      )}
    >
      {label}
    </button>
  )
}

function AssetTile({ item, onClick }: { item: AssetItem; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={item.name}
      className="group flex flex-col items-center gap-1 rounded-md border border-transparent px-1 py-1.5 transition-colors hover:border-primary/30 hover:bg-accent"
    >
      <div className="flex h-8 w-full items-center justify-center">
        {/* emoji 直接用字符渲染，比解析整段 SVG 便宜很多 */}
        {item.preview ? (
          <span className="text-[22px] leading-none">{item.preview}</span>
        ) : (
          <img src={assetPreviewUri(item)} alt={item.name} className="h-7 w-7 object-contain" />
        )}
      </div>
      <span className="w-full truncate text-center text-[9px] leading-none text-muted-foreground group-hover:text-foreground">
        {item.name}
      </span>
    </button>
  )
}
