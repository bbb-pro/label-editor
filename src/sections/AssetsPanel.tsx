/**
 * 素材面板：两类来源。
 *
 * · **精选** —— Lucide 图标 / Twemoji 表情 / 包装储运标志 / 标准合规标志。
 *   体量小（约 600KB），打开面板一次性加载。
 * · **扩展** —— 外部图标库 81 类 / 4000+ 项，含 ISO 3758 洗涤护理、ISO 7010 安全标志、
 *   回收环保、认证、GHS-ADR 危险品、欧盟能效等。整库 30MB+，不可能一次拉全：
 *   **只加载分类索引**（几 KB），用户在分类卡片里点哪一类，才下载那一类的数据。
 *
 * 网格采用「渲染上限 + 滚动到底继续加载」，避免一次性铺几千个矢量节点卡顿。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { X, Search, Loader2, Sparkles, LockKeyhole, ChevronLeft } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { AssetCat, AssetItem } from '@/types/assets'
import {
  assetPreviewUri,
  collectCategories,
  filterAssets,
  loadEmojiSet,
  loadKtmCat,
  loadKtmIndex,
  loadLucideSet,
  loadMarksSet,
  loadSymbolsSet,
  type KtmCatInfo,
} from '@/lib/assetsLib'

/** 每批渲染数量：够铺满一屏即可，滚动到底再追加，避免首屏卡顿 */
const PAGE_SIZE = 80

type Source = 'core' | 'ktm'

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
  const [source, setSource] = useState<Source>('core')
  /** 扩展图标库的分类索引（轻量，随面板一起加载） */
  const [ktmCats, setKtmCats] = useState<KtmCatInfo[]>([])
  const [ktmTotal, setKtmTotal] = useState(0)
  /** 正在加载中的分类 id，用于卡片上的转圈 */
  const [ktmLoading, setKtmLoading] = useState<string | null>(null)
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

  // 首次打开时懒加载数据：精选四集合 + 扩展库的分类索引
  useEffect(() => {
    if (!open || items.length) return
    let alive = true
    const run = async () => {
      setLoading(true)
      setError(null)
      try {
        const [lucide, emoji, marks, ktm] = await Promise.all([
          loadLucideSet(),
          loadEmojiSet(),
          loadMarksSet(),
          loadKtmIndex().catch(() => null), // 索引拿不到不该拖垮整个面板
        ])
        const symbols = loadSymbolsSet()
        if (!alive) return
        setItems([...marks.items, ...symbols.items, ...lucide.items, ...emoji.items])
        setLicenses(
          [lucide.license, symbols.license, marks.license, emoji.license, ktm?.license ?? ''].filter(Boolean),
        )
        if (ktm) {
          setKtmCats(ktm.cats)
          setKtmTotal(ktm.total)
        }
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
  }, [cat, query, source])

  /** 按来源圈定范围：扩展库的素材分类 id 都带 ktm- 前缀 */
  const scoped = useMemo(
    () => items.filter((it) => (source === 'ktm' ? it.set === 'ktm' : it.set !== 'ktm')),
    [items, source],
  )
  const cats = useMemo<AssetCat[]>(() => collectCategories(scoped, 'all'), [scoped])
  const filtered = useMemo<AssetItem[]>(() => filterAssets(scoped, query, cat, 'all'), [scoped, query, cat])
  const shown = filtered.slice(0, visible)

  /** 选分类：扩展库里若这一类还没下过，就地拉取 */
  const selectCat = useCallback(
    (id: string) => {
      setCat(id)
      if (!id.startsWith('ktm-')) return
      if (items.some((it) => it.cat === id)) return
      const info = ktmCats.find((c) => c.id === id)
      if (!info) return
      setKtmLoading(id)
      void loadKtmCat(info)
        .then((list) => setItems((prev) => [...prev, ...list]))
        .catch(() => setError(`「${info.label}」加载失败，请重试`))
        .finally(() => setKtmLoading(null))
    },
    [items, ktmCats],
  )

  const switchSource = useCallback((next: Source) => {
    setSource(next)
    setCat('all')
    setQuery('')
  }, [])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 120) {
      setVisible((v) => (v < filtered.length ? Math.min(filtered.length, v + PAGE_SIZE) : v))
    }
  }

  if (!open) return null

  // 扩展库的分类浏览态：没选分类也没搜索时，铺分类卡片（点进去才下载那一类）
  const browseCats = source === 'ktm' && cat === 'all' && !query

  return (
    <div
      ref={panelRef}
      className="fixed left-[4.25rem] top-16 bottom-4 z-40 flex w-[340px] max-w-[calc(100vw-5.5rem)] flex-col overflow-hidden rounded-xl border bg-background shadow-2xl"
    >
      {/* 头部 */}
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Sparkles className="h-4 w-4 shrink-0 text-teal-600" />
        <span className="flex-1 text-sm font-medium">素材库</span>
        <span className="text-[10px] text-muted-foreground">
          {source === 'ktm' ? `${ktmTotal || '…'} 项 · ${ktmCats.length} 类` : items.filter((i) => i.set !== 'ktm').length || '…'}
        </span>
        <button
          type="button"
          onClick={onClose}
          title="关闭"
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* 来源切换 */}
      <div className="flex gap-1 border-b px-3 py-2">
        <SourceTab active={source === 'core'} onClick={() => switchSource('core')} label="精选" />
        <SourceTab
          active={source === 'ktm'}
          onClick={() => switchSource('ktm')}
          label={`扩展图标库${ktmCats.length ? ` ${ktmTotal}` : ''}`}
        />
      </div>

      {/* 搜索 */}
      <div className="relative px-3 pt-2">
        <Search className="pointer-events-none absolute left-5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={source === 'ktm' ? '搜索已加载的分类，如 洗涤 / 回收' : '搜索中文名，如 包裹 / 笑脸'}
          className="h-8 pl-7 text-xs"
        />
      </div>

      {/* 分类：精选走横滚 chips；扩展库靠分类卡片选，选中后给一个返回入口 */}
      {!browseCats && (
        <div className="flex items-center gap-1 overflow-x-auto px-3 py-2" style={{ scrollbarWidth: 'thin' }}>
          {source === 'ktm' ? (
            <>
              <button
                type="button"
                onClick={() => setCat('all')}
                className="flex shrink-0 items-center gap-0.5 rounded-full border px-2 py-0.5 text-[10px] text-primary hover:bg-accent"
              >
                <ChevronLeft className="h-3 w-3" />
                全部分类
              </button>
              <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary">
                {ktmCats.find((c) => c.id === cat)?.label ?? cat}
              </span>
            </>
          ) : (
            <>
              <Chip active={cat === 'all'} onClick={() => setCat('all')} label="全部" />
              {cats.map((c) => (
                <Chip key={c.id} active={cat === c.id} onClick={() => setCat(c.id)} label={c.label} />
              ))}
            </>
          )}
        </div>
      )}

      {/* 结果区 */}
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
        {loading && (
          <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在加载素材…
          </div>
        )}
        {error && <div className="py-8 text-center text-xs text-destructive">{error}</div>}

        {!loading && browseCats && (
          <>
            <div className="py-1 text-[10px] leading-relaxed text-muted-foreground">
              点分类即下载该类的图形（整库 30MB+，按需取用）
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {ktmCats.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => selectCat(c.id)}
                  className="flex items-center justify-between gap-1 rounded-md border px-2 py-2 text-left text-[11px] transition-colors hover:border-primary/40 hover:bg-accent"
                >
                  <span className="truncate">{c.label}</span>
                  {ktmLoading === c.id ? (
                    <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary" />
                  ) : (
                    <span className="shrink-0 text-[10px] text-muted-foreground">{c.count}</span>
                  )}
                </button>
              ))}
            </div>
          </>
        )}

        {!loading && !error && !browseCats && filtered.length === 0 && (
          <div className="py-10 text-center text-[11px] text-muted-foreground">没有匹配的素材</div>
        )}
        {!browseCats && (
          <div className="grid grid-cols-4 gap-1.5">
            {shown.map((item) => (
              <AssetTile key={item.id} item={item} onClick={() => onInsert(item)} />
            ))}
          </div>
        )}
        {!browseCats && shown.length < filtered.length && (
          <div className="py-3 text-center text-[10px] text-muted-foreground">
            下滑加载更多（{shown.length}/{filtered.length}）
          </div>
        )}
      </div>

      {/* 许可署名 */}
      <div className="flex items-start gap-1.5 border-t px-3 py-2 text-[10px] leading-tight text-muted-foreground">
        <LockKeyhole className="mt-px h-3 w-3 shrink-0" />
        <span>{licenses.filter(Boolean).length ? licenses.filter(Boolean).join(' · ') : '本地素材'}</span>
      </div>
    </div>
  )
}

function SourceTab({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex-1 rounded-md px-2 py-1 text-[11px] transition-colors',
        active ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-accent',
      )}
    >
      {label}
    </button>
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
      title={item.rasterSize ? `${item.name}（位图 ${item.rasterSize}）` : item.name}
      className="group flex flex-col items-center gap-1 rounded-md border border-transparent px-1 py-1.5 transition-colors hover:border-primary/30 hover:bg-accent"
    >
      <div className="flex h-8 w-full items-center justify-center">
        {/* emoji 直接用字符渲染，比解析整段 SVG 便宜很多 */}
        {item.preview ? (
          <span className="text-[22px] leading-none">{item.preview}</span>
        ) : (
          <img src={assetPreviewUri(item)} alt={item.name} loading="lazy" className="h-7 w-7 object-contain" />
        )}
      </div>
      <span className="w-full truncate text-center text-[9px] leading-none text-muted-foreground group-hover:text-foreground">
        {item.name}
      </span>
    </button>
  )
}
