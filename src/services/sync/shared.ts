/**
 * 同步与账号共用的小工具. 不依赖 vue / pinia / 存储, 可在 node 里测试.
 */
import { isTauri } from '../../storage/types.ts'

/** 本机的显示名 (写进 SyncDoc 与账号会话), 如 `Desktop · Win32`、`Web · macOS`、`Android` */
export function deviceName(): string {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined
  if (/Android/i.test(nav?.userAgent ?? '')) return isTauri() ? 'Android' : 'Web · Android'
  const platform = (nav as { userAgentData?: { platform?: string } } | undefined)
    ?.userAgentData?.platform || nav?.platform || ''
  const shell = isTauri() ? 'Desktop' : 'Web'
  return platform ? `${shell} · ${platform}` : shell
}

let current: Promise<unknown> | null = null

/** 登记正在进行的同步 (sync/index.ts 调用) */
export function trackSync<T>(p: Promise<T>): Promise<T> {
  current = p
  const clear = () => {
    if (current === p) current = null
  }
  p.then(clear, clear)
  return p
}

/** 等正在进行的同步结束 (不论成败); 没有则立即返回 */
export async function waitForSync(): Promise<void> {
  while (current) await current.catch(() => undefined)
}
