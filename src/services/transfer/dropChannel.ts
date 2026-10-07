/**
 * 互传 · 临时取件码 (不需要登录, sync.jiangshu.ai /v1/drops, 见 docs/device-transfer.md).
 * 发送方拿到 6 位取件码; 接收方输入取件码 / 扫码 / 打开链接取件.
 * 服务端不按设备列条目: 本机发出的与取到的都只记在本机 (localStorage `lightread-transfer-drops`).
 */
import { defaultTransport, downloadBlob, jsonCall, uploadBlob, type Transport } from './http.ts'
import { normalizeCode, parseItem, validateSend } from './model.ts'
import {
  DAY_MS, DROP_TTLS, LIMITS, TransferError,
  type ProgressOpts, type SendInput, type TransferChannel, type TransferItem, type TranslateFn,
} from './types.ts'

export interface DropChannelConfig {
  base: string
  /** 已登录时带上 (单件上限 50 MB, 否则 20 MB) */
  token?: string
  deviceId: string
  deviceName: string
}

/** 本机记录 (发出的取件与取到的内容) */
export interface DropStore {
  load(): TransferItem[]
  save(items: TransferItem[]): void
}

const STORE_KEY = 'lightread-transfer-drops'
/** 本机记录最多保留条数与时长 */
const KEEP_COUNT = 50
const KEEP_MS = 7 * DAY_MS

export const localDropStore: DropStore = {
  load() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]')
      return Array.isArray(raw) ? raw.map(v => parseItem(v, 'drop')).filter((v): v is TransferItem => !!v) : []
    } catch {
      return []
    }
  },
  save(items) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(items)) } catch { /* 存储不可用 */ }
  },
}

export function createMemoryDropStore(): DropStore {
  let items: TransferItem[] = []
  return { load: () => structuredClone(items), save: v => { items = structuredClone(v) } }
}

export interface DropChannel extends TransferChannel {
  /** 用取件码取件 (文字 / 链接直接带内容; 文件只带信息, 再 fetchBlob) */
  lookup(code: string): Promise<TransferItem>
  maxFileBytes(): number
}

export function createDropChannel(
  cfg: DropChannelConfig,
  transport: Transport = defaultTransport,
  translate?: TranslateFn,
  store: DropStore = localDropStore,
  now: () => number = Date.now,
): DropChannel {
  const base = cfg.base.trim().replace(/\/+$/, '')
  const tr = (key: string, params?: Record<string, string | number>) => (translate ? translate(key, params) : key)
  const maxFileBytes = () => (cfg.token ? LIMITS.dropAuthBytes : LIMITS.dropAnonBytes)

  function remember(item: TransferItem) {
    const t = now()
    const rest = store.load().filter(it => it.id !== item.id && t - it.createdAt < KEEP_MS)
    store.save([item, ...rest].slice(0, KEEP_COUNT))
  }

  return {
    id: 'drop',
    pollIntervalMs: 0,
    maxFileBytes,

    async devices() {
      return []
    },

    async list() {
      const t = now()
      return store.load()
        .filter(it => t - it.createdAt < KEEP_MS)
        .sort((a, b) => b.createdAt - a.createdAt)
    },

    async send(input: SendInput, opts: ProgressOpts = {}) {
      const invalid = validateSend(input, maxFileBytes())
      if (invalid) throw new TransferError(tr(invalid.key, invalid.params), -1, 'invalid')
      const ttlMs = (DROP_TTLS as readonly number[]).includes(input.ttlMs ?? 0) ? input.ttlMs! : DROP_TTLS[1]
      const body: Record<string, unknown> = { kind: input.kind, title: (input.title ?? '').trim(), ttl: ttlMs / 1000 }
      if (input.kind === 'text') body.text = input.text
      if (input.kind === 'link') body.url = input.url!.trim()
      if (input.kind === 'file') {
        body.filename = input.filename
        body.size = input.file!.size
        if (input.mime) body.mime = input.mime
      }
      const res = await jsonCall<{ id?: unknown; code?: unknown; ownerToken?: unknown; expiresAt?: unknown; maxDownloads?: unknown }>(
        base, { method: 'POST', path: '/v1/drops', body, token: cfg.token }, transport, translate)
      const id = typeof res?.id === 'string' ? res.id : ''
      const code = typeof res?.code === 'string' ? res.code : ''
      const ownerToken = typeof res?.ownerToken === 'string' ? res.ownerToken : ''
      if (!id || !code || !ownerToken) throw new TransferError(tr('transfer.err.server', { status: 200 }), 200)
      if (input.kind === 'file') {
        try {
          await uploadBlob(`${base}/v1/drops/${encodeURIComponent(id)}/blob`, input.file!, { 'x-drop-token': ownerToken },
            transport, opts, translate)
        } catch (err) {
          await jsonCall(base, { method: 'DELETE', path: `/v1/drops/${encodeURIComponent(id)}`, headers: { 'x-drop-token': ownerToken } },
            transport, translate).catch(() => undefined)
          throw err
        }
      } else {
        opts.onProgress?.(1)
      }
      const createdAt = now()
      const item: TransferItem = {
        id,
        channel: 'drop',
        kind: input.kind,
        fromDevice: cfg.deviceId,
        fromName: cfg.deviceName,
        toDevice: null,
        title: (input.title ?? '').trim(),
        createdAt,
        expiresAt: Number(res?.expiresAt) || createdAt + ttlMs,
        code,
        ownerToken,
        downloadsLeft: Number(res?.maxDownloads) || 10,
      }
      if (input.kind === 'text') item.text = input.text
      if (input.kind === 'link') item.url = input.url!.trim()
      if (input.kind === 'file') {
        item.filename = input.filename
        item.size = input.file!.size
        if (input.mime) item.mime = input.mime
      }
      remember(item)
      return item
    },

    async lookup(raw: string) {
      const code = normalizeCode(raw)
      if (!code) throw new TransferError(tr('transfer.err.badCode'), -1, 'invalid_code')
      const res = await jsonCall<Record<string, unknown>>(base, { method: 'GET', path: `/v1/drops/${code}` }, transport, translate)
      const createdAt = Number(res?.createdAt) || now()
      const item = parseItem({
        ...res,
        id: `code-${code}-${createdAt}`,
        fromDevice: '',
        fromName: '',
        toDevice: null,
        createdAt,
        code,
      }, 'drop')
      if (!item) throw new TransferError(tr('transfer.err.server', { status: 200 }), 200)
      remember(item)
      return item
    },

    fetchBlob(item, opts = {}) {
      if (!item.code) return Promise.reject(new TransferError(tr('transfer.err.notFound'), 404))
      return downloadBlob(`${base}/v1/drops/${item.code}/blob`, {}, transport, opts, translate)
    },

    async remove(item) {
      if (item.ownerToken) {
        try {
          await jsonCall(base, {
            method: 'DELETE', path: `/v1/drops/${encodeURIComponent(item.id)}`, headers: { 'x-drop-token': item.ownerToken },
          }, transport, translate)
        } catch (err) {
          // 已过期 / 已被清理: 本机记录照删
          if (!(err instanceof TransferError) || (err.status !== 404 && err.status !== 410)) throw err
        }
      }
      store.save(store.load().filter(it => it.id !== item.id))
    },
  }
}
