/** Open Library 搜索目录；链接指向官方书目页，由站点提供阅读或借阅入口。 */
import { compactKey, titleRelevance } from './bookQuery.ts'

export interface OpenLibraryBook {
  key: string
  title: string
  author: string
  url: string
  year?: number
  access: 'public' | 'borrowable' | 'printdisabled' | 'no_ebook' | 'unknown'
}

type RemoteFetcher = typeof import('./net').fetchRemote

const SEARCH_FIELDS = 'key,title,author_name,first_publish_year,ebook_access'

function resultLimit(limit: number): number {
  return Number.isFinite(limit) ? Math.max(1, Math.min(40, Math.floor(limit))) : 24
}

/** 仅接受官方书目 ID，不信任响应中的任意 URL。 */
export function openLibraryBookUrl(key: unknown): string | undefined {
  if (typeof key !== 'string') return undefined
  if (/^\/works\/OL\d+W$/.test(key) || /^\/books\/OL\d+M$/.test(key)) {
    return `https://openlibrary.org${key}`
  }
  if (/^OL\d+W$/.test(key)) return `https://openlibrary.org/works/${key}`
  if (/^OL\d+M$/.test(key)) return `https://openlibrary.org/books/${key}`
  return undefined
}

export function parseOpenLibraryResults(payload: unknown, limit = 24): OpenLibraryBook[] {
  if (!payload || typeof payload !== 'object' || !('docs' in payload) || !Array.isArray(payload.docs)) {
    throw new Error('Open Library 返回了无效的搜索结果')
  }
  const books: OpenLibraryBook[] = []
  const seen = new Set<string>()
  for (const doc of payload.docs) {
    if (!doc || typeof doc !== 'object') continue
    const url = openLibraryBookUrl(doc.key)
    const title = typeof doc.title === 'string' ? doc.title.trim() : ''
    if (!url || !title || seen.has(url)) continue
    seen.add(url)
    const access: OpenLibraryBook['access'] = ['public', 'borrowable', 'printdisabled', 'no_ebook'].includes(doc.ebook_access)
      ? doc.ebook_access : 'unknown'
    const year = typeof doc.first_publish_year === 'number' && Number.isInteger(doc.first_publish_year)
      ? doc.first_publish_year : undefined
    const author = Array.isArray(doc.author_name)
      ? doc.author_name.filter((name: unknown): name is string => typeof name === 'string')
        .map((name: string) => name.trim()).filter(Boolean).join('、')
      : ''
    books.push({
      key: new URL(url).pathname,
      title,
      author,
      url,
      ...(year !== undefined ? { year } : {}),
      access,
    })
    if (books.length >= resultLimit(limit)) break
  }
  return books
}

const ACCESS_ORDER: Record<OpenLibraryBook['access'], number> = {
  public: 0, borrowable: 1, unknown: 2, printdisabled: 3, no_ebook: 4,
}

/**
 * 书名对得上的排前面, 其次能读的排前面 (公开阅读 > 可借阅 > 其余);
 * 同级保持站点的相关度顺序。
 */
export function sortByAccess(books: OpenLibraryBook[], query = ''): OpenLibraryBook[] {
  const offTopic = (book: OpenLibraryBook) => query && titleRelevance(book.title, query) === 0 ? 1 : 0
  return books.map((book, index) => ({ book, index, offTopic: offTopic(book) }))
    .sort((a, b) => a.offTopic - b.offTopic || ACCESS_ORDER[a.book.access] - ACCESS_ORDER[b.book.access] || a.index - b.index)
    .map(entry => entry.book)
}

export async function searchOpenLibrary(
  query: string,
  limit = 24,
  fetcher?: RemoteFetcher,
): Promise<OpenLibraryBook[]> {
  const trimmed = query.trim()
  if (!trimmed) return []
  const boundedLimit = resultLimit(limit)
  const url = new URL('https://openlibrary.org/search.json')
  // q 少于 3 个字符会被拒绝 (422)，「活着」「三体」这类短书名改按书名字段搜索
  const field = compactKey(trimmed).length < 3 ? 'title' : 'q'
  url.search = new URLSearchParams({ [field]: trimmed, fields: SEARCH_FIELDS, limit: String(boundedLimit) }).toString()
  const remoteFetch = fetcher ?? (await import('./net')).fetchRemote
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)
  try {
    const response = await remoteFetch(url.toString(), undefined, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    return sortByAccess(parseOpenLibraryResults(await response.json(), boundedLimit), trimmed)
  } finally {
    clearTimeout(timeout)
  }
}
