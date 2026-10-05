/**
 * 仿生阅读 (实验, 默认关) 的区间计算, 纯函数 (docs/reading-modes.md §3.3 §5.6)。
 *
 * - 西文「词首强调」: 不加粗 (::highlight 不能改字重, 改字重也会重排), 而是词首约 40% 的字母保持正文色,
 *   其余字母降到正文色的 70% (对比度样式)。这里只返回要降色的「词尾」区间。
 * - 中文「分词交替着色」: Intl.Segmenter('zh', word) 分词, 只给长度 ≥2 的词着色, 相邻着色词交替
 *   正文色 / 混合色 (这里只返回混合色那一半); 单字词保持正文色, 降低分词错误的干扰 (Pan 2024: 错误边界有害)。
 *   ICU 会把「图书馆」「人工智能」切开, 用一张常见三、四字词的合并表做最长匹配。
 *
 * 研究显示这两种做法都不能让大多数人读得更快 (reading-modes.md §2.2), 界面上如实说明。
 */

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const LATIN_LETTER_RE = /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}]/u

/** 常见三、四字词: ICU 词典常切开的那些 (只合并相邻且拼起来完全一致的片段) */
export const ZH_MERGE_WORDS: ReadonlySet<string> = new Set([
  // 场所、机构
  '图书馆', '博物馆', '美术馆', '体育馆', '展览馆', '纪念馆', '大使馆', '电影院', '研究院', '科学院', '医学院', '研究所',
  '派出所', '实验室', '办公室', '会议室', '教研室', '火车站', '汽车站', '飞机场', '停车场', '运动场', '幼儿园', '动物园',
  '植物园', '游乐园', '大学生', '研究生', '中学生', '小学生', '留学生', '毕业生', '委员会', '董事会', '联合国',
  // 器物、科技
  '计算机', '互联网', '因特网', '电视机', '收音机', '照相机', '洗衣机', '摄像头', '出租车', '自行车', '摩托车', '救护车',
  '数据库', '操作系统', '应用程序', '人工智能', '机器学习', '深度学习', '神经网络', '大数据', '区块链', '云计算',
  '智能手机', '笔记本', '显微镜', '望远镜', '温度计', '高速公路', '地铁站',
  // 学科、概念
  '经济学', '心理学', '社会学', '哲学家', '科学家', '文学家', '艺术家', '数学家', '物理学', '化学家', '生物学', '历史学',
  '世界观', '人生观', '价值观', '方法论', '唯物主义', '资本主义', '社会主义', '共产主义', '现代化', '全球化', '城市化',
  '自然科学', '社会科学', '人文科学', '中华民族', '传统文化', '可持续', '知识分子', '基础设施', '生态系统',
  // 常用词组
  '为什么', '怎么样', '不知道', '没关系', '对不起', '有时候', '一会儿', '差不多', '无论如何', '总而言之', '换句话说',
  '实际上', '事实上', '一方面', '另一方面', '与此同时', '在这里', '这时候', '那时候', '一下子', '不得不', '越来越',
  '一点儿', '有意思', '不一定', '大部分', '小部分', '各种各样', '乱七八糟', '莫名其妙', '自言自语', '一模一样',
  '实事求是', '一心一意', '全心全意', '千方百计', '不知不觉', '迫不及待', '津津有味', '兴高采烈', '恍然大悟',
  '小说家', '主人公', '男主角', '女主角', '老百姓', '年轻人', '老年人', '中年人', '孩子们', '同学们', '朋友们',
])

/** 词首保留几个字母 (参照常见注视长度表): 1–3 个字母保留 1 个, 更长的保留约 40% */
export function headLength(letters: number): number {
  if (letters <= 0) return 0
  if (letters <= 3) return 1
  return Math.ceil(letters * 0.4)
}

function segmenter(lang: string, granularity: 'word' | 'grapheme'): Intl.Segmenter | null {
  try { return new Intl.Segmenter(lang || 'zh', { granularity }) } catch { return null }
}

/** 西文词 (偏移 base 处的字符串) 的词尾区间: 词首 headLength 个字素之后到词尾 */
function tailOf(word: string, base: number, graph: Intl.Segmenter | null): [number, number] | null {
  const gs = graph ? Array.from(graph.segment(word), g => ({ i: g.index, s: g.segment })) : Array.from(word, (s, i) => ({ i, s }))
  const letterIdx = gs.filter(g => /[\p{L}\p{N}]/u.test(g.s))
  if (letterIdx.length < 2) return null
  const head = headLength(letterIdx.length)
  if (head >= letterIdx.length) return null
  const cut = letterIdx[head].i
  return [base + cut, base + word.length]
}

export interface GuideSpans {
  /** 中文着色词 (混合色那一半) */
  alt: Array<[number, number]>
  /** 西文词尾 (降到 70%) */
  tail: Array<[number, number]>
}

/**
 * 计算一段文本的着色区间。style: auto 按每个片段的文字类型选规则; alternate 只做中文; fixation 只做西文。
 * parityStart 让跨文本节点调用时交替不断档 (返回值 parity 为下一次的起点)。
 */
export function guideSpans(
  text: string,
  lang = 'zh',
  opts: { style?: 'auto' | 'alternate' | 'fixation'; merge?: ReadonlySet<string>; parityStart?: number } = {},
): GuideSpans & { parity: number } {
  const style = opts.style ?? 'auto'
  const merge = opts.merge ?? ZH_MERGE_WORDS
  const out: GuideSpans = { alt: [], tail: [] }
  let parity = opts.parityStart ?? 0
  const word = segmenter(lang, 'word')
  const graph = segmenter(lang, 'grapheme')
  if (!word) return { ...out, parity }
  const segs = Array.from(word.segment(text), s => ({ index: s.index, segment: s.segment, isWordLike: !!s.isWordLike }))
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]
    if (!seg.isWordLike) continue
    if (CJK_RE.test(seg.segment)) {
      if (style === 'fixation') continue
      // 最长匹配合并: 从 i 开始拼接至多 4 个相邻词片段, 拼成合并表里的词就并为一个
      let end = i
      let str = seg.segment
      let best = i
      let acc = seg.segment
      for (let j = i + 1; j < segs.length && j <= i + 3; j++) {
        if (!segs[j].isWordLike || !CJK_RE.test(segs[j].segment) || segs[j].index !== segs[j - 1].index + segs[j - 1].segment.length) break
        acc += segs[j].segment
        if ([...acc].length > 7) break
        if (merge.has(acc)) {
          best = j
          str = acc
        }
      }
      end = best
      const start = seg.index
      const len = [...str].length
      i = end
      if (len < 2) continue
      if (parity % 2 === 1) out.alt.push([start, start + str.length])
      parity++
    } else if (LATIN_LETTER_RE.test(seg.segment)) {
      if (style === 'alternate') continue
      const tail = tailOf(seg.segment, seg.index, graph)
      if (tail) out.tail.push(tail)
    }
  }
  return { ...out, parity }
}
