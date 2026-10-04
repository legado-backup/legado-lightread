import type { BookMeta } from '../storage'

/** 书 → 阅读器路由: PDF 统一走论文阅读器, DjVu 走专用阅读器, 其余走 foliate (藏书与论文共用) */
export function readerPath(book: Pick<BookMeta, 'id' | 'format'>): string {
  if (book.format === 'pdf') return `/read-paper/${book.id}`
  if (book.format === 'djvu') return `/read-djvu/${book.id}`
  return `/read/${book.id}`
}
