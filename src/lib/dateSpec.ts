/**
 * 日期对象：格式样式串 + 日期值 + 跨对象关联公式。
 *
 * 设计要点：日期对象**不是新的 ElementKind**，而是 kind='text' 的文本对象挂一份
 * `_dateSpec` 元数据。这样 PDF / PNG / 打印 / 数据绑定 / 序列化全部走既有文本通道，
 * 导出侧零改动 —— 日期最终就是一段文本。
 */

/** 关联公式：本对象的日期 = 来源日期对象 ± N 天/月/年 */
export interface DateFormula {
  /** 来源日期对象的用户命名（与「名称=表头」同一套命名空间） */
  source: string
  op: 'add' | 'sub'
  amount: number
  unit: 'day' | 'month' | 'year'
}

export interface DateSpec {
  /** 格式样式串，如 yyyy-MM-dd / dd/MM/yyyy / yyyy年M月d日 dddd */
  pattern: string
  /** 直接选定的日期（YYYY-MM-DD）；有 formula 时以公式结果为准 */
  value: string
  /** 关联公式（可选） */
  formula?: DateFormula
}

/** 预设格式，照 Excel「转换 → 日期 → 格式」列表的口径给全 */
export const DATE_PRESETS: { label: string; pattern: string }[] = [
  { label: '2001/03/14', pattern: 'yyyy/MM/dd' },
  { label: '2001/3/14', pattern: 'yyyy/M/d' },
  { label: '2001-3-14', pattern: 'yyyy-M-d' },
  { label: '20010314', pattern: 'yyyyMMdd' },
  { label: '2001.03.14', pattern: 'yyyy.MM.dd' },
  { label: '01/3/14', pattern: 'yy/M/d' },
  { label: '01-03-14', pattern: 'dd-MM-yy' },
  { label: '14/03/2001', pattern: 'dd/MM/yyyy' },
  { label: '2001年3月14日', pattern: 'yyyy年M月d日' },
  { label: '2001年3月14日 星期三', pattern: 'yyyy年M月d日 dddd' },
  { label: '14 Aug 2026', pattern: 'dd MMM yyyy' },
  { label: '14 August 2026', pattern: 'dd MMMM yyyy' },
  { label: 'Aug 14, 2026', pattern: 'MMM d, yyyy' },
]

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
/** 英文月份缩写 / 全称，供 MMM / MMMM token 使用 */
const MONTHS_EN_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTHS_EN_FULL = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/** 同时支持 yyyy/YYYY 与 dd/DD 两套写法；长 token 必须先匹配（MMMM > MMM > MM > M） */
const TOKEN_RE = /yyyy|YYYY|yy|YY|dddd|DDDD|MMMM|mmmm|MMM|mmm|dd|DD|d|D|MM|M/g

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** 按样式串格式化日期（本地时间，不引入 UTC 时区偏移） */
export function formatDate(date: Date, pattern: string): string {
  const y = date.getFullYear()
  const m = date.getMonth() + 1
  const d = date.getDate()
  return (pattern || 'yyyy-MM-dd').replace(TOKEN_RE, (tok) => {
    switch (tok) {
      case 'yyyy':
      case 'YYYY':
        return String(y)
      case 'yy':
      case 'YY':
        return pad2(y % 100)
      case 'dddd':
      case 'DDDD':
        return WEEKDAYS[date.getDay()]
      case 'dd':
      case 'DD':
        return pad2(d)
      case 'd':
      case 'D':
        return String(d)
      case 'MMMM':
      case 'mmmm':
        return MONTHS_EN_FULL[m - 1]
      case 'MMM':
      case 'mmm':
        return MONTHS_EN_SHORT[m - 1]
      case 'MM':
        return pad2(m)
      case 'M':
        return String(m)
      default:
        return tok
    }
  })
}

/** 解析日期值：YYYY-MM-DD / YYYY/MM/DD / YYYYMMDD / Date 可识别的字符串 */
export function parseDateValue(value: string): Date | null {
  const s = String(value ?? '').trim()
  if (!s) return null
  const m = /^(\d{4})[-/.]?(\d{1,2})[-/.]?(\d{1,2})$/.exec(s)
  if (m) {
    const y = Number(m[1])
    const mo = Number(m[2])
    const d = Number(m[3])
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
    const dt = new Date(y, mo - 1, d)
    // 拦截 2 月 30 日这类被 Date 自动进位的写法
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null
    return dt
  }
  return null
}

/** 月末钳制加减月/年：2026-08-31 + 6个月 → 2027-02-28（食品标签惯例） */
function addMonthsClamped(date: Date, delta: number): Date {
  const target = date.getMonth() + delta
  const y = date.getFullYear() + Math.floor(target / 12)
  const m = ((target % 12) + 12) % 12
  const lastDay = new Date(y, m + 1, 0).getDate()
  return new Date(y, m, Math.min(date.getDate(), lastDay))
}

export function applyFormula(base: Date, f: DateFormula): Date {
  const sign = f.op === 'sub' ? -1 : 1
  const n = Math.max(0, Math.floor(Number(f.amount) || 0)) * sign
  if (f.unit === 'month') return addMonthsClamped(base, n)
  if (f.unit === 'year') return addMonthsClamped(base, n * 12)
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + n)
}

export interface DateEntry {
  name: string
  spec: DateSpec
}

/**
 * 递归解析一组日期对象 → Map<对象名, 格式化后的显示文案>。
 * 有 formula 的对象以来源对象的结果为基准；循环引用（A→B→A）直接按「无来源」处理，
 * 避免整张标签的内容刷新陷入死循环。
 */
export function resolveDates(entries: Iterable<DateEntry>): Map<string, string> {
  const byName = new Map<string, DateSpec>()
  for (const e of entries) if (e.name) byName.set(e.name, e.spec)
  const cache = new Map<string, Date>()
  const visiting = new Set<string>()

  const valueOf = (name: string): Date | null => {
    if (cache.has(name)) return cache.get(name)!
    if (visiting.has(name)) return null // 循环引用 → 当作没有来源
    const spec = byName.get(name)
    if (!spec) return null
    visiting.add(name)
    let result: Date | null = null
    if (spec.formula?.source) {
      const base = valueOf(spec.formula.source)
      if (base) result = applyFormula(base, spec.formula)
    }
    if (!result) result = parseDateValue(spec.value)
    visiting.delete(name)
    if (result) cache.set(name, result)
    return result
  }

  const out = new Map<string, string>()
  for (const [name, spec] of byName) {
    const d = valueOf(name)
    if (d) out.set(name, formatDate(d, spec.pattern))
  }
  return out
}

/** 今天（本地时区）转 YYYY-MM-DD，供「插入日期」默认值 */
export function todayValue(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}
