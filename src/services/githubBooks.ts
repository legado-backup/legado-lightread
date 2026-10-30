/**
 * GitHub 书库搜索: 拉取书库仓库的完整文件树 (Git Trees API, 无需登录),
 * 本地按关键词过滤书籍文件, 点选后经 raw 直链下载导入。
 * 未登录接口限流 60 次/小时/IP, 文件树按仓库缓存 24 小时。
 *
 * 只搜用户自己添加的仓库 (settings.githubBookRepos, 随设置同步到账号)。应用不内置、不推荐
 * 任何第三方书籍仓库 —— 仓库内容的版权无法由我们核实 (2026-10-30 用户要求下线社区清单与教材源)。
 */
import { fetchRemote } from './net'
import { detectFormat } from './format'
import { compactKey, queryTerms, titleRelevance } from './bookQuery'

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
    && validFilePath(n.path) && detectFormat(n.path)
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

/** 多仓库搜索; 关键词空格分隔 (标点视同空格), 匹配文件路径 (不区分大小写) */
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
        if (!detectFormat(file.path)) continue
        const lower = file.path.normalize('NFKC').toLowerCase()
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
