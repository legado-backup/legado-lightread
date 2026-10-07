/**
 * 互传 (设备间发送文字 / 链接 / 文件) 的通道接口. 设计见 docs/device-transfer.md.
 * 与同步的 SyncRemote 一样只换传输层: 轻阅账号 / WebDAV / 临时取件码, 界面只有一套.
 * 本模块不依赖 vue / pinia, 可在 node 里测试.
 */

export type TransferKind = 'text' | 'link' | 'file'
export type ChannelId = 'account' | 'webdav' | 'drop'

export interface TransferItem {
  id: string
  channel: ChannelId
  kind: TransferKind
  /** 发出设备的 deviceId (取件码收到的条目为空串) */
  fromDevice: string
  fromName: string
  /** 目标设备; null = 我的其他全部设备 */
  toDevice: string | null
  title: string
  text?: string
  url?: string
  filename?: string
  size?: number
  mime?: string
  createdAt: number
  expiresAt: number
  /** 取件码 (仅 drop) */
  code?: string
  /** 剩余可领取次数 (仅收到的 drop) */
  downloadsLeft?: number
  /** 发送方撤回取件所用的令牌 (仅自己发出的 drop, 只存本机) */
  ownerToken?: string
}

export interface TransferDevice {
  id: string
  name: string
  lastSeenAt: number
}

export interface SendInput {
  kind: TransferKind
  /** null / 缺省 = 我的其他全部设备 */
  toDevice?: string | null
  title?: string
  text?: string
  url?: string
  file?: Blob
  filename?: string
  mime?: string
  /** 仅取件码: 有效期 (毫秒), 10 分钟或 1 小时 */
  ttlMs?: number
}

/** fraction 为 0–1; null 表示进度未知 (显示不确定进度条) */
export type ProgressFn = (fraction: number | null) => void

export interface ProgressOpts {
  onProgress?: ProgressFn
  signal?: AbortSignal
}

export interface TransferChannel {
  readonly id: ChannelId
  /** 后台轮询间隔; 0 = 不轮询 (取件码) */
  readonly pollIntervalMs: number
  /** 可选的目标设备 (不含本机) */
  devices(): Promise<TransferDevice[]>
  /** 本机可见的条目: 发给本机的、发给全部且不是本机发的、本机发出的. 新到旧 */
  list(since?: number): Promise<TransferItem[]>
  send(input: SendInput, opts?: ProgressOpts): Promise<TransferItem>
  fetchBlob(item: TransferItem, opts?: ProgressOpts): Promise<Blob>
  /** 删除 (对所有设备生效) */
  remove(item: TransferItem): Promise<void>
}

export const KB = 1024
export const MB = 1024 * 1024
export const DAY_MS = 24 * 60 * 60 * 1000

/** 与服务端一致的上限 (见 docs/account-api.md「互传」) */
export const LIMITS = {
  textBytes: 64 * KB,
  urlChars: 4096,
  titleChars: 300,
  fileBytes: 50 * MB,
  dropAnonBytes: 20 * MB,
  dropAuthBytes: 50 * MB,
  /** 账号 / WebDAV 条目保留 7 天 */
  keepMs: 7 * DAY_MS,
} as const

/** 取件码有效期可选值 */
export const DROP_TTLS = [10 * 60 * 1000, 60 * 60 * 1000] as const

export type TranslateFn = (key: string, params?: Record<string, string | number>) => string

/** 互传请求的错误; message 已本地化 */
export class TransferError extends Error {
  /** HTTP 状态; 0 为网络错误 / 超时; -1 为本地校验失败 */
  readonly status: number
  readonly code: string
  readonly retryAfter?: number

  constructor(message: string, status: number, code = '', retryAfter?: number) {
    super(message)
    this.name = 'TransferError'
    this.status = status
    this.code = code
    if (retryAfter !== undefined) this.retryAfter = retryAfter
  }
}
