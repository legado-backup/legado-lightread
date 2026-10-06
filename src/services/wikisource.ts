import type { OpdsPublication } from './opds'
import { compactKey, normalizeBookQuery } from './bookQuery.ts'

export interface WikisourceBook {
  id: string
  title: string
  summary?: string
  url: string
  /** 3 书名完全一致 / 2 书名以查询开头 / 1 书名包含查询 / 0 只有某一章节标题命中 */
  relevance: number
  /** 消歧义页 (多个版本的列表), 导出 EPUB 没有意义, 只提供原站链接 */
  disambiguation?: boolean
  publication: OpdsPublication
}

/** 搜索接口里的一条原始命中 (已校验) */
export interface WikisourceHit {
  pageid: number
  title: string
  /** 带 <span class="searchmatch"> 高亮的标题; 缺失时按字面匹配 */
  titlesnippet?: string
  snippet?: string
}

type RemoteFetcher = typeof import('./net').fetchRemote

/** 一次搜索取的候选数: 正文命中 (判决书等) 会挤占前排, 多取一些再按书名筛 */
const CANDIDATES = 50

function resultLimit(limit: number): number {
  return Number.isFinite(limit) ? Math.max(1, Math.min(40, Math.floor(limit))) : 20
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function decodeEntities(value: string): string {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity: string) => {
    if (!entity.startsWith('#')) return entities[entity.toLowerCase()] ?? match
    const code = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1))
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
      ? String.fromCodePoint(code) : match
  })
}

function snippetText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = decodeEntities(value.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim().slice(0, 400)
  return text || undefined
}

/** 官方 WS Export 的同步 EPUB 导出；Web 跨域导入可使用现有 CORS 代理。 */
export function wikisourceEpubUrl(title: string): string {
  const url = new URL('https://ws-export.wmcloud.org/')
  url.search = new URLSearchParams({ lang: 'zh', page: title, format: 'epub-3' }).toString()
  return url.toString()
}

export function wikisourcePageUrl(title: string): string {
  return `https://zh.wikisource.org/wiki/${title.split('/').map(part => encodeURIComponent(part.replace(/ /g, '_'))).join('/')}`
}

/** 校验搜索接口返回, 只留正文名字空间里合法且不重复的页面 */
export function parseWikisourceHits(payload: unknown): WikisourceHit[] {
  const root = asRecord(payload)
  const error = asRecord(root?.error)
  if (error) {
    throw new Error(`维基文库搜索失败：${typeof error.info === 'string' ? error.info : 'API 返回错误'}`)
  }
  const results = asRecord(root?.query)?.search
  if (!Array.isArray(results)) throw new Error('维基文库返回了无效的搜索结果')
  const hits: WikisourceHit[] = []
  const seen = new Set<number>()
  for (const value of results) {
    const doc = asRecord(value)
    if (!doc || doc.ns !== 0 || typeof doc.pageid !== 'number' || !Number.isSafeInteger(doc.pageid) || doc.pageid <= 0) continue
    const title = typeof doc.title === 'string' ? doc.title.trim() : ''
    if (!title || /[\u0000-\u001f\u007f]/u.test(title) || seen.has(doc.pageid)) continue
    seen.add(doc.pageid)
    hits.push({
      pageid: doc.pageid,
      title,
      ...(typeof doc.titlesnippet === 'string' ? { titlesnippet: doc.titlesnippet } : {}),
      ...(typeof doc.snippet === 'string' ? { snippet: doc.snippet } : {}),
    })
  }
  return hits
}

/**
 * 公文与裁判文书: 维基文库收录了大量判决书、通知、条例, 全文搜索书名时它们会因为正文
 * 「提到」这本书而排在前面。这些不是可读的书, 按标题直接排除。
 */
const NON_BOOK_TITLE = new RegExp([
  '(判[决決]|裁定|[调調]解|[决決]定|起[诉訴]|公[诉訴]|仲裁|[执執]行)[书書]',
  '[纠糾][纷紛]', '人民法院', '人民[检檢]察院', '[刑民]事', '行政[处處]罚',
  '(通知|通告|公告|批[复覆]|[复復]函|意[见見]|条例|條例|[办辦]法|[规規]定|[细細]则|方案|公[报報]|[决決][议議]|命令|[讲講]话|致辞|[贺賀][电電]|[唁][电電]|答[记記]者[问問])$',
].join('|'))

/** 分类: 判决书、法律法规等 (「公有领域」分类同样用于版权过期的文学作品, 不能据此排除) */
const NON_BOOK_CATEGORY = /(判[决決]|裁定|[调調]解)[书書]|法律法[规規]|行政法[规規]|部[门門][规規]章|[规規][范範]性文件|政府公[报報]|政府工作[报報]告/

/** 去掉末尾的「 (四庫全書本)」「（程甲本）」等版本括注 */
function stripEdition(title: string): string {
  return title.replace(/\s*[(（][^()（）]*[)）]\s*$/, '').trim() || title
}

function isNonBookTitle(title: string): boolean {
  return NON_BOOK_TITLE.test(stripEdition(title.split('/')[0]!)) || /消歧[义義]/.test(title)
}

interface Run { start: number; end: number; text: string }

/** 解析 titlesnippet: 返回纯文本标题与高亮区间 (相邻高亮合并) */
function highlightRuns(snippet: string): { text: string; runs: Run[] } {
  let text = ''
  const runs: Run[] = []
  const pattern = /<span class="searchmatch">([\s\S]*?)<\/span>/g
  let last = 0
  for (let m = pattern.exec(snippet); m; m = pattern.exec(snippet)) {
    text += decodeEntities(snippet.slice(last, m.index).replace(/<[^>]*>/g, ''))
    const piece = decodeEntities(m[1]!.replace(/<[^>]*>/g, ''))
    const prev = runs[runs.length - 1]
    if (prev && prev.end === text.length) {
      prev.end += piece.length
      prev.text += piece
    } else {
      runs.push({ start: text.length, end: text.length + piece.length, text: piece })
    }
    text += piece
    last = pattern.lastIndex
  }
  text += decodeEntities(snippet.slice(last).replace(/<[^>]*>/g, ''))
  return { text, runs }
}

/** 没有 titlesnippet 时按字面找关键词 (不做繁简转换) */
function literalRuns(title: string, query: string): Run[] {
  const lower = title.toLowerCase()
  const runs: Run[] = []
  for (const term of normalizeBookQuery(query).toLowerCase().split(' ').filter(Boolean)) {
    const at = lower.indexOf(term)
    if (at >= 0) runs.push({ start: at, end: at + term.length, text: title.slice(at, at + term.length) })
  }
  return runs.sort((a, b) => a.start - b.start)
}

/** 高亮覆盖了查询的大部分字 (同一词重复命中只算一次; 单字碎片不算, 如「三青体」之于「三体」) */
function covers(runs: Run[], queryLength: number): boolean {
  if (!queryLength) return false
  const distinct = new Set(runs.map(run => compactKey(run.text))
    .filter(key => key.length >= Math.min(2, queryLength)))
  let covered = 0
  for (const key of distinct) covered += key.length
  return covered >= Math.ceil(queryLength * 0.8)
}

function relevanceOf(root: string, runs: Run[], queryLength: number): number {
  const base = stripEdition(root)
  const baseKey = compactKey(base)
  const inBase = runs.filter(run => run.start < base.length)
  const highlighted = inBase.reduce((n, run) => n + compactKey(run.text).length, 0)
  if (baseKey.length && highlighted >= baseKey.length && baseKey.length <= queryLength + 1) return 3
  const first = inBase[0]
  if (first && !compactKey(base.slice(0, first.start)) && compactKey(first.text).length >= Math.min(2, queryLength)) return 2
  return 1
}

/**
 * 把全文搜索命中整理成「书」:
 *  1. 只留书名命中查询的页面 (正文提到不算), 排除判决书、公文、消歧义
 *  2. 章节页 (书名/第一回) 合并到书本身, 导出 EPUB 时得到整本书
 *  3. 书名完全一致 > 以查询开头 > 包含查询 > 只有章节名命中
 */
export function rankWikisourceHits(hits: WikisourceHit[], query: string, limit = 20): WikisourceBook[] {
  const queryLength = compactKey(normalizeBookQuery(query)).length
  const boundedLimit = resultLimit(limit)
  const works = new Map<string, { book: WikisourceBook; order: number }>()
  hits.forEach((hit, order) => {
    if (isNonBookTitle(hit.title)) return
    const parsed = hit.titlesnippet ? highlightRuns(hit.titlesnippet) : undefined
    const runs = parsed && parsed.text.trim() === hit.title
      ? parsed.runs : literalRuns(hit.title, query)
    const slash = hit.title.indexOf('/')
    const root = slash > 0 ? hit.title.slice(0, slash) : hit.title
    const rootRuns = runs.filter(run => run.start < root.length)
    let title: string
    let relevance: number
    if (!queryLength) {
      title = hit.title
      relevance = 1
    } else if (covers(rootRuns, queryLength)) {
      title = root
      relevance = relevanceOf(root, rootRuns, queryLength)
    } else if (slash > 0 && rootRuns.length && covers(runs, queryLength)) {
      // 「论语 学而」→ 論語/學而第一: 书名与章节名一起命中, 保留这一章
      title = hit.title
      relevance = 0
    } else {
      return
    }
    const summary = title === hit.title ? snippetText(hit.snippet) : undefined
    const existing = works.get(title)
    if (existing) {
      if (summary && !existing.book.summary) {
        existing.book.summary = summary
        existing.book.publication.summary = summary
      }
      return
    }
    works.set(title, {
      order,
      book: {
        id: title === hit.title ? String(hit.pageid) : title,
        title,
        ...(summary ? { summary } : {}),
        url: title === hit.title ? `https://zh.wikisource.org/w/index.php?curid=${hit.pageid}` : wikisourcePageUrl(title),
        relevance,
        publication: {
          title,
          // 搜索接口没有作者字段，不把站点名误记为原作者。
          author: '',
          ...(summary ? { summary } : {}),
          acquisitions: [{ href: wikisourceEpubUrl(title), type: 'application/epub+zip', label: 'EPUB' }],
        },
      },
    })
  })
  return [...works.values()]
    .sort((a, b) => b.book.relevance - a.book.relevance || a.order - b.order)
    .slice(0, boundedLimit)
    .map(entry => entry.book)
}

/** 兼容入口: 校验 + 整理 */
export function parseWikisourceResults(payload: unknown, limit = 20, query = ''): WikisourceBook[] {
  return rankWikisourceHits(parseWikisourceHits(payload), query, limit)
}

/**
 * 用页面分类与页面属性复核候选: 去掉判决书、法律法规等官方文件,
 * 消歧义页保留但不提供 EPUB (导出的只是一张版本列表)。
 */
export function applyWikisourcePageInfo(books: WikisourceBook[], payload: unknown): WikisourceBook[] {
  const query = asRecord(asRecord(payload)?.query)
  const pages = query?.pages
  if (!Array.isArray(pages)) return books
  const alias = new Map<string, string>()
  for (const list of [query?.normalized, query?.redirects]) {
    if (!Array.isArray(list)) continue
    for (const item of list) {
      const entry = asRecord(item)
      if (typeof entry?.from === 'string' && typeof entry.to === 'string') alias.set(entry.from, entry.to)
    }
  }
  const info = new Map<string, { exclude: boolean; disambiguation: boolean }>()
  for (const value of pages) {
    const page = asRecord(value)
    if (!page || typeof page.title !== 'string') continue
    const categories = Array.isArray(page.categories)
      ? page.categories.map(c => String(asRecord(c)?.title ?? '').replace(/^[^:]+:/, '')) : []
    info.set(page.title, {
      exclude: categories.some(c => NON_BOOK_CATEGORY.test(c) && !/^PD-/i.test(c)),
      disambiguation: asRecord(page.pageprops)?.disambiguation !== undefined || categories.some(c => /消歧[义義]/.test(c)),
    })
  }
  return books.flatMap(book => {
    let key = book.title
    for (let i = 0; i < 3 && alias.has(key); i++) key = alias.get(key)!
    const page = info.get(key)
    if (page?.exclude) return []
    if (!page?.disambiguation) return [book]
    return [{ ...book, disambiguation: true, publication: { ...book.publication, acquisitions: [] } }]
  })
}

async function fetchJson(remoteFetch: RemoteFetcher, params: Record<string, string>, signal: AbortSignal): Promise<unknown> {
  const url = new URL('https://zh.wikisource.org/w/api.php')
  url.search = new URLSearchParams({ ...params, format: 'json', origin: '*' }).toString()
  const response = await remoteFetch(url.toString(), undefined, { headers: { accept: 'application/json' }, signal })
  return response.json()
}

export async function searchWikisource(query: string, limit = 20, fetcher?: RemoteFetcher): Promise<WikisourceBook[]> {
  const normalized = normalizeBookQuery(query)
  if (!normalized) return []
  const boundedLimit = resultLimit(limit)
  const remoteFetch = fetcher ?? (await import('./net')).fetchRemote
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)
  try {
    const books = parseWikisourceResults(await fetchJson(remoteFetch, {
      action: 'query', list: 'search', srsearch: normalized, srnamespace: '0',
      srprop: 'snippet|titlesnippet', srlimit: String(CANDIDATES),
    }, controller.signal), boundedLimit, normalized)
    if (!books.length) return books
    try {
      return applyWikisourcePageInfo(books, await fetchJson(remoteFetch, {
        action: 'query', prop: 'pageprops|categories', ppprop: 'disambiguation', cllimit: 'max',
        redirects: '1', formatversion: '2', titles: books.map(book => book.title).join('|'),
      }, controller.signal))
    } catch {
      // 复核失败不影响已按书名筛过的结果
      return books
    }
  } finally {
    clearTimeout(timeout)
  }
}
