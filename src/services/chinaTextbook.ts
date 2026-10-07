/**
 * 中小学及大学 PDF 教材: GitHub 仓库 TapXWorld/ChinaTextbook (国家中小学智慧教育平台公开的电子课本等)。
 *
 * 纯函数部分 (node --test 可直接测):
 *  - 仓库超过 50 MB 的书被拆成约 45 MB 的分卷: `<目录>/<书名>.pdf_merge_folder/<书名>.pdf.1 … .N`
 *    (也有直接放在同目录的 `<书名>.pdf.1 …`), 搜索结果合并成一本, 大小为各分卷之和;
 *    同一本书既有整本又有分卷时只用整本 (一次下载)
 *  - 路径即书目: `初中/数学/人教版-人民教育出版社/七年级/义务教育教科书·数学七年级上册.pdf`
 *    → 学段 · 学科 · 年级 · 版本 (出版社)
 *  - 关键词与整条路径比对 (不只文件名), 「必修一 / 必修 第一册 / 必修1」「选择性必修」「七上」等写法互通
 *  - 分卷按序号 (数值) 依次下载、逐卷核对大小、拼接后检查 %PDF 文件头
 */
import { compactKey, normalizeBookQuery, titleRelevance } from './bookQuery.ts'

export const TEXTBOOK_REPO = 'TapXWorld/ChinaTextbook'
export const TEXTBOOK_REPO_PAGE = 'https://github.com/TapXWorld/ChinaTextbook'

export interface TextbookPart {
  path: string
  size: number
}

export interface TextbookBook {
  /** 合并后的逻辑路径 (目录/书名.pdf), 也是结果的唯一键 */
  path: string
  /** 书名 (去扩展名) */
  title: string
  ext: string
  /** 字节数 (分卷之和) */
  size: number
  /** 按序号排好的分卷; 整本文件则只有它自己 */
  parts: TextbookPart[]
  /** 学段: 小学 / 初中 / 高中 / 大学 … */
  stage: string
  subject: string
  /** 年级 (七年级) 或高中的必修 / 选择性必修 */
  grade: string
  /** 版本 (人教版) */
  edition: string
  publisher: string
  /** 搜索键: 整条路径归一 */
  key: string
  /** 搜索键: 只含文件名 */
  nameKey: string
}

export interface TextbookHit extends TextbookBook {
  /** 0-3, 与其他书源的 titleRelevance 同尺度, 用于分组排序 */
  relevance: number
}

const BOOK_EXT = /\.(pdf|djvu)$/i
const CN_DIGIT: Record<string, string> = { 一: '1', 二: '2', 三: '3', 四: '4', 五: '5', 六: '6', 七: '7', 八: '8', 九: '9', 十: '10' }
const DIGIT_CN = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九']

/** 分卷文件 → 所属的书 (逻辑路径) 与卷号; 不是分卷返回 null */
export function splitPartOf(path: string): { book: string; index: number } | null {
  const m = /^(.+)\.pdf\.(\d+)$/i.exec(path)
  if (!m) return null
  let base = m[1]!
  const folder = /^(?:(.*)\/)?([^/]+)\.pdf_merge_folder\/\2$/i.exec(base)
  if (folder) base = (folder[1] ? `${folder[1]}/` : '') + folder[2]
  return { book: `${base}.pdf`, index: Number(m[2]) }
}

/**
 * 教材写法归一 (搜索用, 路径与关键词共用):
 * 选择性必修 → 选必 (「必修一」不该命中「选择性必修1」), 第一册 → 1, 必修一 → 必修1, 7年级 → 七年级, 去标点空格
 */
export function textbookKey(text: string): string {
  return text.normalize('NFKC').toLowerCase()
    .replace(/选择性必修/g, '选必')
    .replace(/第\s*([一二三四五六七八九十])\s*册/g, (_, n: string) => CN_DIGIT[n]!)
    .replace(/(必修|选必|选修)\s*([一二三四五六七八九])/g, (_, a: string, n: string) => a + CN_DIGIT[n]!)
    .replace(/([1-9])\s*年级/g, (_, d: string) => `${DIGIT_CN[Number(d)]}年级`)
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

/** 只用于关键词: 「七上」「八下」是「七年级上册」的常见简称 */
function expandQueryTerm(term: string): string {
  return term.replace(/(^|[^年高\d])([一二三四五六七八九1-9])([上下])(?![册部])/g, (_, pre: string, g: string, half: string) =>
    `${pre}${/\d/.test(g) ? DIGIT_CN[Number(g)] : g}年级${half}册`)
}

/** 由路径解析学段 / 学科 / 年级 / 版本 */
export function parseTextbookPath(path: string): Pick<TextbookBook, 'title' | 'ext' | 'stage' | 'subject' | 'grade' | 'edition' | 'publisher'> {
  const segments = path.split('/')
  const file = segments.pop() ?? path
  const ext = (BOOK_EXT.exec(file)?.[1] ?? 'pdf').toLowerCase()
  const title = file.replace(BOOK_EXT, '')
  const [stage = '', subject = '', editionDir = '', gradeDir = ''] = segments
  const dash = editionDir.indexOf('-')
  const edition = dash > 0 ? editionDir.slice(0, dash) : editionDir
  const publisher = dash > 0 ? editionDir.slice(dash + 1) : ''
  const grade = /年级|学段|水平/.test(gradeDir) ? gradeDir
    // 「三至六年级·书法练习指导三年级上册」: 取最后一处
    : [...title.matchAll(/[一二三四五六七八九]年级/g)].pop()?.[0]
      ?? /(选择性必修|必修)\s*(\d+|第[一二三四五六七八九十]册)?/.exec(title)?.[0]?.replace(/\s+/g, ' ')
      ?? gradeDir
  return { title, ext, stage, subject, grade, edition, publisher }
}

/** 仓库文件 → 书目: 合并分卷, 去掉 README / 图片 / 工具等非书文件, 缺卷的书不收 */
export function groupTextbookFiles(files: TextbookPart[]): TextbookBook[] {
  const whole = new Map<string, TextbookPart>()
  const split = new Map<string, Array<TextbookPart & { index: number }>>()
  for (const file of files) {
    if (!file?.path || !Number.isFinite(file.size) || file.size <= 0) continue
    if (file.path.split('/').some(segment => segment.startsWith('.'))) continue
    if (BOOK_EXT.test(file.path)) {
      if (file.path.includes('/')) whole.set(file.path, { path: file.path, size: file.size })
      continue
    }
    const part = splitPartOf(file.path)
    if (!part) continue
    const list = split.get(part.book) ?? []
    list.push({ path: file.path, size: file.size, index: part.index })
    split.set(part.book, list)
  }
  const books: TextbookBook[] = []
  const add = (path: string, parts: TextbookPart[]) => {
    const info = parseTextbookPath(path)
    books.push({
      path,
      ...info,
      size: parts.reduce((sum, part) => sum + part.size, 0),
      parts,
      key: textbookKey(path.replace(BOOK_EXT, '')),
      nameKey: textbookKey(info.title),
    })
  }
  for (const [path, file] of whole) add(path, [file])
  for (const [path, list] of split) {
    if (whole.has(path)) continue
    list.sort((a, b) => a.index - b.index)
    // 卷号必须从 1 连续到 N, 否则拼出来的 PDF 是坏的
    if (list.some((part, i) => part.index !== i + 1)) continue
    add(path, list.map(({ path: partPath, size }) => ({ path: partPath, size })))
  }
  return books
}

/** term 能否拆成几段 (每段至少 2 字) 且每段都出现在 key 里: 「七年级数学」「人教版物理」 */
function coveredBy(term: string, key: string): boolean {
  if (key.includes(term)) return true
  const chars = Array.from(term)
  if (chars.length < 4 || chars.length > 24) return false
  const ok = new Array<boolean>(chars.length + 1).fill(false)
  ok[0] = true
  for (let i = 0; i < chars.length; i++) {
    if (!ok[i]) continue
    for (let j = i + 2; j <= chars.length; j++) {
      if (!ok[j] && key.includes(chars.slice(i, j).join(''))) ok[j] = true
    }
  }
  return ok[chars.length]!
}

const STAGE_ORDER = ['小学', '初中', '高中', '小学（五•四学制）', '初中（五•四学制）', '大学']
const order = (book: TextbookBook) => {
  const stage = STAGE_ORDER.indexOf(book.stage)
  const grade = /([一二三四五六七八九])年级/.exec(book.title)?.[1] ?? /必修\s*(\d)/.exec(book.title)?.[1] ?? ''
  const half = /上册/.test(book.title) ? 0 : /下册/.test(book.title) ? 1 : 2
  return [
    /^人教/.test(book.edition) ? 0 : 1,
    stage < 0 ? 9 : stage,
    Number(CN_DIGIT[grade] ?? grade) || 0,
    half,
  ]
}

/**
 * 本地搜索 (纯函数): 关键词全部命中 (整条路径) 才算结果;
 * 书名相关度 > 关键词落在书名里的个数 > 人教版优先 > 学段 / 年级 / 上下册顺序 > 路径
 */
export function searchTextbookBooks(books: TextbookBook[], query: string, limit = 60): TextbookHit[] {
  const normalized = normalizeBookQuery(query)
  const terms = [...new Set(normalized.split(' ').map(term => textbookKey(expandQueryTerm(term))).filter(Boolean))]
  if (!terms.length) return []
  const hits: Array<{ book: TextbookBook; score: number; title: number; rank: number[] }> = []
  for (const book of books) {
    if (!terms.every(term => coveredBy(term, book.key))) continue
    const inName = terms.filter(term => coveredBy(term, book.nameKey)).length
    const title = titleRelevance(book.title, normalized)
    // 关键词恰好是学科 / 学段 / 版本名 (「语文」优先于「语文·书法练习指导」)
    const exact = terms.filter(term => [book.subject, book.stage, book.edition].some(field => textbookKey(field) === term)).length
    const score = title * 100 + (compactKey(book.title) === compactKey(normalized) ? 50 : 0) + inName * 10 + exact * 5
    hits.push({ book, title, score, rank: order(book) })
  }
  hits.sort((a, b) => b.score - a.score
    || a.rank[0]! - b.rank[0]! || a.rank[1]! - b.rank[1]! || a.rank[2]! - b.rank[2]! || a.rank[3]! - b.rank[3]!
    || a.book.path.localeCompare(b.book.path, 'zh'))
  const bounded = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 60
  return hits.slice(0, bounded).map(hit => ({ ...hit.book, relevance: Math.max(1, hit.title) }))
}

/** 结果副标题: 学段 · 学科 · 年级 · 版本 */
export function textbookSubtitle(book: Pick<TextbookBook, 'stage' | 'subject' | 'grade' | 'edition'>): string {
  return [book.stage, book.subject, book.grade, book.edition].filter(Boolean).join(' · ')
}

/** raw 直链 (路径分段编码) */
export function textbookRawUrl(path: string, repo = TEXTBOOK_REPO): string {
  return `https://raw.githubusercontent.com/${repo}/HEAD/${path.split('/').map(encodeURIComponent).join('/')}`
}

export interface TextbookProgress {
  /** 正在下载第几卷 (从 1 起) */
  part: number
  parts: number
  /** 全书已收到的字节数 */
  received: number
  total: number
}

export class TextbookDownloadError extends Error {
  code: 'size' | 'format'
  part: number
  constructor(code: 'size' | 'format', part = 0) {
    super(code === 'size' ? `Part ${part} size mismatch` : 'Not a PDF file')
    this.code = code
    this.part = part
  }
}

/**
 * 依次下载各卷 (按卷号), 每卷收完核对大小, 最后拼成一个 File。
 * 每卷先收成一个 Blob 再丢掉分块, 最终 File 由各卷 Blob 组成 (浏览器不复制数据), 避免整本在内存里存两份。
 */
export async function downloadTextbook(
  book: Pick<TextbookBook, 'title' | 'ext' | 'size' | 'parts'>,
  fetchPart: (url: string) => Promise<Response>,
  onProgress?: (progress: TextbookProgress) => void,
  repo = TEXTBOOK_REPO,
): Promise<File> {
  const blobs: Blob[] = []
  let received = 0
  for (let i = 0; i < book.parts.length; i++) {
    const part = book.parts[i]!
    const res = await fetchPart(textbookRawUrl(part.path, repo))
    const report = (got: number) => onProgress?.({ part: i + 1, parts: book.parts.length, received: received + got, total: book.size })
    let blob: Blob
    const reader = res.body?.getReader?.()
    if (reader) {
      const chunks: Uint8Array[] = []
      let got = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        got += value.length
        if (got > part.size) {
          await reader.cancel().catch(() => {})
          throw new TextbookDownloadError('size', i + 1)
        }
        report(got)
      }
      blob = new Blob(chunks as BlobPart[])
    } else {
      blob = await res.blob()
    }
    if (blob.size !== part.size) throw new TextbookDownloadError('size', i + 1)
    received += blob.size
    report(0)
    blobs.push(blob)
  }
  if (book.ext === 'pdf') {
    const head = new TextDecoder().decode(new Uint8Array(await blobs[0]!.slice(0, 1024).arrayBuffer()))
    if (!head.includes('%PDF-')) throw new TextbookDownloadError('format')
  }
  const type = book.ext === 'pdf' ? 'application/pdf' : 'image/vnd.djvu'
  return new File(blobs, `${book.title}.${book.ext}`, { type })
}
