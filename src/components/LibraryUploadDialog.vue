<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'
import { getStorage } from '../storage'
import type { BookMeta, BooklistRec, CatalogSourceRec, LocalFileRef } from '../storage/types'
import { canConvertToEpub, detectFormat, EPUB_CONVERTIBLE } from '../services/format'
import { discoverLibraryUpload, LibraryUploadError, uploadLibraryBook, type LibraryUploadCapability } from '../services/libraryUpload'
import { t } from '../i18n'

const props = defineProps<{ source?: CatalogSourceRec; bookIds?: string[] }>()
const emit = defineEmits<{ close: []; uploaded: [] }>()
const sources = ref<CatalogSourceRec[]>([])
const sourceId = ref(props.source?.id ?? '')
const target = computed(() => props.source ?? sources.value.find(s => s.id === sourceId.value))
const capability = ref<LibraryUploadCapability>()
const checking = ref(false)
const connectionError = ref('')
const loadError = ref('')
const busy = ref(false)
// RouterView provides its route record to descendants, including this teleported dialog.
// Keep the task visible when browser/Android Back or a route update happens mid-upload.
onBeforeRouteLeave(() => !busy.value)
onBeforeRouteUpdate(() => !busy.value)
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
interface QueueEntry {
  key: string; name: string; file?: File; book?: BookMeta
  status: 'pending' | 'converting' | 'uploading' | 'success' | 'duplicate' | 'failed'
  error?: string
}
const queue = ref<QueueEntry[]>([])
const done = ref(0)
const total = ref(0)
const pendingCount = computed(() => queue.value.filter(x => x.status === 'pending').length)
const failedCount = computed(() => queue.value.filter(x => x.status === 'failed').length)
// 上传前转换为 EPUB (默认开): 书库收到最好的格式; 书库不收 EPUB 时不出现
const convertFirst = ref(true)
const canConvert = computed(() => !!capability.value?.formats.includes('epub'))
const willConvert = (format: ReturnType<typeof detectFormat>) =>
  convertFirst.value && canConvert.value && canConvertToEpub(format)
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
function close() { if (!busy.value) emit('close') }
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
function guardUnload(event: BeforeUnloadEvent) { if (busy.value) { event.preventDefault(); event.returnValue = '' } }
watch(target, async (source) => {
  const run = ++discovery
  capability.value = undefined
  connectionError.value = ''
  // Successful rows refer to their original destination; do not carry them to another library.
  queue.value = queue.value.filter(row => row.status === 'pending' || row.status === 'failed')
  for (const row of queue.value) { row.status = 'pending'; row.error = undefined }
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
  previousFocus = document.activeElement as HTMLElement | null
  await nextTick()
  panel.value?.focus()
  window.addEventListener('beforeunload', guardUnload)
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
onBeforeUnmount(() => { disposed = true; discovery++; window.removeEventListener('beforeunload', guardUnload); previousFocus?.focus() })
function toggle(id: string, event: Event) {
  const copy = new Set(selected.value)
  if ((event.target as HTMLInputElement).checked) copy.add(id); else copy.delete(id)
  selected.value = copy
}
function addSelected() {
  for (const book of books.value.filter(b => selected.value.has(b.id))) {
    const key = `book:${book.id}`
    if (!queue.value.some(row => row.key === key)) queue.value.push({ key, book, name: book.title, status: 'pending' })
  }
  selected.value = new Set()
}
function chooseFiles(event: Event) {
  const input = event.target as HTMLInputElement
  for (const file of Array.from(input.files ?? [])) {
    const key = `file:${file.name}:${file.size}:${file.lastModified}`
    if (!queue.value.some(row => row.key === key)) queue.value.push({ key, file, name: file.name, status: 'pending' })
  }
  input.value = ''
}
async function upload(retry = false) {
  const source = target.value, cap = capability.value
  if (busy.value || !source || !cap) return
  const rows = queue.value.filter(row => row.status === (retry ? 'failed' : 'pending'))
  if (!rows.length) return
  busy.value = true
  done.value = 0
  total.value = rows.length
  let changed = false
  try {
    const storage = await getStorage()
    for (const row of rows) {
      row.status = 'uploading'; row.error = undefined
      try {
        let fileName = row.file?.name ?? row.book!.fileName
        let format = detectFormat(fileName)
        let title = row.book?.title
        let author = row.book?.author
        let body: Blob | LocalFileRef | undefined = row.file
        if (willConvert(format)) {
          // 在本机转成 EPUB 再上传; 藏书里的原文件不变
          row.status = 'converting'
          let original: Blob | undefined = row.file
          if (!original) {
            try { original = await storage.getBookFile(row.book!.id) } catch { throw new LibraryUploadError('upload.fileUnavailable') }
          }
          const [{ convertBookToEpub }, { convertErrorText }] = await Promise.all([
            import('../services/bookToEpub'), import('../services/convertLibraryBook'),
          ])
          try {
            const converted = await convertBookToEpub(original, { fileName, meta: { title, author } })
            body = converted.epub
            fileName = converted.fileName
            format = 'epub'
            title = title || converted.title
            author = author || converted.author || undefined
          } catch (error) {
            throw new LibraryUploadError('upload.convertFailed', { msg: convertErrorText(error) })
          }
          row.status = 'uploading'
        }
        if (!format || !cap.formats.includes(format)) throw new LibraryUploadError('upload.unsupportedFormat')
        if (!body) {
          try {
            body = await storage.getBookFileRef?.(row.book!.id) ?? await storage.getBookFile(row.book!.id)
          } catch { throw new LibraryUploadError('upload.fileUnavailable') }
        }
        const result = await uploadLibraryBook(source, cap, { fileName, body, title, author })
        row.status = result.duplicate ? 'duplicate' : 'success'
        // Release device File handles once completed; retry only needs failed files.
        row.file = undefined
        changed = true
      } catch (error) { row.status = 'failed'; row.error = errorText(error) }
      done.value++
    }
  } catch (error) {
    for (const row of rows.filter(r => r.status === 'pending' || r.status === 'uploading' || r.status === 'failed')) {
      row.status = 'failed'; row.error = errorText(error)
    }
  } finally { busy.value = false; if (changed) emit('uploaded') }
}
</script>

<template>
  <Teleport to="body">
    <div class="upload-overlay" @click.self="close" @keydown="keydown">
      <section ref="panel" class="upload-dialog card" role="dialog" aria-modal="true" aria-labelledby="library-upload-title" tabindex="-1" :aria-busy="busy">
        <header class="upload-header"><h2 id="library-upload-title">{{ t('upload.title') }}</h2><button class="btn btn-sm" :disabled="busy" @click="close">{{ t('upload.close') }}</button></header>
        <div class="upload-body">
          <label class="upload-field">{{ t('upload.target') }}
            <strong v-if="source">{{ source.title }}</strong>
            <select v-else v-model="sourceId" class="input" :disabled="busy"><option value="">{{ t('upload.chooseTarget') }}</option><option v-for="item in sources" :key="item.id" :value="item.id">{{ item.title }}</option></select>
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
            <label v-if="canConvert" class="upload-convert"><input v-model="convertFirst" type="checkbox" :disabled="busy" /><span>{{ t('upload.convertFirst') }}<small>{{ t('upload.convertHint') }}</small></span></label>
            <div class="segmented upload-tabs"><button :class="{ active: mode === 'device' }" :disabled="busy" @click="mode = 'device'">{{ t('upload.device') }}</button><button :class="{ active: mode === 'existing' }" :disabled="busy" @click="mode = 'existing'">{{ t('upload.existing') }}</button></div>
            <div v-if="mode === 'device'" class="upload-device"><input ref="picker" type="file" multiple :accept="accept" hidden @change="chooseFiles" /><button class="btn" :disabled="busy" @click="picker?.click()">{{ t('upload.chooseFiles') }}</button></div>
            <div v-else class="upload-existing">
              <input v-model="query" class="input" type="search" :placeholder="t('upload.search')" :aria-label="t('upload.search')" :disabled="busy" />
              <div class="upload-filters"><select v-model="listFilter" class="input" :aria-label="t('upload.allBooks')" :disabled="busy"><option value="">{{ t('upload.allBooks') }}</option><option v-for="list in booklists" :key="list.id" :value="list.id">{{ list.name }}</option></select><label><input v-model="pinnedOnly" type="checkbox" :disabled="busy" /> {{ t('upload.pinned') }}</label></div>
              <div class="upload-actions"><button class="btn btn-sm" :disabled="busy" @click="selected = new Set([...selected, ...visibleBooks.map(b => b.id)])">{{ t('upload.selectVisible') }}</button><button class="btn btn-sm" :disabled="busy || !selected.size" @click="selected = new Set()">{{ t('upload.clearSelection') }}</button></div>
              <div class="upload-books"><label v-for="book in visibleBooks" :key="book.id" class="upload-book"><input type="checkbox" :checked="selected.has(book.id)" :disabled="busy" @change="toggle(book.id, $event)" /><span><strong>{{ book.title }}</strong><small>{{ book.author }} · {{ book.format.toUpperCase() }}</small></span></label><p v-if="!visibleBooks.length" class="upload-muted">{{ t('upload.noBooks') }}</p></div>
              <button class="btn" :disabled="busy || !selected.size" @click="addSelected">{{ t('upload.addSelected', { n: selected.size }) }}</button>
            </div>
          </template>
          <div v-if="queue.length" class="upload-queue"><h3>{{ t('upload.queue', { n: queue.length }) }}</h3><ul><li v-for="row in queue" :key="row.key"><div><strong>{{ row.name }}</strong><small :class="{ 'upload-error': row.status === 'failed', 'upload-success': row.status === 'success' || row.status === 'duplicate' }">{{ row.error ?? t(`upload.${row.status}`) }}</small></div><button v-if="!busy" class="btn btn-sm" :aria-label="t('upload.remove', { name: row.name })" @click="queue = queue.filter(x => x.key !== row.key)">×</button></li></ul></div>
        </div>
        <footer class="upload-footer"><div v-if="total" role="status" aria-live="polite">{{ t('upload.progress', { done, total }) }}<progress :value="done" :max="total" /></div><div class="upload-actions"><button v-if="failedCount" class="btn" :disabled="busy || !capability" @click="upload(true)">{{ t('upload.retry', { n: failedCount }) }}</button><button class="btn btn-primary" :disabled="busy || !capability || !pendingCount" @click="upload()">{{ busy ? t('upload.uploading') : t('upload.start', { n: pendingCount }) }}</button></div></footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.upload-overlay{position:fixed;inset:0;z-index:1100;background:var(--overlay, color-mix(in srgb,var(--text) 35%,transparent));display:flex;align-items:center;justify-content:center;padding:16px}
.upload-dialog{width:min(680px,100%);max-height:calc(100dvh - 32px);display:flex;flex-direction:column;background:var(--card);outline:none;padding:0;overflow:hidden}
.upload-header,.upload-footer{padding:16px 20px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-shrink:0}.upload-header{border-bottom:1px solid var(--border)}.upload-header h2{font-size:18px;margin:0}.upload-body{padding:16px 20px;overflow:auto;min-height:0}.upload-field{display:grid;gap:8px}.upload-muted{font-size:13px;line-height:1.6;color:var(--text-2);margin:8px 0}.upload-url{overflow-wrap:anywhere}.upload-error{color:var(--danger);line-height:1.6}.upload-success{color:var(--success)}.upload-tabs{margin:16px 0}.upload-convert{display:flex;align-items:flex-start;gap:8px;margin:12px 0 0;font-size:14px;cursor:pointer}.upload-convert input{margin-top:3px}.upload-convert small{display:block;margin-top:2px;color:var(--text-2);font-size:12px;line-height:1.5}.upload-device{padding:8px 0}.upload-existing{display:grid;gap:10px}.upload-filters,.upload-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.upload-filters select{flex:1;min-width:130px}.upload-filters label{font-size:13px;white-space:nowrap}.upload-books{max-height:220px;overflow:auto;border:1px solid var(--border);border-radius:8px}.upload-book{display:flex;align-items:center;gap:10px;padding:10px;border-bottom:1px solid var(--border);cursor:pointer}.upload-book:last-child{border:0}.upload-book span,.upload-queue li>div{min-width:0;flex:1}.upload-book strong,.upload-queue strong{font-size:14px;display:block;overflow-wrap:anywhere}.upload-book small,.upload-queue small{display:block;margin-top:4px;color:var(--text-2);font-size:12px;overflow-wrap:anywhere}.upload-queue{margin-top:18px}.upload-queue h3{font-size:14px}.upload-queue ul{padding:0;margin:0;list-style:none;max-height:240px;overflow:auto}.upload-queue li{display:flex;align-items:center;gap:8px;padding:10px 0;border-bottom:1px solid var(--border)}.upload-queue .upload-error{color:var(--danger)}.upload-queue .upload-success{color:var(--success)}.upload-footer{border-top:1px solid var(--border);flex-wrap:wrap}.upload-footer>div:first-child{font-size:13px}.upload-footer progress{display:block;width:100%;margin-top:6px;accent-color:var(--brand)}
@media(max-width:600px){.upload-overlay{padding:8px}.upload-dialog{max-height:calc(100dvh - 16px)}.upload-header,.upload-body,.upload-footer{padding:14px}.upload-tabs{display:flex}.upload-tabs button{flex:1;white-space:normal}.upload-footer .upload-actions{width:100%}.upload-footer .btn{flex:1}.upload-books{max-height:180px}}
</style>
