// 轻阅账号同步端到端: 本地 wrangler 起 sync-server (DEV_EXPOSE_CODE=1, 验证码随响应返回),
// 两个浏览器上下文模拟两台设备, 走设置页真实的邮箱验证码登录.
// 前置: npm run build && npx vite preview --port 4173 --strictPort &
// 覆盖: A 导入并登录 → 同步 → B 登录只拿到记录 (不含文件) → B 导入同一本书自动匹配进度 → 退出登录
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'

const APP = 'http://localhost:4173/'
const API_PORT = 8788
const API = `http://127.0.0.1:${API_PORT}`
const persist = mkdtempSync(join(tmpdir(), 'lightread-sync-api-'))
const wranglerArgs = ['-c', 'sync-server/wrangler.jsonc', '--persist-to', persist]

execFileSync('npx', ['wrangler', 'd1', 'execute', 'lightread-sync', '--local', ...wranglerArgs,
  '--file', 'sync-server/schema.sql'], { stdio: 'ignore' })
const server = spawn('npx', ['wrangler', 'dev', ...wranglerArgs, '--port', String(API_PORT),
  '--ip', '127.0.0.1', '--var', 'DEV_EXPOSE_CODE:1'], { stdio: 'ignore', detached: true })
for (let i = 0; ; i++) {
  try { if ((await fetch(`${API}/health`)).ok) break } catch { /* 未就绪 */ }
  if (i > 120) throw new Error('本地同步服务启动超时')
  await new Promise(r => setTimeout(r, 500))
}

const TMP = mkdtempSync(join(tmpdir(), 'lightread-account-'))
const txtPath = join(TMP, '账号同步.txt')
writeFileSync(txtPath, '第一章 起\n\n' + '账号同步正文。\n'.repeat(200), 'utf-8')
const EMAIL = `e2e-${Date.now()}@example.com`

const browser = await chromium.launch()
const errors = []
async function device(name) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  await context.addInitScript(api => localStorage.setItem('lightread-sync-api', api), API)
  const page = await context.newPage()
  page.on('pageerror', e => errors.push(`[${name}] ${e.message}`))
  await page.goto(APP + '#/library', { waitUntil: 'networkidle' })
  return page
}

const listBooks = page => page.evaluate(() => new Promise((ok, err) => {
  const r = indexedDB.open('lightread')
  r.onerror = () => err(r.error)
  r.onsuccess = () => {
    const req = r.result.transaction('books').objectStore('books').getAll()
    req.onsuccess = () => { ok(req.result.map(({ file, cover, ...m }) => m)); r.result.close() }
  }
}))

async function login(page) {
  await page.goto(APP + '#/settings', { waitUntil: 'networkidle' })
  await page.getByRole('textbox', { name: /邮箱/ }).fill(EMAIL)
  const codeRes = page.waitForResponse(r => r.url().endsWith('/v1/auth/code'))
  await page.getByRole('button', { name: '发送验证码' }).click()
  const { devCode } = await (await codeRes).json()
  await page.getByRole('textbox', { name: /验证码/ }).fill(devCode)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.waitForSelector(`text=${EMAIL}`, { timeout: 10000 })
}

async function waitSynced(page) {
  await page.waitForFunction(() => {
    const b = document.querySelector('button.sync-now')
    const s = document.querySelector('.sync-status')?.textContent ?? ''
    return b && !b.disabled && (s.includes('上次同步') || document.querySelector('.sync-status.error'))
  }, null, { timeout: 30000 })
  if (await page.locator('.sync-status.error').count()) {
    throw new Error(`同步失败: ${await page.locator('.sync-status').textContent()}`)
  }
}
async function syncVia(page) {
  await page.goto(APP + '#/settings', { waitUntil: 'networkidle' })
  await page.locator('button.sync-now').click()
  await waitSynced(page)
}

let step = 0
const ok = msg => console.log(`✓ ${++step}. ${msg}`)
const assert = (cond, msg) => { if (!cond) throw new Error(msg) }

try {
  const A = await device('A')
  const B = await device('B')

  await A.setInputFiles('input[type=file][multiple]', txtPath)
  await A.waitForSelector('.book-card', { timeout: 15000 })
  const [bookA] = await listBooks(A)
  await A.evaluate(id => new Promise(ok => {
    const r = indexedDB.open('lightread')
    r.onsuccess = () => {
      const s = r.result.transaction('books', 'readwrite').objectStore('books')
      const g = s.get(id)
      g.onsuccess = () => { s.put({ ...g.result, progress: 0.66, location: 'epubcfi(/6/8!/4/2/1:0)', lastReadAt: Date.now(), readingSeconds: 90 }).onsuccess = () => { r.result.close(); ok() } }
    }
  }), bookA.id)
  ok('A 导入并读到 66%')

  await login(A)
  await waitSynced(A)
  assert(await A.getByRole('switch', { name: /自动同步/ }).isChecked(), '登录后应自动打开自动同步')
  ok('A 用邮箱验证码登录, 自动同步已打开, 首次同步完成')

  await login(B)
  await waitSynced(B)
  assert((await listBooks(B)).length === 0, '账号不存书籍文件, B 不应直接出现这本书')
  ok('B 登录同步: 只拿到记录, 不下载书籍文件')

  await B.goto(APP + '#/library', { waitUntil: 'networkidle' })
  await B.setInputFiles('input[type=file][multiple]', txtPath)
  await B.waitForSelector('.book-card', { timeout: 15000 })
  await syncVia(B)
  const [bookB] = await listBooks(B)
  assert(bookB.progress === 0.66 && bookB.location === 'epubcfi(/6/8!/4/2/1:0)', `B 导入后未匹配进度: ${bookB.progress}`)
  assert(bookB.readingSeconds === 90, `B 阅读时长应为 90, 实为 ${bookB.readingSeconds}`)
  ok('B 导入同一本书 → 按内容指纹自动匹配进度与时长')

  const devices = await fetch(`${API}/v1/docs`, {
    headers: { authorization: `Bearer ${await B.evaluate(() => JSON.parse(localStorage.getItem('lightread-account')).token)}` },
  }).then(r => r.json())
  assert(devices.docs.length === 2, `服务端应有 2 台设备的文档, 实为 ${devices.docs.length}`)
  ok('服务端保存了两台设备的同步文档')

  await B.goto(APP + '#/settings', { waitUntil: 'networkidle' })
  await B.getByRole('button', { name: '退出登录' }).click()
  await B.waitForSelector('button:has-text("发送验证码")', { timeout: 10000 })
  assert(!(await B.evaluate(() => localStorage.getItem('lightread-account'))), '退出后本地仍有登录态')
  ok('B 退出登录')

  if (errors.length) throw new Error('页面错误:\n' + errors.join('\n'))
  console.log(`\n全部 ${step} 步通过`)
} finally {
  await browser.close()
  try { process.kill(-server.pid) } catch { /* 已退出 */ }
  rmSync(persist, { recursive: true, force: true })
  rmSync(TMP, { recursive: true, force: true })
}
