import type { ReaderPrefs } from '../stores/settings'

export interface ReaderThemeColors {
  bg: string
  fg: string
  link: string
}

export type ReaderThemeName = Exclude<ReaderPrefs['theme'], 'auto'>

export const READER_THEMES: Record<ReaderThemeName, ReaderThemeColors> = {
  light: { bg: '#ffffff', fg: '#1d2129', link: '#1664ff' },
  sepia: { bg: '#faf3e7', fg: '#453c2c', link: '#8f6c2e' },
  green: { bg: '#c7edcc', fg: '#243528', link: '#1e6b4a' },
  dark: { bg: '#17181a', fg: '#c5c8ce', link: '#6a9bff' },
}

/** auto 跟随界面外观: 浅色外观读白底, 深色外观读夜间 */
export function resolveReaderTheme(theme: ReaderPrefs['theme'], appDark: boolean): ReaderThemeName {
  return theme === 'auto' ? (appDark ? 'dark' : 'light') : theme
}

export function resolveReaderColors(theme: ReaderPrefs['theme'], appDark: boolean): ReaderThemeColors {
  return READER_THEMES[resolveReaderTheme(theme, appDark)]
}

/** 主题选择按钮 (含 auto), 顺序固定; auto 的色板用斜切双色示意跟随外观 */
export const READER_THEME_CHOICES: Array<{ name: ReaderPrefs['theme']; bg: string; fg: string }> = [
  ...(Object.entries(READER_THEMES) as Array<[ReaderThemeName, ReaderThemeColors]>)
    .map(([name, c]) => ({ name: name as ReaderPrefs['theme'], bg: c.bg, fg: c.fg })),
  { name: 'auto', bg: 'linear-gradient(135deg, #ffffff 50%, #17181a 50%)', fg: '#8a919c' },
]

export const FONT_FAMILIES = [
  { labelKey: 'reader.fontDefault', value: '' },
  { labelKey: 'reader.fontSongti', value: '"Songti SC", "Noto Serif SC", SimSun, serif' },
  { labelKey: 'reader.fontHeiti', value: '"PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif' },
  { labelKey: 'reader.fontKaiti', value: '"Kaiti SC", KaiTi, "Noto Serif SC", serif' },
]

/** 注入到 foliate 渲染 iframe 的样式 */
export function getReaderCSS(prefs: ReaderPrefs, appDark: boolean): string {
  const theme = resolveReaderTheme(prefs.theme, appDark)
  const colors = READER_THEMES[theme]
  return `
    @namespace epub "http://www.idpf.org/2007/ops";
    html {
      color-scheme: ${theme === 'dark' ? 'dark' : 'light'};
      color: ${colors.fg};
      font-size: ${prefs.fontSize}px;
      ${prefs.fontFamily ? `font-family: ${prefs.fontFamily};` : ''}
    }
    body { background: none !important; }
    p, li, blockquote, dd {
      line-height: ${prefs.lineHeight};
      ${prefs.justify ? 'text-align: justify;' : ''}
      -webkit-hyphens: auto;
      hyphens: auto;
    }
    a:any-link { color: ${colors.link}; }
    /* 脚注弹出场景保持可读 */
    aside[epub|type~="footnote"] { background: ${colors.bg}; }
    ${readingModeCSS(colors)}
  `
}

/** 6 位 / 3 位十六进制色 → rgba, 用于淡显后文 (不依赖 color-mix, 兼容 Highlight API 最早的 Chrome 105) */
function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return hex
  const h = m[1].length === 3 ? m[1].replace(/./g, c => c + c) : m[1]
  const n = parseInt(h, 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

/**
 * 阅读模式 (打字机) 的静态样式: 开关模式只增删 Highlight 对象, 不调用 setStyles, 所以不会重排。
 * ::highlight 只允许改颜色类属性; 不支持它的旧 WebView 忽略这些规则, 改走 overlayer 遮罩。
 */
function readingModeCSS(colors: ReaderThemeColors): string {
  const ghost = withAlpha(colors.fg, 0.18)
  return `
    ::highlight(lr-tw-hidden) { color: transparent; -webkit-text-fill-color: transparent; text-shadow: none; text-decoration-color: transparent; }
    ::highlight(lr-tw-ghost) { color: ${ghost}; -webkit-text-fill-color: ${ghost}; text-shadow: none; text-decoration-color: ${ghost}; }
    ::highlight(lr-tw-fresh) { color: ${colors.link}; -webkit-text-fill-color: ${colors.link}; }
    [data-lr-pending] { visibility: hidden !important; }
  `
}

export const HIGHLIGHT_COLORS: Record<string, string> = {
  yellow: '#ffd54d',
  green: '#7ed99b',
  blue: '#7cb8ff',
  red: '#ff8f8f',
}
