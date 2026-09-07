// 文本样式：字体与常用字号清单（标签打印常用）

export const FONT_FAMILIES: { value: string; label: string }[] = [
  { value: 'Arial', label: 'Arial' },
  { value: 'Helvetica', label: 'Helvetica' },
  { value: 'Verdana', label: 'Verdana' },
  { value: 'Tahoma', label: 'Tahoma' },
  { value: 'Trebuchet MS', label: 'Trebuchet MS' },
  { value: 'Georgia', label: 'Georgia' },
  { value: 'Times New Roman', label: 'Times New Roman' },
  { value: 'Courier New', label: 'Courier New' },
  { value: 'Impact', label: 'Impact' },
  { value: 'Microsoft YaHei', label: '微软雅黑' },
  { value: 'SimSun', label: '宋体' },
  { value: 'SimHei', label: '黑体' },
  { value: 'KaiTi', label: '楷体' },
  { value: 'FangSong', label: '仿宋' },
]

export const FONT_SIZES_PT: number[] = [
  6, 7, 8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 32, 36, 40, 48,
]

/** px（fabric 使用）→ pt（展示给用户） */
export const pxToPt = (px: number): number => (px * 72) / 96
/** pt → px */
export const ptToPx = (pt: number): number => (pt * 96) / 72

export function clampPt(pt: number): number {
  if (!Number.isFinite(pt)) return 12
  return Math.min(200, Math.max(2, pt))
}
