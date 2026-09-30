/**
 * WebDAV 同步后端. 布局见 docs/sync.md:
 *   <url>/LightRead/sync/v1/devices/<deviceId>.json
 *   <url>/LightRead/sync/v1/files/<hash>[.cover]
 * HTTP 函数可注入 (node 测试用内存假服务器); 默认走 services/net.ts 的 fetchRemote,
 * 按需加载, 使本模块不在顶层依赖 pinia.
 */
import { SYNC_FORMAT } from './types.ts'
import type { SyncDoc, SyncRemote } from './types'

export interface HttpRequest {
  method: string
  headers?: Record<string, string>
  body?: Blob | string
}

/** fetch 的 Response 的子集 */
export interface HttpResponse {
  status: number
  text(): Promise<string>
  blob(): Promise<Blob>
}

export type HttpFn = (url: string, req: HttpRequest) => Promise<HttpResponse>

export type TranslateFn = (key: string, params?: Record<string, string | number>) => string

export interface WebdavConfig {
  url: string
  user: string
  pass: string
}

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>'

function defaultHttp(cfg: WebdavConfig): HttpFn {
  return async (url, req) => {
    const { fetchRemote } = await import('../net.ts')
    return fetchRemote(url, { username: cfg.user, password: cfg.pass }, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      raw: true,
    })
  }
}

async function defaultTranslate(key: string, params?: Record<string, string | number>) {
  const { t } = await import('../../i18n/index.ts')
  return t(key, params)
}

const decodeEntities = (s: string) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&')

/**
 * 从 PROPFIND multistatus 里取出直接子项的文件名 (任意命名空间前缀的 <href>).
 * 跳过集合本身 (末段等于目录名) 与子目录 (以 / 结尾).
 */
export function parsePropfindNames(xml: string, dirName: string): string[] {
  const names: string[] = []
  const re = /<(?:[A-Za-z_][\w.-]*:)?href(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?href\s*>/gi
  for (const m of xml.matchAll(re)) {
    let href = decodeEntities(m[1].trim())
    try { href = decodeURIComponent(href) } catch { /* 非法转义, 按原样用 */ }
    if (href.endsWith('/')) continue
    const name = href.split('?')[0].split('/').pop() ?? ''
    if (!name || name === dirName) continue
    names.push(name)
  }
  return [...new Set(names)]
}

function isSyncDoc(v: unknown): v is SyncDoc {
  if (!v || typeof v !== 'object') return false
  const d = v as Record<string, unknown>
  const isObj = (x: unknown) => !!x && typeof x === 'object' && !Array.isArray(x)
  return d.format === SYNC_FORMAT && typeof d.deviceId === 'string' && !!d.deviceId
    && isObj(d.books) && isObj(d.annotations) && isObj(d.booklists)
    && isObj(d.booklistItems) && isObj(d.sources)
}

/** 有限并发的 map */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

export function createWebdavRemote(
  cfg: WebdavConfig,
  http: HttpFn = defaultHttp(cfg),
  translate?: TranslateFn,
): SyncRemote {
  const base = cfg.url.trim().replace(/\/+$/, '')
  const root = `${base}/LightRead/sync/v1`
  const devicesDir = `${root}/devices/`
  const filesDir = `${root}/files/`
  const tr = async (key: string, params?: Record<string, string | number>) =>
    translate ? translate(key, params) : defaultTranslate(key, params)

  const fail = async (status: number): Promise<never> => {
    throw new Error(status === 401
      ? await tr('sync.err.auth')
      : await tr('sync.err.http', { status }))
  }
  /** 发请求; ≥400 且不在 allow 中时抛错 */
  const request = async (url: string, req: HttpRequest, allow: number[] = []) => {
    const res = await http(url, req)
    if (res.status >= 400 && !allow.includes(res.status)) await fail(res.status)
    return res
  }
  const propfind = (url: string, depth: '0' | '1') => request(url, {
    method: 'PROPFIND',
    headers: { depth, 'content-type': 'application/xml; charset=utf-8' },
    body: PROPFIND_BODY,
  }, [404])
  const list = async (dir: string, dirName: string) => {
    const res = await propfind(dir, '1')
    if (res.status === 404) return []
    return parsePropfindNames(await res.text(), dirName)
  }

  return {
    kind: 'webdav',
    id: `webdav:${base}#${cfg.user}`,
    supportsFiles: true,

    async prepare() {
      const [devices, files] = await Promise.all([propfind(devicesDir, '0'), propfind(filesDir, '0')])
      if (devices.status !== 404 && files.status !== 404) return
      for (const dir of [
        `${base}/LightRead/`, `${base}/LightRead/sync/`, `${root}/`, devicesDir, filesDir,
      ]) {
        // 405: 已存在
        await request(dir, { method: 'MKCOL' }, [405])
      }
    },

    async listDocs() {
      const names = (await list(devicesDir, 'devices')).filter(n => n.endsWith('.json'))
      const docs = await mapLimit(names, 4, async name => {
        const res = await request(devicesDir + encodeURIComponent(name), { method: 'GET' }, [404])
        if (res.status === 404) return null
        try {
          const doc: unknown = JSON.parse(await res.text())
          return isSyncDoc(doc) ? doc : null
        } catch {
          return null // 损坏的文件跳过
        }
      })
      return docs.filter((d): d is SyncDoc => d !== null)
    },

    async putDoc(doc) {
      await request(devicesDir + encodeURIComponent(`${doc.deviceId}.json`), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(doc),
      })
    },

    async listFiles() {
      return new Set(await list(filesDir, 'files'))
    },

    async putFile(name, blob) {
      await request(filesDir + encodeURIComponent(name), {
        method: 'PUT',
        headers: { 'content-type': name.endsWith('.cover') ? 'image/jpeg' : 'application/octet-stream' },
        body: blob,
      })
    },

    async getFile(name) {
      const res = await request(filesDir + encodeURIComponent(name), { method: 'GET' }, [404])
      return res.status === 404 ? null : res.blob()
    },
  }
}
