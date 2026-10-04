import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildArchiveSearchUrl,
  parseArchiveSearch,
  parseArchivePublication,
  searchInternetArchive,
  loadArchivePublication,
} from '../src/services/internetArchive.ts'

const book = { identifier: 'example_book', title: 'Example', author: 'Author', url: 'https://archive.org/details/example_book' }

test('search terms cannot escape public text and supported format filters', () => {
  const url = new URL(buildArchiveSearchUrl('books OR (*:*) " AND 中文', 1000))
  assert.equal(url.origin, 'https://archive.org')
  const query = url.searchParams.get('q')
  assert.ok(query.startsWith('("books" AND "OR" AND "\\(\\*\\:\\*\\)" AND "\\"" AND "AND" AND "中文") AND '))
  assert.match(query, /AND mediatype:texts AND NOT access-restricted-item:true/)
  assert.match(query, /AND NOT collection:printdisabled/)
  assert.match(query, /format:EPUB OR format:"Text PDF"/)
  assert.equal(url.searchParams.get('rows'), '100')
  assert.equal(new URL(buildArchiveSearchUrl('book', NaN)).searchParams.get('rows'), '24')
})

test('search normalizes metadata, ignores restricted/malformed records and deduplicates', () => {
  const results = parseArchiveSearch({ response: { docs: [
    { identifier: 'example_book', title: 'Example', creator: ['Alice', 'Bob'], year: 1920 },
    { identifier: 'example_book', title: 'duplicate' },
    { identifier: '../other', title: 'invalid' },
    { identifier: 'restricted', 'access-restricted-item': 'true' },
    { identifier: 'public', 'access-restricted-item': 'false' },
    null,
  ] } })
  assert.equal(results.length, 2)
  assert.equal(results[0].author, 'Alice, Bob')
  assert.equal(results[0].year, '1920')
  assert.equal(results[1].title, 'public')
  assert.throws(() => parseArchiveSearch({ error: 'upstream failure' }), /Invalid/)
})

test('only real public files are offered, EPUB first and one per format', () => {
  const publication = parseArchivePublication(book, {
    metadata: { title: 'Book title', creator: ['First', 'Second'], description: '<p>Summary</p>' },
    files: [
      { name: 'restricted.epub', private: 'true' },
      { name: 'drm.epub', format: 'ACS encrypted EPUB' },
      { name: 'adobe.pdf', format: 'ACS PDF' },
      { name: 'hidden.pdf', restricted: true },
      { name: 'hidden.txt', encrypted: '1' },
      { name: '../escape.epub' },
      { name: 'a\\escape.epub' },
      { name: 'metadata.txt', source: 'metadata' },
      { name: 'manual.pdf', format: 'Text PDF' },
      { name: 'folder/中文 #1.epub', format: 'EPUB', private: 'false' },
      { name: 'second.epub', format: 'EPUB' },
      { name: 'ocr.txt', format: 'DjVuTXT' },
      { name: 'book.epub.acsm' },
    ],
  })
  assert.equal(publication.title, 'Book title')
  assert.equal(publication.author, 'First, Second')
  assert.equal(publication.summary, 'Summary')
  assert.deepEqual(publication.acquisitions.map(file => file.label), ['EPUB', 'PDF', 'TXT'])
  assert.equal(publication.acquisitions[0].href, 'https://archive.org/download/example_book/folder/%E4%B8%AD%E6%96%87%20%231.epub')
})

test('missing or restricted items are refused, and unavailable formats stay empty', () => {
  assert.throws(() => parseArchivePublication(book, {}), /unavailable/)
  assert.throws(() => parseArchivePublication(book, { metadata: { 'access-restricted-item': ['true'] }, files: [] }), /authorization/)
  assert.throws(() => parseArchivePublication(book, { is_dark: true, metadata: { title: 'Dark' }, files: [] }), /authorization/)
  assert.deepEqual(parseArchivePublication(book, { metadata: { title: 'Empty' }, files: [] }).acquisitions, [])
})

test('empty search and invalid item identifiers perform no network request', async () => {
  assert.deepEqual(await searchInternetArchive('  '), [])
  await assert.rejects(loadArchivePublication({ ...book, identifier: '../bad' }), /Invalid/)
})
