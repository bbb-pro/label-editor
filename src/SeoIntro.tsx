/**
 * 首屏静态介绍 / 加载占位。
 *
 * 两个用途，共用同一套 DOM 与样式（样式定义在 index.html 的 <style> 里，选择器为 #seo-intro）：
 * 1. 编辑器主 chunk（含 fabric，约 2.8MB）懒加载期间的 Suspense fallback；
 * 2. 与 index.html 中 #root 内的静态块内容一致，保证「静态 HTML → React fallback」视觉无缝、无跳变。
 *
 * 同时这段文案也是 SEO 的正文来源：纯客户端 canvas 应用本身没有任何可被抓取的文本，
 * 搜索引擎能读到的就是这个组件与 index.html 静态块里的内容。
 */
export default function SeoIntro() {
  return (
    <div id="seo-intro">
      <h1>标签编辑器 · 在线条码标签设计与打印</h1>
      <p>
        免费在线标签编辑器，无需安装、无需注册。拖拽即可完成条码标签排版，支持 Code128、QR
        Code、EAN-13、DataMatrix、PDF417 等 42 种条码与二维码，可自定义任意毫米尺寸纸张，支持导入
        Excel 批量套打，导出矢量 PDF 与 384 DPI 高清 PNG。
      </p>
      <ul>
        <li>42 种条码与二维码：一维码、二维码、GS1-128、2/5 家族全覆盖</li>
        <li>任意纸张尺寸：快递面单、仓储货架标签、产品铭牌、资产标签</li>
        <li>Excel / CSV 批量套打：文本框名称与表头一致即自动绑定整列数据</li>
        <li>矢量 PDF 导出：文字与条码均为矢量，放大多大都不糊</li>
        <li>高清 PNG 导出：384 DPI 矢量重绘，印刷级清晰度</li>
        <li>多纸与页序控制：一份模板管理多张标签，支持按套或按标签排序输出</li>
        <li>完全本地运行：数据不上传服务器，可离线使用</li>
      </ul>
      <p className="seo-links">
        <a href="/guide/">使用指南</a> ·{' '}
        <a href="/guide/barcode-types.html">42 种码制怎么选</a> ·{' '}
        <a href="/guide/label-sizes.html">标签尺寸速查</a> ·{' '}
        <a href="/guide/batch-print.html">Excel 批量套打</a>
      </p>
      <p className="seo-loading">正在加载编辑器… 若长时间停留在此页面，请刷新重试</p>
    </div>
  )
}
