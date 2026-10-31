import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { mkdir, writeFile, rm } from 'node:fs/promises'
const base=process.env.E2E_BASE || 'http://localhost:4192'
const out=process.env.E2E_OUT || '/tmp/lightread-v2-features'
await mkdir(out,{recursive:true})
const browser=await chromium.launch()
const p=await browser.newPage({viewport:{width:392,height:850},hasTouch:true,isMobile:true,locale:'zh-CN',reducedMotion:'reduce'})
p.setDefaultTimeout(12000)
let ok=false
const errors=[],passed=[]
const pending = new Set()
p.on('request', r => pending.add(r.url()))
p.on('requestfinished', r => pending.delete(r.url()))
p.on('requestfailed', r => pending.delete(r.url()))
p.on('pageerror',e=>errors.push(e.message))
p.on('console',m=>{if(m.type()==='error'||m.type()==='warning') console.log('BROWSER',m.type(),m.text())})
await p.addInitScript(()=>localStorage.setItem('lightread-language','zh'))
const step=async(name,fn)=>{await fn();passed.push(name);console.log('PASS',name)}
const reveal=()=>p.evaluate(()=>document.querySelector('.content')?.dispatchEvent(new MouseEvent('click',{bubbles:true})))
const reloadReader = async () => {
 const started = Date.now()
 await p.reload()
 await p.waitForFunction(()=>document.querySelector('foliate-view')?.renderer?.getContents?.().length, null, { timeout: 60000 })
 console.log('Reader reload:', Date.now() - started, 'ms')
}
const check=async(name)=>{
 assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' overflow')
 await p.screenshot({path:out+'/'+name+'.png',animations:'disabled'})
}
try{
 await step('settings subpages and back navigation',async()=>{
  for(const section of ['sync','ai','data','network','about']){
   await p.goto(base+'/#/settings?page='+section)
   await p.locator('.pl-navbar').waitFor();assert.ok(await p.locator('.pl-navtitle').innerText())
   await check('settings-'+section)
   await p.locator('.pl-back').click();await p.locator('.phone-settings').waitFor()
  }
 })
 await step('appearance and reading goal persist and update UI',async()=>{
  await p.locator('.pl-row').filter({hasText:'外观'}).click()
  await p.getByRole('dialog').getByRole('radio',{name:/深色/}).click()
  await p.waitForFunction(()=>document.documentElement.dataset.theme==='dark')
  await p.locator('.pl-row').filter({hasText:'每日阅读目标'}).click()
  await p.getByRole('radio',{name:'60',exact:true}).click()
  await p.waitForFunction(()=>JSON.parse(localStorage.getItem('lightread-settings'))?.dailyGoalMinutes===60)
  await p.reload();await p.locator('.phone-settings').waitFor()
  assert.equal(await p.evaluate(()=>document.documentElement.dataset.theme),'dark')
  await check('settings-dark')
  await p.locator('.pl-row').filter({hasText:'外观'}).click()
  await p.getByRole('dialog').getByRole('radio',{name:/浅色/}).click()
 })
 await step('library import and search filter',async()=>{
  await p.goto(base+'/#/library')
  await p.setInputFiles('input[type=file][multiple]',[
   {name:'界面验证.txt',mimeType:'text/plain',buffer:Buffer.from('第一章 初见\n\n'+'窗前的树叶映着阳光，留下安静的影子。这里是查找目标。\n\n'.repeat(35)+'\n第二章 重逢\n\n'+'记录与阅读相伴。\n\n'.repeat(35))},
   {name:'另一本文本.txt',mimeType:'text/plain',buffer:Buffer.from('这是另一本测试书。')},
  ])
  await p.locator('.book-card').nth(1).waitFor()
  await p.getByPlaceholder('搜索书名 / 作者 / 标签').fill('界面验证')
  await p.waitForFunction(()=>document.querySelectorAll('.book-card').length===1)
  await p.locator('.book-card').click();await p.waitForFunction(()=>document.querySelector('foliate-view')?.renderer?.getContents?.().length)
 })
 await step('bookmark, selected-text note, reload and deletion',async()=>{
  await reveal();await p.getByRole('button',{name:'添加书签',exact:true}).click()
  await p.evaluate(()=>{
   const doc=document.querySelector('foliate-view').renderer.getContents()[0].doc
   const node=[...doc.querySelectorAll('p')].find(e=>e.textContent.includes('窗前')).firstChild
   const range=doc.createRange();range.setStart(node,0);range.setEnd(node,12)
   doc.getSelection().removeAllRanges();doc.getSelection().addRange(range)
   doc.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}))
  })
  await p.locator('.highlight-bar').waitFor()
  assert.deepEqual(await p.locator('.hl-color').evaluateAll(es => es.map(e => e.getAttribute('aria-label'))), ['黄色', '绿色', '蓝色', '红色'])
  assert.ok(await p.locator('.hl-color').evaluateAll(es => es.every(e => e.getBoundingClientRect().width >= 44 && e.getBoundingClientRect().height >= 44)))
  await p.locator('.highlight-bar').getByRole('button',{name:'写想法',exact:true}).click()
  await p.locator('.note-input').fill('这是一条验证笔记。')
  await p.locator('.annotation-pop').getByRole('button',{name:'保存想法',exact:true}).click()
  await p.locator('.annotation-pop').waitFor({state:'hidden'})
  await reloadReader()
  await reveal();await p.locator('.dock button').nth(1).click()
  await p.locator('.anno-note').filter({hasText:'这是一条验证笔记。'}).waitFor()
  const note = await p.evaluate(async () => {
    const s = await (await import('/src/storage/index.ts')).getStorage()
    return (await s.listAnnotations(location.hash.split('/').at(-1))).find(a => a.note === '这是一条验证笔记。')
  })
  assert.ok(note)
  await p.locator('.anno-item').filter({hasText:'这是一条验证笔记。'}).click()
  await p.evaluate(cfi => document.querySelector('foliate-view').dispatchEvent(new CustomEvent('show-annotation', { detail: { value: cfi } })), note.cfi)
  // 点已有划线: 先出划线工具条, 再从「修改想法」进入编辑
  await p.locator('.highlight-bar').getByRole('button',{name:'修改想法',exact:true}).click()
  await p.locator('.app-modal[role=dialog]').filter({has:p.locator('.annotation-pop')}).waitFor()
  await p.locator('.note-input').fill('')
  await p.locator('.annotation-pop').getByRole('button',{name:'保存想法',exact:true}).click()
  await p.locator('.annotation-pop').waitFor({state:'hidden'})
  await p.waitForFunction(async id => {
    const s = await (await import('/src/storage/index.ts')).getStorage()
    const item = (await s.listAnnotations(location.hash.split('/').at(-1))).find(a => a.id === id)
    return item && item.note === ''
  }, note.id)
  // Reopening while the success message is visible must leave note actions reachable.
  await p.evaluate(cfi => document.querySelector('foliate-view').dispatchEvent(new CustomEvent('show-annotation', { detail: { value: cfi } })), note.cfi)
  await p.locator('.highlight-bar').getByRole('button',{name:'写想法',exact:true}).click()
  await p.waitForFunction(() => document.querySelector('.mobile-messages')?.classList.contains('above-modal'))
  assert.ok(await p.evaluate(() => {
    const toast = document.querySelector('.mobile-messages').getBoundingClientRect()
    return [...document.querySelectorAll('.annotation-pop button')].every(button => {
      const r = button.getBoundingClientRect()
      return r.bottom <= toast.top || r.top >= toast.bottom || r.right <= toast.left || r.left >= toast.right
    })
  }), 'saved message must not cover note actions')
  await p.locator('.annotation-pop').getByRole('button', {name:'取消',exact:true}).click()
  await reloadReader()
  const stored = await p.evaluate(async id => {
    const s = await (await import('/src/storage/index.ts')).getStorage()
    return (await s.listAnnotations(location.hash.split('/').at(-1))).find(a => a.id === id)
  }, note.id)
  assert.ok(stored && !stored.note, 'clearing a saved note survives reload without deleting the highlight')
  await reveal(); await p.locator('.dock button').nth(1).click()

  await p.locator('.anno-tabs').getByRole('button',{name:/书签/}).click()
  assert.equal(await p.locator('.anno-item').count(),1)
  await p.locator('.anno-del').click();await p.locator('.anno-item').waitFor({state:'hidden'})
  await p.keyboard.press('Escape')
 })
 await step('book search and result navigation',async()=>{
  await reveal();await p.getByRole('button',{name:'书内搜索',exact:true}).click()
  await p.locator('.panel input').fill('查找目标');await p.locator('.panel input').press('Enter')
  await p.locator('.search-item').first().waitFor();await p.locator('.search-item').first().click()
  await p.locator('.panel').waitFor({state:'hidden'})
 })
 await step('reader scene toggles restore saved typography',async()=>{
  await reveal();await p.locator('.dock button').nth(3).click()
  const prefs=()=>p.evaluate(()=>JSON.parse(JSON.stringify(document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('settings').reader)))
  const before=await prefs()
  for(const name of ['夜读','护眼','墨水屏','大字','沉浸']){
   const b=p.locator('.rm-card-main').filter({hasText:name});await b.click()
   assert.equal(await b.getAttribute('aria-checked'),'true')
   await b.click();assert.equal(await b.getAttribute('aria-checked'),'false')
   assert.deepEqual(await prefs(),before,name+' restores preferences')
  }
  await p.keyboard.press('Escape')
 })
 await step('all primary routes and reading record remain reachable',async()=>{
  for(const route of ['library','papers','catalogs','stats','settings']){
   await p.goto(base+'/#/'+route);await p.locator('.main').waitFor();await check(route)
  }
 })
 assert.deepEqual(errors,[]); ok=true
}catch(e){await p.screenshot({path:out+'/failure.png'});console.error(p.url(), {pending:[...pending]}, await p.evaluate(()=>({hash:location.hash,ready:document.readyState,route:document.querySelector('#app').__vue_app__?.config.globalProperties.$route?.fullPath})), await p.locator('body').innerText());throw e}
finally{await writeFile(out+'/results.json',JSON.stringify({ok,passed,errors},null,2));if(ok) await rm(out+'/failure.png',{force:true}); await browser.close()}
