/**
 * 互传 · WebDAV 通道 (不需要轻阅账号, 与 WebDAV 同步共用配置与凭据). 布局见 docs/device-transfer.md:
 *   <webdavUrl>/LightRead/transfer/item-<创建时间>-<随机>.json   条目
 *   <webdavUrl>/LightRead/transfer/item-<创建时间>-<随机>.<ext>  文件本体 (先传, 再写 json)
 *   <webdavUrl>/LightRead/transfer/device-<deviceId>.json        设备登记, 每台设备每天至多写一次
 * 一次轮询 = 一次 PROPFIND depth 1, 只 GET 没见过的 json; 过期条目由轮询的设备顺手删除.
 * HTTP 沿用同步的默认实现 (网页版坚果云 / Koofr 经中转, 桌面 / 安卓 PUT 走原生上传).
 */
import { defaultHttp, parsePropfindNames, type HttpFn, type HttpRequest, type WebdavConfig } from '../sync/webdavRemote.ts'
import { errorFor } from './http.ts'
import { extOf, parseItem, parseWebdavName, validateSend, webdavStem } from './model.ts'
import {
  LIMITS, TransferError,
  type SendInput, type TransferChannel, type TransferDevice, type TransferItem, type TranslateFn,
} from './types.ts'

export const WEBDAV_POLL_MS = 2 * 60_000
const REQUEST_TIMEOUT_MS = 60_000
const TRANSFER_TIMEOUT_MS = 30 * 60_000
/** 每次轮询最多顺手删除的过期条目数 */
const CLEANUP_PER_POLL = 10
const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>'

/** 简单的键值存储 (默认 localStorage; 测试注入内存实现) */
export interface Kv {
  get(key: string): string | null
  set(key: string, value: string): void
}

const localKv: Kv = {
  get(key) {
    try { return localStorage.getItem(key) } catch { return null }
  },
  set(key, value) {
    try { localStorage.setItem(key, value) } catch { /* 存储不可用 */ }
  },
}

export interface WebdavChannelDeps {
  http?: HttpFn
  translate?: TranslateFn
  now?: () => number
  kv?: Kv
  rand?: () => string
}

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

const randomStem = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6)

/** 条目的文件本体名: <id>.<扩展名> (无扩展名用 bin) */
export const webdavBlobName = (item: Pick<TransferItem, 'id' | 'filename'>) =>
  `${item.id}.${extOf(item.filename ?? '') || 'bin'}`

export function createWebdavChannel(
  cfg: WebdavConfig,
  me: { deviceId: string; deviceName: string },
  deps: WebdavChannelDeps = {},
): TransferChannel {
  const http = deps.http ?? defaultHttp(cfg)
  const now = deps.now ?? Date.now
  const kv = deps.kv ?? localKv
  const rand = deps.rand ?? randomStem
  const tr = deps.translate
  const base = cfg.url.trim().replace(/\/+$/, '')
  const parent = `${base}/LightRead/`
  const dir = `${parent}transfer/`
  const regKey = `lightread-transfer-webdav-reg:${base}#${cfg.user}`

  /** stem → 条目 (null = 损坏 / 已删除); 只缓存在本次运行 */
  const items = new Map<string, TransferItem | null>()
  const deviceCache = new Map<string, TransferDevice | null>()
  let lastNames: string[] | null = null
  let dirReady = false

  interface Res { status: number; text: string; blob: Blob | null }
  const request = async (
    url: string,
    req: HttpRequest,
    opts: { allow?: number[]; read?: 'text' | 'blob'; timeoutMs?: number } = {},
  ): Promise<Res> => {
    const { allow = [], read, timeoutMs = REQUEST_TIMEOUT_MS } = opts
    const ctrl = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ctrl.abort()
        reject(new Error('timeout'))
      }, timeoutMs)
    })
    const work = (async (): Promise<Res> => {
      const res = await http(url, { ...req, signal: ctrl.signal })
      if (res.status >= 400 && !allow.includes(res.status)) {
        if (res.status === 401) {
          throw new TransferError(tr ? tr('sync.err.auth') : 'sync.err.auth', 401, 'auth')
        }
        throw await errorFor(res.status, '', tr)
      }
      const ok = res.status < 400
      return {
        status: res.status,
        text: read === 'text' && ok ? await res.text() : '',
        blob: read === 'blob' && ok ? await res.blob() : null,
      }
    })()
    try {
      return await Promise.race([work, deadline])
    } catch (err) {
      if (err instanceof TransferError) throw err
      throw await errorFor(0, '', tr)
    } finally {
      clearTimeout(timer)
    }
  }
  const missing = (status: number) => status === 404 || status === 409

  async function listNames(): Promise<string[]> {
    const res = await request(dir, {
      method: 'PROPFIND',
      headers: { depth: '1', 'content-type': 'application/xml; charset=utf-8' },
      body: PROPFIND_BODY,
    }, { allow: [404, 409], read: 'text' })
    if (missing(res.status)) {
      dirReady = false
      return []
    }
    dirReady = true
    return parsePropfindNames(res.text, 'transfer')
  }

  async function ensureDir() {
    if (dirReady) return
    for (const url of [parent, dir]) {
      // 405: 已存在
      await request(url, { method: 'MKCOL' }, { allow: [405] })
    }
    dirReady = true
  }

  const del = (name: string) =>
    request(dir + encodeURIComponent(name), { method: 'DELETE' }, { allow: [404, 409] })

  async function putJson(name: string, value: unknown) {
    await request(dir + encodeURIComponent(name), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(value),
    })
  }

  /** 设备登记: 目录里没有本机的登记文件, 或本机今天还没写过 */
  async function register(names: string[]) {
    const today = new Date(now()).toISOString().slice(0, 10)
    const file = `device-${me.deviceId}.json`
    if (names.includes(file) && kv.get(regKey) === today) return
    await ensureDir()
    await putJson(file, { id: me.deviceId, name: me.deviceName, lastSeenAt: now() })
    kv.set(regKey, today)
  }

  const visible = (it: TransferItem) =>
    it.fromDevice === me.deviceId
    || ((it.toDevice === null || it.toDevice === me.deviceId) && it.fromDevice !== me.deviceId)

  return {
    id: 'webdav',
    pollIntervalMs: WEBDAV_POLL_MS,

    async devices() {
      const names = lastNames ?? await listNames()
      lastNames = names
      const files = names.filter(n => parseWebdavName(n)?.type === 'device')
      const out = await mapLimit(files, 4, async name => {
        if (deviceCache.has(name)) return deviceCache.get(name)!
        const res = await request(dir + encodeURIComponent(name), { method: 'GET' }, { allow: [404], read: 'text' })
        let dev: TransferDevice | null = null
        try {
          const o = JSON.parse(res.text) as Record<string, unknown>
          if (typeof o.id === 'string' && o.id) {
            dev = { id: o.id, name: typeof o.name === 'string' ? o.name : '', lastSeenAt: Number(o.lastSeenAt) || 0 }
          }
        } catch { /* 损坏 / 不存在 */ }
        deviceCache.set(name, dev)
        return dev
      })
      return out
        .filter((d): d is TransferDevice => !!d && d.id !== me.deviceId)
        .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    },

    async list(since) {
      const names = await listNames()
      lastNames = names
      const t = now()
      const stems = new Map<string, { createdAt: number; files: string[]; json: boolean }>()
      for (const name of names) {
        const p = parseWebdavName(name)
        if (p?.type !== 'item') continue
        const e = stems.get(p.stem) ?? { createdAt: p.createdAt, files: [], json: false }
        e.files.push(name)
        if (p.json) e.json = true
        stems.set(p.stem, e)
      }
      // 过期的顺手删掉 (先删 json, 别的设备就不会再读到它)
      const expired = [...stems.entries()]
        .filter(([, e]) => e.createdAt + LIMITS.keepMs < t)
        .slice(0, CLEANUP_PER_POLL)
      for (const [stem, e] of expired) {
        const ordered = [...e.files].sort((a, b) => Number(b.endsWith('.json')) - Number(a.endsWith('.json')))
        try {
          for (const f of ordered) await del(f)
        } catch { /* 清理失败不影响本次列表 */ }
        stems.delete(stem)
        items.delete(stem)
      }
      if (me.deviceId) await register(names).catch(err => console.warn('[transfer] webdav register failed', err))

      const wanted = [...stems.entries()]
        .filter(([, e]) => e.json && e.createdAt + LIMITS.keepMs >= t && (!since || e.createdAt > since - 60_000))
        .map(([stem]) => stem)
      await mapLimit(wanted.filter(s => !items.has(s)), 4, async stem => {
        const res = await request(dir + encodeURIComponent(`${stem}.json`), { method: 'GET' }, { allow: [404], read: 'text' })
        let item: TransferItem | null = null
        try {
          item = res.status === 404 ? null : parseItem(JSON.parse(res.text), 'webdav')
        } catch { /* 损坏的文件跳过 */ }
        if (item && item.id !== stem) item = null
        items.set(stem, item)
      })
      // 目录里已没有的 (别的设备删了) 从缓存里去掉
      for (const stem of [...items.keys()]) if (!stems.has(stem)) items.delete(stem)
      return wanted
        .map(s => items.get(s))
        .filter((it): it is TransferItem => !!it && visible(it) && (!since || it.createdAt > since))
        .sort((a, b) => b.createdAt - a.createdAt)
    },

    async send(input: SendInput, opts = {}) {
      const invalid = validateSend(input, LIMITS.fileBytes)
      if (invalid) throw new TransferError(tr ? tr(invalid.key, invalid.params) : invalid.key, -1, 'invalid')
      await ensureDir()
      const createdAt = now()
      const stem = webdavStem(createdAt, rand())
      const item: TransferItem = {
        id: stem,
        channel: 'webdav',
        kind: input.kind,
        fromDevice: me.deviceId,
        fromName: me.deviceName,
        toDevice: input.toDevice ?? null,
        title: (input.title ?? '').trim(),
        createdAt,
        expiresAt: createdAt + LIMITS.keepMs,
      }
      if (input.kind === 'text') item.text = input.text
      if (input.kind === 'link') item.url = input.url!.trim()
      if (input.kind === 'file') {
        item.filename = input.filename
        item.size = input.file!.size
        if (input.mime) item.mime = input.mime
        // WebDAV 上传拿不到字节级进度 (网页版走中转 / 原生上传), 显示不确定进度
        opts.onProgress?.(null)
        const size = input.file!.size
        await request(dir + encodeURIComponent(webdavBlobName(item)), {
          method: 'PUT',
          headers: { 'content-type': 'application/octet-stream' },
          body: input.file!,
        }, { timeoutMs: Math.min(TRANSFER_TIMEOUT_MS, 60_000 + Math.ceil(size / (1024 * 1024)) * 10_000) })
      }
      const { channel: _channel, ...stored } = item
      await putJson(`${stem}.json`, { format: 1, ...stored, ...(input.kind === 'file' ? { blob: webdavBlobName(item) } : {}) })
      items.set(stem, item)
      opts.onProgress?.(1)
      return item
    },

    async fetchBlob(item, opts = {}) {
      opts.onProgress?.(null)
      const res = await request(dir + encodeURIComponent(webdavBlobName(item)), { method: 'GET' }, {
        allow: [404], read: 'blob', timeoutMs: TRANSFER_TIMEOUT_MS,
      })
      if (res.status === 404 || !res.blob) throw await errorFor(404, '', tr)
      opts.onProgress?.(1)
      return res.blob
    },

    async remove(item) {
      await del(`${item.id}.json`)
      if (item.kind === 'file') await del(webdavBlobName(item))
      items.delete(item.id)
    },
  }
}
