/**
 * 金句卡片: 把一句书摘画成可分享的图片 (Canvas 2D, 宽 1080px, 默认 3:4 即小红书 1080×1440).
 *
 * 调研 (2026-10-31): 微信读书书摘卡片 (K30 实测: 日历 / 经典 / 墨白 / 静影 / 手札 / 锦书, 可换字体底色),
 * 以及小红书常见的文字卡片类型和开源卡片生成器的风格分类 (杂志编辑、大字报、备忘录、弥散渐变、
 * 暗夜、奶油手账等). 这里的版式全部自行绘制:
 *
 *  - paper      纸卡: 渐变底上浮一张圆角纸卡, 大引号, 底部书封与书名
 *  - glass      毛玻璃: 书封模糊铺满, 半透明面板, 清晰书封压在面板上沿
 *  - notebook   手账: 横线本 + 红色页边线 + 和纸胶带, 文字落在横线上
 *  - marker     划线: 马克笔高亮每一行 (用这条划线自己的颜色)
 *  - calendar   日历: 撕页日历, 色带写月份星期, 大号日期
 *  - vertical   竖排: 金句直排自右向左, 句读挪到字格右上、括号转向; 书名在右, 中文日期与朱印在左下
 *                (英文或放不下时退回竖排书名 + 横排金句)
 *  - page       书页: 书眉、首行缩进两端对齐, 划线色衬在字下, 像从书里裁下的一页
 *  - swiss      克莱因: 瑞士国际主义, 单一锚定色、发丝线网格、超大日期与粗无衬线
 *  - minimal    留白: 极简海报, 大字与一行出处
 *  - memo       备忘录: 拟物备忘录界面
 *  - magazine   杂志: 刊头、粗细双线、红色大引号、页脚两栏
 *  - poster     大字报: 撞色底 + 超大粗字
 *  - aurora     弥散: 多团柔和光斑的渐变底
 *  - night      星夜: 深蓝夜空、星点与弯月
 *  - manuscript 稿纸: 绿格方格稿纸, 一字一格
 *
 * 2026-10-31 第二轮 (参考 guizang-social-card-skill 的「克制优于喊话、结构优于装饰」、md2card 主题分类):
 * 金句按句读分行并均衡行宽 (layoutLines), 不再出现「何 / 事秋风」式断行与单字孤行; 出处、日期等辅助
 * 信息不小于 24px (手机上缩到 1/3 仍可读).
 *
 * 文字按版面自动选字号 (在上限与下限之间取能放下的最大值), 放不下时卡片向下加长.
 * 断行、配色、字号等纯函数单独导出, 由 scripts/test-quote-card.mjs 覆盖; 绘制部分只在浏览器运行.
 */

export type CardTemplate =
  | 'paper' | 'glass' | 'notebook' | 'marker' | 'calendar' | 'vertical' | 'minimal'
  | 'memo' | 'magazine' | 'poster' | 'aurora' | 'night' | 'manuscript' | 'page' | 'swiss'
/** 版式顺序 (2026-10-31 用户指定前六个: 弥散、毛玻璃、大字报、稿纸、手账、纸卡); 对话框默认取第一个 */
export const CARD_TEMPLATES: CardTemplate[] = [
  'aurora', 'glass', 'poster', 'manuscript', 'notebook', 'paper',
  'vertical', 'page', 'minimal', 'swiss', 'magazine', 'marker', 'night', 'calendar', 'memo',
]

export type CardSize = 'sm' | 'md' | 'lg'
export type CardRatio = '3:4' | '1:1' | '9:16'
export const CARD_RATIOS: CardRatio[] = ['3:4', '1:1', '9:16']

/** 底色: 纯色写一个色值, 渐变写「起,止」两个色值 (左上到右下) */
export const CARD_BACKGROUNDS = [
  '#f6f1e7', // 宣纸
  '#ffffff', // 素白
  '#fde8e4,#e8eefc', // 蜜桃雾蓝
  '#fff4d6,#fde2e4', // 奶油粉
  '#dff3ea,#e3e9fb', // 薄荷
  '#e9eef4', // 雾蓝
  '#ffd84d', // 柠檬黄
  '#ff7a45', // 活力橙
  '#2a2b2e', // 墨
  '#1f2b45', // 黛蓝
  '#0f1630,#2a2f5c', // 夜空
  '#3d4a3f', // 苍绿
  '#002fa7', // 克莱因蓝
] as const

export const TEMPLATE_DEFAULT_BG: Record<CardTemplate, string> = {
  paper: '#fde8e4,#e8eefc',
  glass: '#e9eef4',
  notebook: '#f6f1e7',
  marker: '#ffffff',
  calendar: '#fff4d6,#fde2e4',
  vertical: '#f6f1e7',
  minimal: '#f6f1e7',
  memo: '#ffffff',
  magazine: '#f6f1e7',
  poster: '#ffd84d',
  aurora: '#ffffff',
  night: '#0f1630,#2a2f5c',
  manuscript: '#f6f1e7',
  page: '#f6f1e7',
  swiss: '#002fa7',
}

/** 切换版式时顺带换上的字体 (CARD_FONTS 的 key); 之后用户可以再改 */
export const TEMPLATE_DEFAULT_FONT: Record<CardTemplate, string> = {
  paper: 'serif', glass: 'serif', notebook: 'kai', marker: 'sans', calendar: 'serif', vertical: 'serif', minimal: 'serif',
  memo: 'sans', magazine: 'serif', poster: 'smiley', aurora: 'sans', night: 'serif', manuscript: 'kai',
  page: 'serif', swiss: 'sans',
}

export interface QuoteCardData {
  text: string
  note?: string
  title: string
  author?: string
  chapter?: string
  /** 摘录时间 (ms) */
  date: number
  /** 书封; 没有时各版式自行退化 */
  cover?: CanvasImageSource & { width: number; height: number }
  /** 划线颜色 (色值), 「划线」版式用作马克笔颜色 */
  highlight?: string
  lang?: 'zh' | 'en'
}

export interface QuoteCardStyle {
  template: CardTemplate
  background: string
  /** CSS font-family, 用于金句与标题 */
  font: string
  size: CardSize
  ratio: CardRatio
  showBook: boolean
  showChapter: boolean
  showNote: boolean
  showDate: boolean
  showBrand: boolean
}

export const CARD_WIDTH = 1080
/** 超过这个长度的摘录截断并以省略号结尾, 避免生成过长的图片 */
export const CARD_MAX_CHARS = 1200

export function cardHeight(ratio: CardRatio): number {
  return ratio === '1:1' ? 1080 : ratio === '9:16' ? 1920 : 1440
}

/** 「起,止」→ 色值数组; 非法值退回宣纸色 */
export function parseBackground(bg: string): string[] {
  const colors = bg.split(',').map(c => c.trim()).filter(c => /^#[0-9a-f]{6}$/i.test(c))
  return colors.length ? colors.slice(0, 2) : ['#f6f1e7']
}

// ---------------------------------------------------------------- 纯函数

/** 不能出现在行首的标点 (避头) */
const NO_LINE_START = new Set('，。、；：？！）」』》〉】〕”’…—·,.;:?!)]}%‰℃～~-'.split(''))
/** 不能出现在行尾的标点 (避尾) */
const NO_LINE_END = new Set('（「『《〈【〔“‘([{'.split(''))

/** 切成排版单元: 中日文逐字, 拉丁字母 / 数字连成词, 空白单独成段 */
export function tokenize(text: string): string[] {
  const out: string[] = []
  const re = /[A-Za-z0-9À-ɏ'’_\-./:@#&+]+|\s+|[\s\S]/gu
  for (const m of text.matchAll(re)) out.push(m[0])
  return out
}

/**
 * 按宽度断行. measure 返回字符串宽度. 规则:
 *  - 行首标点悬挂在上一行末尾 (允许溢出一个标点), 不另起一行
 *  - 避尾标点 (左括号、左引号) 带着下一字一起换行
 *  - 单词比整行还宽时逐字切开
 *  - 行首空白丢弃; 原文的换行保留为段落
 */
export function wrapText(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const lines: string[] = []
  for (const para of text.replace(/\r\n?/g, '\n').split('\n')) {
    let line = ''
    const push = () => { lines.push(line.replace(/\s+$/, '')); line = '' }
    for (const tok of tokenize(para.trim())) {
      const space = /^\s+$/.test(tok)
      if (!line && space) continue
      if (measure(line + tok) <= maxWidth) { line += tok; continue }
      // 溢出: 行首禁则标点悬挂在本行末尾
      if (line && tok.length === 1 && NO_LINE_START.has(tok)) { line += tok; continue }
      if (space) { push(); continue }
      // 行尾是避尾标点 (左括号 / 左引号) 时带到下一行
      let carry = ''
      const last = line.at(-1) ?? ''
      if (line.length > 1 && NO_LINE_END.has(last)) { carry = last; line = line.slice(0, -1) }
      if (line) push()
      line = carry
      if (measure(line + tok) <= maxWidth) { line += tok; continue }
      // 单词比整行还宽: 逐字切开
      for (const ch of tok) {
        if (line && measure(line + ch) > maxWidth && !NO_LINE_START.has(ch)) push()
        line += ch
      }
    }
    push()
  }
  while (lines.length > 1 && !lines.at(-1)) lines.pop()
  return lines
}

/** 按句读切成短句: 标点 (含其后的右引号 / 右括号) 留在短句末尾 */
export function splitClauses(para: string): string[] {
  return para.match(/[^，。；！？、：,;!?]+[，。；！？、：,;!?]*[”’」』）》"')\]]*|[，。；！？、：,;!?]+[”’」』）》"')\]]*/g) ?? (para ? [para] : [])
}

/** 超过这个字数不做句读分行与均衡, 直接贪心断行 (长文差别不大, 省测量) */
const BALANCE_MAX_CHARS = 240

/**
 * 卡片正文断行 (金句用). 在 wrapText 的禁则之上:
 *  1. 句读分行: 只在逗号句号等处换行, 一行能放下几句就放几句 (诗词、短句最好看);
 *     行数比贪心多一行以内才采用, 某一句比整行还宽就放弃
 *  2. 否则均衡: 保持贪心的行数, 把行宽收到刚好不增加行数, 各行长短接近, 不剩单字孤行
 */
/** 不超过这个字数的段落 (诗句、格言) 宁可缩小字号也要按句读分行 */
const SHORT_PARA = 64

export function layoutLines(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  return layoutLinesInfo(text, maxWidth, measure).lines
}

/** 同 layoutLines; rough = 有该按句读分行的短段落却没能做到 (某句比整行宽), 字号应再小一些 */
export function layoutLinesInfo(text: string, maxWidth: number, measure: (s: string) => number): { lines: string[]; rough: boolean } {
  const out: string[] = []
  let rough = false
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const para = raw.trim()
    const greedy = wrapText(para, maxWidth, measure)
    if (greedy.length <= 1 || [...para].length > BALANCE_MAX_CHARS) { out.push(...greedy); continue }
    const clauses = splitClauses(para)
    if (clauses.length > 1) {
      const lines: string[] = []
      let cur = '', ok = true
      for (const cl of clauses) {
        if (!cur || measure(cur + cl) <= maxWidth) { cur += cl; if (measure(cur.replace(/[，。；！？、：,;!?”’」』）》"')\]]+$/, '')) > maxWidth) { ok = false; break } continue }
        lines.push(cur.trim()); cur = cl.trimStart()
        if (measure(cur.replace(/[，。；！？、：,;!?”’」』）》"')\]]+$/, '')) > maxWidth) { ok = false; break }
      }
      if (cur) lines.push(cur.trim())
      if (ok && lines.length <= greedy.length + 1) { out.push(...lines); continue }
      // 只对诗句式短句 (每句不长) 要求缩字号, 否则长句会把字号一路压到下限
      if (!ok && [...para].length <= SHORT_PARA && Math.max(...clauses.map(c => [...c].length)) <= 16) rough = true
    }
    let lo = maxWidth * 0.5, hi = maxWidth
    for (let i = 0; i < 9; i++) {
      const mid = (lo + hi) / 2
      if (wrapText(para, mid, measure).length <= greedy.length) hi = mid
      else lo = mid
    }
    out.push(...wrapText(para, hi, measure))
  }
  while (out.length > 1 && !out.at(-1)) out.pop()
  return { lines: out, rough }
}

/**
 * 卡片上的书名 / 作者: 去掉书名末尾的括注 (丛书名、版次、营销语, 卡片上只占地方, 竖排时尤其难看),
 * 作者只取分号前第一段 (后面多是译者). 去掉后为空则保留原样. 不改书籍元数据.
 */
export function cardBookTitle(title: string): string {
  const t = title.trim()
  const short = t.replace(/(\s*[（(【[〔][^（()）【】[\]〔〕]*[)）】\]〕]\s*)+$/, '').trim()
  return short || t
}

export function cardAuthor(author?: string): string | undefined {
  const a = author?.split(/[;；]/)[0].trim()
  return a || undefined
}

/** 截断过长的摘录 */
export function clampQuote(text: string, max = CARD_MAX_CHARS): { text: string; clipped: boolean } {
  const clean = text.replace(/\r\n?/g, '\n').replace(/[ \t　]+/g, ' ').replace(/\n{2,}/g, '\n').trim()
  const chars = [...clean]
  if (chars.length <= max) return { text: clean, clipped: false }
  return { text: chars.slice(0, max).join('').replace(/[，。、；：,.;:\s]+$/, '') + '……', clipped: true }
}

/** 金句字号: 越短越大 */
export function quoteFontSize(text: string, size: CardSize = 'md'): number {
  const n = [...text].length
  const base = n <= 24 ? 64 : n <= 60 ? 56 : n <= 120 ? 50 : n <= 240 ? 44 : n <= 480 ? 40 : 36
  const k = size === 'sm' ? 0.86 : size === 'lg' ? 1.14 : 1
  return Math.round(base * k)
}

function hexToRgb(hex: string): [number, number, number] {
  const m = hex.replace('#', '')
  const full = m.length === 3 ? m.split('').map(c => c + c).join('') : m.padEnd(6, '0')
  return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16) || 0) as [number, number, number]
}

/** 相对亮度 (WCAG) */
export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map(v => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function mixColor(a: string, b: string, t: number): string {
  const ca = hexToRgb(a), cb = hexToRgb(b)
  return '#' + ca.map((v, i) => Math.round(v + (cb[i] - v) * t).toString(16).padStart(2, '0')).join('')
}

export interface CardPalette {
  bg: string
  /** 正文 */
  ink: string
  /** 次要文字 */
  muted: string
  /** 分隔线 */
  rule: string
  /** 强调 (日历数字、引号) */
  accent: string
  dark: boolean
}

/** 由底色推出文字色: 深底用暖白字, 浅底用墨色字. 渐变按两端的中间色判断 */
export function cardPalette(background: string): CardPalette {
  const colors = parseBackground(background)
  const bg = colors.length > 1 ? mixColor(colors[0], colors[1], 0.5) : colors[0]
  const dark = luminance(bg) < 0.22
  const ink = dark ? '#f2ece0' : '#24221f'
  return {
    bg,
    ink,
    // 中等亮度的底 (橙、黄) 上次要文字要更深一些才读得清
    muted: mixColor(ink, bg, dark || luminance(bg) > 0.6 ? 0.42 : 0.26),
    rule: mixColor(ink, bg, 0.82),
    accent: dark ? '#d9b97a' : '#8a5a2b',
    dark,
  }
}

const CN_DIGITS = '〇一二三四五六七八九'
function cnNumber(n: number): string {
  if (n < 10) return CN_DIGITS[n]
  if (n < 20) return '十' + (n % 10 ? CN_DIGITS[n % 10] : '')
  return CN_DIGITS[Math.floor(n / 10)] + '十' + (n % 10 ? CN_DIGITS[n % 10] : '')
}

/** 竖排日期: 二〇二六年十月三十一日 */
export function chineseDate(ms: number): string {
  const d = new Date(ms)
  const year = String(d.getFullYear()).split('').map(c => CN_DIGITS[+c]).join('')
  return `${year}年${cnNumber(d.getMonth() + 1)}月${cnNumber(d.getDate())}日`
}

const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER']
const WEEK_ZH = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
const WEEK_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export function dateParts(ms: number, lang: 'zh' | 'en' = 'zh') {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    day: String(d.getDate()),
    monthYear: `${MONTHS[d.getMonth()]} ${d.getFullYear()}`,
    weekday: (lang === 'en' ? WEEK_EN : WEEK_ZH)[d.getDay()],
    dotted: `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`,
  }
}

/** 竖排书名分列: 每列最多 perCol 字, 优先在标点 / 空格处分 */
export function verticalColumns(title: string, perCol: number, maxCols = 3): string[] {
  const chars = [...title.replace(/[《》]/g, '').trim()]
  const cols: string[] = []
  let cur: string[] = []
  for (const c of chars) {
    if (/[\s:：·・,，—\-]/.test(c)) {
      if (cur.length) { cols.push(cur.join('')); cur = [] }
      continue
    }
    cur.push(c)
    if (cur.length >= perCol) { cols.push(cur.join('')); cur = [] }
  }
  if (cur.length) cols.push(cur.join(''))
  if (cols.length > maxCols) {
    const kept = cols.slice(0, maxCols)
    kept[maxCols - 1] = [...kept[maxCols - 1]].slice(0, perCol - 1).join('') + '…'
    return kept
  }
  return cols
}

// ---------------------------------------------------------------- 绘制

const SANS = '"PingFang SC", "HarmonyOS Sans SC", "MiSans", "Noto Sans CJK SC", "Noto Sans SC", "Microsoft YaHei", sans-serif'
const LATIN_SERIF = 'Georgia, "Times New Roman", serif'

const LABELS = {
  zh: { excerpt: '摘录于', brand: '轻阅 LightRead', thought: '想法', notes: 'READING NOTES', memo: '备忘录', tag: '今日书摘', from: '摘自', date: '日期' },
  en: { excerpt: 'Excerpted', brand: 'LightRead', thought: 'Note', notes: 'READING NOTES', memo: 'Notes', tag: 'Quote of the day', from: 'From', date: 'Date' },
}

type Ctx = CanvasRenderingContext2D
type Img = NonNullable<QuoteCardData['cover']>

interface Block {
  h: number
  /** 短句没能按句读分行 (见 layoutLinesInfo), 字号适配时当作放不下 */
  rough?: boolean
  draw: (ctx: Ctx, y: number) => void
}

interface TextOpts {
  size: number
  family: string
  weight?: number
  color: string
  x: number
  width: number
  lineHeight?: number
  align?: 'left' | 'center' | 'right'
  /** 字距 (px) */
  tracking?: number
  /** 马克笔: 每行文字下半部垫一条色带 */
  marker?: string
  /** 每行底部画横线 (手账) */
  ruled?: string
  /** greedy: 普通贪心断行 (说明文字); 默认 balanced: 句读分行 / 均衡行宽 (layoutLines) */
  flow?: 'greedy' | 'balanced'
}

function setFont(ctx: Ctx, size: number, family: string, weight = 400) {
  ctx.font = `${weight} ${size}px ${family}`
}

function measureTracked(ctx: Ctx, s: string, tracking: number) {
  return ctx.measureText(s).width + tracking * Math.max(0, [...s].length - 1)
}

function fillTracked(ctx: Ctx, s: string, x: number, y: number, tracking: number, align: 'left' | 'center' | 'right') {
  if (!tracking) { ctx.textAlign = align; ctx.fillText(s, x, y); return }
  const w = measureTracked(ctx, s, tracking)
  let cx = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x
  ctx.textAlign = 'left'
  for (const ch of s) { ctx.fillText(ch, cx, y); cx += ctx.measureText(ch).width + tracking }
}

/** 多行文字块 */
function text(ctx: Ctx, str: string, o: TextOpts): Block {
  setFont(ctx, o.size, o.family, o.weight)
  const tracking = o.tracking ?? 0
  const m = (x: string) => measureTracked(ctx, x, tracking)
  const info = o.flow === 'greedy' ? { lines: wrapText(str, o.width, m), rough: false } : layoutLinesInfo(str, o.width, m)
  const lines = info.lines
  const lh = Math.round(o.size * (o.lineHeight ?? 1.7))
  return {
    h: lines.length * lh,
    rough: info.rough,
    draw: (c, y) => {
      setFont(c, o.size, o.family, o.weight)
      c.textBaseline = 'middle'
      const align = o.align ?? 'left'
      const x = align === 'center' ? o.x + o.width / 2 : align === 'right' ? o.x + o.width : o.x
      lines.forEach((line, i) => {
        const cy = y + lh * i + lh / 2
        if (o.marker && line) {
          const w = measureTracked(c, line, tracking)
          const lx = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x
          c.save()
          c.fillStyle = o.marker
          roundRect(c, lx - 6, cy - o.size * 0.02, w + 12, o.size * 0.56, o.size * 0.12)
          c.fill()
          c.restore()
        }
        if (o.ruled) {
          c.fillStyle = o.ruled
          c.fillRect(o.x - 20, y + lh * (i + 1) - 2, o.width + 40, 2)
        }
        c.fillStyle = o.color
        fillTracked(c, line, x, cy, tracking, align)
      })
      c.textAlign = 'left'
    },
  }
}

const gap = (h: number): Block => ({ h, draw: () => {} })
const none: Block = gap(0)

function rule(x: number, w: number, color: string, thickness = 2): Block {
  return { h: thickness, draw: (c, y) => { c.fillStyle = color; c.fillRect(x, y, w, thickness) } }
}

function stack(blocks: Block[]): Block {
  const list = blocks.filter(b => b.h > 0 || b !== none)
  return {
    h: list.reduce((s, b) => s + b.h, 0),
    rough: list.some(b => b.rough),
    draw: (c, y) => { for (const b of list) { b.draw(c, y); y += b.h } },
  }
}

function roundRect(c: Ctx, x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, w / 2, h / 2)
  c.beginPath()
  c.moveTo(x + r, y)
  c.arcTo(x + w, y, x + w, y + h, r)
  c.arcTo(x + w, y + h, x, y + h, r)
  c.arcTo(x, y + h, x, y, r)
  c.arcTo(x, y, x + w, y, r)
  c.closePath()
}

function fillBackground(c: Ctx, bg: string, W: number, H: number) {
  const colors = parseBackground(bg)
  if (colors.length > 1) {
    const g = c.createLinearGradient(0, 0, W, H)
    g.addColorStop(0, colors[0])
    g.addColorStop(1, colors[1])
    c.fillStyle = g
  } else c.fillStyle = colors[0]
  c.fillRect(0, 0, W, H)
}

/** 带阴影的圆角面 */
function panel(c: Ctx, x: number, y: number, w: number, h: number, r: number, fill: string, shadow = 'rgba(40, 30, 20, 0.12)', blur = 48) {
  c.save()
  c.shadowColor = shadow
  c.shadowBlur = blur
  c.shadowOffsetY = blur / 3
  roundRect(c, x, y, w, h, r)
  c.fillStyle = fill
  c.fill()
  c.restore()
}

function drawImageCover(c: Ctx, img: Img, x: number, y: number, w: number, h: number) {
  const s = Math.max(w / img.width, h / img.height)
  const dw = img.width * s, dh = img.height * s
  c.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh)
}

function bookCover(c: Ctx, img: Img, x: number, y: number, w: number, h: number, radius = 6) {
  panel(c, x, y, w, h, radius, '#ddd', 'rgba(0,0,0,0.25)', 22)
  c.save()
  roundRect(c, x, y, w, h, radius)
  c.clip()
  drawImageCover(c, img, x, y, w, h)
  c.restore()
}

/** 确定性的伪随机, 同一张卡每次生成一致 */
function seeded(seed: number) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
}

function paperGrain(c: Ctx, w: number, h: number, alpha = 0.035) {
  const rand = seeded(7)
  c.save()
  c.globalAlpha = alpha
  c.fillStyle = '#5a4a32'
  for (let i = 0; i < (w * h) / 900; i++) c.fillRect(rand() * w, rand() * h, 1.6, 1.6)
  c.restore()
}

function quoteMark(size: number, color: string, alpha = 1, x = 0, family = LATIN_SERIF): Block {
  return {
    h: Math.round(size * 0.55),
    draw: (c, y) => {
      setFont(c, size, family, 700)
      c.save()
      c.globalAlpha = alpha
      c.fillStyle = color
      c.textBaseline = 'top'
      c.textAlign = 'left'
      c.fillText('“', x - size * 0.06, y - size * 0.12)
      c.restore()
    },
  }
}

/** 想法: 左侧细竖线 + 小号文字 */
function noteBlock(ctx: Ctx, note: string, p: CardPalette, x: number, width: number, family: string, lang: 'zh' | 'en', size = 30): Block {
  const head = text(ctx, LABELS[lang].thought, { size: 27, family: SANS, color: p.muted, x: x + 26, width: width - 26, lineHeight: 1.5, tracking: 2 })
  const body = text(ctx, note, { size, family, color: p.ink, x: x + 26, width: width - 26, lineHeight: 1.7 })
  const inner = stack([head, gap(4), body])
  return {
    h: inner.h,
    draw: (c, y) => {
      c.save()
      c.fillStyle = p.accent
      c.globalAlpha = 0.65
      roundRect(c, x, y + 6, 5, inner.h - 12, 3)
      c.fill()
      c.restore()
      inner.draw(c, y)
    },
  }
}

/** 左右两端各一段文字 (页脚: 日期 / 标识) */
function splitLine(left: string, right: string, x: number, width: number, color: string, size = 24, family = SANS, weight = 400, rightWeight = 600): Block {
  if (!left && !right) return none
  return {
    h: Math.round(size * 1.6),
    draw: (c, y) => {
      c.textBaseline = 'middle'
      c.fillStyle = color
      const cy = y + size * 0.8
      if (left) { setFont(c, size, family, weight); c.textAlign = 'left'; c.fillText(left, x, cy) }
      if (right) { setFont(c, size, family, rightWeight); c.textAlign = 'right'; c.fillText(right, x + width, cy) }
      c.textAlign = 'left'
    },
  }
}

/** 书封 + 书名 + 作者 一行 */
function bookRow(ctx: Ctx, d: QuoteCardData, s: QuoteCardStyle, x: number, width: number, ink: string, muted: string, coverW = 84, titleSize = 32): Block {
  if (!s.showBook) return none
  const cw = d.cover ? coverW : 0
  const ch = Math.round(cw * 1.42)
  const tx = x + (cw ? cw + 28 : 0)
  const tw = width - (cw ? cw + 28 : 0)
  const title = text(ctx, d.lang === 'en' ? d.title : `《${d.title}》`, { size: titleSize, family: s.font, weight: 600, color: ink, x: tx - (d.lang === 'en' ? 0 : titleSize * 0.45), width: tw, lineHeight: 1.4 })
  const author = d.author ? text(ctx, d.author, { size: Math.max(25, Math.round(titleSize * 0.8)), family: SANS, color: muted, x: tx, width: tw, lineHeight: 1.5 }) : none
  const t = stack([title, gap(6), author])
  const h = Math.max(ch, t.h)
  return {
    h,
    draw: (c, y) => {
      if (d.cover && cw) bookCover(c, d.cover, x, y + (h - ch) / 2, cw, ch, 6)
      t.draw(c, y + (h - t.h) / 2)
    },
  }
}

function sourceText(d: QuoteCardData, s: QuoteCardStyle, withChapter = false): string {
  const parts: string[] = []
  if (s.showBook) {
    const book = d.lang === 'en' ? d.title : `《${d.title}》`
    parts.push(d.author ? `${book}${d.lang === 'en' ? ', ' : ' '}${d.author}` : book)
  }
  if (withChapter && s.showChapter && d.chapter) parts.push(d.chapter)
  return parts.join(' · ')
}

const dateText = (d: QuoteCardData) => dateParts(d.date, d.lang ?? 'zh').dotted

/** 字号上限: 用户选的大中小 */
const SIZE_MAX: Record<CardSize, number> = { sm: 72, md: 86, lg: 100 }

/** 字号上限随字数放宽: 短句 (诗句、格言) 放大到撑满版面, 长段维持原上限 */
function capFor(size: CardSize, quote: string, delta = 0): number {
  const n = [...quote].length
  const k = n <= 16 ? 1.5 : n <= 32 ? 1.32 : n <= 60 ? 1.14 : 1
  return Math.min(150, Math.round((SIZE_MAX[size] + delta) * k / 2) * 2)
}

/** 在 [min, max] 里找最大的字号, 让 top + 中段 + bottom 放进 areaH */
function fitMiddle(top: Block, bottom: Block, mid: (fs: number) => Block, areaH: number, max: number, min = 32) {
  const fits = (fs: number) => { const m = mid(fs); return { m, ok: top.h + m.h + bottom.h <= areaH && !m.rough } }
  const best = fits(max)
  if (!best.ok) {
    // 二分: 字号越小越能放下 (偶数步长, 与旧逐步递减结果一致)
    let lo = Math.ceil(min / 2), hi = Math.floor(max / 2) - 1
    let found: { m: Block; fs: number } | null = null
    while (lo <= hi) {
      const k = (lo + hi) >> 1
      const r = fits(k * 2)
      if (r.ok) { found = { m: r.m, fs: k * 2 }; lo = k + 1 } else hi = k - 1
    }
    const fs = found?.fs ?? min
    const m = found?.m ?? mid(min)
    return { mid: m, fs, need: top.h + m.h + bottom.h }
  }
  return { mid: best.m, fs: max, need: top.h + best.m.h + bottom.h }
}

/** 顶部靠上, 底部靠下, 中段在剩余空间里居中 */
function paintColumn(c: Ctx, y0: number, areaH: number, top: Block, mid: Block, bottom: Block, midBias = 0.46) {
  top.draw(c, y0)
  const free = areaH - top.h - bottom.h - mid.h
  mid.draw(c, y0 + top.h + Math.max(0, free * midBias))
  bottom.draw(c, y0 + areaH - bottom.h)
}

interface Layout { height: number; paint: (c: Ctx) => void }
type Template = (ctx: Ctx, d: QuoteCardData, s: QuoteCardStyle, quote: string, W: number, H: number) => Layout

/** 通用: 正文段 = 金句 (+章节) (+想法) */
function quoteBody(ctx: Ctx, d: QuoteCardData, s: QuoteCardStyle, quote: string, x: number, width: number, ink: string, muted: string, p: CardPalette, fs: number, o: Partial<TextOpts> & { lead?: Block; chapterPrefix?: string } = {}): Block {
  const lang = d.lang ?? 'zh'
  const parts: Block[] = []
  if (o.lead) parts.push(o.lead)
  parts.push(text(ctx, quote, { size: fs, family: s.font, weight: 500, color: ink, x, width, lineHeight: 1.72, ...o }))
  if (s.showChapter && d.chapter && o.chapterPrefix !== undefined) parts.push(gap(Math.round(fs * 0.5)), text(ctx, `${o.chapterPrefix}${d.chapter}`, { size: 26, family: SANS, color: muted, x, width, lineHeight: 1.6, align: o.align }))
  if (s.showNote && d.note?.trim()) parts.push(gap(Math.round(fs * 0.8)), noteBlock(ctx, d.note.trim(), { ...p, ink, muted }, x, width, s.font, lang, Math.max(26, Math.round(fs * 0.5))))
  return stack(parts)
}

// ---- 纸卡
const paperTpl: Template = (ctx, d, s, quote, W, H) => {
  const lang = d.lang ?? 'zh'
  const bgP = cardPalette(s.background)
  const cardFill = bgP.dark ? '#24262b' : '#fffdf8'
  const p = cardPalette(cardFill)
  const M = 72, P = 72
  const ix = M + P, iw = W - 2 * (M + P)
  const top = stack([
    splitLine(LABELS[lang].notes, s.showDate ? dateText(d) : '', ix, iw, p.accent, 26, SANS, 600, 400),
    gap(40),
  ])
  const bottom = stack([gap(36), rule(ix, iw, p.rule), gap(32), s.showBook || s.showBrand
    ? (() => {
        const row = bookRow(ctx, d, s, ix, s.showBrand ? iw - 220 : iw, p.ink, p.muted, 72, 28)
        const h = Math.max(row.h, 40)
        return { h, draw: (c: Ctx, y: number) => {
          row.draw(c, y + (h - row.h) / 2)
          if (s.showBrand) { setFont(c, 26, SANS, 600); c.fillStyle = p.muted; c.textAlign = 'right'; c.textBaseline = 'middle'; c.fillText(LABELS[lang].brand, ix + iw, y + h / 2); c.textAlign = 'left' }
        } }
      })()
    : none])
  const areaH = H - 2 * (M + P)
  const { mid, need } = fitMiddle(top, bottom, fs => quoteBody(ctx, d, s, quote, ix, iw, p.ink, p.muted, p, fs, { lead: stack([quoteMark(150, p.accent, 0.85, ix), gap(18)]), chapterPrefix: '— ' }), areaH, capFor(s.size, quote))
  const height = Math.max(H, need + 2 * (M + P))
  return {
    height,
    paint: c => {
      fillBackground(c, s.background, W, height)
      // 柔和光斑
      c.save()
      c.globalAlpha = bgP.dark ? 0.08 : 0.45
      c.fillStyle = '#ffffff'
      c.beginPath(); c.arc(W - 120, 140, 260, 0, Math.PI * 2); c.fill()
      c.beginPath(); c.arc(80, height - 120, 200, 0, Math.PI * 2); c.fill()
      c.restore()
      panel(c, M, M, W - 2 * M, height - 2 * M, 40, cardFill, bgP.dark ? 'rgba(0,0,0,0.4)' : 'rgba(80, 60, 50, 0.14)', 60)
      if (!p.dark) { c.save(); roundRect(c, M, M, W - 2 * M, height - 2 * M, 40); c.clip(); paperGrain(c, W, height, 0.03); c.restore() }
      paintColumn(c, M + P, height - 2 * (M + P), top, mid, bottom)
    },
  }
}

// ---- 毛玻璃
const glassTpl: Template = (ctx, d, s, quote, W, H) => {
  const lang = d.lang ?? 'zh'
  const bgP = cardPalette(s.background)
  const glassDark = bgP.dark
  const pf = glassDark ? 'rgba(24, 26, 32, 0.62)' : 'rgba(255, 255, 255, 0.74)'
  const p = cardPalette(glassDark ? '#1d2027' : '#fbfbfd')
  const M = 80, P = 64
  const coverW = d.cover && s.showBook ? 220 : 0
  const coverH = Math.round(coverW * 1.42)
  const ix = M + P, iw = W - 2 * (M + P)
  const head = s.showBook ? stack([
    gap(coverW ? coverH / 2 + 36 : 0),
    text(ctx, d.title, { size: 40, family: s.font, weight: 600, color: p.ink, x: ix, width: iw, lineHeight: 1.4, align: 'center' }),
    d.author ? stack([gap(6), text(ctx, d.author, { size: 26, family: SANS, color: p.muted, x: ix, width: iw, lineHeight: 1.5, align: 'center' })]) : none,
    gap(44), rule(W / 2 - 40, 80, p.rule, 2), gap(44),
  ]) : gap(0)
  const foot = stack([gap(48), splitLine(s.showDate ? `${LABELS[lang].excerpt} ${dateText(d)}` : '', s.showBrand ? LABELS[lang].brand : '', ix, iw, p.muted, 26)])
  const outerTop = coverW ? 140 : 120
  const areaH = H - outerTop - 120 - 2 * P
  const { mid, need } = fitMiddle(head, foot, fs => quoteBody(ctx, d, s, quote, ix, iw, p.ink, p.muted, p, fs, { chapterPrefix: '— ' }), areaH, capFor(s.size, quote, -6))
  const panelH = need + 2 * P
  const height = Math.max(H, panelH + outerTop + 120)
  const panelY = Math.max(outerTop, (height - panelH) / 2 + (coverW ? coverH / 4 : 0))
  return {
    height,
    paint: c => {
      fillBackground(c, s.background, W, height)
      if (d.cover) {
        c.save()
        try { c.filter = 'blur(46px) saturate(1.25)' } catch { /* 旧 WebView 不支持 filter */ }
        drawImageCover(c, d.cover, -80, -80, W + 160, height + 160)
        c.filter = 'none'
        c.restore()
        c.fillStyle = glassDark ? 'rgba(0,0,0,0.28)' : 'rgba(255,255,255,0.16)'
        c.fillRect(0, 0, W, height)
      } else {
        // 没有书封: 两团柔光代替
        for (const [x, y, r, col] of [[W * 0.2, height * 0.18, 420, '#ffc6d9'], [W * 0.85, height * 0.8, 460, '#b9d4ff']] as const) {
          const g = c.createRadialGradient(x, y, 0, x, y, r)
          g.addColorStop(0, col + (glassDark ? '55' : 'cc'))
          g.addColorStop(1, col + '00')
          c.fillStyle = g
          c.fillRect(0, 0, W, height)
        }
      }
      panel(c, M, panelY, W - 2 * M, panelH, 44, pf, 'rgba(0,0,0,0.18)', 60)
      c.save()
      roundRect(c, M + 1, panelY + 1, W - 2 * M - 2, panelH - 2, 43)
      c.strokeStyle = glassDark ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.8)'
      c.lineWidth = 2
      c.stroke()
      c.restore()
      if (coverW && d.cover) bookCover(c, d.cover, (W - coverW) / 2, panelY - coverH / 2, coverW, coverH, 8)
      paintColumn(c, panelY + P, panelH - 2 * P, head, mid, foot, 0.5)
    },
  }
}

// ---- 手账
const notebookTpl: Template = (ctx, d, s, quote, W, H) => {
  const lang = d.lang ?? 'zh'
  const p = cardPalette(s.background)
  const marginX = 150, ix = marginX + 34, iw = W - ix - 96
  const top = stack([gap(170), splitLine('', s.showDate ? dateText(d) : '', ix, iw, p.muted, 26, s.font, 400, 400), gap(40)])
  const tail = sourceText(d, s, true)
  const bottom = stack([
    tail ? stack([gap(30), text(ctx, `—— ${tail}`, { size: 28, family: s.font, color: p.muted, x: ix, width: iw, lineHeight: 1.6, align: 'right' })]) : none,
    s.showBrand ? stack([gap(40), text(ctx, LABELS[lang].brand, { size: 26, family: SANS, weight: 600, color: p.muted, x: ix, width: iw, lineHeight: 1.4, align: 'center' })]) : none,
    gap(90),
  ])
  const ruleColor = p.dark ? 'rgba(255,255,255,0.12)' : 'rgba(80, 110, 160, 0.22)'
  const { mid, need } = fitMiddle(top, bottom, fs => {
    const parts: Block[] = [text(ctx, quote, { size: fs, family: s.font, weight: 500, color: p.ink, x: ix, width: iw, lineHeight: 1.9, ruled: ruleColor })]
    if (s.showNote && d.note?.trim()) parts.push(gap(Math.round(fs * 0.9)), text(ctx, `${LABELS[lang].thought}${lang === 'en' ? ': ' : '：'}${d.note.trim()}`, { size: Math.max(26, Math.round(fs * 0.62)), family: s.font, color: p.accent, x: ix, width: iw, lineHeight: 1.9, ruled: ruleColor }))
    return stack(parts)
  }, H, capFor(s.size, quote, -8))
  const height = Math.max(H, need)
  return {
    height,
    paint: c => {
      fillBackground(c, s.background, W, height)
      if (!p.dark) paperGrain(c, W, height, 0.04)
      // 红色页边线 + 装订孔
      c.fillStyle = p.dark ? 'rgba(255,140,140,0.35)' : 'rgba(214, 92, 92, 0.45)'
      c.fillRect(marginX, 0, 3, height)
      c.fillStyle = p.dark ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.07)'
      for (let y = 140; y < height - 80; y += 180) { c.beginPath(); c.arc(64, y, 16, 0, Math.PI * 2); c.fill() }
      // 和纸胶带
      const tape = (x: number, y: number, w: number, h: number, rot: number, col: string) => {
        c.save()
        c.translate(x, y)
        c.rotate(rot)
        c.globalAlpha = 0.78
        c.fillStyle = col
        c.fillRect(-w / 2, -h / 2, w, h)
        c.globalAlpha = 0.22
        c.fillStyle = '#ffffff'
        for (let i = -w / 2; i < w / 2; i += 26) c.fillRect(i, -h / 2, 12, h)
        c.restore()
      }
      tape(W / 2, 84, 300, 66, -0.06, '#f4b6a6')
      tape(W - 150, height - 70, 220, 54, 0.12, '#b9d7c4')
      paintColumn(c, 0, height, top, mid, bottom, 0.25)
    },
  }
}

// ---- 划线 (马克笔)
const markerTpl: Template = (ctx, d, s, quote, W, H) => {
  const lang = d.lang ?? 'zh'
  const p = cardPalette(s.background)
  const hl = (d.highlight ?? '#ffd54d') + (p.dark ? '66' : '99')
  const M = 110, iw = W - 2 * M
  const tag = s.showChapter && d.chapter ? `${LABELS[lang].tag} · ${d.chapter}` : LABELS[lang].tag
  const pill: Block = {
    h: 56,
    draw: (c, y) => {
      setFont(c, 27, SANS, 600)
      const w = c.measureText(tag).width + 44
      roundRect(c, M, y, Math.min(w, iw), 52, 26)
      c.fillStyle = (d.highlight ?? '#ffd54d') + 'cc'
      c.fill()
      c.fillStyle = '#2a2418'
      c.textBaseline = 'middle'
      c.fillText(tag, M + 22, y + 26)
    },
  }
  const top = stack([gap(120), pill, gap(56)])
  const bottom = stack([gap(56), bookRow(ctx, d, s, M, iw, p.ink, p.muted, 76, 28), gap(28), splitLine(s.showDate ? dateText(d) : '', s.showBrand ? LABELS[lang].brand : '', M, iw, p.muted, 26), gap(100)])
  const { mid, need } = fitMiddle(top, bottom, fs => {
    const parts: Block[] = [text(ctx, quote, { size: fs, family: s.font, weight: 600, color: p.ink, x: M, width: iw, lineHeight: 1.78, marker: hl })]
    if (s.showNote && d.note?.trim()) parts.push(gap(Math.round(fs * 0.8)), noteBlock(ctx, d.note.trim(), p, M, iw, s.font, lang, Math.max(26, Math.round(fs * 0.5))))
    return stack(parts)
  }, H, capFor(s.size, quote, +4))
  const height = Math.max(H, need)
  return {
    height,
    paint: c => {
      fillBackground(c, s.background, W, height)
      // 点阵纸
      c.fillStyle = p.dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)'
      for (let y = 48; y < height; y += 48) for (let x = 48; x < W; x += 48) c.fillRect(x - 1.5, y - 1.5, 3, 3)
      paintColumn(c, 0, height, top, mid, bottom, 0.4)
    },
  }
}

// ---- 日历
const calendarTpl: Template = (ctx, d, s, quote, W, H) => {
  const lang = d.lang ?? 'zh'
  const bgP = cardPalette(s.background)
  const sheetFill = bgP.dark ? '#23252a' : '#ffffff'
  const p = cardPalette(sheetFill)
  const band = '#c8553d'
  const M = 84, top0 = 150, P = 70
  const ix = M + P, iw = W - 2 * (M + P)
  const dp = dateParts(d.date, lang)
  const bandH = 150
  const top = stack([
    gap(bandH + 30),
    text(ctx, dp.day, { size: 230, family: LATIN_SERIF, weight: 700, color: p.ink, x: ix, width: iw, lineHeight: 1.0, align: 'center' }),
    gap(26),
    { h: 2, draw: (c, y) => { c.save(); c.setLineDash([10, 10]); c.strokeStyle = p.rule; c.lineWidth = 2; c.beginPath(); c.moveTo(ix, y); c.lineTo(ix + iw, y); c.stroke(); c.restore() } },
    gap(50),
  ])
  const src = sourceText(d, s)
  const bottom = stack([
    src ? stack([gap(40), text(ctx, src, { size: 28, family: s.font, color: p.muted, x: ix, width: iw, lineHeight: 1.6, align: 'center' })]) : none,
    s.showBrand ? stack([gap(30), text(ctx, LABELS[lang].brand, { size: 26, family: SANS, weight: 600, color: p.muted, x: ix, width: iw, lineHeight: 1.4, align: 'center' })]) : none,
    gap(50),
  ])
  const areaH = H - top0 - 90
  const { mid, need } = fitMiddle(top, bottom, fs => quoteBody(ctx, d, s, quote, ix, iw, p.ink, p.muted, p, fs, { align: 'center', chapterPrefix: '' }), areaH, capFor(s.size, quote, -10))
  const height = Math.max(H, need + top0 + 90)
  const sheetH = height - top0 - 90
  return {
    height,
    paint: c => {
      fillBackground(c, s.background, W, height)
      panel(c, M, top0, W - 2 * M, sheetH, 30, sheetFill, 'rgba(60, 30, 20, 0.16)', 50)
      // 色带
      c.save()
      roundRect(c, M, top0, W - 2 * M, sheetH, 30)
      c.clip()
      c.fillStyle = band
      c.fillRect(M, top0, W - 2 * M, bandH)
      c.restore()
      setFont(c, 34, LATIN_SERIF, 700)
      c.fillStyle = '#ffffff'
      c.textBaseline = 'middle'
      fillTracked(c, dp.monthYear, ix, top0 + bandH / 2 + 8, 4, 'left')
      setFont(c, 28, SANS, 500)
      c.textAlign = 'right'
      c.fillText(dp.weekday, ix + iw, top0 + bandH / 2 + 8)
      c.textAlign = 'left'
      // 装订环
      for (const x of [W / 2 - 220, W / 2 + 220]) {
        c.fillStyle = 'rgba(0,0,0,0.25)'
        c.beginPath(); c.arc(x, top0 + 34, 13, 0, Math.PI * 2); c.fill()
        panel(c, x - 11, top0 - 46, 22, 86, 11, '#3a3d44', 'rgba(0,0,0,0.3)', 8)
      }
      paintColumn(c, top0, sheetH, top, mid, bottom, 0.45)
    },
  }
}

// ---- 竖排 (放不下直排时的横排退路: 竖排书名 + 横排金句)
const verticalFallbackTpl: Template = (ctx, d, s, quote, W, H) => {
  const lang = d.lang ?? 'zh'
  const p = cardPalette(s.background)
  const M = 100, iw = W - 2 * M
  const titleSize = 80
  const cols = s.showBook ? verticalColumns(d.title, 5, 3) : []
  const dateStr = s.showDate ? (lang === 'zh' ? chineseDate(d.date) : dateParts(d.date, lang).dotted) : ''
  const dateChars = [...dateStr]
  const dateSize = 30
  const titleH = cols.length ? Math.max(...cols.map(col => [...col].length)) * titleSize * 1.12 : 0
  const authorChars = s.showBook && d.author ? [...cardBookTitle(d.author)].slice(0, 12) : []
  const topH = Math.max(titleH, authorChars.length * 34, lang === 'zh' ? dateChars.length * dateSize * 1.2 : 0)
  const header: Block = {
    h: topH,
    draw: (c, y) => {
      c.textBaseline = 'top'
      c.textAlign = 'center'
      setFont(c, titleSize, s.font, 700)
      c.fillStyle = p.ink
      const colW = titleSize * 1.18
      const blockW = cols.length * colW
      cols.forEach((col, i) => {
        const cx = M + blockW - colW * (i + 1) + colW / 2
        ;[...col].forEach((ch, j) => c.fillText(ch, cx, y + j * titleSize * 1.12))
      })
      if (authorChars.length) {
        setFont(c, 28, s.font)
        c.fillStyle = p.muted
        authorChars.forEach((ch, j) => c.fillText(ch, M + blockW + 34, y + 4 + j * 34))
      }
      if (dateChars.length) {
        const dx = M + iw - 22
        c.fillStyle = p.rule
        c.fillRect(dx - 34, y, 2, topH)
        c.fillRect(dx + 34, y, 2, topH)
        setFont(c, dateSize, s.font)
        c.fillStyle = p.muted
        if (lang === 'zh') dateChars.forEach((ch, j) => c.fillText(ch, dx, y + j * dateSize * 1.2))
        else { c.save(); c.translate(dx, y); c.rotate(Math.PI / 2); c.textAlign = 'left'; c.textBaseline = 'middle'; c.fillText(dateStr, 0, 0); c.restore() }
      }
      c.textAlign = 'left'
    },
  }
  const top = stack([gap(96), rule(M, iw, p.accent, 10), gap(80), header, gap(topH ? 90 : 0)])
  const bottom = stack([s.showBrand ? text(ctx, LABELS[lang].brand, { size: 26, family: SANS, weight: 600, color: p.muted, x: M, width: iw, lineHeight: 1.4, align: 'right' }) : none, gap(90)])
  const { mid, need } = fitMiddle(top, bottom, fs => quoteBody(ctx, d, s, quote, M, iw, p.ink, p.muted, p, fs, { chapterPrefix: '/ ' }), H, capFor(s.size, quote, -6))
  const height = Math.max(H, need)
  return {
    height,
    paint: c => {
      fillBackground(c, s.background, W, height)
      paintColumn(c, 0, height, top, mid, bottom, 0.35)
    },
  }
}

// ---- 竖排: 金句直排, 自右向左; 书名在最右, 日期与朱印在左下
/** 直排时转 90° 画的标点 (括号、引号、破折号、省略号) */
const V_ROTATE = new Set('（）()「」『』《》〈〉【】〔〕—…～~-[]'.split(''))
/** 直排时挪到字格右上角的句读 */
const V_CORNER = new Set('，。、．,.'.split(''))
const V_QUOTE: Record<string, string> = { '“': '「', '”': '」', '‘': '『', '’': '』', '"': '「' }

function drawVChar(c: Ctx, ch: string, cx: number, cy: number, fs: number) {
  ch = V_QUOTE[ch] ?? ch
  if (V_CORNER.has(ch)) { c.fillText(ch, cx + fs * 0.5, cy - fs * 0.42); return }
  if (V_ROTATE.has(ch)) { c.save(); c.translate(cx, cy); c.rotate(Math.PI / 2); c.fillText(ch, 0, 0); c.restore(); return }
  c.fillText(ch, cx, cy)
}

/** 直排单元: 拉丁字母 / 数字连成的一段 (可含空格) 整体转 90° 横躺, 其余逐字 */
const V_LATIN = /[A-Za-z0-9À-ɏ][A-Za-z0-9À-ɏ'’.\-]*(?: +[A-Za-z0-9À-ɏ][A-Za-z0-9À-ɏ'’.\-]*)*|[\s\S]/gu
const isLatinRun = (t: string) => /^[A-Za-z0-9À-ɏ]/.test(t) && (t.length > 1 || /[A-Za-z]/.test(t))

/** 直排长度 (以字格计); 调用前 ctx 已设好字体 */
function vLength(ctx: Ctx, str: string, pitch: number): number {
  let n = 0
  for (const t of str.match(V_LATIN) ?? []) n += isLatinRun(t) ? (ctx.measureText(t).width + pitch * 0.2) / pitch : /\s/.test(t) ? 0.3 : 1
  return n
}

/** 一组直排列: cols[0] 在最右; x 为最右一列的中线 */
function drawVColumns(c: Ctx, cols: string[], x: number, y: number, fs: number, pitch: number, colGap: number) {
  c.textAlign = 'center'
  c.textBaseline = 'middle'
  cols.forEach((col, i) => {
    const cx = x - i * colGap
    let cy = y
    for (const t of col.match(V_LATIN) ?? []) {
      if (isLatinRun(t)) {
        const w = c.measureText(t).width
        c.save(); c.translate(cx, cy + pitch * 0.1 + w / 2); c.rotate(Math.PI / 2); c.fillText(t, 0, 0); c.restore()
        cy += w + pitch * 0.2
      } else if (/\s/.test(t)) {
        cy += pitch * 0.3
      } else {
        drawVChar(c, t, cx, cy + pitch / 2, fs)
        cy += pitch
      }
    }
  })
  c.textAlign = 'left'
}

/** 朱印: 四字两列 (右列先读), 白文 */
function drawSeal(c: Ctx, text4: string, x: number, y: number, size: number, family: string) {
  const chars = [...text4].slice(0, 4)
  c.save()
  c.translate(x + size / 2, y + size / 2)
  c.rotate(-0.03)
  roundRect(c, -size / 2, -size / 2, size, size, size * 0.08)
  c.fillStyle = '#b8352b'
  c.fill()
  // 印泥不匀: 随机擦掉一些小点
  const rand = seeded(19)
  c.globalCompositeOperation = 'destination-out'
  for (let i = 0; i < 70; i++) { c.globalAlpha = 0.25 + rand() * 0.5; c.beginPath(); c.arc((rand() - 0.5) * size, (rand() - 0.5) * size, rand() * 2.4 + 0.6, 0, Math.PI * 2); c.fill() }
  c.globalCompositeOperation = 'source-over'
  c.globalAlpha = 1
  c.fillStyle = '#fbf3e6'
  const fs = size * 0.36
  setFont(c, fs, family, 700)
  c.textAlign = 'center'
  c.textBaseline = 'middle'
  const pos = chars.length > 2 ? [[0.22, -0.22], [0.22, 0.22], [-0.22, -0.22], [-0.22, 0.22]] : [[0, -0.22], [0, 0.22]]
  chars.forEach((ch, i) => c.fillText(ch, pos[i][0] * size, pos[i][1] * size))
  c.restore()
}

const verticalTpl: Template = (ctx, d, s, quote, W, H) => {
  const lang = d.lang ?? 'zh'
  // 夹几个外文词时整段转 90° 直排; 以外文为主的摘录退回横排
  if (lang === 'en' || (quote.match(/[A-Za-z]/g) ?? []).length > [...quote].length * 0.5) return verticalFallbackTpl(ctx, d, s, quote, W, H)
  const p = cardPalette(s.background)
  const MX = 96, MY = 128
  const colH = H - 2 * MY
  const count = (x: string) => [...x].length
  // 书名列 (最右) + 作者 · 章节列
  const tSize = 62, tPitch = tSize * 1.16
  const titleCols = s.showBook ? verticalColumns(d.title, Math.max(4, Math.floor(colH * 0.62 / tPitch)), 2) : []
  // 作者后的外文原名括注 (「柏拉图 (Plato)」) 直排时逐个字母竖立很难看, 竖排里省掉
  const byline = [s.showBook && d.author ? cardBookTitle(d.author) : '', s.showChapter ? d.chapter ?? '' : ''].filter(Boolean).join('·')
  const aSize = 30, aPitch = aSize * 1.2
  setFont(ctx, aSize, s.font)
  const bylineCols = byline ? wrapText(byline, Math.floor(colH * 0.7 / aPitch), t => vLength(ctx, t, aPitch)).slice(0, 2) : []
  const titleW = titleCols.length * tSize * 1.3 + (bylineCols.length ? 20 + bylineCols.length * aSize * 1.6 : 0)
  // 左侧: 日期列与朱印
  const dateStr = s.showDate ? chineseDate(d.date) : ''
  const dSize = 28, dPitch = dSize * 1.18
  const leftW = dateStr || s.showBrand ? 130 : 0
  const right = W - MX - titleW - (titleW ? 76 : 0)
  const left = MX + leftW + (leftW ? 40 : 0)
  const areaW = right - left
  const note = s.showNote && d.note?.trim() ? `${LABELS.zh.thought}：${d.note.trim()}` : ''
  let fit: { fs: number; cols: string[]; noteCols: string[]; nfs: number } | null = null
  for (let fs = capFor(s.size, quote); fs >= 40; fs -= 2) {
    const pitch = fs * 1.14
    setFont(ctx, fs, s.font, 500)
    const cols = layoutLines(quote, Math.floor(colH / pitch), t => vLength(ctx, t, pitch))
    const nfs = Math.max(28, Math.round(fs * 0.48))
    setFont(ctx, nfs, s.font)
    const noteCols = note ? wrapText(note, Math.floor(colH * 0.85 / (nfs * 1.18)), t => vLength(ctx, t, nfs * 1.18)) : []
    const w = cols.length * fs * 1.72 + (noteCols.length ? fs * 0.9 + noteCols.length * nfs * 1.7 : 0)
    if (w <= areaW) { fit = { fs, cols, noteCols, nfs }; break }
  }
  if (!fit) return verticalFallbackTpl(ctx, d, s, quote, W, H)
  const { fs, cols, noteCols, nfs } = fit
  const blockW = cols.length * fs * 1.72 + (noteCols.length ? fs * 0.9 + noteCols.length * nfs * 1.7 : 0)
  // 文字块靠书名一侧; 空得太多时往中间挪一些
  const free = areaW - blockW
  const blockRight = right - free * (free > areaW * 0.35 ? 0.4 : 0.1)
  return {
    height: H,
    paint: c => {
      fillBackground(c, s.background, W, H)
      if (!p.dark) paperGrain(c, W, H, 0.04)
      // 书名
      let x = W - MX - tSize * 0.65
      if (titleCols.length) {
        setFont(c, tSize, s.font, 700)
        c.fillStyle = p.ink
        drawVColumns(c, titleCols, x, MY - 6, tSize, tPitch, tSize * 1.3)
        x -= titleCols.length * tSize * 1.3 - tSize * 0.3
      }
      if (bylineCols.length) {
        setFont(c, aSize, s.font)
        c.fillStyle = p.muted
        drawVColumns(c, bylineCols, x - aSize * 0.4, MY + tPitch * 0.5, aSize, aPitch, aSize * 1.6)
      }
      if (titleW) {
        c.fillStyle = p.rule
        c.fillRect(W - MX - titleW - 38, MY, 2, colH)
      }
      // 金句
      setFont(c, fs, s.font, 500)
      c.fillStyle = p.ink
      const qx = blockRight - fs * 0.86
      drawVColumns(c, cols, qx, MY, fs, fs * 1.14, fs * 1.72)
      if (noteCols.length) {
        setFont(c, nfs, s.font)
        c.fillStyle = p.muted
        drawVColumns(c, noteCols, qx - cols.length * fs * 1.72 - fs * 0.9 + fs * 0.86 - nfs * 0.85, MY + fs * 1.14, nfs, nfs * 1.18, nfs * 1.7)
      }
      // 日期与朱印
      const seal = 112
      if (s.showBrand) drawSeal(c, '轻阅书摘', MX, H - MY - seal + 20, seal, s.font)
      if (dateStr) {
        setFont(c, dSize, s.font)
        c.fillStyle = p.muted
        const n = count(dateStr)
        const bottom = s.showBrand ? H - MY - seal - 10 : H - MY
        drawVColumns(c, [dateStr], MX + seal / 2, bottom - n * dPitch, dSize, dPitch, 0)
      }
    },
  }
}

// ---- 书页: 像从书里裁下的一页, 书眉、首行缩进、两端对齐, 划线色画在字下
const pageTpl: Template = (ctx, d, s, quote, W, H) => {
  const lang = d.lang ?? 'zh'
  const p = cardPalette(s.background)
  const M = 120, iw = W - 2 * M
  const hl = (d.highlight ?? '#e0a23a')
  const headL = s.showBook && d.author ? d.author : LABELS[lang].brand
  const headR = s.showBook ? (lang === 'en' ? d.title : `《${d.title}》`) : ''
  const runningHead: Block = {
    h: 120,
    draw: (c, y) => {
      setFont(c, 26, s.font, 400)
      c.fillStyle = p.muted
      c.textBaseline = 'middle'
      fillTracked(c, headL, M, y + 50, 2, 'left')
      if (headR) fillTracked(c, headR, M + iw, y + 50, 2, 'right')
      c.fillStyle = p.rule
      c.fillRect(M, y + 96, iw, 2)
    },
  }
  const chapter = s.showChapter && d.chapter
    ? stack([gap(30), text(ctx, d.chapter, { size: 36, family: s.font, weight: 700, color: p.ink, x: M, width: iw, lineHeight: 1.5, align: 'center', tracking: 4 }), gap(20), { h: 30, draw: (c, y) => { c.fillStyle = p.accent; for (const dx of [-24, 0, 24]) { c.beginPath(); c.arc(W / 2 + dx, y + 15, 3.5, 0, Math.PI * 2); c.fill() } } }])
    : none
  const top = stack([gap(70), runningHead, chapter, gap(50)])
  const footer: Block = {
    h: 110,
    draw: (c, y) => {
      c.fillStyle = p.rule
      c.fillRect(M, y + 10, iw, 2)
      setFont(c, 26, s.font)
      c.fillStyle = p.muted
      c.textBaseline = 'middle'
      if (s.showDate) { c.textAlign = 'center'; c.fillText(`— ${dateText(d)} —`, W / 2, y + 66) }
      if (s.showBrand) { setFont(c, 24, SANS, 600); c.textAlign = 'right'; c.fillText(LABELS[lang].brand, M + iw, y + 66) }
      c.textAlign = 'left'
    },
  }
  const bottom = stack([gap(50), footer, gap(80)])
  /** 正文: 首行缩进两字, 中文两端对齐, 划线色衬在字的下半部 */
  const body = (fs: number): Block => {
    setFont(ctx, fs, s.font, 400)
    const lh = Math.round(fs * 1.95)
    const indent = lang === 'en' ? 0 : fs * 2
    const rows: Array<{ line: string; x: number; justify: boolean }> = []
    for (const para of quote.split('\n')) {
      const first = wrapText(para.trim(), iw - indent, t => ctx.measureText(t).width)[0] ?? ''
      const rest = wrapText([...para.trim()].slice([...first].length).join(''), iw, t => ctx.measureText(t).width)
      rows.push({ line: first, x: M + indent, justify: rest.length > 0 && !!rest[0] })
      rest.filter(Boolean).forEach((line, i, arr) => rows.push({ line, x: M, justify: i < arr.length - 1 }))
    }
    const parts: Block[] = [{
      h: rows.length * lh,
      draw: (c, y) => {
        setFont(c, fs, s.font, 400)
        c.textBaseline = 'middle'
        rows.forEach((r, i) => {
          const cy = y + lh * i + lh / 2
          const chars = [...r.line]
          const natural = c.measureText(r.line).width
          // 行尾悬挂标点时本行已超出版心, 不再拉伸
          const just = r.justify && lang !== 'en' && chars.length > 1 && natural < iw - (r.x - M)
          const width = just ? iw - (r.x - M) : natural
          const extra = just ? (width - natural) / (chars.length - 1) : 0
          c.save()
          c.globalAlpha = p.dark ? 0.4 : 0.42
          c.fillStyle = hl
          c.fillRect(r.x - 4, cy + fs * 0.12, width + 8, fs * 0.36)
          c.restore()
          c.fillStyle = p.ink
          if (!extra) { c.fillText(r.line, r.x, cy); return }
          let cx = r.x
          for (const ch of chars) { c.fillText(ch, cx, cy); cx += c.measureText(ch).width + extra }
        })
      },
    }]
    if (s.showNote && d.note?.trim()) parts.push(gap(Math.round(fs * 1.1)), noteBlock(ctx, d.note.trim(), p, M, iw, s.font, lang, Math.max(26, Math.round(fs * 0.62))))
    return stack(parts)
  }
  const { mid, need } = fitMiddle(top, bottom, body, H, capFor(s.size, quote, -16), 30)
  const height = Math.max(H, need)
  return {
    height,
    paint: c => {
      fillBackground(c, s.background, W, height)
      if (!p.dark) paperGrain(c, W, height, 0.035)
      // 书脊一侧的阴影, 像摊开的书页
      const g = c.createLinearGradient(0, 0, 70, 0)
      g.addColorStop(0, p.dark ? 'rgba(0,0,0,0.35)' : 'rgba(90,70,40,0.12)')
      g.addColorStop(1, 'rgba(0,0,0,0)')
      c.fillStyle = g
      c.fillRect(0, 0, 70, height)
      paintColumn(c, 0, height, top, mid, bottom, 0.42)
    },
  }
}

// ---- 克莱因: 瑞士国际主义, 单一锚定色、发丝线网格、超大日期与粗无衬线
const swissTpl: Template = (ctx, d, s, quote, W, H) => {
  const lang = d.lang ?? 'zh'
  const p = cardPalette(s.background)
  const ink = p.dark ? '#ffffff' : '#0b0b0c'
  const soft = p.dark ? 'rgba(255,255,255,0.68)' : 'rgba(11,11,12,0.6)'
  const line = p.dark ? 'rgba(255,255,255,0.55)' : 'rgba(11,11,12,0.7)'
  const M = 80, iw = W - 2 * M
  const dt = new Date(d.date)
  const dp = dateParts(d.date, lang)
  const head: Block = {
    h: 250,
    draw: (c, y) => {
      c.fillStyle = line
      c.fillRect(M, y, iw, 3)
      setFont(c, 26, SANS, 700)
      c.fillStyle = ink
      c.textBaseline = 'top'
      fillTracked(c, 'LIGHTREAD', M, y + 26, 5, 'left')
      setFont(c, 26, SANS, 500)
      c.fillStyle = soft
      fillTracked(c, LABELS[lang].notes, M + iw / 2, y + 26, 5, 'left')
      if (s.showDate) {
        setFont(c, 150, SANS, 800)
        c.fillStyle = ink
        c.textBaseline = 'alphabetic'
        c.textAlign = 'left'
        c.fillText(String(dt.getDate()).padStart(2, '0'), M - 6, y + 220)
        setFont(c, 26, SANS, 600)
        c.textBaseline = 'top'
        fillTracked(c, dp.monthYear.split(' ')[0], M + iw / 2, y + 124, 4, 'left')
        c.fillStyle = soft
        fillTracked(c, `${dt.getFullYear()} · ${dp.weekday}`, M + iw / 2, y + 164, 2, 'left')
      }
    },
  }
  const top = stack([gap(96), head, gap(70)])
  const meta: Block = (s.showBook || s.showChapter) ? (() => {
    const t = s.showBook ? text(ctx, lang === 'en' ? d.title : `《${d.title}》`, { size: 32, family: SANS, weight: 700, color: ink, x: M - (lang === 'en' ? 0 : 14), width: iw / 2 - 20, lineHeight: 1.4, flow: 'greedy' }) : none
    const a = [s.showBook ? d.author : '', s.showChapter ? d.chapter : ''].filter(Boolean).join(' · ')
    const sub = a ? text(ctx, a, { size: 26, family: SANS, color: soft, x: M + iw / 2, width: iw / 2, lineHeight: 1.5, flow: 'greedy' }) : none
    const h = Math.max(t.h, sub.h)
    return { h: h + 30, draw: (c: Ctx, y: number) => { c.fillStyle = line; c.fillRect(M, y, iw, 3); t.draw(c, y + 26); sub.draw(c, y + 30) } }
  })() : none
  const bottom = stack([gap(60), meta, s.showBrand ? stack([gap(26), text(ctx, LABELS[lang].brand, { size: 24, family: SANS, weight: 600, color: soft, x: M, width: iw, lineHeight: 1.4, align: 'right', flow: 'greedy' })]) : none, gap(90)])
  const { mid, need } = fitMiddle(top, bottom, fs => {
    const parts: Block[] = [text(ctx, quote, { size: fs, family: s.font, weight: 700, color: ink, x: M, width: iw, lineHeight: 1.42 })]
    if (s.showNote && d.note?.trim()) parts.push(gap(Math.round(fs * 0.7)), text(ctx, `→ ${d.note.trim()}`, { size: Math.max(28, Math.round(fs * 0.42)), family: SANS, weight: 500, color: soft, x: M + iw / 2, width: iw / 2, lineHeight: 1.6 }))
    return stack(parts)
  }, H, capFor(s.size, quote, +20), 36)
  const height = Math.max(H, need)
  return {
    height,
    paint: c => {
      fillBackground(c, s.background, W, height)
      // 发丝线网格: 两栏 + 竖向分割
      c.fillStyle = p.dark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.07)'
      for (let x = M; x <= W - M + 1; x += iw / 4) c.fillRect(Math.round(x), 0, 1.5, height)
      paintColumn(c, 0, height, top, mid, bottom, 0.38)
    },
  }
}

// ---- 留白
const minimalTpl: Template = (ctx, d, s, quote, W, H) => {
  const lang = d.lang ?? 'zh'
  const p = cardPalette(s.background)
  const M = 120, iw = W - 2 * M
  const top = stack([gap(130), splitLine(LABELS[lang].notes, '', M, iw, p.muted, 26, SANS, 600), gap(20)])
  const tail = sourceText(d, s, true)
  const bottom = stack([
    tail ? stack([gap(70), rule(M, 64, p.ink, 4), gap(30), text(ctx, tail, { size: 28, family: SANS, color: p.muted, x: M, width: iw, lineHeight: 1.6 })]) : none,
    gap(56),
    splitLine(s.showDate ? dateText(d) : '', s.showBrand ? LABELS[lang].brand : '', M, iw, p.muted, 26),
    gap(110),
  ])
  const { mid, need } = fitMiddle(top, bottom, fs => quoteBody(ctx, d, s, quote, M, iw, p.ink, p.muted, p, fs, { weight: 700, lineHeight: 1.62, lead: stack([quoteMark(220, p.accent, 0.3, M), gap(10)]) }), H, capFor(s.size, quote, +14))
  const height = Math.max(H, need)
  return {
    height,
    paint: c => {
      fillBackground(c, s.background, W, height)
      if (!p.dark) paperGrain(c, W, height, 0.03)
      paintColumn(c, 0, height, top, mid, bottom, 0.45)
    },
  }
}

// ---- 备忘录
const memoTpl: Template = (ctx, d, s, quote, W, H) => {
  const lang = d.lang ?? 'zh'
  const p = cardPalette(s.background)
  const amber = '#e0a100'
  const M = 76, iw = W - 2 * M
  const nav: Block = {
    h: 120,
    draw: (c, y) => {
      c.textBaseline = 'middle'
      c.strokeStyle = amber
      c.lineWidth = 6
      c.lineCap = 'round'
      c.beginPath(); c.moveTo(M + 20, y + 40); c.lineTo(M, y + 60); c.lineTo(M + 20, y + 80); c.stroke()
      setFont(c, 36, SANS, 400)
      c.fillStyle = amber
      c.fillText(LABELS[lang].memo, M + 40, y + 60)
      // 右侧: 分享与「完成」
      for (let i = 0; i < 3; i++) { c.beginPath(); c.arc(W - M - 160 + i * 16, y + 60, 5, 0, Math.PI * 2); c.fillStyle = amber; c.fill() }
      setFont(c, 34, SANS, 600)
      c.textAlign = 'right'
      c.fillText(lang === 'en' ? 'Done' : '完成', W - M, y + 60)
      c.textAlign = 'left'
    },
  }
  const meta = [s.showDate ? `${new Date(d.date).getFullYear()}年${new Date(d.date).getMonth() + 1}月${new Date(d.date).getDate()}日` : '', s.showChapter && d.chapter ? d.chapter : ''].filter(Boolean).join('  ')
  const top = stack([
    gap(60), nav, gap(30),
    meta ? stack([text(ctx, meta, { size: 27, family: SANS, color: p.muted, x: M, width: iw, lineHeight: 1.5, align: 'center' }), gap(40)]) : none,
    s.showBook ? stack([text(ctx, lang === 'en' ? d.title : `《${d.title}》`, { size: 52, family: s.font, weight: 700, color: p.ink, x: M - (lang === 'en' ? 0 : 22), width: iw, lineHeight: 1.35 }), d.author ? text(ctx, d.author, { size: 28, family: SANS, color: p.muted, x: M, width: iw, lineHeight: 1.7 }) : none, gap(36)]) : none,
  ])
  const bottom = stack([gap(40), s.showBrand ? text(ctx, LABELS[lang].brand, { size: 26, family: SANS, weight: 600, color: p.muted, x: M, width: iw, lineHeight: 1.4, align: 'center' }) : none, gap(80)])
  const { mid, need } = fitMiddle(top, bottom, fs => {
    const parts: Block[] = [text(ctx, quote, { size: fs, family: s.font, color: p.ink, x: M, width: iw, lineHeight: 1.7 })]
    if (s.showNote && d.note?.trim()) parts.push(gap(Math.round(fs * 0.8)), text(ctx, `• ${d.note.trim()}`, { size: Math.max(26, Math.round(fs * 0.7)), family: s.font, color: p.ink, x: M, width: iw, lineHeight: 1.7 }))
    return stack(parts)
  }, H, capFor(s.size, quote, -18))
  const height = Math.max(H, need)
  return {
    height,
    paint: c => {
      fillBackground(c, s.background, W, height)
      paintColumn(c, 0, height, top, mid, bottom, 0)
    },
  }
}

// ---- 杂志
const magazineTpl: Template = (ctx, d, s, quote, W, H) => {
  const lang = d.lang ?? 'zh'
  const p = cardPalette(s.background)
  const red = p.dark ? '#ff6b5a' : '#c8372d'
  const M = 90, iw = W - 2 * M
  const dt = new Date(d.date)
  const issue = `VOL.${String(dt.getFullYear()).slice(2)} · NO.${String(dt.getMonth() + 1).padStart(2, '0')}${String(dt.getDate()).padStart(2, '0')}`
  const masthead: Block = {
    h: 170,
    draw: (c, y) => {
      setFont(c, 72, LATIN_SERIF, 700)
      c.fillStyle = p.ink
      c.textBaseline = 'alphabetic'
      fillTracked(c, 'LIGHTREAD', M, y + 96, 6, 'left')
      setFont(c, 26, SANS, 600)
      c.fillStyle = red
      c.textBaseline = 'middle'
      c.textAlign = 'right'
      c.fillText(issue, M + iw, y + 60)
      c.textAlign = 'left'
      c.fillStyle = p.ink
      c.fillRect(M, y + 124, iw, 8)
      c.fillRect(M, y + 142, iw, 2)
    },
  }
  const top = stack([gap(80), masthead, gap(30), text(ctx, lang === 'en' ? 'QUOTE OF THE ISSUE' : '本期书摘 · QUOTE', { size: 27, family: SANS, weight: 600, color: p.muted, x: M, width: iw, lineHeight: 1.5, tracking: 4 }), gap(40)])
  const footer: Block = {
    h: 150,
    draw: (c, y) => {
      c.fillStyle = p.ink
      c.fillRect(M, y, iw, 4)
      const col = (label: string, value: string, sub: string, x: number, w: number) => {
        setFont(c, 27, SANS, 600); c.fillStyle = red; c.textBaseline = 'top'
        fillTracked(c, label, x, y + 30, 3, 'left')
        setFont(c, 30, s.font, 600); c.fillStyle = p.ink
        const v = wrapText(value, w, t => c.measureText(t).width)[0] ?? ''
        c.fillText(v, x, y + 66)
        if (sub) { setFont(c, 26, SANS, 400); c.fillStyle = p.muted; c.fillText(sub, x, y + 110) }
      }
      if (s.showBook) col('FROM', lang === 'en' ? d.title : `《${d.title}》`, d.author ?? '', M, iw * 0.62)
      if (s.showDate) col('DATE', dateText(d), s.showChapter && d.chapter ? d.chapter : '', M + iw * 0.68, iw * 0.32)
    },
  }
  const bottom = stack([gap(50), s.showBook || s.showDate ? footer : none, s.showBrand ? text(ctx, LABELS[lang].brand, { size: 24, family: SANS, weight: 600, color: p.muted, x: M, width: iw, lineHeight: 1.4, align: 'right' }) : none, gap(80)])
  const { mid, need } = fitMiddle(top, bottom, fs => {
    const parts: Block[] = [quoteMark(200, red, 1, M), gap(16), text(ctx, quote, { size: fs, family: s.font, weight: 700, color: p.ink, x: M, width: iw, lineHeight: 1.6 })]
    if (s.showNote && d.note?.trim()) parts.push(gap(Math.round(fs * 0.8)), noteBlock(ctx, d.note.trim(), { ...p, accent: red }, M, iw, s.font, lang, Math.max(26, Math.round(fs * 0.5))))
    return stack(parts)
  }, H, capFor(s.size, quote, +2))
  const height = Math.max(H, need)
  return {
    height,
    paint: c => {
      fillBackground(c, s.background, W, height)
      if (!p.dark) paperGrain(c, W, height, 0.035)
      paintColumn(c, 0, height, top, mid, bottom, 0.4)
    },
  }
}

// ---- 大字报
const posterTpl: Template = (ctx, d, s, quote, W, H) => {
  const lang = d.lang ?? 'zh'
  const p = cardPalette(s.background)
  const ink = p.dark ? '#ffe14d' : '#111111'
  const M = 90, iw = W - 2 * M
  const tagText = LABELS[lang].tag
  const tag: Block = {
    h: 70,
    draw: (c, y) => {
      setFont(c, 30, SANS, 700)
      const w = c.measureText(tagText).width + 48
      c.fillStyle = ink
      roundRect(c, M, y, w, 64, 10)
      c.fill()
      c.fillStyle = p.dark ? '#111111' : parseBackground(s.background)[0]
      c.textBaseline = 'middle'
      c.fillText(tagText, M + 24, y + 33)
    },
  }
  const top = stack([gap(110), tag, gap(60)])
  const tail = sourceText(d, s, true)
  const bottom = stack([
    tail ? stack([gap(60), rule(M, iw, ink, 6), gap(26), text(ctx, tail, { size: 32, family: s.font, weight: 600, color: ink, x: M, width: iw, lineHeight: 1.5 })]) : none,
    gap(18),
    splitLine(s.showDate ? dateText(d) : '', s.showBrand ? LABELS[lang].brand : '', M, iw, ink, 27, SANS, 500, 700),
    gap(100),
  ])
  const { mid, need } = fitMiddle(top, bottom, fs => {
    const parts: Block[] = [text(ctx, quote, { size: fs, family: s.font, weight: 700, color: ink, x: M, width: iw, lineHeight: 1.36 })]
    if (s.showNote && d.note?.trim()) parts.push(gap(Math.round(fs * 0.5)), text(ctx, `${LABELS[lang].thought}${lang === 'en' ? ': ' : '：'}${d.note.trim()}`, { size: Math.max(28, Math.round(fs * 0.36)), family: SANS, weight: 500, color: ink, x: M, width: iw, lineHeight: 1.6 }))
    return stack(parts)
  }, H, capFor(s.size, quote, +64), 40)
  const height = Math.max(H, need)
  return {
    height,
    paint: c => {
      fillBackground(c, s.background, W, height)
      paintColumn(c, 0, height, top, mid, bottom, 0.3)
    },
  }
}

// ---- 弥散
const auroraTpl: Template = (ctx, d, s, quote, W, H) => {
  const lang = d.lang ?? 'zh'
  const p = cardPalette(s.background)
  const M = 100, iw = W - 2 * M
  const top = stack([gap(140), splitLine(s.showDate ? dateText(d) : '', LABELS[lang].notes, M, iw, p.muted, 26, SANS, 500, 600), gap(30)])
  const chipRow = bookRow(ctx, d, s, M + 30, iw - 60, p.ink, p.muted, 64, 26)
  const chip: Block = s.showBook ? {
    h: chipRow.h + 48,
    draw: (c, y) => {
      panel(c, M, y, iw, chipRow.h + 48, 28, p.dark ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.62)', 'rgba(0,0,0,0.08)', 30)
      chipRow.draw(c, y + 24)
    },
  } : none
  const bottom = stack([gap(56), chip, s.showBrand ? stack([gap(30), text(ctx, LABELS[lang].brand, { size: 26, family: SANS, weight: 600, color: p.muted, x: M, width: iw, lineHeight: 1.4, align: 'center' })]) : none, gap(100)])
  const { mid, need } = fitMiddle(top, bottom, fs => quoteBody(ctx, d, s, quote, M, iw, p.ink, p.muted, p, fs, { weight: 600, chapterPrefix: '— ' }), H, capFor(s.size, quote, +6))
  const height = Math.max(H, need)
  return {
    height,
    paint: c => {
      fillBackground(c, s.background, W, height)
      const blobs: Array<[number, number, number, string]> = p.dark
        ? [[0.15, 0.12, 0.7, '#6b4cff'], [0.9, 0.35, 0.6, '#ff4f9a'], [0.3, 0.95, 0.75, '#00b3a4']]
        : [[0.1, 0.1, 0.7, '#ffb8d0'], [0.95, 0.3, 0.62, '#a9c8ff'], [0.25, 0.92, 0.75, '#b5f0d6'], [0.85, 0.95, 0.5, '#ffe3a3']]
      for (const [fx, fy, fr, col] of blobs) {
        const x = W * fx, y = height * fy, r = W * fr
        const g = c.createRadialGradient(x, y, 0, x, y, r)
        g.addColorStop(0, col + (p.dark ? '88' : 'dd'))
        g.addColorStop(1, col + '00')
        c.fillStyle = g
        c.fillRect(0, 0, W, height)
      }
      paintColumn(c, 0, height, top, mid, bottom, 0.45)
    },
  }
}

// ---- 星夜
const nightTpl: Template = (ctx, d, s, quote, W, H) => {
  const lang = d.lang ?? 'zh'
  const p = cardPalette(s.background)
  const ink = p.dark ? '#f3ecdc' : p.ink
  const gold = '#e3c27a'
  const M = 110, iw = W - 2 * M
  const top = stack([gap(260), text(ctx, s.showDate ? dateText(d) : '', { size: 27, family: SANS, color: gold, x: M, width: iw, lineHeight: 1.5, tracking: 3 }), gap(50)])
  const tail = sourceText(d, s)
  const bottom = stack([
    tail ? stack([gap(70), text(ctx, `— ${tail}`, { size: 30, family: s.font, color: gold, x: M, width: iw, lineHeight: 1.6, align: 'right' })]) : none,
    s.showBrand ? stack([gap(60), text(ctx, LABELS[lang].brand, { size: 26, family: SANS, weight: 600, color: p.dark ? 'rgba(243,236,220,0.55)' : p.muted, x: M, width: iw, lineHeight: 1.4, align: 'center' })]) : none,
    gap(110),
  ])
  const { mid, need } = fitMiddle(top, bottom, fs => quoteBody(ctx, d, s, quote, M, iw, ink, p.dark ? 'rgba(243,236,220,0.65)' : p.muted, { ...p, accent: gold }, fs, { lineHeight: 1.85, chapterPrefix: '' }), H, capFor(s.size, quote, -4))
  const height = Math.max(H, need)
  return {
    height,
    paint: c => {
      fillBackground(c, s.background, W, height)
      const rand = seeded(42)
      for (let i = 0; i < 140; i++) {
        const x = rand() * W, y = rand() * height, r = rand() * 2.2 + 0.4
        c.globalAlpha = 0.25 + rand() * 0.6
        c.fillStyle = '#ffffff'
        c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill()
      }
      c.globalAlpha = 1
      // 弯月
      const mx = W - 200, my = 180
      const glow = c.createRadialGradient(mx, my, 20, mx, my, 220)
      glow.addColorStop(0, 'rgba(255, 236, 190, 0.35)')
      glow.addColorStop(1, 'rgba(255, 236, 190, 0)')
      c.fillStyle = glow
      c.fillRect(mx - 240, my - 240, 480, 480)
      // 月牙: 先在离屏画布上挖出月牙再贴上, 不碰底下的星空与光晕
      const moon = document.createElement('canvas')
      moon.width = moon.height = 140
      const mc = moon.getContext('2d')!
      mc.fillStyle = '#f8e7b8'
      mc.beginPath(); mc.arc(70, 70, 62, 0, Math.PI * 2); mc.fill()
      mc.globalCompositeOperation = 'destination-out'
      mc.beginPath(); mc.arc(100, 48, 58, 0, Math.PI * 2); mc.fill()
      c.drawImage(moon, mx - 70, my - 70)
      paintColumn(c, 0, height, top, mid, bottom, 0.4)
    },
  }
}

// ---- 稿纸
const manuscriptTpl: Template = (_ctx, d, s, quote, W, H) => {
  const lang = d.lang ?? 'zh'
  const p = cardPalette(s.background)
  const green = p.dark ? 'rgba(140, 200, 160, 0.55)' : 'rgba(64, 128, 88, 0.55)'
  const M = 70
  const tail = sourceText(d, s)
  const noteText = s.showNote && d.note?.trim() ? d.note.trim() : ''
  // 一字一格: 段落之间换行; 找能放下的最大格子
  const lay = (cell: number) => {
    const cols = Math.floor((W - 2 * M) / cell)
    const rows: string[][] = []
    const pushPara = (str: string) => {
      const chars = [...str.replace(/\s+/g, '')]
      // 首行空两格
      let row: string[] = ['', '']
      for (const ch of chars) {
        if (row.length >= cols) {
          // 行首不能是标点: 挤进上一行最后一格之外 (与稿纸习惯一致)
          if (NO_LINE_START_CHARS.has(ch)) { row[row.length - 1] += ch; continue }
          rows.push(row); row = []
        }
        row.push(ch)
      }
      rows.push(row)
    }
    for (const para of quote.split('\n')) pushPara(para)
    if (noteText) { rows.push([]); pushPara(`${LABELS[lang].thought}${lang === 'en' ? ': ' : '：'}${noteText}`) }
    return { cols, rows }
  }
  const headH = 300, footH = 260
  let cell = 104
  let L = lay(cell)
  while (cell > 54 && L.rows.length * cell * 1.15 > H - headH - footH) { cell -= 4; L = lay(cell) }
  const gridRows = Math.max(L.rows.length, Math.floor((Math.max(H, headH + footH + L.rows.length * cell * 1.15) - headH - footH) / (cell * 1.15)))
  const height = Math.max(H, headH + footH + gridRows * cell * 1.15)
  const gx = (W - L.cols * cell) / 2
  return {
    height,
    paint: c => {
      fillBackground(c, s.background, W, height)
      if (!p.dark) paperGrain(c, W, height, 0.035)
      // 书名居中在顶部
      c.textBaseline = 'middle'
      c.textAlign = 'center'
      if (s.showBook) {
        setFont(c, 46, s.font, 600)
        c.fillStyle = p.ink
        c.fillText(lang === 'en' ? d.title : `《${d.title}》`, W / 2, 150)
        if (d.author) { setFont(c, 26, s.font); c.fillStyle = p.muted; c.fillText(d.author, W / 2, 214) }
      }
      // 格子
      const rowH = cell * 1.15
      c.strokeStyle = green
      c.lineWidth = 2
      c.strokeRect(gx - 10, headH - 10, L.cols * cell + 20, gridRows * rowH + 20 - (rowH - cell))
      for (let r = 0; r < gridRows; r++) {
        const y = headH + r * rowH
        c.lineWidth = 1.5
        c.strokeRect(gx, y, L.cols * cell, cell)
        for (let k = 1; k < L.cols; k++) { c.beginPath(); c.moveTo(gx + k * cell, y); c.lineTo(gx + k * cell, y + cell); c.stroke() }
      }
      // 字
      setFont(c, Math.round(cell * 0.62), s.font, 500)
      c.fillStyle = p.ink
      L.rows.forEach((row, r) => {
        row.forEach((ch, k) => {
          if (!ch) return
          const x = gx + k * cell + cell / 2
          const y = headH + r * rowH + cell / 2
          // 句读标点靠左下, 与稿纸书写习惯一致
          if (ch.length === 1 && /[，。、；：！？]/.test(ch)) c.fillText(ch, x - cell * 0.2, y + cell * 0.18)
          else if (ch.length > 1) { c.fillText(ch[0], x, y); c.fillText(ch.slice(1), x + cell * 0.42, y + cell * 0.18) }
          else c.fillText(ch, x, y)
        })
      })
      // 页脚
      const fy = headH + gridRows * rowH + 60
      setFont(c, 26, s.font)
      c.fillStyle = p.muted
      c.textAlign = 'right'
      if (s.showChapter && d.chapter) c.fillText(d.chapter, gx + L.cols * cell, fy)
      c.textAlign = 'left'
      setFont(c, 26, SANS)
      const left = [s.showDate ? dateText(d) : '', `${L.cols}×${gridRows}`].filter(Boolean).join('  ')
      c.fillText(left, gx, fy + 64)
      if (s.showBrand) { setFont(c, 26, SANS, 600); c.textAlign = 'right'; c.fillText(LABELS[lang].brand, gx + L.cols * cell, fy + 64); c.textAlign = 'left' }
      if (!s.showBook && tail) { /* 书名关掉时稿纸只留正文 */ }
    },
  }
}

const NO_LINE_START_CHARS = new Set('，。、；：？！）」』》〉】”’…'.split(''))

const TEMPLATES: Record<CardTemplate, Template> = {
  paper: paperTpl,
  glass: glassTpl,
  notebook: notebookTpl,
  marker: markerTpl,
  calendar: calendarTpl,
  vertical: verticalTpl,
  minimal: minimalTpl,
  memo: memoTpl,
  magazine: magazineTpl,
  poster: posterTpl,
  aurora: auroraTpl,
  night: nightTpl,
  manuscript: manuscriptTpl,
  page: pageTpl,
  swiss: swissTpl,
}

/** 先确保字体已加载, 否则 Canvas 会用回退字体画出错位的字 */
export async function ensureCardFonts(family: string, sample: string): Promise<void> {
  const fonts = (document as Document & { fonts?: FontFaceSet }).fonts
  if (!fonts?.load) return
  const t = sample.slice(0, 200) || '轻阅'
  await Promise.all([
    fonts.load(`400 48px ${family}`, t),
    fonts.load(`500 48px ${family}`, t),
    fonts.load(`700 48px ${family}`, t),
  ].map(p => p.catch(() => {})))
}

/** 画出整张卡片 (宽 1080, 高按比例, 内容放不下时加长) */
export function renderQuoteCard(d: QuoteCardData, s: QuoteCardStyle, canvas = document.createElement('canvas')): HTMLCanvasElement {
  const { text: quote } = clampQuote(d.text)
  d = { ...d, title: cardBookTitle(d.title), author: cardAuthor(d.author) }
  const tpl = TEMPLATES[s.template] ?? paperTpl
  const W = CARD_WIDTH
  const H = cardHeight(s.ratio ?? '3:4')
  const measureCtx = document.createElement('canvas').getContext('2d')!
  const layout = tpl(measureCtx, d, s, quote, W, H)
  canvas.width = W
  canvas.height = Math.ceil(layout.height)
  const c = canvas.getContext('2d')!
  c.clearRect(0, 0, canvas.width, canvas.height)
  layout.paint(c)
  return canvas
}

export function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'))
}

/** 卡片文件名: LightRead-书名-时间.png */
export function cardFileName(title: string, now = Date.now()): string {
  const safe = (cardBookTitle(title || '') || 'LightRead').replace(/[\\/:*?"<>|\u0000-\u001f《》]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40)
  const d = new Date(now)
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`
  return `LightRead-${safe}-${stamp}.png`
}
