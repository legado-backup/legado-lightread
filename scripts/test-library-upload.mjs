import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  discoverLibraryUpload, LibraryUploadError, LIBRARY_REL, UPLOAD_REL,
  parseLibraryCapability, sameOriginLibraryUrl, uploadLibraryBook,
} from '../src/services/libraryUpload.ts'
import { acquisitionLabel, sortAcquisitions } from '../src/services/privateLibrary.ts'

const source = { id: 'mine', url: 'https://books.example/opds', title: 'My books', kind: 'opds', builtin: false, addedAt: 0, username: '读者', password: 'secret' }
const data = { version: 1, uploadUrl: '/api/upload', formats: ['epub', 'azw', 'azw3', 'pdf', 'mobi'], maxFileBytes: 94371840 }
const links = () => [{ rel: LIBRARY_REL, href: '/api/library' }, { rel: UPLOAD_REL, href: '/api/upload' }]
const response = (value, status = 200) => ({ status, text: async () => typeof value === 'string' ? value : JSON.stringify(value) })
const rejectsKey = async (task, key) => assert.rejects(task, e => e instanceof LibraryUploadError && e.key === key)

test('discovers an explicitly advertised capability with Basic auth on both reads', async () => {
  const calls = []
  const cap = await discoverLibraryUpload(source, { links, request: async (url, req) => {
    calls.push({ url, req }); return response(calls.length === 1 ? '<feed />' : data)
  } })
  assert.equal(cap.uploadUrl, 'https://books.example/api/upload')
  assert.deepEqual(calls.map(c => c.url), [source.url, 'https://books.example/api/library'])
  assert.ok(calls.every(c => c.req.method === 'GET'))
  assert.equal(Buffer.from(calls[0].req.headers.authorization.slice(6), 'base64').toString(), '读者:secret')
  assert.equal(calls[1].req.headers.authorization, calls[0].req.headers.authorization)
})
test('does not probe guessed endpoints when the server has no upload capability', async () => {
  let requests = 0
  await rejectsKey(discoverLibraryUpload(source, { links: () => [], request: async () => { requests++; return response('<feed />') } }), 'upload.unsupportedServer')
  assert.equal(requests, 1)
})
test('never requests cross-origin discovery or upload URLs with credentials', async () => {
  for (const rel of [LIBRARY_REL, UPLOAD_REL]) {
    let requests = 0
    await rejectsKey(discoverLibraryUpload(source, {
      links: () => links().map(link => link.rel === rel ? { ...link, href: 'https://attacker.example/receive' } : link),
      request: async () => { requests++; return response('<feed />') },
    }), 'upload.unsafeUrl')
    assert.equal(requests, 1)
  }
  for (const url of ['//attacker.example/u', 'http://books.example/u', 'https://u:p@books.example/u', 'javascript:alert(1)']) {
    assert.throws(() => sameOriginLibraryUrl(url, source.url), e => e.key === 'upload.unsafeUrl')
  }
  assert.throws(() => parseLibraryCapability({ ...data, uploadUrl: 'https://attacker.example/u' }, source.url), e => e.key === 'upload.unsafeUrl')
})
test('denies built-in sources before any request and rejects malformed capabilities', async () => {
  let called = false
  await rejectsKey(discoverLibraryUpload({ ...source, builtin: true }, { request: async () => { called = true } }), 'upload.unsupportedServer')
  assert.equal(called, false)
  for (const bad of [null, { ...data, version: 2 }, { ...data, formats: ['exe'] }, { ...data, maxFileBytes: -1 }]) {
    assert.throws(() => parseLibraryCapability(bad, source.url), e => e.key === 'upload.unsupportedServer')
  }
})
test('rejects inconsistent advertised upload endpoints', async () => {
  await rejectsKey(discoverLibraryUpload(source, { links, request: async url => response(url === source.url ? '<feed />' : { ...data, uploadUrl: '/different' }) }), 'upload.invalidResponse')
})
test('uploads original raw bytes and encoded Unicode metadata, returning duplicate status', async () => {
  const body = new Blob(['original AZW bytes'])
  const result = await uploadLibraryBook(source, parseLibraryCapability(data, source.url), {
    fileName: '收藏.azw', title: '我的书', author: '作者', body,
  }, async (url, req) => {
    assert.equal(url, 'https://books.example/api/upload')
    assert.equal(req.body, body)
    assert.equal(req.method, 'POST')
    assert.equal(req.headers['content-type'], 'application/vnd.amazon.ebook')
    assert.equal(decodeURIComponent(req.headers['x-file-name']), '收藏.azw')
    assert.equal(decodeURIComponent(req.headers['x-book-title']), '我的书')
    assert.equal(decodeURIComponent(req.headers['x-book-author']), '作者')
    return response({ bookId: 'sha256', title: '我的书', format: 'azw', duplicate: true })
  })
  assert.equal(result.duplicate, true)
})
test('size and format failures do not send a file; native file references remain lazy', async () => {
  const cap = parseLibraryCapability({ ...data, maxFileBytes: 2 }, source.url)
  const never = async () => { throw new Error('must not request') }
  await rejectsKey(uploadLibraryBook(source, cap, { fileName: 'book.epub', body: new Blob(['abc']) }, never), 'upload.tooLarge')
  await rejectsKey(uploadLibraryBook(source, cap, { fileName: 'book.exe', body: new Blob(['a']) }, never), 'upload.unsupportedFormat')
  const ref = { kind: 'local-file', root: '', rel: 'books/book.epub', blob: async () => { throw new Error('must not read into JS') } }
  await uploadLibraryBook(source, cap, { fileName: 'book.epub', body: ref }, async (_, req) => {
    assert.equal(req.body, ref)
    return response({ bookId: 'id', title: 'book', format: 'epub', duplicate: false }, 201)
  })
})
test('auth, oversized and invalid-success responses never report success', async () => {
  const cap = parseLibraryCapability(data, source.url)
  const input = { fileName: 'book.pdf', body: new Blob(['pdf']) }
  for (const [status, key] of [[401, 'upload.denied'], [403, 'upload.denied'], [413, 'upload.tooLargeServer'], [307, 'upload.httpError']]) {
    await rejectsKey(uploadLibraryBook(source, cap, input, async () => response('', status)), key)
  }
  await rejectsKey(uploadLibraryBook(source, cap, input, async () => response('<html>login</html>')), 'upload.invalidResponse')
})
test('AZW acquisitions remain AZW and are offered before PDF', () => {
  assert.equal(acquisitionLabel('application/octet-stream', '/books/novel.azw'), 'AZW')
  assert.equal(acquisitionLabel('application/vnd.amazon.ebook', '/books/novel.azw'), 'AZW')
  assert.equal(acquisitionLabel('application/vnd.amazon.ebook', '/books/novel.azw3'), 'AZW3')
  assert.equal(acquisitionLabel('application/x-mobi8-ebook', '/books/novel.azw3'), 'AZW3')
  assert.equal(acquisitionLabel('application/vnd.amazon.mobi8-ebook', '/books/novel.azw3'), 'AZW3')
  assert.deepEqual(sortAcquisitions([{ href: 'pdf', type: '', label: 'PDF' }, { href: 'azw', type: '', label: 'AZW' }]).map(x => x.label), ['AZW', 'PDF'])
})

test('browser upload goes directly to the private origin and disables redirects and cookies', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://books.example/api/upload')
    assert.equal(init.redirect, 'error')
    assert.equal(init.credentials, 'omit')
    assert.equal(init.method, 'POST')
    assert.ok(init.signal)
    return response({ bookId: 'id', title: 'book', format: 'epub', duplicate: false })
  }
  try {
    await uploadLibraryBook(source, parseLibraryCapability(data, source.url), { fileName: 'book.epub', body: new Blob(['raw']) })
  } finally { globalThis.fetch = original }
})
