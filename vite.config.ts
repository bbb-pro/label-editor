import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    // fabric 本体无法再拆，阈值调到 1200kB 避免无意义的告警噪音
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        /**
         * 只手工拆分「彼此独立、体量大」的第三方库，其余全部交给 Rollup 自动分配。
         *
         * ⚠️ 不要在这里细拆 react / @radix-ui / lucide-react 之类的 UI 生态包：
         * 它们之间存在密集的相互依赖（radix 依赖 react，cmdk 又依赖 radix），
         * 手工指定极易产出「Circular chunk」环 —— rollup 会警告，且运行时可能
         * 出现 "Cannot access before initialization"。交给 Rollup 自动分组可保证无环。
         *
         * 首屏关键：下面这些重型库都只被「懒加载的编辑器 chunk」引用，不会被入口引用，
         * 因此不拖慢首屏（首屏 = 入口 + react 共享 chunk + CSS）。
         * 拆分本身不减少总体积，收益在于：
         *   - 发版后未变动的 vendor chunk 命中浏览器缓存（fabric 很少变，业务代码经常变）；
         *   - 多 chunk 并行下载，HTTP/2 下更快。
         */
        manualChunks(id) {
          if (!id.includes("node_modules")) return
          if (id.includes("node_modules/fabric")) return "vendor-fabric"
          if (id.includes("jspdf") || id.includes("svg2pdf") || id.includes("fonteditor-core"))
            return "vendor-pdf"
          if (id.includes("node_modules/xlsx")) return "vendor-xlsx"
          if (id.includes("bwip-js")) return "vendor-barcode"
          return undefined
        },
      },
    },
  },
})
