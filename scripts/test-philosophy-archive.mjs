import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  PHILOSOPHY_FORMATS, foldText, preparePhilosophyIndex, searchPhilosophyIndex,
} from '../src/services/philosophyArchive.ts'

const fixture = {
  version: 1,
  updated: '2026-10-06',
  sources: [
    { id: 'mia', name: 'Marxists Internet Archive', base: 'https://www.marxists.org/', cors: false },
    { id: 'emt', name: 'Early Modern Texts', base: 'https://www.earlymoderntexts.com/', cors: true },
  ],
  authors: ['马克思', 'Karl Marx', 'Francis Bacon', '马克思恩格斯文集'],
  pages: ['chinese/pdf/me-old.htm', 'archive/marx/works/download/index.htm', 'authors/bacon'],
  works: [
    ['马克思恩格斯文集(5) 《资本论》第一卷', 3, 0, 'zh', 0, 'p:chinese/pdf/marx-engels/mea05.pdf'],
    ['《资本论》入门', -1, 0, 'zh', 0, 'p:chinese/pdf/politicaleconomics/rumen.pdf'],
    ['共产党宣言', 0, 0, 'zh', -1, 'h:chinese/marx/01.htm'],
    ['共产党宣言', 0, 0, 'zh', -1, 'h:chinese/marx/mia-chinese-marx-184002-cwd.htm'],
    ['《共产党宣言》发表一百周年', -1, 0, 'zh', -1, 'h:chinese/x/y.htm'],
    ['Capital Vol. I, 1867', 1, 0, 'en', 1, 'p:archive/marx/works/download/pdf/Capital-Volume-I.pdf e:archive/marx/works/download/epub/capital-v1.epub m:archive/marx/works/download/mobi/capital-v1.mobi'],
    ['Capital Vol. II, 1885', 1, 0, 'en', 1, 'p:archive/marx/works/download/pdf/Capital-Volume-II.pdf'],
    ['The New Organon', 2, 1, 'en', 2, 'p:assets/pdfs/bacon1620.pdf e:assets/mobile/bacon1620.epub'],
    ['Essays', 2, 1, 'en', 2, 'p:assets/pdfs/bacon1597.pdf'],
    ['broken row'],
    ['Bad source', -1, 9, 'en', -1, 'p:x.pdf'],
  ],
}
const index = preparePhilosophyIndex(fixture)
const titles = (query, limit) => searchPhilosophyIndex(index, query, limit).map(work => work.title)

test('invalid rows and unknown sources are skipped, broken indexes rejected', () => {
  assert.equal(index.works.length, 9)
  assert.throws(() => preparePhilosophyIndex({ works: [] }), /索引无效/)
  assert.throws(() => preparePhilosophyIndex(null), /索引无效/)
})

test('query normalization: 书名号, full-width punctuation, case and traditional characters', () => {
  assert.equal(foldText('共產黨宣言'), '共产党宣言')
  assert.equal(foldText('資本論'), '资本论')
  assert.equal(foldText('ＣＡＰＩＴＡＬ'), 'capital')
  for (const query of ['共产党宣言', '《共产党宣言》', '共產黨宣言', ' 「共产党宣言」 ']) {
    assert.deepEqual(titles(query).slice(0, 2), ['共产党宣言', '共产党宣言'], query)
  }
  assert.deepEqual(titles(''), [])
  assert.deepEqual(titles('《》'), [])
})

test('ranking: exact title > prefix > contains > author', () => {
  // 「共产党宣言」完全一致排在「《共产党宣言》发表一百周年」(以查询开头) 之前
  assert.deepEqual(titles('共产党宣言'), ['共产党宣言', '共产党宣言', '《共产党宣言》发表一百周年'])
  // 以查询开头 (《资本论》入门) > 包含 (文集第五卷)
  assert.deepEqual(titles('资本论'), ['《资本论》入门', '马克思恩格斯文集(5) 《资本论》第一卷'])
  // 作者命中排在书名命中之后
  const marx = searchPhilosophyIndex(index, '马克思')
  assert.equal(marx[0].title, '马克思恩格斯文集(5) 《资本论》第一卷')
  assert.deepEqual(marx.slice(1).map(w => w.title), ['共产党宣言', '共产党宣言'])
  assert.deepEqual(marx.map(w => w.relevance), [2, 1, 1])
  // 关键词分布在作者与书名中
  assert.deepEqual(titles('bacon organon'), ['The New Organon'])
  assert.deepEqual(titles('capital'), ['Capital Vol. I, 1867', 'Capital Vol. II, 1885'])
  assert.deepEqual(titles('capital', 1), ['Capital Vol. I, 1867'])
  assert.deepEqual(titles('nothing like this'), [])
})

test('EPUB preferred: among equally relevant works and within one work\'s downloads', () => {
  // 同为「以查询开头」: 有 EPUB 的第一卷排在只有 PDF 的第二卷之前
  const [capital] = searchPhilosophyIndex(index, 'capital')
  assert.deepEqual(capital.publication.acquisitions.map(acq => acq.label), ['EPUB', 'PDF', 'MOBI'])
  assert.equal(capital.relevance, 2)
  assert.equal(capital.publication.acquisitions[0].type, 'application/epub+zip')
})

test('result mapping: absolute URLs, original page, source and CORS flag', () => {
  const [organon] = searchPhilosophyIndex(index, 'the new organon')
  assert.equal(organon.relevance, 3)
  assert.equal(organon.author, 'Francis Bacon')
  assert.equal(organon.source.id, 'emt')
  assert.equal(organon.source.cors, true)
  assert.equal(organon.url, 'https://www.earlymoderntexts.com/authors/bacon')
  assert.deepEqual(organon.publication, {
    title: 'The New Organon',
    author: 'Francis Bacon',
    acquisitions: [
      { href: 'https://www.earlymoderntexts.com/assets/mobile/bacon1620.epub', type: 'application/epub+zip', label: 'EPUB' },
      { href: 'https://www.earlymoderntexts.com/assets/pdfs/bacon1620.pdf', type: 'application/pdf', label: 'PDF' },
    ],
  })
  // HTML 文章: 原网页就是文章本身, 导入时按 HTML 处理
  const [manifesto] = searchPhilosophyIndex(index, '共产党宣言')
  assert.equal(manifesto.url, 'https://www.marxists.org/chinese/marx/01.htm')
  assert.equal(manifesto.source.cors, false)
  assert.deepEqual(manifesto.publication.acquisitions, [{ href: 'https://www.marxists.org/chinese/marx/01.htm', type: 'text/html', label: 'HTML' }])
  const ids = searchPhilosophyIndex(index, '共产党宣言').map(work => work.id)
  assert.equal(new Set(ids).size, ids.length, 'ids are unique')
})

test('every download label is a format the importer recognises', () => {
  const importable = new Set(['epub', 'pdf', 'azw3', 'mobi', 'djvu', 'txt', 'html'])
  for (const format of Object.values(PHILOSOPHY_FORMATS)) assert.ok(importable.has(format.label.toLowerCase()), format.label)
})

test('the bundled index is valid, compact and finds well-known works', () => {
  const raw = readFileSync(new URL('../src/data/philosophy-index.json', import.meta.url), 'utf8')
  assert.ok(raw.length < 1024 * 1024, `index too large: ${raw.length}`)
  const data = JSON.parse(raw)
  const bundled = preparePhilosophyIndex(data)
  assert.equal(bundled.works.length, data.works.length, 'every row is valid')
  assert.ok(bundled.works.length > 1000)
  for (const work of searchPhilosophyIndex(bundled, 'a', 100)) {
    for (const acq of work.publication.acquisitions) assert.match(acq.href, /^https:\/\/(www\.marxists\.org|www\.earlymoderntexts\.com|standardebooks\.org)\//)
  }
  const first = (query) => searchPhilosophyIndex(bundled, query)[0]
  assert.equal(first('共产党宣言').title, '共产党宣言')
  assert.ok(searchPhilosophyIndex(bundled, '资本论').some(work => work.publication.acquisitions.some(acq => acq.label === 'PDF')))
  assert.ok(searchPhilosophyIndex(bundled, 'capital').some(work => /^Capital Vol\. I\b/.test(work.title) && work.publication.acquisitions[0].label === 'EPUB'))
  assert.ok(searchPhilosophyIndex(bundled, 'hegel').length > 0)
  assert.equal(first("Hegel's Logic").publication.acquisitions[0].href, 'https://www.marxists.org/ebooks/hegel/hegels-logic.epub')
})
