/**
 * 同步对外接口 (设置页 / App 壳调用). 实现在 engine.ts.
 * 导出签名是 UI 依赖的契约, 不要改.
 */
import { reactive } from 'vue'
import type { SyncResult } from './types'
import { runSync } from './engine.ts'
import { createDexieSyncStore, type SyncStore } from './baseline.ts'
import { createWebdavRemote } from './webdavRemote.ts'
import { getStorage } from '../../storage'
import { isTauri } from '../../storage/types'
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

function deviceName(): string {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined
  const platform = (nav as { userAgentData?: { platform?: string } } | undefined)
    ?.userAgentData?.platform || nav?.platform || ''
  const shell = isTauri() ? 'Desktop' : 'Web'
  return platform ? `${shell} · ${platform}` : shell
}

/** WebDAV 地址已填写 */
export function webdavSyncConfigured(): boolean {
  return !!useSettings().webdavUrl.trim()
}

let inflight: Promise<SyncResult> | null = null

/** 立即同步; 正在同步时等待当前这次结束并返回其结果. 失败抛错, 同时写入 syncState.lastError */
export async function syncNow(): Promise<SyncResult> {
  if (inflight) return inflight
  inflight = (async () => {
    syncState.running = true
    syncState.message = ''
    try {
      const settings = useSettings()
      if (!webdavSyncConfigured()) throw new Error(t('sync.err.notConfigured'))
      const library = useLibrary()
      const result = await runSync({
        storage: await getStorage(),
        remote: createWebdavRemote(
          { url: settings.webdavUrl, user: settings.webdavUser, pass: settings.webdavPass },
          undefined,
          t,
        ),
        store: syncStore(),
        syncFiles: settings.webdavSyncFiles,
        deviceName: deviceName(),
        app: __APP_VERSION__,
        t,
        onProgress: msg => { syncState.message = msg },
        deleteBook: id => library.removeBook(id),
      })
      syncState.lastSyncAt = Date.now()
      syncState.lastResult = result
      syncState.lastError = ''
      try {
        localStorage.setItem(STATE_KEY, JSON.stringify({ lastSyncAt: syncState.lastSyncAt }))
      } catch { /* 存储不可用时只影响展示 */ }
      await library.refresh()
      return result
    } catch (err) {
      syncState.lastError = err instanceof Error ? err.message : String(err)
      throw err
    } finally {
      syncState.running = false
      syncState.message = ''
    }
  })()
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
    if (!useSettings().webdavSyncAuto || !webdavSyncConfigured()) return
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

/** 清除本地基线 (换网盘等); 下次同步按首次同步处理 */
export async function resetSyncBaseline(): Promise<void> {
  // 正在同步时等它结束, 否则它会把旧基线写回去
  await inflight?.catch(() => undefined)
  await syncStore().clearBaseline()
}
