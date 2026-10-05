// 听书句子游标的纯函数契约: 断句 / 偏移换算 / 断点时间分档
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { splitSentences, locateOffset, agoBucket } from '../src/services/readAloud.ts'

const pieces = (text, lang) => splitSentences(text, lang).map(s => text.slice(s.start, s.end))

test('中文按句末标点断句, 引号跟着句子走', () => {
  assert.deepEqual(pieces('他说：“走吧。”她没有回头。风很大！', 'zh'), ['他说：“走吧。”', '她没有回头。', '风很大！'])
})

test('句末的左引号归下一句', () => {
  assert.deepEqual(pieces('他走了。“你来。”她说。', 'zh'), ['他走了。', '“你来。”', '她说。'])
})

test('只有标点的碎片并入前一句, 分隔符不读', () => {
  assert.deepEqual(pieces('第一句。……\n* * *', 'zh'), ['第一句。……'])
  assert.deepEqual(pieces('* * *', 'zh'), [])
})

test('西文按句点断句, 两端空白去掉', () => {
  assert.deepEqual(pieces('  The rain fell. It was cold!  ', 'en'), ['The rain fell.', 'It was cold!'])
})

test('过长无句号的段在逗号处再切, 不切出碎句', () => {
  const clause = '夜色像一块浸了水的墨布慢慢压下来，'
  const text = clause.repeat(20) + '完。'
  const out = pieces(text, 'zh')
  assert.ok(out.length > 1)
  assert.equal(out.join(''), text)
  for (const s of out) assert.ok(s.length <= 160 && s.length >= 20, s.length)
})

test('偏移换算回文本节点, 结束偏移可停在节点末尾', () => {
  const lengths = [3, 0, 4]
  assert.deepEqual(locateOffset(lengths, 0), { node: 0, offset: 0 })
  assert.deepEqual(locateOffset(lengths, 3), { node: 2, offset: 0 })
  assert.deepEqual(locateOffset(lengths, 3, true), { node: 0, offset: 3 })
  assert.deepEqual(locateOffset(lengths, 6), { node: 2, offset: 3 })
  assert.deepEqual(locateOffset(lengths, 99), { node: 2, offset: 4 })
})

test('断点时间分档', () => {
  const now = Date.UTC(2026, 9, 5, 12)
  assert.deepEqual(agoBucket(now - 20_000, now), { kind: 'justNow', n: 0 })
  assert.deepEqual(agoBucket(now - 5 * 60_000, now), { kind: 'minutes', n: 5 })
  assert.deepEqual(agoBucket(now - 3 * 3600_000, now), { kind: 'hours', n: 3 })
  assert.deepEqual(agoBucket(now - 30 * 3600_000, now), { kind: 'yesterday', n: 1 })
  assert.deepEqual(agoBucket(now - 5 * 86400_000, now), { kind: 'days', n: 5 })
})
