// 帮助中心：把 helpContent 里的条目渲染成一个可检索的说明面板
//
// 之所以做成弹窗而不是跳外链文档：编辑器是纯前端离线可用的工具，
// 帮助必须跟着应用一起走（离线包里不能指望能打开网页）。
import { useMemo, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { CircleHelp, Lightbulb, Search, TriangleAlert } from 'lucide-react'
import { HELP_GROUPS, HELP_TOPICS, type HelpBlock, type HelpTopic } from '@/lib/helpContent'

interface HelpCenterProps {
  open: boolean
  onOpenChange: (v: boolean) => void
  /** 打开时定位到某条（默认总览） */
  initialTopicId?: string
}

/**
 * 检索打分：0 = 未命中。标题 > 标签 > 正文，逐级降权 ——
 * 否则搜「校验位」时，正文里顺带提过一句的条目会排到真正讲校验位的那条前面。
 */
function score(t: HelpTopic, kw: string): number {
  if (!kw) return 1
  let s = 0
  if (t.title.toLowerCase().includes(kw)) s += 100
  if (t.tags.some((x) => x.toLowerCase().includes(kw))) s += 30
  const body = t.blocks
    .map((b) =>
      'text' in b ? b.text : 'items' in b ? b.items.map((i) => (Array.isArray(i) ? i.join(' ') : i)).join(' ') : '',
    )
    .join(' ')
    .toLowerCase()
  if (body.includes(kw)) s += 5
  return s
}

export default function HelpCenter({ open, onOpenChange, initialTopicId }: HelpCenterProps) {
  const [q, setQ] = useState('')
  const [activeId, setActiveId] = useState(initialTopicId ?? HELP_TOPICS[0].id)

  const kw = q.trim().toLowerCase()
  const hits = useMemo(() => {
    const scored = HELP_TOPICS.map((t) => ({ t, s: score(t, kw) })).filter((x) => x.s > 0)
    // 有关键词时按相关度排序；无关键词时保持原书写顺序（分组阅读更顺）
    if (kw) scored.sort((a, b) => b.s - a.s)
    return scored.map((x) => x.t)
  }, [kw])
  const active = useMemo(
    () => hits.find((t) => t.id === activeId) ?? hits[0] ?? HELP_TOPICS[0],
    [hits, activeId],
  )
  // 分组列表：只保留命中项，保持 HELP_GROUPS 的顺序
  const grouped = useMemo(
    () =>
      HELP_GROUPS.map((g) => ({ ...g, topics: hits.filter((t) => t.group === g.id) })).filter(
        (g) => g.topics.length > 0,
      ),
    [hits],
  )

  /** 目录条目（搜索态与分组态共用） */
  const topicItem = (t: HelpTopic) => (
    <li key={t.id}>
      <button
        type="button"
        onClick={() => setActiveId(t.id)}
        className={
          'w-full truncate rounded px-1.5 py-1 text-left text-[11px] transition-colors ' +
          (active.id === t.id
            ? 'bg-blue-500/10 font-medium text-blue-700 dark:text-blue-300'
            : 'text-muted-foreground hover:bg-accent hover:text-foreground')
        }
        title={t.title}
      >
        {t.title}
      </button>
    </li>
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5 text-base">
            <CircleHelp className="h-4 w-4 text-blue-600" />
            使用帮助
          </DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            共 {HELP_TOPICS.length} 条说明，涵盖制作、数据绑定、条码、多标签与导出打印。搜索框支持按内容检索。
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索帮助内容（如 校验位、GPSR、无边距、{{字段}}、扫不出来）"
              className="h-8 w-full rounded-md border bg-background pr-2 pl-7 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            />
          </div>
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {hits.length} / {HELP_TOPICS.length}
          </span>
        </div>

        <div className="flex min-h-0 gap-3">
          {/* 目录（窄屏时纵向堆叠在上方） */}
          <nav className="max-h-[62vh] w-full shrink-0 overflow-y-auto pr-1 sm:w-48">
            {kw ? (
              // 搜索态：按相关度**平铺**（标题命中 100 分 > 标签 30 > 正文 5）。
              // 不能沿用分组视图 —— 那样"搜 导出"时结果散在各个分组里，
              // 真正讲导出的那几条反而排在后面，用户得自己去翻。
              <ul>{hits.map(topicItem)}</ul>
            ) : (
              grouped.map((g) => (
                <div key={g.id} className="mb-2">
                  <div className="px-1 pb-0.5 text-[10px] font-medium tracking-wide text-muted-foreground">
                    {g.name}
                  </div>
                  <ul>{g.topics.map(topicItem)}</ul>
                </div>
              ))
            )}
            {hits.length === 0 && (
              <div className="px-2 py-6 text-center text-[11px] text-muted-foreground">
                没有匹配的条目
              </div>
            )}
          </nav>

          {/* 正文 */}
          <article className="max-h-[62vh] min-w-0 flex-1 overflow-y-auto pr-1">
            <h3 className="mb-2 text-sm font-semibold">{active.title}</h3>
            <div className="space-y-2">
              {active.blocks.map((b, i) => (
                <Block key={i} b={b} />
              ))}
            </div>
            <p className="mt-4 border-t pt-2 text-[10px] leading-relaxed text-muted-foreground">
              找不到答案？界面上的每个面板都有悬停提示；也可以把这条说明的标题当作关键词在帮助里搜一次。
            </p>
          </article>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Block({ b }: { b: HelpBlock }) {
  switch (b.t) {
    case 'p':
      return <p className="text-xs leading-relaxed text-foreground/85">{b.text}</p>
    case 'h':
      return <h4 className="pt-1 text-xs font-semibold text-foreground">{b.text}</h4>
    case 'steps':
      return (
        <ol className="space-y-1">
          {b.items.map((it, i) => (
            <li key={i} className="flex gap-1.5 text-xs leading-relaxed text-foreground/85">
              <span className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-blue-500/15 text-[9px] font-semibold text-blue-700 dark:text-blue-300">
                {i + 1}
              </span>
              <span>{it}</span>
            </li>
          ))}
        </ol>
      )
    case 'ul':
      return (
        <ul className="space-y-1">
          {b.items.map((it, i) => (
            <li key={i} className="flex gap-1.5 text-xs leading-relaxed text-foreground/85">
              <span className="mt-[6px] h-1 w-1 shrink-0 rounded-full bg-muted-foreground/70" />
              <span>{it}</span>
            </li>
          ))}
        </ul>
      )
    case 'kv':
      return (
        <dl className="divide-y overflow-hidden rounded-md border">
          {b.items.map(([k, v], i) => (
            <div key={i} className="flex gap-2 px-2 py-1.5">
              <dt className="w-28 shrink-0 text-[11px] font-medium text-foreground/90">{k}</dt>
              <dd className="text-[11px] leading-relaxed text-muted-foreground">{v}</dd>
            </div>
          ))}
        </dl>
      )
    case 'tip':
      return (
        <div className="flex gap-1.5 rounded-md border border-blue-500/30 bg-blue-500/5 px-2 py-1.5">
          <Lightbulb className="mt-px h-3.5 w-3.5 shrink-0 text-blue-600 dark:text-blue-400" />
          <p className="text-[11px] leading-relaxed text-foreground/85">{b.text}</p>
        </div>
      )
    case 'warn':
      return (
        <div className="flex gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/5 px-2 py-1.5">
          <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="text-[11px] leading-relaxed text-foreground/85">{b.text}</p>
        </div>
      )
    default:
      return null
  }
}
