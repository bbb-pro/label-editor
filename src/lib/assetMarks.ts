/**
 * 标准合规标志（自绘，24×24 线稿）。
 *
 * 覆盖四类：UN GHS 危险品象形图 / ISO 3758 洗涤护理 / 回收环保 / 认证标识。
 * 与 `assetSymbols.ts` 的包装储运标志同一原则：**按标准规定的图形语义原创绘制**，
 * 不复制任何厂商、图标站或标准出版物插图的原始图样，因此可自由换色、缩放、
 * 矢量导出，不引入第三方许可问题。
 *
 * ⚠️ 用途边界：本组图形是**排版示意稿**，供标签版式设计使用。若用于法定合规
 *    声明（危险品运输包装、跨境平台合规、检测机构送审等），请以标准原文
 *    （GB 190 / GB/T 191 / ISO 3758 / UN GHS 等）与主管机构要求为准。
 *
 * 元组：[id, 中文名, 检索词, 分类id, 样式, SVG 内部片段]
 * - 'line'   = 线稿，stroke 跟随当前颜色，可换色（与 Lucide 同款）
 * - 'filled' = 内含固有配色（如 GHS 红边框），不参与换色
 */
export type MarkStyle = 'line' | 'filled'

type MarkTuple = [string, string, string, string, MarkStyle, string]

// ── GHS 危险品：红边白底菱形外框，九个象形图共用 ──
const GHS_FRAME =
  '<path d="M12 2 22 12 12 22 2 12Z" fill="#ffffff" stroke="#e60012" stroke-width="1.8"/>'
const ghs = (id: string, name: string, kw: string, body: string): MarkTuple => [
  id,
  name,
  `GHS 危险品 化学品 警示 ${kw}`,
  'ghs',
  'filled',
  GHS_FRAME + body,
]

// ── ISO 3758 洗涤：基本水洗符号（洗涤槽 + 顶部波纹）──
const TUB =
  '<path d="M4.2 7.6h15.6l-1.5 8.7a2.5 2.5 0 0 1-2.45 2.05H8.15A2.5 2.5 0 0 1 5.7 16.3L4.2 7.6Z"/>' +
  '<path d="M3.9 7.6q1.35-1.5 2.7 0t2.7 0 2.7 0 2.7 0 2.7 0"/>'

/**
 * 7 段式数字（6×10 骨架线稿）。
 * ⚠️ 不用 `<text>`：SVG 里的文字依赖字体，而线稿套壳把 `fill` 设为 none、
 * 只保留 stroke —— 文字会不可见；换成 path 后既稳定可换色、导出也不会丢字形。
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
/** 熨斗（ISO 3758 熨烫）*/
const IRON =
  '<path d="M5.6 16c0-3.5 1.7-5.9 4.6-5.9h5.3a3.5 3.5 0 0 1 3.5 3.5V16Z"/>' +
  '<path d="M4.8 17.8h14.4"/>'
/** 漂白三角 */
const TRI = '<path d="M12 4.5 20 18.5H4L12 4.5Z"/>'
/** 滚筒干燥（方框内含圆）*/
const TUMBLE = '<rect x="4.6" y="4.6" width="14.8" height="14.8" rx="1"/><circle cx="12" cy="12" r="4.2"/>'
/** 专业干洗（圆）*/
const DC = '<circle cx="12" cy="12" r="8"/>'
/** 干洗字母 P */
const LETTER_P = '<path d="M10 16.2V7.8h2.7a2.7 2.7 0 0 1 0 5.4H10"/>'
/** 循环回收：三个箭头绕中心 120° 旋转，构成莫比乌斯三角 */
const RECYCLE_ARM =
  '<path d="M12 4.6 18.41 15.7"/><path d="M15.98 14.1 18.41 15.7 18.24 12.8"/>'
const RECYCLE =
  `<g>${RECYCLE_ARM}</g>` +
  `<g transform="rotate(120 12 12)">${RECYCLE_ARM}</g>` +
  `<g transform="rotate(240 12 12)">${RECYCLE_ARM}</g>`

const line = (id: string, name: string, kw: string, cat: string, body: string): MarkTuple => [
  id,
  name,
  kw,
  cat,
  'line',
  body,
]

export const MARKS: MarkTuple[] = [
  // ══ GHS 危险品象形图（UN GHS 九类）══
  ghs(
    'ghs01',
    '爆炸物',
    '易爆 爆炸物 explosive 1.1 烟花爆竹',
    '<circle cx="12" cy="12.4" r="3.1" fill="#1a1a1a"/><path d="M12 5.9v3.3M12 15.6v3.3M5.4 12.4h3.3M15.3 12.4h3.3M7.3 7.7l2.4 2.4M14.3 14.7l2.4 2.4M16.7 7.7l-2.4 2.4M9.7 14.7l-2.4 2.4" stroke="#1a1a1a" stroke-width="1.1" stroke-linecap="round"/>',
  ),
  ghs(
    'ghs02',
    '易燃',
    '易燃 可燃 flammable 火 火焰 酒精',
    '<path d="M12 5c0 3.1-4.1 4.5-4.1 8.2a4.1 4.1 0 0 0 8.2 0C16.1 9.5 12 8.1 12 5z" fill="#1a1a1a"/>',
  ),
  ghs(
    'ghs03',
    '氧化剂',
    '氧化 助燃 oxidizer 过氧化物',
    '<circle cx="12" cy="16" r="2.3" fill="none" stroke="#1a1a1a" stroke-width="1.2"/><path d="M12 5.4c0 2.2-2.7 3.3-2.7 5.9a2.7 2.7 0 0 0 5.4 0c0-2.6-2.7-3.7-2.7-5.9z" fill="#1a1a1a"/>',
  ),
  ghs(
    'ghs04',
    '高压气体',
    '气体 气瓶 compressed gas 高压 液化',
    '<rect x="9.8" y="8.4" width="4.4" height="9.5" rx="1.1" fill="#1a1a1a"/><rect x="10.9" y="5.9" width="2.2" height="2.5" fill="#1a1a1a"/>',
  ),
  ghs(
    'ghs05',
    '腐蚀性',
    '腐蚀 corrosive 酸碱 灼伤 金属',
    '<path d="M6.6 11.1h10.8" stroke="#1a1a1a" stroke-width="1.4" stroke-linecap="round"/><path d="M9.2 13v2.4M12 13v2.9M14.8 13v2.4" stroke="#1a1a1a" stroke-width="1.1" stroke-linecap="round"/><path d="M6.4 17.6h4.4M16.4 17.6h1.2" stroke="#1a1a1a" stroke-width="1.4" stroke-linecap="round"/>',
  ),
  ghs(
    'ghs06',
    '剧毒',
    '剧毒 有毒 toxic 骷髅 致死',
    '<path d="M12 6.2c-2.5 0-4.2 1.7-4.2 4.1 0 1.5.6 2.6 1.7 3.2v2.1h5v-2.1c1.1-.6 1.7-1.7 1.7-3.2 0-2.4-1.7-4.1-4.2-4.1z" fill="#1a1a1a"/><circle cx="10.3" cy="10.2" r="1.1" fill="#ffffff"/><circle cx="13.7" cy="10.2" r="1.1" fill="#ffffff"/><path d="M12 12.4v1.7" stroke="#ffffff" stroke-width="0.9"/><path d="M8.3 7 6.5 5.5M15.7 7l1.8-1.5" stroke="#1a1a1a" stroke-width="1.2" stroke-linecap="round"/>',
  ),
  ghs(
    'ghs07',
    '有害刺激',
    '有害 刺激 注意 harmful irritant 感叹号',
    '<path d="M12 6.6v6.1" stroke="#1a1a1a" stroke-width="2.1" stroke-linecap="round"/><circle cx="12" cy="16.4" r="1.35" fill="#1a1a1a"/>',
  ),
  ghs(
    'ghs08',
    '健康危害',
    '健康危害 致癌 致敏 呼吸道 health hazard',
    '<circle cx="12" cy="7.7" r="1.75" fill="#1a1a1a"/><path d="M12 10.4c-1.85 0-3.35 1.5-3.35 3.35v4.1h6.7v-4.1c0-1.85-1.5-3.35-3.35-3.35z" fill="#1a1a1a"/><path d="M12 12.2l.72 1.55 1.63.2-1.2 1.12.32 1.62-1.47-.83-1.47.83.32-1.62-1.2-1.12 1.63-.2z" fill="#ffffff"/>',
  ),
  ghs(
    'ghs09',
    '环境危害',
    '环境 危害 水生生物 污染 environment',
    '<path d="M8.6 17.6V9.2M8.6 9.2 6.2 7.3M8.6 9.2l2.3-1.9M8.6 12.1 6.4 10.4M8.6 12.1l2.2-1.7" stroke="#1a1a1a" stroke-width="1.15" stroke-linecap="round"/><path d="M12.9 17.9c1.5-1.35 3.4-1.35 4.9-.2l1.5-1.35v2.6l-1.5-1.35c-1.5 1.15-3.4 1.15-4.9-.2z" fill="#1a1a1a"/>',
  ),

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
  line(
    'weee',
    'WEEE 电子废弃物',
    '电子电器 废弃物 垃圾桶 WEEE 报废 回收',
    'recycle',
    '<path d="M7 6.6h10l-1.2 10.2a1.7 1.7 0 0 1-1.7 1.5H9.9a1.7 1.7 0 0 1-1.7-1.5L7 6.6Z"/><path d="M5.2 6.6h13.6"/><path d="M5.2 20.6h13.6"/>',
  ),
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

  // ══ 认证 / 环保标识 ══
  line(
    'ce',
    'CE 标志',
    'CE 欧盟 认证 出口',
    'cert',
    '<path d="M9.7 8.2a4.6 4.6 0 1 0 0 7.6"/><path d="M13.5 8.2v7.6h5.3M13.5 12h4.3"/>',
  ),
  line(
    'pb-free',
    '无铅 Pb-Free',
    '无铅 铅 有害物质 RoHS Pb free',
    'cert',
    '<circle cx="12" cy="12" r="8"/><path d="M9.4 16.2V7.8h2.3a2.5 2.5 0 0 1 0 5h-2.3"/><path d="M14.6 7.8v8.4"/><path d="M5.6 18.4 18.4 5.6"/>',
  ),
  line(
    'eco-leaf',
    '环保绿叶',
    '环保 绿色 生态 eco 绿叶 绿色产品',
    'cert',
    '<path d="M19.4 4.6c0 8.3-4.3 12.8-11.4 12.8H5.4C5.4 9.5 9.9 4.6 19.4 4.6Z"/><path d="M5.4 19.4c1.8-3.4 4.4-6 7.8-7.8"/>',
  ),
  line(
    'fsc',
    '森林认证 FSC',
    '森林 FSC 木材 纸张 可持续 认证',
    'cert',
    '<path d="M12 3.6 8.6 9.4h2.2L7.4 15h2.4l-1.8 5.4h9.6L14.6 15h2.4l-3.4-5.6h2.2L12 3.6Z"/>',
  ),
  [
    'energy-label',
    '能效等级标识',
    '能效 等级 能耗 energy label 欧盟 家电',
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
