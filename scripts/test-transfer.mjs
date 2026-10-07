// 互传: 纯函数 (校验 / 解析 / 新条目检测 / 文件名 / 取件码) + 三个通道 × 假后端
// (账号与取件码: 按 docs/account-api.md 行为的内存假服务器; WebDAV: sync-test-fakes 的假 WebDAV 加 DELETE).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  codeFromLink, composeInput, dropShareLink, durationText, extOf, findNew, formatBytes, groupBySender,
  isIncomingFor, isOutgoing, looksLikeUrl, mergeItems, normalizeCode, parseItem, parseWebdavName,
  rememberSeen, safeFilename, textFileName, validateSend, webdavStem,
} from '../src/services/transfer/model.ts'
import { LIMITS, MB, TransferError } from '../src/services/transfer/types.ts'
import { createAccountChannel } from '../src/services/transfer/accountChannel.ts'
import { createWebdavChannel, webdavBlobName } from '../src/services/transfer/webdavChannel.ts'
import { createDropChannel, createMemoryDropStore } from '../src/services/transfer/dropChannel.ts'
import { createFakeDav, tr } from './sync-test-fakes.mjs'

const bytes = (n, fill = 7) => new Blob([new Uint8Array(n).fill(fill)])

// ---- 纯函数 ----

test('链接识别与输入归类: 整段链接 → link, 其它 → text, 有文件 → file', () => {
  assert.ok(looksLikeUrl(' https://example.com/a.epub '))
  assert.ok(!looksLikeUrl('看看 https://example.com'))
  assert.ok(!looksLikeUrl('javascript:alert(1)'))
  assert.ok(!looksLikeUrl('ftp://x.y/z'))
  assert.deepEqual(composeInput('https://a.b/c'), { kind: 'link', url: 'https://a.b/c' })
  assert.deepEqual(composeInput('  你好\n世界 '), { kind: 'text', text: '  你好\n世界 ' })
  assert.equal(composeInput('   '), null)
  const f = composeInput('附言', { blob: bytes(3), name: 'a.epub' })
  assert.equal(f.kind, 'file')
  assert.equal(f.filename, 'a.epub')
  assert.equal(f.title, '附言')
})

test('发送校验: 文字 64KB (按 UTF-8 字节)、链接、空文件、文件上限', () => {
  assert.equal(validateSend({ kind: 'text', text: '汉'.repeat(21845) }), null) // 65535 字节
  assert.equal(validateSend({ kind: 'text', text: '汉'.repeat(21846) }).key, 'transfer.err.textTooLong')
  assert.equal(validateSend({ kind: 'text', text: '  ' }).key, 'transfer.err.empty')
  assert.equal(validateSend({ kind: 'link', url: 'javascript:1' }).key, 'transfer.err.badUrl')
  assert.equal(validateSend({ kind: 'file', file: bytes(0), filename: 'a.txt' }).key, 'transfer.err.emptyFile')
  assert.equal(validateSend({ kind: 'file', file: bytes(21 * MB), filename: 'a.pdf' }, LIMITS.dropAnonBytes).key, 'transfer.err.fileTooLarge')
  assert.equal(validateSend({ kind: 'file', file: bytes(21 * MB), filename: 'a.pdf' }), null)
  assert.equal(validateSend({ kind: 'text', text: 'x', title: 'x'.repeat(301) }).key, 'transfer.err.titleTooLong')
})

test('条目解析: 缺字段 / 类型不符的丢弃; toDevice 空串视为全部', () => {
  const ok = parseItem({ id: 'a', kind: 'text', text: 'hi', fromDevice: 'd1', fromName: 'A', toDevice: '', createdAt: 5 }, 'account')
  assert.equal(ok.toDevice, null)
  assert.equal(ok.expiresAt, 5 + LIMITS.keepMs)
  assert.equal(parseItem({ id: 'a', kind: 'text', createdAt: 5 }, 'account'), null)
  assert.equal(parseItem({ id: 'a', kind: 'link', createdAt: 5 }, 'account'), null)
  assert.equal(parseItem({ id: 'a', kind: 'evil', text: 'x', createdAt: 5 }, 'account'), null)
  assert.equal(parseItem({ kind: 'text', text: 'x', createdAt: 5 }, 'account'), null)
  assert.equal(parseItem(null, 'account'), null)
})

test('方向、新条目检测与已见记录', () => {
  const me = 'me'
  const mk = (id, from, to, createdAt = 1000) => ({ id, channel: 'account', kind: 'text', text: id, fromDevice: from, fromName: from.toUpperCase(), toDevice: to, title: '', createdAt, expiresAt: createdAt + LIMITS.keepMs })
  const items = [mk('1', 'a', null), mk('2', 'a', 'me'), mk('3', 'a', 'b'), mk('4', 'me', null), mk('5', 'b', null)]
  assert.deepEqual(items.filter(i => isIncomingFor(i, me)).map(i => i.id), ['1', '2', '5'])
  assert.ok(isOutgoing(items[3], me))
  const now = 2000
  assert.deepEqual(findNew(items, new Set(['1']), me, now, false).map(i => i.id), ['2', '5'])
  // 首次运行只提醒 24 小时内的
  const old = mk('6', 'a', null, now - 2 * 86400_000)
  assert.deepEqual(findNew([old, items[0]], new Set(), me, now, true).map(i => i.id), ['1'])
  // 已过期的不提醒
  assert.deepEqual(findNew([{ ...items[0], expiresAt: now - 1 }], new Set(), me, now, false), [])
  assert.deepEqual(groupBySender(findNew(items, new Set(), me, now, false)), [{ name: 'A', count: 2 }, { name: 'B', count: 1 }])
  assert.deepEqual(rememberSeen(['a', 'b'], ['c', 'a'], 3), ['c', 'a', 'b'])
  // 取件码条目: 有 ownerToken 的是本机发出的
  assert.ok(isOutgoing({ ...items[0], channel: 'drop', ownerToken: 'x' }, me))
  assert.ok(!isOutgoing({ ...items[0], channel: 'drop', fromDevice: me }, me))
})

test('合并排序去重; 文件名清理; 格式化', () => {
  const a = { id: 'x', channel: 'account', createdAt: 1 }
  const b = { id: 'x', channel: 'webdav', createdAt: 3 }
  const c = { id: 'x', channel: 'account', createdAt: 2 }
  assert.deepEqual(mergeItems([a], [b, c]).map(i => `${i.channel}${i.createdAt}`), ['webdav3', 'account2'])
  assert.equal(safeFilename('../../etc/passwd'), 'passwd')
  assert.equal(safeFilename('C:\\x\\书.epub'), '书.epub')
  assert.equal(safeFilename('\u0000\u0007.hidden'), 'hidden')
  assert.equal(safeFilename(''), 'file')
  const long = safeFilename('a'.repeat(300) + '.epub')
  assert.equal(long.length, 255)
  assert.ok(long.endsWith('.epub'))
  assert.equal(extOf('A.Fb2'), 'fb2')
  assert.equal(extOf('noext'), '')
  assert.equal(textFileName({ title: '', text: '\n\n第一行\n第二行' }), '第一行.txt')
  assert.equal(textFileName({ title: '', text: '' }), 'text.txt')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(50 * MB), '50 MB')
  assert.equal(durationText(30_000, tr), 'transfer.wait.seconds {"n":30}')
  assert.equal(durationText(3600_000, tr), 'transfer.wait.hours {"n":1}')
  assert.equal(durationText(10 * 60_000, tr), 'transfer.wait.minutes {"n":10}')
  assert.equal(durationText(7 * 86400_000, tr), 'transfer.wait.days {"n":7}')
})

test('取件码与分享链接', () => {
  assert.equal(normalizeCode(' 123 456 '), '123456')
  assert.equal(normalizeCode('12345'), null)
  assert.equal(codeFromLink('https://x.app/#/transfer?code=654321'), '654321')
  assert.equal(codeFromLink('https://sync.jiangshu.ai/d/000123'), '000123')
  assert.equal(codeFromLink('123-456'), '123456')
  assert.equal(codeFromLink('hello'), null)
  assert.equal(dropShareLink('123456', 'https://sync.jiangshu.ai/', null), 'https://sync.jiangshu.ai/d/123456')
  assert.equal(dropShareLink('123456', 'https://sync.jiangshu.ai', 'https://app.example/#/library'), 'https://app.example/#/transfer?code=123456')
})

test('WebDAV 文件名解析', () => {
  const stem = webdavStem(1_800_000_000_000, 'ab-c_D9')
  assert.equal(stem, 'item-1800000000000-abcD9')
  assert.deepEqual(parseWebdavName(`${stem}.json`), { type: 'item', stem, createdAt: 1_800_000_000_000, json: true })
  assert.deepEqual(parseWebdavName(`${stem}.epub`), { type: 'item', stem, createdAt: 1_800_000_000_000, json: false })
  assert.deepEqual(parseWebdavName('device-abc-123.json'), { type: 'device', deviceId: 'abc-123' })
  assert.equal(parseWebdavName('random.txt'), null)
  assert.equal(webdavBlobName({ id: stem, filename: 'x.EPUB' }), `${stem}.epub`)
  assert.equal(webdavBlobName({ id: stem, filename: 'noext' }), `${stem}.bin`)
})

// ---- 假账号 / 取件服务器 (行为对齐 docs/account-api.md 互传 / 取件码) ----

function createFakeTransferServer(base = 'https://sync.test') {
  let clock = 1_800_000_000_000
  const tokens = new Map([['tok-1', 'acct-1'], ['tok-2', 'acct-2']])
  const transfers = new Map()
  const blobs = new Map()
  const devices = new Map()
  const drops = new Map()
  const log = []
  let seq = 0
  const json = (status, body) => ({ status, text: async () => (body === undefined ? '' : JSON.stringify(body)) })
  const fail = (status, error, retryAfter) => json(status, retryAfter ? { error, retryAfter } : { error })
  const acctOf = headers => tokens.get(/^Bearer (.+)$/.exec(headers?.authorization ?? '')?.[1] ?? '')
  const pub = row => {
    const { accountId, ready, ...item } = row
    return item
  }

  async function handle(method, url, headers, body) {
    const u = new URL(url)
    const path = u.pathname
    log.push(`${method} ${path}`)
    let m
    if ((m = /^\/v1\/drops(?:\/([^/]+))?(\/blob)?$/.exec(path))) {
      const [, key, blob] = m
      if (method === 'POST' && !key) {
        const b = JSON.parse(body)
        const max = acctOf(headers) ? 50 * MB : 20 * MB
        if (b.kind === 'file' && b.size > max) return fail(413, 'too_large')
        if (![600, 3600].includes(b.ttl)) return fail(400, 'invalid_drop')
        const id = `drop-${++seq}`
        const code = String(100000 + seq)
        drops.set(id, { id, code, ownerToken: `own-${id}`, ...b, ready: b.kind !== 'file', downloads: 0, createdAt: clock, expiresAt: clock + b.ttl * 1000 })
        return json(201, { id, code, ownerToken: `own-${id}`, expiresAt: clock + b.ttl * 1000, maxDownloads: 10 })
      }
      if (method === 'PUT' && blob) {
        const d = drops.get(key)
        if (!d) return fail(404, 'not_found')
        if (headers['x-drop-token'] !== d.ownerToken) return fail(403, 'forbidden')
        d.blob = body
        d.ready = true
        return json(204)
      }
      if (method === 'DELETE') {
        const d = drops.get(key)
        if (!d) return fail(404, 'not_found')
        if (headers['x-drop-token'] !== d.ownerToken) return fail(403, 'forbidden')
        drops.delete(key)
        return json(204)
      }
      if (method === 'GET') {
        const d = [...drops.values()].find(x => x.code === key && x.ready)
        if (!d) return fail(404, 'not_found')
        if (d.expiresAt <= clock || d.downloads >= 10) return fail(410, 'gone')
        if (blob) {
          d.downloads++
          return { status: 200, blob: d.blob, text: '' }
        }
        if (d.kind !== 'file') d.downloads++
        const { ownerToken, blob: _b, ready, downloads, id, code, ttl, ...rest } = d
        return json(200, { ...rest, downloadsLeft: 10 - d.downloads })
      }
    }

    const acct = acctOf(headers)
    if (!acct) return fail(401, 'unauthorized')
    if (method === 'GET' && path === '/v1/devices') {
      return json(200, { devices: [...devices.values()].filter(d => d.accountId === acct).map(({ accountId, ...d }) => d) })
    }
    if (method === 'GET' && path === '/v1/transfers') {
      const me = u.searchParams.get('device')
      if (!me) return fail(400, 'invalid_device')
      devices.set(`${acct}:${me}`, { accountId: acct, id: me, name: u.searchParams.get('name') ?? '', lastSeenAt: clock })
      const since = Number(u.searchParams.get('since') ?? 0)
      const items = [...transfers.values()]
        .filter(r => r.accountId === acct && r.ready && r.expiresAt > clock && r.createdAt > since)
        .filter(r => r.fromDevice === me || ((r.toDevice === null || r.toDevice === me) && r.fromDevice !== me))
        .sort((a, b) => b.createdAt - a.createdAt)
      return json(200, { items: items.map(pub), now: clock })
    }
    if (method === 'POST' && path === '/v1/transfers') {
      const b = JSON.parse(body)
      if (b.kind === 'file' && b.size > 50 * MB) return fail(413, 'too_large')
      if (b.kind === 'text' && new TextEncoder().encode(b.text).length > 64 * 1024) return fail(413, 'too_large')
      const id = `t-${++seq}`
      clock += 1000
      const row = { id, accountId: acct, kind: b.kind, fromDevice: b.fromDevice, fromName: b.fromName ?? '', toDevice: b.toDevice ?? null, title: b.title ?? '', createdAt: clock, expiresAt: clock + LIMITS.keepMs, ready: b.kind !== 'file' }
      for (const k of ['text', 'url', 'filename', 'size', 'mime']) if (b[k] !== undefined) row[k] = b[k]
      transfers.set(id, row)
      return json(201, { item: pub(row) })
    }
    if ((m = /^\/v1\/transfers\/([^/]+)(\/blob)?$/.exec(path))) {
      const row = transfers.get(m[1])
      if (!row || row.accountId !== acct) return fail(404, 'not_found')
      if (m[2] && method === 'PUT') {
        if (Number(headers['content-length'] ?? body.size) !== row.size) return fail(400, 'invalid_length')
        blobs.set(row.id, body)
        row.ready = true
        return json(204)
      }
      if (m[2] && method === 'GET') return { status: 200, blob: blobs.get(row.id), text: '' }
      if (!m[2] && method === 'DELETE') {
        transfers.delete(row.id)
        blobs.delete(row.id)
        return json(204)
      }
    }
    return fail(404, 'not_found')
  }

  const transport = {
    fetch: (url, init) => handle(init.method, url, init.headers ?? {}, init.body),
    async upload(url, init) {
      init.onProgress?.(0.5)
      const res = await handle('PUT', url, init.headers, init.body)
      return { status: res.status, text: await res.text() }
    },
    async download(url, init) {
      const res = await handle('GET', url, init.headers, undefined)
      if (res.blob) {
        init.onProgress?.(1)
        return { status: res.status, blob: res.blob, text: '' }
      }
      return { status: res.status, blob: null, text: await res.text() }
    },
  }
  return {
    base, transport, transfers, blobs, drops, log,
    tick(ms) { clock += ms },
    get now() { return clock },
  }
}

const acct = (srv, deviceId, token = 'tok-1') =>
  createAccountChannel({ base: srv.base, token, deviceId, deviceName: `Dev ${deviceId}` }, srv.transport, tr)

test('账号通道: 文字发全部 / 链接发指定设备 / 他人账号不可见 / 设备登记', async () => {
  const srv = createFakeTransferServer()
  const A = acct(srv, 'A')
  const B = acct(srv, 'B')
  const C = acct(srv, 'C')
  const other = acct(srv, 'X', 'tok-2')
  for (const ch of [A, B, C, other]) await ch.list()

  const sent = await A.send({ kind: 'text', text: '你好' })
  assert.equal(sent.channel, 'account')
  assert.equal(sent.toDevice, null)
  await A.send({ kind: 'link', url: 'https://example.com/b.epub', toDevice: 'B' })

  const forB = await B.list()
  assert.deepEqual(forB.map(i => i.kind), ['link', 'text'])
  assert.equal(forB[1].fromName, 'Dev A')
  const forC = await C.list()
  assert.deepEqual(forC.map(i => i.kind), ['text'], 'C 只看到发给全部的')
  assert.deepEqual((await A.list()).map(i => i.kind), ['link', 'text'], '发送方看到自己发出的')
  assert.deepEqual(await other.list(), [], '别的账号看不到')
  assert.equal((await B.list(sent.createdAt)).length, 1, 'since 只返回之后的')

  const devs = await A.devices()
  assert.deepEqual(devs.map(d => d.id).sort(), ['B', 'C'], '设备列表不含本机')
  assert.equal(devs.find(d => d.id === 'B').name, 'Dev B')
})

test('账号通道: 文件先建记录再上传 (带进度), 接收方下载内容一致; 删除对所有设备生效', async () => {
  const srv = createFakeTransferServer()
  const A = acct(srv, 'A')
  const B = acct(srv, 'B')
  const file = new Blob([new TextEncoder().encode('EPUB-BYTES')])
  const progress = []
  const item = await A.send({ kind: 'file', file, filename: '书.epub', title: '书' }, { onProgress: p => progress.push(p) })
  assert.equal(item.kind, 'file')
  assert.deepEqual(progress, [0.5, 1])
  assert.deepEqual(srv.log.slice(-2), ['POST /v1/transfers', `PUT /v1/transfers/${item.id}/blob`])
  const [got] = await B.list()
  assert.equal(got.filename, '书.epub')
  assert.equal(got.size, file.size)
  const blob = await B.fetchBlob(got)
  assert.equal(await blob.text(), 'EPUB-BYTES')
  await B.remove(got)
  assert.deepEqual(await A.list(), [])
  // 再删一次 (已不存在) 不报错
  await A.remove(got)
})

test('账号通道: 本地校验与服务端错误映射 (401 / 413 / 429)', async () => {
  const srv = createFakeTransferServer()
  const A = acct(srv, 'A')
  await assert.rejects(A.send({ kind: 'file', file: bytes(51 * MB), filename: 'x.pdf' }), e => e instanceof TransferError && e.status === -1)
  await assert.rejects(A.send({ kind: 'text', text: '' }), /transfer\.err\.empty/)
  const bad = acct(srv, 'A', 'nope-token')
  await assert.rejects(bad.list(), e => e instanceof TransferError && e.status === 401 && /account\.err\.unauthorized/.test(e.message))

  const limited = createAccountChannel({ base: 'https://x', token: 't', deviceId: 'A', deviceName: 'A' }, {
    fetch: async () => ({ status: 429, text: async () => JSON.stringify({ error: 'rate_limited', retryAfter: 7200 }) }),
    upload: async () => ({ status: 200, text: '' }),
    download: async () => ({ status: 200, blob: null, text: '' }),
  }, tr)
  await assert.rejects(limited.send({ kind: 'text', text: 'x' }), e =>
    e.status === 429 && e.retryAfter === 7200 && e.message.includes('transfer.wait.hours'))

  const offline = createAccountChannel({ base: 'https://x', token: 't', deviceId: 'A', deviceName: 'A' }, {
    fetch: async () => { throw new TypeError('Failed to fetch') },
    upload: async () => ({ status: 200, text: '' }),
    download: async () => ({ status: 200, blob: null, text: '' }),
  }, tr)
  await assert.rejects(offline.list(), e => e.status === 0 && /transfer\.err\.network/.test(e.message))
})

test('账号通道: 上传失败时删掉半成品记录', async () => {
  const srv = createFakeTransferServer()
  const transport = { ...srv.transport, upload: async () => ({ status: 500, text: '' }) }
  const A = createAccountChannel({ base: srv.base, token: 'tok-1', deviceId: 'A', deviceName: 'A' }, transport, tr)
  await assert.rejects(A.send({ kind: 'file', file: bytes(10), filename: 'a.txt' }), e => e.status === 500)
  assert.equal(srv.transfers.size, 0)
})

// ---- 取件码 ----

test('取件码: 匿名发文字 → 输码取件 (计次); 文件需令牌上传, 取件下载一致; 撤回', async () => {
  const srv = createFakeTransferServer()
  const store = createMemoryDropStore()
  const sender = createDropChannel({ base: srv.base, deviceId: 'S', deviceName: 'S' }, srv.transport, tr, store, () => srv.now)
  const receiver = createDropChannel({ base: srv.base, deviceId: 'R', deviceName: 'R' }, srv.transport, tr, createMemoryDropStore(), () => srv.now)

  assert.equal(sender.maxFileBytes(), 20 * MB)
  const sent = await sender.send({ kind: 'text', text: '取件内容', ttlMs: 10 * 60_000 })
  assert.match(sent.code, /^\d{6}$/)
  assert.ok(sent.ownerToken)
  assert.equal(sent.expiresAt, srv.now + 600_000)
  assert.deepEqual((await sender.list()).map(i => i.id), [sent.id], '发出的记在本机')

  const got = await receiver.lookup(` ${sent.code.slice(0, 3)} ${sent.code.slice(3)} `)
  assert.equal(got.text, '取件内容')
  assert.equal(got.downloadsLeft, 9)
  assert.ok(!isOutgoing(got, 'R'))
  assert.equal((await receiver.list()).length, 1, '取到的记在本机')
  await assert.rejects(receiver.lookup('12'), e => e.code === 'invalid_code')
  await assert.rejects(receiver.lookup('999999'), e => e.status === 404)

  const fileItem = await sender.send({ kind: 'file', file: new Blob(['PDFDATA']), filename: 'a.pdf' })
  const meta = await receiver.lookup(fileItem.code)
  assert.equal(meta.filename, 'a.pdf')
  assert.equal(await (await receiver.fetchBlob(meta)).text(), 'PDFDATA')

  await assert.rejects(sender.send({ kind: 'file', file: bytes(21 * MB), filename: 'big.pdf' }), e => e.status === -1)
  const authed = createDropChannel({ base: srv.base, token: 'tok-1', deviceId: 'S', deviceName: 'S' }, srv.transport, tr, createMemoryDropStore(), () => srv.now)
  assert.equal(authed.maxFileBytes(), 50 * MB)

  await sender.remove(sent)
  await assert.rejects(receiver.lookup(sent.code), e => e.status === 404)
  assert.ok(!(await sender.list()).some(i => i.id === sent.id))
  // 接收方删除只删本机记录
  await receiver.remove(got)
  assert.ok(!(await receiver.list()).some(i => i.id === got.id))
})

test('取件码: 过期 → 410, 映射为 transfer.err.gone', async () => {
  const srv = createFakeTransferServer()
  const ch = createDropChannel({ base: srv.base, deviceId: 'S', deviceName: 'S' }, srv.transport, tr, createMemoryDropStore(), () => srv.now)
  const sent = await ch.send({ kind: 'link', url: 'https://a.b/c' })
  srv.tick(3600_001)
  await assert.rejects(ch.lookup(sent.code), e => e.status === 410 && /transfer\.err\.gone/.test(e.message))
})

// ---- WebDAV ----

function davWithDelete() {
  const dav = createFakeDav()
  const root = new URL(dav.base).pathname.replace(/\/+$/, '')
  const http = async (url, req) => {
    if (req.method === 'DELETE') {
      dav.log.push(`DELETE ${url}`)
      const p = decodeURIComponent(new URL(url).pathname)
      return { status: dav.files.delete(p) ? 204 : 404, text: async () => '', blob: async () => new Blob([]) }
    }
    return dav.http(url, req)
  }
  return { dav, http, dir: `${root}/LightRead/transfer` }
}

function memKv() {
  const m = new Map()
  return { get: k => m.get(k) ?? null, set: (k, v) => m.set(k, v) }
}

test('WebDAV 通道: 建目录、登记设备、文件先传本体再写 json、按目标可见、删除', async () => {
  const { dav, http, dir } = davWithDelete()
  let clock = 1_800_000_000_000
  let r = 0
  const mk = id => createWebdavChannel({ url: dav.base + '/', user: 'u', pass: 'p' }, { deviceId: id, deviceName: `Dev ${id}` },
    { http, translate: tr, now: () => clock, kv: memKv(), rand: () => `r${++r}` })
  const A = mk('A')
  const B = mk('B')
  const C = mk('C')

  assert.deepEqual(await B.list(), [], '目录还不存在时为空')
  const text = await A.send({ kind: 'text', text: '经 WebDAV' })
  assert.match(text.id, /^item-1800000000000-r\d+$/)
  clock += 1000
  const file = await A.send({ kind: 'file', file: new Blob(['BOOK']), filename: 'b.epub', toDevice: 'B' })
  const puts = dav.log.filter(l => l.startsWith('PUT'))
  assert.ok(puts.at(-2).endsWith(`${file.id}.epub`) && puts.at(-1).endsWith(`${file.id}.json`), '先传本体再写 json')
  const stored = JSON.parse(new TextDecoder().decode(dav.files.get(`${dir}/${file.id}.json`)))
  assert.equal(stored.format, 1)
  assert.equal(stored.blob, `${file.id}.epub`)
  assert.equal(stored.channel, undefined)

  const forB = await B.list()
  assert.deepEqual(forB.map(i => i.kind), ['file', 'text'])
  assert.equal(await (await B.fetchBlob(forB[0])).text(), 'BOOK')
  assert.deepEqual((await C.list()).map(i => i.kind), ['text'], 'C 看不到只发给 B 的')
  assert.deepEqual((await A.list()).map(i => i.id), [file.id, text.id])

  // 轮询过的设备都登记了
  assert.ok(dav.files.has(`${dir}/device-B.json`) && dav.files.has(`${dir}/device-C.json`))
  const devs = await A.devices()
  assert.deepEqual(devs.map(d => d.id).sort(), ['B', 'C'])
  assert.equal(devs.find(d => d.id === 'C').name, 'Dev C')

  // 第二次轮询: 只 PROPFIND, 不重复 GET 已见过的 json, 当天不重复登记
  const before = dav.log.length
  await B.list()
  const extra = dav.log.slice(before)
  assert.deepEqual(extra.map(l => l.split(' ')[0]), ['PROPFIND'])

  await B.remove(forB[0])
  assert.ok(!dav.files.has(`${dir}/${file.id}.json`) && !dav.files.has(`${dir}/${file.id}.epub`))
  assert.deepEqual((await A.list()).map(i => i.id), [text.id], '删除对所有设备生效')
})

test('WebDAV 通道: 7 天前的条目由轮询的设备顺手删除; 401 映射为 sync.err.auth', async () => {
  const { dav, http, dir } = davWithDelete()
  let clock = 1_800_000_000_000
  const A = createWebdavChannel({ url: dav.base, user: 'u', pass: 'p' }, { deviceId: 'A', deviceName: 'A' },
    { http, translate: tr, now: () => clock, kv: memKv() })
  const old = await A.send({ kind: 'file', file: new Blob(['x']), filename: 'old.txt' })
  clock += LIMITS.keepMs + 1000
  const fresh = await A.send({ kind: 'text', text: 'new' })
  const list = await A.list()
  assert.deepEqual(list.map(i => i.id), [fresh.id])
  assert.ok(!dav.files.has(`${dir}/${old.id}.json`) && !dav.files.has(`${dir}/${old.id}.txt`))

  dav.authFail = true
  await assert.rejects(A.list(), e => e.status === 401 && /sync\.err\.auth/.test(e.message))
})
