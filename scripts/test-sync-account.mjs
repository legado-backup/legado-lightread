// 轻阅账号同步: accountRemote × 假账号服务器; 账号 + WebDAV 两个远端共用基线的多设备场景; account.ts 的登录状态.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runSync, sha256Hex } from '../src/services/sync/engine.ts'
import {
  baselineUsableFor, createMemorySyncStore, nextBaselineRemotes,
} from '../src/services/sync/baseline.ts'
import { AccountApiError, createAccountRemote, isAccountUnauthorized } from '../src/services/sync/accountRemote.ts'
import { createFakeAccountServer, createFakeDav, createFakeStorage, enc, tr } from './sync-test-fakes.mjs'

let clock = 1_800_000_000_000
const tick = (ms = 1000) => (clock += ms)

async function device(name) {
  const storage = createFakeStorage()
  await storage.init()
  return { name, storage, store: createMemorySyncStore(`dev-${name}`) }
}

const syncOne = (dev, remote) => runSync({
  storage: dev.storage,
  remote,
  store: dev.store,
  syncFiles: true,
  now: () => clock,
  deviceName: dev.name,
  app: 'test',
  t: tr,
})

/** 同 sync/index.ts 的 syncNow: 依次同步各远端 (先账号, 再 WebDAV) */
async function syncAll(dev, ...remotes) {
  const results = []
  for (const r of remotes) {
    tick()
    results.push(await syncOne(dev, r))
  }
  return results
}

const BOOK_BYTES = enc('%EPUB fake book for account sync')
const BOOK2_BYTES = enc('%EPUB another book only on B')

function importBook(dev, extra = {}, bytes = BOOK_BYTES) {
  return dev.storage.addBook({
    title: '三体', author: '刘慈欣', format: 'epub', fileName: 'santi.epub',
    tags: [], addedAt: clock, readingSeconds: 60,
    location: 'cfi-1', progress: 0.1, lastReadAt: clock, ...extra,
  }, new Blob([bytes]))
}

const onlyBook = async dev => {
  const list = await dev.storage.listBooks()
  assert.equal(list.length, 1)
  return list[0]
}

const emptyDoc = (deviceId, extra = {}) => ({
  format: 1, deviceId, writtenAt: 1, books: {}, annotations: {}, booklists: {}, booklistItems: {}, sources: {}, ...extra,
})

// ---- accountRemote ----

test('accountRemote: 文档读写、Bearer、跳过未知格式、不存文件', async () => {
  const srv = createFakeAccountServer()
  const sess = srv.login('a@x.com')
  const remote = srv.remote(sess)
  assert.equal(remote.kind, 'account')
  assert.equal(remote.id, `account:${sess.account.id}`)
  assert.equal(remote.supportsFiles, false)
  await remote.prepare()
  assert.deepEqual(await remote.listDocs(), [])
  assert.deepEqual([...await remote.listFiles()], [])
  await assert.rejects(remote.putFile('x', new Blob([])))
  await assert.rejects(remote.getFile('x'))

  await remote.putDoc(emptyDoc('dev-1'))
  await remote.putDoc(emptyDoc('dev-2', { writtenAt: 2 }))
  await remote.putDoc(emptyDoc('dev-2', { writtenAt: 3 })) // 覆盖本设备的旧文档
  srv.docs.get(sess.account.id).set('future', JSON.stringify(emptyDoc('future', { format: 2 })))
  srv.docs.get(sess.account.id).set('junk', JSON.stringify({ deviceId: 'junk' }))
  const docs = await remote.listDocs()
  assert.deepEqual(docs.map(d => [d.deviceId, d.writtenAt]).sort(), [['dev-1', 1], ['dev-2', 3]])
  assert.ok(srv.log.includes('PUT /v1/docs/dev-2'))

  // 别的账号看不到
  const other = srv.remote(srv.login('b@x.com'))
  assert.deepEqual(await other.listDocs(), [])
})

test('accountRemote: 401 / 413 / 网络错误映射为本地化错误', async () => {
  const srv = createFakeAccountServer()
  const sess = srv.login('a@x.com')
  const remote = srv.remote(sess)

  srv.opts.maxBytes = 10
  await assert.rejects(remote.putDoc(emptyDoc('dev-1')), e =>
    e instanceof AccountApiError && e.status === 413 && e.message === 'account.err.server {"status":413}'
    && !isAccountUnauthorized(e))
  srv.opts.maxBytes = Infinity

  srv.opts.down = true
  await assert.rejects(remote.listDocs(), e => e.status === 0 && e.message === 'account.err.network')
  srv.opts.down = false

  srv.sessions.clear() // token 被吊销
  await assert.rejects(remote.listDocs(), e =>
    isAccountUnauthorized(e) && e.message === 'account.err.unauthorized')

  // 网关错误页 (非 JSON)
  const gw = createAccountRemote({ base: 'https://sync.test/', token: 't', accountId: 'u' },
    async () => ({ status: 502, text: async () => '<html>Bad gateway</html>' }), tr)
  await assert.rejects(gw.listDocs(), { message: 'account.err.server {"status":502}' })
  // 同步接口的 429 不套用「发送验证码太频繁」的文案
  const limited = createAccountRemote({ base: 'https://sync.test', token: 't', accountId: 'u' },
    async () => ({ status: 429, text: async () => '{"error":"rate_limited","retryAfter":30}' }), tr)
  await assert.rejects(limited.putDoc(emptyDoc('d')), e => e.message === 'account.err.server {"status":429}' && e.retryAfter === 30)
})

// ---- 基线在远端间共用 ----

test('基线可用性: 同步过的远端 / 新的一类远端可用, 同类换了作废; 旧版基线视为 [remoteId]', () => {
  const wd = { id: 'webdav:https://dav#u' }
  const acc = { id: 'account:u1' }
  const old = { remoteId: wd.id, doc: emptyDoc('d'), presentHashes: [], syncedAt: 1 }
  assert.equal(baselineUsableFor(old, wd), true)
  assert.equal(baselineUsableFor(old, acc), true, '新增账号: 本机已知状态照样作数')
  assert.equal(baselineUsableFor(old, { id: 'webdav:https://other#u' }), false, '换了 WebDAV')
  assert.deepEqual(nextBaselineRemotes(old, true, acc), [wd.id, acc.id])
  const both = { ...old, remoteId: acc.id, remotes: [wd.id, acc.id] }
  assert.equal(baselineUsableFor(both, { id: 'account:u2' }), false, '换了账号')
  assert.deepEqual(nextBaselineRemotes(both, false, { id: 'account:u2' }), [wd.id, 'account:u2'])
  assert.deepEqual(nextBaselineRemotes(null, false, acc), [acc.id])
})

test('A 用账号 + WebDAV, B 只用账号: B 得到仅元数据的书, 导入同一文件后匹配; 改动经两个远端收敛', async () => {
  const srv = createFakeAccountServer()
  const dav = createFakeDav()
  const sessA = srv.login('me@x.com')
  const sessB = srv.login('me@x.com')
  const accA = srv.remote(sessA)
  const accB = srv.remote(sessB)
  const wdA = dav.remote()
  const A = await device('A')
  const B = await device('B')
  const hash = await sha256Hex(BOOK_BYTES)
  const uid = sessA.account.id

  const bookA = await importBook(A, { location: 'cfi-9', progress: 0.9 })
  const annId = await A.storage.addAnnotation({
    bookId: bookA, kind: 'highlight', cfi: 'epubcfi(/6/4)', text: '给岁月以文明', color: 'red', createdAt: clock,
  })
  const [ra1, rw1] = await syncAll(A, accA, wdA)
  assert.equal(ra1.uploadedFiles, 0, '账号不存文件')
  assert.equal(rw1.uploadedFiles, 1, 'WebDAV 存书文件')
  assert.equal(srv.readDoc(uid, 'dev-A').books[hash].meta.value.title, '三体')
  assert.deepEqual((await A.store.loadBaseline()).remotes, [accA.id, wdA.id])

  // B 只有账号: 仅元数据
  const [rb1] = await syncAll(B, accB)
  assert.equal(rb1.pendingBooks, 1)
  assert.equal(rb1.devices, 2)
  assert.equal((await B.storage.listBooks()).length, 0)

  // B 导入同一文件 → 匹配进度与标注
  tick(60_000)
  const bookB = await B.storage.addBook({
    title: '三体(副本)', author: '', format: 'epub', fileName: 'copy.epub', tags: [], addedAt: clock,
  }, new Blob([BOOK_BYTES]))
  const [rb2] = await syncAll(B, accB)
  assert.equal(rb2.pendingBooks, 0)
  let b = await B.storage.getBook(bookB)
  assert.equal(b.title, '三体', '同步过的元数据胜过刚导入的')
  assert.equal(b.location, 'cfi-9')
  assert.equal(b.readingSeconds, 60)
  assert.deepEqual((await B.storage.listAnnotations(bookB)).map(a => a.id), [annId])

  // B 阅读并删标注 → A 经账号拿到, 再经 A 转写到 WebDAV
  tick(60_000)
  await B.storage.updateBook(bookB, { location: 'cfi-20', progress: 0.95, lastReadAt: clock, readingSeconds: 60 + 120 })
  await B.storage.deleteAnnotation(annId)
  await syncAll(B, accB)
  await syncAll(A, accA, wdA)
  const a = await A.storage.getBook(bookA)
  assert.equal(a.location, 'cfi-20')
  assert.equal(a.readingSeconds, 180)
  assert.deepEqual(await A.storage.listAnnotations(bookA), [])

  // A 写到 WebDAV 的文档沿用 B 的寄存器 (不重新打 stamp), 时长仍记在 B 名下
  const wdDoc = dav.readJson('devices/dev-A.json')
  assert.equal(wdDoc.books[hash].progress.stamp.d, 'dev-B')
  assert.deepEqual(wdDoc.books[hash].reading, { 'dev-A': 60, 'dev-B': 120 })
  assert.equal(wdDoc.annotations[annId].value, null)
  assert.equal(wdDoc.annotations[annId].stamp.d, 'dev-B')

  // 收敛: 再各同步一次没有改动, 时长不重复计算
  await syncAll(B, accB)
  const [ra3, rw3] = await syncAll(A, accA, wdA)
  assert.equal(ra3.applied + rw3.applied, 0)
  const [rb3] = await syncAll(B, accB)
  assert.equal(rb3.applied, 0)
  assert.equal((await A.storage.getBook(bookA)).readingSeconds, 180)
  b = await B.storage.getBook(bookB)
  assert.equal(b.readingSeconds, 180)

  // A 删书 → B 也删除; WebDAV 上也是墓碑
  await A.storage.deleteBook(bookA)
  await syncAll(A, accA, wdA)
  await syncAll(B, accB)
  assert.equal((await B.storage.listBooks()).length, 0)
  assert.equal(dav.readJson('devices/dev-A.json').books[hash].alive.value, false)
})

test('多台设备各连不同远端 (A、D 两者, B 仅账号, C 仅 WebDAV): 时长不重复计算, 较新的改动不被转写盖掉', async () => {
  const srv = createFakeAccountServer()
  const dav = createFakeDav()
  const accA = srv.remote(srv.login('me@x.com'))
  const accB = srv.remote(srv.login('me@x.com'))
  const wdA = dav.remote()
  const wdC = dav.remote()
  const accD = srv.remote(srv.login('me@x.com'))
  const wdD = dav.remote()
  const A = await device('A')
  const B = await device('B')
  const C = await device('C')
  const D = await device('D')

  await importBook(A, { readingSeconds: 100 })
  await syncAll(A, accA, wdA)
  await syncAll(C, wdC) // C 从 WebDAV 下载书
  await importBook(B, { readingSeconds: 0, lastReadAt: 0, location: undefined, progress: undefined })
  await syncAll(B, accB)
  await syncAll(D, accD, wdD)
  const bookB = await onlyBook(B)
  const bookC = await onlyBook(C)
  assert.equal(bookB.readingSeconds, 100)
  assert.equal(bookC.readingSeconds, 100)

  // B 读 30 秒, C 读 50 秒
  await B.storage.updateBook(bookB.id, { readingSeconds: 130 })
  await C.storage.updateBook(bookC.id, { readingSeconds: 150 })
  for (let i = 0; i < 3; i++) {
    await syncAll(B, accB)
    await syncAll(C, wdC)
    await syncAll(A, accA, wdA)
    await syncAll(D, accD, wdD)
  }
  for (const dev of [A, B, C, D]) {
    assert.equal((await onlyBook(dev)).readingSeconds, 180, `${dev.name} 总时长 = 100 + 30 + 50`)
  }

  // C 先改书名 (经 WebDAV), A 转到账号后, B 再改 (更晚) → 各处都应是 B 的书名
  tick(10_000)
  await C.storage.updateBook(bookC.id, { title: 'C 改的' })
  await syncAll(C, wdC)
  await syncAll(A, wdA) // A 只从 WebDAV 拿到 C 的改动, 还没同步账号
  tick(10_000)
  await B.storage.updateBook(bookB.id, { title: 'B 改的 (更晚)' })
  await syncAll(B, accB)
  for (let i = 0; i < 2; i++) {
    await syncAll(A, accA, wdA)
    await syncAll(B, accB)
    await syncAll(C, wdC)
    await syncAll(D, accD, wdD)
  }
  for (const dev of [A, B, C, D]) {
    assert.equal((await onlyBook(dev)).title, 'B 改的 (更晚)', dev.name)
  }
})

test('已用 WebDAV 的设备首次登录账号: 未上账号的本地改动不被账号里的旧记录盖掉', async () => {
  const srv = createFakeAccountServer()
  const dav = createFakeDav()
  const A = await device('A')
  const B = await device('B')
  const bookA = await importBook(A)
  await syncAll(A, dav.remote())
  await syncAll(B, dav.remote())
  // B 先登录账号, 把当时的状态写上去
  const accB = srv.remote(srv.login('me@x.com'))
  await syncAll(B, accB)
  // A 改书名 (已同步到 WebDAV), 然后首次登录账号
  tick(10_000)
  await A.storage.updateBook(bookA, { title: '新书名' })
  await syncAll(A, dav.remote())
  const accA = srv.remote(srv.login('me@x.com'))
  await syncAll(A, accA, dav.remote())
  assert.equal((await A.storage.getBook(bookA)).title, '新书名')
  await syncAll(B, accB, dav.remote())
  assert.equal((await onlyBook(B)).title, '新书名')
})

test('换账号: 基线对新账号作废, 旧账号里只有元数据的书不会带进新账号', async () => {
  const srv = createFakeAccountServer()
  const A = await device('A')
  const B = await device('B')
  const sessX = srv.login('x@x.com')
  await importBook(B, {}, BOOK2_BYTES) // 只在 B 上
  await syncAll(B, srv.remote(srv.login('x@x.com')))
  await importBook(A)
  const [r1] = await syncAll(A, srv.remote(sessX))
  assert.equal(r1.pendingBooks, 1, 'A 知道 B 的书 (仅元数据)')

  const sessY = srv.login('y@x.com')
  const accY = srv.remote(sessY)
  await syncAll(A, accY)
  const docY = srv.readDoc(sessY.account.id, 'dev-A')
  assert.deepEqual(Object.keys(docY.books), [await sha256Hex(BOOK_BYTES)])
  assert.deepEqual((await A.store.loadBaseline()).remotes, [accY.id])

  // 登录回旧账号: 按首次同步只并集, 本地书不删
  await syncAll(A, srv.remote(sessX))
  assert.equal((await A.storage.listBooks()).length, 1)
})

// ---- account.ts (登录状态 + 接口封装) ----

test('account.ts: 登录 / 错误文案 / 401 清除登录 / 注销 / 退出', async () => {
  const mem = new Map()
  globalThis.localStorage = {
    getItem: k => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: k => mem.delete(k),
  }
  const srv = createFakeAccountServer('https://sync.test')
  const realFetch = globalThis.fetch
  globalThis.fetch = (url, init) => srv.fetch(url, init)
  mem.set('lightread-sync-api', 'https://sync.test/')
  try {
    const acc = await import('../src/services/account.ts')
    const { t } = await import('../src/i18n/index.ts')
    assert.equal(acc.accountApiBase(), 'https://sync.test')
    assert.equal(acc.isLoggedIn(), false)

    await assert.rejects(acc.requestLoginCode('nope'), { message: t('account.err.invalidEmail') })
    await assert.rejects(acc.requestLoginCode('a@bounce.test'), { message: t('account.err.emailFailed') })
    srv.opts.codeRateLimited = true
    await assert.rejects(acc.requestLoginCode('me@x.com'), e =>
      e.message === t('account.err.rateLimited', { seconds: 42 }) && e.retryAfter === 42)
    srv.opts.codeRateLimited = false
    srv.opts.down = true
    await assert.rejects(acc.requestLoginCode('me@x.com'), { message: t('account.err.network') })
    srv.opts.down = false

    await acc.requestLoginCode(' Me@X.com ')
    await assert.rejects(acc.verifyLoginCode('me@x.com', '000000'), { message: t('account.err.invalidCode') })
    const info = await acc.verifyLoginCode('me@x.com', '123456')
    assert.equal(info.email, 'me@x.com')
    assert.equal(acc.isLoggedIn(), true)
    assert.equal(acc.accountState.account.id, info.id)
    const saved = JSON.parse(mem.get('lightread-account'))
    assert.equal(saved.token, acc.accountState.token)
    assert.ok(srv.sessions.get(saved.token).deviceName, '带上设备名')

    // 401: 本地登录被清除
    const token1 = acc.accountState.token
    srv.sessions.delete(token1)
    await assert.rejects(acc.deleteAccount(), { message: t('account.err.unauthorized') })
    assert.equal(acc.isLoggedIn(), false)
    assert.equal(mem.has('lightread-account'), false)
    acc.clearLocalLogin('stale') // 旧 token 不影响

    // 注销: 云端账号与文档都删除
    await acc.requestLoginCode('me@x.com')
    const me = await acc.verifyLoginCode('me@x.com', '123456')
    await srv.remote({ token: acc.accountState.token, account: me }).putDoc(emptyDoc('dev-1'))
    await acc.deleteAccount()
    assert.equal(acc.isLoggedIn(), false)
    assert.equal(srv.users.has(me.id), false)
    assert.equal(srv.docs.has(me.id), false)

    // 退出: 服务端吊销; 网络不通时也照样退出本地
    await acc.requestLoginCode('me@x.com')
    await acc.verifyLoginCode('me@x.com', '123456')
    const token2 = acc.accountState.token
    await acc.logout()
    assert.equal(srv.sessions.has(token2), false)
    assert.equal(acc.isLoggedIn(), false)
    await acc.requestLoginCode('me@x.com')
    await acc.verifyLoginCode('me@x.com', '123456')
    srv.opts.down = true
    await acc.logout()
    assert.equal(acc.isLoggedIn(), false)
    srv.opts.down = false
  } finally {
    globalThis.fetch = realFetch
  }
})
