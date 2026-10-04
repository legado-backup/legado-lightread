/** Public Internet Archive books; file links are resolved only when a reader opens a result. */
import type { OpdsPublication } from './opds'

export interface ArchiveBook {
  identifier: string
  title: string
  author: string
  url: string
  year?: string
}

type JsonRecord = Record<string, unknown>
const ORIGIN = 'https://archive.org'

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
}

function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(', ')
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
}

function flagged(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(flagged)
  return value != null && !['', 'false', '0', 'no'].includes(String(value).trim().toLowerCase())
}

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,511}$/.test(value)
}

function requireIdentifier(identifier: string): string {
  if (!validIdentifier(identifier)) throw new Error('Invalid Internet Archive identifier')
  return encodeURIComponent(identifier)
}

export function buildArchiveSearchUrl(query: string, limit = 24): string {
  // Quote each word to keep OR/AND and escaped Lucene syntax inside the user clause.
  const terms = query.trim().split(/\s+/).filter(Boolean)
    .map(term => `"${term.replace(/[+\-!(){}\[\]^"~*?:\\/&|]/g, '\\$&')}"`)
  const params = new URLSearchParams({
    q: `(${terms.join(' AND ') || '""'}) AND mediatype:texts AND NOT access-restricted-item:true AND NOT collection:printdisabled AND (format:EPUB OR format:"Text PDF" OR format:PDF OR format:Text OR format:DjVuTXT)`,
    output: 'json',
    rows: String(Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.floor(limit))) : 24),
  })
  for (const field of ['identifier', 'title', 'creator', 'year', 'access-restricted-item']) {
    params.append('fl[]', field)
  }
  return `${ORIGIN}/advancedsearch.php?${params}`
}

export function parseArchiveSearch(data: unknown): ArchiveBook[] {
  const docs = record(record(data).response).docs
  if (!Array.isArray(docs)) throw new Error('Invalid Internet Archive search response')
  const seen = new Set<string>()
  return docs.flatMap(value => {
    const doc = record(value)
    if (!validIdentifier(doc.identifier) || flagged(doc['access-restricted-item']) || seen.has(doc.identifier)) return []
    seen.add(doc.identifier)
    return [{
      identifier: doc.identifier,
      title: text(doc.title) || doc.identifier,
      author: text(doc.creator),
      url: `${ORIGIN}/details/${encodeURIComponent(doc.identifier)}`,
      year: text(doc.year) || undefined,
    }]
  })
}

export function parseArchivePublication(book: ArchiveBook, data: unknown): OpdsPublication {
  const identifier = requireIdentifier(book.identifier)
  const item = record(data)
  const metadata = record(item.metadata)
  if (item.error || !Array.isArray(item.files) || !Object.keys(metadata).length) {
    throw new Error('Internet Archive item is unavailable')
  }
  if (flagged(item.is_dark) || flagged(item['access-restricted-item']) || flagged(metadata['access-restricted-item'])) {
    throw new Error('This Internet Archive item requires authorization')
  }
  const formats = [
    { label: 'EPUB', extension: /\.epub$/i, type: 'application/epub+zip' },
    { label: 'PDF', extension: /\.pdf$/i, type: 'application/pdf' },
    { label: 'TXT', extension: /\.txt$/i, type: 'text/plain' },
  ]
  const files = item.files.map(record).filter(file => {
    if (typeof file.name !== 'string' || !file.name || /[\\\x00-\x1f\x7f]/.test(file.name)) return false
    if (file.name.split('/').some(part => !part || part === '.' || part === '..')) return false
    if (flagged(file.private) || flagged(file.restricted) || flagged(file['access-restricted-item']) || flagged(file.encrypted)) return false
    if (/encrypted|\bdrm\b|\bacs(?:\b|\d)/i.test(`${file.format ?? ''} ${file.name}`)) return false
    return file.source !== 'metadata' && !/metadata/i.test(text(file.format))
  })
  const acquisitions = formats.flatMap(format => {
    const file = files.find(candidate => format.extension.test(String(candidate.name)))
    if (!file) return []
    const path = String(file.name).split('/').map(encodeURIComponent).join('/')
    return [{ href: `${ORIGIN}/download/${identifier}/${path}`, type: format.type, label: format.label }]
  })
  return {
    title: text(metadata.title) || book.title,
    author: text(metadata.creator) || book.author,
    summary: text(metadata.description).replace(/<[^>]*>/g, '').slice(0, 400) || undefined,
    coverUrl: `${ORIGIN}/services/img/${identifier}`,
    acquisitions,
  }
}

async function fetchArchiveJson(url: string): Promise<unknown> {
  const { fetchRemote } = await import('./net')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const response = await fetchRemote(url, undefined, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

export async function searchInternetArchive(query: string, limit = 24): Promise<ArchiveBook[]> {
  if (!query.trim()) return []
  return parseArchiveSearch(await fetchArchiveJson(buildArchiveSearchUrl(query, limit)))
}

export async function loadArchivePublication(book: ArchiveBook): Promise<OpdsPublication> {
  const identifier = requireIdentifier(book.identifier)
  return parseArchivePublication(book, await fetchArchiveJson(`${ORIGIN}/metadata/${identifier}`))
}
