/**
 * 标准合规标志（主体 24×24 viewBox；CE 用官方原始坐标系）。
 *
 * 来源分三类，务必区分清楚：
 *
 * ① **CE 标志** —— 几何**原样取自欧盟委员会官方矢量模型**
 *    （ec.europa.eu → "CE marking - vector and bitmap images" 内的 CE.ai）。
 *    CE 是法规强制标志，形状由 Regulation (EC) No 765/2008 附录 II 规定，
 *    不允许自行调整比例，所以这里连一个坐标都不改。
 *
 * ② **UN GHS 危险品九类** —— 不在本文件，见 `public/assets/marks-ghs.json`，
 *    由 `scripts/build-ghs-marks.mjs` 从 @ghs-hazard-pictograms/sprite（MIT）
 *    抽取，图形即 UN GHS 标准象形图（公有领域）。
 *
 * ③ 其余（ISO 3758 洗涤护理 / 回收环保 / 认证）为**按标准语义自绘**的线稿，
 *    供版式设计使用。
 *
 * ⚠️ 用途边界：②③ 属排版示意稿，用于法定合规声明（危险品运输包装、跨境平台
 *    合规、检测机构送审等）时，请以标准原文（GB 190 / GB/T 191 / ISO 3758 /
 *    UN GHS 等）与主管机构要求为准。CE ① 几何已与官方一致，但**加贴位置、
 *    最小高度（默认 5mm）、颜色对比度**等要求仍须自行确认。
 *
 * 元组：[id, 中文名, 检索词, 分类id, 样式, SVG 内部片段, viewBox（缺省 0 0 24 24）]
 * - 'line'   = 线稿，stroke 跟随当前颜色，可换色（与 Lucide 同款）
 * - 'filled' = 内含固有配色（CE 黑字、能效彩条），不参与换色
 */
export type MarkStyle = 'line' | 'filled'

type MarkTuple = [string, string, string, string, MarkStyle, string, string?]

// ════════════════════════════════════════════════════════════════════
// CE 标志 —— 欧盟官方几何，原样搬运
// ════════════════════════════════════════════════════════════════════
/**
 * 官方文件 CE.ai 用的是 PostScript 坐标（y 轴向上），
 * 这里用 `<g transform="translate(-111 749) scale(1 -1)">` 翻成 SVG 坐标：
 * 官方 (x, y) → SVG (x-111, 749-y)，于是外框正好落在 840×600。
 *
 * 官方网格自检（1 格 = 30 原单位，与各 CE 认证机构公布的规格逐项吻合）：
 *   字母高 = 600 → 20 格 ✓          笔画粗 = 90 → 3 格 ✓
 *   字母宽 = 332 → 11 格 ✓          外圆 ⌀600 → 20 格 ✓
 *   内圆 ⌀420 → 14 格 ✓             两字母圆心距 = 510 → 17 格（外圆重叠 3 格）✓
 *   E 中横长 = 175.2 → 6 格 ✓（位于圆心上下各 45 = 1.5 格处）✓
 *
 * ⚠️ 关键形态：两个字母的**背面都是圆弧**（同一组同心圆的环带），
 *    不是直竖线 —— 这是 CE 最常见的手绘错误来源。
 */
const CE_INNER =
  '<g transform="translate(-111 749) scale(1 -1)">' +
  '<path fill="#1a1a1a" d="M111 449C111 283.31 245.31 149 411 149C421.81 149 432.49 149.57 443 150.68' +
  'L443 241.42C432.57 239.82 421.88 239 411 239C295.02 239 201 333.02 201 449C201 564.98 295.02 659 411 659' +
  'C421.88 659 432.57 658.18 443 656.58L443 747.32C432.49 748.43 421.81 749 411 749C245.31 749 111 614.69 111 449Z"/>' +
  '<path fill="#1a1a1a" d="M951 150.48L951 241.13C941.2 239.72 931.19 239 921 239' +
  'C820.46 239 736.43 309.64 715.83 404L891 404L891 494L715.83 494C736.43 588.36 820.46 659 921 659' +
  'C931.19 659 941.2 658.28 951 656.88L951 747.52C941.13 748.5 931.13 749 921 749C755.31 749 621 614.69 621 449' +
  'C621 283.31 755.31 149 921 149C931.13 149 941.13 149.5 951 150.48Z"/>' +
  '</g>'

// ════════════════════════════════════════════════════════════════════
// ISO 3758 洗涤护理（自绘线稿）
// ════════════════════════════════════════════════════════════════════
/** 基本水洗符号：洗涤槽（上宽下窄）+ 槽内水面波纹 */
const TUB =
  '<path d="M4.2 7.6h15.6l-1.5 8.7a2.5 2.5 0 0 1-2.45 2.05H8.15A2.5 2.5 0 0 1 5.7 16.3L4.2 7.6Z"/>' +
  '<path d="M3.9 7.6q1.35-1.5 2.7 0t2.7 0 2.7 0 2.7 0 2.7 0"/>'

/**
 * 7 段式数字（6×10 骨架线稿）。
 * ⚠️ 不用 `<text>`：SVG 文字依赖字体，PDF 走 svg2pdf 时字体未必可用 →
 * 换成 path 既稳定可换色、导出也不会丢字形。
 */
const SEG: Record<string, string> = {
  '0': 'M1 0H5M6 1V4M6 6V9M1 10H5M0 6V9M0 1V4',
  '3': 'M1 0H5M6 1V4M6 6V9M1 10H5M1 5H5',
  '4': 'M6 1V4M6 6V9M0 1V4M1 5H5',
  '5': 'M1 0H5M6 6V9M1 10H5M0 1V4M1 5H5',
  '6': 'M1 0H5M6 6V9M1 10H5M0 1V4M0 6V9M1 5H5',
  '9': 'M1 0H5M6 1V4M6 6V9M1 10H5M0 1V4M1 5H5',
}
/** 把数字串画进洗涤槽内；x/y 为左上角，k 为整体缩放 */
const digits = (s: string, x: number, y: number, k = 0.78): string =>
  `<g transform="translate(${x} ${y}) scale(${k})">` +
  s
    .split('')
    .map((ch, i) => `<path transform="translate(${i * 7.4} 0)" d="${SEG[ch] ?? ''}"/>`)
    .join('') +
  '</g>'

/** 禁止叠加叉 */
const NO = '<path d="M4.5 4.5 19.5 19.5M19.5 4.5 4.5 19.5"/>'
/** 熨斗 */
const IRON =
  '<path d="M5.6 16c0-3.5 1.7-5.9 4.6-5.9h5.3a3.5 3.5 0 0 1 3.5 3.5V16Z"/>' +
  '<path d="M4.8 17.8h14.4"/>'
/** 漂白三角 */
const TRI = '<path d="M12 4.5 20 18.5H4L12 4.5Z"/>'
/** 滚筒干燥（方框内含圆） */
const TUMBLE = '<rect x="4.6" y="4.6" width="14.8" height="14.8" rx="1"/><circle cx="12" cy="12" r="4.2"/>'
/** 专业干洗（圆） */
const DC = '<circle cx="12" cy="12" r="8"/>'
/** 干洗字母 P（四氯乙烯） */
const LETTER_P = '<path d="M10 16.2V7.8h2.7a2.7 2.7 0 0 1 0 5.4H10"/>'

// ════════════════════════════════════════════════════════════════════
// 回收 / 环保（自绘线稿）
// ════════════════════════════════════════════════════════════════════
/** 循环回收：三个箭头绕中心 120° 旋转，构成莫比乌斯三角 */
const RECYCLE_ARM =
  '<path d="M12 4.6 18.41 15.7"/><path d="M15.98 14.1 18.41 15.7 18.24 12.8"/>'
const RECYCLE =
  `<g>${RECYCLE_ARM}</g>` +
  `<g transform="rotate(120 12 12)">${RECYCLE_ARM}</g>` +
  `<g transform="rotate(240 12 12)">${RECYCLE_ARM}</g>`

/**
 * WEEE（废弃电子电气设备）—— 打叉的带轮垃圾桶。
 * ⚠️ 这个符号**必须有叉**：少了叉就退化成普通垃圾桶，含义完全变了
 *   （旧版本漏了叉与轮子，已修正）。
 */
const WEEE =
  '<path d="M5.2 8.1h13.6"/>' +
  '<path d="M7.3 8.1 8.4 18.4h7.2L16.7 8.1"/>' +
  '<circle cx="9.9" cy="20.5" r="1.15"/>' +
  '<circle cx="14.1" cy="20.5" r="1.15"/>' +
  '<path d="M5 5 19 19M19 5 5 19"/>'

const line = (id: string, name: string, kw: string, cat: string, body: string): MarkTuple => [
  id,
  name,
  kw,
  cat,
  'line',
  body,
]

export const MARKS: MarkTuple[] = [
  // ══ ISO 3758 洗涤护理 ══
  line('wash', '水洗', '洗涤 可水洗 wash 洗标', 'wash', TUB),
  line('wash-30', '30℃水洗', '30度 水洗 洗涤 wash 温和', 'wash', TUB + digits('30', 6.6, 8.7)),
  line('wash-40', '40℃水洗', '40度 水洗 洗涤 wash', 'wash', TUB + digits('40', 6.6, 8.7)),
  line('wash-60', '60℃水洗', '60度 水洗 洗涤 wash', 'wash', TUB + digits('60', 6.6, 8.7)),
  line('wash-95', '95℃水洗', '95度 水洗 洗涤 wash 高温 煮沸', 'wash', TUB + digits('95', 6.6, 8.7)),
  line(
    'hand-wash',
    '手洗',
    '手洗 hand wash 温和 手',
    'wash',
    TUB +
      '<path d="M9.4 12.4V9.1a1 1 0 0 1 2 0v3.3M11.4 11.9V8.3a1 1 0 0 1 2 0v4.6M13.4 12.4v-2.8a1 1 0 0 1 2 0v5.3a2.4 2.4 0 0 1-2.4 2.4h-1.1a2.6 2.6 0 0 1-2.6-2.6v-2.3"/>',
  ),
  line('no-wash', '不可水洗', '不能水洗 禁止洗涤 do not wash', 'wash', TUB + NO),
  line('bleach', '允许漂白', '漂白 bleach 氯漂 氧漂', 'wash', TRI),
  line('no-bleach', '不可漂白', '禁止漂白 do not bleach 不能氯漂', 'wash', TRI + NO),
  line('tumble-dry', '可滚筒干燥', '烘干 滚筒干燥 tumble dry 干燥', 'wash', TUMBLE),
  line('no-tumble-dry', '不可滚筒干燥', '禁止烘干 do not tumble dry', 'wash', TUMBLE + NO),
  line(
    'line-dry',
    '悬挂晾干',
    '晾干 悬挂 dry 挂干 悬挂干燥',
    'wash',
    '<rect x="4.6" y="4.6" width="14.8" height="14.8" rx="1"/><path d="M12 4.6v14.8"/>',
  ),
  line(
    'flat-dry',
    '平摊晾干',
    '平铺 平摊 晾干 flat dry 阴干',
    'wash',
    '<rect x="4.6" y="4.6" width="14.8" height="14.8" rx="1"/><path d="M4.6 12h14.8"/>',
  ),
  line(
    'iron-low',
    '低温熨烫',
    '低温 熨烫 iron low 熨斗 100度',
    'wash',
    IRON + '<circle cx="12" cy="13.6" r="0.85"/>',
  ),
  line(
    'iron-mid',
    '中温熨烫',
    '中温 熨烫 iron medium 熨斗 150度',
    'wash',
    IRON + '<circle cx="10.5" cy="13.6" r="0.85"/><circle cx="13.5" cy="13.6" r="0.85"/>',
  ),
  line(
    'iron-high',
    '高温熨烫',
    '高温 熨烫 iron high 熨斗 200度',
    'wash',
    IRON +
      '<circle cx="9.4" cy="13.6" r="0.85"/><circle cx="12" cy="13.6" r="0.85"/><circle cx="14.6" cy="13.6" r="0.85"/>',
  ),
  line('no-iron', '不可熨烫', '禁止熨烫 do not iron', 'wash', IRON + NO),
  line('dry-clean', '专业干洗', '干洗 dry clean 四氯乙烯 P', 'wash', DC + LETTER_P),
  line('no-dry-clean', '不可干洗', '禁止干洗 do not dry clean', 'wash', DC + LETTER_P + NO),

  // ══ 回收 / 环保 ══
  line('recycle', '循环回收', '回收 可回收 recycle 循环 环保', 'recycle', RECYCLE),
  line('no-recycle', '不可回收', '不能回收 禁止回收 non-recyclable', 'recycle', RECYCLE + NO),
  line('weee', 'WEEE 电子废弃物', '电子电器 废弃物 垃圾桶 WEEE 报废 回收', 'recycle', WEEE),
  line(
    'battery-recycle',
    '电池回收',
    '电池 回收 battery 蓄电池 锂电',
    'recycle',
    '<rect x="4.8" y="8" width="12.4" height="11" rx="1.4"/><path d="M17.2 11.2h2.2v4.6h-2.2"/><path d="M8.4 13.5h5.2M11 11.9l1.6 1.6-1.6 1.6"/>',
  ),
  line(
    'paper-recycle',
    '纸类回收',
    '纸 纸箱 回收 paper 纸板 瓦楞',
    'recycle',
    '<path d="M6.4 4.6h6.9l4.3 4.3v10.5H6.4z"/><path d="M13.3 4.6v4.3h4.3"/><path d="M9 15.6h6"/>',
  ),
  line(
    'plastic-recycle',
    '塑料回收',
    '塑料 回收 plastic 树脂 三角',
    'recycle',
    '<path d="M12 5.2 19.6 18.4H4.4Z"/><path d="M12 10.2 15.6 16.6H8.4Z"/>',
  ),

  // ══ 认证 / 标识 ══
  [
    'ce',
    'CE 标志',
    'CE 欧盟 认证 出口 Conformité Européenne',
    'cert',
    'filled',
    CE_INNER,
    // 官方模型真实外框比例 840:600 ≈ 1.4:1，不做二次裁剪
    '0 0 840 600',
  ],
  line(
    'pb-free',
    '无铅 Pb-Free',
    '无铅 铅 有害物质 RoHS Pb free',
    'cert',
    '<circle cx="12" cy="12" r="8.4"/>' +
      '<path d="M8.6 16.2V7.8h2.2a2.4 2.4 0 0 1 0 4.8H8.6"/>' +
      '<path d="M14.9 16.2V7.4"/>' +
      '<path d="M14.9 11.4h1.1a2.4 2.4 0 0 1 0 4.8h-1.1"/>' +
      '<path d="M5.6 18.4 18.4 5.6"/>',
  ),
  line(
    'eco-leaf',
    '环保绿叶',
    '环保 绿色 生态 eco 绿叶 绿色产品',
    'cert',
    '<path d="M19.4 4.6c0 8.3-4.3 12.8-11.4 12.8H5.4C5.4 9.5 9.9 4.6 19.4 4.6Z"/><path d="M5.4 19.4c1.8-3.4 4.4-6 7.8-7.8"/>',
  ),
  [
    'energy-label',
    '能效等级色阶',
    '能效 等级 能耗 energy label 家电 色阶',
    'cert',
    'filled',
    '<rect x="4.8" y="2.8" width="14.4" height="18.4" rx="1.2" fill="#ffffff" stroke="#1a1a1a" stroke-width="1"/>' +
      '<rect x="6.5" y="4.6" width="11" height="2.5" fill="#00a651"/>' +
      '<rect x="6.5" y="7.8" width="9.4" height="2.5" fill="#bfd730"/>' +
      '<rect x="6.5" y="11" width="7.8" height="2.5" fill="#fff200"/>' +
      '<rect x="6.5" y="14.2" width="6.2" height="2.5" fill="#fdb913"/>' +
      '<rect x="6.5" y="17.4" width="4.6" height="2.5" fill="#ed1c24"/>',
  ],
]

/** 合规标志分类（供素材面板分组） */
export const MARK_CATS: { id: string; label: string }[] = [
  { id: 'ghs', label: '危险品标示' },
  { id: 'wash', label: '洗涤护理' },
  { id: 'recycle', label: '回收环保' },
  { id: 'cert', label: '认证标识' },
]
