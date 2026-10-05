// 阅读模式 (打字机) 的纯函数契约: 分词 / 时间表 / 偏移↔时间 / 分行 / 偏移定位 / 速度换算
// node --experimental-strip-types --test scripts/test-reading-modes.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  adjustSpeed,
  buildSchedule,
  clampSpeed,
  dominantScript,
  freshStart,
  groupLines,
  indexAt,
  locate,
  offsetAt,
  sentenceSpans,
  soundEvery,
  speedPresets,
  timeAt,
  tokenize,
} from '../src/services/readingModes/pacing.ts'
import { locateOffset } from '../src/services/readAloud.ts'

const pieces = (text, lang) => sentenceSpans(text, lang).map(([s, e]) => text.slice(s, e))

test('主文字识别: 中文 / 西文 / RTL', () => {
  assert.equal(dominantScript('他慢慢地走进了图书馆。'), 'cjk')
  assert.equal(dominantScript('The quick brown fox jumps over the lazy dog.'), 'latin')
  assert.equal(dominantScript('مرحبا بالعالم'), 'rtl')
  assert.equal(dominantScript('…… —— 123'), 'other')
  // 一个汉字约等于一个词: 中英混排时中文为主
  assert.equal(dominantScript('他用 iPhone 看书，觉得很好。'), 'cjk')
})

test('句子切分: 句末开引号归下一句, 缩写不切开', () => {
  assert.deepEqual(pieces('第一句。第二句！“第三句？”', 'zh'), ['第一句。', '第二句！', '“第三句？”'])
  assert.deepEqual(pieces('Mr. Smith went home. He slept.', 'en'), ['Mr. Smith went home.', 'He slept.'])
  assert.deepEqual(pieces('J. K. Rowling wrote it. Dr. Who? Yes.', 'en'), ['J. K. Rowling wrote it.', 'Dr. Who?', 'Yes.'])
})

test('分词: 汉字每字一个出字单位, 标点和空白不占时间', () => {
  const text = '他说：“走吧。”'
  const toks = tokenize(text, 'zh')
  const weighted = toks.filter(t => t.weight > 0).map(t => text.slice(t.start, t.end))
  assert.deepEqual(weighted, ['他', '说', '走', '吧'])
  const colon = toks.find(t => text.slice(t.start, t.end) === '：')
  assert.equal(colon.pause, 1.5)
  assert.equal(toks.find(t => text.slice(t.start, t.end) === '。').pause, 3)
  assert.equal(toks.find(t => text.slice(t.start, t.end) === '“').open, true)
})

test('分词: 西文按词计时, 词内字母平分; 长词加时; RTL 整词出', () => {
  const text = 'cat extraordinarily'
  const toks = tokenize(text, 'en')
  const cat = toks.filter(t => t.start < 3)
  assert.equal(cat.length, 3)
  assert.ok(Math.abs(cat.reduce((s, t) => s + t.weight, 0) - 1) < 1e-9)
  assert.equal(cat[0].wordStart, true)
  assert.equal(cat[1].wordStart, false)
  const long = toks.filter(t => t.start >= 4 && t.weight > 0)
  // 15 个字母: 1 + (15 - 8) × 0.1 = 1.7
  assert.ok(Math.abs(long.reduce((s, t) => s + t.weight, 0) - 1.7) < 1e-9)
  const ar = tokenize('مرحبا بالعالم', 'ar').filter(t => t.weight > 0)
  assert.equal(ar.length, 2)
  assert.ok(ar.every(t => t.wordStart))
  // wholeWords: 整词一个 token
  assert.equal(tokenize('hello world', 'en', { wholeWords: true }).filter(t => t.weight > 0).length, 2)
})

test('字素: emoji、组合附加符、代理对不被切开, offsetAt 不落在代理对中间', () => {
  const text = '读👍🏽书é𠀀字'
  const toks = tokenize(text, 'zh')
  for (const tok of toks) {
    const code = text.charCodeAt(tok.start)
    assert.ok(!(code >= 0xdc00 && code <= 0xdfff), `token 起点落在低代理项: ${tok.start}`)
  }
  assert.ok(toks.some(t => text.slice(t.start, t.end) === '👍🏽'))
  assert.ok(toks.some(t => text.slice(t.start, t.end) === 'é'))
  assert.ok(toks.some(t => text.slice(t.start, t.end) === '𠀀'))
  const s = buildSchedule(toks, 300)
  for (let ms = 0; ms <= s.total; ms += 7) {
    const off = offsetAt(s, ms)
    const code = text.charCodeAt(off)
    assert.ok(off === text.length || !(code >= 0xdc00 && code <= 0xdfff), `偏移 ${off} 落在代理对中间`)
    assert.ok(off === text.length || text.charCodeAt(off) !== 0x0301, `偏移 ${off} 切开了组合附加符`)
  }
})

test('速度换算: 300 字/分时 60 秒内出 300 个汉字 (关闭标点停顿)', () => {
  const text = '字'.repeat(300)
  const s = buildSchedule(tokenize(text, 'zh'), 300, { punctuationPause: false })
  assert.equal(s.ends.length, 300)
  assert.equal(s.total, 60000)
  assert.equal(offsetAt(s, 0), 1) // 开始即出第一个字
  assert.equal(offsetAt(s, 59999), 300)
  assert.equal(offsetAt(s, 30000), 151)
})

test('标点停顿: 「，」之后的出字点间隔约为单字时长的 2.5 倍', () => {
  const text = '一二，三四。五'
  const s = buildSchedule(tokenize(text, 'zh'), 60) // 单字 1000ms
  // 出字点: 一 / 二， / 三 / 四。 / 五
  assert.deepEqual([...s.ends], [1, 3, 4, 6, 7])
  assert.deepEqual([...s.times], [0, 1000, 3500, 4500, 8500])
  assert.equal(s.times[2] - s.times[1], 2500)
  // 关闭停顿: 匀速
  const flat = buildSchedule(tokenize(text, 'zh'), 60, { punctuationPause: false })
  assert.deepEqual([...flat.times], [0, 1000, 2000, 3000, 4000])
})

test('段末停顿 +4, 原子块 (图片) 停留 1.2 秒, 开引号随后一个字出现', () => {
  const text = '甲乙“丙'
  const toks = tokenize(text, 'zh')
  const s = buildSchedule(toks, 60, { breaks: [2] })
  assert.deepEqual([...s.ends], [1, 2, 4]) // 「“」不并入「乙」, 随「丙」一起出现
  assert.deepEqual([...s.times], [0, 1000, 6000]) // 乙 1000 + 1000 + 段末 4000
  const withAtom = buildSchedule([...toks.slice(0, 2), { start: 2, end: 2, weight: 0, kind: 'atom' }, ...toks.slice(2)], 60, { punctuationPause: false })
  assert.deepEqual([...withAtom.ends], [1, 2, 2, 4])
  assert.deepEqual([...withAtom.times], [0, 1000, 2000, 3200])
})

test('origin: 时间表的偏移加上窗口起点', () => {
  const s = buildSchedule(tokenize('一二', 'zh'), 60, { origin: 100 })
  assert.equal(s.start, 100)
  assert.equal(offsetAt(s, -1), 100)
  assert.deepEqual([...s.ends], [101, 102])
})

test('逐句: 整句一起出现, 停留时间等于这句按速度算出的时长', () => {
  const text = '一二三。四五。'
  const units = sentenceSpans(text, 'zh')
  const s = buildSchedule(tokenize(text, 'zh'), 60, { units, punctuationPause: false })
  assert.deepEqual([...s.ends], [4, 7])
  assert.deepEqual([...s.times], [0, 3000])
  assert.deepEqual([...s.ticks], [1, 1])
  assert.equal(s.total, 5000)
})

test('offsetAt 与 timeAt 单调且互为近似反函数', () => {
  const text = '他说：“走吧。”她没有回头，风很大！Hello, world. 第二段的文字。'
  const s = buildSchedule(tokenize(text, 'zh'), 300, { breaks: [18] })
  let prev = -1
  for (let ms = -10; ms <= s.total + 100; ms += 13) {
    const off = offsetAt(s, ms)
    assert.ok(off >= prev, '偏移单调不减')
    prev = off
    assert.ok(timeAt(s, off) <= Math.max(0, ms), 'timeAt(offsetAt(t)) ≤ t')
  }
  let prevT = -1
  for (let off = 0; off <= text.length; off++) {
    const ms = timeAt(s, off)
    assert.ok(ms >= prevT, '时间单调不减')
    prevT = ms
    assert.ok(offsetAt(s, ms) >= off, 'offsetAt(timeAt(o)) ≥ o')
  }
  assert.equal(indexAt(s, -1), -1)
  assert.equal(timeAt(s, text.length + 10), s.total)
})

test('墨迹未干: 逐字为最近 2 个出字点, 逐句 / 逐行为刚出现的整个单位', () => {
  const s = buildSchedule(tokenize('一二三四', 'zh'), 60, { origin: 10 })
  assert.equal(freshStart(s, 3, 'char'), 12)
  assert.equal(freshStart(s, 0, 'char'), 10)
  assert.equal(freshStart(s, -1, 'char'), 10)
  assert.equal(freshStart(s, 3, 'sentence'), 13)
})

test('groupLines: ruby / 上标造成的 top 抖动不拆行; 换栏回到顶部算新行', () => {
  const lh = 30
  // 第一行含 ruby 基字 (下沉 6px) 与上标 (上浮 8px)
  const tops = [100, 100, 106, 92, 100, 130, 130, 131, 160, 40, 40]
  assert.deepEqual(groupLines(tops, lh), [[0, 5], [5, 8], [8, 9], [9, 11]])
  assert.deepEqual(groupLines([NaN, 10, NaN, 10, 50], 20), [[0, 4], [4, 5]])
  assert.deepEqual(groupLines([], 20), [])
})

test('locate: 跨多个文本节点的偏移、节点边界、空节点', () => {
  const lengths = [3, 0, 2, 4]
  assert.deepEqual(locate(lengths, 0), { node: 0, offset: 0 })
  assert.deepEqual(locate(lengths, 3), { node: 2, offset: 0 }) // 交界归后一个非空节点
  assert.deepEqual(locate(lengths, 3, true), { node: 0, offset: 3 }) // 区间终点归前一个节点末尾
  assert.deepEqual(locate(lengths, 6), { node: 3, offset: 1 })
  assert.deepEqual(locate(lengths, 9), { node: 3, offset: 4 })
  assert.deepEqual(locate(lengths, 99), { node: 3, offset: 4 })
  assert.deepEqual(locate([], 5), { node: 0, offset: 0 })
  assert.deepEqual(locate([0, 0], 0), { node: 1, offset: 0 })
  // 与听书的线性实现逐点一致
  for (let trial = 0; trial < 200; trial++) {
    const ls = Array.from({ length: 1 + (trial % 7) }, (_, i) => ((trial * 7 + i * 13) % 5))
    const total = ls.reduce((a, b) => a + b, 0)
    for (let off = 0; off <= total + 1; off++) {
      for (const pe of [false, true]) assert.deepEqual(locate(ls, off, pe), locateOffset(ls, off, pe), `${ls} @${off} ${pe}`)
    }
  }
})

test('速度: 范围钳制、±10% 取整到 10、快捷档、打字声频率', () => {
  assert.equal(clampSpeed(30, 'cjk'), 60)
  assert.equal(clampSpeed(5000, 'cjk'), 1200)
  assert.equal(clampSpeed(30, 'latin'), 40)
  assert.equal(clampSpeed(900, 'latin'), 800)
  assert.equal(clampSpeed(NaN, 'cjk'), 300)
  assert.equal(adjustSpeed(300, 1), 330)
  assert.equal(adjustSpeed(300, -1), 270)
  assert.equal(adjustSpeed(60, 1), 70) // 至少变化 10
  assert.equal(adjustSpeed(40, -1), 30)
  assert.deepEqual(speedPresets('cjk'), [200, 300, 450])
  assert.deepEqual(speedPresets('latin'), [150, 200, 300])
  assert.equal(soundEvery(300), 1)
  assert.equal(soundEvery(601), 3)
})
