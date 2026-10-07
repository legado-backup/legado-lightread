#!/usr/bin/env node
/**
 * 生成「研辞问典」(wendian.dicomp.net) 离线书目索引 src/data/wendian-index.json。
 *
 * 应用内只在本地搜这份索引, 不调用该站的搜索接口 (robots.txt 禁止 /search.php?q=、/suggest.php、
 * /*?ajax=、/*?action=、/data/), 只有用户点「导入」时才请求那一本书的页面。
 *
 * 收录 (都是书, 不收诗词 / 字典):
 *  - 古籍文献 /ancient/  约 2 万部, 每部一页全文 (detail.php?id=N)
 *  - 中医药古籍 /tcm/   约 700 部, 每部一页全文
 *  - 四书五经 /classics/ 9 部, 每部分多页 (book.php?book=X → detail.php?id=N)
 *  - 蒙学 /mengxue/     13 部, 同上 (book.php?book=X&var=Y)
 *
 * 抓取方式: 只读 sitemap (核对 id 是否齐全) 与分类列表页 (index.php?cat=…&p=…, robots 允许),
 * 不逐本抓取 2 万个正文页。每个请求间隔 --delay 毫秒 (默认 1100, 即每秒不超过 1 次), 失败退避重试,
 * 页面缓存在 --cache (默认系统临时目录), 中断后重跑会从缓存续上。
 *
 * 繁简互通: 另取 OpenCC 的 TSCharacters.txt (Apache-2.0), 只保留索引里出现过的字的「繁→简」对,
 * 随索引分发, 应用搜索时把书名与关键词都折算成简体再比。
 *
 * 用法: node scripts/build-wendian-index.mjs [--cache <dir>] [--out <file>] [--delay <ms>]
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
const CACHE = opt('--cache', join(tmpdir(), 'lightread-wendian-index-cache'))
const OUT = opt('--out', join(root, 'src/data/wendian-index.json'))
const DELAY = Math.max(1000, Number(opt('--delay', '1100')))
const SITE = 'https://wendian.dicomp.net/'
const OPENCC_TS = 'https://raw.githubusercontent.com/BYVoid/OpenCC/master/data/dictionary/TSCharacters.txt'
const USER_AGENT = 'LightReadIndexBot/1.0 (+https://github.com/yzfly/LightRead; offline catalog index, <=1 req/s)'
mkdirSync(CACHE, { recursive: true })

// ---------------------------------------------------------------- 抓取 (缓存 + 限速 + 退避重试)
let lastRequest = 0
let requests = 0
async function fetchPage(url) {
  const file = join(CACHE, createHash('sha1').update(url).digest('hex') + '.html')
  if (existsSync(file)) return readFileSync(file, 'utf8')
  for (let attempt = 0; attempt < 5; attempt++) {
    const wait = lastRequest + DELAY - Date.now()
    if (wait > 0) await new Promise(r => setTimeout(r, wait))
    lastRequest = Date.now()
    requests++
    try {
      const res = await fetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xml' } })
      if (res.ok) {
        const text = await res.text()
        writeFileSync(file, text)
        return text
      }
      if (res.status === 404) {
        console.warn(`  ! 404 ${url}`)
        return ''
      }
      console.warn(`  ! ${res.status} ${url} (retry ${attempt + 1})`)
    } catch (e) {
      console.warn(`  ! ${e?.message ?? e} ${url} (retry ${attempt + 1})`)
    }
    // 429 / 5xx / 网络错误: 指数退避
    await new Promise(r => setTimeout(r, 5000 * 2 ** attempt))
  }
  throw new Error(`failed: ${url}`)
}

// ---------------------------------------------------------------- 极简 HTML 工具 (页面结构固定, 不引依赖)
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', hellip: '…', ldquo: '“', rdquo: '”' }
const decodeEntities = s => s.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m
  const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m
})
const clean = s => decodeEntities(String(s ?? '').replace(/<[^>]*>/g, ' ')).replace(/[\s　 ]+/g, ' ').trim()
const bookTitle = s => clean(s).replace(/^《(.*)》$/, '$1').trim()
const spans = html => [...html.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/g)].map(m => clean(m[1])).filter(Boolean)

/** 「1,405 字」「2.8万字」「3.7 万字」 → 字数 */
function parseChars(text) {
  const m = /([\d.,]+)\s*(万)?\s*字/.exec(text ?? '')
  if (!m) return 0
  const n = Number(m[1].replace(/,/g, ''))
  return Number.isFinite(n) ? Math.round(m[2] ? n * 10000 : n) : 0
}
const withDynasty = (author, dynasty) => author ? (dynasty ? `[${dynasty}]${author}` : author) : ''

/** 列表页上的分类 Tab: [{ name, href, count }] */
function categoryTabs(html, section, param = 'cat') {
  const re = new RegExp(`href="\\.\\./${section}/index\\.php\\?${param}=([^"&]+)"[^>]*>([\\s\\S]*?)</a>`, 'g')
  const out = new Map()
  for (const m of html.matchAll(re)) {
    const name = decodeURIComponent(decodeEntities(m[1]))
    const count = Number((/\(?([\d,]+)\)?\s*$/.exec(clean(m[2]))?.[1] ?? '0').replace(/,/g, ''))
    if (!out.has(name)) out.set(name, { name, count })
  }
  return [...out.values()]
}
const lastPage = html => Math.max(1, ...[...html.matchAll(/[?&]p=(\d+)/g)].map(m => Number(m[1])))

// ---------------------------------------------------------------- 书目
/** { section, ref, title, author, category, chars } */
const books = []
const seen = new Set()
function addBook(book) {
  // 个别书卡的作者栏是一整段生平 (「王筠（1784-1854），字貫山…」): 只留名字
  if (Array.from(book.author).length > 24) book.author = book.author.split(/[（(，,。；;]/)[0].trim()
  const key = `${book.section}:${book.ref}`
  if (seen.has(key) || !book.title) return false
  seen.add(key)
  books.push(book)
  return true
}

/** 古籍文献 / 中医药古籍: 分类列表页的卡片 */
function parseDetailCards(html, section, topCategory, sectionName) {
  const re = new RegExp(`<a href="\\.\\./${section}/detail\\.php\\?id=(\\d+)"[^>]*>([\\s\\S]*?)</a>`, 'g')
  let added = 0
  for (const m of html.matchAll(re)) {
    const card = m[2]
    const title = bookTitle(/<h3\b[^>]*>([\s\S]*?)<\/h3>/.exec(card)?.[1])
    const texts = spans(card)
    const excerpt = clean(/<p\b[^>]*>([\s\S]*?)<\/p>/.exec(card)?.[1])
    let author = texts.find(s => s.startsWith('作者：'))?.slice(3).trim() ?? ''
    const sub = texts.find(s => s.startsWith('部类：'))?.slice(3).trim() ?? ''
    if (!author && section === 'tcm') {
      // 中医药古籍的卡片把「作者：… 朝代：…」写在摘要里
      const a = /作者：\s*(\S+)/.exec(excerpt)?.[1] ?? ''
      const d = /朝代：\s*(\S+)/.exec(excerpt)?.[1] ?? ''
      author = withDynasty(a.replace(/朝代：.*$/, ''), d)
    }
    const category = [sectionName, topCategory, sub && sub !== topCategory ? sub : ''].filter(Boolean).join(' · ')
    const chars = parseChars(texts.find(s => /字$/.test(s)) ?? '')
    if (addBook({ section, ref: m[1], title, author, category, chars })) added++
  }
  return added
}

async function listedSection(section, sectionName) {
  const index = await fetchPage(`${SITE}${section}/index.php`)
  const cats = categoryTabs(index, section)
  console.log(`${sectionName}: ${cats.length} 个分类, 合计 ${cats.reduce((n, c) => n + c.count, 0)} 部`)
  for (const cat of cats) {
    const first = `${SITE}${section}/index.php?cat=${encodeURIComponent(cat.name)}`
    const html = await fetchPage(first)
    const pages = lastPage(html)
    let added = parseDetailCards(html, section, cat.name, sectionName)
    for (let p = 2; p <= pages; p++) {
      added += parseDetailCards(await fetchPage(`${first}&p=${p}`), section, cat.name, sectionName)
    }
    console.log(`  ${cat.name}: ${pages} 页, 新增 ${added} 部 (分类标注 ${cat.count})`)
  }
}

/** 四书五经 / 蒙学: 首页的书卡 (book.php) */
async function bookSection(section, sectionName) {
  const html = await fetchPage(`${SITE}${section}/index.php`)
  const re = new RegExp(`<a href="\\.\\./${section}/book\\.php\\?([^"]+)"[^>]*>([\\s\\S]*?)</a>`, 'g')
  let added = 0
  for (const m of html.matchAll(re)) {
    const query = new URLSearchParams(decodeEntities(m[1]))
    const name = query.get('book') ?? ''
    const variant = query.get('var') ?? ''
    const card = m[2]
    const texts = [...card.matchAll(/<(?:span|div)\b[^>]*>([^<]*)<\/(?:span|div)>/g)].map(x => clean(x[1])).filter(Boolean)
    const title = bookTitle(/<h3\b[^>]*>([\s\S]*?)<\/h3>/.exec(card)?.[1]) || name
    let author = ''
    let category = ''
    if (section === 'classics') {
      const a = texts.find(s => s.startsWith('作者：'))?.slice(3).trim() ?? ''
      const d = texts.find(s => s.startsWith('时代：'))?.slice(3).trim() ?? ''
      author = withDynasty(a, d)
      category = [sectionName, texts.find(s => s === '四书' || s === '五经') ?? ''].filter(Boolean).join(' · ')
    } else {
      // 蒙学的书卡统计的是书里某一类 (唐詩三百首卡片写「樂府 44 篇」), 作者也可能缺:
      // 以书的目录页 (面包屑 / 作者 / 全书字数) 为准, 共 13 本
      const page = await fetchPage(`${SITE}${section}/book.php?${m[1].replace(/&amp;/g, '&')}`)
      const head = /<main\b[\s\S]*?<\/h1>([\s\S]*?)<\/div>/.exec(page)?.[1] ?? ''
      author = clean(/作者\s*<strong\b[^>]*>([\s\S]*?)<\/strong>/.exec(head)?.[1] ?? '')
      const crumbs = [...(/<nav\b[^>]*>([\s\S]*?)<\/nav>/.exec(/<main\b[\s\S]*/.exec(page)?.[0] ?? '')?.[1] ?? '')
        .matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/g)].map(x => clean(x[1]))
      category = [sectionName, crumbs[1] ?? ''].filter(Boolean).join(' · ')
      const pageChars = parseChars(clean(head))
      if (pageChars) texts.push(`${pageChars} 字`)
    }
    const chars = parseChars([...texts].reverse().find(s => /字$/.test(s)) ?? '')
    const ref = variant ? `${name}|${variant}` : name
    if (addBook({ section, ref, title: variant ? `${title}（${variant}）` : title, author, category, chars })) added++
  }
  console.log(`${sectionName}: ${added} 部`)
}

/** sitemap 里的 detail id, 用来核对列表页是否漏书 */
async function sitemapIds(type, section) {
  const xml = await fetchPage(`${SITE}sitemap.php?type=${type}&page=1`)
  return new Set([...xml.matchAll(new RegExp(`/${section}/detail\\.php\\?id=(\\d+)`, 'g'))].map(m => m[1]))
}

// ---------------------------------------------------------------- 运行
const started = Date.now()
const sitemapIndex = await fetchPage(`${SITE}sitemap.php`)
for (const type of ['ancient_books', 'tcm_books', 'classics', 'mengxue']) {
  if (!sitemapIndex.includes(`type=${type}`)) console.warn(`  ! sitemap 索引里没有 ${type}`)
}
await bookSection('classics', '四书五经')
await bookSection('mengxue', '蒙学')
await listedSection('tcm', '中医药古籍')
await listedSection('ancient', '古籍文献')

for (const [type, section] of [['ancient_books', 'ancient'], ['tcm_books', 'tcm']]) {
  const ids = await sitemapIds(type, section)
  const listed = new Set(books.filter(b => b.section === section).map(b => b.ref))
  const missing = [...ids].filter(id => !listed.has(id))
  console.log(`核对 ${section}: sitemap ${ids.size} 部, 列表页 ${listed.size} 部, 缺 ${missing.length}${missing.length ? ` (${missing.slice(0, 20).join(', ')}${missing.length > 20 ? '…' : ''})` : ''}`)
}

// 繁→简对照: 只留索引里用得到的字
const tsText = await fetchPage(OPENCC_TS)
const usedChars = new Set(books.flatMap(b => [...`${b.title}${b.author}${b.category}`]))
const pairs = []
for (const line of tsText.split('\n')) {
  const [trad, simp] = line.split('\t')
  const s = simp?.trim().split(' ')[0]
  if (!trad || !s || [...trad].length !== 1 || [...s].length !== 1 || trad === s) continue
  if (usedChars.has(trad) || usedChars.has(s)) pairs.push(trad + s)
}

const SECTIONS = ['ancient', 'tcm', 'classics', 'mengxue']
const authors = []
const authorIndex = new Map()
const categories = []
const categoryIndex = new Map()
const intern = (list, index, value) => {
  if (!index.has(value)) { index.set(value, list.length); list.push(value) }
  return index.get(value)
}
const out = {
  version: 1,
  updated: new Date().toISOString().slice(0, 10),
  site: SITE,
  sections: SECTIONS,
  categories,
  authors,
  // OpenCC TSCharacters 子集: 每两个字一对 (繁, 简)
  t2s: pairs.join(''),
  // [书名, 作者序号(-1 无), 分类序号, 栏目序号, 站内编号 (detail id 或 book[|var]), 约字数 (0 未知)]
  books: books.map(b => [
    b.title,
    b.author ? intern(authors, authorIndex, b.author) : -1,
    intern(categories, categoryIndex, b.category),
    SECTIONS.indexOf(b.section),
    /^\d+$/.test(b.ref) ? Number(b.ref) : b.ref,
    b.chars,
  ]),
}
const json = JSON.stringify(out)
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, json + '\n')
const bySection = Object.fromEntries(SECTIONS.map(s => [s, books.filter(b => b.section === s).length]))
console.log(`\n共 ${books.length} 部 ${JSON.stringify(bySection)}, 繁简对 ${pairs.length}, 本次请求 ${requests} 次, 用时 ${((Date.now() - started) / 60000).toFixed(1)} 分钟`)
console.log(`${(Buffer.byteLength(json) / 1024).toFixed(0)} KB (gzip ${(gzipSync(json).length / 1024).toFixed(0)} KB) → ${OUT}`)
