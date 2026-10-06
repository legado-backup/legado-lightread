/**
 * 私有书库 (自建 / 需登录的 OPDS 目录) 的纯逻辑:
 *  - 解析服务端给出的「连接信息」文本, 自动填写书源表单
 *  - 从目录链接中找出搜索入口 (直接模板 或 OpenSearch 描述文档)
 *  - 填充搜索模板
 *  - 多种获取格式时 EPUB 优先
 * 不依赖 DOM / 网络 / i18n, 由 scripts/test-opds-library.mjs 做契约测试。
 */

// ---------------------------------------------------------------------------
// 连接信息
// ---------------------------------------------------------------------------

export interface ConnectionInfo {
  title?: string
  url?: string
  username?: string
  password?: string
}

const FIELD_KEYS: Array<[keyof ConnectionInfo, RegExp]> = [
  ['title', /^(?:名称|书源名称|书库名称|名字|name|title)$/i],
  ['url', /^(?:地址|书源地址|书库地址|网址|链接|opds|opds\s*地址|url|address|server|opds\s*url)$/i],
  ['username', /^(?:用户名|用户|账号|帐号|username|user\s*name|user|login)$/i],
  ['password', /^(?:密码|口令|password|pass|pwd)$/i],
]

/** 把 URL 里内嵌的 user:pass@ 拆出来 (浏览器 fetch 不接受带凭据的 URL) */
export function splitUrlCredentials(raw: string): { url: string; username?: string; password?: string } {
  const value = raw.trim()
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return { url: value }
  }
  if (!parsed.username && !parsed.password) return { url: value }
  const username = decodeURIComponent(parsed.username) || undefined
  const password = decodeURIComponent(parsed.password) || undefined
  parsed.username = ''
  parsed.password = ''
  return { url: parsed.href, username, password }
}

function cleanUrl(value: string): string {
  return value.trim().replace(/^[<（(「『"'`]+|[>）)」』"'`。，,;；]+$/g, '').trim()
}

/**
 * 解析形如
 *   名称：我的书库 / 地址：https://… / 用户名：… / 密码：…
 * 的连接信息 (全角/半角冒号, 中英文字段名均可)。
 * 至少识别出地址才返回结果, 否则返回 null。
 */
export function parseConnectionText(text: string): ConnectionInfo | null {
  if (!text) return null
  const info: ConnectionInfo = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/^[\s>*•·\-–—]+/, '').trim()
    if (!line) continue
    const m = /^([^:：=]{1,24}?)\s*[:：=]\s*(.*)$/.exec(line)
    if (!m) continue
    const key = m[1].trim().replace(/[*_`]/g, '')
    const value = m[2].trim()
    const field = FIELD_KEYS.find(([, re]) => re.test(key))?.[0]
    if (!field || !value || info[field] !== undefined) continue
    info[field] = field === 'url' ? cleanUrl(value) : value
  }
  // 没有带标签的地址时, 取文本里第一个 http(s) 链接
  if (!info.url) {
    const bare = /https?:\/\/[^\s<>"'，。；]+/i.exec(text)
    if (bare) info.url = cleanUrl(bare[0])
  }
  if (!info.url || !/^https?:\/\//i.test(info.url)) return null
  const split = splitUrlCredentials(info.url)
  info.url = split.url
  if (!info.username && split.username) info.username = split.username
  if (!info.password && split.password) info.password = split.password
  return info
}

/** 粘贴内容是否像连接信息 (而不只是一个网址): 多行且识别出地址和至少另一项 */
export function looksLikeConnectionText(text: string): boolean {
  if (!/\n/.test(text.trim())) return false
  const info = parseConnectionText(text)
  if (!info) return false
  return Boolean(info.title || info.username || info.password)
}

// ---------------------------------------------------------------------------
// 搜索入口
// ---------------------------------------------------------------------------

export interface FeedLink {
  href?: string | null
  type?: string | null
  rel?: string | string[] | null
}

export type SearchLink =
  | { kind: 'template'; template: string }
  | { kind: 'opensearch'; url: string }

const relsOf = (link: FeedLink): string[] =>
  (Array.isArray(link.rel) ? link.rel : String(link.rel ?? '').split(/\s+/)).filter(Boolean)

/**
 * 相对地址解析, 但保留 {searchTerms} 这类模板变量
 * (new URL 会把路径里的花括号转义成 %7B…%7D, 模板就失效了)。
 */
export function resolveTemplateHref(href: string, base: string): string {
  const vars: string[] = []
  const masked = href.replace(/\{[^{}]*\}/g, v => {
    vars.push(v)
    return `__lrtpl${vars.length - 1}__`
  })
  let resolved: string
  try {
    resolved = new URL(masked, base).href
  } catch {
    resolved = masked
  }
  return resolved.replace(/__lrtpl(\d+)__/g, (_, i) => vars[Number(i)] ?? '')
}

const isOpenSearchType = (type: string) => /opensearchdescription/i.test(type)
const isAtomOrOpdsType = (type: string) =>
  /atom\+xml|opds\+json|opds-catalog/i.test(type)

/**
 * 从目录的链接里找搜索入口:
 *  - href 含 {searchTerms} → 直接模板 (按目录地址解析相对路径)
 *  - type 是 application/opensearchdescription+xml → 需要再取描述文档
 * 多个候选时: 直接模板 > OpenSearch 描述 > 其它 rel=search。
 */
export function findSearchLink(links: FeedLink[] | undefined, baseUrl: string): SearchLink | null {
  const candidates = (links ?? []).filter(l => l.href && relsOf(l).includes('search'))
  const template = candidates.find(l => /\{searchTerms\??\}/.test(l.href!))
  if (template) return { kind: 'template', template: resolveTemplateHref(template.href!, baseUrl) }
  const osd = candidates.find(l => isOpenSearchType(l.type ?? ''))
    ?? candidates.find(l => !isAtomOrOpdsType(l.type ?? ''))
  if (osd) return { kind: 'opensearch', url: resolveTemplateHref(osd.href!, baseUrl) }
  return null
}

/** 把 SearchLink 压平成旧接口里的 searchUrl 字符串 (模板或描述文档地址) */
export const searchLinkUrl = (link: SearchLink | null) =>
  link ? (link.kind === 'template' ? link.template : link.url) : undefined

const TEMPLATE_DEFAULTS: Record<string, string> = {
  count: '50',
  startIndex: '1',
  startPage: '1',
  language: '*',
  inputEncoding: 'UTF-8',
  outputEncoding: 'UTF-8',
}

/**
 * 填充 OpenSearch 模板: {searchTerms} 为关键词; 常见参数用默认值;
 * 其余可选参数 ({x?}) 和带命名空间的参数清空。
 */
export function fillSearchTemplate(template: string, query: string): string {
  return template.replace(/\{(?:([^}:]+):)?([^}?]+)(\?)?\}/g, (_, prefix, name, optional) => {
    if (!prefix && name === 'searchTerms') return encodeURIComponent(query)
    if (prefix || optional) return ''
    return encodeURIComponent(TEMPLATE_DEFAULTS[name] ?? '')
  })
}

/**
 * OpenSearch 描述里 indexOffset / pageOffset 决定起始序号,
 * 发现模板时就把必填的 {startIndex} / {startPage} 定下来。
 */
export function applyOpenSearchOffsets(template: string, indexOffset?: string | null, pageOffset?: string | null) {
  return template
    .replace(/\{startIndex\}/g, indexOffset?.trim() || '1')
    .replace(/\{startPage\}/g, pageOffset?.trim() || '1')
}

/**
 * 从 OpenSearch 描述文档的 <Url> 列表里选模板:
 * 优先 OPDS/Atom 结果, 其次任意 Atom, 再次第一个。
 */
export function pickOpenSearchUrl<T extends { type?: string | null; template?: string | null }>(urls: T[]): T | undefined {
  const usable = urls.filter(u => u.template)
  return usable.find(u => /opds-catalog/i.test(u.type ?? ''))
    ?? usable.find(u => /atom\+xml/i.test(u.type ?? ''))
    ?? usable[0]
}

// ---------------------------------------------------------------------------
// 获取格式
// ---------------------------------------------------------------------------

export interface Acquisition {
  href: string
  type: string
  label: string
}

const TYPE_LABELS: Array<[RegExp, string]> = [
  [/epub\+zip/i, 'EPUB'],
  [/x-mobi8-ebook|vnd\.amazon\.(?:ebook|mobi8-ebook)|azw3/i, 'AZW3'],
  [/x-mobipocket/i, 'MOBI'],
  [/fb2/i, 'FB2'],
  [/pdf/i, 'PDF'],
  [/text\/plain/i, 'TXT'],
]

const EXT_LABELS: Record<string, string> = {
  epub: 'EPUB', azw: 'AZW', azw3: 'AZW3', mobi: 'MOBI', fb2: 'FB2', pdf: 'PDF', txt: 'TXT',
}

/**
 * 获取链接的格式标签; 无法识别 (不可读) 时返回 null。
 * MIME 不明确 (octet-stream / 缺省) 时按链接扩展名推断。
 */
export function acquisitionLabel(type: string | null | undefined, href = ''): string | null {
  const mime = (type ?? '').trim()
  let path = href
  try {
    path = new URL(href, 'http://x/').pathname
  } catch { /* 用原文 */ }
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase()
  // Amazon's generic MIME covers both AZW and AZW3. Preserve an explicit filename.
  if (/vnd\.amazon\.ebook/i.test(mime) && (ext === 'azw' || ext === 'azw3')) return EXT_LABELS[ext]!
  const byType = TYPE_LABELS.find(([re]) => re.test(mime))?.[1]
  if (byType) return byType
  if (mime && !/octet-stream|binary|zip$|download/i.test(mime)) return null
  return (ext && EXT_LABELS[ext]) || null
}

/** 重排友好的格式优先: EPUB 最好, PDF/TXT 兜底 */
const FORMAT_RANK = ['EPUB', 'AZW3', 'AZW', 'MOBI', 'FB2', 'PDF', 'TXT']
export const acquisitionRank = (label: string) => {
  const i = FORMAT_RANK.indexOf(label.toUpperCase())
  return i < 0 ? FORMAT_RANK.length : i
}

/** 按格式优先级稳定排序并按 href 去重 */
export function sortAcquisitions<T extends Acquisition>(acqs: T[]): T[] {
  const seen = new Set<string>()
  return acqs
    .filter(a => (seen.has(a.href) ? false : (seen.add(a.href), true)))
    .map((a, i) => ({ a, i }))
    .sort((x, y) => acquisitionRank(x.a.label) - acquisitionRank(y.a.label) || x.i - y.i)
    .map(x => x.a)
}

/** 主下载按钮用哪个格式 (EPUB 优先), 其余作为备选 */
export function pickPrimaryAcquisition<T extends Acquisition>(acqs: T[]): { primary?: T; others: T[] } {
  const [primary, ...others] = sortAcquisitions(acqs)
  return { primary, others }
}

// ---------------------------------------------------------------------------
// 其它
// ---------------------------------------------------------------------------

/** 统一搜书里参与搜索的「我的书库」: 用户自己添加的 OPDS 书源 */
export function userOpdsSources<T extends { kind: string; builtin: boolean }>(sources: T[]): T[] {
  return sources.filter(s => s.kind === 'opds' && !s.builtin)
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TimeoutError'
  }
}

/**
 * 给异步任务加超时; 超时时调用 onTimeout (通常是 AbortController.abort),
 * 并以 TimeoutError 拒绝, 不影响其它并行任务。
 */
export function withTimeout<T>(task: Promise<T>, ms: number, message: string, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.()
      reject(new TimeoutError(message))
    }, ms)
  })
  return Promise.race([task, timeout]).finally(() => clearTimeout(timer))
}
