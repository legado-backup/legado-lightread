import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  cancelLibraryUpload, dismissLibraryUpload, enqueueLibraryUpload, libraryUploadTask,
  retryFailedLibraryUploads, runLibraryUpload,
} from '../src/services/libraryUploadTask.ts'
import { LibraryUploadError } from '../src/services/libraryUpload.ts'

const source = { id: 'mine', url: 'https://books.example/opds', title: '我的书库', kind: 'opds', builtin: false, addedAt: 0 }
const cap = { version: 1, uploadUrl: 'https://books.example/api/upload', formats: ['epub', 'pdf'], maxFileBytes: 1 << 20 }
const file = (name) => new File([new Uint8Array([1, 2, 3])], name)
const input = (name) => ({ key: `file:${name}`, name, file: file(name) })
const book = (id, fileName) => ({ key: `book:${id}`, name: id, book: { id, fileName, title: `书 ${id}`, author: '某人' } })

function fakeDeps({ fail = new Set(), dup = new Set(), gate } = {}) {
  const calls = []
  return {
    calls,
    getBookFile: async () => new Blob(['x']),
    convert: async (f, fileName, meta) => ({ epub: new Blob(['epub']), fileName: fileName.replace(/\.\w+$/, '.epub'), title: meta.title, author: meta.author }),
    convertError: () => 'bad',
    upload: async (_s, _c, req) => {
      calls.push(req)
      if (gate) await gate()
      if (fail.has(req.fileName)) throw new LibraryUploadError('upload.denied')
      return { bookId: req.fileName, title: req.title ?? req.fileName, format: 'epub', duplicate: dup.has(req.fileName) }
    },
  }
}
function reset() { libraryUploadTask.rows = []; libraryUploadTask.generation = 0 }

test('runs queued uploads in order in the background and records each outcome', async () => {
  reset()
  const deps = fakeDeps({ fail: new Set(['b.epub']), dup: new Set(['c.pdf']) })
  assert.equal(enqueueLibraryUpload(source, cap, true, [input('a.epub'), input('b.epub'), input('c.pdf')], deps), 3)
  assert.equal(libraryUploadTask.running, true)
  await runLibraryUpload(deps)
  assert.equal(libraryUploadTask.running, false)
  assert.deepEqual(libraryUploadTask.rows.map(r => r.status), ['success', 'failed', 'duplicate'])
  assert.deepEqual(libraryUploadTask.rows[1].error, { key: 'upload.denied', params: {} })
  assert.deepEqual(deps.calls.map(c => c.fileName), ['a.epub', 'b.epub', 'c.pdf'])
  assert.equal(libraryUploadTask.rows[0].file, undefined, 'device file handle is released after success')
  assert.equal(libraryUploadTask.generation, 1)
})

test('books added while running join the same run; duplicates of queued books are ignored', async () => {
  reset()
  let release
  const first = new Promise(r => { release = r })
  let gated = true
  const deps = fakeDeps({ gate: () => gated ? (gated = false, first) : undefined })
  enqueueLibraryUpload(source, cap, false, [input('a.epub')], deps)
  await new Promise(r => setTimeout(r, 0))
  assert.equal(enqueueLibraryUpload(source, cap, false, [input('a.epub'), input('b.epub')], deps), 1)
  release()
  await runLibraryUpload(deps)
  assert.deepEqual(libraryUploadTask.rows.map(r => [r.name, r.status]), [['a.epub', 'success'], ['b.epub', 'success']])
})

test('converts non-EPUB books from the library to EPUB before uploading', async () => {
  reset()
  const deps = fakeDeps()
  enqueueLibraryUpload(source, cap, true, [book('m1', 'm1.mobi')], deps)
  await runLibraryUpload(deps)
  assert.equal(deps.calls[0].fileName, 'm1.epub')
  assert.equal(deps.calls[0].title, '书 m1')
  assert.equal(libraryUploadTask.rows[0].status, 'success')
})

test('cancel stops the queue after the current book; retry re-runs only failed rows', async () => {
  reset()
  let release
  const gate = new Promise(r => { release = r })
  const deps = fakeDeps({ fail: new Set(['a.epub']), gate: () => gate })
  enqueueLibraryUpload(source, cap, false, [input('a.epub'), input('b.epub'), input('c.epub')], deps)
  await new Promise(r => setTimeout(r, 0))
  cancelLibraryUpload()
  assert.equal(libraryUploadTask.cancelling, true)
  release()
  await runLibraryUpload(deps)
  assert.deepEqual(libraryUploadTask.rows.map(r => r.status), ['failed', 'cancelled', 'cancelled'])
  assert.equal(deps.calls.length, 1)
  assert.equal(libraryUploadTask.generation, 0, 'nothing reached the library')

  const ok = fakeDeps()
  retryFailedLibraryUploads(ok)
  await runLibraryUpload(ok)
  assert.deepEqual(libraryUploadTask.rows.map(r => r.status), ['success', 'cancelled', 'cancelled'])
  assert.deepEqual(ok.calls.map(c => c.fileName), ['a.epub'])

  // 新一轮开始时收起上一轮已结束的记录
  enqueueLibraryUpload(source, cap, false, [input('d.epub')], ok)
  await runLibraryUpload(ok)
  assert.deepEqual(libraryUploadTask.rows.map(r => r.name), ['d.epub'])
  dismissLibraryUpload()
  assert.equal(libraryUploadTask.rows.length, 0)
})

test('unsupported formats fail that row without stopping the queue', async () => {
  reset()
  const deps = fakeDeps()
  enqueueLibraryUpload(source, cap, false, [input('x.mobi'), input('y.epub')], deps)
  await runLibraryUpload(deps)
  assert.deepEqual(libraryUploadTask.rows.map(r => [r.status, r.error?.key]), [['failed', 'upload.unsupportedFormat'], ['success', undefined]])
})

test('folder rows load their file lazily, release it on failure and reload on retry', async () => {
  reset()
  let loads = 0, brokenLoads = 0
  const deps = fakeDeps({ fail: new Set(['lazy.epub']) })
  const lazy = { key: 'path:/books/lazy.epub', name: 'sub/lazy.epub', loadFile: async () => { loads++; return file('lazy.epub') } }
  const broken = { key: 'path:/books/gone.pdf', name: 'gone.pdf', loadFile: async () => { brokenLoads++; throw new Error('ENOENT') } }
  enqueueLibraryUpload(source, cap, false, [lazy, broken], deps)
  assert.equal(brokenLoads, 0, 'later rows are not read until their turn')
  await runLibraryUpload(deps)
  assert.deepEqual(libraryUploadTask.rows.map(r => r.status), ['failed', 'failed'])
  assert.deepEqual(libraryUploadTask.rows[1].error, { key: 'upload.fileUnavailable', params: {} })
  assert.equal(deps.calls[0].fileName, 'lazy.epub', 'upload uses the real file name, not the display path')
  assert.equal(libraryUploadTask.rows[0].file, undefined, 'failed lazy rows drop the loaded bytes')
  deps.calls.length = 0
  const ok = fakeDeps()
  retryFailedLibraryUploads(ok)
  await runLibraryUpload(ok)
  assert.equal(loads, 2)
  assert.equal(libraryUploadTask.rows[0].status, 'success')
})
