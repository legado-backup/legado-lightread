/**
 * 笔记导出 (issue #16): 把一本书的划线、想法整理成 Markdown / 纯文本 / JSON / CSV.
 * 纯函数, 不碰存储与 DOM; 章节名、完整原文由阅读器解析后填进 NoteItem (见 annotationContext.ts).
 *
 *  - Markdown: Obsidian / Notion / Logseq 直接用, 章节为二级标题, 划线为引用块
 *  - 纯文本: 沿用微信读书「复制全部笔记」的版式 (◆ 章节 / >> 划线), 贴到聊天、备忘录、已有笔记流程不用改
 *  - JSON: 完整结构化数据 (含位置与颜色), 供备份、脚本处理或别的应用导入
 *  - CSV: Readwise 导入格式 (Highlight, Title, Author, URL, Note, Location, Date)
 */

export type NotesFormat = 'md' | 'txt' | 'json' | 'csv'
export const NOTES_FORMATS: NotesFormat[] = ['md', 'txt', 'json', 'csv']

export interface NoteItem {
  id: string
  kind: 'highlight' | 'bookmark'
  text: string
  note?: string
  color: string
  createdAt: number
  /** 所在章节名, 解析不到时为空 */
  chapter?: string
  /** 书内位置: EPUB CFI 或 PDF 位置串 */
  position?: string
  /** PDF 页码 (从 1 开始) */
  page?: number
}

export interface NotesBook {
  title: string
  author?: string
  format?: string
}

export interface NotesExportOptions {
  format: NotesFormat
  /** 按章节分组 (Markdown / 纯文本) */
  chapters: boolean
  /** 带上想法 */
  notes: boolean
  /** 带上划线时间 */
  time: boolean
  /** 只导出这些颜色; 空或缺省为全部 */
  colors?: string[]
  /** 连同书签一起导出 (只对 JSON 生效) */
  bookmarks?: boolean
  lang?: 'zh' | 'en'
  /** 导出时间, 测试时固定 */
  now?: number
}

export const DEFAULT_NOTES_OPTIONS: Omit<NotesExportOptions, 'format'> = {
  chapters: true,
  notes: true,
  time: false,
}

const L = {
  zh: {
    mdTitle: (title: string) => `《${title}》读书笔记`,
    author: '作者',
    count: (h: number, n: number) => (n ? `${h} 条划线，${n} 条想法` : `${h} 条划线`),
    exported: '导出自轻阅',
    thought: '想法',
    txtCount: (n: number) => `${n}个笔记`,
    page: (p: number) => `第 ${p} 页`,
    sep: '：',
  },
  en: {
    mdTitle: (title: string) => `Notes on ${title}`,
    author: 'Author',
    count: (h: number, n: number) =>
      `${h} highlight${h === 1 ? '' : 's'}` + (n ? `, ${n} note${n === 1 ? '' : 's'}` : ''),
    exported: 'Exported from LightRead',
    thought: 'Note',
    txtCount: (n: number) => `${n} note${n === 1 ? '' : 's'}`,
    page: (p: number) => `Page ${p}`,
    sep: ': ',
  },
}

const pad = (n: number) => String(n).padStart(2, '0')

/** 本地时间 YYYY-MM-DD HH:MM */
export function formatNoteTime(ms: number, seconds = false): string {
  const d = new Date(ms)
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  return seconds ? `${base}:${pad(d.getSeconds())}` : base
}

/** 正文里的换行统一成 \n, 去掉首尾空白与连续空行 */
function clean(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[ \t　]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** 按颜色 / 类型筛选 (导出与「复制全部」共用) */
export function selectNotes(items: NoteItem[], opts: Pick<NotesExportOptions, 'colors' | 'bookmarks' | 'format'>): NoteItem[] {
  const colors = opts.colors?.length ? new Set(opts.colors) : null
  return items.filter(item => {
    if (item.kind === 'bookmark') return opts.format === 'json' && !!opts.bookmarks
    return !colors || colors.has(item.color)
  })
}

/** 分组时的章节标题: PDF 没有章节时退回页码 */
function chapterOf(item: NoteItem, lang: 'zh' | 'en'): string {
  if (item.chapter?.trim()) return item.chapter.trim()
  if (item.page) return L[lang].page(item.page)
  return ''
}

function toMarkdown(book: NotesBook, items: NoteItem[], o: NotesExportOptions): string {
  const l = L[o.lang ?? 'zh']
  const thoughts = o.notes ? items.filter(i => i.note?.trim()).length : 0
  const out: string[] = [`# ${l.mdTitle(book.title)}`, '']
  const meta: string[] = []
  if (book.author) meta.push(`${l.author}${l.sep}${book.author}`)
  meta.push(`${l.count(items.length, thoughts)} · ${l.exported} ${formatNoteTime(o.now ?? Date.now()).slice(0, 10)}`)
  out.push(meta.map(line => `> ${line}`).join('  \n'), '')
  let last: string | null = null
  for (const item of items) {
    const chapter = chapterOf(item, o.lang ?? 'zh')
    if (o.chapters && chapter && chapter !== last) {
      out.push(`## ${chapter}`, '')
      last = chapter
    }
    out.push(clean(item.text).split('\n').map(line => `> ${line}`).join('\n'), '')
    const note = o.notes ? clean(item.note ?? '') : ''
    if (note) out.push(note, '')
    if (o.time) out.push(`<small>${formatNoteTime(item.createdAt)}</small>`, '')
  }
  return out.join('\n').replace(/\n+$/, '\n')
}

function toText(book: NotesBook, items: NoteItem[], o: NotesExportOptions): string {
  const l = L[o.lang ?? 'zh']
  const out: string[] = [o.lang === 'en' ? book.title : `《${book.title}》`]
  if (book.author) out.push(book.author)
  out.push(l.txtCount(items.length))
  let last: string | null = null
  for (const item of items) {
    const chapter = chapterOf(item, o.lang ?? 'zh')
    if (o.chapters && chapter && chapter !== last) {
      out.push('', '', `◆ ${chapter}`)
      last = chapter
    }
    out.push('')
    out.push(`>> ${clean(item.text).replace(/\n+/g, '\n')}`)
    const note = o.notes ? clean(item.note ?? '') : ''
    if (note) out.push(`${l.thought}${l.sep}${note}`)
    if (o.time) out.push(formatNoteTime(item.createdAt))
  }
  return out.join('\n') + '\n'
}

function toJson(book: NotesBook, items: NoteItem[], o: NotesExportOptions): string {
  const notes = items.map(item => {
    const entry: Record<string, unknown> = {
      id: item.id,
      type: item.kind,
    }
    if (item.chapter?.trim()) entry.chapter = item.chapter.trim()
    if (item.page) entry.page = item.page
    entry.text = item.text
    if (o.notes && item.note?.trim()) entry.note = item.note
    if (item.kind === 'highlight') entry.color = item.color
    entry.createdAt = new Date(item.createdAt).toISOString()
    if (item.position) entry.position = item.position
    return entry
  })
  const doc = {
    format: 'lightread-notes',
    version: 1,
    exportedAt: new Date(o.now ?? Date.now()).toISOString(),
    book: {
      title: book.title,
      ...(book.author ? { author: book.author } : {}),
      ...(book.format ? { format: book.format } : {}),
    },
    notes,
  }
  return JSON.stringify(doc, null, 2) + '\n'
}

function csvCell(value: string | number | undefined): string {
  const s = value === undefined ? '' : String(value)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function toCsv(book: NotesBook, items: NoteItem[], o: NotesExportOptions): string {
  const rows = [['Highlight', 'Title', 'Author', 'URL', 'Note', 'Location', 'Date']]
  items.forEach((item, i) => {
    rows.push([
      clean(item.text),
      book.title,
      book.author ?? '',
      '',
      o.notes ? clean(item.note ?? '') : '',
      String(item.page ?? i + 1),
      formatNoteTime(item.createdAt, true),
    ])
  })
  return rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

/** 生成导出内容; items 需已按书中位置排好序 */
export function buildNotesExport(book: NotesBook, items: NoteItem[], opts: NotesExportOptions): string {
  const picked = selectNotes(items, opts)
  switch (opts.format) {
    case 'md': return toMarkdown(book, picked, opts)
    case 'txt': return toText(book, picked, opts)
    case 'json': return toJson(book, picked, opts)
    case 'csv': return toCsv(book, picked, opts)
  }
}

export const NOTES_MIME: Record<NotesFormat, string> = {
  md: 'text/markdown',
  txt: 'text/plain',
  json: 'application/json',
  csv: 'text/csv',
}

/** 《书名》笔记.md; 去掉文件系统不允许的字符, 书名过长时截断 */
export function notesFileName(title: string, format: NotesFormat, lang: 'zh' | 'en' = 'zh'): string {
  const safe = (title || 'LightRead').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'LightRead'
  return lang === 'en' ? `${safe} - notes.${format}` : `《${safe}》笔记.${format}`
}

/**
 * 按书中位置排序. compare 由调用方给出 (EPUB 用 CFI 比较, PDF 用页码 + 坐标);
 * 比较失败或位置相同的按创建时间, 保证结果稳定.
 */
export function sortNotes<T extends { position?: string; createdAt: number }>(
  items: T[],
  compare: (a: string, b: string) => number,
): T[] {
  return [...items].sort((a, b) => {
    if (a.position && b.position) {
      try {
        const c = compare(a.position, b.position)
        if (c) return c
      } catch { /* 无法比较时按时间 */ }
    }
    return a.createdAt - b.createdAt
  })
}

/** 一条划线的纯文本 (列表里的「复制」): 原文 + 想法 + 出处 */
export function noteToClipboard(book: NotesBook, item: NoteItem, lang: 'zh' | 'en' = 'zh'): string {
  const parts = [clean(item.text)]
  if (item.note?.trim()) parts.push(`${L[lang].thought}${L[lang].sep}${clean(item.note)}`)
  const source = lang === 'en'
    ? `— ${book.title}${book.author ? `, ${book.author}` : ''}`
    : `——《${book.title}》${book.author ? ` ${book.author}` : ''}`
  parts.push(source)
  return parts.join('\n')
}
