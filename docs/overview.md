# 标签编辑器 — 项目交付总览

对标 Bartender 的**纯前端标签打印编辑器**，基于 **React 19 + TS + Vite + Tailwind + shadcn/ui**，底层用 fabric.js 实现所见即所得画布。无后端、无登录、全部数据留在浏览器本地。

## ✅ 已交付能力
| 模块 | 能力 |
|---|---|
| 画布 | 毫米单位(DPI=96)，白纸灰底，拖拽/缩放/旋转，Delete 删除，滚轮缩放 + 双击适应 |
| 元素 | 文本(`{{变量}}`)、Code128 条码、二维码、矩形、直线、本地图片上传 |
| 属性 | 纸张宽高(实时改画布)、选中对象 X/Y/宽/高/旋转、文本/条码内容编辑、`{{字段}}` 一键插入提示 |
| 数据 | 上传 CSV/XLSX → 表格预览，点行实时替换画布变量；上/下行切换；清空还原设计原文 |
| 输出 | 模板 JSON 导入导出、高清 PNG、PDF(按 mm 建页)、浏览器打印(无边距引导) |

## 🗂 关键文件
- `src/App.tsx` — 全局编排（画布生命周期、缩放、工具、数据预览）
- `src/lib/canvasEngine.ts` — fabric 控制器（元素/几何/变量/序列化往返）
- `src/lib/barcode.ts`、`spreadsheet.ts`、`export.ts`、`mm.ts`
- `src/sections/` — TopBar / Toolbox / PropertyPanel / DataDock
- `docs/UI-UX设计建议.md` — 现代 Web 专家的 UI/UX 评审文档
- 需求原型：`label-editor.md`（UI 原型 + 开发文档两份）

## ⚙️ 运行
```bash
npm install      # 依赖（fabric@5.3.0 / bwip-js@4.5.0 / xlsx@0.18.5 / jspdf@2.5.2）
npm run dev      # 开发（HMR）
npm run build    # 产物在 dist/
npm run preview  # 预览生产包（当前运行于 http://localhost:4173/）
```

## 🔭 后续可做
- 撤销/重做、多选对齐、标尺网格吸附、图层/元素树
- 对象复制粘贴(Ctrl+D)、字距字号/字体增强
- 大 bundle(2.2MB) 按需优化、离线 CDN 本地化、二期打印标尺刻度
- 打印偏移提示：工业热敏请选"无边距"
