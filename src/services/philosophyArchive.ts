/**
 * 哲学文库: 马克思主义文库 (marxists.org 中英文)、Early Modern Texts、Standard Ebooks 哲学类。
 * 这些站点没有可用的搜索接口 (marxists.org 站内搜索就是 Google), 所以随应用附带一份离线索引
 * (src/data/philosophy-index.json, 由 scripts/build-philosophy-index.mjs 生成), 在本地搜索;
 * 只有下载书籍时才访问原站。
 */
import type { OpdsPublication } from './opds'
import { baseTitle, compactKey, normalizeBookQuery } from './bookQuery.ts'

export interface PhilosophySource {
  id: string
  name: string
  /** 索引里的相对路径都相对这个地址 */
  base: string
  /** 下载接口带 Access-Control-Allow-Origin: 网页版无需代理即可在应用内下载 */
  cors: boolean
}

/** [书名, 作者序号(-1 无), 来源序号, 语言, 原网页序号(-1 即第一个文件), "格式码:路径 ..."] */
export type PhilosophyIndexRow = [string, number, number, string, number, string]

export interface PhilosophyIndexData {
  version: number
  updated: string
  sources: PhilosophySource[]
  authors: string[]
  pages: string[]
  works: PhilosophyIndexRow[]
}

export interface PhilosophyWork {
  id: string
  title: string
  author: string
  lang: string
  source: PhilosophySource
  /** 原网页 (目录页或文章本身) */
  url: string
  /** 3 书名完全一致 / 2 书名以查询开头 / 1 书名包含查询或作者命中 */
  relevance: number
  publication: OpdsPublication
}

interface FormatInfo { label: string; type: string; rank: number }

/** 格式码 → 下载按钮; rank 小的排前面 (EPUB 优先) */
export const PHILOSOPHY_FORMATS: Record<string, FormatInfo> = {
  e: { label: 'EPUB', type: 'application/epub+zip', rank: 0 },
  p: { label: 'PDF', type: 'application/pdf', rank: 1 },
  a: { label: 'AZW3', type: 'application/vnd.amazon.ebook', rank: 2 },
  m: { label: 'MOBI', type: 'application/x-mobipocket-ebook', rank: 3 },
  d: { label: 'DJVU', type: 'image/vnd.djvu', rank: 4 },
  t: { label: 'TXT', type: 'text/plain', rank: 5 },
  h: { label: 'HTML', type: 'text/html', rank: 6 },
}

/**
 * 常用繁体字 → 简体 (只覆盖这类文库书名的高频字): 文库中文部分基本是简体,
 * 用户输入「共產黨宣言」「資本論」也应找到。
 */
const TRAD_PAIRS = (
  '黨党 產产 資资 論论 國国 馬马 義义 經经 濟济 學学 會会 階阶 級级 鬥斗 爭争 運运 動动 發发 選选 實实 踐践 '
  + '辯辩 證证 東东 澤泽 寧宁 達达 爾尔 費费 說说 話话 書书 讀读 體体 與与 們们 個个 為为 來来 時时 對对 開开 '
  + '關关 於于 從从 當当 過过 還还 這这 進进 應应 錄录 軍军 隊队 權权 歷历 數数 設设 計计 問问 題题 傳传 電电 '
  + '樂乐 藝艺 術术 觀观 點点 線线 務务 辦办 條条 區区 縣县 農农 業业 勞劳 價价 貨货 幣币 餘余 積积 專专 綱纲 '
  + '領领 戰战 殺杀 歲岁 紀纪 屬属 維维 紐纽 約约 華华 蘇苏 聯联 羅罗 盧卢 薩萨 莊庄 無无 統统 帥帅 壇坛 邏逻 '
  + '輯辑 認认 識识 樣样 萬万 億亿 貧贫 窮穷 態态 環环 節节 變变 現现 狀状 幾几 張张 陳陈 獨独 楊杨 廣广 鄧邓 '
  + '劉刘 舊旧 黃黄 譯译 審审 傑杰 綫线 驗验 響响 選选 擇择 創创 準准 備备 鬥斗 爭争 輪轮 談谈 論论 筆笔 記记 '
  + '詞词 典典 隨随 筆笔 闡阐 釋释 補补 編编 輯辑 錄录 選选 讀读 譯译 註注 齊齐 衛卫 鐵铁 鋼钢 礦矿 漢汉 灣湾 '
  + '亞亚 歐欧 洲洲 澳澳 韓韩 義义 黑黑 費费 爾尔 恩恩 寫写 斯斯 熱热 愛爱 憲宪 選选 舉举 議议 員员 職职 鬥斗'
).split(' ').filter(pair => pair.length === 2)
const TRAD_MAP = new Map(TRAD_PAIRS.map(pair => [pair[0]!, pair[1]!]))
const TRAD_RE = new RegExp(`[${[...TRAD_MAP.keys()].join('')}]`, 'g')

/** 搜索用的归一: NFKC + 小写 + 常用繁体转简体 */
export function foldText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(TRAD_RE, ch => TRAD_MAP.get(ch) ?? ch)
}

interface PreparedWork {
  row: PhilosophyIndexRow
  order: number
  /** 去括注后的书名 compactKey */
  baseKey: string
  /** 整个书名 compactKey */
  fullKey: string
  /** 书名小写 (保留空格, 判断「包含全部关键词」) */
  lower: string
  authorLower: string
  authorKey: string
  bestRank: number
}

export interface PreparedPhilosophyIndex {
  data: PhilosophyIndexData
  works: PreparedWork[]
}

function isRow(value: unknown): value is PhilosophyIndexRow {
  return Array.isArray(value) && value.length === 6
    && typeof value[0] === 'string' && Number.isInteger(value[1]) && Number.isInteger(value[2])
    && typeof value[3] === 'string' && Number.isInteger(value[4]) && typeof value[5] === 'string'
}

/** 校验索引并预先算好每部作品的搜索键 (只做一次) */
export function preparePhilosophyIndex(raw: unknown): PreparedPhilosophyIndex {
  const data = raw as PhilosophyIndexData
  if (!data || !Array.isArray(data.sources) || !Array.isArray(data.works) || !Array.isArray(data.authors) || !Array.isArray(data.pages)) {
    throw new Error('哲学文库索引无效')
  }
  const works: PreparedWork[] = []
  data.works.forEach((row, order) => {
    if (!isRow(row) || !data.sources[row[2]]) return
    const author = data.authors[row[1]] ?? ''
    const title = foldText(row[0])
    works.push({
      row,
      order,
      baseKey: compactKey(baseTitle(title)),
      fullKey: compactKey(title),
      lower: title,
      authorLower: foldText(author),
      authorKey: compactKey(foldText(author)),
      bestRank: Math.min(...row[5].split(' ').map(file => PHILOSOPHY_FORMATS[file[0]!]?.rank ?? 9)),
    })
  })
  return { data, works }
}

/**
 * 相关度 (细分, 用于排序): 40 书名完全一致 / 30 以查询开头 / 20 书名包含全部关键词
 * / 15 关键词分布在书名与作者中 / 10 作者命中 / 0 不相关
 */
export function scorePhilosophyWork(work: PreparedWork, terms: string[], key: string): number {
  if (!key) return 0
  if (work.baseKey === key || work.fullKey === key) return 40
  if (work.baseKey.startsWith(key) || work.fullKey.startsWith(key)) return 30
  const inTitle = (term: string) => work.lower.includes(term) || work.fullKey.includes(compactKey(term))
  const inAuthor = (term: string) => !!work.authorLower && (work.authorLower.includes(term) || work.authorKey.includes(compactKey(term)))
  if (work.fullKey.includes(key) || terms.every(inTitle)) return 20
  if (terms.some(inTitle) && terms.every(term => inTitle(term) || inAuthor(term))) return 15
  if (work.authorKey && (work.authorKey === key || terms.every(inAuthor))) return 10
  return 0
}

function toRelevance(score: number): number {
  return score >= 40 ? 3 : score >= 30 ? 2 : score > 0 ? 1 : 0
}

function absoluteUrl(path: string, source: PhilosophySource): string {
  return /^https?:\/\//i.test(path) ? path : source.base + path
}

/** 索引一行 → 统一搜书的结果 (下载链接按 EPUB > PDF > AZW3 > MOBI > DjVu > TXT > HTML) */
export function philosophyWorkOf(index: PreparedPhilosophyIndex, work: PreparedWork, relevance = 0): PhilosophyWork {
  const [title, authorIdx, sourceIdx, lang, pageIdx, filesText] = work.row
  const source = index.data.sources[sourceIdx]!
  const author = index.data.authors[authorIdx] ?? ''
  const files = filesText.split(' ').flatMap(entry => {
    const format = PHILOSOPHY_FORMATS[entry[0]!]
    const path = entry.slice(2)
    return format && entry[1] === ':' && path ? [{ format, href: absoluteUrl(path, source) }] : []
  })
  const acquisitions = files
    .map((file, i) => ({ file, i }))
    .sort((a, b) => a.file.format.rank - b.file.format.rank || a.i - b.i)
    .map(({ file }) => ({ href: file.href, type: file.format.type, label: file.format.label }))
  const page = pageIdx >= 0 && index.data.pages[pageIdx] ? absoluteUrl(index.data.pages[pageIdx]!, source) : acquisitions[0]?.href ?? source.base
  return {
    id: `${source.id}:${files[0]?.href ?? work.order}`,
    title,
    author,
    lang,
    source,
    url: page,
    relevance,
    publication: { title, author, acquisitions },
  }
}

/** 本地搜索 (纯函数): 相关度 > 有 EPUB > 短书名 > 索引原顺序 */
export function searchPhilosophyIndex(index: PreparedPhilosophyIndex, query: string, limit = 30): PhilosophyWork[] {
  const normalized = foldText(normalizeBookQuery(query))
  const key = compactKey(normalized)
  if (!key) return []
  const terms = normalized.split(' ').filter(Boolean)
  const bounded = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.floor(limit))) : 30
  const hits: Array<{ work: PreparedWork; score: number }> = []
  for (const work of index.works) {
    const score = scorePhilosophyWork(work, terms, key)
    if (score) hits.push({ work, score })
  }
  hits.sort((a, b) => b.score - a.score
    || a.work.bestRank - b.work.bestRank
    || a.work.fullKey.length - b.work.fullKey.length
    || a.work.order - b.work.order)
  return hits.slice(0, bounded).map(hit => philosophyWorkOf(index, hit.work, toRelevance(hit.score)))
}

let loading: Promise<PreparedPhilosophyIndex> | undefined

/** 索引单独打包, 第一次搜索时才加载 */
export function loadPhilosophyIndex(): Promise<PreparedPhilosophyIndex> {
  loading ??= import('../data/philosophy-index.json')
    .then(module => preparePhilosophyIndex((module as { default?: unknown }).default ?? module))
    .catch(error => {
      loading = undefined
      throw error
    })
  return loading
}

export async function searchPhilosophyArchive(query: string, limit = 30): Promise<PhilosophyWork[]> {
  return searchPhilosophyIndex(await loadPhilosophyIndex(), query, limit)
}
