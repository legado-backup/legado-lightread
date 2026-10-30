// README 截图共用的原创演示内容: 示例读物、封面、PDF 段落与书库种子 (不读取任何真实书库)。
import { strToU8, zipSync } from 'fflate'

export const paragraphs = [
  '阅读不是把一页页文字搬进记忆，而是在已有的经验之间建立新的联系。当我们合上书，试着用自己的话解释一个观点，知识才开始变成理解。',
  '注意力是一种有限的资源。工作记忆只能同时处理少量信息，太多标记反而会让重要的内容消失在颜色里。留下少数关键概念，给思考留出空白。',
  '主动回忆比反复浏览更能暴露理解的缺口。读完一段，先问自己：作者在回答什么问题？这条证据支持了什么结论？还有哪些可能的解释？',
  '间隔重复让学习成为一条可以回头走的路。今天写下一个问题，几天后带着新的经验重读，原本陌生的概念就有机会与生活发生联系。',
  '批判性思维不是急着反对，而是把事实、推断与价值判断分开。好的笔记既记录作者的观点，也保留自己的疑问，为下一次阅读留下入口。',
  '理解也需要安静的节奏。选择合适的字号，关掉暂时用不到的面板，让视线沿着段落自然移动。读得慢一点，有时能看见更多。',
  '一本书的价值，并不只在读完的那一刻。与朋友讨论、写下一段解释、在新的问题中再次使用，都是阅读继续发生的方式。',
]
export const books = [
  ['阅读与记忆', 'READ & REMEMBER', '#234b4d', '#e6e1cc', '认知'],
  ['山野笔记', 'INTO THE WILD', '#d4dac8', '#304635', '自然'],
  ['慢读的力量', 'THE ART OF SLOW', '#bd694d', '#fff0dc', '阅读'],
  ['一间自己的书房', 'A ROOM FOR IDEAS', '#e6dcc8', '#5a4739', '生活'],
  ['时间的形状', 'A SENSE OF TIME', '#3e4c69', '#ece0bb', '科学'],
  ['城市漫游', 'WALK & WONDER', '#bfcdd1', '#283f50', '旅行'],
  ['写给明天的信', 'LETTERS TO TOMORROW', '#876252', '#faeedc', '随笔'],
  ['思考的边界', 'BEYOND THE PAGE', '#dbcaa3', '#514f31', '哲学'],
  ['日常的诗意', 'EVERYDAY POETRY', '#c9b8bd', '#4d3b4a', '生活'],
  ['万物之间', 'CONNECTIONS', '#557364', '#f2ead4', '自然'],
  ['远方的灯火', 'DISTANT LIGHTS', '#38465b', '#e1cda5', '随笔'],
  ['好奇心手册', 'STAY CURIOUS', '#d6ad6c', '#493d30', '科学'],
]
export function cover([title, subtitle, bg, fg], i) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="660" viewBox="0 0 480 660"><rect width="480" height="660" fill="${bg}"/><rect x="24" y="24" width="432" height="612" fill="none" stroke="${fg}" opacity=".4"/><text x="52" y="83" fill="${fg}" font-size="14" letter-spacing="4">LIGHTREAD / ${String(i + 1).padStart(2, '0')}</text><path d="M52 390 Q150 ${240 + i * 15} 240 390 T428 390 M52 415 Q150 ${265 + i * 15} 240 415 T428 415 M52 440 Q150 ${290 + i * 15} 240 440 T428 440" fill="none" stroke="${fg}" stroke-width="2" opacity=".55"/><text x="52" y="191" fill="${fg}" font-family="serif" font-size="${title.length > 6 ? 42 : 49}">${title}</text><text x="54" y="233" fill="${fg}" font-size="13" letter-spacing="2">${subtitle}</text><text x="52" y="568" fill="${fg}" font-family="sans-serif" font-size="17">轻阅 · 示例读物</text><text x="52" y="597" fill="${fg}" font-size="11" letter-spacing="2">A LITTLE TIME FOR YOURSELF</text></svg>`
}
export function epub(title) {
  return zipSync({
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8('<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    'content.opf': strToU8(`<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">demo-${title}</dc:identifier><dc:title>${title}</dc:title><dc:creator>轻阅 · 示例读物</dc:creator><dc:language>zh</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="text" href="text.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="text"/></spine></package>`),
    'nav.xhtml': strToU8('<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol><li><a href="text.xhtml">第一章 让阅读留下痕迹</a></li></ol></nav></body></html>'),
    'text.xhtml': strToU8(`<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head><body><h2>第一章 让阅读留下痕迹</h2>${[...paragraphs, ...paragraphs].map(p => `<p>${p}</p>`).join('')}</body></html>`),
  })
}
export const paper = [
  ['Reading to Understand', '为理解而阅读'],
  ['A practical guide to attention, memory and reflection', '关于注意力、记忆与反思的实践指南'],
  ['LightRead demo document', '轻阅演示文档'],
  ['Abstract', '摘要'],
  ['Reading becomes useful when new ideas connect with what we already know. This demonstration document presents a simple workflow: focus on one question, connect the main concepts, and return to the text after a pause.', '当新的想法与已有知识建立联系时，阅读便有了意义。本文介绍一种简单的方法：聚焦一个问题，联系主要概念，稍作停顿后再回到原文。'],
  ['1. Read with a question', '1. 带着问题阅读'],
  ['Before opening a chapter, write down one question you want to answer. A clear question gives your attention a direction. As you read, distinguish the main claim from the examples that support it.', '开始一章之前，写下一个想要回答的问题。明确的问题让注意力有了方向。阅读时，区分主要论点与支持论点的例子。'],
  ['2. Connect ideas', '2. 建立概念之间的联系'],
  ['Highlight a small number of useful concepts. Explain each one in your own words, then connect it to an experience or another idea. Notes are most helpful when they preserve both the argument and your questions.', '标记少量有用的概念。用自己的话解释，再将它与一段经历或另一个想法联系起来。好的笔记既保存论证，也留下自己的疑问。'],
  ['3. Return and reflect', '3. 回顾与反思'],
  ['Close the book and recall the main point. Later, revisit the passages you could not explain. Reading history helps you return to a book; reflection helps you return to an idea.', '合上书，回忆主要观点。过一段时间，再读那些还解释不清的段落。阅读记录让你回到一本书，反思让你回到一个想法。'],
  ['Original sample text for the LightRead feature tour. Not a research publication.', '轻阅功能演示原创示例文本，并非研究论文。'],
]

/** 生成封面并把 12 本示例书、书单、48 天阅读记录写进应用 (需 Vite 开发服务的 /src 模块) */
export async function seedDemoLibrary(context, page) {
  const demoBooks = []
  const art = await context.newPage()
  for (const [i, b] of books.entries()) {
    await art.setContent(`<style>body{margin:0}svg{display:block}</style>${cover(b, i)}`)
    await art.evaluate(() => document.fonts.ready)
    const png = await art.locator('svg').screenshot({ type: 'png' })
    demoBooks.push({ title: b[0], tag: b[4], cover: [...png], file: [...epub(b[0])] })
  }
  await art.close()
  const seeded = await page.evaluate(async data => {
    const { getStorage } = await import('/src/storage/index.ts')
    const { recordReading } = await import('/src/services/readingLog.ts')
    const storage = await getStorage()
    const ids = []
    for (const [i, b] of data.entries()) {
      const id = await storage.addBook({ title: b.title, author: '轻阅 · 示例读物', format: 'epub', fileName: `${b.title}.epub`, tags: [b.tag], addedAt: Date.now() - i * 86400000, lastReadAt: Date.now() - i * 3600000, progress: [0.36, 0.68, 0.12, 0, 0.82, 0.23, 0, 1, 0.17, 0.52, 0, 0.09][i], source: 'README 示例' }, new Blob([new Uint8Array(b.file)]), new Blob([new Uint8Array(b.cover)], { type: 'image/png' }))
      ids.push(id)
    }
    const list = await storage.createBooklist('给自己一点阅读时间')
    await storage.addBooksToBooklist(list, ids.slice(0, 3))
    await storage.createBooklist('周末慢读')
    await storage.createBooklist('关于世界的好奇心')
    await storage.putBooklistWanted([{ id: 'demo-wanted-1', booklistId: list, title: '瓦尔登湖', author: '亨利·戴维·梭罗', note: '下一本，去自然里找一点安静。', addedAt: Date.now() }, { id: 'demo-wanted-2', booklistId: list, title: '论语', author: '孔子及其弟子', note: '每天读一段，也记下自己的理解。', addedAt: Date.now() + 1 }])
    for (let day = 0; day < 48; day++) {
      if (day > 6 && day % 6 === 0) continue
      const at = new Date(); at.setHours(12, 0, 0, 0); at.setDate(at.getDate() - day)
      const index = day % 4
      await recordReading({ id: ids[index], title: data[index].title }, (day === 0 ? 42 : 18 + day * 7 % 43) * 60, at.getTime())
    }
    return ids
  }, demoBooks)
  return seeded
}
