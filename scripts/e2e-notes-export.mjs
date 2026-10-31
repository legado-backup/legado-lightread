/**
 * 书摘端到端 (issue #16): 划线 → 笔记面板按章节分组 → 复制全部 (微信读书版式) → 导出四种格式 →
 * 金句卡片六种版式出图 → 旧版截断划线在打开面板时取回全文.
 *
 * 连接 Vite 开发服务器 (用到 /src/storage/index.ts 动态导入):
 *   npm run dev                                   # 桌面界面, 5173
 *   E2E_BASE=http://localhost:5173 node scripts/e2e-notes-export.mjs
 *   LIGHTREAD_UI=mobile npm run dev               # App 界面
 *   E2E_MOBILE=1 E2E_BASE=http://localhost:5173 node scripts/e2e-notes-export.mjs
 * 截图与生成的卡片在 E2E_OUT (默认 /tmp/lightread-notes-export).
 */
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { mkdir, readFile } from 'node:fs/promises'

const base = process.env.E2E_BASE || 'http://localhost:5173'
const mobile = process.env.E2E_MOBILE === '1'
const out = process.env.E2E_OUT || `/tmp/lightread-notes-export/${mobile ? 'app' : 'desktop'}`
await mkdir(out, { recursive: true })

const browser = await chromium.launch()
const context = await browser.newContext({
  viewport: mobile ? { width: 392, height: 850 } : { width: 1360, height: 900 },
  hasTouch: mobile,
  isMobile: mobile,
  locale: 'zh-CN',
  reducedMotion: 'reduce',
  acceptDownloads: true,
  permissions: ['clipboard-read', 'clipboard-write'],
})
const p = await context.newPage()
p.setDefaultTimeout(20000)
const errors = []
p.on('pageerror', e => errors.push(e.message))
p.on('console', m => { if (m.type() === 'error') console.log('BROWSER', m.text()) })
await p.addInitScript(() => localStorage.setItem('lightread-language', 'zh'))

const step = async (name, fn) => { await fn(); console.log('PASS', name) }
const shot = name => p.screenshot({ path: `${out}/${name}.png`, animations: 'disabled' })
const noOverflow = async name => assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}: horizontal overflow`)
const storage = fn => p.evaluate(async src => {
  const s = await (await import('/src/storage/index.ts')).getStorage()
  const id = location.hash.split('/').at(-1).split('?')[0]
  return (0, eval)(src)(s, id)
}, fn.toString())

const para = '窗前的树叶映着阳光，留下安静的影子。这里是查找目标。'
const book = '第一章 初见\n\n' + (para + '\n\n').repeat(40) + '\n第二章 重逢\n\n' + '记录与阅读相伴，“书摘”要能带走。\n\n'.repeat(40)

async function select(chapterText, fromPara, toPara, endOffset) {
  // 章节文档可能还在加载: 先等到正文里出现目标文字
  await p.waitForFunction(needle => document.querySelector('foliate-view')?.renderer?.getContents?.().some(c => c.doc?.body?.textContent?.includes(needle)), chapterText, { timeout: 30000 })
  await p.evaluate(([needle, from, to, end]) => {
    const view = document.querySelector('foliate-view')
    const doc = view.renderer.getContents().map(c => c.doc).find(d => d?.body?.textContent?.includes(needle))
    const ps = [...doc.querySelectorAll('p')].filter(e => e.textContent.includes(needle))
    const range = doc.createRange()
    range.setStart(ps[from].firstChild, 0)
    const last = ps[to].firstChild
    range.setEnd(last, end ?? last.length)
    doc.getSelection().removeAllRanges()
    doc.getSelection().addRange(range)
    doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  }, [chapterText, fromPara, toPara, endOffset])
  await p.locator('.highlight-bar').waitFor()
}

async function openNotesPanel() {
  if (mobile) {
    await p.evaluate(() => document.querySelector('.content')?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await p.locator('.dock button').nth(1).click()
  } else {
    await p.locator('button[title="笔记"]').first().click()
  }
  await p.locator('.anno-tabs').waitFor()
}

try {
  await step('import a two-chapter book and open it', async () => {
    await p.goto(base + '/#/library')
    await p.setInputFiles('input[type=file][multiple]', [{ name: '书摘验证.txt', mimeType: 'text/plain', buffer: Buffer.from(book) }])
    await p.locator('.book-card').first().waitFor()
    await p.locator('.book-card').first().click()
    await p.waitForFunction(() => document.querySelector('foliate-view')?.renderer?.getContents?.().length, null, { timeout: 60000 })
  })

  await step('highlight: short with note, long paragraph run, quote card from selection', async () => {
    await select('窗前', 1, 1, 9)
    await p.locator('.highlight-bar').getByRole('button', { name: '写想法', exact: true }).click()
    await p.locator('.note-input').fill('树影是安静的。')
    await p.locator('.annotation-pop').getByRole('button', { name: '保存想法', exact: true }).click()
    await p.locator('.annotation-pop').waitFor({ state: 'hidden' })

    await select('窗前', 3, 16)
    await p.locator('.highlight-bar .hl-color').nth(2).click()
    await p.locator('.highlight-bar').waitFor({ state: 'hidden' })

    const saved = await storage((s, id) => s.listAnnotations(id))
    assert.equal(saved.length, 2)
    const long = saved.find(a => !a.note)
    assert.ok([...long.text].length > 300, `long highlight keeps full text (${[...long.text].length})`)

    // 选区直接做卡片
    await select('窗前', 5, 5)
    await p.locator('.highlight-bar').getByRole('button', { name: '金句卡片', exact: true }).click()
    await p.locator('.qc-preview').waitFor()
    await p.locator('.app-modal-close').click()
    await p.locator('.qc-preview').waitFor({ state: 'hidden' })
  })

  await step('legacy truncated highlight is restored from the book', async () => {
    // 模拟 2.5.x 以前存下的 300 字截断
    const id = await storage(async (s, bookId) => {
      const a = (await s.listAnnotations(bookId)).find(x => !x.note)
      await s.updateAnnotation(a.id, { text: [...a.text].slice(0, 300).join('') })
      return a.id
    })
    await p.reload()
    await p.waitForFunction(() => document.querySelector('foliate-view')?.renderer?.getContents?.().length, null, { timeout: 60000 })
    await openNotesPanel()
    await p.waitForFunction(async id => {
      const s = await (await import('/src/storage/index.ts')).getStorage()
      const bookId = location.hash.split('/').at(-1).split('?')[0]
      const a = (await s.listAnnotations(bookId)).find(x => x.id === id)
      return a && [...a.text].length > 300
    }, id, { timeout: 15000 })
  })

  await step('second-chapter highlight; panel groups by chapter in book order', async () => {
    if (mobile) await p.keyboard.press('Escape')
    else await p.locator('button[title="笔记"]').first().click()
    await p.evaluate(async () => {
      const view = document.querySelector('foliate-view')
      const i = view.book.sections.findIndex(s => s.id && s !== view.book.sections[0])
      await view.goTo(view.book.toc?.[1]?.href ?? i)
    })
    await p.waitForFunction(() => document.querySelector('foliate-view').renderer.getContents().some(c => c.doc?.body?.textContent?.includes('记录与阅读')))
    await select('记录与阅读', 0, 0)
    await p.locator('.highlight-bar .hl-color').nth(3).click()
    await openNotesPanel()
    await p.waitForFunction(() => document.querySelectorAll('.anno-chapter').length >= 2)
    const chapters = await p.locator('.anno-chapter').allInnerTexts()
    assert.deepEqual(chapters.map(c => c.trim()).slice(0, 2), ['第一章 初见', '第二章 重逢'])
    const items = await p.locator('.anno-item .anno-text').allInnerTexts()
    assert.ok(items[0].startsWith('窗前的树叶') && items.at(-1).startsWith('记录与阅读'), 'book order')
    await noOverflow('panel')
    await shot('notes-panel')
  })

  await step('copy all uses the WeRead layout', async () => {
    await p.locator('.anno-copy-all').click()
    await p.waitForTimeout(300)
    const text = await p.evaluate(() => navigator.clipboard.readText())
    assert.match(text, /^《书摘验证》\n/)
    assert.match(text, /3个笔记/)
    assert.match(text, /◆ 第一章 初见\n\n>> 窗前的树叶映着阳光\n想法：树影是安静的。/)
    assert.match(text, /◆ 第二章 重逢\n\n>> 记录与阅读相伴/)
  })

  await step('export dialog: four formats, filters, save as file', async () => {
    await p.locator('.anno-foot').getByRole('button', { name: '导出', exact: true }).click()
    const dlg = p.locator('.app-modal')
    await dlg.locator('.nx-preview').waitFor()
    assert.match(await dlg.locator('.nx-preview').innerText(), /^# 《书摘验证》读书笔记/)
    await noOverflow('export-md')
    await shot('export-md')
    for (const [label, re] of [['纯文本', /^《书摘验证》/], ['JSON', /"format": "lightread-notes"/], ['CSV', /^Highlight,Title,Author,URL,Note,Location,Date/]]) {
      await dlg.getByRole('button', { name: label, exact: true }).click()
      assert.match(await dlg.locator('.nx-preview').innerText(), re, label)
    }
    await dlg.getByRole('button', { name: 'JSON', exact: true }).click()
    const json = JSON.parse(await dlg.locator('.nx-preview').innerText())
    assert.equal(json.notes.length, 3)
    assert.deepEqual(json.notes.map(n => n.chapter), ['第一章 初见', '第一章 初见', '第二章 重逢'])
    // 只要红色
    await dlg.getByRole('button', { name: '红色' }).click()
    assert.equal(JSON.parse(await dlg.locator('.nx-preview').innerText()).notes.length, 1)
    await dlg.getByRole('button', { name: '全部', exact: true }).click()
    await dlg.getByRole('button', { name: 'Markdown', exact: true }).click()
    const [download] = await Promise.all([p.waitForEvent('download'), dlg.getByRole('button', { name: '保存为文件' }).click()])
    assert.equal(download.suggestedFilename(), '《书摘验证》笔记.md')
    const path = `${out}/${download.suggestedFilename()}`
    await download.saveAs(path)
    const md = await readFile(path, 'utf8')
    assert.match(md, /## 第二章 重逢/)
    await shot('export-json')
    await p.locator('.app-modal-close').click()
  })

  await step('quote card from a highlight: fifteen layouts render, save PNG', async () => {
    await p.locator('.anno-item').filter({ hasText: '树影是安静的' }).hover().catch(() => {})
    await p.locator('.anno-item').filter({ hasText: '树影是安静的' }).getByRole('button', { name: '金句卡片' }).click()
    const dlg = p.locator('.app-modal')
    await dlg.locator('.qc-preview').waitFor()
    await p.waitForFunction(() => document.querySelectorAll('.qc-thumb img').length === 15, null, { timeout: 60000 })
    const names = ['纸卡', '毛玻璃', '手账', '划线', '日历', '竖排', '留白', '备忘录', '杂志', '大字报', '弥散', '星夜', '稿纸']
    for (const [i, name] of names.entries()) {
      await dlg.locator('.qc-tpl').filter({ hasText: name }).click()
      await p.waitForFunction(() => !document.querySelector('.qc-stage.busy'))
      const size = await dlg.locator('.qc-preview').evaluate(img => new Promise(r => (img.complete ? r([img.naturalWidth, img.naturalHeight]) : img.onload = () => r([img.naturalWidth, img.naturalHeight]))))
      assert.equal(size[0], 1080, name)
      assert.ok(size[1] >= 1440, `${name}: 3:4 default`)
      if (i === 0 || i === 2) await shot(`card-${i}`)
    }
    // 比例: 方图与长图
    await dlg.getByRole('button', { name: '方图 1:1' }).click()
    await p.waitForFunction(() => !document.querySelector('.qc-stage.busy'))
    assert.equal(await dlg.locator('.qc-preview').evaluate(img => new Promise(r => img.complete && img.naturalWidth ? r(img.naturalHeight) : (img.onload = () => r(img.naturalHeight))))  >= 1080, true)
    await dlg.getByRole('button', { name: '小红书 3:4' }).click()
    // 深色底 + 楷体 + 大字
    await dlg.locator('.qc-swatch').nth(9).click()
    await dlg.getByRole('button', { name: '楷体', exact: true }).click()
    await dlg.getByRole('button', { name: '大', exact: true }).click()
    await p.waitForFunction(() => !document.querySelector('.qc-stage.busy'))
    await noOverflow('card')
    await shot('card-dark')
    // 浏览器里没有 App 的相册桥, 两种界面都是「保存图片」下载
    const [download] = await Promise.all([p.waitForEvent('download'), dlg.getByRole('button', { name: '保存图片' }).click()])
    assert.match(download.suggestedFilename(), /^LightRead-书摘验证-\d{8}-\d{6}\.png$/)
    await download.saveAs(`${out}/card.png`)
    await p.locator('.app-modal-close').click()
  })

  assert.deepEqual(errors, [], 'page errors')
  console.log('ALL PASS', out)
} catch (e) {
  await shot('failure').catch(() => {})
  console.error(e)
  console.error('page errors:', errors)
  process.exitCode = 1
} finally {
  await browser.close()
}
