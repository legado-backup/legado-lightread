// 教材 (TapXWorld/ChinaTextbook): 分卷合并 / 路径解析 / 整条路径排序 / 分卷依次下载拼接
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  downloadTextbook, groupTextbookFiles, parseTextbookPath, searchTextbookBooks, splitPartOf,
  textbookKey, textbookRawUrl, textbookSubtitle, TextbookDownloadError,
} from '../src/services/chinaTextbook.ts'

const MB = 1048576
const f = (path, size = 9 * MB) => ({ path, size })
const parts = (dir, name, sizes, folder = true) => sizes.map((size, i) => f(
  folder ? `${dir}/${name}.pdf_merge_folder/${name}.pdf.${i + 1}` : `${dir}/${name}.pdf.${i + 1}`, size))

// 仿照真实仓库的目录结构 (学段/学科/版本-出版社/[年级/]书名.pdf)
const tree = [
  f('README.md', 4000), f('.cache/support-alipay.png', 30000), f('高中/英语/重庆大学版-重庆大学出版社/mergePDFs.exe', 70000),
  f('初中/数学/人教版-人民教育出版社/七年级/义务教育教科书·数学七年级上册.pdf'),
  f('初中/数学/人教版-人民教育出版社/七年级/义务教育教科书·数学七年级下册.pdf'),
  f('初中/数学/人教版-人民教育出版社/八年级/义务教育教科书·数学八年级上册.pdf'),
  ...parts('初中/数学/北师大版-北京师范大学出版社/七年级', '义务教育教科书·数学七年级上册', [47185920, 34600000]),
  f('初中/数学/北京版-北京出版社/七年级/义务教育教科书·数学七年级下册.pdf'),
  f('初中/语文/统编版-人民教育出版社/七年级/义务教育教科书·语文七年级上册.pdf'),
  f('初中（五•四学制）/数学/人教版-人民教育出版社/六年级/义务教育教科书（五•四学制）·数学六年级上册.pdf'),
  f('小学/语文/统编版/义务教育教科书·语文三年级上册.pdf'),
  f('小学/语文/统编版/义务教育教科书·语文三年级下册.pdf'),
  f('小学/语文·书法练习指导/北师大版/义务教育三至六年级·书法练习指导（实验）三年级上册.pdf'),
  f('高中/物理/人教版-人民教育出版社/普通高中教科书·物理必修 第一册.pdf'),
  f('高中/物理/人教版-人民教育出版社/普通高中教科书·物理必修 第二册.pdf'),
  f('高中/物理/人教版-人民教育出版社/普通高中教科书·物理选择性必修 第一册.pdf'),
  f('高中/物理/教科版-教育科学出版社/普通高中教科书·物理必修 第一册.pdf'),
  f('高中/生物学/人教版-人民教育出版社/普通高中教科书·生物学选择性必修1 稳态与调节.pdf'),
  // 分卷不在 merge 文件夹里, 且有 11 卷: 必须按数值排序 (10, 11 不能排到 2 前面)
  ...parts('小学/体育与健康/未来社版', '义务教育教科书·体育与健康教师用书水平三', Array.from({ length: 11 }, (_, i) => i < 10 ? 47185920 : 1234567), false),
  // 同一本书既有整本又有分卷: 用整本
  f('初中/化学/北京版-北京出版社/九年级/义务教育教科书·化学九年级下册.pdf', 51785902),
  ...parts('初中/化学/北京版-北京出版社/九年级', '义务教育教科书·化学九年级下册', [47185920, 4599982]),
  // 缺第 2 卷: 拼出来是坏文件, 不收
  ...parts('高中/音乐/沪音版-上海音乐出版社', '普通高中教科书·音乐必修6 音乐与戏剧', [47185920, 47185920, 3000000]).filter((_, i) => i !== 1),
  f('大学/高等数学/同济大学高等数学第七版/同济高 等数学 第七版下册.pdf'),
  ...parts('大学/高等数学/同济大学高等数学第七版', '高等数学 第7版 上册 同济大学', [47185920, 10666666], false),
]
const books = groupTextbookFiles(tree)
const titlesOf = hits => hits.map(hit => `${hit.title} | ${textbookSubtitle(hit)}`)

test('split parts: both layouts, numeric order, gaps rejected, whole file preferred', () => {
  assert.deepEqual(splitPartOf('a/b/书.pdf_merge_folder/书.pdf.3'), { book: 'a/b/书.pdf', index: 3 })
  assert.deepEqual(splitPartOf('a/书.pdf.10'), { book: 'a/书.pdf', index: 10 })
  assert.equal(splitPartOf('a/书.pdf'), null)
  assert.equal(splitPartOf('a/书.pdf_merge_folder/另一本.pdf.1')?.book, 'a/书.pdf_merge_folder/另一本.pdf')

  const pe = books.find(book => book.title.endsWith('教师用书水平三'))
  assert.equal(pe.parts.length, 11)
  assert.deepEqual(pe.parts.map(part => Number(part.path.split('.').pop())), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  assert.equal(pe.size, 10 * 47185920 + 1234567)

  const chem = books.filter(book => book.title === '义务教育教科书·化学九年级下册')
  assert.equal(chem.length, 1)
  assert.deepEqual(chem[0].parts, [{ path: '初中/化学/北京版-北京出版社/九年级/义务教育教科书·化学九年级下册.pdf', size: 51785902 }])

  assert.equal(books.some(book => book.title.includes('音乐与戏剧')), false, 'books with a missing part are not offered')
  assert.equal(books.some(book => /README|png|exe/.test(book.path)), false)
  const bnu = books.find(book => book.edition === '北师大版' && book.subject === '数学')
  assert.equal(bnu.path, '初中/数学/北师大版-北京师范大学出版社/七年级/义务教育教科书·数学七年级上册.pdf')
  assert.equal(bnu.size, 47185920 + 34600000)
})

test('path → stage · subject · grade · edition (publisher)', () => {
  const junior = parseTextbookPath('初中/体育与健康/华中师大版-华中师范大学出版社/七年级/义务教育教科书·体育与健康七年级全一册.pdf')
  assert.deepEqual(junior, {
    title: '义务教育教科书·体育与健康七年级全一册', ext: 'pdf', stage: '初中', subject: '体育与健康',
    grade: '七年级', edition: '华中师大版', publisher: '华中师范大学出版社',
  })
  assert.equal(textbookSubtitle(junior), '初中 · 体育与健康 · 七年级 · 华中师大版')
  const primary = parseTextbookPath('小学/语文·书法练习指导/北师大版/义务教育三至六年级·书法练习指导（实验）三年级上册.pdf')
  assert.equal(primary.grade, '三年级', 'the last grade in the title wins over 「三至六年级」')
  assert.equal(primary.publisher, '')
  assert.equal(parseTextbookPath('高中/物理/人教版-人民教育出版社/普通高中教科书·物理必修 第一册.pdf').grade, '必修 第一册')
  assert.equal(parseTextbookPath('高中/生物学/人教版-人民教育出版社/普通高中教科书·生物学选择性必修1 稳态与调节.pdf').grade, '选择性必修1')
})

test('textbook spellings are normalised for both path and query', () => {
  assert.equal(textbookKey('物理必修 第一册'), textbookKey('物理 必修一'))
  assert.equal(textbookKey('必修1'), textbookKey('必修一'))
  assert.equal(textbookKey('选择性必修一'), textbookKey('选择性必修 第一册'))
  assert.ok(!textbookKey('选择性必修1').includes(textbookKey('必修1')), '「必修一」 must not match 「选择性必修1」')
  assert.equal(textbookKey('7年级'), textbookKey('七年级'))
})

test('「七年级 数学」: grade + subject from the full path, merged split book listed once', () => {
  const hits = searchTextbookBooks(books, '七年级 数学')
  assert.deepEqual(titlesOf(hits).slice(0, 2), [
    '义务教育教科书·数学七年级上册 | 初中 · 数学 · 七年级 · 人教版',
    '义务教育教科书·数学七年级下册 | 初中 · 数学 · 七年级 · 人教版',
  ])
  assert.deepEqual(titlesOf(hits).slice(2).sort(), [
    '义务教育教科书·数学七年级上册 | 初中 · 数学 · 七年级 · 北师大版',
    '义务教育教科书·数学七年级下册 | 初中 · 数学 · 七年级 · 北京版',
  ].sort())
  assert.equal(hits.filter(hit => hit.parts.length > 1).length, 1)
  assert.match(titlesOf(hits)[0], /人教版/, '人教版 first among equally relevant books')
  assert.equal(titlesOf(hits)[0].split(' | ')[0], '义务教育教科书·数学七年级上册', '上册 before 下册')
  // 不加空格、简称也能搜
  assert.deepEqual(titlesOf(searchTextbookBooks(books, '七年级数学')), titlesOf(hits))
  assert.deepEqual(searchTextbookBooks(books, '数学 七上').map(hit => hit.edition).sort(), ['人教版', '北师大版'].sort())
})

test('「人教版 高中 物理 必修一」 and 「语文 三年级上册」 rank the exact book first', () => {
  const physics = searchTextbookBooks(books, '人教版 高中 物理 必修一')
  assert.deepEqual(titlesOf(physics), ['普通高中教科书·物理必修 第一册 | 高中 · 物理 · 必修 第一册 · 人教版'])
  assert.equal(searchTextbookBooks(books, '物理 必修 第一册').length, 2)
  assert.deepEqual(titlesOf(searchTextbookBooks(books, '物理 选择性必修一')), ['普通高中教科书·物理选择性必修 第一册 | 高中 · 物理 · 选择性必修 第一册 · 人教版'])
  assert.equal(searchTextbookBooks(books, '生物 选择性必修1')[0].title, '普通高中教科书·生物学选择性必修1 稳态与调节')

  const chinese = searchTextbookBooks(books, '语文 三年级上册')
  assert.equal(chinese[0].title, '义务教育教科书·语文三年级上册')
  assert.equal(chinese[0].subject, '语文', '「语文」 itself beats 「语文·书法练习指导」')
  assert.equal(chinese.length, 2)
  assert.equal(searchTextbookBooks(books, '下册 语文 三年级').length, 1)
})

test('title queries use title relevance; unrelated queries return nothing', () => {
  const calculus = searchTextbookBooks(books, '高等数学')
  assert.equal(calculus[0].title, '高等数学 第7版 上册 同济大学')
  assert.equal(calculus[0].relevance, 2)
  assert.equal(calculus[0].parts.length, 2)
  assert.deepEqual(searchTextbookBooks(books, '三体'), [])
  assert.deepEqual(searchTextbookBooks(books, '  '), [])
  assert.equal(searchTextbookBooks(books, '数学', 2).length, 2)
})

/** 一卷的内容: 第一卷以 %PDF- 开头 */
function partBytes(index, size) {
  const bytes = new Uint8Array(size).fill(48 + index)
  if (index === 1) bytes.set(new TextEncoder().encode('%PDF-1.7\n'))
  return bytes
}
const streamed = bytes => new Response(new ReadableStream({
  start(controller) {
    for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.subarray(i, i + 7))
    controller.close()
  },
}))

test('download: parts fetched sequentially in numeric order, sizes verified, concatenated', async () => {
  const sizes = [30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 12]
  const book = {
    title: '义务教育教科书·体育与健康教师用书水平三', ext: 'pdf', size: sizes.reduce((a, b) => a + b, 0),
    parts: sizes.map((size, i) => ({ path: `小学/体育与健康/未来社版/义务教育教科书·体育与健康教师用书水平三.pdf.${i + 1}`, size })),
  }
  const requested = []
  let active = 0
  const progress = []
  const file = await downloadTextbook(book, async url => {
    assert.equal(active++, 0, 'one part at a time')
    requested.push(url)
    const index = Number(decodeURIComponent(url).split('.').pop())
    await new Promise(resolve => setTimeout(resolve, 1))
    active--
    return streamed(partBytes(index, sizes[index - 1]))
  }, p => progress.push(p))
  assert.deepEqual(requested.map(url => Number(url.split('.').pop())), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  assert.equal(requested[0], textbookRawUrl(book.parts[0].path))
  assert.match(requested[0], /^https:\/\/raw\.githubusercontent\.com\/TapXWorld\/ChinaTextbook\/HEAD\/%E5%B0%8F%E5%AD%A6\//)
  assert.equal(file.name, '义务教育教科书·体育与健康教师用书水平三.pdf')
  assert.equal(file.type, 'application/pdf')
  assert.equal(file.size, book.size)
  const bytes = new Uint8Array(await file.arrayBuffer())
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 5)), '%PDF-')
  assert.equal(bytes[30], 50, 'second part follows the first')
  assert.equal(bytes[bytes.length - 1], 48 + 11)
  assert.ok(progress.every((p, i) => i === 0 || p.received >= progress[i - 1].received), 'progress never goes backwards')
  assert.deepEqual(progress.at(-1), { part: 11, parts: 11, received: book.size, total: book.size })
})

test('download: a short or oversized part, or a non-PDF result, is rejected', async () => {
  const book = { title: 'x', ext: 'pdf', size: 60, parts: [{ path: 'a/x.pdf.1', size: 30 }, { path: 'a/x.pdf.2', size: 30 }] }
  await assert.rejects(downloadTextbook(book, async url => new Response(partBytes(Number(url.at(-1)), url.endsWith('2') ? 29 : 30))),
    error => error instanceof TextbookDownloadError && error.code === 'size' && error.part === 2)
  await assert.rejects(downloadTextbook(book, async url => streamed(partBytes(Number(url.at(-1)), url.endsWith('1') ? 31 : 30))),
    error => error instanceof TextbookDownloadError && error.code === 'size' && error.part === 1)
  await assert.rejects(downloadTextbook(book, async () => new Response(new Uint8Array(30).fill(65))),
    error => error instanceof TextbookDownloadError && error.code === 'format')
  const whole = { title: 'y', ext: 'pdf', size: 30, parts: [{ path: 'a/y.pdf', size: 30 }] }
  assert.equal((await downloadTextbook(whole, async () => new Response(partBytes(1, 30)))).size, 30)
})
