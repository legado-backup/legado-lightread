/**
 * 金句卡片可选字体 (QuoteCardDialog). 桌面: 宋 / 黑 / 楷用系统字体, 得意黑随应用打包;
 * App 版见 src/mobile/services/cardFonts.ts (宋体、楷体也用打包的字体文件).
 * 带 url 的由卡片注册进主文档 (FontFace), family 第一项即注册名.
 */
import smileyUrl from '../assets/fonts/smiley-sans.woff2?url'

export interface CardFontDef { key: string; labelKey: string; family: string; url?: string }

export const CARD_FONTS: CardFontDef[] = [
  { key: 'serif', labelKey: 'reader.fontSongti', family: '"Songti SC", "Noto Serif CJK SC", "Noto Serif SC", "Source Han Serif SC", SimSun, serif' },
  { key: 'sans', labelKey: 'reader.fontHeiti', family: '"PingFang SC", "Noto Sans CJK SC", "Noto Sans SC", "Microsoft YaHei", sans-serif' },
  { key: 'kai', labelKey: 'reader.fontKaiti', family: '"Kaiti SC", "LXGW WenKai", STKaiti, KaiTi, serif' },
  { key: 'smiley', labelKey: 'card.fontSmiley', family: '"LightRead Card Smiley", sans-serif', url: smileyUrl },
]
