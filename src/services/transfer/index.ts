/**
 * 互传对外接口 (互传页 / App 壳 / 书卡片 / 阅读器调用). 通道实现见同目录, 设计见 docs/device-transfer.md.
 *  - 可用通道: 已登录 → 轻阅账号; 已配置 WebDAV → WebDAV; 取件码始终可用
 *  - 轮询: 启动时、窗口获得焦点 / 回到前台时、可见期间按通道间隔 (账号 30 s, WebDAV 2 min)
 *  - 新收到的条目提示「收到来自「设备名」的 N 条」, 带「查看」按钮
 */
import { reactive } from 'vue'
import { t } from '../../i18n'
import { toast } from '../toast'
import { isTauri } from '../../storage/types'
import { accountApiBase, accountState, clearLocalLogin, isLoggedIn } from '../account'
import { localDeviceId, webdavSyncConfigured } from '../sync'
import { deviceName } from '../sync/shared'
import { useSettings } from '../../stores/settings'
import { createAccountChannel } from './accountChannel'
import { createWebdavChannel } from './webdavChannel'
import { createDropChannel, type DropChannel } from './dropChannel'
import {
  findNew, groupBySender, isIncomingFor, itemKey, mergeItems, rememberSeen, safeFilename, textFileName,
} from './model'
import { TransferError, type ChannelId, type ProgressFn, type SendInput, type TransferChannel, type TransferDevice, type TransferItem } from './types'

export type DeviceChannelId = Exclude<ChannelId, 'drop'>

export const transferState = reactive({
  /** 各通道合并后的条目, 新到旧 */
  items: [] as TransferItem[],
  devices: { account: [], webdav: [] } as Record<DeviceChannelId, TransferDevice[]>,
  /** 各通道最近一次的错误 (已本地化) */
  errors: {} as Partial<Record<ChannelId, string>>,
  loading: false,
  deviceId: '',
  /** 互传页打开时不弹提醒 (条目已在眼前) */
  pageOpen: false,
  /** 未在互传页看到的新条目数 (侧栏角标) */
  unread: 0,
})

// ---- 通道 ----

export function deviceChannelsAvailable(): DeviceChannelId[] {
  const out: DeviceChannelId[] = []
  if (isLoggedIn()) out.push('account')
  try {
    if (webdavSyncConfigured()) out.push('webdav')
  } catch { /* pinia 未就绪 */ }
  return out
}

/** 默认通道: 账号优先, 其次 WebDAV; 都没有为 null */
export const defaultDeviceChannel = (): DeviceChannelId | null => deviceChannelsAvailable()[0] ?? null

async function me() {
  if (!transferState.deviceId) transferState.deviceId = await localDeviceId()
  return { deviceId: transferState.deviceId, deviceName: deviceName() }
}

let webdavCache: { key: string; channel: TransferChannel } | null = null

export async function getChannel(id: DeviceChannelId): Promise<TransferChannel>
export async function getChannel(id: 'drop'): Promise<DropChannel>
export async function getChannel(id: ChannelId): Promise<TransferChannel>
export async function getChannel(id: ChannelId): Promise<TransferChannel> {
  const m = await me()
  if (id === 'account') {
    if (!isLoggedIn()) throw new TransferError(t('transfer.needLogin'), 401)
    return createAccountChannel({ base: accountApiBase(), token: accountState.token, ...m }, undefined, t)
  }
  if (id === 'webdav') {
    const s = useSettings()
    const cfg = { url: s.webdavUrl, user: s.webdavUser, pass: s.webdavPass }
    const key = JSON.stringify([cfg, m.deviceId])
    if (webdavCache?.key !== key) {
      webdavCache = { key, channel: createWebdavChannel(cfg, m, { translate: t }) }
    }
    return webdavCache.channel
  }
  return createDropChannel({ base: accountApiBase(), token: isLoggedIn() ? accountState.token : undefined, ...m }, undefined, t)
}

/** 账号通道 401: 会话失效, 清除本地登录 (与同步一致) */
function handleError(id: ChannelId, err: unknown, token?: string) {
  const msg = err instanceof Error ? err.message : String(err)
  transferState.errors[id] = msg
  if (id === 'account' && err instanceof TransferError && err.status === 401) clearLocalLogin(token)
}

// ---- 已见记录 ----

const SEEN_KEY = 'lightread-transfer-seen'
type SeenState = Partial<Record<ChannelId, string[]>>

function loadSeen(): SeenState {
  try {
    const v = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}')
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}
function saveSeen(s: SeenState) {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(s)) } catch { /* 存储不可用 */ }
}

/** 记下这些条目已见; 返回其中新的 (首次运行只算最近 24 小时的) */
function noteSeen(id: ChannelId, items: TransferItem[]): TransferItem[] {
  const seen = loadSeen()
  const prev = seen[id]
  const fresh = findNew(items, new Set(prev ?? []), transferState.deviceId, Date.now(), prev === undefined)
  const incoming = items.filter(it => isIncomingFor(it, transferState.deviceId)).map(it => it.id)
  seen[id] = rememberSeen(prev ?? [], incoming)
  saveSeen(seen)
  return fresh
}

// ---- 刷新与轮询 ----

let openPanel: (() => void) | null = null

function setChannelItems(id: ChannelId, items: TransferItem[]) {
  transferState.items = mergeItems(transferState.items.filter(it => it.channel !== id), items)
}

function notify(fresh: TransferItem[]) {
  if (!fresh.length) return
  if (transferState.pageOpen) return
  transferState.unread += fresh.length
  const groups = groupBySender(fresh)
  const message = groups.length === 1
    ? t('transfer.receivedFrom', { name: groups[0].name || t('transfer.unknownDevice'), n: groups[0].count })
    : t('transfer.receivedMany', { n: fresh.length })
  toast(message, 'info', 8000, openPanel ? { label: t('transfer.view'), run: openPanel } : undefined)
}

const lastPolled: Partial<Record<ChannelId, number>> = {}
const polling: Partial<Record<ChannelId, Promise<void>>> = {}

/** 刷新一个设备通道 (同一通道同时只跑一次) */
function pollChannel(id: DeviceChannelId): Promise<void> {
  polling[id] ??= (async () => {
    const token = accountState.token
    try {
      const channel = await getChannel(id)
      const items = await channel.list()
      lastPolled[id] = Date.now()
      setChannelItems(id, items)
      delete transferState.errors[id]
      notify(noteSeen(id, items))
    } catch (err) {
      lastPolled[id] = Date.now()
      console.warn('[transfer] poll failed', id, err)
      handleError(id, err, token)
    }
  })().finally(() => { delete polling[id] })
  return polling[id]!
}

async function refreshDrops() {
  setChannelItems('drop', await (await getChannel('drop')).list())
}

/** 立即刷新全部可用通道 (互传页打开 / 下拉刷新时) */
export async function refreshTransfers(): Promise<void> {
  transferState.loading = true
  try {
    const ids = deviceChannelsAvailable()
    // 退出登录 / 断开 WebDAV 后, 去掉它们的条目
    transferState.items = transferState.items.filter(it => it.channel === 'drop' || ids.includes(it.channel as DeviceChannelId))
    await Promise.all([...ids.map(pollChannel), refreshDrops().catch(err => handleError('drop', err))])
  } finally {
    transferState.loading = false
  }
}

export async function loadDevices(id: DeviceChannelId): Promise<TransferDevice[]> {
  const token = accountState.token
  try {
    const list = await (await getChannel(id)).devices()
    transferState.devices[id] = list
    return list
  } catch (err) {
    handleError(id, err, token)
    return transferState.devices[id]
  }
}

const TICK_MS = 10_000
/** 获得焦点等触发的最小间隔 */
const TRIGGER_GAP_MS = 10_000

/** 后台轮询; 返回卸载函数. onOpen: 提醒里「查看」的动作 (打开互传页) */
export function startTransferPolling(onOpen: () => void): () => void {
  openPanel = onOpen
  const tick = (force: boolean) => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return
    const now = Date.now()
    for (const id of deviceChannelsAvailable()) {
      const last = lastPolled[id] ?? 0
      const interval = id === 'account' ? 30_000 : 2 * 60_000
      if (now - last >= (force ? TRIGGER_GAP_MS : interval)) void pollChannel(id)
    }
  }
  const onTrigger = () => tick(true)
  const onVisibility = () => { if (document.visibilityState === 'visible') tick(true) }
  window.addEventListener('focus', onTrigger)
  document.addEventListener('visibilitychange', onVisibility)
  const timer = setInterval(() => tick(false), TICK_MS)
  tick(true)
  return () => {
    window.removeEventListener('focus', onTrigger)
    document.removeEventListener('visibilitychange', onVisibility)
    clearInterval(timer)
    openPanel = null
  }
}

// ---- 发送 / 收取 ----

export async function sendTransfer(id: ChannelId, input: SendInput, onProgress?: ProgressFn): Promise<TransferItem> {
  const channel = await getChannel(id)
  const token = accountState.token
  try {
    const item = await channel.send(input, { onProgress })
    transferState.items = mergeItems(transferState.items, [item])
    return item
  } catch (err) {
    if (id === 'account' && err instanceof TransferError && err.status === 401) clearLocalLogin(token)
    throw err
  }
}

export async function removeTransfer(item: TransferItem): Promise<void> {
  await (await getChannel(item.channel)).remove(item)
  transferState.items = transferState.items.filter(it => itemKey(it) !== itemKey(item))
}

export async function lookupDrop(code: string): Promise<TransferItem> {
  const item = await (await getChannel('drop')).lookup(code)
  transferState.items = mergeItems(transferState.items, [item])
  return item
}

export async function fetchTransferBlob(item: TransferItem, onProgress?: ProgressFn): Promise<Blob> {
  return (await getChannel(item.channel)).fetchBlob(item, { onProgress })
}

/** 导入书库; 返回新书 (调用方决定是否打开) */
async function importBlob(blob: Blob, name: string) {
  const [{ importFile }, { detectFormat }, { useLibrary }] = await Promise.all([
    import('../importer'), import('../format'), import('../../stores/library'),
  ])
  const file = new File([blob], name)
  if (!detectFormat(name)) throw new Error(t('transfer.err.unsupported', { name }))
  const res = await importFile(file, t('transfer.source'))
  if (!res.ok || !res.bookId) throw new Error(res.error ?? t('common.unknownError'))
  await useLibrary().refresh()
  return { id: res.bookId, format: detectFormat(name)! }
}

export async function importTransferFile(item: TransferItem, onProgress?: ProgressFn) {
  const blob = await fetchTransferBlob(item, onProgress)
  return importBlob(blob, safeFilename(item.filename ?? 'file'))
}

export function saveTextToLibrary(item: TransferItem) {
  return importBlob(new Blob([item.text ?? ''], { type: 'text/plain' }), textFileName(item))
}

/** 下载保存: 网页走浏览器下载, 桌面弹出另存为 */
export async function saveTransferFile(item: TransferItem, onProgress?: ProgressFn): Promise<boolean> {
  const blob = await fetchTransferBlob(item, onProgress)
  const name = safeFilename(item.filename ?? 'file')
  if (isTauri()) {
    const [{ save }, { writeFile }] = await Promise.all([
      import('@tauri-apps/plugin-dialog'), import('@tauri-apps/plugin-fs'),
    ])
    const path = await save({ defaultPath: name })
    if (!path) return false
    await writeFile(path, new Uint8Array(await blob.arrayBuffer()))
    return true
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.hidden = true
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return true
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    return
  } catch { /* 旧 WebView / 非安全上下文: 退回 execCommand */ }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.append(ta)
  ta.select()
  const ok = document.execCommand('copy')
  ta.remove()
  if (!ok) throw new Error(t('transfer.copyFailed'))
}

export async function openExternalLink(url: string): Promise<void> {
  if (isTauri()) {
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    await openUrl(url)
  } else {
    window.open(url, '_blank', 'noopener')
  }
}

/** 网页版的应用地址 (取件码分享链接用); 桌面 / 安卓为 null */
export function webAppBase(): string | null {
  if (isTauri() || typeof location === 'undefined' || !/^https?:$/.test(location.protocol)) return null
  return location.origin + location.pathname
}

// ---- 快捷发送 (阅读器划词 / 书卡片) ----

/**
 * 发到「我的其他设备」(默认通道). 没有可用通道时提示去登录, 带「互传」按钮.
 * 返回是否已发出.
 */
export async function quickSend(input: SendInput, label: string): Promise<boolean> {
  const id = defaultDeviceChannel()
  if (!id) {
    toast(t('transfer.quickNeedSetup'), 'info', 8000, openPanel ? { label: t('transfer.open'), run: openPanel } : undefined)
    return false
  }
  const done = toast(t('transfer.sending', { name: label }), 'info', 120_000)
  try {
    await sendTransfer(id, { ...input, toDevice: null })
    done()
    toast(t('transfer.sentToOthers'), 'success', 4000, openPanel ? { label: t('transfer.view'), run: openPanel } : undefined)
    return true
  } catch (err) {
    done()
    toast(t('transfer.sendFailed', { msg: err instanceof Error ? err.message : String(err) }), 'error', 6000)
    return false
  }
}

/** 阅读器划词「发送到其他设备」 */
export function sendSelectionToDevices(text: string, bookTitle?: string): Promise<boolean> {
  const title = bookTitle ? t('transfer.fromBook', { title: bookTitle }) : ''
  return quickSend({ kind: 'text', text, title }, text.slice(0, 20))
}

/** 书卡片「发送到其他设备」: 发送书籍文件 */
export async function sendBookToDevices(bookId: string): Promise<boolean> {
  const { getStorage } = await import('../../storage')
  const storage = await getStorage()
  const book = await storage.getBook(bookId)
  if (!book) return false
  let file: Blob
  try {
    file = await storage.getBookFile(bookId)
  } catch (err) {
    toast(t('transfer.sendFailed', { msg: err instanceof Error ? err.message : String(err) }), 'error', 6000)
    return false
  }
  return quickSend({
    kind: 'file', file, filename: safeFilename(book.fileName || `${book.title}.${book.format}`), title: book.title,
  }, book.title)
}
