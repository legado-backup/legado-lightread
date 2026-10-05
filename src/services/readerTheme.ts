import type { ReaderPrefs } from '../stores/settings'
import { dianjingCSS, djThemeName } from './dianjing/theme.ts'

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

/** 墨水屏 (docs/research/reading-modes-landscape.md §6.3): 纯黑白 21:1, 链接为黑色加下划线; 夜间配合为反色 */
export const EINK_THEMES: { light: ReaderThemeColors; dark: ReaderThemeColors } = {
  light: { bg: '#ffffff', fg: '#000000', link: '#000000' },
  dark: { bg: '#000000', fg: '#ffffff', link: '#ffffff' },
}

/** 阅读模式对正文样式的附加影响 (useReadingModes().readerStyle), 由阅读器传给 getReaderCSS / resolveReaderColors */
export interface ReaderModeStyle {
  /** 墨水屏: 纯黑白配色、字重 +100、无动画 */
  eink?: boolean
  /** 大字: 段距 0.6em、正文字重 500 */
  largeText?: boolean
}

/** auto 跟随界面外观: 浅色外观读白底, 深色外观读夜间 */
export function resolveReaderTheme(theme: ReaderPrefs['theme'], appDark: boolean): ReaderThemeName {
  return theme === 'auto' ? (appDark ? 'dark' : 'light') : theme
}

export function resolveReaderColors(theme: ReaderPrefs['theme'], appDark: boolean, style?: ReaderModeStyle): ReaderThemeColors {
  const name = resolveReaderTheme(theme, appDark)
  if (style?.eink) return EINK_THEMES[name === 'dark' ? 'dark' : 'light']
  return READER_THEMES[name]
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
export function getReaderCSS(prefs: ReaderPrefs, appDark: boolean, style?: ReaderModeStyle): string {
  const theme = resolveReaderTheme(prefs.theme, appDark)
  const colors = resolveReaderColors(prefs.theme, appDark, style)
  return `
    @namespace epub "http://www.idpf.org/2007/ops";
    html {
      color-scheme: ${theme === 'dark' ? 'dark' : 'light'};
      color: ${colors.fg};
      font-size: ${prefs.fontSize}px;
      ${prefs.fontFamily ? `font-family: ${prefs.fontFamily};` : ''}
      ${prefs.letterSpacing > 0 ? `letter-spacing: ${Math.min(0.5, prefs.letterSpacing)}em;` : ''}
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
    ${modeStyleCSS(style)}
    ${dianjingCSS(djThemeName(theme, !!style?.eink))}
  `
}

/** 墨水屏 / 大字附加的正文样式 (只在开关切换时随 setStyles 重排一次) */
function modeStyleCSS(style?: ReaderModeStyle): string {
  let css = ''
  if (style?.largeText) {
    css += `
    body { font-weight: 500; }
    p + p { margin-block-start: 0.6em; }
    `
  }
  if (style?.eink) {
    // 字重 +100 (约等于 Boox 的「加深」); 链接黑色加下划线; 图片灰度; 去掉一切过渡与动画
    css += `
    body { font-weight: ${style.largeText ? 600 : 500}; }
    b, strong, th, h1, h2, h3, h4, h5, h6 { font-weight: 800; }
    a:any-link { text-decoration: underline; }
    img, svg, video { filter: grayscale(1) contrast(1.1); }
    *, *::before, *::after { transition: none !important; animation: none !important; scroll-behavior: auto !important; }
    `
  }
  return css
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
    ${lyricAndGuideCSS(colors)}
    [data-lr-pending] { visibility: hidden !important; }
  `
}

export const HIGHLIGHT_COLORS: Record<string, string> = {
  yellow: '#ffd54d',
  green: '#7ed99b',
  blue: '#7cb8ff',
  red: '#ff8f8f',
}

/** 两个十六进制色按比例混合 (t 为 b 的占比), 不依赖 color-mix */
function mixHex(a: string, b: string, t: number): string {
  const parse = (hex: string) => {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
    if (!m) return null
    const h = m[1].length === 3 ? m[1].replace(/./g, c => c + c) : m[1]
    const n = parseInt(h, 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  const x = parse(a)
  const y = parse(b)
  if (!x || !y) return a
  const c = x.map((v, i) => Math.round(v + (y[i] - v) * t))
  return `#${c.map(v => v.toString(16).padStart(2, '0')).join('')}`
}

/**
 * 歌词 (其余行淡显 30% / 隐藏) 与仿生阅读 (中文交替着色: 正文色与强调色 7:3 / 5.5:4.5 混合; 西文词尾 70%) 的静态样式。
 * 只改颜色, 开关模式只增删 Highlight 对象。
 */
function lyricAndGuideCSS(colors: ReaderThemeColors): string {
  const dim = withAlpha(colors.fg, 0.3)
  const altLight = mixHex(colors.fg, colors.link, 0.3)
  const altNormal = mixHex(colors.fg, colors.link, 0.45)
  const tail = withAlpha(colors.fg, 0.7)
  return `
    ::highlight(lr-ly-dim) { color: ${dim}; -webkit-text-fill-color: ${dim}; text-shadow: none; text-decoration-color: ${dim}; }
    ::highlight(lr-ly-hide) { color: transparent; -webkit-text-fill-color: transparent; text-shadow: none; text-decoration-color: transparent; }
    ::highlight(lr-wg-alt-l) { color: ${altLight}; -webkit-text-fill-color: ${altLight}; }
    ::highlight(lr-wg-alt-n) { color: ${altNormal}; -webkit-text-fill-color: ${altNormal}; }
    ::highlight(lr-wg-tail) { color: ${tail}; -webkit-text-fill-color: ${tail}; }
  `
}
