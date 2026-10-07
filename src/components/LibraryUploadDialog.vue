<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { getStorage } from '../storage'
import type { BookFormat, BookMeta, BooklistRec, CatalogSourceRec } from '../storage/types'
import { EPUB_CONVERTIBLE } from '../services/format'
import { discoverLibraryUpload, LibraryUploadError, type LibraryUploadCapability } from '../services/libraryUpload'
import {
  enqueueLibraryUpload, isFinished, libraryUploadTask, retryFailedLibraryUploads, type UploadTaskInput,
} from '../services/libraryUploadTask'
import { planFolderPick, type FolderPlan } from '../services/folderPick'
import { canPickFolder, loadFolderFile, scanFromFileList, scanNativeFolder, useNativeFolderPicker, type FolderFile, type FolderScan } from '../services/folderSource'
import FolderPickDialog from './FolderPickDialog.vue'
import { t } from '../i18n'

const props = defineProps<{ source?: CatalogSourceRec; bookIds?: string[] }>()
const emit = defineEmits<{ close: [] }>()
const sources = ref<CatalogSourceRec[]>([])
const sourceId = ref(props.source?.id ?? '')
const target = computed(() => props.source ?? sources.value.find(s => s.id === sourceId.value))
const capability = ref<LibraryUploadCapability>()
const checking = ref(false)
const connectionError = ref('')
const loadError = ref('')
const books = ref<BookMeta[]>([])
const booklists = ref<BooklistRec[]>([])
const listIds = ref<Record<string, string[]>>({})
const listFilter = ref('')
const pinnedOnly = ref(false)
const query = ref('')
const selected = ref<Set<string>>(new Set(props.bookIds ?? []))
const mode = ref<'device' | 'existing'>(props.bookIds?.length ? 'existing' : 'device')
const picker = ref<HTMLInputElement>()
const panel = ref<HTMLElement>()
let previousFocus: HTMLElement | null = null
let discovery = 0
let disposed = false
// 还没开始传的待选列表; 点「开始上传」后交给后台任务 (libraryUploadTask), 关掉弹窗也继续
const queue = ref<UploadTaskInput[]>([])
const task = libraryUploadTask
const taskDone = computed(() => task.rows.filter(isFinished).length)
const failedCount = computed(() => task.rows.filter(row => row.status === 'failed').length)
// 上传前转换为 EPUB (默认开): 书库收到最好的格式; 书库不收 EPUB 时不出现
const convertFirst = ref(true)
const canConvert = computed(() => !!capability.value?.formats.includes('epub'))
const accept = computed(() => {
  const formats = new Set<string>(capability.value?.formats ?? [])
  if (convertFirst.value && canConvert.value) for (const f of EPUB_CONVERTIBLE) formats.add(f)
  return [...formats].map(f => `.${f}`).join(',')
})
const visibleBooks = computed(() => {
  const ids = listFilter.value ? new Set(listIds.value[listFilter.value] ?? []) : null
  const q = query.value.trim().toLocaleLowerCase()
  return books.value.filter(book => (!ids || ids.has(book.id)) && (!pinnedOnly.value || book.pinnedAt) &&
    (!q || `${book.title} ${book.author}`.toLocaleLowerCase().includes(q)))
})
function errorText(error: unknown) {
  return error instanceof LibraryUploadError ? t(error.key, error.params) : t('upload.network')
}
function close() { emit('close') }
function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
  if (event.key !== 'Tab' || !panel.value) return
  const elements = Array.from(panel.value.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]'))
    .filter(el => el.getClientRects().length)
  const first = elements[0], last = elements[elements.length - 1]
  if (!first || !last) { event.preventDefault(); return }
  if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.value)) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
}
watch(target, async (source) => {
  const run = ++discovery
  capability.value = undefined
  connectionError.value = ''
  if (!source) { checking.value = false; return }
  checking.value = true
  try {
    const found = await discoverLibraryUpload(source)
    if (run === discovery && !disposed) capability.value = found
  } catch (error) {
    if (run === discovery && !disposed) connectionError.value = errorText(error)
  } finally { if (run === discovery && !disposed) checking.value = false }
}, { immediate: true })

onMounted(async () => {
  task.dialogs++
  previousFocus = document.activeElement as HTMLElement | null
  await nextTick()
  panel.value?.focus()
  try {
    const storage = await getStorage()
    const [allSources, allBooks, lists] = await Promise.all([storage.listSources(), storage.listBooks(), storage.listBooklists()])
    if (disposed) return
    sources.value = allSources.filter(s => s.kind === 'opds' && !s.builtin)
    books.value = allBooks
    booklists.value = lists
    for (const list of lists) listIds.value[list.id] = await storage.listBooklistBookIds(list.id)
    if (props.bookIds?.length) addSelected()
  } catch { loadError.value = t('upload.loadFailed') }
})
onBeforeUnmount(() => { disposed = true; discovery++; task.dialogs--; previousFocus?.focus() })
function toggle(id: string, event: Event) {
  const copy = new Set(selected.value)
  if ((event.target as HTMLInputElement).checked) copy.add(id); else copy.delete(id)
  selected.value = copy
}
function addSelected() {
  for (const book of books.value.filter(b => selected.value.has(b.id))) {
    const key = `book:${book.id}`
    if (!queue.value.some(row => row.key === key)) queue.value.push({ key, book, name: book.title })
  }
  selected.value = new Set()
}
function chooseFiles(event: Event) {
  const input = event.target as HTMLInputElement
  for (const file of Array.from(input.files ?? [])) {
    const key = `file:${file.name}:${file.size}:${file.lastModified}`
    if (!queue.value.some(row => row.key === key)) queue.value.push({ key, file, name: file.name })
  }
  input.value = ''
}
// 选择文件夹: 按书库支持的格式与大小上限挑书, 同一本书只传最推荐的格式, 确认后直接进后台队列
const folderInput = ref<HTMLInputElement>()
const folderSupported = canPickFolder()
const folderPick = ref<{ scanning: boolean; scan?: FolderScan; plan?: FolderPlan<FolderFile> } | null>(null)
const uploadFormats = computed(() => accept.value.split(',').filter(Boolean).map(ext => ext.slice(1)) as BookFormat[])
async function chooseFolder() {
  if (!useNativeFolderPicker()) { folderInput.value?.click(); return }
  try {
    const scan = await scanNativeFolder(name => { folderPick.value = { scanning: true, scan: { name, entries: [], truncated: false } } })
    if (scan && !disposed) showFolderPlan(scan); else folderPick.value = null
  } catch (error) {
    folderPick.value = null
    connectionError.value = t('folder.scanFailed', { msg: error instanceof Error ? error.message : String(error) })
  }
}
function onFolderPick(event: Event) {
  const input = event.target as HTMLInputElement
  const scan = input.files ? scanFromFileList(input.files) : null
  input.value = ''
  if (scan) showFolderPlan(scan)
}
function showFolderPlan(scan: FolderScan) {
  const cap = capability.value
  if (!cap) return
  folderPick.value = { scanning: false, scan, plan: planFolderPick(scan.entries, { formats: uploadFormats.value, maxBytes: cap.maxFileBytes }) }
}
function confirmFolderUpload() {
  const selected = folderPick.value?.plan?.selected ?? []
  folderPick.value = null
  const source = target.value, cap = capability.value
  if (!source || !cap || !selected.length) return
  enqueueLibraryUpload(source, cap, convertFirst.value && canConvert.value, selected.map(e => e.file
    ? { key: `file:${e.file.name}:${e.file.size}:${e.file.lastModified}`, name: e.path, file: e.file }
    : { key: `path:${e.absPath}`, name: e.path, loadFile: () => loadFolderFile(e) }))
}
function upload() {
  const source = target.value, cap = capability.value
  if (!source || !cap || !queue.value.length) return
  enqueueLibraryUpload(source, cap, convertFirst.value && canConvert.value, queue.value)
  queue.value = []
}
</script>

<template>
  <Teleport to="body">
    <div class="upload-overlay" @click.self="close" @keydown="keydown">
      <!-- 选文件夹的输入框放在对话框外: 对话框里只有一个文件输入框 (e2e 依赖) -->
      <input v-if="folderSupported && capability" ref="folderInput" type="file" webkitdirectory hidden data-folder-input @change="onFolderPick" />
      <section ref="panel" class="upload-dialog card" role="dialog" aria-modal="true" aria-labelledby="library-upload-title" tabindex="-1">
        <header class="upload-header"><h2 id="library-upload-title">{{ t('upload.title') }}</h2><button class="btn btn-sm" @click="close">{{ t('upload.close') }}</button></header>
        <div class="upload-body">
          <label class="upload-field">{{ t('upload.target') }}
            <strong v-if="source">{{ source.title }}</strong>
            <select v-else v-model="sourceId" class="input"><option value="">{{ t('upload.chooseTarget') }}</option><option v-for="item in sources" :key="item.id" :value="item.id">{{ item.title }}</option></select>
          </label>
          <p v-if="target" class="upload-muted upload-url">{{ target.url }}</p>
          <p v-else-if="!sources.length" class="upload-muted">{{ t('upload.noSources') }}</p>
          <p v-else class="upload-muted">{{ t('upload.targetHint') }}</p>
          <p v-if="checking" role="status">{{ t('upload.checking') }}</p>
          <p v-if="connectionError" class="upload-error" role="alert">{{ connectionError }}</p>
          <p v-if="loadError" class="upload-error" role="alert">{{ loadError }}</p>
          <template v-if="capability">
            <p class="upload-muted">{{ t('upload.ready', { formats: capability.formats.join(' / ').toUpperCase(), mb: Math.floor(capability.maxFileBytes / 1048576) }) }}</p>
            <p class="upload-muted">{{ t('upload.localHint') }}</p>
            <label v-if="canConvert" class="upload-convert"><input v-model="convertFirst" type="checkbox" /><span>{{ t('upload.convertFirst') }}<small>{{ t('upload.convertHint') }}</small></span></label>
            <div class="segmented upload-tabs"><button :class="{ active: mode === 'device' }" @click="mode = 'device'">{{ t('upload.device') }}</button><button :class="{ active: mode === 'existing' }" @click="mode = 'existing'">{{ t('upload.existing') }}</button></div>
            <div v-if="mode === 'device'" class="upload-device"><input ref="picker" type="file" multiple :accept="accept" hidden @change="chooseFiles" /><button class="btn" @click="picker?.click()">{{ t('upload.chooseFiles') }}</button><button v-if="folderSupported" class="btn upload-folder" @click="chooseFolder()">{{ t('folder.choose') }}</button></div>
            <div v-else class="upload-existing">
              <input v-model="query" class="input" type="search" :placeholder="t('upload.search')" :aria-label="t('upload.search')" />
              <div class="upload-filters"><select v-model="listFilter" class="input" :aria-label="t('upload.allBooks')"><option value="">{{ t('upload.allBooks') }}</option><option v-for="list in booklists" :key="list.id" :value="list.id">{{ list.name }}</option></select><label><input v-model="pinnedOnly" type="checkbox" /> {{ t('upload.pinned') }}</label></div>
              <div class="upload-actions"><button class="btn btn-sm" @click="selected = new Set([...selected, ...visibleBooks.map(b => b.id)])">{{ t('upload.selectVisible') }}</button><button class="btn btn-sm" :disabled="!selected.size" @click="selected = new Set()">{{ t('upload.clearSelection') }}</button></div>
              <div class="upload-books"><label v-for="book in visibleBooks" :key="book.id" class="upload-book"><input type="checkbox" :checked="selected.has(book.id)" @change="toggle(book.id, $event)" /><span><strong>{{ book.title }}</strong><small>{{ book.author }} · {{ book.format.toUpperCase() }}</small></span></label><p v-if="!visibleBooks.length" class="upload-muted">{{ t('upload.noBooks') }}</p></div>
              <button class="btn" :disabled="!selected.size" @click="addSelected">{{ t('upload.addSelected', { n: selected.size }) }}</button>
            </div>
          </template>
          <div v-if="queue.length" class="upload-queue upload-pending"><h3>{{ t('upload.queue', { n: queue.length }) }}</h3><ul><li v-for="row in queue" :key="row.key"><div><strong>{{ row.name }}</strong><small>{{ t('upload.pending') }}</small></div><button class="btn btn-sm" :aria-label="t('upload.remove', { name: row.name })" @click="queue = queue.filter(x => x.key !== row.key)">×</button></li></ul></div>
          <div v-if="task.rows.length" class="upload-queue upload-task"><h3>{{ t('upload.task', { done: taskDone, total: task.rows.length }) }}</h3><p v-if="task.running" class="upload-muted">{{ t('upload.background') }}</p><ul><li v-for="row in task.rows" :key="row.id"><div><strong>{{ row.name }}</strong><small :class="{ 'upload-error': row.status === 'failed', 'upload-success': row.status === 'success' || row.status === 'duplicate' }">{{ row.error ? t(row.error.key, row.error.params) : t(`upload.${row.status}`) }}<template v-if="row.source.id !== target?.id"> · {{ row.source.title }}</template></small></div></li></ul></div>
        </div>
        <footer class="upload-footer"><div v-if="task.rows.length" role="status" aria-live="polite">{{ t('upload.progress', { done: taskDone, total: task.rows.length }) }}<progress :value="taskDone" :max="task.rows.length" /></div><div class="upload-actions"><button v-if="failedCount && !task.running" class="btn" @click="retryFailedLibraryUploads()">{{ t('upload.retry', { n: failedCount }) }}</button><button class="btn btn-primary" :disabled="!capability || !queue.length" @click="upload()">{{ task.running ? t('upload.addToTask', { n: queue.length }) : t('upload.start', { n: queue.length }) }}</button></div></footer>
      </section>
    </div>
  </Teleport>
  <FolderPickDialog
    v-if="folderPick"
    action="upload"
    :scanning="folderPick.scanning"
    :scan="folderPick.scan"
    :plan="folderPick.plan"
    :max-mb="capability ? Math.floor(capability.maxFileBytes / 1048576) : undefined"
    @confirm="confirmFolderUpload"
    @cancel="folderPick = null"
  />
</template>

<style scoped>
.upload-overlay{position:fixed;inset:0;z-index:1100;background:var(--overlay, color-mix(in srgb,var(--text) 35%,transparent));display:flex;align-items:center;justify-content:center;padding:16px}
.upload-dialog{width:min(680px,100%);max-height:calc(100dvh - 32px);display:flex;flex-direction:column;background:var(--card);outline:none;padding:0;overflow:hidden}
.upload-header,.upload-footer{padding:16px 20px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-shrink:0}.upload-header{border-bottom:1px solid var(--border)}.upload-header h2{font-size:18px;margin:0}.upload-body{padding:16px 20px;overflow:auto;min-height:0}.upload-field{display:grid;gap:8px}.upload-muted{font-size:13px;line-height:1.6;color:var(--text-2);margin:8px 0}.upload-url{overflow-wrap:anywhere}.upload-error{color:var(--danger);line-height:1.6}.upload-success{color:var(--success)}.upload-tabs{margin:16px 0}.upload-convert{display:flex;align-items:flex-start;gap:8px;margin:12px 0 0;font-size:14px;cursor:pointer}.upload-convert input{margin-top:3px}.upload-convert small{display:block;margin-top:2px;color:var(--text-2);font-size:12px;line-height:1.5}.upload-device{padding:8px 0;display:flex;gap:8px;flex-wrap:wrap}.upload-existing{display:grid;gap:10px}.upload-filters,.upload-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.upload-filters select{flex:1;min-width:130px}.upload-filters label{font-size:13px;white-space:nowrap}.upload-books{max-height:220px;overflow:auto;border:1px solid var(--border);border-radius:8px}.upload-book{display:flex;align-items:center;gap:10px;padding:10px;border-bottom:1px solid var(--border);cursor:pointer}.upload-book:last-child{border:0}.upload-book span,.upload-queue li>div{min-width:0;flex:1}.upload-book strong,.upload-queue strong{font-size:14px;display:block;overflow-wrap:anywhere}.upload-book small,.upload-queue small{display:block;margin-top:4px;color:var(--text-2);font-size:12px;overflow-wrap:anywhere}.upload-queue{margin-top:18px}.upload-queue h3{font-size:14px}.upload-queue ul{padding:0;margin:0;list-style:none;max-height:240px;overflow:auto}.upload-queue li{display:flex;align-items:center;gap:8px;padding:10px 0;border-bottom:1px solid var(--border)}.upload-queue .upload-error{color:var(--danger)}.upload-queue .upload-success{color:var(--success)}.upload-footer{border-top:1px solid var(--border);flex-wrap:wrap}.upload-footer>div:first-child{font-size:13px}.upload-footer progress{display:block;width:100%;margin-top:6px;accent-color:var(--brand)}
@media(max-width:600px){.upload-overlay{padding:8px}.upload-dialog{max-height:calc(100dvh - 16px)}.upload-header,.upload-body,.upload-footer{padding:14px}.upload-tabs{display:flex}.upload-tabs button{flex:1;white-space:normal}.upload-footer .upload-actions{width:100%}.upload-footer .btn{flex:1}.upload-books{max-height:180px}}
</style>
