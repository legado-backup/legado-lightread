/** 匿名使用统计的纯函数 (无依赖, 可单测); 上报逻辑见 usageStats.ts */

export type StatsPlatform = 'windows' | 'macos' | 'linux' | 'android' | 'ios' | 'web' | 'other'

export interface PingBody {
  id: string
  platform: StatsPlatform
  version: string
  lang: 'zh' | 'en'
  reader: boolean
}

/** 北京时间的日期 (统计按北京时间切天, 与服务端一致) */
export function beijingDay(now = Date.now()): string {
  return new Date(now + 8 * 3600_000).toISOString().slice(0, 10)
}

/** 由 UA 与运行环境判断平台; 网页版统一记为 web */
export function detectPlatform(ua: string, tauri: boolean): StatsPlatform {
  if (/Android/i.test(ua)) return tauri ? 'android' : 'web'
  if (/iPhone|iPad|iPod/i.test(ua)) return tauri ? 'ios' : 'web'
  if (!tauri) return 'web'
  if (/Windows/i.test(ua)) return 'windows'
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macos'
  if (/Linux|X11/i.test(ua)) return 'linux'
  return 'other'
}

/**
 * 今天还需不需要发: 记录形如 "2026-10-05:app" / "2026-10-05:reader"。
 * 打开应用发一次; 当天第一次打开书再发一次 (服务端把 reader 按「或」合并)。
 */
export function needsPing(sent: string | null, day: string, reader: boolean): boolean {
  if (!sent || !sent.startsWith(day + ':')) return true
  return reader && !sent.endsWith(':reader')
}

/**
 * 自动化测试 (Playwright / WebDriver 会置 navigator.webdriver) 与本机开发预览 (localhost / 127.0.0.1)
 * 不上报, 免得开发期间每跑一次测试就多出一个「网页版新安装」; 桌面 / 安卓 App 的 tauri.localhost 不受影响
 */
export function isTestEnvironment(nav: { webdriver?: boolean } | undefined, hostname: string, tauri: boolean): boolean {
  if (nav?.webdriver) return true
  if (tauri) return false
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1' || hostname === '0.0.0.0'
}
