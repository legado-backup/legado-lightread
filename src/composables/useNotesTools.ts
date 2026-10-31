/**
 * 阅读器笔记面板的书摘能力 (桌面与 App 的 EPUB 阅读器共用):
 *  - 划线按书中位置排序并按章节分组, 章节名与被截断的旧划线全文在面板打开时补全 (annotationContext)
 *  - 复制全部 / 导出 (NotesExportDialog) / 复制单条
 *  - 金句卡片 (QuoteCardDialog): 来自选区、划线或面板条目
 * 视图只负责把按钮与两个对话框接到这里.
 */
import { computed, ref, shallowRef, watch, type Ref } from 'vue'
import { getStorage, type AnnotationRec, type BookMeta } from '../storage'
import { resolveAnnotations, toNoteItems, type ResolvedAnnotation } from '../services/annotationContext'
import { buildNotesExport, noteToClipboard, DEFAULT_NOTES_OPTIONS, type NoteItem, type NotesBook } from '../services/notesExport'
import { copyText } from '../services/shareOut'
import { HIGHLIGHT_COLORS } from '../services/readerTheme'
import type { QuoteCardData } from '../services/quoteCard'
import { toast } from '../services/toast'
import { t } from '../i18n'

export interface NotesToolsDeps {
  meta: Ref<BookMeta | null | undefined>
  annotations: Ref<AnnotationRec[]>
  /** 当前 foliate-view; 书未打开时为空 */
  getView: () => any
  /** 智能目录 (书本身无目录时); 没有时返回空 */
  getSmartToc: () => Array<{ label: string; href: string }>
  lang: () => 'zh' | 'en'
  /**
   * PDF: 由位置串取页码与纵坐标 (PaperReaderView 的 decodeLoc). 提供时按页码 + 坐标排序、按页分组,
   * 不走 foliate 的章节解析.
   */
  pdfLoc?: (cfi: string) => { page: number; y: number } | null
}

export interface ChapterGroup {
  chapter: string
  items: AnnotationRec[]
}

export function useNotesTools(deps: NotesToolsDeps) {
  const resolved = shallowRef(new Map<string, ResolvedAnnotation>())
  const resolving = ref(false)
  const exportOpen = ref(false)
  const card = shallowRef<QuoteCardData | null>(null)
  let resolvedFor = ''

  const book = computed<NotesBook>(() => ({
    title: deps.meta.value?.title ?? '',
    author: deps.meta.value?.author || undefined,
    format: deps.meta.value?.format,
  }))

  /** 已排序的导出条目 (含书签) */
  const noteItems = computed<NoteItem[]>(() => (deps.pdfLoc ? pdfItems(deps.annotations.value, deps.pdfLoc) : toNoteItems(deps.annotations.value, resolved.value)))

  /** 面板用: 划线按章节分组, 保持书中顺序 */
  const highlightGroups = computed<ChapterGroup[]>(() => {
    const byId = new Map(deps.annotations.value.map(a => [a.id, a]))
    const groups: ChapterGroup[] = []
    for (const item of noteItems.value) {
      if (item.kind === 'bookmark') continue
      const a = byId.get(item.id)
      if (!a) continue
      const chapter = item.chapter ?? (item.page ? t('notes.page', { n: item.page }) : '')
      const last = groups.at(-1)
      if (last && last.chapter === chapter) last.items.push(a)
      else groups.push({ chapter, items: [a] })
    }
    return groups
  })

  const highlightCount = computed(() => deps.annotations.value.filter(a => a.kind !== 'bookmark').length)

  /** 显示 / 导出用的全文 (旧划线取回的全文优先) */
  function fullText(a: AnnotationRec): string {
    return resolved.value.get(a.id)?.fullText ?? a.text
  }

  function chapterOf(a: AnnotationRec): string | undefined {
    if (deps.pdfLoc) {
      const page = deps.pdfLoc(a.cfi)?.page
      return page ? t('notes.page', { n: page }) : undefined
    }
    return resolved.value.get(a.id)?.chapter
  }

  /** 补全章节与全文; 标注集合没变时不重复解析. 取回的全文写回存储, 以后在其他设备也完整 */
  async function refresh(force = false) {
    if (deps.pdfLoc) return
    const view = deps.getView()
    if (!view?.book) return
    const key = deps.annotations.value.map(a => a.id).join(',')
    if (!force && key === resolvedFor) return
    resolving.value = true
    try {
      const map = await resolveAnnotations(view, deps.annotations.value, { smartToc: deps.getSmartToc() })
      resolvedFor = key
      resolved.value = map
      const storage = await getStorage()
      for (const a of deps.annotations.value) {
        const full = map.get(a.id)?.fullText
        if (!full || full === a.text) continue
        try {
          await storage.updateAnnotation(a.id, { text: full })
          a.text = full
        } catch { /* 写回失败不影响本次导出 */ }
      }
    } catch (e) {
      console.warn('resolve annotations failed', e)
    } finally {
      resolving.value = false
    }
  }

  // 标注增删后标记需要重新解析 (面板打开时再算)
  watch(() => deps.annotations.value.length, () => { resolvedFor = '' })

  async function copyAll() {
    await refresh()
    const content = buildNotesExport(book.value, noteItems.value, { format: 'txt', ...DEFAULT_NOTES_OPTIONS, lang: deps.lang() })
    try {
      await copyText(content)
      toast(t('notes.copiedAll', { n: highlightCount.value }), 'success')
    } catch {
      toast(t('notes.copyFailed'), 'error')
    }
  }

  async function copyOne(a: AnnotationRec) {
    const item = noteItems.value.find(i => i.id === a.id)
    try {
      await copyText(noteToClipboard(book.value, item ?? { id: a.id, kind: 'highlight', text: a.text, note: a.note, color: a.color, createdAt: a.createdAt }, deps.lang()))
      toast(t('notes.copied'), 'success')
    } catch {
      toast(t('notes.copyFailed'), 'error')
    }
  }

  async function openExport() {
    exportOpen.value = true
    void refresh()
  }

  async function cardFromAnnotation(a: AnnotationRec) {
    if (!resolved.value.has(a.id)) await refresh()
    card.value = {
      text: fullText(a),
      note: a.note,
      title: book.value.title,
      author: book.value.author,
      chapter: chapterOf(a),
      date: a.createdAt,
      highlight: HIGHLIGHT_COLORS[a.color],
      lang: deps.lang(),
    }
  }

  /** 选区直接生成卡片 (不必先划线); 章节取当前页眉 */
  function cardFromSelection(text: string, chapter?: string) {
    card.value = {
      text,
      title: book.value.title,
      author: book.value.author,
      chapter: chapter || undefined,
      date: Date.now(),
      lang: deps.lang(),
    }
  }

  return {
    book, noteItems, highlightGroups, highlightCount, resolving,
    exportOpen, card,
    refresh, copyAll, copyOne, openExport, cardFromAnnotation, cardFromSelection, fullText,
  }
}

/** PDF 标注 → 导出条目: 按页码、再按页内纵坐标排序 */
function pdfItems(annos: AnnotationRec[], loc: (cfi: string) => { page: number; y: number } | null): NoteItem[] {
  return annos
    .map(a => {
      const l = loc(a.cfi)
      return {
        item: {
          id: a.id,
          kind: a.kind ?? 'highlight',
          text: a.text,
          note: a.note,
          color: a.color,
          createdAt: a.createdAt,
          page: l?.page,
          position: a.cfi,
        } satisfies NoteItem,
        y: l?.y ?? 0,
      }
    })
    .sort((x, y) => (x.item.page ?? 0) - (y.item.page ?? 0) || x.y - y.y || x.item.createdAt - y.item.createdAt)
    .map(x => x.item)
}
