<script setup lang="ts">
/** 导出一本书的划线与想法: Markdown / 纯文本 / JSON / CSV, 可复制、存文件或 (App) 系统分享. 见 services/notesExport.ts */
import { computed, reactive, watch } from 'vue'
import AppModal from './AppModal.vue'
import {
  buildNotesExport, notesFileName, selectNotes, NOTES_FORMATS, NOTES_MIME,
  type NoteItem, type NotesBook, type NotesFormat,
} from '../services/notesExport'
import { HIGHLIGHT_COLORS } from '../services/readerTheme'
import { canShareText, copyText, saveFileAs, shareFile, shareText, isAndroidApp } from '../services/shareOut'
import { toast } from '../services/toast'
import { t } from '../i18n'

const props = defineProps<{ book: NotesBook; items: NoteItem[]; lang: 'zh' | 'en'; busy?: boolean }>()
const emit = defineEmits<{ close: [] }>()

const STORE_KEY = 'lightread-notes-export'
interface Prefs { format: NotesFormat; chapters: boolean; notes: boolean; time: boolean; bookmarks: boolean; colors: string[] }
function loadPrefs(): Prefs {
  const base: Prefs = { format: 'md', chapters: true, notes: true, time: false, bookmarks: false, colors: [] }
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}')
    if (NOTES_FORMATS.includes(saved.format)) base.format = saved.format
    for (const k of ['chapters', 'notes', 'time', 'bookmarks'] as const) if (typeof saved[k] === 'boolean') base[k] = saved[k]
  } catch { /* 用默认 */ }
  return base
}
const prefs = reactive(loadPrefs())
watch(prefs, () => {
  try {
    const { colors: _c, ...rest } = prefs
    localStorage.setItem(STORE_KEY, JSON.stringify(rest))
  } catch { /* 存不了就算了 */ }
})

const opts = computed(() => ({ ...prefs, lang: props.lang }))
const content = computed(() => buildNotesExport(props.book, props.items, opts.value))
const picked = computed(() => selectNotes(props.items, opts.value))
const highlightTotal = computed(() => props.items.filter(i => i.kind !== 'bookmark').length)
const usedColors = computed(() => Object.keys(HIGHLIGHT_COLORS).filter(c => props.items.some(i => i.kind !== 'bookmark' && i.color === c)))
const preview = computed(() => (content.value.length > 6000 ? content.value.slice(0, 6000) + '\n…' : content.value))
const fileName = computed(() => notesFileName(props.book.title, prefs.format, props.lang))

function toggleColor(c: string) {
  const i = prefs.colors.indexOf(c)
  if (i >= 0) prefs.colors.splice(i, 1)
  else prefs.colors.push(c)
}

const FORMAT_LABEL: Record<NotesFormat, string> = { md: 'Markdown', txt: '', json: 'JSON', csv: 'CSV' }
const formatLabel = (f: NotesFormat) => (f === 'txt' ? t('notes.formatTxt') : FORMAT_LABEL[f])
const formatHint = computed(() => t(`notes.formatHint.${prefs.format}`))

async function copy() {
  try {
    await copyText(content.value)
    toast(t('notes.copiedAll', { n: picked.value.filter(i => i.kind !== 'bookmark').length }), 'success')
  } catch {
    toast(t('notes.copyFailed'), 'error')
  }
}

const blob = () => new Blob([content.value], { type: `${NOTES_MIME[prefs.format]};charset=utf-8` })

async function save() {
  try {
    const ok = await saveFileAs(blob(), fileName.value, { name: prefs.format.toUpperCase(), extensions: [prefs.format] })
    if (ok) toast(t('notes.saved'), 'success')
  } catch (e: any) {
    toast(e?.message ? `${t('notes.saveFailed')}: ${e.message}` : t('notes.saveFailed'), 'error', 6000)
  }
}

async function share() {
  try {
    // App 里按文件分享 (笔记应用能直接收), 网页按文本分享
    if (isAndroidApp()) await shareFile(blob(), fileName.value, NOTES_MIME[prefs.format], t('notes.shareTitle'))
    else await shareText(content.value, fileName.value, t('notes.shareTitle'))
  } catch {
    toast(t('notes.shareFailed'), 'error')
  }
}
</script>

<template>
  <AppModal wide :title="t('notes.exportTitle', { title: book.title })" @close="emit('close')">
    <div class="nx">
      <div class="nx-opts">
        <div class="nx-field">
          <span class="nx-label">{{ t('notes.format') }}</span>
          <div class="segmented nx-formats">
            <button v-for="f in NOTES_FORMATS" :key="f" :class="{ active: prefs.format === f }" :aria-pressed="prefs.format === f" @click="prefs.format = f">{{ formatLabel(f) }}</button>
          </div>
          <p class="nx-hint">{{ formatHint }}</p>
        </div>
        <div v-if="usedColors.length > 1" class="nx-field">
          <span class="nx-label">{{ t('notes.range') }}</span>
          <div class="nx-colors">
            <button class="nx-chip" :class="{ on: !prefs.colors.length }" :aria-pressed="!prefs.colors.length" @click="prefs.colors.splice(0)">{{ t('notes.allColors') }}</button>
            <button
              v-for="c in usedColors"
              :key="c"
              class="nx-dot"
              :class="{ on: prefs.colors.includes(c) }"
              :aria-pressed="prefs.colors.includes(c)"
              :title="t(`reader.highlightColor.${c}`)"
              :aria-label="t(`reader.highlightColor.${c}`)"
              @click="toggleColor(c)"
            ><i :style="{ background: HIGHLIGHT_COLORS[c] }" /></button>
          </div>
        </div>
        <div class="nx-field">
          <span class="nx-label">{{ t('notes.include') }}</span>
          <label v-if="prefs.format === 'md' || prefs.format === 'txt'" class="nx-check"><input v-model="prefs.chapters" type="checkbox" /> {{ t('notes.withChapters') }}</label>
          <label class="nx-check"><input v-model="prefs.notes" type="checkbox" /> {{ t('notes.withNotes') }}</label>
          <label v-if="prefs.format === 'md' || prefs.format === 'txt'" class="nx-check"><input v-model="prefs.time" type="checkbox" /> {{ t('notes.withTime') }}</label>
          <label v-if="prefs.format === 'json'" class="nx-check"><input v-model="prefs.bookmarks" type="checkbox" /> {{ t('notes.withBookmarks') }}</label>
        </div>
      </div>
      <div class="nx-preview-wrap">
        <pre class="nx-preview" :aria-label="t('notes.preview')" tabindex="0">{{ preview }}</pre>
        <p v-if="busy" class="nx-hint">{{ t('notes.resolving') }}</p>
      </div>
    </div>
    <template #footer>
      <div class="nx-actions">
        <span class="nx-count">{{ t('notes.countLine', { n: picked.filter(i => i.kind !== 'bookmark').length, total: highlightTotal }) }}</span>
        <button v-if="canShareText()" class="btn btn-sm" @click="share">{{ t('notes.share') }}</button>
        <button class="btn btn-sm" @click="save">{{ t('notes.saveFile') }}</button>
        <button class="btn btn-sm btn-primary" :disabled="!picked.length" @click="copy">{{ t('notes.copy') }}</button>
      </div>
    </template>
  </AppModal>
</template>

<style scoped>
.nx { display: grid; grid-template-columns: 250px minmax(0, 1fr); gap: var(--space-4); padding: var(--space-4) var(--space-5); }
.nx-opts { display: grid; gap: var(--space-4); align-content: start; min-width: 0; }
.nx-field { display: grid; gap: var(--space-2); }
.nx-label { font-size: var(--fs-caption); color: var(--text-3); }
.nx-formats { flex-wrap: wrap; }
.nx-hint { margin: 0; font-size: var(--fs-caption); line-height: 1.5; color: var(--text-3); }
.nx-colors { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.nx-chip { min-height: 32px; padding: 0 12px; border: 1px solid var(--border); border-radius: var(--radius-pill); background: var(--card); color: var(--text-2); font-size: var(--fs-small); cursor: pointer; }
.nx-chip.on { border-color: var(--brand); color: var(--brand); background: var(--brand-soft); }
.nx-dot { display: grid; place-items: center; width: 32px; height: 32px; padding: 0; border: 2px solid transparent; border-radius: var(--radius-pill); background: none; cursor: pointer; }
.nx-dot i { width: 18px; height: 18px; border-radius: var(--radius-pill); }
.nx-dot.on { border-color: var(--text-2); }
.nx-check { display: flex; align-items: center; gap: var(--space-2); min-height: 32px; font-size: var(--fs-small); cursor: pointer; }
.nx-check input { width: 16px; height: 16px; margin: 0; accent-color: var(--brand); }
.nx-preview-wrap { min-width: 0; display: grid; gap: var(--space-2); align-content: start; }
.nx-preview { margin: 0; min-height: 220px; max-height: 52vh; overflow: auto; padding: var(--space-3); border-radius: var(--radius); background: var(--surface-2); color: var(--text); font-family: var(--font-mono); font-size: var(--fs-caption); line-height: 1.7; white-space: pre-wrap; word-break: break-word; }
.nx-actions { display: flex; align-items: center; justify-content: flex-end; gap: var(--space-2); flex-wrap: wrap; }
.nx-count { margin-right: auto; font-size: var(--fs-caption); color: var(--text-3); }
@media (max-width: 720px) {
  .nx { grid-template-columns: minmax(0, 1fr); padding: var(--space-3) var(--space-4); }
  .nx-preview { min-height: 140px; max-height: 30vh; }
  .nx-actions .btn { flex: 1; min-height: 44px; }
  .nx-count { flex-basis: 100%; }
}
</style>
