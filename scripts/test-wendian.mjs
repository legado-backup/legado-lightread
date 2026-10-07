// 研辞问典: 离线书目搜索 (繁简互通 / 排序) + 页面解析 (真实页面存档, 已去掉 <script>) + 分章 + EPUB 打包
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { unzipSync, strFromU8 } from 'fflate'
import {
  buildWendianEpub, fetchWendianBook, makeFold, parseWendianBookPage, parseWendianDetail,
  prepareWendianIndex, searchWendianIndex, splitChapters, wendianUrl,
} from '../src/services/wendian.ts'

const fixture = name => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

const index = prepareWendianIndex({
  version: 1,
  updated: '2026-10-07',
  site: 'https://wendian.dicomp.net/',
  sections: ['ancient', 'tcm', 'classics', 'mengxue'],
  categories: ['古籍文献 · 儒藏 · 四书', '四书五经 · 四书', '蒙学 · 識字啟蒙', '中医药古籍 · 伤寒金匮', '蒙学 · 七言律詩', '古籍文献 · 集藏'],
  authors: ['[春秋]孔子门徒（辑录）', '周興嗣', '[东汉]张仲景', '[清]蘅塘退士', '[宋]朱熹'],
  t2s: '論论語语興兴詩诗經经傷伤寒寒蘅蘅',
  books: [
    ['论语集注', 4, 0, 0, 101, 120000],
    ['论语', -1, 0, 0, 102, 16000],
    ['论语', 0, 1, 2, '论语', 22000],
    ['论语义疏', -1, 0, 0, 103, 300000],
    ['千字文（南北朝）', 1, 2, 3, '千字文|南北朝', 1249],
    ['唐詩三百首', 3, 4, 3, '唐詩三百首', 90000],
    ['伤寒论', 2, 3, 1, 457, 37000],
    ['注解伤寒论', -1, 3, 1, 461, 124000],
    ['broken'],
    ['bad section', -1, 0, 9, 1, 0],
  ],
})
const titles = query => searchWendianIndex(index, query).map(work => `${work.title}@${work.section}`)

test('invalid rows are skipped and broken indexes rejected', () => {
  assert.equal(index.works.length, 8)
  assert.throws(() => prepareWendianIndex({ books: [] }), /Invalid wendian index/)
  assert.throws(() => prepareWendianIndex(null), /Invalid/)
})

test('ranking: exact > prefix > contains > author; classics before ancient copies', () => {
  // 同为前缀命中: 篇幅大的 (多为足本) 在前
  assert.deepEqual(titles('论语'), ['论语@classics', '论语@ancient', '论语义疏@ancient', '论语集注@ancient'])
  assert.deepEqual(titles('《论语》').slice(0, 1), ['论语@classics'])
  assert.deepEqual(titles('伤寒'), ['伤寒论@tcm', '注解伤寒论@tcm'])
  assert.deepEqual(titles('张仲景'), ['伤寒论@tcm'])
  assert.deepEqual(titles('朱熹 论语'), ['论语集注@ancient'])
  assert.deepEqual(titles('千字文'), ['千字文（南北朝）@mengxue'], 'the version note does not hurt an exact match')
  assert.equal(searchWendianIndex(index, '千字文')[0].relevance, 3)
  assert.deepEqual(titles('三体'), [])
  assert.deepEqual(titles(' 》'), [])
})

test('traditional and simplified characters match both ways', () => {
  assert.deepEqual(titles('論語').slice(0, 1), ['论语@classics'])
  assert.deepEqual(titles('唐诗三百首'), ['唐詩三百首@mengxue'])
  assert.deepEqual(titles('周兴嗣'), ['千字文（南北朝）@mengxue'])
  assert.equal(makeFold('詩诗經经')('詩經 ABC'), '诗经 abc')
  assert.equal(makeFold('')('ＡＢ'), 'ab')
})

test('result URLs point at the one page an import needs', () => {
  const [lunyu] = searchWendianIndex(index, '论语')
  assert.equal(lunyu.url, 'https://wendian.dicomp.net/classics/book.php?book=%E8%AE%BA%E8%AF%AD')
  assert.equal(searchWendianIndex(index, '千字文')[0].url, 'https://wendian.dicomp.net/mengxue/book.php?book=%E5%8D%83%E5%AD%97%E6%96%87&var=%E5%8D%97%E5%8C%97%E6%9C%9D')
  assert.equal(wendianUrl('ancient', 1171), 'https://wendian.dicomp.net/ancient/detail.php?id=1171')
  assert.equal(searchWendianIndex(index, '伤寒论')[0].author, '[东汉]张仲景')
})

const realIndex = new URL('../src/data/wendian-index.json', import.meta.url)
test('bundled index: sections, size and real queries', { skip: !existsSync(realIndex) }, () => {
  const raw = readFileSync(realIndex, 'utf8')
  const data = prepareWendianIndex(JSON.parse(raw))
  const count = section => data.works.filter(work => work.section === section).length
  assert.ok(count('ancient') > 20000, `ancient ${count('ancient')}`)
  assert.ok(count('tcm') >= 690)
  assert.equal(count('classics'), 9)
  assert.equal(count('mengxue'), 13)
  assert.ok(raw.length < 2.5 * 1024 * 1024, 'index stays commit-sized')
  const top = query => searchWendianIndex(data, query)[0]
  assert.equal(top('论语').title, '论语')
  assert.equal(top('论语').section, 'classics')
  assert.match(top('千字文').title, /^千字文/)
  assert.match(top('唐诗三百首').title, /^唐詩三百首/)
  assert.equal(top('伤寒论').title, '伤寒论')
  assert.ok(searchWendianIndex(data, '道德经').length > 0)
})

test('ancient detail page: title, breadcrumb, text without per-character dictionary links', () => {
  const page = parseWendianDetail(fixture('wendian-ancient-1171.html'))
  assert.equal(page.title, '三归五戒慈心厌离功德经', 'the traditional-character subtitle is dropped')
  assert.deepEqual(page.breadcrumb, ['古籍文献', '佛藏', '乾隆藏', '三归五戒慈心厌离功德经'])
  assert.equal(page.chapters.length, 1)
  const text = page.chapters[0].paragraphs.join('\n')
  assert.equal(page.chapters[0].paragraphs[0], '三归五戒慈心厌离功德经一卷')
  assert.match(text, /闻如是。一时佛在舍卫国祇树给孤独园。/)
  assert.doesNotMatch(text, /[<>]|poem-char|查「/)
  assert.ok(text.length > 400 && text.length < 600, `about 418 characters, got ${text.length}`)
})

test('mengxue book page lists chapter ids; detail page keeps verse lines', () => {
  const book = parseWendianBookPage(fixture('wendian-mengxue-book-qianziwen.html'), 'mengxue')
  assert.deepEqual(book, { title: '千字文', author: '周興嗣', ids: [451] })
  const page = parseWendianDetail(fixture('wendian-mengxue-451.html'))
  assert.equal(page.title, '千字文 第1段')
  assert.match(page.byline, /周興嗣/)
  const lines = page.chapters[0].paragraphs
  assert.deepEqual(lines.slice(0, 3), ['天地玄黃', '宇宙洪荒', '日月盈昃'])
  assert.equal(lines.length, 250)
})

test('sections with headings become chapters; hard-wrapped lines are rejoined', () => {
  const html = `<main><nav><a href="../tcm/">中医药古籍</a><span>›</span><span>《伤寒论》</span></nav>
    <h1 style="x">《伤寒论》</h1><article>
    <section id="ch-0"><h2>伤寒论</h2><div><p>书名：伤寒论
作者：张仲景</p></div></section>
    <section id="ch-1"><h2> 辨太阳病脉证并治上 </h2><div><p>属性：1．太阳之为病，脉浮、头项强痛而恶寒。
6．太阳病，发热而渴，不恶寒者，为温病。若发汗已，身灼热者，名风温。风温为病，脉阴阳俱浮、自
汗出、身重、多眠睡。
桂枝（去皮，三两） 芍药（三两） a&lt;b</p></div></section></article></main>`
  const page = parseWendianDetail(html)
  assert.equal(page.title, '伤寒论')
  assert.deepEqual(page.chapters.map(chapter => chapter.title), ['伤寒论', '辨太阳病脉证并治上'])
  assert.deepEqual(page.chapters[1].paragraphs, [
    '1．太阳之为病，脉浮、头项强痛而恶寒。',
    '6．太阳病，发热而渴，不恶寒者，为温病。若发汗已，身灼热者，名风温。风温为病，脉阴阳俱浮、自汗出、身重、多眠睡。',
    '桂枝（去皮，三两） 芍药（三两） a<b',
  ])
})

test('one-section books split at 卷 headings; closing markers and noise lines stay inside', () => {
  const paragraphs = [
    '钦定四库全书　　　　经部一', '某书　　易类', '提要', '臣等谨案某书十卷宋某某撰。',
    '某书卷一　　宋　某某　撰', '正文一。', '\\<经部,易类,某书,卷一 \\>', '正文一续。', '某书卷一',
    '钦定四库全书', '某书卷二', '正文二。', '某书卷二',
  ]
  const chapters = splitChapters([{ title: '', paragraphs }], '某书')
  assert.deepEqual(chapters.map(chapter => chapter.title), ['某书', '某书卷一', '某书卷二'])
  assert.deepEqual(chapters[1].paragraphs, ['某书卷一　　宋　某某　撰', '正文一。', '\\<经部,易类,某书,卷一 \\>', '正文一续。', '某书卷一', '钦定四库全书'])
  // 只有一处卷题: 不分章
  assert.equal(splitChapters([{ title: '', paragraphs: ['某书卷一', '正文'] }], '某书').length, 1)
  // 过长的章按段切开
  const long = Array.from({ length: 30 }, (_, i) => `${i}`.padEnd(2000, '字'))
  const parts = splitChapters([{ title: '大书', paragraphs: long }], '大书')
  assert.ok(parts.length >= 2)
  assert.deepEqual(parts.map(part => part.title).slice(0, 2), ['大书（1）', '大书（2）'])
  assert.equal(parts.flatMap(part => part.paragraphs).length, 30)
})

test('fetchWendianBook: detail page for ancient books, book page + chapters for 蒙学', async () => {
  const requested = []
  const pages = {
    'https://wendian.dicomp.net/ancient/detail.php?id=1171': fixture('wendian-ancient-1171.html'),
    'https://wendian.dicomp.net/mengxue/book.php?book=%E5%8D%83%E5%AD%97%E6%96%87&var=%E5%8D%97%E5%8C%97%E6%9C%9D': fixture('wendian-mengxue-book-qianziwen.html'),
    'https://wendian.dicomp.net/mengxue/detail.php?id=451': fixture('wendian-mengxue-451.html'),
  }
  const fetchText = async url => {
    requested.push(url)
    if (!(url in pages)) throw new Error(`unexpected ${url}`)
    return pages[url]
  }
  const ancient = await fetchWendianBook({ title: '三归五戒慈心厌离功德经', author: '', category: '古籍文献 · 佛藏 · 乾隆藏', section: 'ancient', url: wendianUrl('ancient', 1171) }, fetchText)
  assert.equal(ancient.chapters.length, 1)
  assert.equal(ancient.chapters[0].title, '三归五戒慈心厌离功德经')
  const progress = []
  const qzw = searchWendianIndex(index, '千字文')[0]
  const mengxue = await fetchWendianBook(qzw, fetchText, p => progress.push(p))
  assert.equal(mengxue.title, '千字文（南北朝）')
  assert.equal(mengxue.author, '周興嗣')
  assert.deepEqual(mengxue.chapters.map(chapter => chapter.title), ['千字文 第1段'])
  assert.deepEqual(progress, [{ done: 0, total: 1 }, { done: 1, total: 1 }])
  assert.equal(requested.length, 3, 'one request per page, nothing else (no search endpoint)')
  assert.ok(requested.every(url => !/search\.php|suggest\.php|ajax=|action=/.test(url)))
  await assert.rejects(fetchWendianBook({ ...qzw, url: wendianUrl('ancient', 1) }, async () => '<main><h1>x</h1></main>'), /empty/)
})

test('EPUB: mimetype first, metadata, nav for every chapter, escaped XML', async () => {
  const book = {
    title: '三归五戒慈心厌离功德经',
    author: '佚名 & <译>',
    category: '古籍文献 · 佛藏',
    url: 'https://wendian.dicomp.net/ancient/detail.php?id=1171',
    chapters: [
      { title: '卷上', paragraphs: ['闻如是。', 'a < b & c'] },
      { title: '', paragraphs: ['天地玄黃', '宇宙洪荒', '日月盈昃', '辰宿列張'] },
    ],
  }
  const bytes = await buildWendianEpub(book, { note: ['来源：研辞问典 https://wendian.dicomp.net/ancient/detail.php?id=1171'], tocTitle: '目录', now: new Date('2026-10-07T00:00:00Z') })
  assert.equal(strFromU8(bytes.subarray(30, 38)), 'mimetype')
  const files = unzipSync(bytes)
  assert.equal(strFromU8(files.mimetype), 'application/epub+zip')
  const opf = strFromU8(files['OEBPS/content.opf'])
  assert.match(opf, /<dc:title>三归五戒慈心厌离功德经<\/dc:title>/)
  assert.match(opf, /<dc:creator id="creator1">佚名 &amp; &lt;译&gt;<\/dc:creator>/)
  assert.match(opf, /<dc:language>zh<\/dc:language>/)
  assert.match(opf, /<dc:publisher>研辞问典<\/dc:publisher>/)
  assert.match(opf, /detail\.php\?id=1171/)
  assert.match(opf, /<meta property="dcterms:modified">2026-10-07T00:00:00Z<\/meta>/)
  assert.deepEqual([...opf.matchAll(/<itemref idref="([^"]+)"/g)].map(m => m[1]), ['title', 'c1', 'c2'])
  const nav = strFromU8(files['OEBPS/nav.xhtml'])
  assert.match(nav, /<a href="c0001\.xhtml">卷上<\/a>/)
  assert.match(nav, /<a href="c0002\.xhtml">2<\/a>/)
  const c1 = strFromU8(files['OEBPS/c0001.xhtml'])
  assert.match(c1, /<p>a &lt; b &amp; c<\/p>/)
  assert.match(strFromU8(files['OEBPS/c0002.xhtml']), /<p class="verse">天地玄黃<\/p>/)
  assert.match(strFromU8(files['OEBPS/title.xhtml']), /来源：研辞问典/)
  assert.ok(files['OEBPS/toc.ncx'] && files['META-INF/container.xml'] && files['OEBPS/style.css'])
})
