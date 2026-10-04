/**
 * 轻阅账号 / 多端同步后端 (Cloudflare Worker, sync.jiangshu.ai)
 *
 * 只存同步记录 (SyncDoc, 见 docs/sync.md), 不存书籍文件. 接口约定见 docs/account-api.md.
 *  - D1 (DB): 账号、验证码、会话、按 UTC 日的限流计数
 *  - R2 (DOCS): 每台设备的 SyncDoc, 键 u/<userId>/devices/<deviceId>.json
 *  - 登录: 邮箱 6 位验证码 (Resend 发信), 10 分钟有效, 每码最多试 5 次
 *  - 鉴权: Bearer token (32 字节随机数 base64url), 服务端只存 SHA-256, 登出即吊销
 *
 * 部署: cd sync-server && npx wrangler deploy
 * 配置密钥: npx wrangler secret put RESEND_API_KEY
 * 建表 (一次): npx wrangler d1 execute lightread-sync --remote --file schema.sql
 */

// ---- 运行时类型 (只声明用到的部分, 免装 @cloudflare/workers-types) ----

interface D1Result<T = Record<string, unknown>> {
  results: T[]
  meta: { changes: number }
}
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  first<T = Record<string, unknown>>(): Promise<T | null>
  run(): Promise<D1Result>
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>
}
interface D1Database {
  prepare(sql: string): D1PreparedStatement
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>
}
interface R2Object {
  key: string
}
interface R2ObjectBody extends R2Object {
  text(): Promise<string>
}
interface R2Objects {
  objects: R2Object[]
  truncated: boolean
  cursor?: string
}
interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>
  put(key: string, value: string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>
  delete(keys: string | string[]): Promise<void>
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<R2Objects>
}
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void
}

export interface Env {
  DB: D1Database
  DOCS: R2Bucket
  MAIL_FROM: string
  RESEND_API_KEY?: string
  /** 仅本地测试: '1' 时 /v1/auth/code 直接返回验证码而不发邮件. 生产绝不能设 */
  DEV_EXPOSE_CODE?: string
}

// ---- 常量 ----

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const CODE_TTL = 10 * MINUTE
const CODE_MAX_ATTEMPTS = 5
const RESEND_WINDOW = MINUTE
const EMAIL_DAILY_CODES = 10
const IP_DAILY_CODES = 30
const DAILY_PUTS = 2000
const MAX_DOC_BYTES = 8 * 1024 * 1024
/** 登录类请求体很小, 超过即视为非法 */
const MAX_AUTH_BODY = 4 * 1024
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'access-control-max-age': '86400',
}

// ---- 响应 ----

const json = (status: number, payload: unknown, extra?: Record<string, string>) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...extra },
  })

const noContent = () => new Response(null, { status: 204, headers: CORS })

const fail = (status: number, error: string, retryAfter?: number) =>
  retryAfter === undefined
    ? json(status, { error })
    : json(status, { error, retryAfter }, { 'retry-after': String(retryAfter) })

// ---- 工具 ----

const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10)

/** 距下一个 UTC 零点的秒数 (按日限流的 retryAfter) */
const secondsToNextDay = (now = Date.now()) => Math.max(1, Math.ceil((DAY - (now % DAY)) / 1000))

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

function base64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** 均匀分布的 6 位数字 (拒绝采样, 避免取模偏差) */
function randomCode(): string {
  const buf = new Uint32Array(1)
  const limit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000
  for (;;) {
    crypto.getRandomValues(buf)
    if (buf[0] < limit) return String(buf[0] % 1_000_000).padStart(6, '0')
  }
}

const normEmail = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '')

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * 读请求体, 超过 limit 字节即返回 null (边读边数, 不会把超大请求整个读进内存).
 * content-length 只作快速拒绝, 以实际字节数为准.
 */
async function readBody(request: Request, limit: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > limit) return null
  if (!request.body) return new Uint8Array(0)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(size)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return out
}

async function readJson(request: Request, limit: number): Promise<unknown> {
  const body = await readBody(request, limit)
  if (!body) return undefined
  try {
    return JSON.parse(new TextDecoder().decode(body))
  } catch {
    return undefined
  }
}

/** 自增并返回当日计数 (原子, 跨节点一致) */
async function bump(db: D1Database, key: string, day: string): Promise<number> {
  const row = await db
    .prepare(
      'INSERT INTO counters(key, day, count) VALUES(?1, ?2, 1) ' +
        'ON CONFLICT(key, day) DO UPDATE SET count = count + 1 RETURNING count',
    )
    .bind(key, day)
    .first<{ count: number }>()
  return Number(row?.count ?? 0)
}

const docsPrefix = (userId: string) => `u/${userId}/devices/`

/** 列出前缀下全部对象键 (分页) */
async function listKeys(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = []
  let cursor: string | undefined
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 })
    for (const o of page.objects) keys.push(o.key)
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return keys
}

// ---- 邮件 ----

async function sendCodeEmail(env: Env, to: string, code: string): Promise<boolean> {
  if (!env.RESEND_API_KEY) return false
  const text =
    `你的轻阅登录验证码是 ${code}，10 分钟内有效。\n` +
    `Your LightRead sign-in code is ${code}. It expires in 10 minutes.\n\n` +
    `如果这不是你本人的操作，忽略这封邮件即可。\n` +
    `If you didn't request this, you can safely ignore this email.`
  const html =
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;line-height:1.6;color:#222">` +
    `<p>你的轻阅登录验证码 / Your LightRead sign-in code:</p>` +
    `<p style="font-size:28px;font-weight:600;letter-spacing:6px;margin:16px 0">${code}</p>` +
    `<p>10 分钟内有效。如果这不是你本人的操作，忽略这封邮件即可。<br>` +
    `It expires in 10 minutes. If you didn't request this, you can safely ignore this email.</p>` +
    `</div>`
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: env.MAIL_FROM,
        to: [to],
        subject: `轻阅登录验证码：${code}`,
        text,
        html,
      }),
    })
    if (!res.ok) console.error('resend failed', res.status, (await res.text()).slice(0, 500))
    return res.ok
  } catch (e) {
    console.error('resend error', e)
    return false
  }
}

// ---- 鉴权 ----

interface Account {
  id: string
  email: string
  createdAt: number
}
interface Session {
  tokenHash: string
  lastSeenAt: number
  account: Account
}

async function authenticate(request: Request, env: Env): Promise<Session | null> {
  const m = /^Bearer\s+([A-Za-z0-9_-]{16,128})$/.exec(request.headers.get('authorization') ?? '')
  if (!m) return null
  const tokenHash = await sha256Hex(m[1])
  const row = await env.DB.prepare(
    'SELECT s.last_seen_at, u.id, u.email, u.created_at FROM sessions s ' +
      'JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?1',
  )
    .bind(tokenHash)
    .first<{ last_seen_at: number; id: string; email: string; created_at: number }>()
  if (!row) return null
  return {
    tokenHash,
    lastSeenAt: Number(row.last_seen_at),
    account: { id: row.id, email: row.email, createdAt: Number(row.created_at) },
  }
}

// ---- 接口 ----

async function requestCode(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request, MAX_AUTH_BODY)
  const email = normEmail(isObj(body) ? body.email : undefined)
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) return fail(400, 'invalid_email')

  const now = Date.now()
  const day = today(now)
  const prev = await env.DB.prepare('SELECT sent_at FROM codes WHERE email = ?1')
    .bind(email)
    .first<{ sent_at: number }>()
  if (prev && now - Number(prev.sent_at) < RESEND_WINDOW) {
    return fail(429, 'rate_limited', Math.ceil((RESEND_WINDOW - (now - Number(prev.sent_at))) / 1000))
  }
  // 先计 IP 再计邮箱: IP 超限时不占用该邮箱的当日额度
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
  if ((await bump(env.DB, `code:ip:${ip}`, day)) > IP_DAILY_CODES) {
    return fail(429, 'rate_limited', secondsToNextDay(now))
  }
  if ((await bump(env.DB, `code:email:${email}`, day)) > EMAIL_DAILY_CODES) {
    return fail(429, 'rate_limited', secondsToNextDay(now))
  }

  const code = randomCode()
  await env.DB.prepare(
    'INSERT INTO codes(email, code_hash, expires_at, attempts, sent_at) VALUES(?1, ?2, ?3, 0, ?4) ' +
      'ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, ' +
      'attempts = 0, sent_at = excluded.sent_at',
  )
    .bind(email, await sha256Hex(`${email}:${code}`), now + CODE_TTL, now)
    .run()

  if (env.DEV_EXPOSE_CODE === '1') return json(200, { devCode: code })

  if (!(await sendCodeEmail(env, email, code))) {
    // 发信失败则作废这条验证码, 用户可立即重试 (当日计数照算)
    await env.DB.prepare('DELETE FROM codes WHERE email = ?1 AND sent_at = ?2').bind(email, now).run()
    return fail(502, 'email_failed')
  }
  return noContent()
}

async function verifyCode(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request, MAX_AUTH_BODY)
  if (!isObj(body)) return fail(400, 'invalid_code')
  const email = normEmail(body.email)
  const code = typeof body.code === 'string' ? body.code.trim() : ''
  if (!email || !/^\d{6}$/.test(code)) return fail(400, 'invalid_code')

  const now = Date.now()
  // 先占用一次尝试再比对: 并发请求也逃不过 5 次上限
  const row = await env.DB.prepare(
    'UPDATE codes SET attempts = attempts + 1 WHERE email = ?1 RETURNING code_hash, expires_at, attempts',
  )
    .bind(email)
    .first<{ code_hash: string; expires_at: number; attempts: number }>()
  if (!row) return fail(400, 'invalid_code')
  if (Number(row.expires_at) < now) {
    await env.DB.prepare('DELETE FROM codes WHERE email = ?1').bind(email).run()
    return fail(400, 'invalid_code')
  }
  if (Number(row.attempts) > CODE_MAX_ATTEMPTS) return fail(429, 'too_many_attempts')
  if ((await sha256Hex(`${email}:${code}`)) !== row.code_hash) {
    return Number(row.attempts) >= CODE_MAX_ATTEMPTS
      ? fail(429, 'too_many_attempts')
      : fail(400, 'invalid_code')
  }
  // 验证码一次性: 删除成功的请求才算数 (防止同一个码并发换出两个会话)
  const del = await env.DB.prepare('DELETE FROM codes WHERE email = ?1 AND code_hash = ?2')
    .bind(email, row.code_hash)
    .run()
  if (!del.meta.changes) return fail(400, 'invalid_code')

  await env.DB.prepare('INSERT INTO users(id, email, created_at) VALUES(?1, ?2, ?3) ON CONFLICT(email) DO NOTHING')
    .bind(crypto.randomUUID(), email, now)
    .run()
  const user = await env.DB.prepare('SELECT id, email, created_at FROM users WHERE email = ?1')
    .bind(email)
    .first<{ id: string; email: string; created_at: number }>()
  if (!user) return fail(500, 'internal')

  const token = base64url(crypto.getRandomValues(new Uint8Array(32)))
  const deviceName = typeof body.deviceName === 'string' ? body.deviceName.trim().slice(0, 100) || null : null
  await env.DB.prepare(
    'INSERT INTO sessions(token_hash, user_id, device_name, created_at, last_seen_at) VALUES(?1, ?2, ?3, ?4, ?4)',
  )
    .bind(await sha256Hex(token), user.id, deviceName, now)
    .run()

  return json(200, {
    token,
    account: { id: user.id, email: user.email, createdAt: Number(user.created_at) },
  })
}

async function getMe(session: Session, env: Env): Promise<Response> {
  const now = Date.now()
  // last_seen_at 至多每小时写一次, 省 D1 写入
  if (now - session.lastSeenAt >= HOUR) {
    await env.DB.prepare('UPDATE sessions SET last_seen_at = ?1 WHERE token_hash = ?2')
      .bind(now, session.tokenHash)
      .run()
  }
  return json(200, { account: session.account })
}

async function logout(session: Session, env: Env): Promise<Response> {
  await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(session.tokenHash).run()
  return noContent()
}

async function deleteMe(session: Session, env: Env): Promise<Response> {
  const { id, email } = session.account
  // 先删 R2 文档 (每次最多 1000 个键), 再删库里的账号与会话
  const keys = await listKeys(env.DOCS, `u/${id}/`)
  for (let i = 0; i < keys.length; i += 1000) await env.DOCS.delete(keys.slice(i, i + 1000))
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(id),
    env.DB.prepare('DELETE FROM codes WHERE email = ?1').bind(email),
    env.DB.prepare('DELETE FROM counters WHERE key = ?1').bind(`put:${id}`),
    env.DB.prepare('DELETE FROM users WHERE id = ?1').bind(id),
  ])
  return noContent()
}

async function listDocs(session: Session, env: Env): Promise<Response> {
  const keys = await listKeys(env.DOCS, docsPrefix(session.account.id))
  const docs = await Promise.all(
    keys.map(async key => {
      try {
        const obj = await env.DOCS.get(key)
        if (!obj) return null
        const doc: unknown = JSON.parse(await obj.text())
        return isObj(doc) ? doc : null
      } catch {
        return null // 损坏的文档跳过
      }
    }),
  )
  return json(200, { docs: docs.filter(d => d !== null) })
}

function validDoc(doc: unknown, deviceId: string): boolean {
  return (
    isObj(doc) &&
    doc.format === 1 &&
    doc.deviceId === deviceId &&
    isObj(doc.books) &&
    isObj(doc.annotations) &&
    isObj(doc.booklists) &&
    isObj(doc.booklistItems) &&
    isObj(doc.sources)
  )
}

async function putDoc(request: Request, session: Session, env: Env, deviceId: string): Promise<Response> {
  const body = await readBody(request, MAX_DOC_BYTES)
  if (!body) return fail(413, 'too_large')
  const text = new TextDecoder().decode(body)
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return fail(400, 'invalid_doc')
  }
  if (!validDoc(doc, deviceId)) return fail(400, 'invalid_doc')

  const now = Date.now()
  if ((await bump(env.DB, `put:${session.account.id}`, today(now))) > DAILY_PUTS) {
    return fail(429, 'rate_limited', secondsToNextDay(now))
  }
  // 原样存 JSON, 不重新序列化
  await env.DOCS.put(`${docsPrefix(session.account.id)}${deviceId}.json`, text, {
    httpMetadata: { contentType: 'application/json' },
  })
  return noContent()
}

// ---- WebDAV 中转 (仅网页版用) ----
// 坚果云 / Koofr 的 WebDAV 不支持浏览器跨域 (CORS 预检直接 401), 网页版经此原样转发.
// 只转发到白名单里的固定地址 (不是开放代理), 不存储也不记录账号密码与内容.

const WEBDAV_UPSTREAMS: Record<string, string> = {
  jianguoyun: 'https://dav.jianguoyun.com/dav/',
  koofr: 'https://app.koofr.net/dav/Koofr/',
}
const WEBDAV_METHODS = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'MKCOL', 'PROPFIND'])
const WEBDAV_CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, depth',
  'access-control-allow-methods': 'GET, HEAD, PUT, DELETE, MKCOL, PROPFIND, OPTIONS',
  'access-control-expose-headers': 'content-length, content-type, last-modified, etag',
  'access-control-max-age': '86400',
}
const WEBDAV_RE = /^\/v1\/webdav\/([a-z0-9]+)\/(.*)$/

const davFail = (status: number, error: string) =>
  new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...WEBDAV_CORS },
  })

async function webdavRelay(request: Request, provider: string, rest: string, search: string): Promise<Response> {
  const upstream = WEBDAV_UPSTREAMS[provider]
  if (!upstream) return davFail(404, 'not_found')
  const method = request.method
  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: WEBDAV_CORS })
  if (!WEBDAV_METHODS.has(method)) return davFail(405, 'method_not_allowed')
  // 路径段里不许出现 .. (含转义形式), 防止跳出上游目录
  let decoded = rest
  try { decoded = decodeURIComponent(rest) } catch { return davFail(400, 'invalid_path') }
  if (decoded.split('/').some(seg => seg === '..' || seg === '.')) return davFail(400, 'invalid_path')
  const auth = request.headers.get('authorization') ?? ''
  // 不带 WWW-Authenticate: 免得浏览器弹出原生登录框
  if (!auth.startsWith('Basic ')) return davFail(401, 'unauthorized')

  const headers = new Headers({ authorization: auth })
  for (const name of ['content-type', 'depth']) {
    const v = request.headers.get(name)
    if (v) headers.set(name, v)
  }
  const hasBody = method === 'PUT' || method === 'PROPFIND'
  const res = await fetch(upstream + rest + search, {
    method,
    headers,
    // 读成整块再转发: 上游需要 Content-Length (Workers 请求体本身有 100MB 上限)
    body: hasBody ? await request.arrayBuffer() : undefined,
    redirect: 'manual',
  })
  const out = new Headers(WEBDAV_CORS)
  for (const name of ['content-type', 'content-length', 'last-modified', 'etag']) {
    const v = res.headers.get(name)
    if (v) out.set(name, v)
  }
  return new Response(method === 'HEAD' ? null : res.body, { status: res.status, headers: out })
}

// ---- 路由 ----

async function route(request: Request, env: Env): Promise<Response> {
  const { pathname, search } = new URL(request.url)
  const method = request.method

  const davMatch = WEBDAV_RE.exec(pathname)
  if (davMatch) return webdavRelay(request, davMatch[1], davMatch[2], search)

  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (method === 'GET' && pathname === '/health') return json(200, { ok: true })
  if (method === 'POST' && pathname === '/v1/auth/code') return requestCode(request, env)
  if (method === 'POST' && pathname === '/v1/auth/verify') return verifyCode(request, env)

  const docMatch = /^\/v1\/docs\/([^/]+)$/.exec(pathname)
  const authed =
    (pathname === '/v1/me' && (method === 'GET' || method === 'DELETE')) ||
    (pathname === '/v1/auth/logout' && method === 'POST') ||
    (pathname === '/v1/docs' && method === 'GET') ||
    (docMatch !== null && method === 'PUT')
  if (!authed) return fail(404, 'not_found')

  // 先鉴权再校验路径参数, 未登录请求一律 401
  const session = await authenticate(request, env)
  if (!session) return fail(401, 'unauthorized')

  if (pathname === '/v1/me') return method === 'GET' ? getMe(session, env) : deleteMe(session, env)
  if (pathname === '/v1/auth/logout') return logout(session, env)
  if (pathname === '/v1/docs') return listDocs(session, env)
  const deviceId = docMatch![1]
  if (!DEVICE_ID_RE.test(deviceId)) return fail(400, 'invalid_doc')
  return putDoc(request, session, env, deviceId)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env)
    } catch (e) {
      console.error('unhandled', e)
      return fail(500, 'internal')
    }
  },

  /** 每日清理: 过期验证码与两天前的计数 */
  async scheduled(_event: unknown, env: Env, ctx: ExecutionContext): Promise<void> {
    const now = Date.now()
    ctx.waitUntil(
      env.DB.batch([
        env.DB.prepare('DELETE FROM codes WHERE expires_at < ?1').bind(now),
        env.DB.prepare('DELETE FROM counters WHERE day < ?1').bind(today(now - 2 * DAY)),
      ]),
    )
  },
}
