// 毫米与像素换算（DPI=96，浏览器标准）

export const DPI = 96
export const MM_PER_INCH = 25.4

export const mmToPx = (mm: number): number => (mm * DPI) / MM_PER_INCH
export const pxToMm = (px: number): number => (px * MM_PER_INCH) / DPI

export function roundMm(v: number): number {
  return Math.round(v * 100) / 100
}
