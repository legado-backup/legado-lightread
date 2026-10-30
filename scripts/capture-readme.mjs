// README screenshots of the real app, in a disposable browser with original demo content.
// Start: TAURI_ENV_PLATFORM=linux npm run dev -- --host 127.0.0.1
// Run: node scripts/capture-readme.mjs (requires Playwright Chromium).
// Translation responses and reading history are fixtures, not a live AI benchmark.
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'
import { paper, seedDemoLibrary } from './readme-demo.mjs'

const base = process.env.E2E_BASE ?? 'http://127.0.0.1:5173'
const out = new URL('../docs/screenshots/', import.meta.url).pathname
mkdirSync(out, { recursive: true })
const browser = await chromium.launch()
const errors = []
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1.5, locale: 'zh-CN', serviceWorkers: 'block' })
  // No external requests, credentials, real library, or paid model calls.
  await context.route('**/*', async route => {
    const url = route.request().url()
    if (url.startsWith(base + '/')) return route.continue()
    if (url === 'https://readme-demo.invalid/v1/chat/completions') {
      const request = route.request().postDataJSON()
      const parts = request.messages.at(-1).content.split(/\[\[(\d+)\]\]/)
      let text = ''
      for (let i = 1; i < parts.length; i += 2) {
        const source = parts[i + 1].replace(/\s+/g, ' ').trim()
        const matches = paper.filter(([en]) => source.includes(en))
        assert.ok(matches.length, `Unmapped PDF paragraph: ${source}`)
        text += `[[${parts[i]}]] ${matches.map(([, zh]) => zh).join('\n')}\n\n`
      }
      return route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n` })
    }
    return route.abort()
  })
  const page = await context.newPage()
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(base)
  await page.evaluate(() => localStorage.setItem('lightread-settings', JSON.stringify({
    version: 14, language: 'zh', appearance: 'light', usageStats: false,
    aiProvider: 'custom', aiBaseUrl: 'https://readme-demo.invalid/v1', aiModel: 'readme-demo',
    features: { recommendedBooklists: true }, dailyGoalMinutes: 30,
    reader: { fontSize: 21, lineHeight: 1.9, maxColumnCount: 1, theme: 'sepia' },
    dianjing: { level: 'basic', density: 'normal' },
    readingMode: { wordGuide: { enabled: true, mark: 'keywords', color: 'teal' } },
  })))
  await page.reload()
  const seeded = await seedDemoLibrary(context, page)
  async function shot(name) {
    await page.evaluate(() => document.fonts.ready)
    await page.mouse.move(1260, 880)
    await page.waitForFunction(() => [...document.images].every(img => img.complete && img.naturalWidth > 0))
    await page.waitForTimeout(800)
    await page.screenshot({ path: `${out}${name}.png` })
    console.log(`Captured ${name}`)
  }
  await page.reload()
  await page.locator('.book-card').first().waitFor()
  await shot('feature-library')
  await page.locator('.booklist-chip').filter({ hasText: '给自己一点阅读时间' }).click()
  await shot('feature-booklists')
  await page.goto(`${base}/#/stats`)
  await page.getByText('42', { exact: true }).first().waitFor()
  await shot('feature-reading-stats')
  await page.goto(`${base}/#/catalogs`)
  await page.locator('.curated-section').waitFor()
  await shot('feature-discovery')
  await page.goto(`${base}/#/read/${seeded[0]}`)
  await page.waitForFunction(() => {
    const doc = document.querySelector('foliate-view')?.renderer?.getContents?.()[0]?.doc
    return doc && [...doc.defaultView.CSS.highlights].some(([name, ranges]) => name.startsWith('lr-wg-kw-') && ranges.size)
  })
  await shot('feature-dianjing')
  await page.keyboard.press('m')
  await page.locator('.dj-toggle').waitFor()
  await shot('feature-reading-modes')
  await page.locator('.rm-close').click()
  await page.locator('button[title="听书"]').click()
  await page.locator('.tts-panel').waitFor()
  await shot('feature-listen')
  // Generate a text-layer PDF from original English prose.
  const print = await context.newPage()
  await print.setContent(`<html><head><style>body{font:15px/1.65 Georgia;padding:36px;color:#24383b}h1{font-size:34px;line-height:1.2}h2{font-size:18px;margin-top:24px}p{margin:12px 0}.sub{font-size:18px;color:#527277}footer{font-size:11px;margin-top:34px;color:#667}</style></head><body><h1>${paper[0][0]}</h1><p class="sub">${paper[1][0]}</p><p>${paper[2][0]}</p>${paper.slice(3, -1).map(([en], i) => i % 2 === 0 ? `<h2>${en}</h2>` : `<p>${en}</p>`).join('')}<footer>${paper.at(-1)[0]}</footer></body></html>`)
  const pdf = await print.pdf({ format: 'A4', printBackground: true })
  await print.close()
  const pdfId = await page.evaluate(async bytes => {
    const { getStorage } = await import('/src/storage/index.ts')
    return (await getStorage()).addBook({ title: 'Reading to Understand', author: 'LightRead · 演示文档', kind: 'paper', format: 'pdf', fileName: 'reading-to-understand.pdf', tags: [], addedAt: Date.now() }, new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }))
  }, [...pdf])
  await page.goto(`${base}/#/read-paper/${pdfId}`)
  await page.locator('.p-canvas canvas').first().waitFor({ timeout: 30000 })
  await page.getByRole('button', { name: '翻译', exact: true }).click()
  await page.getByText('为理解而阅读', { exact: false }).first().waitFor({ timeout: 30000 })
  await page.locator('.p-canvas canvas').first().waitFor({ timeout: 30000 })
  await shot('feature-pdf-translation')
  assert.deepEqual(errors, [], 'No application page errors')
  console.log('All README screenshots captured; external network blocked; demo translation only.')
} finally {
  await browser.close()
}
