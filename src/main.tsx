import {
  Component,
  StrictMode,
  Suspense,
  lazy,
  useEffect,
  type ReactNode,
} from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import SeoIntro from './SeoIntro'

/**
 * 编辑器主 chunk 按需加载。
 *
 * 编辑器及其依赖（fabric / jspdf / xlsx / bwip-js，未压缩约 2.8MB）全部走动态 import，
 * 首屏只下载 React + CSS。配合 index.html 中 #root 内的静态介绍块：
 *   - LCP 从「等 2.8MB 下载并解析完」变为「HTML 到达即可见」，首屏显著变快；
 *   - 加载期间显示 SeoIntro，与静态块的 DOM/样式完全一致，视觉无缝无跳变。
 */
const Editor = lazy(() => import('./App.tsx'))

/**
 * 懒加载失败兜底。
 *
 * 真实场景：发新版后 chunk 文件名带新 hash，而用户浏览器可能仍缓存旧 HTML，
 * 于是去请求已被替换掉的旧 chunk → 404 → lazy import reject。
 * 没有兜底的话用户会永远卡在加载页（对单页应用等于完全不可用）。
 * 这里自动刷新一次即可拿到新 HTML；若刷新后仍失败，则停在提示页由用户手动重试。
 */
const RELOAD_KEY = 'label-editor:chunk-reload'
class ChunkBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch() {
    // 只自动刷新一次：标记还在说明上次刷新后依然失败，此时停下来让用户手动处理
    if (!sessionStorage.getItem(RELOAD_KEY)) {
      sessionStorage.setItem(RELOAD_KEY, '1')
      window.location.reload()
    }
  }

  render() {
    return this.state.failed ? <SeoIntro /> : this.props.children
  }
}

/**
 * 编辑器加载成功后清掉「已刷新过」标记。
 * 放在 Suspense 内部是关键 —— 只有 chunk 真正加载完成它才会挂载，
 * 从而保证「失败 → 刷新 → 仍失败」时标记不会被提前清掉导致无限刷新。
 */
function ClearReloadFlag() {
  useEffect(() => {
    sessionStorage.removeItem(RELOAD_KEY)
  }, [])
  return null
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ChunkBoundary>
      <Suspense fallback={<SeoIntro />}>
        <ClearReloadFlag />
        <Editor />
      </Suspense>
    </ChunkBoundary>
  </StrictMode>,
)
