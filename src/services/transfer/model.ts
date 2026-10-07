/**
 * 互传的纯函数: 输入校验、条目解析、合并排序、新条目检测、文件名. 不依赖 vue / DOM, 可在 node 里测试.
 */
import { DAY_MS, LIMITS, type ChannelId, type SendInput, type TransferItem, type TransferKind } from './types.ts'

export const utf8Bytes = (s: string) => new TextEncoder().encode(s).length

/** 整段是一个 http(s) 链接 (不含空白) */
export function looksLikeUrl(text: string): boolean {
  const s = text.trim()
  if (!/^https?:\/\/\S+$/i.test(s) || s.length > LIMITS.urlChars) return false
  try {
    const u = new URL(s)
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname
  } catch {
    return false
  }
}

/** 输入框内容 + 可选文件 → 发送内容: 有文件发文件; 整段是链接发链接; 否则发文字 */
export function composeInput(text: string, file?: { blob: Blob; name: string } | null): SendInput | null {
  if (file) {
    return { kind: 'file', file: file.blob, filename: file.name, mime: file.blob.type || undefined, title: text.trim() || undefined }
  }
  const s = text.trim()
  if (!s) return null
  if (looksLikeUrl(s)) return { kind: 'link', url: s }
  return { kind: 'text', text }
}

export interface Invalid {
  key: string
  params?: Record<string, string | number>
}

/** 发送前的本地校验 (与服务端一致), 通过返回 null */
export function validateSend(input: SendInput, maxFileBytes: number = LIMITS.fileBytes): Invalid | null {
  if ((input.title ?? '').length > LIMITS.titleChars) return { key: 'transfer.err.titleTooLong', params: { max: LIMITS.titleChars } }
  if (input.kind === 'text') {
    if (!input.text?.trim()) return { key: 'transfer.err.empty' }
    if (utf8Bytes(input.text) > LIMITS.textBytes) return { key: 'transfer.err.textTooLong', params: { max: '64 KB' } }
    return null
  }
  if (input.kind === 'link') {
    if (!input.url || !looksLikeUrl(input.url)) return { key: 'transfer.err.badUrl' }
    return null
  }
  if (input.kind === 'file') {
    if (!input.file || !input.filename) return { key: 'transfer.err.empty' }
    if (input.file.size <= 0) return { key: 'transfer.err.emptyFile' }
    if (input.file.size > maxFileBytes) return { key: 'transfer.err.fileTooLarge', params: { max: formatBytes(maxFileBytes) } }
    return null
  }
  return { key: 'transfer.err.empty' }
}

const KINDS = new Set<TransferKind>(['text', 'link', 'file'])
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** 服务端 / WebDAV 上的条目 JSON → TransferItem; 不合法返回 null */
export function parseItem(v: unknown, channel: ChannelId): TransferItem | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const id = str(o.id)
  const kind = o.kind as TransferKind
  const createdAt = num(o.createdAt)
  if (!id || !KINDS.has(kind) || createdAt === undefined) return null
  const item: TransferItem = {
    id,
    channel,
    kind,
    fromDevice: str(o.fromDevice),
    fromName: str(o.fromName),
    toDevice: typeof o.toDevice === 'string' && o.toDevice ? o.toDevice : null,
    title: str(o.title),
    createdAt,
    expiresAt: num(o.expiresAt) ?? createdAt + LIMITS.keepMs,
  }
  if (typeof o.text === 'string') item.text = o.text
  if (typeof o.url === 'string') item.url = o.url
  if (typeof o.filename === 'string') item.filename = o.filename
  if (num(o.size) !== undefined) item.size = num(o.size)
  if (typeof o.mime === 'string') item.mime = o.mime
  if (typeof o.code === 'string') item.code = o.code
  if (num(o.downloadsLeft) !== undefined) item.downloadsLeft = num(o.downloadsLeft)
  if (typeof o.ownerToken === 'string') item.ownerToken = o.ownerToken
  if (kind === 'text' && item.text === undefined) return null
  if (kind === 'link' && !item.url) return null
  if (kind === 'file' && !item.filename) return null
  return item
}

export const itemKey = (item: Pick<TransferItem, 'channel' | 'id'>) => `${item.channel}:${item.id}`

/** 多个通道的条目合并: 去重, 新到旧 */
export function mergeItems(...lists: TransferItem[][]): TransferItem[] {
  const map = new Map<string, TransferItem>()
  for (const list of lists) for (const it of list) map.set(itemKey(it), it)
  return [...map.values()].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
}

/** 本机发出的 */
export function isOutgoing(item: TransferItem, me: string): boolean {
  if (item.channel === 'drop') return !!item.ownerToken
  return !!me && item.fromDevice === me
}

/** 是发给本机的 (本机收到的) */
export function isIncomingFor(item: TransferItem, me: string): boolean {
  if (isOutgoing(item, me)) return false
  return item.toDevice === null || item.toDevice === me
}

/**
 * 新收到的条目: 发给本机、未见过、未过期. 首次运行 (还没有已见记录) 只提醒最近 24 小时内的.
 */
export function findNew(
  items: TransferItem[],
  seen: ReadonlySet<string>,
  me: string,
  now: number,
  firstRun: boolean,
): TransferItem[] {
  return items.filter(it =>
    isIncomingFor(it, me) && !seen.has(it.id) && it.expiresAt > now
    && (!firstRun || now - it.createdAt < DAY_MS))
}

/** 已见 id 记录: 新 id 放在前面, 最多保留 limit 个 */
export function rememberSeen(prev: string[], ids: string[], limit = 1000): string[] {
  const out = [...new Set([...ids, ...prev])]
  return out.slice(0, limit)
}

/** 按发出设备分组计数 (提醒文案「收到来自「设备名」的 N 条」) */
export function groupBySender(items: TransferItem[]): Array<{ name: string; count: number }> {
  const map = new Map<string, number>()
  for (const it of items) map.set(it.fromName, (map.get(it.fromName) ?? 0) + 1)
  return [...map.entries()].map(([name, count]) => ({ name, count }))
}

/** 文件名清理: 去掉路径与控制字符, 限 255 字符, 保留扩展名 */
export function safeFilename(name: string, fallback = 'file'): string {
  let s = name.replace(/[\u0000-\u001f\u007f]/g, '').split(/[\\/]/).pop()!.trim()
  s = s.replace(/^\.+/, '')
  if (!s) s = fallback
  if (s.length > 255) {
    const ext = extOf(s)
    s = s.slice(0, 255 - ext.length - 1) + (ext ? `.${ext}` : '')
  }
  return s
}

/** 小写扩展名 (不含点); 没有返回空串 */
export function extOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(name)
  return m ? m[1].toLowerCase() : ''
}

/** 文字存为 TXT 时的文件名: 标题或首行 (最多 40 字) */
export function textFileName(item: Pick<TransferItem, 'title' | 'text'>): string {
  const base = (item.title || (item.text ?? '').split(/\r?\n/).find(l => l.trim()) || '').trim().slice(0, 40)
  return safeFilename(`${base || 'text'}.txt`, 'text.txt')
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

type Tr = (key: string, params?: Record<string, string | number>) => string

/** 时长 (毫秒) → 「x 秒 / x 分钟 / x 小时 / x 天」, 向上取整 */
export function durationText(ms: number, tr: Tr): string {
  const s = Math.max(1, Math.ceil(ms / 1000))
  if (s < 90) return tr('transfer.wait.seconds', { n: s })
  if (s < 59 * 60) return tr('transfer.wait.minutes', { n: Math.ceil(s / 60) })
  if (s < 36 * 3600) return tr('transfer.wait.hours', { n: Math.ceil(s / 3600) })
  return tr('transfer.wait.days', { n: Math.ceil(s / 86400) })
}

/** 时间点 → 「刚刚 / x 分钟前 / x 小时前 / 月日 时分」 */
export function relativeTime(ts: number, now: number, tr: Tr, locale = 'zh-CN'): string {
  const d = now - ts
  if (d < 60_000) return tr('transfer.justNow')
  if (d < 3600_000) return tr('transfer.minutesAgo', { n: Math.floor(d / 60_000) })
  if (d < 6 * 3600_000) return tr('transfer.hoursAgo', { n: Math.floor(d / 3600_000) })
  return new Date(ts).toLocaleString(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// ---- WebDAV 布局 ----

/** 条目文件名的主干: item-<创建时间毫秒>-<随机> */
export function webdavStem(createdAt: number, rand: string): string {
  return `item-${createdAt}-${rand.replace(/[^A-Za-z0-9]/g, '').slice(0, 16)}`
}

/** 解析 WebDAV 目录里的文件名; 不认识的返回 null */
export function parseWebdavName(name: string):
  | { type: 'item'; stem: string; createdAt: number; json: boolean }
  | { type: 'device'; deviceId: string }
  | null {
  const m = /^(item-(\d{10,16})-[A-Za-z0-9]{1,16})(?:\.([A-Za-z0-9]{1,10}))?$/.exec(name)
  if (m) return { type: 'item', stem: m[1], createdAt: Number(m[2]), json: m[3] === 'json' }
  const d = /^device-([A-Za-z0-9_-]{1,64})\.json$/.exec(name)
  if (d) return { type: 'device', deviceId: d[1] }
  return null
}

/** 取件码: 去掉空白与连字符后须为 6 位数字 */
export function normalizeCode(raw: string): string | null {
  const s = raw.replace(/[\s-]/g, '')
  return /^\d{6}$/.test(s) ? s : null
}

/**
 * 取件码的分享链接: 网页版用当前网页地址 (<origin><path>#/transfer?code=…);
 * 桌面 / 安卓没有网页地址, 用同步服务的 /d/<code> (Worker 配了 WEB_APP_URL 时跳转到网页版).
 */
export function dropShareLink(code: string, apiBase: string, webAppBase?: string | null): string {
  if (webAppBase) return `${webAppBase.replace(/#.*$/, '')}#/transfer?code=${code}`
  return `${apiBase.replace(/\/+$/, '')}/d/${code}`
}

/** 从链接 / 文本里找取件码 (#/transfer?code=123456 或 /d/123456) */
export function codeFromLink(raw: string): string | null {
  const s = raw.trim()
  const direct = normalizeCode(s)
  if (direct) return direct
  const m = /[?&]code=(\d{6})\b/.exec(s) ?? /\/d\/(\d{6})\b/.exec(s)
  return m ? m[1] : null
}
