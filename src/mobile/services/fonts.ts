/**
 * 字体管理:
 *  - 桌面端枚举系统已安装字体 (Rust fontdb)
 *  - 自定义字体文件: 复制到应用数据目录, 阅读时以 FontFace 注入各章节文档
 */
import { isTauri } from '../../storage/types'
import { t } from '../../i18n'

export interface CustomFont {
  /** 展示名与 CSS font-family 名 (取自文件名) */
  name: string
  /** 应用数据目录内的字体文件路径 */
  file: string
}

let systemFontsCache: string[] | null = null

export async function listSystemFonts(): Promise<string[]> {
  if (!isTauri()) return []
  if (!systemFontsCache) {
    const { invoke } = await import('@tauri-apps/api/core')
    systemFontsCache = await invoke<string[]>('list_system_fonts')
  }
  return systemFontsCache
}

/** 弹文件选择框导入字体, 复制到 $APPDATA/fonts/; 取消返回 null */
export async function importFontFile(): Promise<CustomFont | null> {
  const { open } = await import('@tauri-apps/plugin-dialog')
  const picked = await open({
    title: t('reader.pickFontFile'),
    filters: [{ name: 'Fonts', extensions: ['ttf', 'otf', 'woff', 'woff2', 'ttc'] }],
  })
  if (typeof picked !== 'string') return null
  const { mkdir, exists } = await import('@tauri-apps/plugin-fs')
  const { appDataDir, join, basename } = await import('@tauri-apps/api/path')
  const data = new Uint8Array(await readNativeFont(picked))
  const dir = await join(await appDataDir(), 'fonts')
  if (!(await exists(dir))) await mkdir(dir, { recursive: true })
  const base = await basename(picked)
  const dest = await join(dir, base)
  await writeNativeFont(dest, data)
  return { name: base.replace(/\.(ttf|otf|woff2?|ttc)$/i, ''), file: dest }
}

const bytesCache = new Map<string, Promise<ArrayBuffer>>()
// Android's IPC bridge serializes binary messages. Keep each transfer bounded
// so a large CJK font does not leave a multi-gigabyte native allocation behind.
const FONT_IO_CHUNK = 256 * 1024

async function readNativeFont(file: string): Promise<ArrayBuffer> {
  const { open } = await import('@tauri-apps/plugin-fs')
  const handle = await open(file, { read: true })
  try {
    const { size } = await handle.stat()
    if (!Number.isSafeInteger(size) || size <= 0) throw new Error('Font file unavailable')
    const bytes = new Uint8Array(size)
    for (let offset = 0; offset < size;) {
      const chunk = new Uint8Array(Math.min(FONT_IO_CHUNK, size - offset))
      const read = await handle.read(chunk)
      if (!read) throw new Error('Incomplete font file')
      bytes.set(chunk.subarray(0, read), offset)
      offset += read
    }
    return bytes.buffer
  } finally { await handle.close() }
}

async function writeNativeFont(file: string, bytes: Uint8Array) {
  const { writeFile } = await import('@tauri-apps/plugin-fs')
  for (let offset = 0; offset < bytes.length; offset += FONT_IO_CHUNK) {
    await writeFile(file, bytes.subarray(offset, offset + FONT_IO_CHUNK), { append: offset > 0 })
  }
}

function loadFontBytes(file: string): Promise<ArrayBuffer> {
  if (!bytesCache.has(file)) {
    bytesCache.set(file, (async () => {
      if (file.startsWith('idb:')) {
        const data = await webFont('readonly', file)
        if (!(data instanceof Uint8Array)) throw new Error('Font file unavailable')
        return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
      }
      return readNativeFont(file)
    })().catch(error => { bytesCache.delete(file); throw error }))
    while (bytesCache.size > 2) bytesCache.delete(bytesCache.keys().next().value!)
  }
  return bytesCache.get(file)!
}

/** 把自定义字体注入章节 iframe 文档; FontFace 需在目标 realm 构造 */
export async function injectFontIntoDoc(doc: Document, font: CustomFont, shouldApply: () => boolean = () => true) {
  try {
    const win = doc.defaultView as any
    const state = doc as Document & { __lrFont?: { file: string; face: FontFace }; __lrFontRequest?: number }
    if (!win?.FontFace || state.__lrFont?.file === font.file) return
    const request = (state.__lrFontRequest ?? 0) + 1
    state.__lrFontRequest = request
    const face = new win.FontFace(font.name, await loadFontBytes(font.file))
    await face.load()
    if (state.__lrFontRequest !== request || !shouldApply()) return
    if (state.__lrFont) doc.fonts.delete(state.__lrFont.face)
    doc.fonts.add(face)
    state.__lrFont = { file: font.file, face }
  } catch (e) {
    console.warn('自定义字体加载失败:', font.name, e)
  }
}

/** 阅读设置里存的字体值 → 实际 CSS font-family (custom:Name → "Name") */
export function resolveFontFamily(value: string): string {
  const m = value.match(/^custom:(.+)$/)
  return m ? `"${m[1]}"` : value
}

// App resource downloads also work in its isolated browser preview.
let webDb: Promise<IDBDatabase> | undefined
function webFont(mode: IDBTransactionMode, key: string, value?: Uint8Array): Promise<unknown> {
  webDb ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('lightread-mobile-fonts', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('files')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => { webDb = undefined; reject(request.error) }
  })
  return webDb.then(db => new Promise((resolve, reject) => {
    const tx = db.transaction('files', mode), store = tx.objectStore('files')
    const req = value ? store.put(value, key) : store.get(key)
    tx.oncomplete = () => resolve(req.result)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  }))
}
export async function fontAvailable(font: CustomFont): Promise<boolean> {
  if (font.file.startsWith('idb:')) return (await webFont('readonly', font.file)) instanceof Uint8Array
  if (!isTauri()) return false
  const { exists } = await import('@tauri-apps/plugin-fs')
  return exists(font.file)
}
export async function saveFontResource(name: string, fileName: string, bytes: Uint8Array, license: Uint8Array): Promise<CustomFont> {
  if (!/^[a-zA-Z0-9._-]+$/.test(fileName)) throw new Error('Invalid font file name')
  if (!isTauri()) {
    const file = `idb:${fileName}`
    await webFont('readwrite', file + '.LICENSE.txt', license)
    await webFont('readwrite', file, bytes)
    return { name, file }
  }
  const { writeFile, mkdir, remove } = await import('@tauri-apps/plugin-fs')
  const { appDataDir, join } = await import('@tauri-apps/api/path')
  const dir = await join(await appDataDir(), 'fonts')
  await mkdir(dir, { recursive: true })
  const file = await join(dir, fileName)
  await writeFile(file + '.LICENSE.txt', license)
  try { await writeNativeFont(file, bytes) }
  catch (error) { await remove(file).catch(() => {}); throw error }
  bytesCache.delete(file)
  return { name, file }
}
