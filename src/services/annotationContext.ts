/**
 * 为导出 / 金句卡片补全划线的上下文 (只在书已打开时可用):
 *  - 章节名: 书自带目录走 foliate 的 TOCProgress (与阅读器页眉同一套判定);
 *    智能目录 (TXT 等识别出的章节) 按 CFI 二分查找
 *  - 完整原文: 旧版本入库时把划线截到 300 字, 这里按 CFI 回到章节文档取回全文
 *  - 排序: 按书中位置 (CFI 比较)
 * 失败一律静默回退到已存的数据, 不影响导出.
 */
import { compare as compareCfi } from 'foliate-js/epubcfi.js'
import { TOCProgress } from 'foliate-js/progress.js'
import type { AnnotationRec } from '../storage'
import { findCurrentSmartItem } from './smartToc'
import { sortNotes, type NoteItem } from './notesExport'

/** 旧版本入库时截断划线的长度 (ReaderView addHighlight 曾用 text.slice(0, 300)) */
export const LEGACY_TEXT_CAP = 300
/** 现在入库的上限: 足够放下一整段, 又不至于把整章塞进一条记录 */
export const HIGHLIGHT_TEXT_MAX = 5000

interface FoliateView {
  book: any
  resolveCFI(cfi: string): { index: number; anchor: (doc: Document) => Range | Element }
}

const squash = (s: string) => s.replace(/\s+/g, '')

/** 取回的全文必须以已存文本开头 (忽略空白差异), 否则视为定位失败 */
export function acceptRecovered(stored: string, recovered: string): boolean {
  const a = squash(stored), b = squash(recovered)
  return !!a && b.length > a.length && b.startsWith(a.slice(0, Math.min(a.length, 200)))
}

/** 选区文字的空白整理: 与 Selection.toString() 的结果保持一致的观感 */
export function tidyRangeText(text: string): string {
  return text.replace(/[ \t ]+/g, ' ').replace(/ *\n[\s]*/g, '\n').trim()
}

export interface ResolveOptions {
  /** 智能目录 (阅读器 tocAuto 时) */
  smartToc?: Array<{ label: string; href: string }>
}

export interface ResolvedAnnotation {
  chapter?: string
  /** 取回的完整原文; 未截断或取不回时为空 */
  fullText?: string
}

/**
 * 解析一批标注的章节与全文. 同一章节的文档只加载一次.
 * 返回 id → 结果; 解析失败的 id 不出现在结果里.
 */
export async function resolveAnnotations(view: FoliateView, annos: AnnotationRec[], opts: ResolveOptions = {}): Promise<Map<string, ResolvedAnnotation>> {
  const out = new Map<string, ResolvedAnnotation>()
  const book = view?.book
  if (!book) return out
  let toc: TOCProgress | null = null
  if (!opts.smartToc?.length && book.splitTOCHref && book.getTOCFragment && book.toc?.length) {
    try {
      toc = new TOCProgress()
      await toc.init({
        toc: book.toc,
        ids: book.sections.map((s: any) => s.id),
        splitHref: book.splitTOCHref.bind(book),
        getFragment: book.getTOCFragment.bind(book),
      })
    } catch { toc = null }
  }
  const docs = new Map<number, Promise<Document | null>>()
  const loadDoc = (index: number) => {
    if (!docs.has(index)) {
      const section = book.sections?.[index]
      docs.set(index, section?.createDocument ? Promise.resolve(section.createDocument()).catch(() => null) : Promise.resolve(null))
    }
    return docs.get(index)!
  }
  for (const a of annos) {
    if (!a.cfi) continue
    const r: ResolvedAnnotation = {}
    if (opts.smartToc?.length) r.chapter = findCurrentSmartItem(opts.smartToc, a.cfi)?.label
    const needText = a.kind !== 'bookmark' && [...a.text].length >= LEGACY_TEXT_CAP
    if (toc || needText) {
      try {
        const { index, anchor } = view.resolveCFI(a.cfi)
        const doc = await loadDoc(index)
        let range: Range | null = null
        if (doc) {
          const hit = anchor(doc)
          if (hit instanceof Range || (hit && 'startContainer' in hit)) range = hit as Range
          else if (hit) { range = doc.createRange(); range.selectNodeContents(hit as Element) }
        }
        if (toc && !r.chapter) r.chapter = toc.getProgress(index, range ?? undefined)?.label?.trim() || undefined
        if (needText && range) {
          const full = tidyRangeText(range.toString()).slice(0, HIGHLIGHT_TEXT_MAX)
          if (acceptRecovered(a.text, full)) r.fullText = full
        }
      } catch { /* 定位失败, 用已存数据 */ }
    }
    if (r.chapter || r.fullText) out.set(a.id, r)
  }
  return out
}

/** AnnotationRec → 导出用的 NoteItem, 按书中位置排序 */
export function toNoteItems(annos: AnnotationRec[], resolved: Map<string, ResolvedAnnotation>): NoteItem[] {
  const items = annos.map(a => {
    const r = resolved.get(a.id)
    return {
      id: a.id,
      kind: a.kind ?? 'highlight',
      text: r?.fullText ?? a.text,
      note: a.note,
      color: a.color,
      createdAt: a.createdAt,
      chapter: r?.chapter,
      position: a.cfi,
    } satisfies NoteItem
  })
  return sortNotes(items, compareCfi)
}

/**
 * 这一下轻点是否落在划线上 (foliate overlayer 的命中测试, 坐标为 iframe 内 client 坐标).
 * 触屏轻点在 touchend 就判定翻页 / 切换工具栏, 早于 foliate 由 click 派发的 show-annotation;
 * 落在划线上时阅读器应只弹划线工具条, 不再按轻点分区翻页或切换工具栏. 搜索结果高亮不算.
 */
export function hitsAnnotation(view: unknown, doc: Document, x: number, y: number): boolean {
  type Overlayer = { hitTest?(p: { x: number; y: number }): [string?, Range?] }
  const renderer = (view as { renderer?: { getContents?(): Array<{ doc?: Document; overlayer?: Overlayer }> } } | null)?.renderer
  const overlayer = renderer?.getContents?.()?.find(c => c.doc === doc)?.overlayer
  const [value] = overlayer?.hitTest?.({ x, y }) ?? []
  return !!value && !value.startsWith('foliate-search:')
}
