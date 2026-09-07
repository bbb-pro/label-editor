// 内容解析：数据列 {{col}} + 跨对象引用 {{对象名}}
import type { DataRow } from '@/types/template'

export interface ContentSource {
  name: string
  design: string
}

const TOKEN = /\{\{\s*([^}]+?)\s*\}\}/g

/**
 * 解析一个对象的"设计文本"。
 * 单遍替换：列优先（{{col}} 取行），对象名次之（{{name}} 取其它内容对象的设计原文，递归解析）。
 * 未命中的占位原样保留，便于提示用户。
 */
export function resolveContent(
  design: string,
  row: DataRow | null,
  byName: Map<string, string>,
  guard: Set<string>,
  depth = 0,
): string {
  return design.replace(TOKEN, (_match, rawKey: string) => {
    const key = rawKey.trim()
    // 1) 数据列
    if (row && key in row) return String(row[key] ?? '')
    // 2) 跨对象引用
    const tgt = byName.get(key)
    if (!tgt) return `{{${key}}}`
    if (guard.has(key)) return `{{${key}}}`
    if (depth > 12) return `{{${key}}}`
    const g2 = new Set(guard)
    g2.add(key)
    return resolveContent(tgt, row, byName, g2, depth + 1)
  })
}

/** 收集内容对象中用到的所有变量名/对象名引用（用于属性面板提示） */
export function collectContentRefs(design: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  const re = /\{\{\s*([^}]+?)\s*\}\}/g
  while ((m = re.exec(design)) !== null) {
    const k = m[1].trim()
    if (!seen.has(k)) {
      seen.add(k)
      out.push(k)
    }
  }
  return out
}
