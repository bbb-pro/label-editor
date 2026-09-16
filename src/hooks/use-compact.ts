import * as React from 'react'

/**
 * 是否“紧凑布局”（手机 + 较窄平板）。
 * 此宽度下右侧属性栏放不下，改为底部弹层抽屉；桌面(≥1024px)保持右侧固定面板。
 */
const COMPACT_BREAKPOINT = 1024

export function useIsCompact(): boolean {
  // ⚠️ 初值必须**同步**取到：若先渲染桌面布局、再在 effect 里切成紧凑布局，
  //    首帧会按「带右侧属性栏的窄画布」算好视图 pan，随后属性栏消失、画布区骤然变宽
  //    ~320px，而视图只在挂载时居中过一次 → 标签停在原处，看起来「偏左」
  //    （实测 innerWidth<1024 时纸心偏 -145px）。同时这也避免窄屏首帧闪一下桌面布局。
  const [compact, setCompact] = React.useState(() => window.innerWidth < COMPACT_BREAKPOINT)

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
