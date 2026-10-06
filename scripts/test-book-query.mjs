import assert from 'node:assert/strict'
import test from 'node:test'
import { baseTitle, compactKey, normalizeBookQuery, queryTerms, rankByTitle, titleRelevance } from '../src/services/bookQuery.ts'

test('book-title marks and full-width punctuation become spaces', () => {
  assert.equal(normalizeBookQuery('  思考，快与慢 '), '思考 快与慢')
  assert.equal(normalizeBookQuery('《思考，快与慢》'), '思考 快与慢')
  assert.equal(normalizeBookQuery('「三体」　刘慈欣'), '三体 刘慈欣')
  assert.equal(normalizeBookQuery('Thinking, Fast and Slow'), 'Thinking Fast and Slow')
  assert.equal(normalizeBookQuery('ＡＢＣ：红楼梦（程甲本）'), 'ABC 红楼梦 程甲本')
  // 词内的撇号、连字符、点保留; 词首尾的去掉
  assert.equal(normalizeBookQuery("A Wizard's Tale - Spider-Man vol.2 'quoted'"), "A Wizard's Tale Spider-Man vol.2 quoted")
  assert.equal(normalizeBookQuery(' ，《》 '), '')
  assert.deepEqual(queryTerms('Pride, and PREJUDICE'), ['pride', 'and', 'prejudice'])
})

test('compact keys and base titles ignore punctuation, editions and file extensions', () => {
  assert.equal(compactKey('思考，快与慢'), compactKey('思考 快与慢'))
  assert.equal(compactKey('Thinking, Fast & Slow'), 'thinkingfastslow')
  assert.equal(baseTitle('活着 (余华)'), '活着')
  assert.equal(baseTitle('三体（全集）.epub'), '三体')
  assert.equal(baseTitle('紅樓夢 (四庫全書本) [精校]'), '紅樓夢')
  assert.equal(baseTitle('(序)'), '(序)')
})

test('title relevance: exact > prefix > contains all terms > unrelated', () => {
  assert.equal(titleRelevance('思考，快与慢', '思考 快与慢'), 3)
  assert.equal(titleRelevance('活着 (余华)', '活着'), 3)
  assert.equal(titleRelevance('Pride and prejudice', 'Pride and Prejudice'), 3)
  assert.equal(titleRelevance('三体全集（全三册）', '三体'), 2)
  assert.equal(titleRelevance('Thinking, Fast and Slow - Daniel Kahneman', 'thinking fast and slow'), 2)
  assert.equal(titleRelevance('我能活着，全靠校花们续命！', '活着'), 1)
  assert.equal(titleRelevance('Daniel Kahneman Thinking, Fast And Slow', 'Thinking, Fast and Slow'), 1)
  assert.equal(titleRelevance('三青体（北京）体育科技', '三体'), 0)
  assert.equal(titleRelevance('anything', ' ，'), 0)
})

test('ranking is stable within a tier and lets author matches count', () => {
  const books = [
    { title: '文学 鲁迅先生纪念特辑', author: '文学社' },
    { title: '呐喊', author: '鲁迅' },
    { title: '鲁迅全集', author: '' },
    { title: '无关', author: '' },
    { title: '回忆鲁迅', author: '' },
  ]
  assert.deepEqual(rankByTitle(books, '鲁迅', b => b.title).map(b => b.title), ['鲁迅全集', '文学 鲁迅先生纪念特辑', '回忆鲁迅', '呐喊', '无关'])
  assert.deepEqual(rankByTitle(books, '鲁迅', b => b.title, b => b.author).map(b => b.title), ['鲁迅全集', '文学 鲁迅先生纪念特辑', '呐喊', '回忆鲁迅', '无关'])
})
