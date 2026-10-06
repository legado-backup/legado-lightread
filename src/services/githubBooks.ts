/**
 * GitHub 书库搜索: 拉取书库仓库的完整文件树 (Git Trees API, 无需登录),
 * 本地按关键词过滤书籍文件, 点选后经 raw 直链下载导入。
 * 未登录接口限流 60 次/小时/IP, 文件树按仓库缓存 24 小时。
 */
import { fetchRemote } from './net'
import { detectFormat } from './format'
import { compactKey, queryTerms, titleRelevance } from './bookQuery'
import bundledSources from '../../booksources.json'

export interface GithubBookHit {
  repo: string
  /** 仓库内完整路径 */
  path: string
  /** 文件名 */
  name: string
  /** 字节数 */
  size: number
  /** raw 下载直链 */
  url: string
}

interface TreeCacheEntry {
  at: number
  files: Array<{ path: string; size: number }>
  truncated: boolean
}

const CACHE_PREFIX = 'lightread-ghtree-v2-'
const CACHE_TTL = 24 * 60 * 60 * 1000

// Bound requests across simultaneous searches as well as within one search.
let activeRequests = 0
const requestQueue: Array<() => void> = []
async function requestGithub<T>(url: string, read: (response: Response) => Promise<T>): Promise<T> {
  if (activeRequests < 4) activeRequests++
  else await new Promise<void>(resolve => requestQueue.push(resolve))
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)
  try {
    const response = await fetchRemote(url, undefined, {
      headers: { accept: 'application/vnd.github+json' },
      signal: controller.signal,
    })
    return await read(response)
  } finally {
    clearTimeout(timeout)
    const next = requestQueue.shift()
    if (next) next()
    else activeRequests--
  }
}

/** owner/repo 合法性 */
export function isValidRepo(repo: string): boolean {
  return /^[a-zA-Z0-9][\w.-]*\/[a-zA-Z0-9_.-]+$/.test(repo.trim())
    && !repo.trim().split('/').some(part => part === '.' || part === '..')
}

function validFilePath(path: unknown): path is string {
  return typeof path === 'string' && !!path && !/[\\\x00-\x1f]/.test(path)
    && !path.split('/').some(part => !part || part === '.' || part === '..')
}

function includedPath(repo: string, path: string): boolean {
  const include = activeSources.get(repo.toLowerCase())?.include
  return !include?.length || include.some(pattern => {
    const regex = pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')
    return new RegExp(`^${regex}$`, 'i').test(path)
  })
}

async function fetchRepoTree(repo: string): Promise<TreeCacheEntry> {
  const key = CACHE_PREFIX + repo.toLowerCase()
  try {
    const cached: TreeCacheEntry = JSON.parse(localStorage.getItem(key) ?? '')
    if (cached.at > Date.now() - CACHE_TTL && Array.isArray(cached.files)
      && cached.files.every(file => validFilePath(file.path) && Number.isFinite(file.size))) return cached
  } catch { /* 无缓存 */ }

  const data = await requestGithub(`https://api.github.com/repos/${repo}/git/trees/HEAD?recursive=1`, response => response.json())
  if (!Array.isArray(data.tree)) throw new Error('Invalid GitHub file tree')
  const candidates = data.tree.filter((n: any) => n.type === 'blob' && n.mode !== '120000'
    && validFilePath(n.path) && detectFormat(n.path) && includedPath(repo, n.path)
    && Number.isFinite(n.size) && n.size > 0)
  const files: TreeCacheEntry['files'] = []
  for (const node of candidates) {
    // A binary ebook recorded as a tiny blob may actually be a Git LFS pointer.
    // Do not fetch short README/Markdown/TXT files while indexing a repository.
    const format = detectFormat(node.path)
    if (node.size <= 1024 && format && !['txt', 'md', 'html'].includes(format)) {
      try {
        const content = await requestGithub(`https://raw.githubusercontent.com/${repo}/HEAD/${encodePath(node.path)}`, response => response.text())
        if (/^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\n/.test(content)) continue
      } catch { continue /* A candidate that cannot be fetched is not offered as a book. */ }
    }
    files.push({ path: node.path, size: node.size })
  }
  const entry: TreeCacheEntry = { at: Date.now(), files, truncated: !!data.truncated }
  try {
    localStorage.setItem(key, JSON.stringify(entry))
  } catch { /* 缓存写满则放弃, 不影响功能 */ }
  return entry
}

/** 路径分段编码, 保留斜杠 */
function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

export interface GithubSearchResult {
  hits: GithubBookHit[]
  /** 拉取失败的仓库及原因 */
  errors: Array<{ repo: string; message: string }>
  /** 超大仓库文件树被 GitHub 截断 */
  truncated: boolean
}

/** 多仓库搜索; 关键词空格分隔 (标点视同空格), 匹配路径和书库说明 (不区分大小写) */
export async function searchGithubBooks(repos: string[], keyword: string): Promise<GithubSearchResult> {
  const terms = queryTerms(keyword)
  const result: GithubSearchResult = { hits: [], errors: [], truncated: false }
  const uniqueRepos = [...new Map(repos.map(repo => [repo.trim().toLowerCase(), repo.trim()])).values()]
  await Promise.all(uniqueRepos.map(async repo => {
    try {
      if (!isValidRepo(repo)) throw new Error('Invalid GitHub repository')
      const tree = await fetchRepoTree(repo)
      if (tree.truncated) result.truncated = true
      for (const file of tree.files) {
        if (!includedPath(repo, file.path)) continue
        const lower = `${file.path} ${activeSources.get(repo.toLowerCase())?.note ?? ''}`.normalize('NFKC').toLowerCase()
        // 文件名常把「思考，快与慢」写成「思考快与慢」: 去掉标点空格后再比一次
        const compact = compactKey(lower)
        if (terms.length && !terms.every(term => lower.includes(term) || compact.includes(compactKey(term)))) continue
        result.hits.push({
          repo,
          path: file.path,
          name: file.path.split('/').pop() ?? file.path,
          size: file.size,
          url: `https://raw.githubusercontent.com/${repo}/HEAD/${encodePath(file.path)}`,
        })
      }
    } catch (e: any) {
      result.errors.push({ repo, message: e?.message ?? String(e) })
    }
  }))
  // 书名一致的排最前 (「活着.epub」先于「活着活着就老了.epub」), 只在路径/说明里命中的排后面
  const score = (hit: GithubBookHit) => terms.length ? titleRelevance(hit.name, keyword) : 0
  result.hits = result.hits
    .map(hit => ({ hit, score: score(hit) }))
    .sort((a, b) => b.score - a.score || a.hit.name.localeCompare(b.hit.name, 'zh'))
    .map(entry => entry.hit)
  return result
}

export const fmtBytes = (n: number) =>
  n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(0)} KB` : `${n} B`

// ---- 社区书源清单 (GitHub 共建) ----

export interface CommunityRepo {
  repo: string
  note?: string
  /** Optional file globs; * matches within one path segment. */
  include?: string[]
}

/** 解析清单 JSON (远程与内置共用) */
function parseSourceList(data: any): { repos: CommunityRepo[]; updated: string } {
  const repos: CommunityRepo[] = (Array.isArray(data?.githubRepos) ? data.githubRepos : [])
    .filter((r: any) => isValidRepo(String(r?.repo ?? '')))
    .map((r: any) => ({
      repo: String(r.repo).trim(),
      note: r.note ? String(r.note) : undefined,
      include: Array.isArray(r.include) ? r.include.filter((path: unknown) => validFilePath(path)) : undefined,
    }))
  return { repos: [...new Map(repos.map(repo => [repo.repo.toLowerCase(), repo])).values()], updated: String(data?.updated ?? '') }
}

/** 应用自带的清单 (随安装包分发, 即仓库根目录 booksources.json 本体) */
export const BUNDLED_COMMUNITY = parseSourceList(bundledSources)
let activeSources = new Map(BUNDLED_COMMUNITY.repos.map(repo => [repo.repo.toLowerCase(), repo]))

/** 社区清单源文件 (欢迎 PR): https://github.com/yzfly/LightRead/blob/main/booksources.json */
export const COMMUNITY_LIST_PAGE = 'https://github.com/yzfly/LightRead/blob/main/booksources.json'
const COMMUNITY_LIST_RAW = 'https://raw.githubusercontent.com/yzfly/LightRead/main/booksources.json'
const COMMUNITY_CACHE_KEY = 'lightread-community-sources'

export interface CommunityList {
  repos: CommunityRepo[]
  /** 清单日期 (booksources.json 的 updated 字段) */
  updated: string
  /** 本次数据是否来自远程 (或有效远程缓存); false = 回退到应用自带清单 */
  fromRemote: boolean
}

function selectCommunity(candidate?: CommunityList): CommunityList {
  const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
  const useRemote = candidate?.repos.length && validDate(candidate.updated)
    && candidate.updated > BUNDLED_COMMUNITY.updated
  // Same-date bundles also win: a package update may add sources before main is pushed.
  const selected = useRemote ? candidate : { ...BUNDLED_COMMUNITY, fromRemote: false }
  activeSources = new Map(selected.repos.map(repo => [repo.repo.toLowerCase(), repo]))
  return selected
}

function readCommunityCache(): (CommunityList & { at: number }) | undefined {
  try {
    const cached = JSON.parse(localStorage.getItem(COMMUNITY_CACHE_KEY) ?? '')
    const parsed = parseSourceList({ githubRepos: cached.repos, updated: cached.updated })
    if (parsed.repos.length) return { ...parsed, at: Number(cached.at), fromRemote: true }
  } catch { /* No usable cache. */ }
}

/** 拉取社区书源清单: 24 小时缓存; force 跳过缓存; 拉取失败回退应用自带清单 */
export async function fetchCommunityRepos(force = false): Promise<CommunityList> {
  const cached = readCommunityCache()
  if (!force) {
    if (cached && cached.at > Date.now() - CACHE_TTL) return selectCommunity(cached)
  }
  try {
    const { repos, updated } = parseSourceList(await requestGithub(COMMUNITY_LIST_RAW, response => response.json()))
    if (repos.length) {
      const remote = { repos, updated, fromRemote: true }
      const newest = cached && cached.updated > updated ? cached : remote
      try { localStorage.setItem(COMMUNITY_CACHE_KEY, JSON.stringify({ ...newest, at: Date.now() })) } catch { /* Storage quota must not discard fetched results. */ }
      return selectCommunity(newest)
    }
  } catch { /* 网络失败 */ }
  return selectCommunity(cached)
}
