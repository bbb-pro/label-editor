// 用户自带字体：把本机的 .ttf 交给浏览器，画布显示 + 导出 PDF 内嵌都用这一份字节。
//
// 为什么这条路可行（而「直接读 C:\Windows\Fonts」不可行）：
//   浏览器不允许 JS 遍历系统字体目录，但**用户主动选一个文件**是完全允许的 ——
//   拿到的 ArrayBuffer 就是字体的全部字形数据，喂给 FontFace 画布就能显示，
//   喂给 fonteditor-core 子集化就能内嵌进 PDF。两侧同源，所以「画布 = PDF」。
//
// 三条设计取舍：
//   ① **族名加 `LEU ` 前缀**（如 `LEU 方正大黑`）。内置字体是 Arial / SimHei / LE Narrow…
//      不带这个前缀，所以用户上传的字体永远不会盖掉内置款；反过来也便于识别
//      「这个名字到底是内置还是用户传的」—— normalizeFontFamily 靠这一点决定要不要保留。
//   ② **存 IndexedDB 而不是 localStorage**：localStorage 只能放字符串（base64 会膨胀 33%），
//      而 IndexedDB 能直接结构化存储 ArrayBuffer，几十 MB 的字体也不卡主线程。
//   ③ **PDF alias 由族名哈希得到**（`UFxxxx`）：只要族名不变，跨会话、跨设备的 alias 就一致，
//      导出的逻辑不需要「先注册再导出」的时序配合。
/** 用户字体族名统一前缀（内置字体都没有这个前缀） */
export const USER_FAMILY_PREFIX = 'LEU '

/** 单个字体文件上限：再大就该先做子集化再上传了（也避免 IndexedDB 写爆） */
const MAX_FONT_BYTES = 24 * 1024 * 1024

export interface UserFontVariant {
  weight: '400' | '700'
  /** 上传时的文件名，仅用于展示 */
  fileName: string
  /** TTF 原始字节 —— 画布 FontFace 与 PDF 子集化共用 */
  data: ArrayBuffer
}

export interface UserFontRecord {
  /** 族名小写，IndexedDB 主键 */
  id: string
  /** 字体自带的族名（展示用，如「方正大黑简体」） */
  family: string
  /** 画布 fontFamily / PDF 注册用的族名（带 LEU 前缀） */
  canvasFamily: string
  variants: UserFontVariant[]
  /** 是否含中文字形（导入时按 cmap 实测，不是猜的） */
  cjk: boolean
  /** 字形总数（展示用，看得出是不是只有几十个字的图标字体） */
  glyphCount: number
  addedAt: number
}

export interface ImportResult {
  fileName: string
  ok: boolean
  message: string
}

/* ── TTF 表解析（只读需要的几张表，不做完整解析） ─────────────────
 * 为什么不用 fonteditor-core 解析：它会完整展开 glyf / loca，一个 20MB 的中文字体
 * 能吃掉几百 MB 内存并卡住主线程好几秒。这里只读表目录 + name/head/OS2/maxp/cmap，
 * 耗时是毫秒级，也足够判断「是不是 TTF / 叫什么 / 有没有中文 / 是不是粗体」。
 */

const TAG = (s: string): number =>
  ((s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3)) >>> 0

const T_NAME = TAG('name')
const T_HEAD = TAG('head')
const T_OS2 = TAG('OS/2')
const T_MAXP = TAG('maxp')
const T_CMAP = TAG('cmap')
const T_CFF = TAG('CFF ')
const T_CFF2 = TAG('CFF2')
const T_TTCF = TAG('ttcf')
const T_TRUE = TAG('true')
const T_OTTO = TAG('OTTO')

interface TableRec {
  offset: number
  length: number
}

export interface FontMeta {
  family: string
  bold: boolean
  italic: boolean
  cjk: boolean
  glyphCount: number
}

function readTableDir(dv: DataView): Map<number, TableRec> {
  const num = dv.getUint16(4)
  const out = new Map<number, TableRec>()
  for (let i = 0; i < num; i++) {
    const p = 12 + i * 16
    if (p + 16 > dv.byteLength) break
    out.set(dv.getUint32(p), { offset: dv.getUint32(p + 8), length: dv.getUint32(p + 12) })
  }
  return out
}

/** UTF-16BE（Windows/Unicode 平台）或 Latin-1（Mac 旧字体）解码 name 记录 */
function decodeName(bytes: Uint8Array, platform: number): string {
  let s = ''
  if (platform === 3 || platform === 0) {
    for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1])
  } else {
    for (const b of bytes) s += String.fromCharCode(b)
  }
  // 去掉控制字符（有些字体族名尾部带 \0），否则会带进 fontFamily 里
  let clean = ''
  for (const ch of s) if (ch.codePointAt(0)! >= 0x20) clean += ch
  return clean.trim()
}

/** 读 name 表：返回 nameID → 文本（同 ID 多条记录时按平台优先级取最好的一条） */
function readNames(dv: DataView, u8: Uint8Array, rec: TableRec): Map<number, string> {
  const out = new Map<number, string>()
  const score = new Map<number, number>()
  const count = dv.getUint16(rec.offset + 2)
  const strBase = rec.offset + dv.getUint16(rec.offset + 4)
  for (let i = 0; i < count; i++) {
    const p = rec.offset + 6 + i * 12
    if (p + 12 > dv.byteLength) break
    const platform = dv.getUint16(p)
    const lang = dv.getUint16(p + 4)
    const nameId = dv.getUint16(p + 6)
    const len = dv.getUint16(p + 8)
    const off = dv.getUint16(p + 10)
    // 只要族名/子族名/排版族名（nameID 1/2/16/17）
    if (nameId !== 1 && nameId !== 2 && nameId !== 16 && nameId !== 17) continue
    const start = strBase + off
    if (start + len > u8.length) continue
    // 优先 Windows 英文（3/0x409）→ Windows 任意 → Unicode → Mac
    const sc = platform === 3 ? (lang === 0x409 ? 4 : 3) : platform === 0 ? 2 : 1
    const text = decodeName(u8.subarray(start, start + len), platform)
    if (!text) continue
    const prev = score.get(nameId) ?? -1
    if (sc > prev) {
      score.set(nameId, sc)
      out.set(nameId, text)
    }
  }
  return out
}

/** cmap 里挑一张最合适的子表（优先 format 12 全 Unicode，其次 format 4 BMP） */
function pickCmap(dv: DataView, rec: TableRec): { offset: number; format: number } | null {
  const count = dv.getUint16(rec.offset + 2)
  let best: { offset: number; format: number; sc: number } | null = null
  for (let i = 0; i < count; i++) {
    const p = rec.offset + 4 + i * 8
    if (p + 8 > dv.byteLength) break
    const platform = dv.getUint16(p)
    const encoding = dv.getUint16(p + 2)
    const off = rec.offset + dv.getUint32(p + 4)
    if (off + 4 > dv.byteLength) continue
    const format = dv.getUint16(off)
    if (format !== 4 && format !== 12) continue
    // 3/10 = Windows UCS-4、3/1 = Windows BMP、0/x = Unicode
    const sc = format === 12 ? 3 : platform === 3 && encoding === 1 ? 2 : 1
    if (!best || sc > best.sc) best = { offset: off, format, sc }
  }
  return best ? { offset: best.offset, format: best.format } : null
}

/** 该码位在字体里是否有字形（format 4 / 12 两种子表） */
function hasGlyph(dv: DataView, sub: { offset: number; format: number }, cp: number): boolean {
  if (sub.format === 12) {
    if (sub.offset + 16 > dv.byteLength) return false
    const nGroups = dv.getUint32(sub.offset + 12)
    let lo = 0
    let hi = nGroups - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const g = sub.offset + 16 + mid * 12
      if (g + 12 > dv.byteLength) return false
      const start = dv.getUint32(g)
      const end = dv.getUint32(g + 4)
      if (cp < start) hi = mid - 1
      else if (cp > end) lo = mid + 1
      else return true
    }
    return false
  }
  // format 4
  if (cp > 0xffff || sub.offset + 14 > dv.byteLength) return false
  const segX2 = dv.getUint16(sub.offset + 6)
  const seg = segX2 / 2
  const endBase = sub.offset + 14
  const startBase = endBase + segX2 + 2
  const deltaBase = startBase + segX2
  const rangeBase = deltaBase + segX2
  if (rangeBase + segX2 > dv.byteLength) return false
  let lo = 0
  let hi = seg - 1
  let idx = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (dv.getUint16(endBase + mid * 2) >= cp) {
      idx = mid
      hi = mid - 1
    } else lo = mid + 1
  }
  if (idx < 0) return false
  const start = dv.getUint16(startBase + idx * 2)
  if (cp < start) return false
  const rangeOff = dv.getUint16(rangeBase + idx * 2)
  if (rangeOff === 0) return true
  const gidOff = rangeBase + idx * 2 + rangeOff + (cp - start) * 2
  if (gidOff + 1 >= dv.byteLength) return false
  return dv.getUint16(gidOff) !== 0
}

/**
 * 解析字体元信息。
 * 抛出的 Error 文案直接面向用户（「这是 .otf，请改用 .ttf」之类），调用方原样展示。
 */
export function parseFontMeta(buf: ArrayBuffer): FontMeta {
  if (buf.byteLength < 12) throw new Error('文件太小，不是有效的字体文件')
  const dv = new DataView(buf)
  const u8 = new Uint8Array(buf)
  const sfnt = dv.getUint32(0)
  if (sfnt === T_TTCF) throw new Error('这是字体集合（.ttc），请选择单个 .ttf 文件')
  if (sfnt === T_OTTO) throw new Error('这是 .otf（CFF 轮廓），导出 PDF 不支持，请改用 .ttf 版本')
  if (sfnt !== 0x00010000 && sfnt !== T_TRUE) throw new Error('不是 TrueType 字体（.ttf）文件')

  const tables = readTableDir(dv)
  if (tables.has(T_CFF) || tables.has(T_CFF2)) {
    throw new Error('这是 CFF 轮廓字体，导出 PDF 不支持，请改用 TrueType（.ttf）版本')
  }
  const head = tables.get(T_HEAD)
  const nameRec = tables.get(T_NAME)
  if (!head || !nameRec) throw new Error('字体缺少必需的表（head/name），文件可能已损坏')

  // head.macStyle：bit0 = bold，bit1 = italic
  const macStyle = head.offset + 46 <= dv.byteLength ? dv.getUint16(head.offset + 44) : 0
  // OS/2.fsSelection：bit0 = italic，bit5 = bold；usWeightClass ≥ 600 也算粗
  const os2 = tables.get(T_OS2)
  let fsSelection = 0
  let weightClass = 400
  if (os2 && os2.offset + 64 <= dv.byteLength) {
    weightClass = dv.getUint16(os2.offset + 4)
    fsSelection = dv.getUint16(os2.offset + 62)
  }
  const bold = (macStyle & 1) !== 0 || (fsSelection & 32) !== 0 || weightClass >= 600
  const italic = (macStyle & 2) !== 0 || (fsSelection & 1) !== 0

  const names = readNames(dv, u8, nameRec)
  const family = (names.get(16) || names.get(1) || '').replace(/\s+/g, ' ').slice(0, 64)
  if (!family) throw new Error('字体里读不到族名，文件可能已损坏')

  const maxp = tables.get(T_MAXP)
  const glyphCount = maxp && maxp.offset + 6 <= dv.byteLength ? dv.getUint16(maxp.offset + 4) : 0

  const cmapRec = tables.get(T_CMAP)
  const sub = cmapRec ? pickCmap(dv, cmapRec) : null
  // 「含中文」实测：抽常用汉字的码位问 cmap，命中一半以上才算
  let cjk = false
  if (sub) {
    const probes = '的一是了我不人在他有中文标签打印'
    let hit = 0
    for (const ch of probes) if (hasGlyph(dv, sub, ch.codePointAt(0)!)) hit++
    cjk = hit >= probes.length / 2
  }

  return { family, bold, italic, cjk, glyphCount }
}

/* ── IndexedDB 持久化 ───────────────────────────────────────── */

const DB_NAME = 'label-editor-fonts'
const DB_STORE = 'userFonts'

let _dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (_dbPromise) return _dbPromise
  _dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null)
      return
    }
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(DB_NAME, 1)
    } catch {
      resolve(null)
      return
    }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE, { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
    req.onblocked = () => resolve(null)
  })
  return _dbPromise
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => resolve()
    tx.onabort = () => resolve()
  })
}

async function dbAll(): Promise<UserFontRecord[]> {
  const db = await openDb()
  if (!db) return []
  try {
    const tx = db.transaction(DB_STORE, 'readonly')
    const req = tx.objectStore(DB_STORE).getAll()
    const rows = await new Promise<UserFontRecord[]>((resolve) => {
      req.onsuccess = () => resolve((req.result as UserFontRecord[]) ?? [])
      req.onerror = () => resolve([])
    })
    return rows
  } catch {
    return []
  }
}

async function dbPut(rec: UserFontRecord): Promise<void> {
  const db = await openDb()
  if (!db) return
  try {
    const tx = db.transaction(DB_STORE, 'readwrite')
    tx.objectStore(DB_STORE).put(rec)
    await txDone(tx)
  } catch {
    /* 存储失败不影响本次会话内使用（内存里已有） */
  }
}

async function dbDelete(id: string): Promise<void> {
  const db = await openDb()
  if (!db) return
  try {
    const tx = db.transaction(DB_STORE, 'readwrite')
    tx.objectStore(DB_STORE).delete(id)
    await txDone(tx)
  } catch {
    /* 同上 */
  }
}

/* ── 运行时注册表 + 订阅（供 React useSyncExternalStore 使用） ── */

const _fonts = new Map<string, UserFontRecord>()
/** 族名小写 → PDF alias（normal / 可选 bold） */
const _alias = new Map<string, { normal: string; bold?: string }>()
/** 族名小写 → 该字体有没有中文字形（导出时判断要不要退回黑体） */
const _cjkById = new Map<string, boolean>()
/** PDF alias → 字节（导出时按 alias 取，不用再碰 IndexedDB） */
const _bytes = new Map<string, ArrayBuffer>()
/** PDF alias → 展示名（日志 / 降级提示用） */
const _aliasLabel = new Map<string, { label: string; bold: boolean }>()

let _snapshot: UserFontRecord[] = []
const _listeners = new Set<() => void>()

function notify() {
  _snapshot = [..._fonts.values()].sort((a, b) => a.addedAt - b.addedAt)
  for (const cb of _listeners) cb()
}

export function subscribeUserFonts(cb: () => void): () => void {
  _listeners.add(cb)
  return () => {
    _listeners.delete(cb)
  }
}

/** 稳定引用：内容不变时引用不变（useSyncExternalStore 要求） */
export function getUserFontsSnapshot(): UserFontRecord[] {
  return _snapshot
}

/** 字体族名 → alias 的稳定哈希（FNV-1a，base36） */
function aliasHash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36).toUpperCase()
}

/**
 * 重建 alias / 字节索引。
 * 只在字体集合变化（导入 / 删除 / 启动加载）时调用。
 */
function rebuildIndex() {
  _alias.clear()
  _bytes.clear()
  _aliasLabel.clear()
  _cjkById.clear()
  for (const rec of _fonts.values()) {
    const base = `UF${aliasHash(rec.canvasFamily)}`
    const boldVar = rec.variants.find((v) => v.weight === '700')
    const normalVar = rec.variants.find((v) => v.weight === '400')
    // 只有粗体文件时，常规字重也用这份（宁可偏粗，也不要导出失败/空白）
    const normalData = normalVar?.data ?? boldVar?.data
    if (normalData) {
      _bytes.set(base, normalData)
      _aliasLabel.set(base, { label: rec.family, bold: false })
    }
    if (boldVar) {
      const boldAlias = `${base}B`
      _bytes.set(boldAlias, boldVar.data)
      _aliasLabel.set(boldAlias, { label: rec.family, bold: true })
    }
    _alias.set(rec.id, boldVar ? { normal: base, bold: `${base}B` } : { normal: base })
    _cjkById.set(rec.id, !!rec.cjk)
  }
}

/** FontFaceSet 里按「族名（可限定字重）」删掉已注册的 face —— 重复上传时避免同族同字重并存 */
function deleteFaces(family: string, weight?: '400' | '700') {
  if (typeof document === 'undefined' || !document.fonts) return
  const doomed: FontFace[] = []
  document.fonts.forEach((f) => {
    // 有的浏览器把族名带引号存（"LEU xxx"），统一去掉引号再比
    if (f.family.replace(/["']/g, '') !== family) return
    if (weight && f.weight !== weight) return
    doomed.push(f)
  })
  for (const f of doomed) document.fonts.delete(f)
}

/** 把一份字体字节注册进浏览器（画布显示用） */
async function registerFace(rec: UserFontRecord, v: UserFontVariant): Promise<void> {
  if (typeof document === 'undefined' || typeof FontFace === 'undefined') return
  try {
    // 传副本：不同浏览器对「把 ArrayBuffer 交给 FontFace 后是否 detach」实现不一致，
    // 而这份字节后面导出 PDF 还要用，不能被吞掉。
    const face = new FontFace(rec.canvasFamily, v.data.slice(0), { weight: v.weight })
    const loaded = await face.load()
    deleteFaces(rec.canvasFamily, v.weight)
    document.fonts.add(loaded)
  } catch (err) {
    console.warn(`[userFonts] 画布注册失败：${rec.canvasFamily} ${v.weight}`, err)
  }
}

async function registerRecord(rec: UserFontRecord): Promise<void> {
  _fonts.set(rec.id, rec)
  await Promise.all(rec.variants.map((v) => registerFace(rec, v)))
}

let _initPromise: Promise<void> | null = null

/**
 * 启动时加载用户此前上传的字体（幂等）。
 * 与 `ensureEmbeddedFonts()` 并行调用；完成后要补一次 `refreshTextMetrics()`，
 * 否则文本盒宽/断行还是按 fallback 字体算的。
 */
export function initUserFonts(): Promise<void> {
  if (_initPromise) return _initPromise
  _initPromise = (async () => {
    const rows = await dbAll()
    for (const row of rows) {
      if (!row?.id || !Array.isArray(row.variants)) continue
      // 存进去的可能是只读视图，统一成 ArrayBuffer
      const rec: UserFontRecord = {
        ...row,
        variants: row.variants.filter((v) => v?.data instanceof ArrayBuffer),
      }
      if (rec.variants.length === 0) continue
      await registerRecord(rec)
    }
    rebuildIndex()
    notify()
  })()
  return _initPromise
}

/** 该族名是否是「用户上传的字体」（normalizeFontFamily 靠它决定要不要保留） */
export function isUserFontFamily(name: unknown): boolean {
  const key = String(name ?? '').trim().toLowerCase()
  return !!key && _fonts.has(key)
}

/** 用户字体 → PDF alias（vectorExport 用） */
export function userFontPdfMapping(
  family: unknown,
): { normal: string; bold?: string; cjk: boolean } | undefined {
  const key = String(family ?? '').trim().toLowerCase()
  const hit = _alias.get(key)
  return hit ? { ...hit, cjk: _cjkById.get(key) ?? false } : undefined
}

/** PDF alias → 字体字节（vectorExport 子集化用） */
export function userFontBytes(alias: string): ArrayBuffer | undefined {
  return _bytes.get(alias)
}

/** PDF alias → 展示名 + 是否已是粗体字形 */
export function userFontAliasInfo(alias: string): { label: string; bold: boolean } | undefined {
  return _aliasLabel.get(alias)
}

/** 下拉框选项：用户字体排在内置字体之后 */
export function userFontOptions(): { value: string; label: string }[] {
  return _snapshot.map((rec) => ({
    value: rec.canvasFamily,
    label: `${rec.family}${rec.cjk ? '' : '（仅西文）'}`,
  }))
}

/* ── 导入 / 删除 ───────────────────────────────────────────── */

async function importOne(file: File): Promise<ImportResult> {
  const fileName = file.name
  if (!/\.ttf$/i.test(fileName)) {
    return { fileName, ok: false, message: '只支持 .ttf（TrueType）字体文件' }
  }
  if (file.size > MAX_FONT_BYTES) {
    return {
      fileName,
      ok: false,
      message: `文件 ${(file.size / 1024 / 1024).toFixed(1)}MB 超过 ${MAX_FONT_BYTES / 1024 / 1024}MB 上限`,
    }
  }
  let buf: ArrayBuffer
  try {
    buf = await file.arrayBuffer()
  } catch {
    return { fileName, ok: false, message: '读取文件失败' }
  }
  let meta: FontMeta
  try {
    meta = parseFontMeta(buf)
  } catch (err) {
    return { fileName, ok: false, message: (err as Error).message }
  }
  if (meta.italic) {
    return { fileName, ok: false, message: '斜体字体暂不支持（导出 PDF 无法保持斜体），请上传正体文件' }
  }

  const canvasFamily = `${USER_FAMILY_PREFIX}${meta.family}`
  const id = canvasFamily.toLowerCase()
  const weight: '400' | '700' = meta.bold ? '700' : '400'
  const prev = _fonts.get(id)
  const variant: UserFontVariant = { weight, fileName, data: buf }
  const rec: UserFontRecord = {
    id,
    family: meta.family,
    canvasFamily,
    // 同族同字重（重复上传）→ 覆盖；不同字重 → 合并成同一款字体的两个变体
    variants: [...(prev?.variants.filter((v) => v.weight !== weight) ?? []), variant].sort((a, b) =>
      a.weight.localeCompare(b.weight),
    ),
    cjk: meta.cjk || !!prev?.cjk,
    glyphCount: Math.max(meta.glyphCount, prev?.glyphCount ?? 0),
    addedAt: prev?.addedAt ?? Date.now(),
  }
  _fonts.set(id, rec)
  await registerFace(rec, variant)
  rebuildIndex()
  await dbPut(rec)

  const bits = [meta.bold ? '粗体' : '常规']
  if (rec.cjk) bits.push('含中文')
  if (meta.glyphCount > 0 && meta.glyphCount < 200) bits.push(`仅 ${meta.glyphCount} 个字形`)
  const replaced = prev ? '（已更新）' : ''
  return { fileName, ok: true, message: `「${meta.family}」${bits.join(' · ')}${replaced}` }
}

/** 导入一批字体文件（逐个处理，单个失败不影响其它） */
export async function importFontFiles(files: File[] | FileList): Promise<ImportResult[]> {
  const list = Array.from(files)
  const out: ImportResult[] = []
  for (const f of list) out.push(await importOne(f))
  if (out.some((r) => r.ok)) notify()
  return out
}

/** 删除一款用户字体（画布里用到它的文本会退回 fallback，需调用方重排） */
export async function removeUserFont(id: string): Promise<void> {
  const rec = _fonts.get(id)
  if (!rec) return
  _fonts.delete(id)
  rebuildIndex()
  notify()
  deleteFaces(rec.canvasFamily)
  await dbDelete(id)
}
