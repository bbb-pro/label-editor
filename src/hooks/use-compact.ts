import * as React from 'react'

/**
 * 是否“紧凑布局”（手机 + 较窄平板）。
 * 此宽度下右侧属性栏放不下，改为底部弹层抽屉；桌面(≥1024px)保持右侧固定面板。
 */
const COMPACT_BREAKPOINT = 1024

export function useIsCompact(): boolean {
  const [compact, setCompact] = React.useState<boolean | undefined>(undefined)

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${COMPACT_BREAKPOINT - 1}px)`)
    const onChange = () => {
      setCompact(window.innerWidth < COMPACT_BREAKPOINT)
    }
    mql.addEventListener('change', onChange)
    setCompact(window.innerWidth < COMPACT_BREAKPOINT)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  return !!compact
}
