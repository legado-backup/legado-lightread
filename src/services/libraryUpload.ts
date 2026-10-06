/** Explicit, same-origin private-library upload protocol. Never uses a CORS relay. */
import type { BookFormat, CatalogSourceRec, LocalFileRef } from '../storage/types'
import { isLocalFileRef, isTauri } from '../storage/types.ts'
import { detectFormat } from './format.ts'

export const LIBRARY_REL = 'https://lightread.app/rel/library'
export const UPLOAD_REL = 'https://lightread.app/rel/upload'
export const UPLOAD_FORMATS = ['epub', 'pdf', 'azw', 'azw3', 'mobi'] as const
const MIMES: Record<string, string> = {
  epub: 'application/epub+zip', pdf: 'application/pdf', azw: 'application/vnd.amazon.ebook',
  azw3: 'application/x-mobi8-ebook', mobi: 'application/x-mobipocket-ebook',
}
export interface LibraryUploadCapability {
  version: 1
  uploadUrl: string
  formats: BookFormat[]
  maxFileBytes: number
}
export interface LibraryUploadInput {
  fileName: string
  title?: string
  author?: string
  body: Blob | LocalFileRef
}
export interface LibraryUploadResult { bookId: string; title: string; format: string; duplicate: boolean }
export class LibraryUploadError extends Error {
  readonly key: string
  readonly params: Record<string, string | number>
  constructor(key: string, params: Record<string, string | number> = {}) {
    super(key)
    this.key = key
    this.params = params
  }
}
export interface UploadRequest {
  method: 'GET' | 'POST'
  headers: Record<string, string>
  body?: Blob | LocalFileRef
}
export type UploadTransport = (url: string, request: UploadRequest) => Promise<{ status: number; text(): Promise<string> }>
export interface UploadDependencies {
  request?: UploadTransport
  links?: (xml: string) => Array<{ rel: string; href: string }>
}

export function sameOriginLibraryUrl(href: string, sourceUrl: string): string {
  try {
    const source = new URL(sourceUrl)
    const url = new URL(href, source)
    if (!['http:', 'https:'].includes(source.protocol) || url.origin !== source.origin ||
      url.username || url.password || source.username || source.password) throw new Error()
    url.hash = ''
    return url.href
  } catch { throw new LibraryUploadError('upload.unsafeUrl') }
}
function headersFor(source: CatalogSourceRec): Record<string, string> {
  if (!source.username) return {}
  const raw = new TextEncoder().encode(`${source.username}:${source.password ?? ''}`)
  return { authorization: `Basic ${btoa(Array.from(raw, x => String.fromCharCode(x)).join(''))}` }
}
async function transport(url: string, req: UploadRequest) {
  if (isTauri()) {
    if (req.method === 'POST' && req.body) {
      const { nativeUpload } = await import('./nativeUpload.ts')
      const result = await nativeUpload(url, { ...req, body: req.body, redirect: 'error' })
      return { status: result.status, text: async () => result.body }
    }
    const [{ fetch: nativeFetch }, { useSettings }] = await Promise.all([
      import('@tauri-apps/plugin-http'), import('../stores/settings'),
    ])
    const proxy = useSettings().httpProxy.trim()
    return nativeFetch(url, {
      method: 'GET', headers: req.headers, maxRedirections: 0, connectTimeout: 30_000,
      signal: AbortSignal.timeout(30_000), ...(proxy ? { proxy: { all: proxy } } : {}),
    })
  }
  return fetch(url, {
    method: req.method, headers: req.headers, redirect: 'error', credentials: 'omit',
    body: isLocalFileRef(req.body) ? await req.body.blob() : req.body,
    signal: AbortSignal.timeout(req.method === 'POST' ? 30 * 60_000 : 30_000),
  })
}
function parseLinks(xml: string) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.querySelector('parsererror') || doc.documentElement.localName !== 'feed') {
    throw new LibraryUploadError('upload.unsupportedServer')
  }
  return Array.from(doc.documentElement.children)
    .filter(el => el.localName === 'link')
    .map(el => ({ rel: el.getAttribute('rel') ?? '', href: el.getAttribute('href') ?? '' }))
}
async function checked(response: Awaited<ReturnType<UploadTransport>>) {
  if (response.status === 401 || response.status === 403) throw new LibraryUploadError('upload.denied')
  if (response.status === 413) throw new LibraryUploadError('upload.tooLargeServer')
  if (response.status < 200 || response.status >= 300) {
    throw new LibraryUploadError('upload.httpError', { status: response.status })
  }
  return response.text()
}
function json(text: string): any {
  try { return JSON.parse(text) } catch { throw new LibraryUploadError('upload.invalidResponse') }
}
export function parseLibraryCapability(value: unknown, sourceUrl: string): LibraryUploadCapability {
  const data = value as Partial<LibraryUploadCapability> | null
  if (!data || data.version !== 1 || typeof data.uploadUrl !== 'string' || !data.uploadUrl.trim() ||
    !Array.isArray(data.formats) || typeof data.maxFileBytes !== 'number' ||
    !Number.isSafeInteger(data.maxFileBytes) || data.maxFileBytes <= 0) {
    throw new LibraryUploadError('upload.unsupportedServer')
  }
  const formats = data.formats.filter((f): f is BookFormat => UPLOAD_FORMATS.includes(f as any))
  if (!formats.length) throw new LibraryUploadError('upload.unsupportedServer')
  return { version: 1, uploadUrl: sameOriginLibraryUrl(data.uploadUrl, sourceUrl), formats, maxFileBytes: data.maxFileBytes }
}
export async function discoverLibraryUpload(source: CatalogSourceRec, deps: UploadDependencies = {}): Promise<LibraryUploadCapability> {
  if (source.builtin || source.kind !== 'opds') throw new LibraryUploadError('upload.unsupportedServer')
  const request = deps.request ?? transport
  const root = sameOriginLibraryUrl(source.url, source.url)
  const auth = headersFor(source)
  const xml = await checked(await request(root, { method: 'GET', headers: { ...auth, accept: 'application/atom+xml' } }))
  const links = (deps.links ?? parseLinks)(xml)
  const find = (rel: string) => links.find(link => link.rel.split(/\s+/).includes(rel) && link.href)?.href
  const library = find(LIBRARY_REL)
  if (!library) throw new LibraryUploadError('upload.unsupportedServer')
  const capabilityUrl = sameOriginLibraryUrl(library, root)
  const advertisedUpload = find(UPLOAD_REL)
  if (advertisedUpload) sameOriginLibraryUrl(advertisedUpload, root)
  const data = json(await checked(await request(capabilityUrl, { method: 'GET', headers: { ...auth, accept: 'application/json' } })))
  const capability = parseLibraryCapability(data, root)
  if (advertisedUpload && sameOriginLibraryUrl(advertisedUpload, root) !== capability.uploadUrl) {
    throw new LibraryUploadError('upload.invalidResponse')
  }
  return capability
}
export async function uploadLibraryBook(
  source: CatalogSourceRec, capability: LibraryUploadCapability, input: LibraryUploadInput,
  request: UploadTransport = transport,
): Promise<LibraryUploadResult> {
  if (source.builtin || source.kind !== 'opds') throw new LibraryUploadError('upload.unsupportedServer')
  const url = sameOriginLibraryUrl(capability.uploadUrl, source.url)
  const format = detectFormat(input.fileName)
  if (!format || !capability.formats.includes(format) || !MIMES[format]) throw new LibraryUploadError('upload.unsupportedFormat')
  if (!isLocalFileRef(input.body) && input.body.size > capability.maxFileBytes) {
    throw new LibraryUploadError('upload.tooLarge', { mb: Math.floor(capability.maxFileBytes / 1048576) })
  }
  if (!isLocalFileRef(input.body) && !input.body.size) throw new LibraryUploadError('upload.emptyFile')
  const headers: Record<string, string> = {
    ...headersFor(source), 'content-type': MIMES[format], accept: 'application/json',
    'x-file-name': encodeURIComponent(input.fileName),
  }
  if (input.title) headers['x-book-title'] = encodeURIComponent(input.title)
  if (input.author) headers['x-book-author'] = encodeURIComponent(input.author)
  const result = json(await checked(await request(url, { method: 'POST', headers, body: input.body })))
  if (!result || typeof result.bookId !== 'string' || !result.bookId || typeof result.title !== 'string' ||
    typeof result.format !== 'string' || typeof result.duplicate !== 'boolean') throw new LibraryUploadError('upload.invalidResponse')
  return result
}
