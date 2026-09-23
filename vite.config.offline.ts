/**
 * 离线单文件构建专用配置 —— 与线上的 `vite.config.ts` **完全隔离**。
 *
 * 为什么单独一份配置（而不是给主配置加开关）：
 * 线上构建（CI / GitHub Pages）必须保持原样、后续改动不受影响；
 * 离线包是一次性产物，需求（单文件、无代码分割）与线上（多 chunk + 缓存友好）相反。
 * 两者共用同一份源码，只是构建参数不同 —— 所以源码层面零改动。
 *
 * 与主配置的两处关键差异：
 *  1. `inlineDynamicImports: true` —— 关掉代码分割。
 *     线上靠多 chunk 并行下载 + 缓存复用；单文件则必须把所有懒加载的
 *     动态 import（编辑器主包 / vectorExport / spreadsheet）合并成一个文件。
 *     ⚠️ 更要紧的是：`file://` 协议下动态 import 会被 CORS 拦截，不合并跑不起来。
 *  2. 去掉 manualChunks —— 它与 inlineDynamicImports 互斥。
 *
 * 用法：vite build --config vite.config.offline.ts
 */
import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    outDir: "offline-dist",
    emptyOutDir: true,
    // 单文件不关心分包体积告警
    chunkSizeWarningLimit: 100000,
    // 不把资源转成 base64 塞进 JS —— 后面有专门的步骤处理
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        entryFileNames: "app.js",
        assetFileNames: "app.[ext]",
      },
    },
  },
})
