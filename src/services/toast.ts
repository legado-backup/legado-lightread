import { reactive } from 'vue'

export interface Toast {
  id: number
  message: string
  type: 'info' | 'success' | 'error'
}

export const toasts = reactive<Toast[]>([])

let nextId = 1

/** 显示提示; 返回的函数可提前关闭 (如加载完成后撤下「正在加载」) */
export function toast(message: string, type: Toast['type'] = 'info', duration = 2600): () => void {
  const item: Toast = { id: nextId++, message, type }
  toasts.push(item)
  const dismiss = () => {
    const i = toasts.findIndex(t => t.id === item.id)
    if (i >= 0) toasts.splice(i, 1)
  }
  setTimeout(dismiss, duration)
  return dismiss
}
