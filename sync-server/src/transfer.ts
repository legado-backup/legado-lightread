/**
 * 互传 (docs/device-transfer.md): 设备间发送文字 / 链接 / 文件. 接口约定见 docs/account-api.md「互传」.
 *
 *  - 账号通道: 同一账号的设备之间, Bearer 鉴权. D1 transfers + devices, 文件在 R2 transfer/<accountId>/<id>, 保留 7 天
 *  - 取件码: 匿名, 6 位数字取件码, 10 分钟或 1 小时, 最多取 10 次. D1 drops, 文件在 R2 drop/<id>
 *  - 文件一律以 application/octet-stream + attachment + nosniff 下发, 从不在本域名下渲染
 *  - 过期条目与 R2 对象由每日 Cron 清理 (cleanupExpired)
 *
 * 注意: 本模块与 index.ts 互相 import (共用响应 / 计数 / 鉴权工具). 模块顶层不要用 index.ts 导出的值
 * (打包后本模块先于 index.ts 求值), 只在函数里用; 常量在本文件里单独定义.
 */

import {
  CORS,
  DEVICE_ID_RE,
  authenticate,
  base64url,
  bump,
  fail,
  ipRateKey,
  isObj,
  json,
  listKeys,
  noContent,
  randomCode,
  readBody,
  secondsToNextDay,
  sha256Hex,
  today,
} from './index'
import type { D1Database, D1PreparedStatement, Env, R2ObjectBody, Session } from './index'

// ---- 常量 ----

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
const MB = 1024 * 1024
/** 已就绪条目保留 7 天 */
const TRANSFER_TTL = 7 * DAY_MS
/** 文件记录建好后 24 小时内没传完即由 Cron 清理 */
const PENDING_TTL = DAY_MS
/** 设备登记: 90 天没见过的不再列出, Cron 删除 */
const DEVICE_TTL = 90 * DAY_MS
/** 同名且一小时内见过的设备不重复写 */
const DEVICE_TOUCH_INTERVAL = HOUR_MS
/** 创建请求体上限 (文字 64 KB 的 JSON 转义后仍能放下) */
const MAX_CREATE_BODY = 80 * 1024
const MAX_TEXT_BYTES = 64 * 1024
const MAX_URL = 4096
const MAX_TITLE = 300
const MAX_FILENAME = 255
const MAX_MIME = 100
const MAX_DEVICE_NAME = 100
const MAX_FILE = 50 * MB
const MAX_DROP_FILE_ANON = 20 * MB
const XFER_DAILY_ITEMS = 200
const XFER_DAILY_BYTES = 500 * MB
const LIST_LIMIT = 200
const DROP_TTLS = [600, 3600]
const DROP_DEFAULT_TTL = 3600
const DROP_MAX_DOWNLOADS = 10
const DROP_IP_DAILY_CREATES = 20
const DROP_IP_DAILY_LOOKUPS = 60
const DROP_IP_DAILY_MISSES = 10
const DROP_CODE_RETRIES = 8
/** Cron 每轮最多处理的过期行数 (R2 一次最多删 1000 个键) */
const CLEANUP_BATCH = 1000
const CLEANUP_ROUNDS = 10
/** D1 每条语句最多绑定 100 个参数 */
const IN_CHUNK = 90
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const CODE_RE = /^\d{6}$/
const BLOB_TYPE = 'application/octet-stream'

// ---- 条目 ----

type Kind = 'text' | 'link' | 'file'
const KINDS: readonly string[] = ['text', 'link', 'file']

/** 校验后的内容字段 (transfers 与 drops 共用) */
interface ItemInput {
  kind: Kind
  title: string
  text: string | null
  url: string | null
  filename: string | null
  size: number | null
  mime: string | null
}

interface ContentRow {
  kind: string
  title: string
  text: string | null
  url: string | null
  filename: string | null
  size: number | null
  mime: string | null
  r2_key: string | null
  ready: number
  created_at: number
  expires_at: number
}

interface TransferRow extends ContentRow {
  id: string
  account_id: string
  from_device: string
  from_name: string
  to_device: string | null
}

interface DropRow extends ContentRow {
  id: string
  code: string
  account_id: string | null
  owner_hash: string
  downloads: number
  max_downloads: number
}

const optStr = (v: unknown): string | null | false =>
  v === undefined || v === null ? null : typeof v === 'string' ? v : false

/** 去掉路径分隔符与控制字符, 只留最后一段 */
function cleanFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? ''
  return base.replace(/[\u0000-\u001f\u007f]/g, '').trim()
}

/**
 * 校验内容字段. 只保留与 kind 对应的字段 (文字只存 text, 链接只存 url, 文件只存 filename/size/mime).
 * 标题为空时: 链接用网址, 文件用文件名 (截到 300 字); 文字可以没有标题.
 */
function parseItem(body: Record<string, unknown>, maxFile: number): ItemInput | 'invalid' | 'too_large' {
  const kind = body.kind
  if (typeof kind !== 'string' || !KINDS.includes(kind)) return 'invalid'
  const rawTitle = optStr(body.title)
  if (rawTitle === false) return 'invalid'
  const title = (rawTitle ?? '').trim()
  if (title.length > MAX_TITLE) return 'invalid'
  const item: ItemInput = { kind: kind as Kind, title, text: null, url: null, filename: null, size: null, mime: null }

  if (kind === 'text') {
    const text = optStr(body.text)
    if (!text || !text.trim()) return 'invalid'
    if (new TextEncoder().encode(text).byteLength > MAX_TEXT_BYTES) return 'too_large'
    item.text = text
  } else if (kind === 'link') {
    const url = optStr(body.url)
    if (!url) return 'invalid'
    const trimmed = url.trim()
    if (!trimmed || trimmed.length > MAX_URL) return 'invalid'
    let parsed: URL
    try {
      parsed = new URL(trimmed)
    } catch {
      return 'invalid'
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'invalid'
    item.url = trimmed
    if (!title) item.title = trimmed.slice(0, MAX_TITLE)
  } else {
    const rawName = optStr(body.filename)
    if (!rawName) return 'invalid'
    const filename = cleanFilename(rawName)
    if (!filename || filename === '.' || filename === '..' || filename.length > MAX_FILENAME) return 'invalid'
    const size = body.size
    if (typeof size !== 'number' || !Number.isInteger(size) || size < 1) return 'invalid'
    if (size > maxFile) return 'too_large'
    const mime = optStr(body.mime)
    if (mime === false) return 'invalid'
    const m = (mime ?? '').trim()
    if (m.length > MAX_MIME) return 'invalid'
    item.filename = filename
    item.size = size
    item.mime = m || null
    if (!title) item.title = filename.slice(0, MAX_TITLE)
  }
  return item
}

/** title + 非空的可选字段 (null 一律省略) */
function contentFields(r: ContentRow): Record<string, unknown> {
  const out: Record<string, unknown> = { title: r.title ?? '' }
  if (r.text !== null) out.text = r.text
  if (r.url !== null) out.url = r.url
  if (r.filename !== null) out.filename = r.filename
  if (r.size !== null) out.size = Number(r.size)
  if (r.mime !== null) out.mime = r.mime
  return out
}

/** 线上格式 TransferItem */
function toItem(r: TransferRow): Record<string, unknown> {
  return {
    id: r.id,
    kind: r.kind,
    fromDevice: r.from_device,
    fromName: r.from_name ?? '',
    toDevice: r.to_device ?? null,
    ...contentFields(r),
    createdAt: Number(r.created_at),
    expiresAt: Number(r.expires_at),
  }
}

/** 解析创建请求的 JSON: 超限 → 413, 非 JSON / 非对象 → 400 */
async function readCreateBody(request: Request, invalid: string): Promise<Record<string, unknown> | Response> {
  const raw = await readBody(request, MAX_CREATE_BODY)
  if (!raw) return fail(413, 'too_large')
  let body: unknown
  try {
    body = JSON.parse(new TextDecoder().decode(raw))
  } catch {
    return fail(400, invalid)
  }
  return isObj(body) ? body : fail(400, invalid)
}

const normName = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, MAX_DEVICE_NAME) || null : null)

// ---- 计数 ----

/** 当日计数加 n (原子), 返回语句以便并入 batch */
const addCount = (db: D1Database, key: string, day: string, n: number) =>
  db
    .prepare(
      'INSERT INTO counters(key, day, count) VALUES(?1, ?2, ?3) ' +
        'ON CONFLICT(key, day) DO UPDATE SET count = count + ?3 RETURNING count',
    )
    .bind(key, day, n)

/** 只读当日计数 (不自增) */
async function counterValue(db: D1Database, key: string, day: string): Promise<number> {
  const row = await db
    .prepare('SELECT count FROM counters WHERE key = ?1 AND day = ?2')
    .bind(key, day)
    .first<{ count: number }>()
  return Number(row?.count ?? 0)
}

const clientIp = (request: Request) => request.headers.get('cf-connecting-ip') ?? 'unknown'

// ---- 文件本体 ----

/** content-length 声明超过上限 → 413 (不读请求体) */
function declaredTooLarge(request: Request): Response | null {
  const len = Number(request.headers.get('content-length') ?? '')
  return Number.isFinite(len) && len > MAX_FILE ? fail(413, 'too_large') : null
}

/**
 * 把请求体流式写入 R2. content-length 必须存在且等于声明的 size; 实际字节数不符时 workerd 会让写入失败.
 * 成功返回 null, 否则返回错误响应 (并删掉可能写了一半的对象).
 */
async function storeBlob(request: Request, env: Env, key: string, size: number): Promise<Response | null> {
  const len = request.headers.get('content-length')
  if (len === null || !/^\d{1,12}$/.test(len) || Number(len) !== size || !request.body) {
    return fail(400, 'invalid_length')
  }
  try {
    const obj = await env.DOCS.put(key, request.body, { httpMetadata: { contentType: BLOB_TYPE } })
    if (obj && Number(obj.size) !== size) throw new Error(`size mismatch ${obj.size} != ${size}`)
  } catch (e) {
    console.error('blob upload failed', e)
    await env.DOCS.delete(key).catch(() => {})
    return fail(400, 'invalid_length')
  }
  return null
}

/** RFC 6266: ASCII 兜底 filename + UTF-8 的 filename* */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_')
  const utf8 = encodeURIComponent(filename).replace(
    /['()*]/g,
    c => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  )
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`
}

function blobResponse(obj: R2ObjectBody, filename: string): Response {
  return new Response(obj.body, {
    status: 200,
    headers: {
      ...CORS,
      'content-type': BLOB_TYPE,
      'content-length': String(obj.size),
      'content-disposition': contentDisposition(filename || 'file'),
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
      'access-control-expose-headers': 'content-length, content-disposition',
    },
  })
}

// ---- 账号通道 ----

const transferKey = (accountId: string, id: string) => `transfer/${accountId}/${id}`

/** 设备登记 (upsert). name 为 null 时保留原名; 同名且一小时内见过则不写 */
const touchDevice = (db: D1Database, accountId: string, deviceId: string, name: string | null, now: number) =>
  db
    .prepare(
      "INSERT INTO devices(account_id, device_id, name, last_seen_at) VALUES(?1, ?2, COALESCE(?3, ''), ?4) " +
        'ON CONFLICT(account_id, device_id) DO UPDATE SET name = COALESCE(?3, devices.name), last_seen_at = ?4 ' +
        'WHERE (?3 IS NOT NULL AND devices.name != ?3) OR devices.last_seen_at < ?5',
    )
    .bind(accountId, deviceId, name, now, now - DEVICE_TOUCH_INTERVAL)

async function listDevices(session: Session, env: Env): Promise<Response> {
  const now = Date.now()
  const { results } = await env.DB.prepare(
    'SELECT device_id, name, last_seen_at FROM devices WHERE account_id = ?1 AND last_seen_at > ?2 ' +
      'ORDER BY last_seen_at DESC',
  )
    .bind(session.account.id, now - DEVICE_TTL)
    .all<{ device_id: string; name: string; last_seen_at: number }>()
  return json(200, {
    devices: results.map(r => ({ id: r.device_id, name: r.name ?? '', lastSeenAt: Number(r.last_seen_at) })),
  })
}

async function listTransfers(session: Session, env: Env, search: string): Promise<Response> {
  const params = new URLSearchParams(search)
  const device = params.get('device') ?? ''
  if (!DEVICE_ID_RE.test(device)) return fail(400, 'invalid_device')
  const sinceRaw = params.get('since')
  const since = sinceRaw !== null && /^\d{1,16}$/.test(sinceRaw) ? Number(sinceRaw) : null
  const now = Date.now()
  const id = session.account.id

  // 本机可见: 发给本机 / 发给全部 (且不是本机发的) / 本机发出的
  // = (to_device = 本机 OR to_device IS NULL) AND from_device != 本机, 并上 from_device = 本机
  const [, listed] = await env.DB.batch([
    touchDevice(env.DB, id, device, normName(params.get('name')), now),
    env.DB.prepare(
      'SELECT * FROM transfers WHERE account_id = ?1 AND expires_at > ?2 AND ready = 1 ' +
        'AND (to_device = ?3 OR to_device IS NULL OR from_device = ?3) ' +
        'AND (?4 IS NULL OR created_at > ?4) ORDER BY created_at DESC LIMIT ?5',
    ).bind(id, now, device, since, LIST_LIMIT),
  ])
  return json(200, { items: (listed.results as unknown as TransferRow[]).map(toItem), now })
}

async function createTransfer(request: Request, session: Session, env: Env): Promise<Response> {
  const body = await readCreateBody(request, 'invalid_transfer')
  if (body instanceof Response) return body
  const fromDevice = body.fromDevice
  if (typeof fromDevice !== 'string' || !DEVICE_ID_RE.test(fromDevice)) return fail(400, 'invalid_transfer')
  const toDevice = body.toDevice ?? null
  if (toDevice !== null && (typeof toDevice !== 'string' || !DEVICE_ID_RE.test(toDevice))) {
    return fail(400, 'invalid_transfer')
  }
  if (body.fromName !== undefined && body.fromName !== null && typeof body.fromName !== 'string') {
    return fail(400, 'invalid_transfer')
  }
  const item = parseItem(body, MAX_FILE)
  if (item === 'invalid') return fail(400, 'invalid_transfer')
  if (item === 'too_large') return fail(413, 'too_large')

  // 每账号每 UTC 日: 200 条, 文件 500 MB (按声明大小计; 先查字节额度, 超限的不计入)
  const accountId = session.account.id
  const now = Date.now()
  const day = today(now)
  const bytesKey = `xfer:b:${accountId}`
  if (item.size !== null && (await counterValue(env.DB, bytesKey, day)) + item.size > XFER_DAILY_BYTES) {
    return fail(429, 'rate_limited', secondsToNextDay(now))
  }
  if ((await bump(env.DB, `xfer:n:${accountId}`, day)) > XFER_DAILY_ITEMS) {
    return fail(429, 'rate_limited', secondsToNextDay(now))
  }

  const id = crypto.randomUUID()
  const isFile = item.kind === 'file'
  const fromName = normName(body.fromName)
  const row: TransferRow = {
    id,
    account_id: accountId,
    from_device: fromDevice,
    from_name: fromName ?? '',
    to_device: toDevice,
    ...item,
    r2_key: isFile ? transferKey(accountId, id) : null,
    ready: isFile ? 0 : 1,
    created_at: now,
    expires_at: now + (isFile ? PENDING_TTL : TRANSFER_TTL),
  }
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      'INSERT INTO transfers(id, account_id, from_device, from_name, to_device, kind, title, text, url, r2_key, ' +
        'size, mime, filename, ready, created_at, expires_at) ' +
        'VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)',
    ).bind(
      row.id, row.account_id, row.from_device, row.from_name, row.to_device, row.kind, row.title, row.text,
      row.url, row.r2_key, row.size, row.mime, row.filename, row.ready, row.created_at, row.expires_at,
    ),
    touchDevice(env.DB, accountId, fromDevice, fromName, now),
  ]
  if (item.size !== null) statements.push(addCount(env.DB, bytesKey, day, item.size))
  await env.DB.batch(statements)
  return json(201, { item: toItem(row) })
}

async function putTransferBlob(request: Request, session: Session, env: Env, id: string): Promise<Response> {
  const tooLarge = declaredTooLarge(request)
  if (tooLarge) return tooLarge
  if (!ID_RE.test(id)) return fail(404, 'not_found')
  const now = Date.now()
  const row = await env.DB.prepare(
    'SELECT kind, ready, size, r2_key, expires_at FROM transfers WHERE id = ?1 AND account_id = ?2',
  )
    .bind(id, session.account.id)
    .first<{ kind: string; ready: number; size: number; r2_key: string | null; expires_at: number }>()
  if (!row || row.kind !== 'file' || !row.r2_key || Number(row.expires_at) <= now) return fail(404, 'not_found')
  if (row.ready) return fail(409, 'already_uploaded')
  const bad = await storeBlob(request, env, row.r2_key, Number(row.size))
  if (bad) return bad
  await env.DB.prepare('UPDATE transfers SET ready = 1, expires_at = ?3 WHERE id = ?1 AND account_id = ?2')
    .bind(id, session.account.id, Date.now() + TRANSFER_TTL)
    .run()
  return noContent()
}

async function getTransferBlob(session: Session, env: Env, id: string): Promise<Response> {
  if (!ID_RE.test(id)) return fail(404, 'not_found')
  const row = await env.DB.prepare(
    "SELECT filename, r2_key FROM transfers WHERE id = ?1 AND account_id = ?2 AND kind = 'file' " +
      'AND ready = 1 AND expires_at > ?3',
  )
    .bind(id, session.account.id, Date.now())
    .first<{ filename: string | null; r2_key: string | null }>()
  if (!row?.r2_key) return fail(404, 'not_found')
  const obj = await env.DOCS.get(row.r2_key)
  if (!obj) return fail(404, 'not_found')
  return blobResponse(obj, row.filename ?? '')
}

async function deleteTransfer(session: Session, env: Env, id: string): Promise<Response> {
  if (!ID_RE.test(id)) return fail(404, 'not_found')
  const row = await env.DB.prepare('SELECT r2_key FROM transfers WHERE id = ?1 AND account_id = ?2')
    .bind(id, session.account.id)
    .first<{ r2_key: string | null }>()
  if (!row) return fail(404, 'not_found')
  // 先删 R2 再删行: R2 失败时行还在, 由 Cron 到期再删
  if (row.r2_key) await env.DOCS.delete(row.r2_key)
  await env.DB.prepare('DELETE FROM transfers WHERE id = ?1 AND account_id = ?2').bind(id, session.account.id).run()
  return noContent()
}

const TRANSFER_ITEM_RE = /^\/v1\/transfers\/([^/]+)$/
const TRANSFER_BLOB_RE = /^\/v1\/transfers\/([^/]+)\/blob$/

/** 是否为需要登录的互传接口 (用于 index.ts 的鉴权分流) */
export function isTransferRoute(method: string, pathname: string): boolean {
  return (
    (pathname === '/v1/devices' && method === 'GET') ||
    (pathname === '/v1/transfers' && (method === 'GET' || method === 'POST')) ||
    (TRANSFER_ITEM_RE.test(pathname) && method === 'DELETE') ||
    (TRANSFER_BLOB_RE.test(pathname) && (method === 'GET' || method === 'PUT'))
  )
}

/** 已鉴权的互传接口 (先经 isTransferRoute 判定) */
export function routeTransfers(
  request: Request,
  env: Env,
  session: Session,
  pathname: string,
  search: string,
): Promise<Response> {
  const method = request.method
  if (pathname === '/v1/devices') return listDevices(session, env)
  if (pathname === '/v1/transfers') {
    return method === 'GET' ? listTransfers(session, env, search) : createTransfer(request, session, env)
  }
  const blob = TRANSFER_BLOB_RE.exec(pathname)
  if (blob) return method === 'PUT' ? putTransferBlob(request, session, env, blob[1]) : getTransferBlob(session, env, blob[1])
  return deleteTransfer(session, env, TRANSFER_ITEM_RE.exec(pathname)![1])
}

/**
 * 注销账号时: 删掉该账号的互传 / 取件文件 (R2), 返回删库语句供 deleteMe 并入同一个 batch.
 */
export async function accountTransferCleanup(env: Env, accountId: string): Promise<D1PreparedStatement[]> {
  const keys = await listKeys(env.DOCS, `transfer/${accountId}/`)
  const { results } = await env.DB.prepare('SELECT r2_key FROM drops WHERE account_id = ?1 AND r2_key IS NOT NULL')
    .bind(accountId)
    .all<{ r2_key: string }>()
  for (const r of results) keys.push(r.r2_key)
  for (let i = 0; i < keys.length; i += 1000) await env.DOCS.delete(keys.slice(i, i + 1000))
  return [
    env.DB.prepare('DELETE FROM transfers WHERE account_id = ?1').bind(accountId),
    env.DB.prepare('DELETE FROM devices WHERE account_id = ?1').bind(accountId),
    env.DB.prepare('DELETE FROM drops WHERE account_id = ?1').bind(accountId),
    env.DB.prepare('DELETE FROM counters WHERE key IN (?1, ?2)').bind(`xfer:n:${accountId}`, `xfer:b:${accountId}`),
  ]
}

// ---- 临时取件码 (匿名) ----

const dropKey = (id: string) => `drop/${id}`

async function createDrop(request: Request, env: Env): Promise<Response> {
  const body = await readCreateBody(request, 'invalid_drop')
  if (body instanceof Response) return body
  const ttl = body.ttl === undefined || body.ttl === null ? DROP_DEFAULT_TTL : body.ttl
  if (typeof ttl !== 'number' || !DROP_TTLS.includes(ttl)) return fail(400, 'invalid_drop')
  // 可选登录: 有效 Bearer 提高文件上限; 无效 / 缺失按匿名处理, 从不 401
  const session = request.headers.has('authorization') ? await authenticate(request, env) : null
  const item = parseItem(body, session ? MAX_FILE : MAX_DROP_FILE_ANON)
  if (item === 'invalid') return fail(400, 'invalid_drop')
  if (item === 'too_large') return fail(413, 'too_large')

  const now = Date.now()
  const day = today(now)
  if ((await bump(env.DB, await ipRateKey(env, 'drop:c', clientIp(request), day), day)) > DROP_IP_DAILY_CREATES) {
    return fail(429, 'rate_limited', secondsToNextDay(now))
  }

  const id = crypto.randomUUID()
  const ownerToken = base64url(crypto.getRandomValues(new Uint8Array(32)))
  const ownerHash = await sha256Hex(ownerToken)
  const isFile = item.kind === 'file'
  const expiresAt = now + ttl * 1000
  for (let attempt = 0; attempt < DROP_CODE_RETRIES; attempt++) {
    const code = randomCode()
    // 取件码只在未过期的取件里唯一: 先删掉占着这个码的过期取件 (连同其文件), 再插入, 撞上未过期的就换码
    const [expired, inserted] = await env.DB.batch([
      env.DB.prepare('DELETE FROM drops WHERE code = ?1 AND expires_at <= ?2 RETURNING r2_key').bind(code, now),
      env.DB.prepare(
        'INSERT INTO drops(id, code, account_id, owner_hash, kind, title, text, url, r2_key, size, mime, filename, ' +
          'ready, downloads, max_downloads, created_at, expires_at) ' +
          'VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 0, ?14, ?15, ?16) ' +
          'ON CONFLICT(code) DO NOTHING',
      ).bind(
        id, code, session?.account.id ?? null, ownerHash, item.kind, item.title, item.text, item.url,
        isFile ? dropKey(id) : null, item.size, item.mime, item.filename, isFile ? 0 : 1, DROP_MAX_DOWNLOADS,
        now, expiresAt,
      ),
    ])
    const orphans = (expired.results as { r2_key: string | null }[]).map(r => r.r2_key).filter((k): k is string => !!k)
    if (orphans.length) await env.DOCS.delete(orphans)
    if (inserted.meta.changes) {
      return json(201, { id, code, ownerToken, expiresAt, maxDownloads: DROP_MAX_DOWNLOADS })
    }
  }
  return fail(503, 'busy')
}

/** 按 id 取取件并核对 x-drop-token (发送方). 失败返回错误响应 */
async function ownedDrop(request: Request, env: Env, id: string): Promise<DropRow | Response> {
  if (!ID_RE.test(id)) return fail(404, 'not_found')
  const row = await env.DB.prepare('SELECT * FROM drops WHERE id = ?1').bind(id).first<DropRow>()
  if (!row) return fail(404, 'not_found')
  const token = request.headers.get('x-drop-token') ?? ''
  if (!token || token.length > 128 || (await sha256Hex(token)) !== row.owner_hash) return fail(403, 'forbidden')
  return row
}

async function putDropBlob(request: Request, env: Env, id: string): Promise<Response> {
  const tooLarge = declaredTooLarge(request)
  if (tooLarge) return tooLarge
  const row = await ownedDrop(request, env, id)
  if (row instanceof Response) return row
  if (Number(row.expires_at) <= Date.now()) return fail(410, 'gone')
  if (row.kind !== 'file' || !row.r2_key || row.ready) return fail(409, 'already_uploaded')
  const bad = await storeBlob(request, env, row.r2_key, Number(row.size))
  if (bad) return bad
  await env.DB.prepare('UPDATE drops SET ready = 1 WHERE id = ?1').bind(id).run()
  return noContent()
}

async function deleteDrop(request: Request, env: Env, id: string): Promise<Response> {
  const row = await ownedDrop(request, env, id)
  if (row instanceof Response) return row
  if (row.r2_key) await env.DOCS.delete(row.r2_key)
  await env.DB.prepare('DELETE FROM drops WHERE id = ?1').bind(id).run()
  return noContent()
}

/**
 * 取件: 每个 IP 每个 UTC 日查询 60 次; 输错 (查无 / 格式错) 满 10 次后当天所有查询 429.
 * 计数键是 HMAC(日期|IP), 不存原始 IP.
 */
async function getDrop(request: Request, env: Env, code: string, blob: boolean): Promise<Response> {
  const now = Date.now()
  const day = today(now)
  const ip = clientIp(request)
  const missKey = await ipRateKey(env, 'drop:m', ip, day)
  const [misses, lookups] = await env.DB.batch([
    env.DB.prepare('SELECT count FROM counters WHERE key = ?1 AND day = ?2').bind(missKey, day),
    addCount(env.DB, await ipRateKey(env, 'drop:q', ip, day), day, 1),
  ])
  const missCount = Number((misses.results[0] as { count?: number } | undefined)?.count ?? 0)
  const lookupCount = Number((lookups.results[0] as { count?: number } | undefined)?.count ?? 0)
  if (missCount >= DROP_IP_DAILY_MISSES || lookupCount > DROP_IP_DAILY_LOOKUPS) {
    return fail(429, 'rate_limited', secondsToNextDay(now))
  }
  const miss = async (status: number, error: string) => {
    await bump(env.DB, missKey, day)
    return fail(status, error)
  }
  if (!CODE_RE.test(code)) return miss(400, 'invalid_code')

  const row = await env.DB.prepare('SELECT * FROM drops WHERE code = ?1').bind(code).first<DropRow>()
  if (!row || !row.ready) return miss(404, 'not_found')
  if (Number(row.expires_at) <= now || Number(row.downloads) >= Number(row.max_downloads)) return fail(410, 'gone')

  /** 原子地领取一次; 已领完 / 刚过期返回 null */
  const claim = () =>
    env.DB.prepare(
      'UPDATE drops SET downloads = downloads + 1 WHERE id = ?1 AND downloads < max_downloads AND expires_at > ?2 ' +
        'RETURNING downloads',
    )
      .bind(row.id, now)
      .first<{ downloads: number }>()

  if (blob) {
    if (row.kind !== 'file' || !row.r2_key) return fail(404, 'not_found')
    if (!(await claim())) return fail(410, 'gone')
    const obj = await env.DOCS.get(row.r2_key)
    if (!obj) return fail(404, 'not_found')
    return blobResponse(obj, row.filename ?? '')
  }

  // 文字 / 链接: 每次查看算一次领取; 文件: 只看元数据不算, 下载 blob 才算
  let downloads = Number(row.downloads)
  if (row.kind !== 'file') {
    const claimed = await claim()
    if (!claimed) return fail(410, 'gone')
    downloads = Number(claimed.downloads)
  }
  return json(
    200,
    {
      kind: row.kind,
      ...contentFields(row),
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
      downloadsLeft: Math.max(0, Number(row.max_downloads) - downloads),
    },
    { 'cache-control': 'no-store' },
  )
}

/** 分享链接 /d/<code>: 配了 WEB_APP_URL 时跳到网页版互传页, 否则给纯文本说明 (从不返回 HTML) */
function shareLink(env: Env, code: string): Response {
  if (!CODE_RE.test(code)) return fail(404, 'not_found')
  const base = (env.WEB_APP_URL ?? '').split('#')[0]
  if (base) {
    return new Response(null, {
      status: 302,
      headers: { location: `${base}#/transfer?code=${code}`, 'cache-control': 'no-store' },
    })
  }
  return new Response(
    `轻阅取件码 ${code}：打开轻阅 → 互传 → 取件码，输入这 6 位数字。\n` +
      `LightRead pickup code ${code}: open LightRead → Transfer → Pickup code.\n`,
    {
      status: 200,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
      },
    },
  )
}

const DROP_ITEM_RE = /^\/v1\/drops\/([^/]+)$/
const DROP_BLOB_RE = /^\/v1\/drops\/([^/]+)\/blob$/
const SHARE_RE = /^\/d\/([^/]+)$/

/** 取件码接口 (不要求登录). 不是取件码路径时返回 null */
export function routeDrops(request: Request, env: Env, pathname: string): Promise<Response> | Response | null {
  const method = request.method
  if (pathname === '/v1/drops') return method === 'POST' ? createDrop(request, env) : null
  const item = DROP_ITEM_RE.exec(pathname)
  if (item) {
    if (method === 'GET') return getDrop(request, env, item[1], false)
    if (method === 'DELETE') return deleteDrop(request, env, item[1])
    return null
  }
  const blob = DROP_BLOB_RE.exec(pathname)
  if (blob) {
    if (method === 'GET') return getDrop(request, env, blob[1], true)
    if (method === 'PUT') return putDropBlob(request, env, blob[1])
    return null
  }
  const share = SHARE_RE.exec(pathname)
  if (share && method === 'GET') return shareLink(env, share[1])
  return null
}

// ---- 定时清理 ----

/** 按 id 批量删行 (每条语句 ≤ 90 个参数, 合成一个 batch) */
async function deleteIds(db: D1Database, table: 'transfers' | 'drops', ids: string[]): Promise<void> {
  const statements: D1PreparedStatement[] = []
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK)
    statements.push(
      db.prepare(`DELETE FROM ${table} WHERE id IN (${chunk.map((_, j) => `?${j + 1}`).join(', ')})`).bind(...chunk),
    )
  }
  if (statements.length) await db.batch(statements)
}

/**
 * 每日 Cron: 删过期的互传 / 取件 (先删 R2 对象再删行, R2 失败时行保留到下次),
 * 以及 90 天没见过的设备登记.
 */
export async function cleanupExpired(env: Env, now = Date.now()): Promise<void> {
  for (const table of ['transfers', 'drops'] as const) {
    for (let round = 0; round < CLEANUP_ROUNDS; round++) {
      const { results } = await env.DB.prepare(
        `SELECT id, r2_key FROM ${table} WHERE expires_at < ?1 ORDER BY expires_at LIMIT ?2`,
      )
        .bind(now, CLEANUP_BATCH)
        .all<{ id: string; r2_key: string | null }>()
      if (!results.length) break
      const keys = results.map(r => r.r2_key).filter((k): k is string => !!k)
      if (keys.length) await env.DOCS.delete(keys)
      await deleteIds(env.DB, table, results.map(r => r.id))
      if (results.length < CLEANUP_BATCH) break
    }
  }
  await env.DB.prepare('DELETE FROM devices WHERE last_seen_at < ?1').bind(now - DEVICE_TTL).run()
}
