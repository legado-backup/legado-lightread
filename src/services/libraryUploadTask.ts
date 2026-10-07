/**
 * 上传到私人书库的后台任务: 弹窗只负责挑书, 点「开始上传」后交给这里,
 * 关掉弹窗、切换页面都不影响; 右下角 LibraryUploadStatus 显示进度。
 * 同一时间只跑一个队列, 按加入顺序逐本处理, 运行中还能继续追加。
 */
import { reactive } from 'vue'
import type { BookMeta, CatalogSourceRec, LocalFileRef } from '../storage/types'
import { canConvertToEpub, detectFormat } from './format.ts'
import { LibraryUploadError, type LibraryUploadCapability, type LibraryUploadInput, type LibraryUploadResult } from './libraryUpload.ts'

export type UploadRowStatus = 'pending' | 'converting' | 'uploading' | 'success' | 'duplicate' | 'failed' | 'cancelled'
export interface UploadTaskRow {
  id: number
  /** 去重键: file:名:大小:修改时间 / book:藏书 id */
  key: string
  name: string
  file?: File
  /** 桌面选文件夹上传: 轮到这本时才从磁盘读出 (重试时再读一次) */
  loadFile?: () => Promise<File>
  book?: BookMeta
  source: CatalogSourceRec
  capability: LibraryUploadCapability
  convert: boolean
  status: UploadRowStatus
  error?: { key: string; params?: Record<string, string | number> }
}
export type UploadTaskInput = Pick<UploadTaskRow, 'key' | 'name' | 'file' | 'book' | 'loadFile'>

export interface UploadTaskDeps {
  getBookFile(id: string): Promise<Blob>
  getBookFileRef?(id: string): Promise<LocalFileRef | undefined>
  convert(file: Blob, fileName: string, meta: { title?: string; author?: string }): Promise<{ epub: Blob; fileName: string; title?: string; author?: string | null }>
  convertError(error: unknown): string
  upload(source: CatalogSourceRec, capability: LibraryUploadCapability, input: LibraryUploadInput): Promise<LibraryUploadResult>
}

export const libraryUploadTask = reactive({
  rows: [] as UploadTaskRow[],
  running: false,
  cancelling: false,
  /** 每跑完一轮且有书真正进了书库就 +1, 书源页据此刷新列表 */
  generation: 0,
  /** 上传弹窗打开时不再重复显示右下角进度卡片 */
  dialogs: 0,
})

const FINISHED: UploadRowStatus[] = ['success', 'duplicate', 'failed', 'cancelled']
export const isFinished = (row: UploadTaskRow) => FINISHED.includes(row.status)
export const isActive = (row: UploadTaskRow) => row.status === 'converting' || row.status === 'uploading'

let nextId = 1
let defaultDeps: Promise<UploadTaskDeps> | undefined

async function loadDeps(): Promise<UploadTaskDeps> {
  const [{ getStorage }, { convertBookToEpub }, { convertErrorText }, { uploadLibraryBook }] = await Promise.all([
    import('../storage'), import('./bookToEpub.ts'), import('./convertLibraryBook.ts'), import('./libraryUpload.ts'),
  ])
  const storage = await getStorage()
  return {
    getBookFile: id => storage.getBookFile(id),
    getBookFileRef: storage.getBookFileRef ? id => storage.getBookFileRef!(id) : undefined,
    convert: (file, fileName, meta) => convertBookToEpub(file, { fileName, meta }),
    convertError: convertErrorText,
    upload: uploadLibraryBook,
  }
}

/** 网页版关标签页会中断上传, 提醒一下; 安装版 WebView 不触发 */
function guardUnload(event: BeforeUnloadEvent) { event.preventDefault(); event.returnValue = '' }

/** 加入后台队列并开始; 同一书库里已在排队/上传中的同一本书不会重复加入。返回实际加入的行数。 */
export function enqueueLibraryUpload(
  source: CatalogSourceRec, capability: LibraryUploadCapability, convert: boolean,
  inputs: UploadTaskInput[], deps?: UploadTaskDeps,
): number {
  if (!libraryUploadTask.running) {
    // 新一轮: 收起上一轮已成功/已取消的记录, 失败的留着方便重试
    libraryUploadTask.rows = libraryUploadTask.rows.filter(row => row.status === 'failed')
  }
  let added = 0
  for (const input of inputs) {
    if (libraryUploadTask.rows.some(row => row.key === input.key && row.source.id === source.id && !isFinished(row))) continue
    libraryUploadTask.rows.push({ ...input, id: nextId++, source, capability, convert, status: 'pending' })
    added++
  }
  if (added) void runLibraryUpload(deps)
  return added
}

export function retryFailedLibraryUploads(deps?: UploadTaskDeps) {
  for (const row of libraryUploadTask.rows) if (row.status === 'failed') { row.status = 'pending'; row.error = undefined }
  void runLibraryUpload(deps)
}

/** 取消排队中的书; 正在传的那一本无法中途撤回, 传完即停 */
export function cancelLibraryUpload() {
  if (!libraryUploadTask.running) return
  libraryUploadTask.cancelling = true
  for (const row of libraryUploadTask.rows) if (row.status === 'pending') row.status = 'cancelled'
}

/** 关闭已结束的任务卡片 */
export function dismissLibraryUpload() {
  if (!libraryUploadTask.running) libraryUploadTask.rows = []
}

export function uploadErrorOf(error: unknown): UploadTaskRow['error'] {
  return error instanceof LibraryUploadError ? { key: error.key, params: error.params } : { key: 'upload.network' }
}

async function processRow(row: UploadTaskRow, deps: UploadTaskDeps) {
  const cap = row.capability
  if (!row.file && row.loadFile) {
    try { row.file = await row.loadFile() } catch { throw new LibraryUploadError('upload.fileUnavailable') }
  }
  let fileName = row.file?.name ?? row.book!.fileName
  let format = detectFormat(fileName)
  let title = row.book?.title
  let author = row.book?.author
  let body: Blob | LocalFileRef | undefined = row.file
  if (row.convert && cap.formats.includes('epub') && canConvertToEpub(format)) {
    // 在本机转成 EPUB 再上传; 藏书里的原文件不变
    row.status = 'converting'
    let original: Blob | undefined = row.file
    if (!original) {
      try { original = await deps.getBookFile(row.book!.id) } catch { throw new LibraryUploadError('upload.fileUnavailable') }
    }
    try {
      const converted = await deps.convert(original, fileName, { title, author })
      body = converted.epub
      fileName = converted.fileName
      format = 'epub'
      title = title || converted.title
      author = author || converted.author || undefined
    } catch (error) {
      throw new LibraryUploadError('upload.convertFailed', { msg: deps.convertError(error) })
    }
  }
  row.status = 'uploading'
  if (!format || !cap.formats.includes(format)) throw new LibraryUploadError('upload.unsupportedFormat')
  if (!body) {
    try {
      body = await deps.getBookFileRef?.(row.book!.id) ?? await deps.getBookFile(row.book!.id)
    } catch { throw new LibraryUploadError('upload.fileUnavailable') }
  }
  const result = await deps.upload(row.source, cap, { fileName, body, title, author })
  return result.duplicate
}

let runner: Promise<void> | undefined

/** 逐本处理队列直到没有待传的书; 已在运行时直接返回当前这轮 (新加的书会被这轮接着处理) */
export function runLibraryUpload(deps?: UploadTaskDeps): Promise<void> {
  if (libraryUploadTask.running && runner) return runner
  libraryUploadTask.running = true
  runner = (async () => {
    libraryUploadTask.cancelling = false
    if (typeof window !== 'undefined') window.addEventListener('beforeunload', guardUnload)
    let changed = false
    try {
      let row: UploadTaskRow | undefined
      while ((row = libraryUploadTask.rows.find(r => r.status === 'pending'))) {
        row.status = 'uploading'
        row.error = undefined
        try {
          const resolved = deps ?? await (defaultDeps ??= loadDeps().catch(e => { defaultDeps = undefined; throw e }))
          row.status = await processRow(row, resolved) ? 'duplicate' : 'success'
          // 传完就放掉设备文件句柄; 重试只需要失败的那些
          row.file = undefined
          changed = true
        } catch (error) {
          row.status = 'failed'
          row.error = uploadErrorOf(error)
          // 能重新从磁盘读的就先放掉, 免得失败的大文件一直占内存
          if (row.loadFile) row.file = undefined
        }
      }
    } finally {
      if (typeof window !== 'undefined') window.removeEventListener('beforeunload', guardUnload)
      libraryUploadTask.running = false
      libraryUploadTask.cancelling = false
      if (changed) libraryUploadTask.generation++
    }
  })()
  return runner
}
