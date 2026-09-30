// 多端同步端到端: 内嵌最小 WebDAV 服务, 两个浏览器上下文模拟两台设备.
// 前置: npm run build && npx vite preview --port 4173 --strictPort &
// 覆盖: 导入 → 同步上传 → 另一端下载入库 → 进度/时长回传 → 书单 → 删除传播
import http from 'node:http'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { chromium } from 'playwright'

const APP = 'http://localhost:4173/'
const DAV_PORT = 8089
const root = mkdtempSync(join(tmpdir(), 'lightread-dav-'))

// ---- 最小 WebDAV 服务 (Basic u:p, 带 CORS) ----
const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,HEAD,PUT,DELETE,MKCOL,PROPFIND,OPTIONS',
  'access-control-allow-headers': 'authorization,depth,content-type,user-agent,accept',
  'access-control-expose-headers': 'etag,content-length,last-modified',
}
const propEntry = (href, st) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${
  st.isDirectory() ? '<d:resourcetype><d:collection/></d:resourcetype>'
    : `<d:resourcetype/><d:getcontentlength>${st.size}</d:getcontentlength>`
}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
const dav = http.createServer((req, res) => {
  const send = (code, body = '', headers = {}) => { res.writeHead(code, { ...cors, ...headers }); res.end(body) }
  if (req.method === 'OPTIONS') return send(204)
  if (req.headers.authorization !== 'Basic ' + Buffer.from('u:p').toString('base64')) return send(401)
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  const file = join(root, urlPath)
  const chunks = []
  req.on('data', c => chunks.push(c))
  req.on('end', () => {
    const st = existsSync(file) ? statSync(file) : null
    switch (req.method) {
      case 'PROPFIND': {
        if (!st) return send(404)
        const base = urlPath.endsWith('/') || !st.isDirectory() ? urlPath : urlPath + '/'
        let xml = propEntry(base, st)
        if (st.isDirectory() && req.headers.depth !== '0') {
          for (const name of readdirSync(file)) {
            const cst = statSync(join(file, name))
            xml += propEntry(base + encodeURIComponent(name) + (cst.isDirectory() ? '/' : ''), cst)
          }
        }
        return send(207, `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${xml}</d:multistatus>`)
      }
      case 'MKCOL':
        if (st) return send(405)
        if (!existsSync(dirname(file))) return send(409)
        mkdirSync(file); return send(201)
      case 'PUT':
        if (!existsSync(dirname(file))) return send(409)
        writeFileSync(file, Buffer.concat(chunks)); return send(201)
      case 'GET': case 'HEAD':
        if (!st || st.isDirectory()) return send(404)
        return send(200, req.method === 'GET' ? readFileSync(file) : '')
      default: return send(405)
    }
  })
})
await new Promise(r => dav.listen(DAV_PORT, r))
mkdirSync(join(root, 'dav'))

// ---- 测试书 ----
const TMP = mkdtempSync(join(tmpdir(), 'lightread-sync-'))
const txtPath = join(TMP, '同步测试.txt')
writeFileSync(txtPath, '第一章 起\n\n' + '同步测试正文。\n'.repeat(200), 'utf-8')

const settings = {
  webdavUrl: `http://127.0.0.1:${DAV_PORT}/dav`,
  webdavUser: 'u',
  webdavPass: 'p',
  webdavSyncAuto: false,
}

const browser = await chromium.launch()
const errors = []
async function device(name) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  await context.addInitScript(s => {
    const raw = localStorage.getItem('lightread-settings')
    if (!raw) localStorage.setItem('lightread-settings', JSON.stringify(s))
  }, settings)
  const page = await context.newPage()
  page.on('pageerror', e => errors.push(`[${name}] ${e.message}`))
  await page.goto(APP + '#/library', { waitUntil: 'networkidle' })
  return page
}

/** 在页面里直接读写 IndexedDB (lightread 库) */
const idb = (page, fn, arg) => page.evaluate(async ([src, a]) => {
  const db = await new Promise((ok, err) => {
    const r = indexedDB.open('lightread')
    r.onsuccess = () => ok(r.result)
    r.onerror = () => err(r.error)
  })
  const run = (store, mode, op) => new Promise((ok, err) => {
    const tx = db.transaction(store, mode)
    const req = op(tx.objectStore(store))
    tx.oncomplete = () => ok(req?.result)
    tx.onerror = () => err(tx.error)
  })
  try {
    // eslint-disable-next-line no-new-func
    return await new Function('run', 'a', `return (${src})(run, a)`)(run, a)
  } finally {
    db.close()
  }
}, [fn.toString(), arg])

const listBooks = page => idb(page, run => run('books', 'readonly', s => s.getAll()))
  .then(rows => rows.map(({ file, cover, ...m }) => m))

async function syncVia(page) {
  await page.goto(APP + '#/settings', { waitUntil: 'networkidle' })
  const btn = page.locator('button.sync-now')
  await btn.click()
  await page.waitForFunction(() => {
    const b = document.querySelector('button.sync-now')
    const s = document.querySelector('.sync-status')?.textContent ?? ''
    return b && !b.disabled && (s.includes('上次同步') || s.length > 0 && document.querySelector('.sync-status.error'))
  }, null, { timeout: 30000 })
  const status = await page.locator('.sync-status').textContent()
  if (await page.locator('.sync-status.error').count()) throw new Error(`同步失败: ${status}`)
  return status
}

let step = 0
const ok = msg => console.log(`✓ ${++step}. ${msg}`)
const assert = (cond, msg) => { if (!cond) throw new Error(msg) }

try {
  const A = await device('A')
  const B = await device('B')

  // 1. A 导入并同步
  await A.setInputFiles('input[type=file][multiple]', txtPath)
  await A.waitForSelector('.book-card', { timeout: 15000 })
  ok('A 导入 TXT')
  const [bookA] = await listBooks(A)
  // A 建书单, 把书放进去
  await idb(A, async (run, a) => {
    await run('booklists', 'readwrite', s => s.put({ id: 'bl-1', name: '同步书单', createdAt: 1, updatedAt: 1 }))
    await run('booklistItems', 'readwrite', s => s.put({ booklistId: 'bl-1', bookId: a, addedAt: 2 }))
  }, bookA.id)
  await syncVia(A)
  const davDir = join(root, 'dav', 'LightRead', 'sync', 'v1')
  const devicesA = readdirSync(join(davDir, 'devices'))
  const filesA = readdirSync(join(davDir, 'files'))
  assert(devicesA.length === 1 && filesA.some(f => /^[0-9a-f]{64}$/.test(f)), `远端布局不对: ${devicesA} / ${filesA}`)
  ok(`A 同步: 远端有 ${devicesA.length} 个设备文档, ${filesA.length} 个文件`)

  // 2. B 同步 → 下载入库, 书单带过来
  await syncVia(B)
  await B.goto(APP + '#/library', { waitUntil: 'networkidle' })
  await B.waitForSelector('.book-card:has-text("同步测试")', { timeout: 10000 })
  const [bookB] = await listBooks(B)
  assert(bookB && bookB.id !== bookA.id, 'B 应有本地新 id 的同一本书')
  const blB = await idb(B, run => run('booklists', 'readonly', s => s.getAll()))
  const itemsB = await idb(B, run => run('booklistItems', 'readonly', s => s.getAll()))
  assert(blB.some(b => b.id === 'bl-1' && b.name === '同步书单'), 'B 未收到书单')
  assert(itemsB.some(i => i.booklistId === 'bl-1' && i.bookId === bookB.id), 'B 书单未包含该书')
  ok('B 同步: 书籍文件下载入库, 书单 (沿用原 id) 与条目到位')

  // 3. B 阅读 (进度 + 时长) → A 收到
  const readAt = Date.now()
  await idb(B, (run, a) => run('books', 'readwrite', s => {
    const r = s.get(a.id)
    r.onsuccess = () => s.put({ ...r.result, location: 'epubcfi(/6/4!/4/2/1:0)', progress: 0.42, lastReadAt: a.readAt, readingSeconds: 120 })
    return r
  }), { id: bookB.id, readAt })
  await syncVia(B)
  await syncVia(A)
  const [bookA2] = await listBooks(A)
  assert(bookA2.progress === 0.42 && bookA2.location === 'epubcfi(/6/4!/4/2/1:0)', `A 进度未更新: ${bookA2.progress} ${bookA2.location}`)
  assert(bookA2.readingSeconds === 120, `A 阅读时长应为 120, 实为 ${bookA2.readingSeconds}`)
  ok('B 的阅读进度与时长同步到 A')

  // 4. 再同步不重复计时
  await syncVia(A)
  await syncVia(B)
  const [bookA3] = await listBooks(A)
  const [bookB3] = await listBooks(B)
  assert(bookA3.readingSeconds === 120 && bookB3.readingSeconds === 120, `重复同步后时长漂移: ${bookA3.readingSeconds} / ${bookB3.readingSeconds}`)
  ok('重复同步幂等, 时长不重复累计')

  // 5. A 删书 → B 删除
  await A.goto(APP + '#/library', { waitUntil: 'networkidle' })
  await idb(A, (run, id) => run('books', 'readwrite', s => s.delete(id)), bookA.id)
  await syncVia(A)
  await syncVia(B)
  assert((await listBooks(B)).length === 0, 'B 未删除该书')
  await B.goto(APP + '#/library', { waitUntil: 'networkidle' })
  await B.waitForSelector('text=书架还是空的', { timeout: 10000 })
  ok('A 删除的书在 B 上同步删除')

  if (errors.length) throw new Error('页面错误:\n' + errors.join('\n'))
  console.log(`\n全部 ${step} 步通过`)
} finally {
  await browser.close()
  dav.close()
  rmSync(root, { recursive: true, force: true })
  rmSync(TMP, { recursive: true, force: true })
}
