# Label-editor 代码审计报告

**审计日期**：2026-09-10
**审计范围**：15,476 行源码（`src/lib` 引擎与管线、`src/sections` 应用层、`src/components/editor`）
**审计方式**：三路并行静态审计（画布引擎 / 导出打印管线 / React 应用层）+ 关键项人工核验 + tsc/eslint/build 门禁
**结论**：修复 10 处实质缺陷（3 高危 / 7 中危）+ 若干清理项；tsc 0 错误，eslint error 13 → 10（余下为模板固有告警），构建通过。

---

## 一、高危（已修复）

### 1. 字体子集化失败会中断整份 PDF 导出
`src/lib/vectorExport.ts` — `subsetFont()`

原实现 `await fetch(font)` + `Font.create()` + `font.write()` 全链路无 try/catch。任一环节异常（网络失败、字形缺失、子集化抛错）都会让 `buildVectorPdf` 整体 reject —— **一个 PDF 页都导不出来**，尽管形状/条码/图片本不依赖字体。

**修法**：失败时返回 `null` 并在调用处降级为内置 Helvetica，保证非文本内容仍可导出；同时新增 TTF `ArrayBuffer` 内存缓存（`loadTtf`），避免每次导出重复下载字体。

### 2. `originX/originY` 模块级全局 → 并发导出坐标错乱
`src/lib/vectorExport.ts`

纸张原点存在两个模块级可变变量中，每页绘制前覆写。由于逐页绘制含 `await`（SVG 素材），两路导出（如先点导出再点打印）交错执行时，后一方会改写全局值，导致另一方的叶子被平移到错误原点 → 内容偏移出页。

**修法**：封装为 `setOrigin(x, y)`，并把原点随 `buildVectorPdf` 的页循环内聚，消除跨调用污染。

### 3. 大尺寸标签导出为空白
`src/lib/canvasEngine.ts` — `toPaperDataUrl()`

`out.width = paper.width * scale` 未做上限钳制。浏览器 canvas 单边上限约 16384px，超限时 `toDataURL()` 静默返回空白 —— 用户表现为"导出空白 PDF/PNG"，且无任何报错。

**修法**：加 `MAX_DIM = 16384` 钳制；超限时按比例下调 `effectiveScale` 并输出警告，保证大标签仍能导出（分辨率等比降低）。

---

## 二、中危（已修复）

| # | 问题 | 位置 | 修法 |
|---|------|------|------|
| 4 | **拖动对象无法 Ctrl+Z** — `object:modified` 未压历史栈，最常用操作不可撤销 | `canvasEngine.ts` | 处理器内补 `pushHistory()` |
| 5 | **`destroy()` 未清理挂起资源** — 仅 `canvas.dispose()`，挂起的 rAF 回调会访问已销毁 canvas；`whenIdle` 等待者永不 resolve → 导出流程卡死 | `canvasEngine.ts` | `cancelAnimationFrame(_raf)` + 清空并唤醒所有 `_waiters` |
| 6 | **编组锁定态载入后失效** — `restoreRecursive` 遇 group 只递归子对象、跳过 `restoreObjectFields`，`_locked` 未进交互锁 | `canvasEngine.ts` | 组自身也先调 `restoreObjectFields`（内含 `applyLockState` + `patchSerialize`） |
| 7 | **`refreshAllContent` 退化为 O(n²)** — 逐对象 `displayContent` → 每次全量 `buildContentMap` | `canvasEngine.ts` | 按纸预建一次 contentMap 复用（`displayContent`/`resolveDesign` 增 `prebuilt` 可选参） |
| 8 | **导出期间无锁** — 批量渲染 `await` 多帧，用户此刻编辑会截到半成品 | `canvasEngine.ts` + `export.ts` + `vectorExport.ts` | 新增 `setReadOnly(bool)`（临时关选择/变换，不改 `_locked` 业务态），三处导出流程 try/finally 包裹 |
| 9 | **PNG 文件编号错位** — `i>0 ? i+1 : ''` 导致首张无编号、缺「标签1.png」 | `export.ts` | 恒用 `i + 1` |
| 10 | **大表撑爆 DOM** — 万行 Excel 全量 `rows.map` 渲染 | `DataDock.tsx` | 窗口化：>200 行时仅渲染当前行 ±60 行，上下用占位行撑滚动高度 |

---

## 三、低危 / 清理（已修复）

- **React `set-state-in-effect` × 3**（`PropertyPanel.tsx` 657/894/1019）：`NameField`、`FontSizeField`、补零位数输入。改用父级 `key` 强制重建 + 派生值，去掉 effect 内 setState 引发的级联渲染。eslint error 13 → 10。
- **渲染期写 ref**（`App.tsx`）：`activeRef.current = active` 移入 `useEffect`。
- **`onDirty` 无谓重渲染**：`usedVariables`/`objectNames`/`activeSerial` 加相等守卫，内容不变时复用旧引用。
- **ResizeObserver 抖动**（`App.tsx`）：`fitToView` 加 rAF 节流，拖窗口不再每帧重算。
- **hand 模式误清选中**（`App.tsx`）：手抓平移起手的左键不再清空当前选择。
- **打印定时器未清**（`vectorExport.ts`）：60s 兜底定时器加 `settled` 闸与 `clearTimeout`，`afterprint` 后不残留。
- **死代码删除**：`barcode.ts` 的 `renderBarcodeDataUrl`（位图条码时代残留）+ 其 `bwip-js` import。

---

## 四、已核实为误报（勿重复排查）

| 怀疑点 | 结论 |
|--------|------|
| `emitActive`/`onDirty` 闭包陈旧，读到旧 state | ❌ 不存在。回调定义在 `[]` 依赖的 init effect 内，闭包捕获常驻 `ctrl`，只调用稳定 setter |
| window 监听未解绑导致泄漏 | ❌ 不存在。`mousemove`/`mouseup`/`keydown`/`wheel` 均有 cleanup |
| AssetsPanel 加载 1910 图标存在请求竞态 | ❌ 不存在。加载有 `alive` 守卫，tab/搜索为客户端过滤，分页 80/页 |
| BatchDialog 打开时渲染全部预览导致卡顿 | ❌ 不存在。对话框只渲染份数与首尾序号文本 |
| 条码组序列化丢子对象锁定 | ❌ 不存在。锁定态存于 group，载入后 `replaceBarcodeObject` 重绑 |

---

## 五、遗留观察项（未改，供后续评估）

1. **`App.tsx` 1600+ 行职责过载** — 建议拆 `useCanvasController` / `useViewport` hooks。
2. **主包 2.79 MB（gzip 853 kB）** — 可对 `xlsx` / `svg2pdf` / `jspdf` 做动态 import 分包。
3. **`drawEllipseObject` 忽略旋转**、`drawLineObject` 斜线按盒对角绘制 — 属已知矢量导出限制。
4. **双遍扫描**：矢量导出先扫全部页收集字符、再扫一遍绘制，大批量下时间翻倍。

---

## 门禁结果

```
tsc -b        → 0 errors
eslint .      → 10 errors（均为 react-refresh/only-export-components 模板告警）
vite build    → ✓ built in 48.31s（2,792.60 kB / gzip 853.02 kB）
```
