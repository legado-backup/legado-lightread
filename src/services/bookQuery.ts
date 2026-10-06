/**
 * 统一搜书的查询归一与标题相关度 (纯函数, 各公开书源共用)。
 *  - normalizeBookQuery: 去掉书名号、全角标点等, 「思考，快与慢」「《三体》」与「思考 快与慢」「三体」同义
 *  - titleRelevance: 0 不相关 / 1 包含全部关键词 / 2 以查询开头 / 3 书名完全一致
 */

/** 作为分隔符处理的标点 (中英文); 词内的 ' - . & + # 保留 */
const SEPARATORS = /[\s,，、;；:：!！?？。…—–~～·•/\\|"“”‘’「」『』《》〈〉【】〔〕（）()［］\[\]{}｛｝<>＜＞]+/gu

export function normalizeBookQuery(raw: string): string {
  return raw.normalize('NFKC')
    .replace(SEPARATORS, ' ')
    // 词首词尾的撇号/连字符/点 (如 'quoted' 或 "- 作者") 不是书名的一部分
    .replace(/(^|\s)['\-.]+|['\-.]+(?=\s|$)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

export function queryTerms(raw: string): string[] {
  return normalizeBookQuery(raw).toLowerCase().split(' ').filter(Boolean)
}

/** 只保留字母与数字, 用于「同一个书名」判定 */
export function compactKey(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/** 去掉末尾的版本/作者括注与文件扩展名: 「活着 (余华)」「三体（全集）.epub」 → 「活着」「三体」 */
export function baseTitle(title: string): string {
  let base = title.normalize('NFKC').trim().replace(/\.(epub|pdf|mobi|azw3?|txt|fb2|djvu|cbz|md|html?)$/i, '')
  for (let i = 0; i < 3; i++) {
    const next = base.replace(/\s*[(\[][^()\[\]]*[)\]]\s*$/, '').trim()
    if (next === base || !next) break
    base = next
  }
  return base
}

export function titleRelevance(title: string, query: string): number {
  const q = compactKey(query)
  if (!q) return 0
  const full = compactKey(title)
  const base = compactKey(baseTitle(title))
  if (base === q || full === q) return 3
  // 「三体全集」「活着-余华」: 以查询开头
  if (base.startsWith(q) || full.startsWith(q)) return 2
  const lower = title.normalize('NFKC').toLowerCase()
  const terms = queryTerms(query)
  return terms.length && terms.every(term => lower.includes(term) || full.includes(compactKey(term))) ? 1 : 0
}

/**
 * 稳定排序: 相关度高的在前, 同级保持书源原有顺序。
 * authorOf: 作者名包含全部关键词时至少算 1 级 (按作者搜「鲁迅」时, 《呐喊》不该排在纪念文章之后)。
 */
export function rankByTitle<T>(items: T[], query: string, titleOf: (item: T) => string, authorOf?: (item: T) => string): T[] {
  const terms = queryTerms(query)
  const byAuthor = (item: T) => {
    const author = authorOf?.(item).normalize('NFKC').toLowerCase()
    return author && terms.length && terms.every(term => author.includes(term)) ? 1 : 0
  }
  return items
    .map((item, index) => ({ item, index, score: Math.max(titleRelevance(titleOf(item), query), byAuthor(item)) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(entry => entry.item)
}
