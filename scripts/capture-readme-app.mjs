// README screenshots of the App interface (Android / iOS UI from src/mobile), in a disposable phone-sized browser.
// Start: TAURI_ENV_PLATFORM=android npm run dev -- --host 127.0.0.1 --port 5174
// Run: E2E_BASE=http://127.0.0.1:5174 node scripts/capture-readme-app.mjs (requires Playwright Chromium).
// Same original demo content as capture-readme.mjs; external network blocked.
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'
import { seedDemoLibrary } from './readme-demo.mjs'

const base = process.env.E2E_BASE ?? 'http://127.0.0.1:5174'
const out = new URL('../docs/screenshots/', import.meta.url).pathname
mkdirSync(out, { recursive: true })
const browser = await chromium.launch()
const errors = []
try {
  // 390 × 844 (常见手机竖屏), 3 倍像素密度; isMobile + hasTouch 让界面按触屏处理
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    locale: 'zh-CN', serviceWorkers: 'block',
  })
  // Android 原生壳注入的桥 (MainActivity.kt) 在浏览器里不存在; 提供同名空实现, 让「音量键翻页」等 App 专属设置按真机显示
  await context.addInitScript(() => {
    window.LightReadInsets = { get: () => '{"top":0,"right":0,"bottom":0,"left":0}', setBarsDark() {}, setImmersive() {}, setKeepScreenOn() {}, setVolumeKeys() {} }
  })
  await context.route('**/*', route => route.request().url().startsWith(base + '/') ? route.continue() : route.abort())
  const page = await context.newPage()
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(base)
  await page.evaluate(() => localStorage.setItem('lightread-settings', JSON.stringify({
    version: 14, language: 'zh', appearance: 'light', usageStats: false, dailyGoalMinutes: 30,
    reader: { fontSize: 19, lineHeight: 1.9, maxColumnCount: 1, theme: 'sepia' },
    dianjing: { level: 'basic', density: 'normal' },
    readingMode: { wordGuide: { enabled: true, mark: 'keywords', color: 'teal' } },
  })))
  await page.reload()
  const seeded = await seedDemoLibrary(context, page)
  async function shot(name) {
    await page.evaluate(() => document.fonts.ready)
    await page.waitForFunction(() => [...document.images].every(img => img.complete && img.naturalWidth > 0))
    await page.waitForTimeout(900)
    await page.screenshot({ path: `${out}${name}.png` })
    console.log(`Captured ${name}`)
  }
  await page.goto(`${base}/#/library`)
  await page.reload()
  await page.locator('.book-card').first().waitFor()
  await shot('app-library')
  await page.goto(`${base}/#/stats`)
  await page.getByText('42', { exact: true }).first().waitFor()
  await shot('app-stats')
  await page.goto(`${base}/#/catalogs`)
  await page.getByRole('searchbox', { name: '统一搜书' }).waitFor()
  await shot('app-sources')
  // 从头开始的那本 (进度 0), 正文从章节标题开始
  await page.goto(`${base}/#/read/${seeded[3]}`)
  await page.waitForFunction(() => !!document.querySelector('foliate-view')?.renderer?.getContents?.()[0]?.doc?.body?.textContent?.includes('阅读'))
  // 工具栏在收起动画中时正文层会盖住按钮; 直接派发点击, 等同于用户点到按钮
  const showBars = async () => {
    if (await page.locator('.dock').isVisible()) return
    await page.mouse.click(195, 422)
    await page.locator('.dock').waitFor()
  }
  const dock = name => page.locator('.dock button').filter({ hasText: name }).dispatchEvent('click')
  const keyWordsPainted = () => page.waitForFunction(() => {
    const doc = document.querySelector('foliate-view')?.renderer?.getContents?.()[0]?.doc
    return doc && [...doc.defaultView.CSS.highlights].some(([name, ranges]) => name.startsWith('lr-wg-kw-') && ranges.size)
  })
  // 在「模式」里打开点睛阅读 (基础版, 不联网), 和读者的操作一样
  await showBars()
  await dock('模式')
  const djSwitch = page.locator('.dj-toggle [role="switch"]').first()
  await djSwitch.waitFor()
  if (!await djSwitch.isChecked()) await djSwitch.dispatchEvent('click')
  await keyWordsPainted()
  await shot('app-reading-modes')
  await page.keyboard.press('Escape')
  await page.locator('.dock').waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {})
  await keyWordsPainted()
  await shot('app-reader')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  await showBars()
  await dock('排版')
  // 拍「页面」一节: 翻页方式、进度显示与音量键翻页
  await page.getByRole('tab', { name: '页面' }).dispatchEvent('click')
  const volume = page.getByRole('switch', { name: '音量键翻页' })
  await volume.waitFor()
  await volume.evaluate(el => el.closest('.tp-portrait')?.scrollIntoView({ block: 'end' }))
  await shot('app-typography')
  // 点遮罩收起排版面板, 再呼出工具栏上的「听书」
  if (await page.locator('.sheet-scrim').count()) await page.locator('.sheet-scrim').dispatchEvent('click')
  await page.waitForTimeout(400)
  // 收起的工具栏只是移出屏幕; 轻点正文中部呼出, 直到出现「听书」
  for (let i = 0; i < 4 && !await page.locator('.listen-entry').count(); i++) {
    await page.mouse.click(195, 422)
    await page.waitForTimeout(600)
  }
  await page.locator('.listen-entry').dispatchEvent('click')
  await page.locator('.tts-panel').waitFor()
  await shot('app-listen')
  assert.deepEqual(errors, [], 'No application page errors')
  console.log('All App README screenshots captured; external network blocked.')
} finally {
  await browser.close()
}
