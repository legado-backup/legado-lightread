/**
 * 研辞问典 (wendian.dicomp.net): 古籍文献、中医药古籍、四书五经、蒙学。
 *
 *  - 搜索: 随应用附带离线书目 src/data/wendian-index.json (scripts/build-wendian-index.mjs 生成,
 *    第一次搜索时才加载), 本地比对书名 / 作者, 繁简互通。不调用该站的搜索接口 (robots.txt 禁止)。
 *  - 导入: 只请求用户选中的那一本 —— 古籍 / 中医古籍是一页全文 (detail.php?id=N),
 *    四书五经 / 蒙学是目录页 (book.php) 加各章页面; 解析正文、分章, 在本地打包成 EPUB。
 *
 * 本文件只有纯函数与注入的网络请求, node --test 可直接测。
 */
import { baseTitle, compactKey, normalizeBookQuery } from './bookQuery.ts'
import {
  buildContainerXml, buildNav, buildNcx, buildOpf, escapeXml, zipEpub,
  type EpubEntry, type ManifestItem, type TocNode,
} from './epubWriter.ts'

export const WENDIAN_SITE = 'https://wendian.dicomp.net/'
export type WendianSection = 'ancient' | 'tcm' | 'classics' | 'mengxue'

/** [书名, 作者序号(-1 无), 分类序号, 栏目序号, 站内编号 (detail id 或 "book|var"), 约字数 (0 未知)] */
export type WendianIndexRow = [string, number, number, number, number | string, number]

export interface WendianIndexData {
  version: number
  updated: string
  site: string
  sections: string[]
  categories: string[]
  authors: string[]
  /** OpenCC 繁→简对照子集, 每两个字一对 */
  t2s: string
  books: WendianIndexRow[]
}

export interface WendianWork {
  id: string
  title: string
  author: string
  category: string
  section: WendianSection
  /** 站内编号: detail id 或 book 名 (蒙学可带 |版本) */
  ref: string
  /** 约字数, 0 未知 */
  chars: number
  /** 原站页面 */
  url: string
  /** 3 书名完全一致 / 2 书名以查询开头 / 1 包含或作者命中 */
  relevance: number
}

interface PreparedWork {
  row: WendianIndexRow
  order: number
  section: WendianSection
  baseKey: string
  fullKey: string
  lower: string
  authorLower: string
  authorKey: string
}

export interface PreparedWendianIndex {
  data: WendianIndexData
  works: PreparedWork[]
  fold: (text: string) => string
}

const SECTIONS: WendianSection[] = ['ancient', 'tcm', 'classics', 'mengxue']
/** 同等相关度时: 四书五经 / 蒙学 (整理过的通行本) 在前, 再古籍、中医古籍 */
const SECTION_RANK: Record<WendianSection, number> = { classics: 0, mengxue: 1, ancient: 2, tcm: 3 }

/** 繁简归一: NFKC + 小写 + 繁体字折成简体 (对照表随索引分发) */
export function makeFold(t2s: string): (text: string) => string {
  const chars = Array.from(t2s ?? '')
  const map = new Map<string, string>()
  for (let i = 0; i + 1 < chars.length; i += 2) map.set(chars[i]!, chars[i + 1]!)
  return text => {
    const lower = text.normalize('NFKC').toLowerCase()
    if (!map.size) return lower
    let out = ''
    for (const ch of lower) out += map.get(ch) ?? ch
    return out
  }
}

function isRow(value: unknown): value is WendianIndexRow {
  return Array.isArray(value) && value.length === 6
    && typeof value[0] === 'string' && Number.isInteger(value[1]) && Number.isInteger(value[2])
    && Number.isInteger(value[3]) && (typeof value[4] === 'string' || Number.isInteger(value[4]))
    && Number.isFinite(value[5])
}

/** 校验索引并预先算好搜索键 (只做一次) */
export function prepareWendianIndex(raw: unknown): PreparedWendianIndex {
  const data = raw as WendianIndexData
  if (!data || !Array.isArray(data.books) || !Array.isArray(data.authors) || !Array.isArray(data.categories) || !Array.isArray(data.sections)) {
    throw new Error('Invalid wendian index')
  }
  const fold = makeFold(data.t2s)
  const works: PreparedWork[] = []
  data.books.forEach((row, order) => {
    if (!isRow(row)) return
    const section = data.sections[row[3]] as WendianSection
    if (!SECTIONS.includes(section) || !row[0]) return
    const title = fold(row[0])
    const author = fold(data.authors[row[1]] ?? '')
    works.push({
      row, order, section,
      baseKey: compactKey(baseTitle(title)),
      fullKey: compactKey(title),
      lower: title,
      authorLower: author,
      authorKey: compactKey(author),
    })
  })
  return { data, works, fold }
}

/** 与哲学文库同一尺度: 40 书名一致 / 30 前缀 / 20 书名含全部关键词 / 15 书名 + 作者 / 10 作者 / 0 */
function scoreWork(work: PreparedWork, terms: string[], key: string): number {
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

/** 原站页面地址 */
export function wendianUrl(section: WendianSection, ref: string | number, site = WENDIAN_SITE): string {
  if (section === 'ancient' || section === 'tcm') return `${site}${section}/detail.php?id=${ref}`
  const [book = '', variant = ''] = String(ref).split('|')
  return `${site}${section}/book.php?book=${encodeURIComponent(book)}${variant ? `&var=${encodeURIComponent(variant)}` : ''}`
}

export function wendianWorkOf(index: PreparedWendianIndex, work: PreparedWork, relevance = 0): WendianWork {
  const [title, authorIdx, categoryIdx, , ref, chars] = work.row
  return {
    id: `${work.section}:${ref}`,
    title,
    author: index.data.authors[authorIdx] ?? '',
    category: index.data.categories[categoryIdx] ?? '',
    section: work.section,
    ref: String(ref),
    chars,
    url: wendianUrl(work.section, ref, index.data.site || WENDIAN_SITE),
    relevance,
  }
}

/** 本地搜索 (纯函数): 相关度 > 栏目 (四书五经 / 蒙学在前) > 短书名 > 篇幅大的 (多为足本) > 索引顺序 */
export function searchWendianIndex(index: PreparedWendianIndex, query: string, limit = 40): WendianWork[] {
  const normalized = index.fold(normalizeBookQuery(query))
  const key = compactKey(normalized)
  if (!key) return []
  const terms = normalized.split(' ').filter(Boolean)
  const hits: Array<{ work: PreparedWork; score: number }> = []
  for (const work of index.works) {
    const score = scoreWork(work, terms, key)
    if (score) hits.push({ work, score })
  }
  hits.sort((a, b) => b.score - a.score
    || SECTION_RANK[a.work.section] - SECTION_RANK[b.work.section]
    || a.work.fullKey.length - b.work.fullKey.length
    || b.work.row[5] - a.work.row[5]
    || a.work.order - b.work.order)
  const bounded = Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.floor(limit))) : 40
  return hits.slice(0, bounded).map(hit => wendianWorkOf(index, hit.work, hit.score >= 40 ? 3 : hit.score >= 30 ? 2 : 1))
}

let loading: Promise<PreparedWendianIndex> | undefined

/** 索引单独打包, 第一次搜索时才加载 */
export function loadWendianIndex(): Promise<PreparedWendianIndex> {
  loading ??= import('../data/wendian-index.json')
    .then(module => prepareWendianIndex((module as { default?: unknown }).default ?? module))
    .catch(error => {
      loading = undefined
      throw error
    })
  return loading
}

export async function searchWendian(query: string, limit = 40): Promise<WendianWork[]> {
  return searchWendianIndex(await loadWendianIndex(), query, limit)
}

// ---------------------------------------------------------------- 页面解析

export interface WendianChapter {
  title: string
  /** 段落 (已去标签、解码实体) */
  paragraphs: string[]
}

export interface WendianPage {
  title: string
  /** 正文前的说明行 (作者 / 出处等) */
  byline: string
  breadcrumb: string[]
  chapters: WendianChapter[]
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', hellip: '…', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', mdash: '—' }
function decodeEntities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m
    const code = e[1]!.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m
  })
}
const stripTags = (html: string) => decodeEntities(html.replace(/<[^>]*>/g, ''))
const inline = (html: string) => stripTags(html).replace(/\s+/g, ' ').trim()
const bookName = (text: string) => text.replace(/^《(.*)》$/, '$1').trim()
/** 正文里每个字都包成查字典的链接 (6 MB 的页面大半是它), 先还原成纯字 */
const unwrapCharLinks = (html: string) => html.replace(/<a\b[^>]*\bclass="poem-char"[^>]*>([^<]*)<\/a>/g, '$1')

/**
 * 原书的硬换行: 一行很长又不以句末标点结尾, 下一行也不是缩进开头的新段 → 并回上一行
 * (中医古籍按排版宽度折行, 「剧则如 / 惊痫」)。古籍的短标题行 (钦定四库全书 / 提要) 不受影响。
 */
function mergeHardWraps(rawLines: string[]): string[] {
  const out: string[] = []
  let joinNext = false
  for (const raw of rawLines) {
    const line = raw.replace(/^[\s\u3000]+|[\s\u3000]+$/g, '')
    if (!line) { joinNext = false; continue }
    const startsBlock = /^[\u3000\s]/.test(raw) || /^[\d０-９]+[.．、]/.test(line)
    if (joinNext && !startsBlock && out.length) out[out.length - 1] += line
    else out.push(line)
    joinNext = Array.from(line).length >= 20 && !/[。！？；：」』”’）)】〉》.!?]$/.test(line)
  }
  return out
}

function paragraphsOf(bodyHtml: string): string[] {
  const blocks = [...bodyHtml.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map(m => m[1]!)
  const sources = blocks.length ? blocks : [bodyHtml]
  const lines: string[] = []
  for (const block of sources) {
    // 原始行 (保留行首缩进, 用来判断是不是新段)
    const raw = stripTags(block.replace(/<br\s*\/?>/gi, '\n')).split('\n')
    lines.push(...mergeHardWraps(raw))
  }
  return lines
}

/** detail.php: 古籍 / 中医古籍是整本 (分节), 四书五经 / 蒙学是其中一章 */
export function parseWendianDetail(html: string): WendianPage {
  const main = /<main\b[\s\S]*?<\/main>/i.exec(html)?.[0] ?? html
  const nav = /<nav\b[^>]*>([\s\S]*?)<\/nav>/i.exec(main)?.[1] ?? ''
  const breadcrumb = [...nav.matchAll(/<(?:a|span)\b[^>]*>([\s\S]*?)<\/(?:a|span)>/gi)]
    .map(m => bookName(inline(m[1]!))).filter(text => text && text !== '›')
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(main)?.[1] ?? ''
  // 标题里附带的繁体书名 (<span>) 不要
  const title = bookName(inline(h1.replace(/<span\b[\s\S]*?<\/span>/gi, ''))) || breadcrumb[breadcrumb.length - 1] || ''
  const byline = inline(/<\/h1>\s*<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(main)?.[1] ?? '')
  const article = unwrapCharLinks(/<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(main)?.[1] ?? '')
  const sections = [...article.matchAll(/<section\b[^>]*\bid="ch-\d+"[^>]*>([\s\S]*?)<\/section>/gi)].map(m => m[1]!)
  const chapters: WendianChapter[] = []
  for (const section of sections.length ? sections : [article]) {
    const heading = /<h[2-4]\b[^>]*>([\s\S]*?)<\/h[2-4]>/i.exec(section)
    const body = heading ? section.replace(heading[0], '') : section
    // 中医古籍每节正文前有个「属性：」字段名
    const paragraphs = paragraphsOf(body).map((p, i) => i === 0 ? p.replace(/^属性[：:]\s*/, '') : p).filter(Boolean)
    if (paragraphs.length) chapters.push({ title: heading ? inline(heading[1]!) : '', paragraphs })
  }
  return { title, byline, breadcrumb, chapters }
}

export interface WendianBookPage {
  title: string
  author: string
  /** 各章 detail id, 按目录顺序 */
  ids: number[]
}

/** book.php (四书五经 / 蒙学的目录页) */
export function parseWendianBookPage(html: string, section: 'classics' | 'mengxue'): WendianBookPage {
  const main = /<main\b[\s\S]*?<\/main>/i.exec(html)?.[0] ?? html
  const title = bookName(inline(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(main)?.[1] ?? ''))
  const author = inline(/作者[：:]?\s*<strong\b[^>]*>([\s\S]*?)<\/strong>/i.exec(main)?.[1] ?? '')
  // 目录之后是「同分类其他书」(book.php 链接), 只取 detail 链接; 「开始阅读」与目录第一项重复
  const ids: number[] = []
  const re = new RegExp(`href="(?:\\.\\./${section}/)?detail\\.php\\?id=(\\d+)"`, 'g')
  for (const m of main.matchAll(re)) {
    const id = Number(m[1])
    if (id > 0 && !ids.includes(id)) ids.push(id)
  }
  return { title, author, ids }
}

const NUM = '[一二三四五六七八九十百千〇零两]+'
const VOLUME_RE = new RegExp(`^([\\p{Script=Han}·]{0,24}?)卷(?:之|第)?(${NUM}|[上中下首末])(?:之?[上中下])?(?=$|[\\s\\u3000])`, 'u')

/** 卷次标题行 (「周易义海撮要卷一　宋　李衡　撰」); 返回同卷判定用的键 */
function volumeKey(line: string): string | null {
  if (Array.from(line).length > 40 || /[。，；！？,<>\\]/.test(line)) return null
  const m = VOLUME_RE.exec(line)
  return m ? compactKey(m[0]) : null
}

const CHAPTER_LIMIT = 40_000

/** 整本只有一节时, 按「卷一 / 卷二」分章; 每章过长再按段切开, 免得一章几十万字 */
export function splitChapters(chapters: WendianChapter[], bookTitle: string): WendianChapter[] {
  let result = chapters.length === 1 && !chapters[0]!.title ? [{ ...chapters[0]!, title: bookTitle }] : chapters
  if (chapters.length === 1) {
    const out: WendianChapter[] = []
    let current: WendianChapter = { title: chapters[0]!.title || bookTitle, paragraphs: [] }
    let currentKey = ''
    let headings = 0
    for (const paragraph of chapters[0]!.paragraphs) {
      const key = volumeKey(paragraph)
      // 卷末的「某某卷一」与卷首同名, 属于本卷
      if (key && key !== currentKey) {
        headings++
        if (current.paragraphs.length) out.push(current)
        current = { title: VOLUME_RE.exec(paragraph)![0], paragraphs: [paragraph] }
        currentKey = key
      } else {
        current.paragraphs.push(paragraph)
      }
    }
    if (current.paragraphs.length) out.push(current)
    if (headings >= 2) result = out
  }
  return result.flatMap(chapter => {
    const size = chapter.paragraphs.reduce((n, p) => n + p.length, 0)
    if (size <= CHAPTER_LIMIT) return [chapter]
    const parts: WendianChapter[] = []
    let current: string[] = []
    let length = 0
    for (const paragraph of chapter.paragraphs) {
      if (length && length + paragraph.length > CHAPTER_LIMIT) {
        parts.push({ title: '', paragraphs: current })
        current = []
        length = 0
      }
      current.push(paragraph)
      length += paragraph.length
    }
    if (current.length) parts.push({ title: '', paragraphs: current })
    return parts.map((part, i) => ({ ...part, title: `${chapter.title}（${i + 1}）` }))
  })
}

export interface WendianBook {
  title: string
  author: string
  category: string
  url: string
  chapters: WendianChapter[]
}

export interface WendianFetchProgress {
  done: number
  total: number
}

/**
 * 取回一本书 (fetchText 由调用方注入: 桌面 / 安卓原生请求, 网页版经书源代理)。
 * 四书五经 / 蒙学按目录逐章请求, 同时最多 2 个。
 */
export async function fetchWendianBook(
  work: Pick<WendianWork, 'title' | 'author' | 'category' | 'section' | 'url'>,
  fetchText: (url: string) => Promise<string>,
  onProgress?: (progress: WendianFetchProgress) => void,
  signal?: AbortSignal,
): Promise<WendianBook> {
  const meta = { title: work.title, author: work.author, category: work.category, url: work.url }
  if (work.section === 'ancient' || work.section === 'tcm') {
    onProgress?.({ done: 0, total: 1 })
    const page = parseWendianDetail(await fetchText(work.url))
    onProgress?.({ done: 1, total: 1 })
    if (!page.chapters.length) throw new Error('empty')
    return { ...meta, title: work.title || page.title, chapters: splitChapters(page.chapters, work.title || page.title) }
  }
  const book = parseWendianBookPage(await fetchText(work.url), work.section)
  if (!book.ids.length) throw new Error('empty')
  const base = new URL(work.url)
  const chapters: WendianChapter[][] = new Array(book.ids.length)
  let next = 0
  let done = 0
  onProgress?.({ done, total: book.ids.length })
  const worker = async () => {
    while (next < book.ids.length) {
      if (signal?.aborted) throw new Error('aborted')
      const i = next++
      const page = parseWendianDetail(await fetchText(new URL(`detail.php?id=${book.ids[i]}`, base).href))
      chapters[i] = page.chapters.map((chapter, k) => ({
        title: chapter.title || (k === 0 ? page.title : `${page.title}（${k + 1}）`),
        paragraphs: chapter.paragraphs,
      }))
      onProgress?.({ done: ++done, total: book.ids.length })
    }
  }
  await Promise.all([worker(), worker()])
  const flat = chapters.flat().filter(chapter => chapter.paragraphs.length)
  if (!flat.length) throw new Error('empty')
  return { ...meta, title: work.title || book.title, author: work.author || book.author, chapters: flat }
}

// ---------------------------------------------------------------- EPUB

const CSS = `body { line-height: 1.8; }
h1, h2 { line-height: 1.4; font-weight: bold; }
h1 { font-size: 1.5em; margin: 1em 0 0.6em; }
h2 { font-size: 1.25em; margin: 0.6em 0 1em; }
p { margin: 0 0 0.6em; text-indent: 2em; }
p.verse { text-indent: 0; margin: 0 0 0.2em; }
.titlepage { text-align: center; margin-top: 20%; }
.titlepage p { text-indent: 0; }
.note { font-size: 0.85em; margin-top: 3em; }
.note p { text-indent: 0; }
`

function xhtml(title: string, body: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh" xml:lang="zh">
<head>
  <meta charset="utf-8"/>
  <title>${escapeXml(title)}</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
${body}
</body>
</html>
`
}

/** 诗词 / 蒙学 (每行很短) 不缩进 */
const isVerse = (chapter: WendianChapter) =>
  chapter.paragraphs.length >= 4 && chapter.paragraphs.reduce((n, p) => n + Array.from(p).length, 0) / chapter.paragraphs.length <= 16

export interface WendianEpubOptions {
  /** 扉页上的来源说明 (每项一行, 由调用方按界面语言给出) */
  note: string[]
  /** 目录标题 */
  tocTitle: string
  /** 无标题章节的兜底名 */
  untitled?: string
  /** dcterms:modified 用的时间 (测试固定) */
  now?: Date
}

/** 打包成 EPUB 3 (含 NCX), 返回 zip 字节 */
export async function buildWendianEpub(book: WendianBook, options: WendianEpubOptions): Promise<Uint8Array> {
  const modified = (options.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const identifier = `urn:lightread:wendian:${book.url}`
  const entries: EpubEntry[] = [{ path: 'META-INF/container.xml', data: buildContainerXml() }]
  const manifest: ManifestItem[] = [
    { id: 'nav', href: 'nav.xhtml', mediaType: 'application/xhtml+xml', properties: 'nav' },
    { id: 'ncx', href: 'toc.ncx', mediaType: 'application/x-dtbncx+xml' },
    { id: 'css', href: 'style.css', mediaType: 'text/css' },
    { id: 'title', href: 'title.xhtml', mediaType: 'application/xhtml+xml' },
  ]
  const spine = [{ idref: 'title' }]
  const toc: TocNode[] = []
  const titlePage = `<section class="titlepage" epub:type="titlepage">
  <h1>${escapeXml(book.title)}</h1>
  ${book.author ? `<p>${escapeXml(book.author)}</p>` : ''}
  ${book.category ? `<p>${escapeXml(book.category)}</p>` : ''}
  <div class="note">
    ${options.note.map(line => `<p>${escapeXml(line)}</p>`).join('\n    ')}
  </div>
</section>`
  entries.push({ path: 'OEBPS/title.xhtml', data: xhtml(book.title, titlePage) })
  book.chapters.forEach((chapter, i) => {
    const name = `c${String(i + 1).padStart(4, '0')}.xhtml`
    const title = chapter.title || options.untitled || `${i + 1}`
    const cls = isVerse(chapter) ? ' class="verse"' : ''
    // 分卷出来的第一段就是卷题本身, 不再重复
    const paragraphs = chapter.paragraphs[0] === chapter.title ? chapter.paragraphs.slice(1) : chapter.paragraphs
    const body = `<section epub:type="chapter" id="c${i + 1}">
<h2>${escapeXml(title)}</h2>
${paragraphs.map(p => `<p${cls}>${escapeXml(p)}</p>`).join('\n')}
</section>`
    entries.push({ path: `OEBPS/${name}`, data: xhtml(title, body) })
    manifest.push({ id: `c${i + 1}`, href: name, mediaType: 'application/xhtml+xml' })
    spine.push({ idref: `c${i + 1}` })
    toc.push({ label: title, href: name })
  })
  entries.push({ path: 'OEBPS/style.css', data: CSS })
  entries.push({ path: 'OEBPS/nav.xhtml', data: buildNav(toc, { title: book.title, language: 'zh', tocTitle: options.tocTitle }) })
  entries.push({ path: 'OEBPS/toc.ncx', data: buildNcx(toc, { identifier, title: book.title }) })
  entries.push({
    path: 'OEBPS/content.opf',
    data: buildOpf({
      metadata: {
        identifier,
        title: book.title,
        authors: book.author ? [book.author] : [],
        language: 'zh',
        publisher: '研辞问典',
        description: [book.category, book.url].filter(Boolean).join(' · '),
        subjects: book.category ? book.category.split(' · ') : [],
        modified,
      },
      manifest,
      spine,
      ncxId: 'ncx',
    }),
  })
  return zipEpub(entries)
}
