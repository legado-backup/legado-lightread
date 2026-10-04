import assert from 'node:assert/strict'
import test from 'node:test'
import { parseWikisourceResults, searchWikisource, wikisourceEpubUrl } from '../src/services/wikisource.ts'

const hit = (pageid, title = '陋室銘') => ({ ns: 0, pageid, title })

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
    hit(9943), hit(9943, 'duplicate'), { ...hit(6), snippet: { html: 'bad' } },
  ] } })
  assert.deepEqual(books.map(book => book.id), ['9943', '6'])
  assert.equal(books[1].summary, undefined)
})

test('malformed entities stay readable; snippets and result counts are bounded', () => {
  const result = parseWikisourceResults({ query: { search: [{ ...hit(1), snippet: '&#9999999999; &#xD800; &unknown; ' + '字'.repeat(500) }] } })
  assert.equal(result[0].summary.length, 400)
  assert.ok(result[0].summary.startsWith('&#9999999999; &#xD800; &unknown;'))
  const payload = { query: { search: Array.from({ length: 50 }, (_, i) => hit(i + 1)) } }
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

test('search uses anonymous CORS, main namespace and bounded JSON requests', async () => {
  const books = await searchWikisource('  红楼梦 & 文集  ', 100, async (input, auth, init) => {
    const url = new URL(input)
    assert.equal(url.origin, 'https://zh.wikisource.org')
    assert.equal(url.pathname, '/w/api.php')
    assert.equal(url.searchParams.get('action'), 'query')
    assert.equal(url.searchParams.get('list'), 'search')
    assert.equal(url.searchParams.get('srsearch'), '红楼梦 & 文集')
    assert.equal(url.searchParams.get('srnamespace'), '0')
    assert.equal(url.searchParams.get('srlimit'), '40')
    assert.equal(url.searchParams.get('origin'), '*')
    assert.equal(url.searchParams.get('format'), 'json')
    assert.equal(auth, undefined)
    assert.equal(init.headers.accept, 'application/json')
    assert.ok(init.signal instanceof AbortSignal)
    return Response.json({ query: { search: [hit(9943)] } })
  })
  assert.equal(books[0].title, '陋室銘')
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
