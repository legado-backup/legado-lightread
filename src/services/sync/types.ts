/**
 * 多端同步协议类型. 规则见 docs/sync.md.
 * 本文件是 merge (纯函数) / engine (编排) / remote (后端) 三者之间的契约.
 */
import type { AnnotationRec, BookMeta, CatalogSourceRec } from '../../storage/types'

export const SYNC_FORMAT = 1

/** 时间戳 + 设备 id; 先比 t, 相等比 d 字典序 */
export interface Stamp {
  t: number
  d: string
}

/** LWW 寄存器; value 为 null 表示已删除 (墓碑) */
export interface Reg<T> {
  value: T | null
  stamp: Stamp
}

/** 书的可同步元数据 (不含进度与时长) */
export interface BookMetaVal {
  title: string
  author: string
  format: BookMeta['format']
  fileName: string
  description?: string
  language?: string
  tags: string[]
  addedAt: number
  kind: 'book' | 'paper'
  source?: string
  /** 0 表示未置顶 */
  pinnedAt: number
}

export interface ProgressVal {
  location?: string
  progress?: number
  lastReadAt?: number
}

export interface BookSyncRec {
  meta: Reg<BookMetaVal>
  progress: Reg<ProgressVal>
  /** G-Counter: deviceId → 该设备贡献的阅读秒数 */
  reading: Record<string, number>
  /** 书是否存在 (value=false 即删除) */
  alive: Reg<boolean>
}

export type AnnotationVal = Omit<AnnotationRec, 'id' | 'bookId'> & { bookHash: string }

export interface BooklistVal {
  name: string
  createdAt: number
}

export interface BooklistItemVal {
  booklistId: string
  bookHash: string
  addedAt: number
}

export type SourceVal = Omit<CatalogSourceRec, 'id' | 'builtin'>

export interface SyncDoc {
  format: typeof SYNC_FORMAT
  deviceId: string
  deviceName?: string
  /** 写入方的应用版本 */
  app?: string
  writtenAt: number
  /** 键: 书籍内容 SHA-256 */
  books: Record<string, BookSyncRec>
  /** 键: 标注 id */
  annotations: Record<string, Reg<AnnotationVal>>
  /** 键: 书单 id */
  booklists: Record<string, Reg<BooklistVal>>
  /** 键: `${booklistId}|${bookHash}` */
  booklistItems: Record<string, Reg<BooklistItemVal>>
  /** 键: 书源 url (仅自定义书源) */
  sources: Record<string, Reg<SourceVal>>
}

/** 本地库的规范化快照 (engine 从 LibraryStorage 读出, merge 只做纯计算) */
export interface LocalBook {
  /** 本地 BookMeta.id */
  id: string
  meta: BookMetaVal
  progress: ProgressVal
  /** 本地累计阅读秒数 */
  readingSeconds: number
  hasCover: boolean
}

export interface LocalState {
  /** 键: 内容 hash; 同一 hash 多本时取 addedAt 最早的一本 */
  books: Record<string, LocalBook>
  /** 键: 标注 id; 只含所属书在 books 里的标注 */
  annotations: Record<string, AnnotationVal>
  booklists: Record<string, BooklistVal>
  /** 键: `${booklistId}|${bookHash}` */
  booklistItems: Record<string, BooklistItemVal>
  /** 键: url; 不含内置书源 */
  sources: Record<string, SourceVal>
}

/** 上次同步后保存的基线 */
export interface SyncBaseline {
  /** 最近一次同步的远端 (SyncRemote.id); 基线对哪些远端有效见 baseline.ts 的 remotes */
  remoteId: string
  doc: SyncDoc
  /** 上次同步结束时本地实际拥有文件的书 */
  presentHashes: string[]
  syncedAt: number
}

/** 把合并结果落到本地库的操作 (hash 需由 engine 映射回本地 book id) */
export type ApplyOp =
  | { op: 'addBook'; hash: string; meta: BookMetaVal; progress: ProgressVal; readingSeconds: number }
  | { op: 'deleteBook'; hash: string }
  | { op: 'updateBook'; hash: string; patch: Partial<Omit<BookMeta, 'id' | 'hasCover'>> }
  | { op: 'addAnnotation'; id: string; value: AnnotationVal }
  | { op: 'updateAnnotation'; id: string; patch: Partial<Pick<AnnotationRec, 'note' | 'color'>> }
  | { op: 'deleteAnnotation'; id: string }
  | { op: 'addBooklist'; id: string; value: BooklistVal }
  | { op: 'renameBooklist'; id: string; name: string }
  | { op: 'deleteBooklist'; id: string }
  | { op: 'addBooklistItem'; booklistId: string; hash: string }
  | { op: 'removeBooklistItem'; booklistId: string; hash: string }
  | { op: 'addSource'; value: SourceVal }
  | { op: 'deleteSource'; url: string }

/**
 * 同步后端. WebDAV 与 (第二步的) 轻阅账号各实现一份.
 * 文件名: `<hash>` 为书籍文件, `<hash>.cover` 为封面.
 */
export interface SyncRemote {
  readonly kind: 'webdav' | 'account'
  /** 远端标识 (如 WebDAV 地址 + 用户名), 用于判断基线是否属于当前远端 */
  readonly id: string
  /** 是否能存放书籍文件 */
  readonly supportsFiles: boolean
  /** 确保目录等就绪 */
  prepare(): Promise<void>
  /** 读取所有设备的 SyncDoc (含本机旧文件); 损坏的文件跳过 */
  listDocs(): Promise<SyncDoc[]>
  putDoc(doc: SyncDoc): Promise<void>
  /** 已上传的文件名集合 */
  listFiles(): Promise<Set<string>>
  putFile(name: string, blob: Blob): Promise<void>
  /** 不存在返回 null */
  getFile(name: string): Promise<Blob | null>
}

export interface SyncResult {
  /** 应用到本地的操作数 */
  applied: number
  downloadedBooks: number
  uploadedFiles: number
  /** 只有元数据、本地还没有文件的书 */
  pendingBooks: number
  devices: number
}
