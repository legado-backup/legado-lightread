/**
 * 互传 · 轻阅账号通道 (sync.jiangshu.ai, 接口见 docs/account-api.md「互传」).
 * 文件: 先 POST 建记录, 再 PUT /v1/transfers/:id/blob 上传本体 (带进度).
 */
import { defaultTransport, downloadBlob, jsonCall, uploadBlob, type Transport } from './http.ts'
import { parseItem, validateSend } from './model.ts'
import {
  LIMITS, TransferError,
  type ProgressOpts, type SendInput, type TransferChannel, type TransferDevice, type TransferItem, type TranslateFn,
} from './types.ts'

export interface AccountChannelConfig {
  base: string
  token: string
  deviceId: string
  deviceName: string
}

export const ACCOUNT_POLL_MS = 30_000

export function createAccountChannel(
  cfg: AccountChannelConfig,
  transport: Transport = defaultTransport,
  translate?: TranslateFn,
): TransferChannel {
  const base = cfg.base.trim().replace(/\/+$/, '')
  const auth = { authorization: `Bearer ${cfg.token}` }
  const call = <T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) =>
    jsonCall<T>(base, { method, path, body, token: cfg.token }, transport, translate)
  const parse = (v: unknown) => parseItem(v, 'account')

  return {
    id: 'account',
    pollIntervalMs: ACCOUNT_POLL_MS,

    async devices() {
      const res = await call<{ devices?: unknown }>('GET', '/v1/devices')
      const list = Array.isArray(res?.devices) ? res.devices : []
      return list
        .map((d): TransferDevice | null => {
          const o = d as Record<string, unknown>
          if (!o || typeof o.id !== 'string' || !o.id) return null
          return { id: o.id, name: typeof o.name === 'string' ? o.name : '', lastSeenAt: Number(o.lastSeenAt) || 0 }
        })
        .filter((d): d is TransferDevice => !!d && d.id !== cfg.deviceId)
    },

    async list(since) {
      const q = new URLSearchParams({ device: cfg.deviceId, name: cfg.deviceName })
      if (since !== undefined && since > 0) q.set('since', String(Math.floor(since)))
      const res = await call<{ items?: unknown }>('GET', `/v1/transfers?${q}`)
      const items = Array.isArray(res?.items) ? res.items : []
      return items.map(parse).filter((it): it is TransferItem => !!it)
    },

    async send(input: SendInput, opts: ProgressOpts = {}) {
      const invalid = validateSend(input, LIMITS.fileBytes)
      if (invalid) throw new TransferError(translate ? translate(invalid.key, invalid.params) : invalid.key, -1, 'invalid')
      const body: Record<string, unknown> = {
        kind: input.kind,
        fromDevice: cfg.deviceId,
        fromName: cfg.deviceName,
        toDevice: input.toDevice ?? null,
        title: input.title ?? '',
      }
      if (input.kind === 'text') body.text = input.text
      if (input.kind === 'link') body.url = input.url
      if (input.kind === 'file') {
        body.filename = input.filename
        body.size = input.file!.size
        if (input.mime) body.mime = input.mime
      }
      const res = await call<{ item?: unknown }>('POST', '/v1/transfers', body)
      const item = parse(res?.item)
      if (!item) throw new TransferError(translate ? translate('transfer.err.server', { status: 200 }) : 'bad response', 200)
      if (input.kind === 'file') {
        try {
          await uploadBlob(`${base}/v1/transfers/${encodeURIComponent(item.id)}/blob`, input.file!, auth, transport, opts, translate)
        } catch (err) {
          // 上传失败: 删掉半成品记录 (尽力而为, 服务端 24 小时后也会清理)
          await call('DELETE', `/v1/transfers/${encodeURIComponent(item.id)}`).catch(() => undefined)
          throw err
        }
      } else {
        opts.onProgress?.(1)
      }
      return item
    },

    fetchBlob(item, opts = {}) {
      return downloadBlob(`${base}/v1/transfers/${encodeURIComponent(item.id)}/blob`, auth, transport, opts, translate)
    },

    async remove(item) {
      try {
        await call('DELETE', `/v1/transfers/${encodeURIComponent(item.id)}`)
      } catch (err) {
        // 已被别的设备删掉 / 已过期: 视为成功
        if (err instanceof TransferError && err.status === 404) return
        throw err
      }
    },
  }
}
