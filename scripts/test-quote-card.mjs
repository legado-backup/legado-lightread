/**
 * 金句卡片的纯函数 (src/services/quoteCard.ts): 中文断行禁则、长词切分、截断、字号、配色、
 * 中文日期、竖排书名分列与文件名. 绘制部分在浏览器里由 e2e 覆盖.
 *
 *   npm run test:quote-card
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  wrapText, tokenize, clampQuote, quoteFontSize, cardPalette, luminance, chineseDate, verticalColumns,
  cardFileName, dateParts, CARD_MAX_CHARS, CARD_BACKGROUNDS, CARD_TEMPLATES, TEMPLATE_DEFAULT_BG, TEMPLATE_DEFAULT_FONT,
  parseBackground, cardHeight, layoutLines, layoutLinesInfo, splitClauses, cardBookTitle, cardAuthor,
} from '../src/services/quoteCard.ts'

/** 中日文字宽 1, 其余 0.5 */
const measure = s => [...s].reduce((w, c) => w + (/[⺀-￯]/.test(c) ? 1 : 0.5), 0)

test('tokenize keeps latin words together and splits CJK per char', () => {
  assert.deepEqual(tokenize('读 Plato 的 Republic.'), ['读', ' ', 'Plato', ' ', '的', ' ', 'Republic.'])
})

test('wraps CJK by width', () => {
  assert.deepEqual(wrapText('一二三四五六七八九十', 4, measure), ['一二三四', '五六七八', '九十'])
})

test('closing punctuation hangs at line end instead of starting a line', () => {
  const lines = wrapText('一二三四。五六', 4, measure)
  assert.deepEqual(lines, ['一二三四。', '五六'])
  for (const line of wrapText('甲乙丙丁，戊己庚辛。壬癸子丑！', 4, measure)) assert.doesNotMatch(line, /^[，。！]/)
})

test('opening brackets move to the next line with their character', () => {
  assert.deepEqual(wrapText('一二三《四五》', 4, measure), ['一二三', '《四五》'])
  assert.deepEqual(wrapText('甲乙丙“丁', 4, measure), ['甲乙丙', '“丁'])
})

test('latin words wrap at spaces, overly long words split', () => {
  assert.deepEqual(wrapText('aa bb cc', 2, measure), ['aa', 'bb', 'cc'])
  assert.deepEqual(wrapText('abcdefghij', 2, measure), ['abcd', 'efgh', 'ij'])
})

test('keeps paragraphs and drops trailing blank lines', () => {
  assert.deepEqual(wrapText('一二\n三四\n', 4, measure), ['一二', '三四'])
  assert.deepEqual(wrapText('', 4, measure), [''])
})

test('clamps very long quotes and normalizes whitespace', () => {
  const r = clampQuote('字'.repeat(CARD_MAX_CHARS + 50))
  assert.equal(r.clipped, true)
  assert.ok(r.text.endsWith('……'))
  assert.equal([...r.text].length, CARD_MAX_CHARS + 2)
  assert.deepEqual(clampQuote('  a \t b\n\n\nc  '), { text: 'a b\nc', clipped: false })
})

test('font size shrinks as the quote grows and follows the size option', () => {
  const sizes = [10, 50, 100, 200, 400, 800].map(n => quoteFontSize('字'.repeat(n)))
  for (let i = 1; i < sizes.length; i++) assert.ok(sizes[i] <= sizes[i - 1])
  assert.ok(quoteFontSize('短句', 'lg') > quoteFontSize('短句') && quoteFontSize('短句', 'sm') < quoteFontSize('短句'))
})

test('palette picks readable ink for light and dark backgrounds', () => {
  assert.equal(cardPalette('#ffffff').dark, false)
  assert.equal(cardPalette('#2a2b2e').dark, true)
  for (const bg of CARD_BACKGROUNDS) {
    const p = cardPalette(bg)
    const [a, b] = [luminance(p.ink), luminance(p.bg)].sort((x, y) => y - x)
    assert.ok((a + 0.05) / (b + 0.05) >= 4.5, `contrast on ${bg}`)
    const [m1, m2] = [luminance(p.muted), luminance(p.bg)].sort((x, y) => y - x)
    assert.ok((m1 + 0.05) / (m2 + 0.05) >= 3, `muted contrast on ${bg}`)
  }
})

test('chinese dates and date parts', () => {
  assert.equal(chineseDate(new Date(2026, 9, 31).getTime()), '二〇二六年十月三十一日')
  assert.equal(chineseDate(new Date(2030, 0, 5).getTime()), '二〇三〇年一月五日')
  assert.equal(chineseDate(new Date(2026, 11, 20).getTime()), '二〇二六年十二月二十日')
  assert.deepEqual(dateParts(new Date(2026, 9, 31).getTime()), { day: '31', monthYear: 'OCTOBER 2026', weekday: '星期六', dotted: '2026.10.31' })
})

test('vertical title columns split at punctuation and cap columns', () => {
  assert.deepEqual(verticalColumns('中国社会各阶层分析', 4), ['中国社会', '各阶层分', '析'])
  assert.deepEqual(verticalColumns('非暴力沟通：疗愈关系的正向沟通法', 5), ['非暴力沟通', '疗愈关系的', '正向沟通法'])
  assert.deepEqual(verticalColumns('一二三四五六七八九十甲乙丙丁戊己', 5), ['一二三四五', '六七八九十', '甲乙丙丁…'])
  assert.deepEqual(verticalColumns('《理想国》', 5), ['理想国'])
})

test('card file name', () => {
  assert.equal(cardFileName('理想国 / 卷一', new Date(2026, 9, 31, 8, 5, 9).getTime()), 'LightRead-理想国 卷一-20261031-080509.png')
})

test('backgrounds: solid and two-stop gradients parse, invalid falls back', () => {
  assert.deepEqual(parseBackground('#ffffff'), ['#ffffff'])
  assert.deepEqual(parseBackground('#fde8e4,#e8eefc'), ['#fde8e4', '#e8eefc'])
  assert.deepEqual(parseBackground('red'), ['#f6f1e7'])
  assert.equal(cardPalette('#0f1630,#2a2f5c').dark, true)
  assert.equal(cardPalette('#fde8e4,#e8eefc').dark, false)
})

test('every layout has a default background and font; ratios map to 1080 wide sizes', () => {
  assert.equal(CARD_TEMPLATES.length, 15)
  assert.equal(new Set(CARD_TEMPLATES).size, CARD_TEMPLATES.length)
  for (const tpl of CARD_TEMPLATES) {
    assert.ok(parseBackground(TEMPLATE_DEFAULT_BG[tpl]).length >= 1, tpl)
    assert.ok(['serif', 'sans', 'kai', 'smiley'].includes(TEMPLATE_DEFAULT_FONT[tpl]), tpl)
  }
  assert.deepEqual(['3:4', '1:1', '9:16'].map(cardHeight), [1440, 1080, 1920])
})

test('splitClauses keeps punctuation and closing quotes with the clause', () => {
  assert.deepEqual(splitClauses('人生若只如初见，何事秋风悲画扇。'), ['人生若只如初见，', '何事秋风悲画扇。'])
  assert.deepEqual(splitClauses('他说：“走吧。”然后'), ['他说：', '“走吧。”', '然后'])
})

test('layoutLines breaks at clause punctuation instead of mid-phrase', () => {
  // 贪心在宽 10 时会断成「人生若只如初见，何事 / 秋风悲画扇。」
  assert.deepEqual(layoutLines('人生若只如初见，何事秋风悲画扇。', 10, measure), ['人生若只如初见，', '何事秋风悲画扇。'])
  assert.deepEqual(layoutLines('学而时习之，不亦说乎？有朋自远方来，不亦乐乎？', 12, measure), ['学而时习之，不亦说乎？', '有朋自远方来，不亦乐乎？'])
})

test('layoutLines balances prose without leaving a one-character widow', () => {
  const text = '一二三四五六七八九十一二三四五六七八九十一'
  assert.deepEqual(wrapText(text, 10, measure).at(-1), '一')
  const lines = layoutLines(text, 10, measure)
  assert.equal(lines.length, 3)
  for (const l of lines) assert.ok([...l].length >= 6, l)
})

test('layoutLines falls back when a clause is wider than the line, and keeps paragraphs', () => {
  const lines = layoutLines('一二三四五六七八九十一二，三', 6, measure)
  for (const l of lines) assert.ok(measure(l) <= 7, l)
  assert.deepEqual(layoutLines('甲乙。\n丙丁。', 10, measure), ['甲乙。', '丙丁。'])
})

test('layoutLinesInfo flags short verse that cannot break at punctuation', () => {
  assert.equal(layoutLinesInfo('人生若只如初见，何事秋风悲画扇。', 6, measure).rough, true)
  assert.equal(layoutLinesInfo('人生若只如初见，何事秋风悲画扇。', 10, measure).rough, false)
  // 长句无法按句读排时不要求缩字号
  assert.equal(layoutLinesInfo('一二三四五六七八九十一二三四五六七八九十，好', 8, measure).rough, false)
})

test('card titles drop trailing bracket notes, authors keep the first name', () => {
  assert.equal(cardBookTitle('理想国 (商务汉译世界学术名著丛书)'), '理想国')
  assert.equal(cardBookTitle('掌控习惯（樊登读书倾力推荐）【第2版】'), '掌控习惯')
  assert.equal(cardBookTitle('（注）'), '（注）')
  assert.equal(cardBookTitle('Sapiens: A Brief History'), 'Sapiens: A Brief History')
  assert.equal(cardAuthor('柏拉图; 郭斌和 译'), '柏拉图')
  assert.equal(cardAuthor('  '), undefined)
})

test('layout order: the six user-picked layouts come first', () => {
  assert.deepEqual(CARD_TEMPLATES.slice(0, 6), ['aurora', 'glass', 'poster', 'manuscript', 'notebook', 'paper'])
})
