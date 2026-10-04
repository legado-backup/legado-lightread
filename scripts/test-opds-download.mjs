import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { beforeEach, test } from 'node:test'
import { strToU8, zipSync } from 'fflate'
import zh from '../src/i18n/zh.ts'
import en from '../src/i18n/en.ts'

const state = { response: null, imports: [], fetches: [], dictionary: zh }
globalThis.__opdsDownloadTest = state
const opdsUrl = new URL('../src/services/opds.ts', import.meta.url).href
const modules = {
  'foliate-js/opds.js': 'export const getFeed = () => {}; export const isOPDSCatalog = () => false; export const SYMBOL = {}',
  './net': `export const fetchXml = () => {};
    export const fetchBlob = async (...args) => { globalThis.__opdsDownloadTest.fetches.push(args); return globalThis.__opdsDownloadTest.response }`,
  './importer': 'export const importFile = async (...args) => { globalThis.__opdsDownloadTest.imports.push(args); return { ok: true, id: "book-id" } }',
  '../i18n': 'export const t = key => globalThis.__opdsDownloadTest.dictionary[key] ?? key',
}
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === opdsUrl) {
      if (modules[specifier]) return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(modules[specifier])}` }
      if (specifier === './format') return { shortCircuit: true, url: new URL('../src/services/format.ts', import.meta.url).href }
    }
    return nextResolve(specifier, context)
  },
})
const { downloadToLibrary } = await import(opdsUrl)
hook.deregister()

const book = { title: '陋室銘', author: '劉禹錫', summary: '古文', acquisitions: [] }
const epub = { href: 'https://ws-export.wmcloud.org/?format=epub-3&lang=zh&page=test', type: 'application/epub+zip', label: 'EPUB' }
const response = (body, contentType) => { state.response = { blob: new Blob([body]), contentType } }

beforeEach(() => {
  state.imports.length = 0
  state.fetches.length = 0
  state.dictionary = zh
})

test('200 HTML verification responses fail clearly before importing', async () => {
  for (const mime of ['text/html; charset=utf-8', 'Text/HTML', 'application/xhtml+xml; charset=UTF-8']) {
    response('<!DOCTYPE html><html><body>Verify you are human</body></html>', mime)
    await assert.rejects(downloadToLibrary(book, epub, 'Wikisource'), { message: zh['catalog.downloadReturnedWebpage'] })
  }
  assert.equal(state.imports.length, 0)
})

test('HTML body sniffing catches missing or incorrect MIME for EPUB, PDF and TXT', async () => {
  for (const acq of [epub, { ...epub, label: 'PDF', type: 'application/pdf' }, { ...epub, label: 'TXT', type: 'text/plain' }]) {
    for (const body of [
      '\ufeff  <!DOCTYPE html><html>Challenge</html>',
      '<!-- CDN response -->\n<html lang="en"><body>Login</body></html>',
      '<?xml version="1.0"?>\n<html xmlns="http://www.w3.org/1999/xhtml">Challenge</html>',
      '<head><title>Blocked</title></head><body>Try again</body>',
    ]) {
      response(body, 'application/octet-stream')
      await assert.rejects(downloadToLibrary(book, acq, 'Source'), { message: zh['catalog.downloadReturnedWebpage'] })
    }
  }
  assert.equal(state.imports.length, 0)
})

test('legitimate HTML and XHTML book acquisitions remain importable', async () => {
  for (const acq of [
    { ...epub, label: 'HTML', type: 'text/html' },
    { ...epub, label: 'XHTML', type: 'application/xhtml+xml' },
    { ...epub, label: 'HTM', type: 'application/octet-stream' },
  ]) {
    response('<!doctype html><html><body><h1>Book</h1><p>正文</p></body></html>', 'text/html')
    assert.equal((await downloadToLibrary(book, acq, 'OPDS')).ok, true)
  }
  assert.equal(state.imports.length, 3)
})

test('a genuine EPUB ZIP reaches importer unchanged with metadata and authentication', async () => {
  const bytes = zipSync({
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8('<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    'content.opf': strToU8('<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">test</dc:identifier><dc:title>Book</dc:title><dc:language>zh</dc:language></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>'),
    'chapter.xhtml': strToU8('<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Book</title></head><body><p>正文</p></body></html>'),
  }, { level: 0 })
  response(bytes, 'application/epub+zip')
  const auth = { username: 'reader', password: 'fixture' }
  assert.equal((await downloadToLibrary(book, epub, 'Wikisource', auth)).ok, true)
  assert.deepEqual(state.fetches, [[epub.href, auth]])
  const [file, source, metadata] = state.imports[0]
  assert.equal(file.name, '陋室銘.epub')
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes)
  assert.equal(source, 'Wikisource')
  assert.equal(metadata.author, '劉禹錫')
})

test('ordinary TXT containing an HTML example later in its text is accepted', async () => {
  response('HTML 教程\n\n<html>示例</html>', 'text/plain')
  assert.equal((await downloadToLibrary(book, { ...epub, label: 'TXT', type: 'text/plain' }, 'Source')).ok, true)
  assert.equal(state.imports.length, 1)
})

test('English errors also direct the reader to browser verification and import', async () => {
  state.dictionary = en
  response('<html>Challenge</html>', 'text/html')
  await assert.rejects(downloadToLibrary(book, epub, 'Wikisource'), { message: en['catalog.downloadReturnedWebpage'] })
  assert.equal(state.imports.length, 0)
})
