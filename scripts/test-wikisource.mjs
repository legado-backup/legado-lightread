import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyWikisourcePageInfo, parseWikisourceResults, rankWikisourceHits, searchWikisource, wikisourceEpubUrl, wikisourcePageUrl,
} from '../src/services/wikisource.ts'

const hit = (pageid, title = '陋室銘') => ({ ns: 0, pageid, title })
const mark = text => `<span class="searchmatch">${text}</span>`
/** 标题高亮: 'a[b]c' → a<span>b</span>c */
const snip = text => text.replace(/\[([^\]]+)\]/g, (_, word) => mark(word))
const titled = (pageid, pattern) => ({ ns: 0, pageid, title: pattern.replace(/[\[\]]/g, ''), titlesnippet: snip(pattern) })
let judgmentId = 1000
const judgment = word => titled(judgmentId++, `中信出版集团股份有限公司[${word}]袁丽艳等侵害作品发行权纠纷一审民事判决书`)
const titles = books => books.map(book => [book.title, book.relevance])

test('build genuine official EPUB exports with encoded titles', () => {
  const title = '文集/卷一 & format=pdf # 序'
  const url = new URL(wikisourceEpubUrl(title))
  assert.equal(url.origin, 'https://ws-export.wmcloud.org')
  assert.equal(url.pathname, '/')
  assert.equal(url.searchParams.get('lang'), 'zh')
  assert.equal(url.searchParams.get('format'), 'epub-3')
  assert.equal(url.searchParams.get('page'), title)
  assert.equal(url.hash, '')
})

test('convert search snippets to text and produce importable EPUB publications', () => {
  const [book] = parseWikisourceResults({ query: { search: [{
    ...hit(9943), snippet: '山不在高，<span class="searchmatch">有仙</span>則名。 &amp; &#x4e2d; &#25991; &quot;古文&quot; &nbsp; test',
  }] } })
  assert.deepEqual(book, {
    id: '9943', title: '陋室銘', summary: '山不在高，有仙則名。 & 中 文 "古文" test',
    url: 'https://zh.wikisource.org/w/index.php?curid=9943',
    relevance: 1,
    publication: {
      title: '陋室銘', author: '', summary: '山不在高，有仙則名。 & 中 文 "古文" test',
      acquisitions: [{ href: wikisourceEpubUrl('陋室銘'), type: 'application/epub+zip', label: 'EPUB' }],
    },
  })
})

test('skip invalid pages and non-work namespaces; deduplicate valid page IDs', () => {
  const books = parseWikisourceResults({ query: { search: [
    null, 'text', {}, hit(0), hit(-1), hit(1.2), hit('1'), hit(Number.MAX_SAFE_INTEGER + 1),
    { ...hit(2), ns: 102 }, { ...hit(3), ns: 14 }, hit(4, ' \n '), hit(5, 'x\u0000y'),
    hit(9943), hit(9943, 'duplicate'), { ...hit(6, '愛蓮說'), snippet: { html: 'bad' } },
  ] } })
  assert.deepEqual(books.map(book => book.id), ['9943', '6'])
  assert.equal(books[1].summary, undefined)
})

test('malformed entities stay readable; snippets and result counts are bounded', () => {
  const result = parseWikisourceResults({ query: { search: [{ ...hit(1), snippet: '&#9999999999; &#xD800; &unknown; ' + '字'.repeat(500) }] } })
  assert.equal(result[0].summary.length, 400)
  assert.ok(result[0].summary.startsWith('&#9999999999; &#xD800; &unknown;'))
  const payload = { query: { search: Array.from({ length: 50 }, (_, i) => hit(i + 1, `文集${i + 1}`)) } }
  assert.equal(parseWikisourceResults(payload).length, 20)
  assert.equal(parseWikisourceResults(payload, 90).length, 40)
  assert.equal(parseWikisourceResults(payload, NaN).length, 20)
  assert.equal(parseWikisourceResults(payload, -1).length, 1)
  assert.equal(parseWikisourceResults(payload, 2.9).length, 2)
})

test('empty results differ from API failures and invalid response envelopes', () => {
  assert.deepEqual(parseWikisourceResults({ query: { search: [] } }), [])
  assert.throws(() => parseWikisourceResults({ error: { code: 'ratelimited', info: 'Slow down' } }), /Slow down/)
  for (const payload of [null, [], {}, { query: {} }, { query: { search: 'bad' } }]) {
    assert.throws(() => parseWikisourceResults(payload), /无效的搜索结果/)
  }
})

test('search uses anonymous CORS, main namespace, title snippets and a follow-up category check', async () => {
  const requests = []
  const books = await searchWikisource('  《红楼梦》，文集  ', 100, async (input, auth, init) => {
    const url = new URL(input)
    requests.push(url)
    assert.equal(url.origin, 'https://zh.wikisource.org')
    assert.equal(url.pathname, '/w/api.php')
    assert.equal(url.searchParams.get('action'), 'query')
    assert.equal(url.searchParams.get('origin'), '*')
    assert.equal(url.searchParams.get('format'), 'json')
    assert.equal(auth, undefined)
    assert.equal(init.headers.accept, 'application/json')
    assert.ok(init.signal instanceof AbortSignal)
    if (url.searchParams.get('list') === 'search') {
      assert.equal(url.searchParams.get('srsearch'), '红楼梦 文集')
      assert.equal(url.searchParams.get('srnamespace'), '0')
      assert.equal(url.searchParams.get('srlimit'), '50')
      assert.match(url.searchParams.get('srprop'), /titlesnippet/)
      return Response.json({ query: { search: [
        { ns: 0, pageid: 1, title: '紅樓夢文集', titlesnippet: '<span class="searchmatch">紅樓夢</span><span class="searchmatch">文集</span>' },
      ] } })
    }
    assert.equal(url.searchParams.get('prop'), 'pageprops|categories')
    assert.equal(url.searchParams.get('titles'), '紅樓夢文集')
    return Response.json({ query: { pages: [{ title: '紅樓夢文集', categories: [{ title: 'Category:清朝' }] }] } })
  })
  assert.equal(requests.length, 2)
  assert.deepEqual(books.map(book => [book.title, book.relevance]), [['紅樓夢文集', 3]])
})

test('category check failures keep the title-filtered results; nothing found skips it', async () => {
  const search = { query: { search: [{ ns: 0, pageid: 7, title: '論語', titlesnippet: '<span class="searchmatch">論語</span>' }] } }
  const books = await searchWikisource('论语', 20, async input => {
    if (new URL(input).searchParams.get('list') === 'search') return Response.json(search)
    throw new Error('offline')
  })
  assert.deepEqual(books.map(book => book.title), ['論語'])
  let calls = 0
  assert.deepEqual(await searchWikisource('思考 快与慢', 20, async () => {
    calls++
    return Response.json({ query: { search: [judgment('与')] } })
  }), [])
  assert.equal(calls, 1)
})

test('blank query avoids network and network/JSON errors propagate', async () => {
  assert.deepEqual(await searchWikisource(' \n ', 20, () => assert.fail('network called')), [])
  await assert.rejects(searchWikisource('book', 20, async () => { throw new Error('offline') }), /offline/)
  await assert.rejects(searchWikisource('book', 20, async () => new Response('<html>')), SyntaxError)
})

test('search cancels after 30 seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let signal
  const request = searchWikisource('陋室銘', 20, async (_url, _auth, init) => {
    signal = init.signal
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))
  })
  t.mock.timers.tick(29_999)
  assert.equal(signal.aborted, false)
  t.mock.timers.tick(1)
  await assert.rejects(request, /aborted/)
})

test('books mentioned in court judgments are not results; title matches are required', () => {
  // 「思考 快与慢」真实返回: 全是在正文里提到这本书的判决书, 标题只零散命中「与」
  const hits = [judgment('与'), judgment('与'), titled(5, '石某贵[与]王某机动车交通事故责任纠纷二审民事判决书'), hit(6, '日照市某某公司劳动争议')]
  assert.deepEqual(rankWikisourceHits(hits, '思考 快与慢'), [])
  assert.deepEqual(rankWikisourceHits(hits, '思考，快与慢'), [])
})

test('legal and official documents are excluded even when their titles match', () => {
  const hits = [
    titled(1, '刘文君、上海[三体]商贸有限公司等民间借贷纠纷一审民事判决书'),
    titled(2, '[三]青[体]（北京）体育科技有限公司与星盛瑞达公司合同纠纷二审民事判决书'),
    titled(3, '中国—拉共[体]论坛第[三]届部长会议宣言'),
    titled(4, '[三體]唐詩 (四庫全書本)'),
    titled(5, '[三體]唐詩 (四庫全書本)/卷2'),
    titled(6, '新闻出版署关于重申出版[三体]著作有关规定的通知'),
    titled(7, '[三体]某某刑事一审刑事裁定书'),
  ]
  assert.deepEqual(titles(rankWikisourceHits(hits, '三体')), [['三體唐詩 (四庫全書本)', 2]])
})

test('chapters collapse into their work and rank below exact titles', () => {
  const hits = [
    titled(10, '后[红楼梦]/第01回'),
    titled(11, '《[紅樓夢]》考證（改定稿）'),
    titled(12, '[紅樓夢]'),
    titled(13, '[紅樓夢] (消歧義)'),
    titled(14, '[紅樓夢]/第005回'),
    titled(15, '[紅樓夢]（程甲本）'),
    titled(16, '後[紅樓夢]'),
    titled(17, '續[紅樓夢]/00'),
  ]
  const books = rankWikisourceHits(hits, '红楼梦')
  assert.deepEqual(titles(books), [
    // 书名号不算前缀: 《紅樓夢》考證 视同以「紅樓夢」开头
    ['紅樓夢', 3], ['紅樓夢（程甲本）', 3], ['《紅樓夢》考證（改定稿）', 2], ['后红楼梦', 1], ['後紅樓夢', 1], ['續紅樓夢', 1],
  ])
  const sequel = books.find(book => book.title === '后红楼梦')
  assert.equal(sequel.id, '后红楼梦')
  assert.equal(sequel.url, wikisourcePageUrl('后红楼梦'))
  assert.equal(sequel.publication.acquisitions[0].href, wikisourceEpubUrl('后红楼梦'))
  assert.equal(books[0].url, 'https://zh.wikisource.org/w/index.php?curid=12')
})

test('prefix matches outrank titles that merely contain the query', () => {
  const books = rankWikisourceHits([
    titled(1, '學習[鲁迅]雜文'), titled(2, '[魯迅]全集'), titled(3, '[魯迅]日記/甲寅日記'), titled(4, '[魯迅]日記/乙卯日記'),
  ], '鲁迅')
  assert.deepEqual(titles(books), [['魯迅全集', 2], ['魯迅日記', 2], ['學習鲁迅雜文', 1]])
})

test('scattered or repeated fragments do not count as a title match', () => {
  const hits = [
    titled(1, '[狂人][日記]'),
    titled(2, '承政院[日記]/仁祖/八年'),
    titled(3, '赴燕[日記]/往還[日記]'),
  ]
  assert.deepEqual(titles(rankWikisourceHits(hits, '狂人日记')), [['狂人日記', 3]])
  // 只有深层章节名命中: 期刊里的一篇文章不是这本书
  assert.deepEqual(rankWikisourceHits([titled(4, '中國軍人/第四期/死去的领袖与[活着]的我们')], '活着'), [])
})

test('a chapter whose work and chapter title both match is kept as that chapter', () => {
  const books = rankWikisourceHits([titled(1, '[論語]/[學而]第一'), titled(2, '四書大全/讀[論語]孟子法')], '论语 学而')
  assert.deepEqual(titles(books), [['論語/學而第一', 0]])
  assert.equal(books[0].url, 'https://zh.wikisource.org/w/index.php?curid=1')
})

test('without title snippets, titles are matched literally', () => {
  assert.deepEqual(titles(rankWikisourceHits([hit(1, '陋室銘'), hit(2, '愛蓮說')], '陋室銘')), [['陋室銘', 3]])
  assert.deepEqual(rankWikisourceHits([hit(1, '陋室銘')], '陋室铭'), [])
})

test('page categories remove court judgments; disambiguation pages lose the EPUB export', () => {
  const books = rankWikisourceHits([
    titled(1, '[狂人日記]'), titled(2, '[狂人日記]選'), titled(3, '[狂人日記]案民事判決'), titled(4, '[狂人日記]集'),
  ], '狂人日记')
  const checked = applyWikisourcePageInfo(books, { query: {
    normalized: [{ from: '狂人日記集', to: '狂人日記 集' }],
    pages: [
      // 公版文学作品同样带「公有领域」分类, 不能据此排除
      { title: '狂人日記', categories: [{ title: 'Category:中华人民共和国公有领域' }, { title: 'Category:PD-old-80-1996' }] },
      { title: '狂人日記選', pageprops: { disambiguation: '' }, categories: [] },
      { title: '狂人日記案民事判決', categories: [{ title: 'Category:2022年中华人民共和国民事判决书' }] },
      { title: '狂人日記 集', categories: [{ title: 'Category:消歧义' }] },
    ],
  } })
  assert.deepEqual(checked.map(book => [book.title, !!book.disambiguation, book.publication.acquisitions.length]), [
    ['狂人日記', false, 1], ['狂人日記選', true, 0], ['狂人日記集', true, 0],
  ])
  assert.equal(applyWikisourcePageInfo(books, { error: 'x' }), books)
})
