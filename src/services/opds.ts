/** OPDS 目录客户端: 基于 foliate-js 的协议解析 */
import { getFeed, SYMBOL } from 'foliate-js/opds.js'
import { fetchXml, fetchBlob, type RequestAuth } from './net'
import { detectFormat } from './format'
import { importFile } from './importer'
import { t } from '../i18n'
import {
  acquisitionLabel, applyOpenSearchOffsets, fillSearchTemplate, findSearchLink, pickOpenSearchUrl,
  resolveTemplateHref, searchLinkUrl, sortAcquisitions, type SearchLink,
} from './privateLibrary.ts'

export { fillSearchTemplate }

export interface OpdsNavItem {
  title: string
  href: string
  summary?: string
}

export interface OpdsPubLink {
  href: string
  type?: string
  rel?: string | string[]
}

export interface OpdsPublication {
  title: string
  author: string
  summary?: string
  coverUrl?: string
  /** 可下载的获取链接 (已过滤出可读格式) */
  acquisitions: Array<{ href: string; type: string; label: string }>
}

export interface OpdsPage {
  title: string
  navigation: OpdsNavItem[]
  publications: OpdsPublication[]
  /** 下一页链接 (分页目录) */
  next?: string
  /** OpenSearch 搜索模板 (含 {searchTerms}) 或描述文档地址 */
  searchUrl?: string
  /** 结构化的搜索入口 (见 privateLibrary.findSearchLink) */
  search?: SearchLink
}

const resolve = (base: string, href?: string) => {
  if (!href) return ''
  try {
    return new URL(href, base).href
  } catch {
    return href
  }
}

function flattenText(value: any): string {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(flattenText).filter(Boolean).join(', ')
  if (typeof value === 'object') return value.name ?? value.value ?? ''
  return ''
}

function toPublication(pub: any, baseUrl: string): OpdsPublication {
  const links: OpdsPubLink[] = pub.links ?? []
  const acquisitions: OpdsPublication['acquisitions'] = []
  for (const link of links) {
    const rels = Array.isArray(link.rel) ? link.rel : [link.rel ?? '']
    const isAcq = rels.some((r: string) => r?.includes('acquisition'))
    if (!isAcq || !link.href) continue
    const type = link.type ?? ''
    const label = acquisitionLabel(type, link.href)
    // 只保留能读的格式
    if (!label) continue
    acquisitions.push({ href: resolve(baseUrl, link.href), type, label })
  }
  const summaryContent = pub.metadata?.[SYMBOL.CONTENT]
  const summary = typeof summaryContent === 'object'
    ? summaryContent?.value ?? ''
    : summaryContent ?? ''
  const coverHref = pub.images?.[0]?.href
  return {
    title: flattenText(pub.metadata?.title),
    author: flattenText(pub.metadata?.author),
    summary: summary ? String(summary).replace(/<[^>]+>/g, '').slice(0, 400) : undefined,
    coverUrl: coverHref ? resolve(baseUrl, coverHref) : undefined,
    // 多种格式时 EPUB 排最前, 主下载按钮取第一个
    acquisitions: sortAcquisitions(acquisitions),
  }
}

export async function loadOpdsPage(url: string, auth?: RequestAuth, signal?: AbortSignal): Promise<OpdsPage> {
  const doc = await fetchXml(url, auth, signal ? { signal } : undefined)
  const feed = getFeed(doc)

  const navigation: OpdsNavItem[] = []
  const publications: OpdsPublication[] = []

  const collect = (items: any[] | undefined) => {
    for (const item of items ?? []) {
      if (item.metadata) {
        publications.push(toPublication(item, url))
      } else if (item.href) {
        navigation.push({
          title: item.title ?? item.href,
          href: resolve(url, item.href),
          summary: item[SYMBOL.SUMMARY] ? String(item[SYMBOL.SUMMARY]).slice(0, 200) : undefined,
        })
      }
    }
  }
  collect(feed.navigation)
  collect(feed.publications)
  for (const group of feed.groups ?? []) {
    collect(group.navigation)
    collect(group.publications)
  }

  const links: OpdsPubLink[] = feed.links ?? []
  const findRel = (want: string) => links.find(l => {
    const rels = Array.isArray(l.rel) ? l.rel : [l.rel ?? '']
    return rels.includes(want)
  })
  const next = findRel('next')?.href
  const search = findSearchLink(links, url)

  return {
    title: flattenText(feed.metadata?.title) || url,
    navigation,
    publications,
    next: next ? resolve(url, next) : undefined,
    searchUrl: searchLinkUrl(search),
    search: search ?? undefined,
  }
}

/**
 * 把 searchUrl 变成可填充的模板: 已是模板直接返回;
 * 否则当作 OpenSearch 描述文档, 带上书源的鉴权去取 (私有书库的描述文档同样要登录)。
 */
export async function discoverSearchTemplate(searchUrl: string, auth?: RequestAuth, signal?: AbortSignal): Promise<string> {
  if (/\{searchTerms\??\}/.test(searchUrl)) return searchUrl
  const doc = await fetchXml(searchUrl, auth, signal ? { signal } : undefined)
  const urls = Array.from(doc.getElementsByTagNameNS('*', 'Url')).map(el => ({
    type: el.getAttribute('type'),
    template: el.getAttribute('template'),
    indexOffset: el.getAttribute('indexOffset'),
    pageOffset: el.getAttribute('pageOffset'),
  }))
  const picked = pickOpenSearchUrl(urls)
  if (!picked?.template) throw new Error(t('catalog.noSearchTemplate'))
  return resolveTemplateHref(
    applyOpenSearchOffsets(picked.template, picked.indexOffset, picked.pageOffset),
    searchUrl,
  )
}

export interface SearchableSource {
  id: string
  url: string
  username?: string
  password?: string
}

/** 每个书源发现到的搜索模板 (内存缓存; null = 此书源不支持搜索) */
const searchTemplateCache = new Map<string, Promise<string | null>>()
const templateCacheKey = (s: SearchableSource) => `${s.id}\n${s.url}\n${s.username ?? ''}`

export function forgetSearchTemplate(sourceId?: string) {
  for (const key of [...searchTemplateCache.keys()]) {
    if (!sourceId || key.startsWith(`${sourceId}\n`)) searchTemplateCache.delete(key)
  }
}

/** 取书源根目录, 找到搜索入口并解析成模板; 失败不缓存, 下次重试 */
export function sourceSearchTemplate(source: SearchableSource, signal?: AbortSignal): Promise<string | null> {
  const key = templateCacheKey(source)
  const cached = searchTemplateCache.get(key)
  if (cached) return cached
  const auth = { username: source.username, password: source.password }
  const task = (async () => {
    const root = await loadOpdsPage(source.url, auth, signal)
    if (!root.searchUrl) return null
    return discoverSearchTemplate(root.searchUrl, auth, signal)
  })()
  searchTemplateCache.set(key, task)
  task.catch(() => searchTemplateCache.delete(key))
  return task
}

/** 在一个 (可能需要登录的) OPDS 书源里搜索; 返回 null 表示该书源没有搜索入口 */
export async function searchOpdsSource(source: SearchableSource, query: string, signal?: AbortSignal): Promise<OpdsPage | null> {
  const template = await sourceSearchTemplate(source, signal)
  if (!template) return null
  return loadOpdsPage(fillSearchTemplate(template, query), {
    username: source.username, password: source.password,
  }, signal)
}

/** 下载出版物并导入藏书, 书目元数据优先于文件内嵌元数据 */
export async function downloadToLibrary(
  pub: OpdsPublication,
  acq: OpdsPublication['acquisitions'][number],
  sourceTitle: string,
  auth?: RequestAuth,
  kind?: 'book' | 'paper',
) {
  const { blob, contentType } = await fetchBlob(acq.href, auth)
  const htmlMime = /^(?:text\/html|application\/xhtml\+xml)(?:\s*;|\s*$)/i
  const expectsHtml = htmlMime.test(acq.type.trim()) || /^(?:html?|xhtml)$/i.test(acq.label.trim())
  if (!expectsHtml) {
    // 部分源的登录/验证页也返回 200，不能按 EPUB/PDF 等格式交给导入器。
    // 仅检查开头，避免将 TXT 正文中的 HTML 示例误判为网页响应。
    const prefix = (await blob.slice(0, 4096).text()).trimStart()
      .replace(/^<\?xml\b[\s\S]*?\?>\s*/i, '')
      .replace(/^(?:<!--[\s\S]*?-->\s*)+/, '')
    const looksHtml = /^(?:<!doctype\s+html\b|<(?:html|head|body)(?:\s|>))/i.test(prefix)
    if (htmlMime.test(contentType.trim()) || looksHtml) {
      throw new Error(t('catalog.downloadReturnedWebpage'))
    }
  }
  // 从 URL 或 MIME 推断文件名
  let ext = acq.label.toLowerCase()
  if (ext === 'mobi') ext = 'mobi'
  if (/epub/.test(contentType)) ext = 'epub'
  const clean = pub.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'book'
  const file = new File([blob], `${clean}.${ext}`, { type: contentType })
  if (!detectFormat(file.name)) throw new Error('下载的文件格式无法识别')
  const result = await importFile(file, sourceTitle, {
    title: pub.title,
    author: pub.author,
    description: pub.summary,
    kind,
  })
  if (!result.ok) throw new Error(result.error)
  return result
}

/**
 * 古登堡计划搜索适配 (供统一搜书):
 * 其 search.opds 根层返回的是导航 (分组 / 单本书节点), 而非直接的出版物 —
 * 逐层跟随: 根层出版物 → 书节点列表 → titles 分组, 并行拉取书节点详情。
 */
export async function searchGutenberg(query: string, limit = 20): Promise<OpdsPublication[]> {
  const searchUrl = `https://www.gutenberg.org/ebooks/search.opds/?query=${encodeURIComponent(query)}`
  const root = await loadOpdsPage(searchUrl)
  if (root.publications.length) return root.publications.slice(0, limit)

  const bookNode = (href: string) => /\/ebooks\/\d+\.opds/.test(href)
  let bookLinks = root.navigation.filter(n => bookNode(n.href))
  if (!bookLinks.length) {
    const titles = root.navigation.find(n => n.href.includes('/ebooks/titles/'))
    if (titles) {
      const next = await loadOpdsPage(titles.href)
      if (next.publications.length) return next.publications.slice(0, limit)
      bookLinks = next.navigation.filter(n => bookNode(n.href))
    }
  }
  const pubs: OpdsPublication[] = []
  await Promise.all(bookLinks.slice(0, limit).map(async n => {
    try {
      const detail = await loadOpdsPage(n.href)
      if (detail.publications[0]) pubs.push(detail.publications[0])
    } catch { /* 单本失败忽略 */ }
  }))
  return pubs
}
