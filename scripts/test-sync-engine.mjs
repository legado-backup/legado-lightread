// 同步引擎 + WebDAV 后端端到端契约: 内存假书库 × 内存假 WebDAV 服务器 × 内存基线.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runSync, sha256Hex } from '../src/services/sync/engine.ts'
import { createWebdavRemote, parsePropfindNames } from '../src/services/sync/webdavRemote.ts'
import { createMemorySyncStore } from '../src/services/sync/baseline.ts'
import { createFakeDav, createFakeStorage, enc, tr } from './sync-test-fakes.mjs'

// ---- 场景工具 ----
let clock = 1_700_000_000_000
const tick = (ms = 1000) => (clock += ms)

async function device(name) {
  const storage = createFakeStorage()
  await storage.init()
  return { name, storage, store: createMemorySyncStore(`dev-${name}`) }
}

const sync = (dev, dav, opts = {}) => runSync({
  storage: dev.storage,
  remote: opts.remote ?? dav.remote(),
  store: dev.store,
  syncFiles: opts.syncFiles ?? true,
  now: () => clock,
  deviceName: dev.name,
  app: 'test',
  t: tr,
  onProgress: opts.onProgress,
})

const BOOK_BYTES = enc('%EPUB fake book content for sync tests')
const COVER_BYTES = enc('fake-jpeg-cover')

async function importBook(dev, extra = {}) {
  return dev.storage.addBook({
    title: '三体', author: '刘慈欣', format: 'epub', fileName: 'santi.epub',
    tags: ['科幻'], addedAt: clock, readingSeconds: 60,
    location: 'cfi-1', progress: 0.1, lastReadAt: clock, ...extra,
  }, new Blob([BOOK_BYTES]), extra.noCover ? undefined : new Blob([COVER_BYTES]))
}

const onlyBook = async dev => {
  const list = await dev.storage.listBooks()
  assert.equal(list.length, 1)
  return list[0]
}

// ---- 场景 ----

test('A → B: 书文件、标注、书单、书源沿用原 id; B 阅读 + 删标注后回到 A', async () => {
  const dav = createFakeDav()
  const A = await device('A')
  const B = await device('B')
  const hash = await sha256Hex(BOOK_BYTES)

  const bookA = await importBook(A)
  const annId = await A.storage.addAnnotation({
    bookId: bookA, kind: 'highlight', cfi: 'epubcfi(/6/2)', text: '给岁月以文明', color: 'yellow', createdAt: clock,
  })
  const listId = await A.storage.createBooklist('科幻书单', { createdAt: clock })
  await A.storage.addBooksToBooklist(listId, [bookA], { addedAt: clock + 5 })
  await A.storage.addSource({ title: '我的 calibre', url: 'https://calibre.local/opds', kind: 'opds', builtin: false, addedAt: clock, username: 'me', password: 'pw' })

  tick()
  const phases = []
  const r1 = await sync(A, dav, { onProgress: m => phases.push(m.split(' ')[0]) })
  assert.equal(r1.uploadedFiles, 2, '书 + 封面')
  assert.equal(r1.devices, 1)
  assert.ok(dav.files.has(`/remote.php/dav/LightRead/sync/v1/files/${hash}`))
  assert.ok(dav.files.has(`/remote.php/dav/LightRead/sync/v1/files/${hash}.cover`))
  assert.equal(dav.readJson('devices/dev-A.json').deviceId, 'dev-A')
  for (const p of ['sync.phase.scan', 'sync.phase.hash', 'sync.phase.fetch', 'sync.phase.apply', 'sync.phase.upload', 'sync.phase.save']) {
    assert.ok(phases.includes(p), `phase ${p}`)
  }

  tick()
  const r2 = await sync(B, dav)
  assert.equal(r2.downloadedBooks, 1)
  assert.equal(r2.pendingBooks, 0)
  assert.equal(r2.devices, 2)
  const bookB = await onlyBook(B)
  assert.equal(bookB.title, '三体')
  assert.equal(bookB.location, 'cfi-1')
  assert.equal(bookB.readingSeconds, 60)
  assert.equal(bookB.hasCover, true)
  assert.deepEqual(new Uint8Array(await (await B.storage.getBookFile(bookB.id)).arrayBuffer()), BOOK_BYTES)
  const annsB = await B.storage.listAnnotations(bookB.id)
  assert.deepEqual(annsB.map(a => [a.id, a.text]), [[annId, '给岁月以文明']])
  const listsB = await B.storage.listBooklists()
  assert.deepEqual(listsB.map(l => [l.id, l.name]), [[listId, '科幻书单']])
  assert.equal(listsB[0].createdAt, bookB.addedAt, '沿用创建时间')
  assert.deepEqual(await B.storage.listBooklistItems(listId), [{ bookId: bookB.id, addedAt: listsB[0].createdAt + 5 }])
  const srcB = (await B.storage.listSources()).filter(s => !s.builtin)
  assert.deepEqual(srcB.map(s => [s.url, s.username, s.password]), [['https://calibre.local/opds', 'me', 'pw']])

  // 再同步一次: 幂等
  tick()
  const r2b = await sync(B, dav)
  assert.equal(r2b.applied, 0)
  assert.equal(r2b.uploadedFiles, 0)

  // B 阅读并删掉标注
  tick(60_000)
  await B.storage.updateBook(bookB.id, { location: 'cfi-2', progress: 0.5, lastReadAt: clock, readingSeconds: 60 + 120 })
  await B.storage.deleteAnnotation(annId)
  tick()
  await sync(B, dav)

  tick()
  const r3 = await sync(A, dav)
  assert.ok(r3.applied >= 2)
  const a = await A.storage.getBook(bookA)
  assert.equal(a.location, 'cfi-2')
  assert.equal(a.progress, 0.5)
  assert.equal(a.readingSeconds, 180)
  assert.deepEqual(await A.storage.listAnnotations(bookA), [])

  // 两边再各同步一次后收敛, 且时长不重复计算
  tick()
  await sync(B, dav)
  tick()
  const r4 = await sync(A, dav)
  assert.equal(r4.applied, 0)
  assert.equal((await A.storage.getBook(bookA)).readingSeconds, 180)
  assert.equal((await onlyBook(B)).readingSeconds, 180)
})

test('A 删书后 B 也删除; 仅元数据的书不会因本地没有而被删', async () => {
  const dav = createFakeDav()
  const A = await device('A')
  const B = await device('B')
  const C = await device('C')
  const bookA = await importBook(A)
  tick(); await sync(A, dav)
  tick(); await sync(B, dav)
  tick(); await sync(C, dav, { syncFiles: false }) // C 只有元数据
  tick(); await sync(C, dav, { syncFiles: false })
  assert.equal((await C.storage.listBooks()).length, 0)

  await A.storage.deleteBook(bookA)
  tick(); await sync(A, dav)
  tick(); await sync(B, dav)
  assert.equal((await B.storage.listBooks()).length, 0)
  const hash = await sha256Hex(BOOK_BYTES)
  assert.equal(dav.readJson('devices/dev-B.json').books[hash].alive.value, false)
})

test('不同步书籍文件: B 只拿到元数据 (pending), 之后导入同一文件时匹配进度与标注', async () => {
  const dav = createFakeDav()
  const A = await device('A')
  const B = await device('B')
  const bookA = await importBook(A, { location: 'cfi-9', progress: 0.9 })
  const annId = await A.storage.addAnnotation({
    bookId: bookA, kind: 'highlight', cfi: 'epubcfi(/6/4)', text: '弱小和无知不是生存的障碍', color: 'red', createdAt: clock,
  })
  tick(); await sync(A, dav, { syncFiles: false })
  assert.equal([...dav.files.keys()].filter(k => k.includes('/files/')).length, 0, '不上传文件')

  tick()
  const r = await sync(B, dav, { syncFiles: false })
  assert.equal(r.pendingBooks, 1)
  assert.equal(r.downloadedBooks, 0)
  assert.equal((await B.storage.listBooks()).length, 0)

  // 文件关着时远端有文件也不下载
  tick(); await sync(A, dav) // A 开启文件同步, 上传
  tick()
  const r2 = await sync(B, dav, { syncFiles: false })
  assert.equal(r2.pendingBooks, 1)

  // B 自己导入同一本书 (新的本地 id, 没有阅读记录)
  tick(60_000)
  const bookB = await B.storage.addBook({
    title: '三体', author: '刘慈欣', format: 'epub', fileName: 'santi-copy.epub', tags: [], addedAt: clock,
  }, new Blob([BOOK_BYTES]))
  tick()
  const r3 = await sync(B, dav, { syncFiles: false })
  assert.equal(r3.pendingBooks, 0)
  const b = await B.storage.getBook(bookB)
  assert.equal(b.location, 'cfi-9', '沿用 A 的阅读位置')
  assert.equal(b.progress, 0.9)
  assert.equal(b.readingSeconds, 60)
  assert.deepEqual((await B.storage.listAnnotations(bookB)).map(a => a.id), [annId])
})

test('基线属于别的远端时作废: 不产生删除, 只做并集', async () => {
  const dav = createFakeDav()
  const A = await device('A')
  const B = await device('B')
  await importBook(B)
  tick(); await sync(B, dav)
  const hash = await sha256Hex(BOOK_BYTES)
  const remoteId = dav.remote().id

  // A 的基线说"上次这本书在本地", 但基线来自另一个远端 → 应忽略, 书被下载而不是被删
  const bDoc = (await B.store.loadBaseline()).doc
  await A.store.saveBaseline({ remoteId: 'webdav:https://other.example.com#x', doc: bDoc, presentHashes: [hash], syncedAt: clock })
  tick()
  const r = await sync(A, dav)
  assert.equal(r.downloadedBooks, 1)
  assert.equal(dav.readJson('devices/dev-A.json').books[hash].alive.value, true)
  assert.equal((await A.store.loadBaseline()).remoteId, remoteId)

  // 对照: 基线属于当前远端时, 同样的情形就是"本地删了这本书"
  const A2 = await device('A2')
  await A2.store.saveBaseline({ remoteId, doc: bDoc, presentHashes: [hash], syncedAt: clock })
  tick()
  const r2 = await sync(A2, dav)
  assert.equal(r2.downloadedBooks, 0)
  assert.equal(dav.readJson('devices/dev-A2.json').books[hash].alive.value, false)
})

test('同内容多本只取 addedAt 最早的一本; hash 有缓存只算一次', async () => {
  const dav = createFakeDav()
  const A = await device('A')
  const early = await importBook(A, { addedAt: clock - 10_000, title: '早' })
  await importBook(A, { title: '晚' })
  const reads = []
  const orig = A.storage.getBookFile
  A.storage.getBookFile = async id => { reads.push(id); return orig(id) }
  tick(); await sync(A, dav, { syncFiles: false })
  assert.equal(reads.length, 2)
  const hash = await sha256Hex(BOOK_BYTES)
  const doc = dav.readJson('devices/dev-A.json')
  assert.deepEqual(Object.keys(doc.books), [hash])
  assert.equal(doc.books[hash].meta.value.title, '早')
  tick(); await sync(A, dav, { syncFiles: false })
  assert.equal(reads.length, 2, '第二次同步走 hash 缓存')
  assert.ok((await A.store.getHashes()).get(early) === hash)
})

test('WebDAV: 目录创建、401 映射、损坏文件跳过、href 解析', async () => {
  const dav = createFakeDav()
  const remote = dav.remote()
  assert.equal(remote.id, 'webdav:https://dav.example.com/remote.php/dav#u')
  assert.equal(remote.supportsFiles, true)
  await remote.prepare()
  assert.ok(dav.log.some(l => l.startsWith('MKCOL') && l.endsWith('/sync/v1/files/')))
  const n = dav.log.length
  await remote.prepare()
  assert.equal(dav.log.slice(n).filter(l => l.startsWith('MKCOL')).length, 0, '已存在时不再 MKCOL')

  assert.deepEqual(await remote.listDocs(), [])
  assert.deepEqual([...await remote.listFiles()], [])
  assert.equal(await remote.getFile('nope'), null)

  const doc = { format: 1, deviceId: 'x', writtenAt: 1, books: {}, annotations: {}, booklists: {}, booklistItems: {}, sources: {} }
  await remote.putDoc(doc)
  dav.files.set('/remote.php/dav/LightRead/sync/v1/devices/broken.json', enc('{not json'))
  dav.files.set('/remote.php/dav/LightRead/sync/v1/devices/future.json', enc(JSON.stringify({ ...doc, deviceId: 'y', format: 2 })))
  dav.files.set('/remote.php/dav/LightRead/sync/v1/devices/readme.txt', enc('hi'))
  assert.deepEqual((await remote.listDocs()).map(d => d.deviceId), ['x'])

  await remote.putFile('abc', new Blob([enc('data')]))
  assert.deepEqual([...await remote.listFiles()], ['abc'])
  assert.equal(await (await remote.getFile('abc')).text(), 'data')

  dav.authFail = true
  await assert.rejects(remote.listDocs(), { message: 'sync.err.auth' })
  dav.authFail = false
  const bad = createWebdavRemote({ url: 'https://x', user: '', pass: '' }, async () => ({ status: 500, text: async () => '', blob: async () => new Blob() }), tr)
  await assert.rejects(bad.putDoc(doc), { message: 'sync.err.http {"status":500}' })

  const xml = `<?xml version="1.0"?><multistatus xmlns="DAV:">
    <response><href>/dav/LightRead/sync/v1/files</href></response>
    <response><href>https://h/dav/LightRead/sync/v1/files/a%20b.cover</href></response>
    <response><lp1:href xmlns:lp1="DAV:">/dav/LightRead/sync/v1/files/c&amp;d</lp1:href></response>
    <response><d:href>/dav/LightRead/sync/v1/files/sub/</d:href></response>
  </multistatus>`
  assert.deepEqual(parsePropfindNames(xml, 'files'), ['a b.cover', 'c&d'])
})
