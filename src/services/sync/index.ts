/**
 * 同步对外接口 (设置页 / App 壳调用). 实现在 engine.ts.
 * 导出签名是 UI 依赖的契约, 不要改.
 */
import { reactive } from 'vue'
import type { SyncRemote, SyncResult } from './types'
import { runSync } from './engine.ts'
import { createDexieSyncStore, type SyncStore } from './baseline.ts'
import { createWebdavRemote } from './webdavRemote.ts'
import { createAccountRemote, isAccountUnauthorized } from './accountRemote.ts'
import { deviceName, trackSync, waitForSync } from './shared.ts'
import { readingLogSyncPort } from '../readingLog.ts'
import { accountApiBase, accountState, clearLocalLogin, isLoggedIn } from '../account.ts'
import { getStorage } from '../../storage'
import { useSettings } from '../../stores/settings'
import { useLibrary } from '../../stores/library'
import { t } from '../../i18n'

const STATE_KEY = 'lightread-sync-state'

function loadLastSyncAt(): number {
  try {
    const raw = localStorage.getItem(STATE_KEY)
    const n = raw ? Number(JSON.parse(raw).lastSyncAt) : 0
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}

export const syncState = reactive({
  running: false,
  /** 当前阶段文案 (已经过 t()) */
  message: '',
  /** 上次成功同步的时间, 0 为从未 */
  lastSyncAt: loadLastSyncAt(),
  lastError: '',
  lastResult: null as SyncResult | null,
})

let store: SyncStore | null = null
const syncStore = () => (store ??= createDexieSyncStore())

/** WebDAV 地址已填写 */
export function webdavSyncConfigured(): boolean {
  return !!useSettings().webdavUrl.trim()
}

/** 有可用的同步目标 (已登录轻阅账号或已填写 WebDAV) */
export function syncConfigured(): boolean {
  return isLoggedIn() || webdavSyncConfigured()
}

let inflight: Promise<SyncResult> | null = null

/** 多个远端的结果相加; 仅元数据的书数取最后一个远端 (它已看到前面远端落地的书), 设备数取最大 */
function combineResults(a: SyncResult | null, b: SyncResult): SyncResult {
  if (!a) return { ...b }
  return {
    applied: a.applied + b.applied,
    downloadedBooks: a.downloadedBooks + b.downloadedBooks,
    uploadedFiles: a.uploadedFiles + b.uploadedFiles,
    pendingBooks: b.pendingBooks,
    devices: Math.max(a.devices, b.devices),
  }
}

interface SyncTarget {
  remote: SyncRemote
  syncFiles: boolean
  /** 账号远端所用的 token (401 时据此清除本地登录) */
  token?: string
}

/** 本次要同步的远端: 先轻阅账号, 再 WebDAV (都配置时依次各跑一次, 共用本机基线) */
function syncTargets(): SyncTarget[] {
  const targets: SyncTarget[] = []
  if (isLoggedIn()) {
    const token = accountState.token
    targets.push({
      remote: createAccountRemote({ base: accountApiBase(), token, accountId: accountState.account!.id }, undefined, t),
      syncFiles: false,
      token,
    })
  }
  if (webdavSyncConfigured()) {
    const settings = useSettings()
    targets.push({
      remote: createWebdavRemote(
        { url: settings.webdavUrl, user: settings.webdavUser, pass: settings.webdavPass },
        undefined,
        t,
      ),
      syncFiles: settings.webdavSyncFiles,
    })
  }
  return targets
}

/**
 * 立即同步; 正在同步时等待当前这次结束并返回其结果. 失败抛错, 同时写入 syncState.lastError.
 * 已登录账号与已填 WebDAV 时依次同步两者; 一个失败仍会尝试另一个, 最后抛出第一个错误.
 */
export async function syncNow(): Promise<SyncResult> {
  if (inflight) return inflight
  inflight = trackSync((async () => {
    syncState.running = true
    syncState.message = ''
    try {
      const targets = syncTargets()
      if (!targets.length) throw new Error(t('sync.err.notConfigured'))
      const library = useLibrary()
      const storage = await getStorage()
      let result: SyncResult | null = null
      let firstError: unknown = null
      for (const target of targets) {
        try {
          const r = await runSync({
            storage,
            remote: target.remote,
            store: syncStore(),
            syncFiles: target.syncFiles,
            deviceName: deviceName(),
            app: __APP_VERSION__,
            t,
            onProgress: msg => { syncState.message = msg },
            deleteBook: id => library.removeBook(id),
            readingLog: readingLogSyncPort(),
          })
          result = combineResults(result, r)
        } catch (err) {
          // 会话失效: 清除本地登录 (设置页随之回到登录表单), 错误照常报告
          if (target.token !== undefined && isAccountUnauthorized(err)) clearLocalLogin(target.token)
          console.warn('[sync] failed', target.remote.kind, err)
          firstError ??= err
        }
      }
      // 部分远端失败时, 成功的那次也可能已改动本地库
      await library.refresh()
      if (firstError || !result) throw firstError
      syncState.lastSyncAt = Date.now()
      syncState.lastResult = result
      syncState.lastError = ''
      try {
        localStorage.setItem(STATE_KEY, JSON.stringify({ lastSyncAt: syncState.lastSyncAt }))
      } catch { /* 存储不可用时只影响展示 */ }
      return result
    } catch (err) {
      syncState.lastError = err instanceof Error ? err.message : String(err)
      throw err
    } finally {
      syncState.running = false
      syncState.message = ''
    }
  })())
  try {
    return await inflight
  } finally {
    inflight = null
  }
}

const AUTO_DEBOUNCE_MS = 3000
const AUTO_INTERVAL_MS = 5 * 60 * 1000
let autoTimer: ReturnType<typeof setTimeout> | null = null

/** 自动同步请求 (开启自动同步且已配置时才执行; 防抖, 错误只写 syncState 不抛出) */
export function requestAutoSync(reason: string): void {
  try {
    if (!useSettings().webdavSyncAuto || !syncConfigured()) return
  } catch {
    return // pinia 未就绪
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return
  if (autoTimer) clearTimeout(autoTimer)
  // 切到后台时页面随时可能被挂起, 立即执行
  const delay = reason === 'hidden' ? 0 : AUTO_DEBOUNCE_MS
  autoTimer = setTimeout(() => {
    autoTimer = null
    syncNow().catch(() => { /* 已写入 syncState.lastError */ })
  }, delay)
}

/** 安装自动同步 (启动时一次、visibilitychange 到 hidden、每 5 分钟); 返回卸载函数 */
export function startAutoSync(): () => void {
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') requestAutoSync('hidden')
  }
  let interval: ReturnType<typeof setInterval> | undefined
  try {
    document.addEventListener('visibilitychange', onVisibility)
    interval = setInterval(() => requestAutoSync('interval'), AUTO_INTERVAL_MS)
    requestAutoSync('start')
  } catch (err) {
    syncState.lastError = err instanceof Error ? err.message : String(err)
  }
  return () => {
    document.removeEventListener('visibilitychange', onVisibility)
    if (interval) clearInterval(interval)
    if (autoTimer) {
      clearTimeout(autoTimer)
      autoTimer = null
    }
  }
}

/** 等正在进行的同步结束 (不论成败) */
export { waitForSync }

/** 清除本地基线; 下次同步 (各远端) 按首次同步处理: 只并集, 不删除 */
export async function resetSyncBaseline(): Promise<void> {
  // 正在同步时等它结束, 否则它会把旧基线写回去
  await waitForSync()
  await syncStore().clearBaseline()
}
