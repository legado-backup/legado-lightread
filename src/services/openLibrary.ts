/** Open Library 搜索目录；链接指向官方书目页，由站点提供阅读或借阅入口。 */
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

export async function searchOpenLibrary(
  query: string,
  limit = 24,
  fetcher?: RemoteFetcher,
): Promise<OpenLibraryBook[]> {
  const trimmed = query.trim()
  if (!trimmed) return []
  const boundedLimit = resultLimit(limit)
  const url = new URL('https://openlibrary.org/search.json')
  url.search = new URLSearchParams({ q: trimmed, fields: SEARCH_FIELDS, limit: String(boundedLimit) }).toString()
  const remoteFetch = fetcher ?? (await import('./net')).fetchRemote
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)
  try {
    const response = await remoteFetch(url.toString(), undefined, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    return parseOpenLibraryResults(await response.json(), boundedLimit)
  } finally {
    clearTimeout(timeout)
  }
}
