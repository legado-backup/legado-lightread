import { reactive } from 'vue'
import { redactUrls } from './errorText.ts'

export interface ToastAction {
  label: string
  run: () => void
}

export interface Toast {
  id: number
  message: string
  type: 'info' | 'success' | 'error'
  /** 可选的操作按钮 (如「打开」), 点击后执行并关闭提示 */
  action?: ToastAction
  dismiss: () => void
}

export const toasts = reactive<Toast[]>([])

let nextId = 1

/** 显示提示; 返回的函数可提前关闭 (如加载完成后撤下「正在加载」) */
export function toast(message: string, type: Toast['type'] = 'info', duration = 2600, action?: ToastAction): () => void {
  // 兜底: 报错提示里不出现服务器 / 请求地址 (底层网络报错常把完整 URL 带进 message)
  if (type === 'error') message = redactUrls(message)
  const id = nextId++
  const dismiss = () => {
    const i = toasts.findIndex(t => t.id === id)
    if (i >= 0) toasts.splice(i, 1)
  }
  toasts.push({ id, message, type, action, dismiss })
  setTimeout(dismiss, duration)
  return dismiss
}
