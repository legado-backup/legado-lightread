import assert from 'node:assert/strict'
import test from 'node:test'
import {
  openLibraryBookUrl,
  parseOpenLibraryResults,
  searchOpenLibrary,
} from '../src/services/openLibrary.ts'

test('accept only official work/edition identifiers', () => {
  assert.equal(openLibraryBookUrl('OL27448W'), 'https://openlibrary.org/works/OL27448W')
  assert.equal(openLibraryBookUrl('/works/OL27448W'), 'https://openlibrary.org/works/OL27448W')
  assert.equal(openLibraryBookUrl('/books/OL37239326M'), 'https://openlibrary.org/books/OL37239326M')
  assert.equal(openLibraryBookUrl('OL37239326M'), 'https://openlibrary.org/books/OL37239326M')
  for (const invalid of [null, 12, '', '/authors/OL1A', '/works/OL1M', '/books/OL1W',
    '//evil.example/OL1W', 'https://evil.example/works/OL1W', '/works/OL1W/../admin',
    '/works/OL1W?redirect=evil', '/works/OL1W#x', '/works/OL1W\n']) {
    assert.equal(openLibraryBookUrl(invalid), undefined, String(invalid))
  }
})

test('normalize metadata, deduplicate identifiers and skip unusable records', () => {
  const books = parseOpenLibraryResults({ docs: [
    null, 'invalid', {}, { key: 'OL2W', title: '  ' },
    { key: '/works/OL3M', title: 'Wrong path' },
    { key: 'OL27448W', title: '  The Lord of the Rings  ', author_name: [' J. R. R. Tolkien ', null, '', 1], first_publish_year: 1954, ebook_access: 'borrowable' },
    { key: '/works/OL27448W', title: 'Duplicate' },
    { key: '/books/OL37239326M', title: 'Crime and Punishment', author_name: ['A', 'B'], first_publish_year: '1866', ebook_access: 'unexpected' },
  ] })
  assert.deepEqual(books, [
    { key: '/works/OL27448W', title: 'The Lord of the Rings', author: 'J. R. R. Tolkien', year: 1954, access: 'borrowable', url: 'https://openlibrary.org/works/OL27448W' },
    { key: '/books/OL37239326M', title: 'Crime and Punishment', author: 'A、B', access: 'unknown', url: 'https://openlibrary.org/books/OL37239326M' },
  ])
  const accesses = ['public', 'borrowable', 'printdisabled', 'no_ebook', undefined]
  assert.deepEqual(parseOpenLibraryResults({ docs: accesses.map((access, index) => ({ key: `OL${index}W`, title: 'Book', ebook_access: access })) }).map(book => book.access),
    ['public', 'borrowable', 'printdisabled', 'no_ebook', 'unknown'])
})

test('distinguish empty results from invalid API responses and bound result count', () => {
  assert.deepEqual(parseOpenLibraryResults({ docs: [] }), [])
  for (const payload of [null, [], {}, { docs: null }, { docs: {} }]) {
    assert.throws(() => parseOpenLibraryResults(payload), /无效的搜索结果/)
  }
  const payload = { docs: Array.from({ length: 50 }, (_, index) => ({ key: `OL${index}W`, title: 'Book' })) }
  assert.equal(parseOpenLibraryResults(payload).length, 24)
  assert.equal(parseOpenLibraryResults(payload, 1000).length, 40)
  assert.equal(parseOpenLibraryResults(payload, NaN).length, 24)
  assert.equal(parseOpenLibraryResults(payload, 2.9).length, 2)
  assert.equal(parseOpenLibraryResults(payload, -1).length, 1)
})

test('search encodes user input, requests selected JSON fields and applies limit', async () => {
  const fetcher = async (input, auth, init) => {
    const url = new URL(input)
    assert.equal(url.origin, 'https://openlibrary.org')
    assert.equal(url.pathname, '/search.json')
    assert.equal(url.searchParams.get('q'), '三体 & author:刘慈欣')
    assert.equal(url.searchParams.get('fields'), 'key,title,author_name,first_publish_year,ebook_access')
    assert.equal(url.searchParams.get('limit'), '40')
    assert.equal(auth, undefined)
    assert.equal(init.headers.accept, 'application/json')
    assert.ok(init.signal instanceof AbortSignal)
    return Response.json({ docs: [{ key: 'OL1W', title: '三体' }] })
  }
  assert.equal((await searchOpenLibrary('  三体 & author:刘慈欣  ', 100, fetcher))[0].title, '三体')
})

test('blank query makes no request; network and JSON errors propagate', async () => {
  assert.deepEqual(await searchOpenLibrary(' \n\t ', 24, () => assert.fail('network called')), [])
  await assert.rejects(searchOpenLibrary('book', 24, async () => { throw new Error('offline') }), /offline/)
  await assert.rejects(searchOpenLibrary('book', 24, async () => new Response('<html>')), SyntaxError)
})

test('abort requests after 30 seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let signal
  const request = searchOpenLibrary('book', 24, async (_url, _auth, init) => {
    signal = init.signal
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))
  })
  t.mock.timers.tick(29_999)
  assert.equal(signal.aborted, false)
  t.mock.timers.tick(1)
  await assert.rejects(request, /aborted/)
  assert.equal(signal.aborted, true)
})
