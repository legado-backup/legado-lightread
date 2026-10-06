/** Targeted browser coverage. Start Vite on 4175; run with:
 * flock /tmp/heavy.lock nice -n 10 node scripts/e2e-library-upload.mjs
 * Required real Kindle fixtures (never downloaded or silently skipped by this test):
 * E2E_AZW=/tmp/lightread-real.azw E2E_AZW3=/tmp/lightread-real.azw3
 * Gutenberg sources: https://www.gutenberg.org/ebooks/11.kindle.images and 11.kf8.images.
 */
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { zipSync, strToU8 } from 'fflate'
import { readFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'

const base = process.env.E2E_BASE ?? 'http://127.0.0.1:4175'
const tmp = '/tmp/lightread-library-upload'
mkdirSync(tmp, { recursive: true })
const title = '云书库 EPUB 实测'
// Same standards-compliant ZIP/container/package pattern as e2e-epub-compat.mjs.
const epub = Buffer.from(zipSync({
  mimetype: [strToU8('application/epub+zip'), { level: 0 }],
  'META-INF/container.xml': strToU8('<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
  'OEBPS/package.opf': strToU8(`<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">upload-e2e</dc:identifier><dc:title>${title}</dc:title><dc:creator>测试作者</dc:creator><dc:language>zh</dc:language><meta property="dcterms:modified">2026-10-05T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="ch" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="ch"/></spine></package>`),
  'OEBPS/nav.xhtml': strToU8('<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">第一章</a></li></ol></nav></body></html>'),
  'OEBPS/chapter.xhtml': strToU8('<html xmlns="http://www.w3.org/1999/xhtml"><head><title>正文</title></head><body><h1>第一章</h1><p>UPLOAD-E2E-BODY: 真实 EPUB 内容。</p></body></html>'),
}))
// Minimal real PDF, matching the stream/catalog pattern in e2e-smoke.mjs.
const stream = 'BT /F1 24 Tf 100 700 Td (Library Upload PDF) Tj ET'
const pdf = Buffer.from(`%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length ${stream.length} >> stream
${stream}
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
trailer << /Root 1 0 R /Size 6 >>
%%EOF`)
const files = [
  { name: '云端原文.epub', mimeType: 'application/epub+zip', buffer: epub },
  { name: 'upload-document.pdf', mimeType: 'application/pdf', buffer: pdf },
  { name: 'alice.azw', mimeType: 'application/vnd.amazon.ebook', buffer: readFileSync(process.env.E2E_AZW ?? '/tmp/lightread-real.azw') },
  { name: 'alice.azw3', mimeType: 'application/x-mobi8-ebook', buffer: readFileSync(process.env.E2E_AZW3 ?? '/tmp/lightread-real.azw3') },
]
for (const file of files.slice(2)) assert.equal(file.buffer.subarray(60, 68).toString(), 'BOOKMOBI', `${file.name} must be a genuine Kindle/MOBI file`)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const expected = new Map(files.map(f => [f.name, f]))
const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
const page = await context.newPage()
page.setDefaultTimeout(15_000)
const errors = [], requests = [], routeErrors = [], convertedUploads = []
const attempts = new Map()
let releaseUpload, announceUpload
const uploadGate = new Promise(resolve => { releaseUpload = resolve })
const uploadStarted = new Promise(resolve => { announceUpload = resolve })
page.on('pageerror', error => errors.push(error.message))
const auth = `Basic ${Buffer.from('e2e-user:e2e-password').toString('base64')}`
await context.route('https://api.github.com/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tag_name: 'v0.0.0', assets: [] }) }))
await context.route('**/__upload_e2e/**', async route => {
  const req = route.request(), path = new URL(req.url()).pathname
  try {
    assert.equal(req.headers().authorization, auth)
    if (path.endsWith('/readonly')) return await route.fulfill({ contentType: 'application/atom+xml', body: '<feed xmlns="http://www.w3.org/2005/Atom"><title>Read only</title></feed>' })
    if (path.endsWith('/opds')) return await route.fulfill({ contentType: 'application/atom+xml', body: '<feed xmlns="http://www.w3.org/2005/Atom"><id>urn:lightread:upload-e2e</id><title>Private</title><updated>2026-10-05T00:00:00Z</updated><link rel="self" href="opds" type="application/atom+xml;profile=opds-catalog"/><link rel="https://lightread.app/rel/library" href="capabilities"/><link rel="https://lightread.app/rel/upload" href="upload"/></feed>' })
    if (path.endsWith('/capabilities')) return await route.fulfill({ json: { version: 1, uploadUrl: 'upload', formats: ['epub', 'pdf', 'azw', 'azw3'], maxFileBytes: 16 * 1024 * 1024 } })
    assert.ok(path.endsWith('/upload'), `Unexpected path ${path}`)
    assert.equal(req.method(), 'POST')
    const headers = req.headers(), name = decodeURIComponent(headers['x-file-name']), file = expected.get(name)
    if (!file && name.endsWith('.epub')) {
      // 「上传前转换为 EPUB」: 收到的是本机转换出的 EPUB, 不是原文件
      const body = req.postDataBuffer()
      assert.equal(headers['content-type'], 'application/epub+zip')
      assert.equal(body.readUInt32LE(0), 0x04034b50, 'converted upload must be a ZIP')
      assert.equal(body.toString('latin1', 30, 38 + 20), 'mimetypeapplication/epub+zip', 'mimetype must be the first stored entry')
      convertedUploads.push({ name, headers, size: body.length })
      return await route.fulfill({ json: { bookId: hash(body), title: name, format: 'epub', duplicate: false } })
    }
    assert.ok(file, `Unexpected uploaded name ${name}`)
    assert.equal(headers['content-type'], file.mimeType)
    assert.equal(headers.accept, 'application/json')
    assert.equal(hash(req.postDataBuffer()), hash(file.buffer), `Original bytes changed for ${name}`)
    requests.push({ name, headers })
    const count = (attempts.get(name) ?? 0) + 1
    attempts.set(name, count)
    if (requests.length === 1) { announceUpload(); await uploadGate }
    if (name.endsWith('.pdf') && count === 1) return await route.fulfill({ status: 503, body: 'Deliberate E2E failure' })
    return await route.fulfill({ json: { bookId: hash(file.buffer), title: name, format: name.split('.').at(-1), duplicate: name.endsWith('.azw') || count > 1 } })
  } catch (error) {
    routeErrors.push(error.message)
    await route.fulfill({ status: 500, body: error.message })
  }
})
const dialog = page.getByRole('dialog', { name: '添加到私人书库' })
async function openUpload() {
  await page.locator('.import-caret').click()
  await page.getByRole('menuitem', { name: '加入私人云端书库' }).click()
  await dialog.waitFor()
}
async function closeUpload() { await dialog.getByRole('button', { name: '关闭', exact: true }).click() }
async function noOverflow(label) {
  const measurements = await page.evaluate(() => {
    const root = document.documentElement, panel = document.querySelector('.upload-dialog'), body = document.querySelector('.upload-body')
    return { viewport: innerWidth, page: root.scrollWidth, panel: panel?.getBoundingClientRect().toJSON(), bodyClient: body?.clientWidth, bodyScroll: body?.scrollWidth }
  })
  assert.ok(measurements.page <= measurements.viewport + 1, `${label} page overflow: ${JSON.stringify(measurements)}`)
  if (measurements.panel) {
    assert.ok(measurements.panel.left >= 0 && measurements.panel.right <= measurements.viewport + 1, `${label} dialog outside viewport`)
    assert.ok(measurements.bodyScroll <= measurements.bodyClient + 1, `${label} dialog horizontal overflow`)
  }
  await page.screenshot({ path: `${tmp}/${label}.png`, fullPage: true })
}
try {
  await page.goto(`${base}/#/library`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: '新建书单', exact: true }).click()
  await page.getByPlaceholder('例如：2026 阅读计划').fill('上传实测书单')
  await page.getByRole('button', { name: '创建书单', exact: true }).click()
  await page.setInputFiles('input[type=file][multiple]', files)
  await page.waitForFunction(() => document.querySelectorAll('.book-card').length === 4, null, { timeout: 45_000 })
  const seeded = await page.evaluate(async () => {
    const storage = await (await import('/src/storage/index.ts')).getStorage()
    const books = await storage.listBooks(), lists = await storage.listBooklists()
    const list = lists.find(x => x.name === '上传实测书单')
    const members = await storage.listBooklistBookIds(list.id)
    const epub = books.find(x => x.format === 'epub')
    await storage.updateBook(epub.id, { pinnedAt: Date.now() })
    const addSource = (title, path) => storage.addSource({ title, url: `${location.origin}/__upload_e2e/${path}`, kind: 'opds', builtin: false, addedAt: Date.now(), username: 'e2e-user', password: 'e2e-password' })
    return { books, members, listId: list.id, writableId: await addSource('实测私人书库', 'opds'), readonlyId: await addSource('只读测试书源', 'readonly') }
  })
  assert.deepEqual(seeded.books.map(b => b.format).sort(), ['azw', 'azw3', 'epub', 'pdf'])
  assert.equal(seeded.members.length, 4, 'Imports must be added to the active booklist')
  assert.ok(seeded.books.filter(b => b.format.startsWith('azw')).every(b => /Alice/i.test(b.title)), 'Kindle metadata must be parsed')
  console.log('PASS real EPUB/PDF/AZW/AZW3 imports and active booklist membership')
  await noOverflow('desktop-library')

  await openUpload()
  await dialog.locator('.upload-field select').selectOption(seeded.writableId)
  await dialog.locator('.upload-device input').waitFor({ state: 'attached' })
  // 这一轮校验原文件字节: 关掉默认开启的「上传前转换为 EPUB」
  const convertBox = dialog.getByRole('checkbox', { name: /上传前转换为 EPUB/ })
  assert.equal(await convertBox.isChecked(), true, 'Convert-before-upload must default to on')
  await convertBox.uncheck()
  await dialog.locator('input[type=file]').setInputFiles(files)
  // Picking the exact same File objects twice must not duplicate pending queue entries.
  await page.evaluate(() => {
    const picker = document.querySelector('.upload-device input')
    const data = new DataTransfer()
    const file = new File(['same'], 'same.epub', { lastModified: 123 })
    data.items.add(file)
    for (let i = 0; i < 2; i++) { picker.files = data.files; picker.dispatchEvent(new Event('change', { bubbles: true })) }
  })
  assert.equal(await dialog.locator('.upload-queue li').count(), 5)
  await dialog.getByRole('button', { name: '移除 same.epub', exact: true }).click()
  assert.equal(await dialog.locator('.upload-queue li').count(), 4)
  await noOverflow('desktop-upload')
  await dialog.getByRole('button', { name: '开始上传（4）', exact: true }).click()
  await Promise.race([uploadStarted, new Promise((_, reject) => { const timeout = setTimeout(() => reject(new Error('First upload did not start')), 15000); timeout.unref() })])
  const guarded = await page.evaluate(async () => {
    const { router } = await import('/src/router/index.ts')
    const before = router.currentRoute.value.fullPath
    await router.push('/settings')
    const afterLeave = router.currentRoute.value.fullPath
    await router.push('/library?upload-e2e=changed')
    return { before, afterLeave, afterUpdate: router.currentRoute.value.fullPath }
  })
  assert.equal(guarded.afterLeave, guarded.before, 'Busy upload must block route leave')
  assert.equal(guarded.afterUpdate, guarded.before, 'Busy upload must block route update')
  assert.equal(await dialog.isVisible(), true)
  assert.equal(await dialog.getByRole('button', { name: '关闭', exact: true }).isDisabled(), true)
  releaseUpload()
  console.log('PASS busy upload blocks route leave/update and closing')
  await dialog.locator('.upload-footer').getByRole('button', { name: '重试失败（1）', exact: true }).waitFor()
  await page.waitForFunction(() => document.querySelector('.upload-dialog')?.getAttribute('aria-busy') === 'false')
  assert.equal(requests.length, 4, 'A failing PDF must not stop subsequent AZW uploads')
  assert.equal(await dialog.locator('.upload-success').count(), 3)
  assert.match(await dialog.locator('.upload-queue').innerText(), /书库已有，已跳过/)
  assert.equal(routeErrors.length, 0, routeErrors.join('\n'))
  await dialog.getByRole('button', { name: '重试失败（1）', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.upload-queue .upload-success').length === 4)
  assert.equal(requests.length, 5)
  assert.equal(attempts.get('upload-document.pdf'), 2)
  console.log('PASS multi-file original bytes, MIME/auth/name headers, dedupe, partial failure and retry')
  await closeUpload()

  await openUpload()
  await dialog.locator('.upload-field select').selectOption(seeded.writableId)
  await dialog.getByRole('button', { name: '从我的藏书选择', exact: true }).click()
  await dialog.getByRole('combobox', { name: '全部藏书', exact: true }).selectOption(seeded.listId)
  assert.equal(await dialog.locator('.upload-book').count(), 4)
  await dialog.getByRole('checkbox', { name: '只看置顶', exact: true }).check()
  assert.equal(await dialog.locator('.upload-book').count(), 1)
  assert.match(await dialog.locator('.upload-book').innerText(), new RegExp(title))
  await dialog.getByRole('button', { name: '选择当前结果', exact: true }).click()
  await dialog.getByRole('button', { name: '加入上传列表（1）', exact: true }).click()
  await dialog.getByRole('button', { name: '开始上传（1）', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.upload-queue .upload-success').length === 1)
  assert.equal(requests.length, 6)
  assert.equal(decodeURIComponent(requests.at(-1).headers['x-book-title']), title)
  assert.equal(decodeURIComponent(requests.at(-1).headers['x-book-author']), '测试作者')
  await page.setViewportSize({ width: 390, height: 844 })
  await noOverflow('mobile-existing-upload')
  await closeUpload()
  await noOverflow('mobile-library')
  await page.getByPlaceholder('搜索书名 / 作者 / 标签').fill(title)
  await page.waitForFunction(() => document.querySelectorAll('.book-card').length === 1)
  await page.getByRole('button', { name: '将此书单加入云端', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.upload-queue li').length === 4)
  await closeUpload()
  await page.getByPlaceholder('搜索书名 / 作者 / 标签').fill('')
  console.log('PASS entire-booklist shortcut ignores the current search filter')
  console.log('PASS existing-book booklist/pinned filters, stored original bytes, metadata headers and responsive layout')

  await openUpload()
  await dialog.locator('.upload-field select').selectOption(seeded.readonlyId)
  await dialog.getByRole('alert').filter({ hasText: '这个书库暂不支持从轻阅上传' }).waitFor()
  assert.equal(await dialog.locator('input[type=file]').count(), 0)
  assert.equal(await dialog.getByRole('button', { name: '开始上传（0）', exact: true }).isDisabled(), true)
  assert.equal(requests.length, 6, 'Read-only catalog must not receive uploads')
  await noOverflow('mobile-readonly')
  await closeUpload()
  const epubCard = page.locator('.book-card').filter({ hasText: title })
  await page.setViewportSize({ width: 1280, height: 900 })
  await epubCard.hover()
  await epubCard.getByRole('button', { name: '加入私人云端书库', exact: true }).click()
  await dialog.locator('.upload-queue li').waitFor()
  assert.equal(await dialog.locator('.upload-queue li').count(), 1)
  assert.match(await dialog.locator('.upload-queue li').innerText(), new RegExp(title))
  await dialog.locator('.upload-field select').selectOption(seeded.writableId)
  assert.equal(await dialog.locator('.upload-tabs button.active').innerText(), '从我的藏书选择')
  await closeUpload()
  console.log('PASS BookCard cloud action preselects exactly the selected book')

  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(async () => { await (await import('/src/router/index.ts')).router.push('/catalogs') })
  const sourceCard = page.locator('.source-card').filter({ hasText: '实测私人书库' })
  await sourceCard.waitFor()
  await sourceCard.getByRole('button', { name: '添加书籍', exact: true }).click()
  await dialog.locator('.upload-device input').waitFor({ state: 'attached' })
  assert.equal(await dialog.locator('.upload-field strong').innerText(), '实测私人书库')
  assert.equal(await dialog.locator('.upload-field select').count(), 0)
  assert.equal(await dialog.locator('.upload-url').innerText(), `${base}/__upload_e2e/opds`)
  await noOverflow('mobile-catalog-card-upload')
  await closeUpload()
  // Clicking the source itself navigates into its OPDS directory.
  await sourceCard.locator('.source-title').click()
  await page.locator('.crumb.current').waitFor()
  await page.waitForFunction(() => !document.querySelector('.empty[aria-busy="true"]'))
  assert.equal(await page.locator('.empty-icon.danger').count(), 0, 'OPDS directory must load successfully')
  await page.locator('header.toolbar').getByRole('button', { name: '添加书籍', exact: true }).click()
  await dialog.locator('.upload-device input').waitFor({ state: 'attached' })
  assert.equal(await dialog.locator('.upload-field strong').innerText(), '实测私人书库')
  assert.equal(await dialog.locator('.upload-field select').count(), 0)
  assert.equal(await dialog.locator('.upload-url').innerText(), `${base}/__upload_e2e/opds`)
  await noOverflow('mobile-catalog-directory-upload')
  console.log('PASS Catalog card and OPDS directory upload entries preset the correct destination')
  await closeUpload()

  // 默认开启「上传前转换为 EPUB」: AZW3 先在本机转成 EPUB 再上传
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.evaluate(async () => { await (await import('/src/router/index.ts')).router.push('/library') })
  await openUpload()
  await dialog.locator('.upload-field select').selectOption(seeded.writableId)
  await dialog.locator('.upload-device input').waitFor({ state: 'attached' })
  assert.equal(await dialog.getByRole('checkbox', { name: /上传前转换为 EPUB/ }).isChecked(), true)
  assert.match(await dialog.locator('.upload-device input').getAttribute('accept'), /\.fb2/, 'Convertible formats become selectable')
  await dialog.locator('input[type=file]').setInputFiles([files[3]])
  await dialog.getByRole('button', { name: '开始上传（1）', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.upload-queue .upload-success').length === 1, null, { timeout: 60_000 })
  assert.equal(convertedUploads.length, 1)
  assert.equal(convertedUploads[0].name, 'alice.epub')
  assert.match(decodeURIComponent(convertedUploads[0].headers['x-book-title']), /Alice/)
  await page.screenshot({ path: `${tmp}/desktop-convert-upload.png` })
  console.log('PASS convert-before-upload sends a valid EPUB instead of the AZW3 original')
  assert.deepEqual(routeErrors, [])
  assert.deepEqual(errors, [])
  console.log(`PASS read-only OPDS refusal; all assertions passed; screenshots: ${tmp}`)
} catch (error) {
  await page.screenshot({ path: `${tmp}/failure.png`, fullPage: true }).catch(() => {})
  console.error('FAIL', error)
  console.error('Page errors:', errors, 'Route errors:', routeErrors)
  process.exitCode = 1
} finally { releaseUpload(); await browser.close() }
