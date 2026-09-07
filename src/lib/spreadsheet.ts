// 解析 Excel / CSV → DataRow[]（表头作为 key）
import * as XLSX from 'xlsx'
import type { DataRow } from '@/types/template'

export interface ParseResult {
  rows: DataRow[]
  headers: string[]
  fileName: string
}

function normalizeHeader(h: unknown): string {
  const s = String(h ?? '').trim()
  return s || `列${Math.random().toString(36).slice(2, 6)}`
}

export function parseSpreadsheet(
  file: File,
): Promise<ParseResult> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target!.result as ArrayBuffer)
        const wb = XLSX.read(data, { type: 'array' })
        const sheet = wb.Sheets[wb.SheetNames[0]]
        if (!sheet) return reject(new Error('未找到工作表'))
        // header:1 → 首行为表头；defval 统一空串方便变量回退
        const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
          header: 1,
          defval: '',
          blankrows: false,
        })
        if (aoa.length < 2) return resolve({ rows: [], headers: [], fileName: file.name })
        const rawHeaders = aoa[0].map(normalizeHeader)
        // 去重列头，避免 {{key}} 冲突
        const seen = new Map<string, number>()
        const headers = rawHeaders.map((h) => {
          const n = seen.get(h) ?? 0
          seen.set(h, n + 1)
          return n === 0 ? h : `${h}_${n}`
        })
        const rows: DataRow[] = aoa.slice(1).map((line) => {
          const row: DataRow = {}
          headers.forEach((h, idx) => {
            const v = line[idx]
            row[h] = (v === undefined ? '' : v) as string | number
          })
          return row
        })
        resolve({ rows, headers, fileName: file.name })
      } catch {
        reject(new Error('文件解析失败，请检查是否为有效表格'))
      }
    }
    reader.readAsArrayBuffer(file)
  })
}
