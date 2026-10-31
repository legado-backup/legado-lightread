/** 金句卡片可选字体 (App): 宋体、楷体用 App 打包的思源宋体 / 霞鹜文楷, 黑体用系统字体, 得意黑随应用打包 */
import songtiUrl from '../assets/fonts/noto-serif-sc.woff2?url'
import kaitiUrl from '../assets/fonts/lxgw-wenkai.woff2?url'
import smileyUrl from '../../assets/fonts/smiley-sans.woff2?url'

export interface CardFontDef { key: string; labelKey: string; family: string; url?: string }

export const CARD_FONTS: CardFontDef[] = [
  { key: 'serif', labelKey: 'reader.fontSongti', family: '"LightRead Card Serif", "Noto Serif CJK SC", serif', url: songtiUrl },
  { key: 'sans', labelKey: 'reader.fontHeiti', family: '"Noto Sans CJK SC", "Noto Sans SC", "PingFang SC", sans-serif' },
  { key: 'kai', labelKey: 'reader.fontKaiti', family: '"LightRead Card Kai", serif', url: kaitiUrl },
  { key: 'smiley', labelKey: 'card.fontSmiley', family: '"LightRead Card Smiley", sans-serif', url: smileyUrl },
]
