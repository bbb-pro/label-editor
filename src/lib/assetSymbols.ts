/**
 * 包装储运标志（GB/T 191 风格自绘线稿）。
 *
 * 参考国标「包装储运图示标志」的图形语义自绘为 24×24 线稿（stroke 风格，
 * 与 Lucide 一致），可换色、可矢量导出。图形为原创绘制，不构成对标准
 * 插图原样的复制，使用无版权风险。
 *
 * 元组：[id, 中文名, 额外检索词, SVG 内部片段]
 */
export const SYMBOLS: [string, string, string, string][] = [
  [
    'fragile',
    '易碎物品',
    '小心轻放 fragile handle care 玻璃杯',
    '<path d="M8 3h8l-.7 6.3a3.35 3.35 0 0 1-6.6 0L8 3z"/><path d="M14 4.5l-1.8 2 1.8 2"/><path d="M12 12.5V18"/><path d="M8.5 21h7"/>',
  ],
  [
    'this-side-up',
    '向上',
    '摆放方向 up arrow 此面向上',
    '<path d="M7 20v-9"/><path d="M4 14l3-3 3 3"/><path d="M17 20v-9"/><path d="M14 14l3-3 3 3"/>',
  ],
  [
    'keep-dry',
    '怕雨防潮',
    '防潮 keep dry umbrella 雨伞 湿',
    '<path d="M3 11a9 9 0 0 1 18 0"/><path d="M3 11h18"/><path d="M12 11v7a2 2 0 0 0 4 0"/><path d="M12 2v1.5"/>',
  ],
  [
    'keep-away-from-sun',
    '怕晒',
    '防晒 sun temperature 阳光 太阳',
    '<circle cx="12" cy="12" r="4"/><path d="M12 3v2"/><path d="M12 19v2"/><path d="M3 12h2"/><path d="M19 12h2"/><path d="M5.6 5.6L7 7"/><path d="M17 17l1.4 1.4"/><path d="M18.4 5.6L17 7"/><path d="M7 17l-1.4 1.4"/>',
  ],
  [
    'stack-limit',
    '堆码层数极限',
    '堆码 stack layers 层数 重量',
    '<path d="M12 6V2"/><path d="M10 4l2-2 2 2"/><rect x="5" y="8" width="14" height="5.5"/><rect x="5" y="16" width="14" height="5.5"/>',
  ],
  [
    'do-not-stack',
    '禁止堆码',
    '不能堆叠 no stack 重物',
    '<rect x="5" y="12.5" width="14" height="7.5"/><rect x="8" y="5.5" width="8" height="5"/><path d="M4.5 4l15 16"/>',
  ],
  [
    'do-not-roll',
    '禁止翻滚',
    '翻滚 roll 倾倒',
    '<circle cx="12" cy="12" r="9"/><rect x="7.5" y="7.5" width="9" height="9" rx="1"/><path d="M5.5 5.5l13 13"/>',
  ],
  [
    'no-hooks',
    '禁用手钩',
    '挂钩 hook 钩子',
    '<circle cx="12" cy="12" r="9"/><path d="M12 6.5v4a2.5 2.5 0 0 1-5 0"/><path d="M5.5 5.5l13 13"/>',
  ],
  [
    'lift-here',
    '由此吊起',
    '吊装 lift crane 起吊 吊钩',
    '<path d="M12 3v4"/><path d="M12 7a3 3 0 0 1 0 6"/><rect x="8" y="16.5" width="8" height="4.5"/><path d="M12 13v3.5"/>',
  ],
  [
    'center-of-gravity',
    '重心',
    'gravity balance 配重',
    '<rect x="4" y="6" width="16" height="13" rx="1"/><circle cx="12" cy="12.5" r="1.5"/><path d="M12 8.5V10"/><path d="M12 15v1.5"/><path d="M8 12.5h1.5"/><path d="M14.5 12.5H16"/>',
  ],
  [
    'open-here',
    '由此开启',
    '开箱 open 剪刀 拆封',
    '<rect x="4" y="5" width="16" height="14" rx="1"/><path d="M9 5v14" stroke-dasharray="2.5 2.5"/><path d="M14 9v6"/><path d="M12.5 13.5L14 15l1.5-1.5"/>',
  ],
  [
    'temperature-limit',
    '温度极限',
    '怕热 heat thermometer 温度 冷藏',
    '<path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0z"/><path d="M12 9v5"/>',
  ],
]
