/** Run after starting the built app at localhost:4173. No external fixture downloads. */
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { zipSync, strToU8 } from 'fflate'

const base = 'http://localhost:4173'
const title = 'EPUB Compatibility Fixture'
const chapterText = 'EPUB-COMPAT-BODY: 旧版 WebView 也能读取正文。'
const epub = zipSync({
  mimetype: [strToU8('application/epub+zip'), { level: 0 }],
  'META-INF/container.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
    <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
      <rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles>
    </container>`),
  'OEBPS/package.opf': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
    <package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="zh">
      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
        <dc:identifier id="book-id">urn:uuid:lightread-epub-compat</dc:identifier>
        <dc:title id="title">${title}</dc:title>
        <dc:creator id="author">Compatibility Author</dc:creator>
        <dc:language>zh</dc:language>
        <meta property="dcterms:modified">2026-10-03T00:00:00Z</meta>
        <meta refines="#title" property="title-type">main</meta>
        <meta refines="#author" property="role" scheme="marc:relators">aut</meta>
      </metadata>
      <manifest>
        <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
        <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>
      </manifest>
      <spine><itemref idref="chapter"/></spine>
    </package>`),
  'OEBPS/nav.xhtml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
    <html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh">
      <head><title>Contents</title></head>
      <body><nav epub:type="toc"><h1>Contents</h1><ol><li><a href="chapter.xhtml">兼容章节</a></li></ol></nav></body>
    </html>`),
  'OEBPS/chapter.xhtml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
    <html xmlns="http://www.w3.org/1999/xhtml" lang="zh">
      <head><title>兼容章节</title></head>
      <body><h1>兼容章节</h1><p>${chapterText}</p></body>
    </html>`),
  // Exceed foliate's extended ZIP tail scan so the provider scenario needs random reads.
  'OEBPS/padding.bin': [new Uint8Array(1_100_000), { level: 0 }],
})

const browser = await chromium.launch({ headless: true })
try {
  for (const simulateProvider of [false, true]) {
    const context = await browser.newContext({ viewport: { width: 1100, height: 800 }, serviceWorkers: 'block' })
    try {
      await context.route('https://api.github.com/repos/yzfly/LightRead/releases/latest', route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ tag_name: 'v0.0.0', body: '', published_at: '2026-01-01', assets: [] }),
      }))
      await context.addInitScript(({ simulateProvider }) => {
        delete Object.groupBy
        delete Map.groupBy
        window.__epubCompatMissingAtStartup = typeof Object.groupBy === 'undefined' && typeof Map.groupBy === 'undefined'
        window.__epubCompatBadSlices = 0
        if (!simulateProvider) return
        const providerFiles = new WeakSet()
        document.addEventListener('change', event => {
          if (event.target instanceof HTMLInputElement && event.target.type === 'file') {
            for (const file of event.target.files ?? []) providerFiles.add(file)
          }
        }, true)
        const slice = File.prototype.slice
        File.prototype.slice = function (start, end, type) {
          // Keep the ZIP magic check intact; break the selected provider's directory reads.
          // The fallback's new in-memory File is deliberately not in this WeakSet.
          if (providerFiles.has(this) && !(start === 0 && end === 4)) {
            window.__epubCompatBadSlices++
            return new Blob([new Uint8Array(Math.max(0, (end ?? this.size) - (start ?? 0)))], { type })
          }
          return slice.call(this, start, end, type)
        }
      }, { simulateProvider })

      const page = await context.newPage()
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      await page.goto(`${base}/#/library`, { waitUntil: 'networkidle' })
      assert.equal(await page.evaluate(() => window.__epubCompatMissingAtStartup), true)
      assert.deepEqual(await page.evaluate(() => [typeof Object.groupBy, typeof Map.groupBy]), ['function', 'function'])

      await page.setInputFiles('input[type="file"][multiple]', {
        name: simulateProvider ? 'provider-file.epub' : 'legacy-webview.epub',
        mimeType: 'application/epub+zip',
        buffer: Buffer.from(epub),
      })
      const card = page.locator('.book-card').filter({ hasText: title })
      await card.waitFor({ state: 'visible', timeout: 15_000 })
      assert.match(await card.innerText(), /Compatibility Author/)
      if (simulateProvider) assert.ok(await page.evaluate(() => window.__epubCompatBadSlices > 0))
      await card.click()
      await page.waitForSelector('foliate-view', { timeout: 15_000 })
      await page.waitForFunction(expected => {
        const view = document.querySelector('foliate-view')
        return view?.renderer?.getContents?.().some(({ doc }) => doc?.body?.textContent?.includes(expected))
      }, chapterText, { timeout: 15_000 })
      assert.equal(await page.evaluate(() => document.querySelector('foliate-view')?.book?.metadata?.title), title)
      assert.deepEqual(errors, [], `Unhandled errors: ${errors.join('; ')}`)
      console.log(`PASS EPUB import and reading with missing groupBy APIs${simulateProvider ? ' and broken provider slices' : ''}`)
    } finally {
      await context.close()
    }
  }
} finally {
  await browser.close()
}
