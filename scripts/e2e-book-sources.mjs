// Catalog integration: public search, lazy formats, browser fallback, import, failures.
import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const errors = []
let failArchive = false
let metadataCalls = 0
let githubTreeCalls = 0
page.on('pageerror', error => errors.push(error.message))
await page.addInitScript(() => {
  window.__openedBooks = []
  window.open = url => { window.__openedBooks.push(url); return null }
})
await page.route('**/*', async route => {
  const requestUrl = route.request().url()
  if (requestUrl.startsWith('http://localhost:4173/')) return route.continue()
  const parsed = new URL(requestUrl)
  const url = parsed.hostname === 'catalog-proxy.test' ? parsed.searchParams.get('url') : requestUrl
  const json = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
  if (url.includes('api.github.com/repos/') && url.includes('/git/trees/')) {
    githubTreeCalls++
    return json({ tree: [{ type: 'blob', path: '陋室 /?&铭.txt', size: 2048 }], truncated: false })
  }
  if (url.includes('zh.wikisource.org/w/api.php')) return json({ query: { search: [{ pageid: 123, ns: 0, title: '陋室銘', snippet: '山不在高，有仙则名。' }] } })
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
  return route.abort()
})
try {
  await page.goto('http://localhost:4173/#/catalogs')
  const search = page.getByRole('searchbox', { name: '统一搜书' })
  assert.equal(await page.getByRole('checkbox', { name: 'GitHub', exact: true }).isChecked(), true)
  await search.fill('陋室 /?&铭')
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await page.getByText('陋室銘', { exact: true }).waitFor()
  await page.getByText('Public Archive Book', { exact: true }).waitFor()
  await page.getByText('?&铭.txt', { exact: true }).first().waitFor()
  assert.ok(githubTreeCalls > 0, 'default search must query GitHub book repositories')
  assert.equal(metadataCalls, 0, 'search must not fetch each item')
  await page.getByRole('button', { name: '浏览器下载 EPUB' }).click()
  assert.match((await page.evaluate(() => window.__openedBooks)).at(-1), /^https:\/\/ws-export\.wmcloud\.org\//)
  await page.getByRole('button', { name: '查看下载格式' }).click()
  await page.getByRole('button', { name: '浏览器下载 TXT' }).waitFor()
  assert.equal(metadataCalls, 1)
  assert.equal(await page.getByRole('button', { name: '浏览器下载 PDF' }).count(), 0)
  await page.locator('.web-source-card').filter({ hasText: 'Z-Library' }).getByRole('button').click()
  assert.equal((await page.evaluate(() => window.__openedBooks)).at(-1), 'https://z-library.sk/s/' + encodeURIComponent('陋室 /?&铭'))
  await page.getByRole('checkbox', { name: 'Open Library', exact: true }).check()
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await page.getByText('Borrowable Book', { exact: true }).waitFor()
  await page.getByText(/借阅需登录/).waitFor()
  // One source fails; other providers still render results.
  failArchive = true
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await page.locator('.gh-notice').filter({ hasText: 'Internet Archive' }).waitFor()
  await page.getByText('陋室銘', { exact: true }).waitFor()
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
  await page.getByText(/成功导入 1 本|已导入 1 本/).waitFor({ timeout: 15000 })
  await page.goto('http://localhost:4173/#/library')
  await page.getByText('Public Archive Book', { exact: true }).waitFor()
  await page.goto('http://localhost:4173/#/catalogs')
  await page.setViewportSize({ width: 375, height: 812 })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'mobile catalog should not overflow')
  for (const box of await page.locator('.uni-scopes input').all()) await box.uncheck()
  await page.getByText('请至少选择一个搜索来源。').waitFor()
  assert.equal(await page.getByRole('button', { name: '搜索', exact: true }).isDisabled(), true)
  assert.deepEqual(errors, [])
  console.log('PASS: public catalog search, lazy downloads, browser fallback, import, partial failure, mobile layout')
} finally {
  await browser.close()
}
