/**
 * 笔记导出 (src/services/notesExport.ts): Markdown / 纯文本 / JSON / CSV 四种格式,
 * 章节分组、想法、时间、颜色筛选、书签只进 JSON、位置排序与文件名.
 *
 *   npm run test:notes-export
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildNotesExport, notesFileName, noteToClipboard, selectNotes, sortNotes, formatNoteTime,
} from '../src/services/notesExport.ts'

const book = { title: '理想国', author: '柏拉图', format: 'epub' }
const at = (d, h = 9, m = 0) => new Date(2026, 9, d, h, m).getTime()
const items = [
  { id: 'a', kind: 'highlight', chapter: '第一卷', color: 'yellow', text: '正义不是别的，就是强者的利益。', note: '色拉叙马霍斯的立场。', createdAt: at(21), position: 'p1' },
  { id: 'b', kind: 'highlight', chapter: '第一卷', color: 'blue', text: '没有一种技艺是为它本身的利益。', createdAt: at(21, 10), position: 'p2' },
  { id: 'c', kind: 'highlight', chapter: '第七卷', color: 'red', text: '教育实际上并不像某些人所宣称的那样。\n\n\n他们宣称能把知识灌输到灵魂里去。', note: '教育是转向，不是灌输。', createdAt: at(29), position: 'p3' },
  { id: 'k', kind: 'bookmark', chapter: '第七卷', color: 'bookmark', text: '第七卷开头', createdAt: at(29, 11), position: 'p4' },
]
const NOW = at(31, 12)

test('markdown: title, meta, chapter headings, quotes and notes', () => {
  const md = buildNotesExport(book, items, { format: 'md', chapters: true, notes: true, time: false, now: NOW })
  assert.match(md, /^# 《理想国》读书笔记\n/)
  assert.match(md, /> 作者：柏拉图  \n> 3 条划线，2 条想法 · 导出自轻阅 2026-10-31/)
  assert.equal(md.match(/^## 第一卷$/gm).length, 1)
  assert.match(md, /## 第七卷\n\n> 教育实际上并不像某些人所宣称的那样。\n> \n> 他们宣称/)
  assert.match(md, /> 正义不是别的，就是强者的利益。\n\n色拉叙马霍斯的立场。\n/)
  assert.doesNotMatch(md, /第七卷开头/, 'bookmarks never in markdown')
  assert.ok(md.endsWith('\n') && !md.endsWith('\n\n'))
})

test('markdown without chapters / notes, with time', () => {
  const md = buildNotesExport(book, items, { format: 'md', chapters: false, notes: false, time: true, now: NOW })
  assert.doesNotMatch(md, /^## /m)
  assert.doesNotMatch(md, /色拉叙马霍斯/)
  assert.match(md, /3 条划线 · /)
  assert.match(md, /<small>2026-10-21 09:00<\/small>/)
})

test('plain text follows the WeRead copy layout', () => {
  const txt = buildNotesExport(book, items, { format: 'txt', chapters: true, notes: true, time: false, now: NOW })
  const expected = [
    '《理想国》', '柏拉图', '3个笔记',
    '', '', '◆ 第一卷',
    '', '>> 正义不是别的，就是强者的利益。', '想法：色拉叙马霍斯的立场。',
    '', '>> 没有一种技艺是为它本身的利益。',
    '', '', '◆ 第七卷',
    '', '>> 教育实际上并不像某些人所宣称的那样。\n他们宣称能把知识灌输到灵魂里去。', '想法：教育是转向，不是灌输。',
  ].join('\n') + '\n'
  assert.equal(txt, expected)
})

test('json keeps structure, positions and optional bookmarks', () => {
  const doc = JSON.parse(buildNotesExport(book, items, { format: 'json', chapters: true, notes: true, time: false, now: NOW }))
  assert.equal(doc.format, 'lightread-notes')
  assert.equal(doc.version, 1)
  assert.deepEqual(doc.book, { title: '理想国', author: '柏拉图', format: 'epub' })
  assert.equal(doc.notes.length, 3)
  assert.deepEqual(Object.keys(doc.notes[0]), ['id', 'type', 'chapter', 'text', 'note', 'color', 'createdAt', 'position'])
  assert.equal(doc.notes[1].note, undefined)
  const withMarks = JSON.parse(buildNotesExport(book, items, { format: 'json', chapters: true, notes: false, time: false, bookmarks: true, now: NOW }))
  assert.equal(withMarks.notes.length, 4)
  assert.equal(withMarks.notes[3].type, 'bookmark')
  assert.equal(withMarks.notes[3].color, undefined)
  assert.equal(withMarks.notes[0].note, undefined, 'notes option drops thoughts')
})

test('csv matches the Readwise import header and escapes cells', () => {
  const csv = buildNotesExport(
    { title: 'Book, "Quoted"', author: 'A' },
    [{ id: 'x', kind: 'highlight', color: 'yellow', text: 'line1\nline2', note: 'say "hi"', createdAt: at(1), page: 12 }],
    { format: 'csv', chapters: true, notes: true, time: false },
  )
  const rows = csv.split('\r\n')
  assert.equal(rows[0], 'Highlight,Title,Author,URL,Note,Location,Date')
  assert.equal(rows[1], '"line1\nline2","Book, ""Quoted""",A,,"say ""hi""",12,2026-10-01 09:00:00')
})

test('color filter and bookmark selection', () => {
  assert.deepEqual(selectNotes(items, { format: 'md', colors: ['red', 'blue'] }).map(i => i.id), ['b', 'c'])
  assert.deepEqual(selectNotes(items, { format: 'md' }).map(i => i.id), ['a', 'b', 'c'])
  assert.deepEqual(selectNotes(items, { format: 'json', bookmarks: true }).map(i => i.id), ['a', 'b', 'c', 'k'])
  const md = buildNotesExport(book, items, { format: 'md', chapters: true, notes: true, time: false, colors: ['red'], now: NOW })
  assert.match(md, /1 条划线，1 条想法/)
  assert.doesNotMatch(md, /## 第一卷/)
})

test('pdf notes group by page when there is no chapter', () => {
  const md = buildNotesExport({ title: 'Paper' }, [
    { id: '1', kind: 'highlight', color: 'yellow', text: 'A', createdAt: 1, page: 3 },
    { id: '2', kind: 'highlight', color: 'yellow', text: 'B', createdAt: 2, page: 3 },
    { id: '3', kind: 'highlight', color: 'yellow', text: 'C', createdAt: 3, page: 5 },
  ], { format: 'md', chapters: true, notes: true, time: false, lang: 'en', now: NOW })
  assert.match(md, /^# Notes on Paper/)
  assert.equal(md.match(/^## Page 3$/gm).length, 1)
  assert.match(md, /## Page 5/)
  assert.match(md, /3 highlights · Exported from LightRead/)
})

test('sorts by book position, falls back to time when positions cannot compare', () => {
  const list = [
    { id: 'late', position: 'b', createdAt: 1 },
    { id: 'early', position: 'a', createdAt: 2 },
    { id: 'none', createdAt: 0 },
  ]
  const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0)
  assert.deepEqual(sortNotes(list, cmp).map(i => i.id), ['none', 'early', 'late'])
  const broken = sortNotes([{ id: 'x', position: '?', createdAt: 5 }, { id: 'y', position: '!', createdAt: 1 }], () => { throw new Error('bad') })
  assert.deepEqual(broken.map(i => i.id), ['y', 'x'])
})

test('file names are safe on every platform', () => {
  assert.equal(notesFileName('理想国', 'md'), '《理想国》笔记.md')
  assert.equal(notesFileName('A/B: C?', 'json', 'en'), 'A B C - notes.json')
  assert.equal(notesFileName('', 'txt'), '《LightRead》笔记.txt')
  assert.ok(notesFileName('长'.repeat(200), 'csv').length < 100)
})

test('single note clipboard text carries source', () => {
  assert.equal(noteToClipboard(book, items[0]), '正义不是别的，就是强者的利益。\n想法：色拉叙马霍斯的立场。\n——《理想国》 柏拉图')
  assert.equal(noteToClipboard({ title: 'X' }, { ...items[1] }, 'en'), '没有一种技艺是为它本身的利益。\n— X')
  assert.equal(formatNoteTime(at(5, 7, 3)), '2026-10-05 07:03')
})
