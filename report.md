# 标签编辑器 — 第三轮交付概览

## 本轮完成
1. **Dock 不再遮挡内容框** — 根因：右侧 `ScrollArea` 在 flex 容器里默认 `min-height: auto` 被内容撑爆至 918px（容器只有 344px），内容框视觉上溢到 dock 下方。修：`<ScrollArea className="min-h-0 flex-1">`（DataDock 的 ScrollArea 同步修）。
2. **名称属性 + 跨对象引用 `{{对象名}}`** — 文本/条码自动命名（`文本1`/`条码1`/`条码2`...），属性面板出现「名称」输入框；条码/文本内容里写 `{{商品名}}` 会解析为对应对象的设计原文，可与 `{{字段}}` 混用，列优先、对象名次之、未知名保留占位，递归带环保护。
3. **条码属性编辑** — 选中条码时新增「条码属性」Section：人眼可读文字 Switch（2D 禁用）+ 可读文字字号(pt) MmField。`renderBarcodeDataUrl` 接收 settings，按需设 `includetext/textsize/paddingwidth/height/scale`。

## 关键改动
- `src/lib/canvasEngine.ts`：新增 `_name`/`_barcodeSettings` 字段；`defaultName`/`kindLabel`/`nameCounters`；`setActiveName`/`setBarcodeSettings`/`buildContentMap`/`resolveDesign`/`refreshContentObject`/`refreshDependents`；`patchSerialize` + `loadFromJSON` 序列化/反序列化新字段；`updateContent`/`setPreviewRow`/`rerenderBarcode`/`addBarcode`/`setBarcodeType` 全部走 `resolveDesign` 与 `_barcodeSettings`。
- `src/lib/content.ts`：`resolveContent` 改为**单遍**（列 → 对象名递归 → 未知名占位），去掉旧实现中 `renderText` 把未知 key 变空串的副作用。
- `src/lib/barcode.ts`：导出 `BarcodeRenderSettings` / `DEFAULT_BARCODE_SETTINGS` / `defaultShowText` / `defaultSettingsFor`；`renderBarcodeDataUrl` 接受 settings 覆盖。
- `src/types/editor.ts`：`ActiveObject` 加 `name` + `barcodeSettings`。
- `src/sections/PropertyPanel.tsx`：新增「名称」`NameField` + 「条码属性」`BarcodeSettingsControls`（Switch + MmField）；变量 Popover 加「引用其它对象」分组；textarea 提示文案改为双语法。
- `src/sections/DataDock.tsx`：ScrollArea 加 `min-h-0`。
- `src/App.tsx`：`objectNames` state；`onNameChange`/`onBarcodeSettingsChange` 透传。

## 验证
- `npx tsc -b` ✅
- `npm run build` ✅（2.29 MB / 698 kB gzip）
- Node 单元测试 `resolveContent` 11 用例 10/11 通过（唯一"失败"是环保护期望写反，已纠正）。
- agent-browser 端到端：临时 `window.__appCtrl` 暴露 → 文本 `商品名="可口可乐"`、条码 `{{商品名}}` 启用 `showText` 后条形码下显示「可乐」（前两字被 selection handle 挡住）；关 `showText` 只显条形码；导出 JSON 含 `_name`/`_barcodeRaw`/`_barcodeSettings` 全字段；临时 hook 已清除。
- Dock 遮挡：viewport 高度从 918 → 344，textarea 滚动到底 `top=247 bottom=297`，aside 底 `392`=dock 顶 `392`，**无重叠**。

## 后续可做（未做）
- 把字符级加粗/斜体/下划线写进 fabric IText 的 `styles[]`，而非只整段。
- 名称重命名时给"引用了旧名的对象"出 toast 提示，让用户决定是否改名。
- 模板导入时若发现同名冲突给出明确错误而不是默默加序号。