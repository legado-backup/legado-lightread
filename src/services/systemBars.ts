// 安卓系统栏适配, 依赖 MainActivity 注入的 window.LightReadInsets (其他平台无此对象, 全部空操作)。
//
// 1. 安全区: edge-to-edge 下网页铺到状态栏 / 导航栏之下, 靠 env(safe-area-inset-*) 让位。
//    旧版 Android System WebView (如 Android 12 + Chromium 135) 不上报这些值, env() 恒为 0,
//    页面会顶到状态栏、底栏被手势条遮挡。这里取原生上报尺寸与 env() 的较大者写入 --lr-safe-*。
// 2. 系统栏图标深浅: 默认跟随手机系统, 应用选了与系统不同的外观 (或阅读页用夜间正文) 时
//    图标会与背景同色看不清, 按页面实际深浅通知原生端切换。

type Side = 'top' | 'right' | 'bottom' | 'left'
const SIDES: Side[] = ['top', 'right', 'bottom', 'left']

interface AndroidBridge {
  get(): string
  setBarsDark(dark: boolean): void
}

function bridge(): AndroidBridge | undefined {
  return (window as unknown as { LightReadInsets?: AndroidBridge }).LightReadInsets
}

export function installAndroidSafeArea() {
  const b = bridge()
  if (!b) return

  const apply = () => {
    let insets: Partial<Record<Side, number>>
    try {
      insets = JSON.parse(b.get())
    } catch {
      return
    }
    const style = document.documentElement.style
    for (const side of SIDES) {
      const px = Math.max(0, Number(insets[side]) || 0)
      style.setProperty(`--lr-safe-${side}`, `max(env(safe-area-inset-${side}), ${px}px)`)
    }
  }

  // 旋转屏幕、切换手势 / 三键导航时原生端会再次调用
  ;(window as unknown as { __lightreadApplyInsets?: () => void }).__lightreadApplyInsets = apply
  apply()
}

let appDark = false
/** 页面级覆盖 (阅读页正文主题), null 表示跟随应用外观 */
let pageDark: boolean | null = null

function syncBars() {
  bridge()?.setBarsDark(pageDark ?? appDark)
}

/** 应用外观 (浅色 / 深色) 变化时调用 */
export function setAppBarsDark(dark: boolean) {
  appDark = dark
  syncBars()
}

/** 沉浸式页面按自身背景指定系统栏深浅; 离开页面时传 null 恢复跟随应用外观 */
export function setPageBarsDark(dark: boolean | null) {
  pageDark = dark
  syncBars()
}
