/**
 * 记录每项可同步设置的最后修改时间 (设置同步的 LWW 依据, 见 settingsSync.ts).
 * 元数据存在 localStorage `lightread-settings-sync` (与设置本身分开, 清掉只会让本机设置在下次同步时
 * 输给其它设备改过的值). 由 stores/settings.ts 的 persistOnChange() 启动; 同步时 sync/index.ts 取端口.
 */
import { watch } from 'vue'
import type { SettingsSyncPort } from './types'
import {
  createSettingsSyncPort, initSettingsMeta, readSyncedSettings, recordSettingsChanges, type SettingsSyncMeta,
} from './settingsSync.ts'

const META_KEY = 'lightread-settings-sync'

let meta: SettingsSyncMeta | null = null
let getState: (() => unknown) | null = null
let stopWatch: (() => void) | null = null

function loadMeta(): Partial<SettingsSyncMeta> | null {
  try {
    const raw = localStorage.getItem(META_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function saveMeta() {
  if (!meta) return
  try {
    localStorage.setItem(META_KEY, JSON.stringify(meta))
  } catch { /* 存储不可用: 只影响本次会话之后的修改时间 */ }
}

/**
 * 开始追踪 (幂等). state 返回设置 store 的响应式状态, defaults 为默认设置 (判断「从没改过」).
 * 深度监听可同步的值; 同步落地时端口先更新快照, 所以落地的值不会被记成本机修改.
 */
export function startSettingsTracking(state: () => unknown, defaults: unknown): void {
  if (stopWatch) return
  getState = state
  meta = initSettingsMeta(loadMeta(), readSyncedSettings(state()), readSyncedSettings(defaults), Date.now())
  saveMeta()
  stopWatch = watch(
    () => readSyncedSettings(state()),
    values => {
      if (meta && recordSettingsChanges(meta, values, Date.now()).length) saveMeta()
    },
    { deep: true },
  )
}

/** 同步用的设置端口; 还没开始追踪 (不应发生) 时返回 null, 这次同步不带设置 */
export function settingsSyncPort(includeSecrets: boolean): SettingsSyncPort | null {
  if (!meta || !getState) return null
  return createSettingsSyncPort({ state: getState, meta, includeSecrets, onMetaChange: saveMeta })
}
