/**
 * 听书的句子游标: 在分节文档里按「段 → 句」定位, 支持上一句 / 下一句 / 上一段 / 下一段、
 * 从任意位置开始和断点续读。
 *
 * foliate 自带的 TTS 以整段为单位输出 SSML, 高亮也只到段; 跳句、从选中处开始、
 * 精确到句的断点都需要句级位置, 所以这里自建游标:
 * - 段的切分与 foliate tts.js 一致 (相邻块级元素起点之间为一段);
 * - 段内用 Intl.Segmenter 断句, 并修正几类常见问题 (见 splitSentences);
 * - 句子 Range 惰性计算并按段缓存, 20 万字的 TXT 分节也只在读到时才断句。
 */

const BLOCK_TAGS = new Set([
  'article', 'aside', 'audio', 'blockquote', 'caption',
  'details', 'dialog', 'div', 'dl', 'dt', 'dd',
  'figure', 'footer', 'form', 'figcaption',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'li',
  'main', 'math', 'nav', 'ol', 'p', 'pre', 'section', 'tr',
])

/** 有可读的字 (文字或数字); 只有标点、分隔符 (* * *) 的句子跳过不读 */
const SPEAKABLE = /[\p{L}\p{N}]/u

/** 单句过长时 (没有句号的长段) 在逗号、分号处再切, 让高亮跟得上、跳句有意义 */
const MAX_SENTENCE = 160
const SOFT_BREAK = /[，,；;：:、]/g

export interface Span { start: number; end: number }

/**
 * 断句, 返回 [start, end) 偏移。
 * - Intl.Segmenter 句级切分 (中文按 。！？…, 西文按句点并考虑缩写);
 * - 没有可读文字的碎片 (单独的引号、省略号) 并入前一句;
 * - 过长的句子在软断点 (逗号等) 处二次切分;
 * - 去掉两端空白。
 */
export function splitSentences(text: string, lang = 'zh'): Span[] {
  let segmenter: Intl.Segmenter | null = null
  try { segmenter = new Intl.Segmenter(lang || 'zh', { granularity: 'sentence' }) } catch { /* 旧环境退回正则 */ }
  const raw: Span[] = []
  if (segmenter) {
    for (const s of segmenter.segment(text)) raw.push({ start: s.index, end: s.index + s.segment.length })
  } else {
    const re = /[^。！？!?.…]+[。！？!?.…]*[”’」』"')）]*/g
    for (let m = re.exec(text); m; m = re.exec(text)) raw.push({ start: m.index, end: m.index + m[0].length })
  }
  // 换行是硬边界 (分隔线、诗行); 句末的左引号 / 左括号属于下一句 (Segmenter 会把「。“」切在引号之后)
  const lines: Span[] = []
  for (const s of raw) {
    let start = s.start
    for (let i = s.start; i < s.end; i++) {
      if (text[i] === '\n') {
        if (i > start) lines.push({ start, end: i })
        start = i + 1
      }
    }
    if (s.end > start) lines.push({ start, end: s.end })
  }
  for (let i = 0; i + 1 < lines.length; i++) {
    const a = lines[i]
    const b = lines[i + 1]
    if (a.end !== b.start) continue
    let end = a.end
    while (end > a.start && /[\s“‘「『（(《]/.test(text[end - 1])) end--
    if (end < a.end && end > a.start) { a.end = end; b.start = end }
  }
  const merged: Span[] = []
  for (const s of lines) {
    const seg = text.slice(s.start, s.end)
    const prev = merged[merged.length - 1]
    // 只有标点的碎片 (单独的右引号、省略号) 并入紧挨着的前一句; 隔着换行的单独成句, 稍后作为不可读丢弃
    if (prev && prev.end === s.start && !SPEAKABLE.test(seg)) prev.end = s.end
    else merged.push({ ...s })
  }
  const out: Span[] = []
  for (const s of merged) {
    for (const piece of softSplit(text, s)) {
      const trimmed = trimSpan(text, piece)
      if (trimmed.end > trimmed.start && SPEAKABLE.test(text.slice(trimmed.start, trimmed.end))) out.push(trimmed)
    }
  }
  return out
}

function softSplit(text: string, s: Span): Span[] {
  if (s.end - s.start <= MAX_SENTENCE) return [s]
  const out: Span[] = []
  let start = s.start
  while (s.end - start > MAX_SENTENCE) {
    const window = text.slice(start, start + MAX_SENTENCE)
    let cut = -1
    SOFT_BREAK.lastIndex = 0
    for (let m = SOFT_BREAK.exec(window); m; m = SOFT_BREAK.exec(window)) {
      // 不在太靠前的位置切, 避免切出两三个字的碎句
      if (m.index >= MAX_SENTENCE / 3) cut = m.index + 1
    }
    if (cut < 0) cut = MAX_SENTENCE
    out.push({ start, end: start + cut })
    start += cut
  }
  out.push({ start, end: s.end })
  return out
}

function trimSpan(text: string, s: Span): Span {
  let { start, end } = s
  while (start < end && /\s/.test(text[start])) start++
  while (end > start && /\s/.test(text[end - 1])) end--
  return { start, end }
}

/** 把拼接文本里的偏移换算回第几个文本节点的第几个字符 (end 落在节点末尾时停在该节点) */
export function locateOffset(lengths: readonly number[], offset: number, preferEnd = false): { node: number; offset: number } {
  let acc = 0
  for (let i = 0; i < lengths.length; i++) {
    const len = lengths[i]
    if (offset < acc + len || (preferEnd && offset === acc + len)) return { node: i, offset: offset - acc }
    acc += len
  }
  const last = Math.max(0, lengths.length - 1)
  return { node: last, offset: lengths[last] ?? 0 }
}

export interface CursorPos { block: number; sentence: number }

export class SentenceCursor {
  readonly doc: Document
  #blocks: Range[]
  #sentences = new Map<number, Range[]>()
  #lang: string
  pos: CursorPos = { block: 0, sentence: 0 }

  constructor(doc: Document) {
    this.doc = doc
    this.#lang = doc.documentElement?.lang || doc.body?.lang || 'zh'
    this.#blocks = collectBlocks(doc)
  }

  get blockCount() { return this.#blocks.length }

  sentencesOf(block: number): Range[] {
    let list = this.#sentences.get(block)
    if (list) return list
    const range = this.#blocks[block]
    list = range ? sentenceRanges(this.doc, range, this.#lang) : []
    this.#sentences.set(block, list)
    return list
  }

  current(): Range | null {
    return this.sentencesOf(this.pos.block)[this.pos.sentence] ?? null
  }

  text(range = this.current()): string {
    return range ? range.toString().replace(/\s+/g, ' ').trim() : ''
  }

  /** 定位到第一句可读的句子; 整节没有可读文字时返回 false */
  first(): boolean {
    this.pos = { block: 0, sentence: -1 }
    return this.next()
  }

  /** 定位到本节最后一句 */
  last(): boolean {
    for (let b = this.#blocks.length - 1; b >= 0; b--) {
      const n = this.sentencesOf(b).length
      if (n) { this.pos = { block: b, sentence: n - 1 }; return true }
    }
    return false
  }

  /** 下一句; 到本节末返回 false (位置不变) */
  next(): boolean {
    let { block, sentence } = this.pos
    sentence++
    while (block < this.#blocks.length) {
      if (sentence < this.sentencesOf(block).length) {
        this.pos = { block, sentence }
        return true
      }
      block++
      sentence = 0
    }
    return false
  }

  prev(): boolean {
    let { block, sentence } = this.pos
    sentence--
    while (block >= 0) {
      if (sentence >= 0 && sentence < this.sentencesOf(block).length) {
        this.pos = { block, sentence }
        return true
      }
      block--
      if (block >= 0) sentence = this.sentencesOf(block).length - 1
    }
    return false
  }

  /** 下一段的第一句 */
  nextBlock(): boolean {
    for (let b = this.pos.block + 1; b < this.#blocks.length; b++) {
      if (this.sentencesOf(b).length) { this.pos = { block: b, sentence: 0 }; return true }
    }
    return false
  }

  /** 读到段中间时回到本段开头, 已在段首则到上一段开头 (和音乐播放器的「上一首」一致) */
  prevBlock(): boolean {
    if (this.pos.sentence > 0) {
      this.pos = { block: this.pos.block, sentence: 0 }
      return true
    }
    for (let b = this.pos.block - 1; b >= 0; b--) {
      if (this.sentencesOf(b).length) { this.pos = { block: b, sentence: 0 }; return true }
    }
    return false
  }

  /**
   * 定位到包含 (或紧随) 某一点的句子: 用于从选中处、从当前页、从断点开始。
   * 找不到 (点在全部正文之后) 返回 false。
   */
  seek(node: Node, offset: number): boolean {
    for (let b = 0; b < this.#blocks.length; b++) {
      const block = this.#blocks[b]
      let cmp: number
      try { cmp = block.comparePoint(node, offset) } catch { continue }
      if (cmp > 0) continue // 点在这一段之后
      const list = this.sentencesOf(b)
      if (!list.length) continue
      if (cmp < 0) { this.pos = { block: b, sentence: 0 }; return true }
      for (let s = 0; s < list.length; s++) {
        const r = list[s]
        let after: number
        try { after = r.comparePoint(node, offset) } catch { after = 1 }
        // 恰好落在句末边界 (即下一句的开头, 断点 / 选区常见): 属于下一句
        if (after === 0 && node === r.endContainer && offset === r.endOffset && !(node === r.startContainer && offset === r.startOffset)) continue
        // 点在这句之内或之前: 从这句开始
        if (after <= 0) { this.pos = { block: b, sentence: s }; return true }
      }
      // 点落在段尾空白里: 下一段
      this.pos = { block: b, sentence: list.length - 1 }
      return this.next()
    }
    return false
  }

  /** 之后的 count 句文本 (预取合成用), 不移动游标; 本节末尾为止 */
  peek(count: number): string[] {
    const saved = this.pos
    const out: string[] = []
    while (out.length < count && this.next()) out.push(this.text())
    this.pos = saved
    return out
  }
}

/** 与 foliate tts.js 的 getBlocks 相同的切段方式 */
function collectBlocks(doc: Document): Range[] {
  const out: Range[] = []
  const body = doc.body
  if (!body) return out
  let last: Range | null = null
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_ELEMENT)
  for (let node = walker.nextNode() as Element | null; node; node = walker.nextNode() as Element | null) {
    if (!BLOCK_TAGS.has(node.tagName.toLowerCase())) continue
    if (last) {
      last.setEndBefore(node)
      if (last.toString().trim()) out.push(last)
    }
    last = doc.createRange()
    last.setStart(node, 0)
  }
  if (!last) {
    last = doc.createRange()
    last.setStart(body.firstChild ?? body, 0)
  }
  last.setEndAfter(body.lastChild ?? body)
  if (last.toString().trim()) out.push(last)
  return out
}

function sentenceRanges(doc: Document, block: Range, lang: string): Range[] {
  const nodes: Text[] = []
  const root = block.commonAncestorContainer
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: n => {
      if (n.nodeType === 1) {
        const name = (n as Element).tagName.toLowerCase()
        // 脚注角标 / 注音 (rt) 不读
        if (name === 'script' || name === 'style' || name === 'rt' || name === 'rp') return NodeFilter.FILTER_REJECT
        return NodeFilter.FILTER_SKIP
      }
      return NodeFilter.FILTER_ACCEPT
    },
  })
  if (root.nodeType === 3) nodes.push(root as Text)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n as Text
    // 只取落在本段里的部分 (段的起止可能在节点中间)
    try {
      if (block.comparePoint(text, 0) > 0) break
      if (block.comparePoint(text, text.length) < 0) continue
    } catch { continue }
    nodes.push(text)
  }
  if (!nodes.length) return []
  // 段首 / 段尾节点只取段内部分
  const starts = nodes.map(n => (n === block.startContainer ? block.startOffset : 0))
  const ends = nodes.map(n => (n === block.endContainer ? block.endOffset : n.length))
  const strs = nodes.map((n, i) => n.data.slice(starts[i], ends[i]))
  const lengths = strs.map(s => s.length)
  const spans = splitSentences(strs.join('').replace(/\r/g, ' '), lang)
  return spans.map(({ start, end }) => {
    const a = locateOffset(lengths, start)
    const b = locateOffset(lengths, end, true)
    const range = doc.createRange()
    range.setStart(nodes[a.node], starts[a.node] + a.offset)
    range.setEnd(nodes[b.node], starts[b.node] + b.offset)
    return range
  })
}

// ---- 断点续读 ----

export interface ListenBookmark {
  cfi: string
  /** 章节名, 供「上次听到 · 第三章」 */
  chapter: string
  /** 句子开头几个字 */
  snippet: string
  at: number
}

const bookmarkKey = (bookId: string) => `lightread-tts-pos:${bookId}`

export function loadListenBookmark(bookId: string): ListenBookmark | null {
  try {
    const v = JSON.parse(localStorage.getItem(bookmarkKey(bookId)) || 'null')
    return v && typeof v.cfi === 'string' ? v : null
  } catch { return null }
}

export function saveListenBookmark(bookId: string, mark: ListenBookmark | null) {
  try {
    if (mark) localStorage.setItem(bookmarkKey(bookId), JSON.stringify(mark))
    else localStorage.removeItem(bookmarkKey(bookId))
  } catch { /* 存储不可用: 不影响朗读 */ }
}

/** 「3 分钟前 / 2 小时前 / 昨天 / 5 天前」的分档, 文案由调用方套 */
export function agoBucket(at: number, now: number): { kind: 'justNow' | 'minutes' | 'hours' | 'yesterday' | 'days'; n: number } {
  const min = Math.max(0, (now - at) / 60000)
  if (min < 1) return { kind: 'justNow', n: 0 }
  if (min < 60) return { kind: 'minutes', n: Math.floor(min) }
  const h = min / 60
  if (h < 24) return { kind: 'hours', n: Math.floor(h) }
  if (h < 48) return { kind: 'yesterday', n: 1 }
  return { kind: 'days', n: Math.floor(h / 24) }
}
