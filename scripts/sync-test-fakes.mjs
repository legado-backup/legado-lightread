// 同步测试共用的内存假对象: 假书库 (LibraryStorage)、假 WebDAV 服务器、假轻阅账号服务器.
import { createWebdavRemote } from '../src/services/sync/webdavRemote.ts'
import assert from 'node:assert/strict'
import { createAccountRemote } from '../src/services/sync/accountRemote.ts'

export const tr = (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key)
export const enc = s => new TextEncoder().encode(s)

// ---- 假书库 (实现 LibraryStorage, 行为对齐 dexie.ts) ----
export function createFakeStorage() {
  const books = new Map() // id → { meta, file: Blob, cover?: Uint8Array }
  const annotations = new Map()
  const booklists = new Map()
  const items = new Map() // `${booklistId}|${bookId}` → { booklistId, bookId, addedAt }
  const sources = new Map()
  const id = () => crypto.randomUUID()
  const clone = v => structuredClone(v)
  const s = {
    kind: 'indexeddb',
    async init() {
      sources.set('builtin-1', {
        id: 'builtin-1', title: 'Gutenberg', url: 'https://www.gutenberg.org/ebooks.opds/',
        kind: 'opds', builtin: true, addedAt: 1,
      })
    },
    async listBooks() {
      return [...books.values()].map(b => clone(b.meta)).sort((a, b) => b.addedAt - a.addedAt)
    },
    async getBook(bid) { return books.has(bid) ? clone(books.get(bid).meta) : undefined },
    async addBook(meta, file, cover) {
      const bid = id()
      books.set(bid, {
        meta: { ...clone(meta), id: bid, hasCover: !!cover },
        file,
        cover: cover ? new Uint8Array(await cover.arrayBuffer()) : undefined,
      })
      return bid
    },
    async updateBook(bid, patch) {
      const b = books.get(bid)
      if (!b) return
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete b.meta[k]
        else b.meta[k] = clone(v)
      }
    },
    async deleteBook(bid) {
      books.delete(bid)
      for (const [aid, a] of annotations) if (a.bookId === bid) annotations.delete(aid)
      for (const [k, it] of items) if (it.bookId === bid) items.delete(k)
    },
    async getBookFile(bid) {
      const b = books.get(bid)
      if (!b) throw new Error('书籍不存在')
      return b.file
    },
    async getCoverUrl(bid) {
      const c = books.get(bid)?.cover
      return c ? `data:image/jpeg;base64,${Buffer.from(c).toString('base64')}` : undefined
    },
    async listBooklists() { return [...booklists.values()].map(clone) },
    async createBooklist(name, opts = {}) {
      const bid = opts.id ?? id()
      booklists.set(bid, { id: bid, name, createdAt: opts.createdAt ?? Date.now(), updatedAt: Date.now() })
      return bid
    },
    async renameBooklist(bid, name) { const b = booklists.get(bid); if (b) b.name = name },
    async deleteBooklist(bid) {
      for (const [k, it] of items) if (it.booklistId === bid) items.delete(k)
      booklists.delete(bid)
    },
    async listBooklistItems(bid) {
      return [...items.values()].filter(it => it.booklistId === bid)
        .sort((a, b) => a.addedAt - b.addedAt).map(({ bookId, addedAt }) => ({ bookId, addedAt }))
    },
    async listBooklistBookIds(bid) { return (await s.listBooklistItems(bid)).map(it => it.bookId) },
    async addBooksToBooklist(bid, bookIds, opts = {}) {
      const start = opts.addedAt ?? Date.now()
      ;[...new Set(bookIds)].forEach((bookId, i) =>
        items.set(`${bid}|${bookId}`, { booklistId: bid, bookId, addedAt: start + i }))
    },
    async removeBooksFromBooklist(bid, bookIds) {
      for (const bookId of bookIds) items.delete(`${bid}|${bookId}`)
    },
    async listAnnotations(bookId) {
      return [...annotations.values()].filter(a => a.bookId === bookId)
        .sort((a, b) => a.createdAt - b.createdAt).map(clone)
    },
    async addAnnotation(a) {
      const aid = a.id ?? id()
      annotations.set(aid, { ...clone(a), id: aid })
      return aid
    },
    async updateAnnotation(aid, patch) {
      const a = annotations.get(aid)
      if (a) Object.assign(a, clone(patch))
    },
    async deleteAnnotation(aid) { annotations.delete(aid) },
    async listSources() { return [...sources.values()].map(clone) },
    async addSource(src) {
      const sid = id()
      sources.set(sid, { ...clone(src), id: sid })
      return sid
    },
    async updateSource(sid, src) {
      const cur = sources.get(sid)
      if (!cur) return
      const next = { id: sid, builtin: cur.builtin, ...clone(src) }
      for (const k of ['username', 'password', 'updatedAt']) if (next[k] === undefined || next[k] === '') delete next[k]
      sources.set(sid, next)
    },
    async deleteSource(sid) { sources.delete(sid) },
  }
  return s
}

// ---- 假 WebDAV 服务器 ----
export function createFakeDav(base = 'https://dav.example.com/remote.php/dav') {
  const root = new URL(base).pathname.replace(/\/+$/, '')
  const cols = new Set(['', '/remote.php', root])
  const files = new Map() // path → Uint8Array
  const log = []
  let authFail = false
  const norm = url => decodeURIComponent(new URL(url).pathname).replace(/\/+$/, '')
  const parent = p => p.slice(0, p.lastIndexOf('/'))
  const res = (status, body = '') => ({
    status,
    async text() { return typeof body === 'string' ? body : new TextDecoder().decode(body) },
    async blob() { return new Blob([body]) },
  })
  const http = async (url, req) => {
    log.push(`${req.method} ${url}`)
    if (authFail) return res(401)
    const p = norm(url)
    switch (req.method) {
      case 'MKCOL':
        if (cols.has(p) || files.has(p)) return res(405)
        if (!cols.has(parent(p))) return res(409)
        cols.add(p)
        return res(201)
      case 'PROPFIND': {
        if (!cols.has(p)) return res(files.has(p) ? 207 : 404, '')
        const hrefs = [`${encodeURI(p)}/`]
        if (req.headers?.depth === '1') {
          for (const c of cols) if (c && parent(c) === p) hrefs.push(`${encodeURI(c)}/`)
          for (const f of files.keys()) if (parent(f) === p) hrefs.push(encodeURI(f))
        }
        const body = '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">' + hrefs.map(h =>
          `<D:response><D:href>${h.replace(/&/g, '&amp;')}</D:href><D:propstat><D:prop/></D:propstat></D:response>`,
        ).join('') + '</D:multistatus>'
        return res(207, body)
      }
      case 'GET':
        return files.has(p) ? res(200, files.get(p)) : res(404)
      case 'PUT': {
        if (!cols.has(parent(p))) return res(409)
        const body = typeof req.body === 'string' ? enc(req.body) : new Uint8Array(await req.body.arrayBuffer())
        files.set(p, body)
        return res(201)
      }
      default:
        return res(405)
    }
  }
  return {
    base, http, files, log,
    set authFail(v) { authFail = v },
    remote: (user = 'u') => createWebdavRemote({ url: base + '/', user, pass: 'p' }, http, tr),
    readJson(rel) {
      const f = files.get(`${root}/LightRead/sync/v1/${rel}`)
      return f ? JSON.parse(new TextDecoder().decode(f)) : null
    },
  }
}

// ---- 假轻阅账号服务器 (行为对齐 docs/account-api.md) ----
export function createFakeAccountServer(base = 'https://sync.test') {
  const users = new Map() // id → { id, email, createdAt }
  const sessions = new Map() // token → { userId, deviceName }
  const docs = new Map() // userId → Map(deviceId → json 字符串)
  const codes = new Map() // email → { code, attempts }
  const log = []
  const opts = { down: false, maxBytes: 8 * 1024 * 1024, codeRateLimited: false }
  let seq = 0
  const res = (status, body) => ({
    status,
    async text() { return body === undefined ? '' : JSON.stringify(body) },
  })
  const err = (status, error, extra = {}) => res(status, { error, ...extra })
  const newToken = () => `tok-${++seq}-${crypto.randomUUID()}`

  function login(email, deviceName) {
    let user = [...users.values()].find(u => u.email === email)
    if (!user) {
      user = { id: `u${++seq}`, email, createdAt: 1_700_000_000_000 + seq }
      users.set(user.id, user)
    }
    const token = newToken()
    sessions.set(token, { userId: user.id, deviceName })
    return { token, account: { ...user } }
  }

  const fetch = async (url, init) => {
    if (opts.down) throw new TypeError('Failed to fetch')
    assert(url.startsWith(base + '/'), `unexpected url ${url}`)
    const path = new URL(url).pathname
    log.push(`${init.method} ${path}`)
    const bearer = (init.headers?.authorization ?? '').replace(/^Bearer /, '')
    const session = sessions.get(bearer)
    const body = init.body ? JSON.parse(init.body) : null

    if (init.method === 'POST' && path === '/v1/auth/code') {
      const email = String(body?.email ?? '').trim().toLowerCase()
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err(400, 'invalid_email')
      if (opts.codeRateLimited) return err(429, 'rate_limited', { retryAfter: 42 })
      if (email.endsWith('@bounce.test')) return err(502, 'email_failed')
      codes.set(email, { code: '123456', attempts: 0 })
      return res(204)
    }
    if (init.method === 'POST' && path === '/v1/auth/verify') {
      const email = String(body?.email ?? '').trim().toLowerCase()
      const c = codes.get(email)
      if (!c) return err(400, 'invalid_code')
      if (++c.attempts > 5) return err(429, 'too_many_attempts')
      if (c.code !== body.code) return err(400, 'invalid_code')
      codes.delete(email)
      return res(200, login(email, body.deviceName))
    }
    if (path === '/health') return res(200, { ok: true })
    if (!session) return err(401, 'unauthorized')
    const userDocs = docs.get(session.userId) ?? new Map()
    docs.set(session.userId, userDocs)

    if (init.method === 'GET' && path === '/v1/me') return res(200, { account: users.get(session.userId) })
    if (init.method === 'POST' && path === '/v1/auth/logout') {
      sessions.delete(bearer)
      return res(204)
    }
    if (init.method === 'DELETE' && path === '/v1/me') {
      for (const [tok, s] of sessions) if (s.userId === session.userId) sessions.delete(tok)
      users.delete(session.userId)
      docs.delete(session.userId)
      return res(204)
    }
    if (init.method === 'GET' && path === '/v1/docs') {
      return res(200, { docs: [...userDocs.values()].map(j => JSON.parse(j)) })
    }
    const m = /^\/v1\/docs\/([A-Za-z0-9_-]{1,64})$/.exec(path)
    if (init.method === 'PUT' && m) {
      if (init.body.length > opts.maxBytes) return err(413, 'too_large')
      if (body?.format !== 1 || body.deviceId !== m[1]) return err(400, 'invalid_doc')
      userDocs.set(m[1], init.body)
      return res(204)
    }
    return err(404, 'not_found')
  }

  return {
    base, fetch, log, opts, users, sessions, docs, login,
    /** 该会话对应的远端 */
    remote: ({ token, account }) => createAccountRemote({ base, token, accountId: account.id }, fetch, tr),
    /** 某账号下某设备的文档 */
    readDoc(accountId, deviceId) {
      const j = docs.get(accountId)?.get(deviceId)
      return j ? JSON.parse(j) : null
    },
  }
}
