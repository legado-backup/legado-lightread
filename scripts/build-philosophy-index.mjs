#!/usr/bin/env node
/**
 * 生成「哲学文库」离线索引 src/data/philosophy-index.json (应用内本地搜索, 不在运行时爬站)。
 *
 * 来源 (都是免登录、可直接下载的公开文库):
 *  - Marxists Internet Archive (marxists.org)
 *      英文 eBook 合集 /ebooks/、马恩电子书 /archive/marx/works/download/、列宁全集 PDF
 *      中文马克思主义文库 PDF 书库 /chinese/pdf/*.htm, 以及各作者目录页上的单页文章 (HTML)
 *  - Early Modern Texts (earlymoderntexts.com): 早期近代哲学 PDF / EPUB
 *  - Standard Ebooks「Philosophy」主题: EPUB
 *
 * 用法: node scripts/build-philosophy-index.mjs [--cache <dir>] [--out <file>] [--delay <ms>]
 *  - 每个请求之间等待 --delay 毫秒 (默认 1200), 页面缓存在 --cache (默认系统临时目录), 重跑不重复抓取
 *  - 只抓目录页, 不下载任何书籍文件
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const CACHE = opt('--cache', join(tmpdir(), 'lightread-philosophy-index-cache'))
const OUT = opt('--out', join(root, 'src/data/philosophy-index.json'))
const DELAY = Number(opt('--delay', '1200'))
const USER_AGENT = 'LightReadIndexBot/1.0 (+https://github.com/yzfly/LightRead; offline catalog index, polite)'
mkdirSync(CACHE, { recursive: true })

// ---------------------------------------------------------------- 抓取 (带缓存与限速)
let lastRequest = 0
async function fetchPage(url) {
  const file = join(CACHE, createHash('sha1').update(url).digest('hex') + '.html')
  if (existsSync(file)) return readFileSync(file, 'utf8')
  const wait = lastRequest + DELAY - Date.now()
  if (wait > 0) await new Promise(r => setTimeout(r, wait))
  lastRequest = Date.now()
  let res
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      res = await fetch(url, { headers: { 'user-agent': USER_AGENT } })
      if (res.ok || res.status === 404) break
    } catch (e) {
      if (attempt === 2) throw e
    }
    await new Promise(r => setTimeout(r, 3000 * (attempt + 1)))
  }
  if (!res?.ok) {
    console.warn(`  ! ${res?.status ?? 'ERR'} ${url}`)
    return ''
  }
  const bytes = new Uint8Array(await res.arrayBuffer())
  const head = new TextDecoder('latin1').decode(bytes.slice(0, 4096))
  const declared = (/charset=["']?([\w-]+)/i.exec(res.headers.get('content-type') ?? '')?.[1]
    ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ?? 'utf-8').toLowerCase()
  const charset = /^(gb2312|gbk|gb18030|x-gbk)$/.test(declared) ? 'gb18030' : declared
  let text
  try { text = new TextDecoder(charset).decode(bytes) } catch { text = new TextDecoder('utf-8').decode(bytes) }
  writeFileSync(file, text)
  return text
}

// ---------------------------------------------------------------- 极简 HTML 词法 (目录页结构简单, 不引依赖)
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', mdash: '—', ndash: '–', middot: '·', hellip: '…', uuml: 'ü', ouml: 'ö', auml: 'ä', eacute: 'é', egrave: 'è', aacute: 'á', iacute: 'í', oacute: 'ó', uacute: 'ú', ccedil: 'ç', szlig: 'ß', Oslash: '' }
function decodeEntities(s) {
  return s.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] !== '#') return ENTITIES[e] ?? ENTITIES[e.toLowerCase()] ?? m
    const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m
  })
}
const clean = s => decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[\s　 ]+/g, ' ').trim()

/** tokens: { tag, close, attrs, raw } | { text } */
function tokenize(html) {
  const body = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '')
  const tokens = []
  const re = /<(\/?)([a-z][\w-]*)\b([^>]*)>|([^<]+)/gi
  for (let m = re.exec(body); m; m = re.exec(body)) {
    if (m[4] !== undefined) tokens.push({ text: m[4] })
    else tokens.push({ tag: m[2].toLowerCase(), close: m[1] === '/', attrs: m[3] })
  }
  return tokens
}
const attr = (attrs, name) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs ?? '')
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? '') : undefined
}

/** 链接列表 (文字 + 前文), 供各解析器使用 */
function links(html, base) {
  const tokens = tokenize(html)
  const out = []
  let open = null
  let heading = ''
  let headingOpen = null
  let textSince = ''   // 上一个链接或换行之后的纯文本 (英文 eBook 页「书名 epub mobi pdf」)
  for (const tk of tokens) {
    if (tk.text !== undefined) {
      if (open) open.text += tk.text
      else textSince += tk.text
      if (headingOpen !== null) headingOpen += tk.text
      continue
    }
    if (/^h[1-5]$/.test(tk.tag)) {
      if (!tk.close) headingOpen = ''
      else if (headingOpen !== null) { heading = clean(headingOpen); headingOpen = null }
      continue
    }
    if (tk.tag === 'br' || tk.tag === 'p' || tk.tag === 'li' || tk.tag === 'tr' || tk.tag === 'td' || tk.tag === 'div') {
      if (!open) textSince = ''
      continue
    }
    if (tk.tag === 'a' && !tk.close) {
      const href = attr(tk.attrs, 'href')
      open = { href, title: attr(tk.attrs, 'title'), text: '', before: clean(textSince), heading, class: attr(tk.attrs, 'class') ?? '' }
      continue
    }
    if (tk.tag === 'a' && tk.close && open) {
      if (open.href && !/^(mailto|javascript):/i.test(open.href)) {
        try {
          const url = new URL(open.href, base)
          url.hash = ''
          out.push({ ...open, url: url.href, text: clean(open.text) })
        } catch { /* 坏链接 */ }
      }
      open = null
      textSince = ''
    }
  }
  return out
}

// ---------------------------------------------------------------- 格式
const FORMAT_CODES = { epub: 'e', azw3: 'a', azw: 'a', mobi: 'm', pdf: 'p', djvu: 'd', txt: 't', htm: 'h', html: 'h' }
const extOf = url => (/\.([a-z0-9]+)$/i.exec(new URL(url).pathname)?.[1] ?? '').toLowerCase()
const FILE_EXTS = new Set(['epub', 'azw3', 'mobi', 'pdf', 'djvu', 'txt'])
const isFile = url => FILE_EXTS.has(extOf(url))
/** 链接文字只是格式名或「下载」时不能当书名 */
const GENERIC = /^(?:[\[【(（]?\s*)?(?:pdf|epub|mobi|azw3?|djvu|prc|txt|docx?|odt|chm|下载|本片pdf下载|pdf下载|电子书下载|文字网页版|网页版|全文|点击下载|下载地址|pdf文库|here|download|scan|audio)\s*(?:格式|版|下载)?(?:\s*[\]】)）])?\s*$|^\d+(?:\s*mb|\s*kb)?$/i

/** 「【上】」「第66辑」「甲38卷」这类只是分册号, 书名在前文或小标题里 */
const VOLUME_ONLY = /^[【\[(（〔]?\s*(?:第\s*)?[\d一二三四五六七八九十百千零〇两甲乙丙丁上中下ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ.\-—~～、，,\s]+\s*[卷册辑輯号期部篇编集分章本次届]?\s*[】\])）〕]?$/
/** 小标题里夹带的站内链接文字 */
const headingOf = text => text.replace(/马库专栏|文字版|PDF版|\(?\s*pdf\s*\)?/gi, ' ').replace(/[(（]\s*[)）]/g, ' ').replace(/\s+/g, ' ')
  .replace(/(?<=^[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff]$)/, '').trim()

function titleWithContext(title, link) {
  const own = tidyTitle(title)
  // 「第44卷（《资本论》第一卷）」: 以卷号开头的也补上丛书名
  const volumeFirst = /^[【\[(（]?\s*第\s*[\d一二三四五六七八九十百]+\s*[卷册辑輯号期]/.test(own)
  if (own.length > 2 && !VOLUME_ONLY.test(own) && !volumeFirst) return own
  for (const context of [tidyTitle(link.before), headingOf(link.heading)]) {
    if (context && !GENERIC.test(context) && !VOLUME_ONLY.test(context) && context !== own) return `${context} ${own}`.trim()
  }
  return own
}

function tidyTitle(s) {
  return s
    .replace(/[\s　]+/g, ' ')
    .replace(/\.(pdf|djvu|epub|mobi|azw3|chm)$/i, '')
    .replace(/^[\s·•\-—:：、,，;；]+|[\s·•\-—:：、,，;；]+$/g, '')
    .replace(/[(（]\s*(?:pdf|djvu|epub)\s*(?:格式|版)?\s*[)）]$/i, '')
    .trim()
}

// ---------------------------------------------------------------- 结果收集
const SOURCES = [
  { id: 'mia', name: 'Marxists Internet Archive', base: 'https://www.marxists.org/', cors: false },
  { id: 'emt', name: 'Early Modern Texts', base: 'https://www.earlymoderntexts.com/', cors: false },
  { id: 'se', name: 'Standard Ebooks', base: 'https://standardebooks.org/', cors: true },
]
const works = []
const seenFiles = new Set()

function addWork({ title, author = '', source, lang, page, files }) {
  title = tidyTitle(title)
  author = tidyTitle(author)
  if (!title || title.length > 160 || GENERIC.test(title) || !/[\p{L}\p{N}]{2}/u.test(title) || VOLUME_ONLY.test(title)) return
  const unique = []
  for (const f of files) {
    if (seenFiles.has(f.url)) continue
    seenFiles.add(f.url)
    unique.push(f)
  }
  if (!unique.length) return
  works.push({ title, author, source, lang, page, files: unique })
}

/** 「书名 epub mobi pdf<br>」式列表: 把同一书名后的一串格式链接归为一本书 */
function groupedFileLinks(list, { authorOf, page, lang, skip }) {
  let current = null
  const flush = () => { if (current) addWork(current); current = null }
  for (const link of list) {
    if (skip?.(link)) continue
    const label = tidyTitle(link.before)
    if (label && !GENERIC.test(label)) {
      flush()
      current = { title: label, author: authorOf(link), source: 0, lang, page, files: [] }
    } else if (!label && isFile(link.url) && link.text && !GENERIC.test(link.text)) {
      // 书名就是链接文字 (「Marx-Engels Selected Correspondence」这类)
      flush()
      current = { title: link.text, author: authorOf(link), source: 0, lang, page, files: [] }
    }
    if (isFile(link.url)) current?.files.push({ url: link.url })
  }
  flush()
}

// ---------------------------------------------------------------- marxists.org 英文
async function miaEnglish() {
  const ebooks = 'https://www.marxists.org/ebooks/index.htm'
  const html = await fetchPage(ebooks)
  // 作者标题是 <p class="head"><a ...>Name</a></p>, 用正则切段比较稳
  const sections = html.split(/<p\s+class="head">/i).slice(1)
  for (const section of sections) {
    const author = clean(/<a[^>]*>([\s\S]*?)<\/a>/i.exec(section)?.[1] ?? '')
    const list = links(section, ebooks)
    groupedFileLinks(list, { authorOf: () => author, page: ebooks, lang: 'en' })
  }

  const meBooks = 'https://www.marxists.org/archive/marx/works/download/index.htm'
  const meHtml = await fetchPage(meBooks)
  groupedFileLinks(links(meHtml, meBooks), {
    authorOf: link => /engels/i.test(link.heading) ? 'Frederick Engels' : /^marx$/i.test(link.heading) ? 'Karl Marx' : 'Karl Marx, Frederick Engels',
    page: meBooks, lang: 'en',
  })

  const leninCw = 'https://www.marxists.org/archive/lenin/works/cw/index.htm'
  for (const link of links(await fetchPage(leninCw), leninCw)) {
    const vol = /lenin-cw-vol-(\d+)\.pdf$/i.exec(link.url)?.[1]
    if (vol) addWork({ title: `Lenin Collected Works, Volume ${Number(vol)}`, author: 'V. I. Lenin', source: 0, lang: 'en', page: leninCw, files: [{ url: link.url }] })
  }
}

// ---------------------------------------------------------------- marxists.org 中文
const ZH = 'https://www.marxists.org/chinese/'
async function miaChinesePdf() {
  const libraryPage = ZH + 'pdf/marxism-library.htm'
  const pages = links(await fetchPage(libraryPage), libraryPage)
    .filter(l => /\/chinese\/pdf\/[\w-]+\.htm$/.test(l.url) && l.url !== libraryPage)
  const unique = [...new Set(pages.map(l => l.url))]
  for (const page of unique) {
    const html = await fetchPage(page)
    if (!html) continue
    for (const link of links(html, page)) {
      if (!isFile(link.url) || !link.url.startsWith('https://www.marxists.org/')) continue
      const title = link.text && !GENERIC.test(link.text) ? link.text : link.before
      addWork({ title: titleWithContext(title, link), author: headingOf(link.heading), source: 0, lang: 'zh', page, files: [{ url: link.url }] })
    }
  }
}

/** 作者目录页上的单页文章 (HTML) 与 PDF; 多页作品 (xxx/index.htm) 只是目录, 不收 */
async function miaChineseAuthors() {
  const home = ZH
  const authors = new Map()
  for (const link of links(await fetchPage(home), home)) {
    const m = /^https:\/\/www\.marxists\.org\/chinese\/([\w-]+)\/index\.html?$/.exec(link.url)
    if (!m || ['pdf', 'update', 'abc', 'search', 'whoweare'].includes(m[1])) continue
    const name = link.text.replace(/\s+/g, '')
    if (name && name.length <= 12 && !authors.has(link.url)) authors.set(link.url, name)
  }
  console.log(`  中文作者目录 ${authors.size} 个`)
  for (const [page, author] of authors) {
    const html = await fetchPage(page)
    if (!html) continue
    const dir = page.replace(/index\.html?$/, '')
    for (const link of links(html, page)) {
      const url = link.url
      if (!url.startsWith(ZH) || /index\.html?$/i.test(url) || /\/chinese\/pdf\/[\w-]+\.htm$/.test(url)) continue
      const ext = extOf(url)
      const title = link.text && !GENERIC.test(link.text) ? link.text : ''
      if (FILE_EXTS.has(ext)) {
        addWork({ title: titleWithContext(title || link.before, link), author, source: 0, lang: 'zh', page, files: [{ url }] })
      } else if ((ext === 'htm' || ext === 'html') && url.startsWith(dir) && !url.slice(dir.length).includes('/') && title.length >= 2) {
        // 只收作者目录下的单页文章; 子目录里多是多页作品的分章 (capital/vol2-01.htm), 单独导入没有意义
        addWork({ title, author, source: 0, lang: 'zh', page: url, files: [{ url }] })
      }
    }
  }
}

// ---------------------------------------------------------------- Early Modern Texts
async function earlyModernTexts() {
  const texts = 'https://www.earlymoderntexts.com/texts'
  const html = await fetchPage(texts)
  const pages = [...new Set([...html.matchAll(/value="(\/authors\/[\w-]+)"/g)].map(m => new URL(m[1], texts).href))]
  console.log(`  Early Modern Texts 作者 ${pages.length} 位`)
  for (const page of pages) {
    const doc = await fetchPage(page)
    const content = doc.split(/<div class="content">/i)[1] ?? ''
    const author = clean(/<h2>([\s\S]*?)<\/h2>/i.exec(content)?.[1] ?? '').replace(/,?\s*\d{3,4}\s*[-–]\s*\d{3,4}\s*$/, '')
    // 每部作品以 <li><b>书名</b> 开头; 带 title 的链接是分册 PDF, 不单列
    const items = content.split(/<li>\s*<b>/i).slice(1)
    for (const item of items) {
      const title = clean(item.split(/<\/b>/i)[0] ?? '')
      const files = links(item, page).filter(l => !l.title && isFile(l.url)).map(l => ({ url: l.url }))
      addWork({ title, author, source: 1, lang: 'en', page, files })
    }
  }
}

// ---------------------------------------------------------------- Standard Ebooks (philosophy)
async function standardEbooks() {
  const seen = new Set()
  for (let p = 1; p <= 20; p++) {
    const page = `https://standardebooks.org/subjects/philosophy?page=${p}&per-page=48`
    const html = await fetchPage(page)
    const items = html.split(/<li typeof="schema:Book"/).slice(1)
    let added = 0
    for (const item of items) {
      const path = /about="(\/ebooks\/[^"]+)"/.exec(item)?.[1]
      if (!path || seen.has(path)) continue
      seen.add(path)
      added++
      const title = clean(/property="schema:url"><span property="schema:name">([\s\S]*?)<\/span>/.exec(item)?.[1] ?? '')
      const authors = [...item.matchAll(/class="author"[\s\S]*?<span property="schema:name">([\s\S]*?)<\/span>/g)].map(m => clean(m[1]))
      const slug = path.replace(/^\/ebooks\//, '')
      const file = `https://standardebooks.org${path}/downloads/${slug.replace(/\//g, '_')}.epub?source=download`
      addWork({ title, author: authors.join(', '), source: 2, lang: 'en', page: `https://standardebooks.org${path}`, files: [{ url: file, ext: 'epub' }] })
    }
    if (!added) break
  }
}

// ---------------------------------------------------------------- 输出
await miaEnglish(); console.log(`marxists.org 英文: ${works.length}`)
let n = works.length
await miaChinesePdf(); console.log(`marxists.org 中文 PDF 书库: ${works.length - n}`)
n = works.length
await miaChineseAuthors(); console.log(`marxists.org 中文作者目录: ${works.length - n}`)
n = works.length
await earlyModernTexts(); console.log(`Early Modern Texts: ${works.length - n}`)
n = works.length
await standardEbooks(); console.log(`Standard Ebooks: ${works.length - n}`)

const authors = []
const authorIndex = new Map()
const pages = []
const pageIndex = new Map()
const intern = (list, index, value) => {
  if (!index.has(value)) { index.set(value, list.length); list.push(value) }
  return index.get(value)
}
const relative = (url, source) => url.startsWith(SOURCES[source].base) ? url.slice(SOURCES[source].base.length) : url
const out = {
  version: 1,
  updated: new Date().toISOString().slice(0, 10),
  sources: SOURCES,
  authors,
  pages,
  // [书名, 作者序号(-1 无), 来源序号, 语言, 原网页序号(-1 即第一个文件), "格式码:路径 ..."]
  works: works.map(w => {
    const files = w.files.map(f => `${FORMAT_CODES[f.ext ?? extOf(f.url)]}:${relative(f.url, w.source)}`).join(' ')
    const page = w.page === w.files[0].url ? -1 : intern(pages, pageIndex, relative(w.page, w.source))
    return [w.title, w.author ? intern(authors, authorIndex, w.author) : -1, w.source, w.lang, page, files]
  }),
}
const json = JSON.stringify(out)
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, json + '\n')
console.log(`\n共 ${works.length} 部, ${(json.length / 1024).toFixed(0)} KB (gzip ${(gzipSync(json).length / 1024).toFixed(0)} KB) → ${OUT}`)
