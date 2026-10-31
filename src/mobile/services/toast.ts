import { reactive } from 'vue'
import { redactUrls } from '../../services/errorText.ts'

export interface ToastAction { label: string; run: () => void }
export interface Toast {
  id: number
  message: string
  type: 'info' | 'success' | 'error'
  action?: ToastAction
  dismiss: () => void
  pause: () => void
  resume: () => void
}
/** App shows one message at a time. Actionable messages and errors keep their turn. */
export const toasts = reactive<Toast[]>([])
const pending: Toast[] = []
export const isLongMessage = (message: string) => message.length > 120 || message.split('\n').length > 3
let nextId = 1
function show(item: Toast) {
  toasts.splice(0, toasts.length, item)
  item.resume()
}
export function toast(message: string, type: Toast['type'] = 'info', duration = 2600, action?: ToastAction): () => void {
  // 兜底: 报错提示里不出现服务器 / 请求地址 (底层网络报错常把完整 URL 带进 message)
  if (type === 'error') message = redactUrls(message)
  const duplicate = !action && [...toasts, ...pending].find(item => !item.action && item.type === type && item.message === message)
  if (duplicate) return duplicate.dismiss
  const id = nextId++
  // Long messages remain until dismissed or opened in the full-message sheet.
  const lifetime = isLongMessage(message) ? Infinity : Math.max(duration, type === 'error' ? 6500 : action ? 8000 : Math.min(6000, 1500 + message.length * 70))
  const timer = { remaining: lifetime, started: 0 } as { timer?: ReturnType<typeof setTimeout>; remaining: number; started: number }
  const item: Toast = {
    id, message, type, action,
    pause() {
      if (!timer.timer) return
      clearTimeout(timer.timer); timer.timer = undefined
      timer.remaining = Math.max(0, timer.remaining - (Date.now() - timer.started))
    },
    resume() {
      if (toasts[0]?.id !== id || timer.timer || !Number.isFinite(timer.remaining)) return
      timer.started = Date.now()
      timer.timer = setTimeout(item.dismiss, timer.remaining)
    },
    dismiss() {
      clearTimeout(timer.timer); timer.timer = undefined
      const index = pending.findIndex(entry => entry.id === id)
      if (index >= 0) pending.splice(index, 1)
      if (toasts[0]?.id !== id) return
      toasts.splice(0)
      const next = pending.shift()
      if (next) show(next)
    },
  }
  const current = toasts[0]
  if (!current) show(item)
  else if (current.type !== 'error' && !current.action) {
    // A newer ordinary result replaces a stale ordinary result; errors appear promptly.
    pending.unshift(item)
    current.dismiss()
  } else {
    // Keep only the latest passive result waiting behind an error/action.
    for (const queued of [...pending]) if (queued.type !== 'error' && !queued.action) queued.dismiss()
    pending.push(item)
  }
  return item.dismiss
}
