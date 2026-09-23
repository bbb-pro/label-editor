// 解析 y56y.com 模板总览页 → 模板清单 JSON
//
// ⚠️ 站点把模板分成三个分组页，**三个页面各自独立**：
//   group/0 通用标签模板（18 个分类 248 个）
//   group/1 跨境电商模板（3 个分类 39 个：欧洲GPSR / 文字标识 / 亚马逊FBA）
//   group/2 GS1系统标识（1 个分类 7 个）
//   早期只解析了 /labeltemplate（== group/0），漏掉了 46 个 —— 必须三个都读。
// ⚠️ 分类标题里的「共 N 个」不可信（合计 276 / 113，都远超实际卡片数），
//   一律以实际卡片为准。
//
// 用法：node scripts/y56y/parse-manifest.mjs <group0.html> <group1.html> <group2.html> <out.json>
import { readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const outPath = args.pop()
const inPaths = args
const GROUP_NAMES = { 0: '通用标签模板', 1: '跨境电商模板', 2: 'GS1系统标识' }

const types = []
const seenType = new Set()
const items = []
const seenId = new Set()

inPaths.forEach((p, idx) => {
  const html = readFileSync(p, 'utf8')
  const gid = idx

  const typeRe = /typeid="(\d+)"[^>]*>\s*<b>([^<]*)<\/b>\s*<span>\(共(\d+)个\)<\/span>/g
  let m
  while ((m = typeRe.exec(html))) {
    const id = Number(m[1])
    if (seenType.has(id)) continue
    seenType.add(id)
    types.push({ id, name: m[2].trim(), group: gid, groupName: GROUP_NAMES[gid] ?? '其他' })
  }

  const cardRe = /<div class="itembox" orderno="(\d+)">([\s\S]*?)<div class="buttonbox">([\s\S]*?)<\/div>\s*<\/div>/g
  while ((m = cardRe.exec(html))) {
    const body = m[2]
    const idm = /编号:\s*([A-Za-z0-9]{4,8})/.exec(body)
    const titlem = /<div class="title"><b>([\s\S]*?)<\/b>\s*(?:&nbsp;)*<span>([^<]*)<\/span>/.exec(body)
    const applym = /applylabeltemplate\.html\?typeid=(\d+)&amp;id=([A-Za-z0-9]+)/.exec(m[3] + body)
    if (!idm || !titlem || seenId.has(idm[1])) continue
    seenId.add(idm[1])
    items.push({
      id: idm[1],
      typeid: applym ? Number(applym[1]) : null,
      group: gid,
      name: titlem[1].replace(/<[^>]+>/g, '').trim(),
      size: titlem[2].trim().replace('*', '×'),
      order: Number(m[1]),
    })
  }
})

const out = { source: 'https://y56y.com/labeltemplate', crawledAt: new Date().toISOString(), types, items }

const missing = items.filter((i) => i.typeid == null).length
console.log(`分组 ${inPaths.length} 个，分类 ${types.length} 个，模板 ${items.length} 条；缺 typeid ${missing} 条`)
for (const g of Object.keys(GROUP_NAMES)) {
  const n = items.filter((i) => i.group === Number(g)).length
  const cs = types.filter((t) => t.group === Number(g)).map((t) => t.name).join('/')
  console.log(`  group ${g}（${GROUP_NAMES[g]}）：${n} 个模板 · ${cs}`)
}
writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8')
console.log(`已写入 ${outPath}`)
