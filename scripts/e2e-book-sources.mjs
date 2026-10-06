// Catalog integration: public search, lazy formats, browser fallback, import, failures.
// Run after building and starting the preview (default http://localhost:4173, override with E2E_BASE).
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { strToU8, zipSync } from 'fflate'

const base = process.env.E2E_BASE ?? 'http://localhost:4173'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const errors = []
let failArchive = false
let metadataCalls = 0
let githubTreeCalls = 0
const philosophyDownloads = []

/** 最小可导入 EPUB (Early Modern Texts 给 EPUB 标 text/html, 这里统一照样模拟) */
function epubBytes(title) {
  return zipSync({
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8('<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    'content.opf': strToU8(`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">${title}</dc:identifier><dc:title>${title}</dc:title><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`),
    'nav.xhtml': strToU8('<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>nav</title></head><body><nav epub:type="toc"><ol><li><a href="c1.xhtml">One</a></li></ol></nav></body></html>'),
    'c1.xhtml': strToU8(`<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head><body><h1>${title}</h1><p>Philosophy text.</p></body></html>`),
  }, { level: 0 })
}

page.on('pageerror', error => errors.push(error.message))
await page.addInitScript(() => {
  window.__openedBooks = []
  window.open = url => { window.__openedBooks.push(url); return null }
})
await page.route('**/*', async route => {
  const requestUrl = route.request().url()
  if (requestUrl.startsWith(base + '/')) return route.continue()
  const parsed = new URL(requestUrl)
  const url = parsed.hostname === 'catalog-proxy.test' ? parsed.searchParams.get('url') : requestUrl
  const json = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
  if (url.includes('api.github.com/repos/') && url.includes('/git/trees/')) {
    githubTreeCalls++
    return json({ tree: [{ type: 'blob', path: '陋室 /?&铭.txt', size: 2048 }], truncated: false })
  }
  if (url.includes('archive.org/advancedsearch.php')) {
    if (failArchive) return route.fulfill({ status: 503, body: 'Unavailable' })
    return json({ response: { docs: [{ identifier: 'public-book', title: 'Public Archive Book', creator: 'Author' }] } })
  }
  if (url.includes('archive.org/metadata/')) {
    metadataCalls++
    return json({ metadata: { title: 'Public Archive Book', creator: 'Author' }, files: [{ name: 'book.txt', format: 'Text', source: 'original' }, { name: 'locked.pdf', private: 'true' }] })
  }
  if (url.includes('archive.org/download/')) return route.fulfill({ contentType: 'text/plain', body: '第一章 公开图书\n\n可免费阅读的内容。\n'.repeat(20) })
  if (url.includes('openlibrary.org/search.json')) return json({ docs: [{ key: '/works/OL1W', title: 'Borrowable Book', author_name: ['Author'], ebook_access: 'borrowable' }] })
  if (url.includes('gutenberg.org/')) return route.fulfill({ contentType: 'application/atom+xml', body: '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><id>empty</id><title>Gutenberg</title></feed>' })
  // 哲学文库: 搜索在本地索引里完成, 只有下载才访问原站
  if (url.startsWith('https://standardebooks.org/ebooks/') || url.startsWith('https://www.marxists.org/ebooks/')) {
    philosophyDownloads.push({ url, proxied: parsed.hostname === 'catalog-proxy.test' })
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: Buffer.from(epubBytes(url.includes('hegel') ? "Hegel's Logic" : 'An Enquiry Concerning Human Understanding')) })
  }
  return route.abort()
})
try {
  await page.goto(base + '/#/catalogs')
  const search = page.getByRole('searchbox', { name: '统一搜书' })
  assert.equal(await page.getByRole('checkbox', { name: 'GitHub', exact: true }).isChecked(), true)
  assert.equal(await page.getByRole('checkbox', { name: '哲学文库', exact: true }).isChecked(), true, '哲学文库 is a default source')
  assert.equal(await page.getByText('维基文库').count(), 0, 'Wikisource has been removed')
  await search.fill('陋室 /?&铭')
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await page.getByText('Public Archive Book', { exact: true }).waitFor()
  await page.getByText('?&铭.txt', { exact: true }).first().waitFor()
  assert.ok(githubTreeCalls > 0, 'default search must query GitHub book repositories')
  assert.equal(metadataCalls, 0, 'search must not fetch each item')
  await page.getByText(/未找到：.*哲学文库/).waitFor()
  await page.getByRole('button', { name: '查看下载格式' }).click()
  await page.getByRole('button', { name: '浏览器下载 TXT' }).waitFor()
  assert.equal(metadataCalls, 1)
  assert.equal(await page.getByRole('button', { name: '浏览器下载 PDF' }).count(), 0)
  await page.locator('.web-source-card').filter({ hasText: 'Z-Library' }).getByRole('button').click()
  assert.equal((await page.evaluate(() => window.__openedBooks)).at(-1), 'https://z-library.sk/s/' + encodeURIComponent('陋室 /?&铭'))

  // 哲学文库: 本地索引, 繁体/书名号也能命中; marxists.org 无跨域许可, 网页版走浏览器下载
  await search.fill('《共產黨宣言》')
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  const philosophy = page.locator('.uni-group').filter({ hasText: '哲学文库 ·' })
  await philosophy.getByText('共产党宣言', { exact: true }).first().waitFor()
  await philosophy.locator('.gh-item').first().getByRole('button', { name: '查看原站' }).click()
  assert.match((await page.evaluate(() => window.__openedBooks)).at(-1), /^https:\/\/www\.marxists\.org\/chinese\//)
  await search.fill("hegel's logic")
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  const hegel = philosophy.locator('.gh-item').filter({ hasText: "Hegel's Logic" }).first()
  await hegel.getByRole('button', { name: '浏览器下载 EPUB' }).click()
  assert.equal((await page.evaluate(() => window.__openedBooks)).at(-1), 'https://www.marxists.org/ebooks/hegel/hegels-logic.epub')
  // Standard Ebooks 允许跨域: 网页版无代理也直接导入; Early Modern Texts 跨域头不稳定, 走浏览器下载
  await search.fill('an enquiry concerning human understanding')
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  const hume = philosophy.locator('.gh-item').filter({ hasText: 'An Enquiry Concerning Human Understanding' })
  await hume.filter({ hasText: 'Early Modern Texts' }).first().getByRole('button', { name: '浏览器下载 EPUB' }).click()
  assert.match((await page.evaluate(() => window.__openedBooks)).at(-1), /^https:\/\/www\.earlymoderntexts\.com\/assets\/mobile\/hume\d+\.epub$/)
  await hume.filter({ hasText: 'Standard Ebooks' }).first().getByRole('button', { name: '下载 EPUB', exact: true }).click()
  await page.getByText(/成功导入 1 本|已导入 1 本/).first().waitFor({ timeout: 15000 })
  assert.deepEqual(philosophyDownloads.map(d => d.proxied), [false])
  assert.match(philosophyDownloads[0].url, /^https:\/\/standardebooks\.org\/ebooks\/david-hume\/an-enquiry-concerning-human-understanding\/downloads\/.+\.epub\?source=download$/)

  await search.fill('陋室 /?&铭')
  await page.getByRole('checkbox', { name: 'Open Library', exact: true }).check()
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await page.getByText('Borrowable Book', { exact: true }).waitFor()
  await page.getByText(/借阅需登录/).waitFor()
  // One source fails; other providers still render results.
  failArchive = true
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await page.locator('.gh-notice').filter({ hasText: 'Internet Archive' }).waitFor()
  await page.getByText('?&铭.txt', { exact: true }).first().waitFor()
  failArchive = false
  // With the existing CORS proxy configured, download/import stays in the app.
  await page.evaluate(() => {
    const settings = JSON.parse(localStorage.getItem('lightread-settings') || '{}')
    settings.corsProxy = 'https://catalog-proxy.test/?url={url}'
    localStorage.setItem('lightread-settings', JSON.stringify(settings))
  })
  await page.reload()
  await search.fill('public')
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await page.getByRole('button', { name: '查看下载格式' }).click()
  await page.getByRole('button', { name: '下载 TXT', exact: true }).click()
  await page.getByText(/成功导入 1 本|已导入 1 本/).first().waitFor({ timeout: 15000 })
  // marxists.org 经代理下载并导入
  await search.fill("Hegel's Logic")
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await page.locator('.uni-group').filter({ hasText: '哲学文库 ·' }).locator('.gh-item').filter({ hasText: "Hegel's Logic" }).first()
    .getByRole('button', { name: '下载 EPUB', exact: true }).click()
  await page.waitForFunction(() => document.body.innerText.match(/成功导入 1 本|已导入 1 本/g)?.length >= 1)
  await page.waitForTimeout(500)
  assert.ok(philosophyDownloads.some(d => d.proxied && d.url === 'https://www.marxists.org/ebooks/hegel/hegels-logic.epub'), 'marxists.org download goes through the configured proxy')
  await page.goto(base + '/#/library')
  await page.getByText('Public Archive Book', { exact: true }).waitFor()
  await page.getByText('An Enquiry Concerning Human Understanding', { exact: true }).first().waitFor()
  await page.getByText("Hegel's Logic", { exact: true }).first().waitFor()
  await page.goto(base + '/#/catalogs')
  await page.setViewportSize({ width: 375, height: 812 })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'mobile catalog should not overflow')
  for (const box of await page.locator('.uni-scopes input').all()) await box.uncheck()
  await page.getByText('请至少选择一个搜索来源。').waitFor()
  assert.equal(await page.getByRole('button', { name: '搜索', exact: true }).isDisabled(), true)
  assert.deepEqual(errors, [])
  console.log('PASS: public catalog search, 哲学文库 local index + downloads, lazy formats, browser fallback, import, partial failure, mobile layout')
} finally {
  await browser.close()
}
