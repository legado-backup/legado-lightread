import type { OpdsPublication } from './opds'

export interface WikisourceBook {
  id: string
  title: string
  summary?: string
  url: string
  publication: OpdsPublication
}

type RemoteFetcher = typeof import('./net').fetchRemote

function resultLimit(limit: number): number {
  return Number.isFinite(limit) ? Math.max(1, Math.min(40, Math.floor(limit))) : 20
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function snippetText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
  const text = value.replace(/<[^>]*>/g, '').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity: string) => {
    if (!entity.startsWith('#')) return entities[entity.toLowerCase()] ?? match
    const code = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1))
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
      ? String.fromCodePoint(code) : match
  }).replace(/\s+/g, ' ').trim().slice(0, 400)
  return text || undefined
}

/** 官方 WS Export 的同步 EPUB 导出；Web 跨域导入可使用现有 CORS 代理。 */
export function wikisourceEpubUrl(title: string): string {
  const url = new URL('https://ws-export.wmcloud.org/')
  url.search = new URLSearchParams({ lang: 'zh', page: title, format: 'epub-3' }).toString()
  return url.toString()
}

export function parseWikisourceResults(payload: unknown, limit = 20): WikisourceBook[] {
  const root = asRecord(payload)
  const error = asRecord(root?.error)
  if (error) {
    throw new Error(`维基文库搜索失败：${typeof error.info === 'string' ? error.info : 'API 返回错误'}`)
  }
  const results = asRecord(root?.query)?.search
  if (!Array.isArray(results)) throw new Error('维基文库返回了无效的搜索结果')
  const books: WikisourceBook[] = []
  const seen = new Set<number>()
  const boundedLimit = resultLimit(limit)
  for (const value of results) {
    const doc = asRecord(value)
    if (!doc || doc.ns !== 0 || typeof doc.pageid !== 'number' || !Number.isSafeInteger(doc.pageid) || doc.pageid <= 0) continue
    const title = typeof doc.title === 'string' ? doc.title.trim() : ''
    if (!title || /[\u0000-\u001f\u007f]/u.test(title) || seen.has(doc.pageid)) continue
    seen.add(doc.pageid)
    const summary = snippetText(doc.snippet)
    books.push({
      id: String(doc.pageid),
      title,
      ...(summary ? { summary } : {}),
      url: `https://zh.wikisource.org/w/index.php?curid=${doc.pageid}`,
      publication: {
        title,
        // 搜索接口没有作者字段，不把站点名误记为原作者。
        author: '',
        ...(summary ? { summary } : {}),
        acquisitions: [{ href: wikisourceEpubUrl(title), type: 'application/epub+zip', label: 'EPUB' }],
      },
    })
    if (books.length >= boundedLimit) break
  }
  return books
}

export async function searchWikisource(query: string, limit = 20, fetcher?: RemoteFetcher): Promise<WikisourceBook[]> {
  const trimmed = query.trim()
  if (!trimmed) return []
  const boundedLimit = resultLimit(limit)
  const url = new URL('https://zh.wikisource.org/w/api.php')
  url.search = new URLSearchParams({
    action: 'query', list: 'search', srsearch: trimmed, srnamespace: '0',
    srprop: 'snippet', srlimit: String(boundedLimit), format: 'json', origin: '*',
  }).toString()
  const remoteFetch = fetcher ?? (await import('./net')).fetchRemote
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)
  try {
    const response = await remoteFetch(url.toString(), undefined, {
      headers: { accept: 'application/json' }, signal: controller.signal,
    })
    return parseWikisourceResults(await response.json(), boundedLimit)
  } finally {
    clearTimeout(timeout)
  }
}
