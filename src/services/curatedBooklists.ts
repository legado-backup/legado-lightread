/**
 * 推荐书单: 应用自带 (src/data/booklists/*.json) + 远程更新 (仓库 main 分支同一目录, 欢迎 PR).
 * 流程与 GitHub 社区书源清单一致: 24 小时缓存, 远程清单日期更新才采用, 拉取失败回退自带数据.
 * 来源政策与格式见 docs/booklists.md.
 */
import { fetchRemote } from './net'
import { parseCuratedIndex, validateCuratedList, type CuratedList } from './booklists'
import bundledIndexJson from '../data/booklists/index.json'

const bundledFiles = import.meta.glob('../data/booklists/*.json', { eager: true, import: 'default' }) as Record<string, unknown>

/** 书单目录 (仓库网页, 「推荐书单」按钮打开它) */
export const CURATED_LIST_PAGE = 'https://github.com/yzfly/LightRead/tree/main/src/data/booklists'
const CURATED_RAW_BASE = 'https://raw.githubusercontent.com/yzfly/LightRead/main/src/data/booklists/'
const CACHE_KEY = 'lightread-curated-booklists'
const CACHE_TTL = 24 * 60 * 60 * 1000

export interface CuratedCollection {
  lists: CuratedList[]
  /** 清单日期 (index.json 的 updated) */
  updated: string
  /** 是否来自远程 (或有效远程缓存); false = 应用自带 */
  fromRemote: boolean
}

function loadBundled(): CuratedCollection {
  const index = parseCuratedIndex(bundledIndexJson)
  const byId = new Map<string, CuratedList>()
  for (const [path, data] of Object.entries(bundledFiles)) {
    if (path.endsWith('/index.json')) continue
    const list = validateCuratedList(data)
    if (list && path.endsWith(`/${list.id}.json`)) byId.set(list.id, list)
  }
  const order = index?.lists ?? [...byId.keys()].sort()
  return {
    lists: order.map(id => byId.get(id)).filter((list): list is CuratedList => !!list),
    updated: index?.updated ?? '',
    fromRemote: false,
  }
}

export const BUNDLED_CURATED = loadBundled()

function readCache(): (CuratedCollection & { at: number }) | undefined {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) ?? '')
    const lists = Array.isArray(cached.lists)
      ? cached.lists.map(validateCuratedList).filter((list: CuratedList | null): list is CuratedList => !!list)
      : []
    if (typeof cached.updated === 'string') {
      return { lists, updated: cached.updated, fromRemote: true, at: Number(cached.at) || 0 }
    }
  } catch { /* 无缓存 */ }
}

/** 远程清单比自带的新才采用 (同日期以自带为准: 安装包可能先于 main 分支更新) */
function select(candidate?: CuratedCollection): CuratedCollection {
  if (candidate?.lists.length && candidate.updated > BUNDLED_CURATED.updated) return candidate
  return BUNDLED_CURATED
}

async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetchRemote(url, undefined, { headers: { accept: 'application/json' }, signal })
  return response.json()
}

/** 拉取推荐书单: 24 小时缓存; force 跳过缓存; 失败回退缓存或自带数据 */
export async function fetchCuratedLists(force = false): Promise<CuratedCollection> {
  const cached = readCache()
  if (!force && cached && cached.at > Date.now() - CACHE_TTL) return select(cached)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const index = parseCuratedIndex(await fetchJson(`${CURATED_RAW_BASE}index.json`, controller.signal))
    if (index) {
      const newer = index.updated > BUNDLED_CURATED.updated
        && !(cached?.lists.length && cached.updated >= index.updated)
      if (!newer) {
        // 远程没有更新的: 记下检查时间, 继续用现有数据 (较新的缓存或自带)
        const keep = cached?.lists.length ? cached : undefined
        writeCache({ lists: keep?.lists ?? [], updated: keep?.updated ?? index.updated })
        return select(keep)
      }
      const bundledById = new Map(BUNDLED_CURATED.lists.map(list => [list.id, list]))
      const lists: CuratedList[] = []
      // 逐个拉取 (最多 4 个并发); 单个失败时用自带的同名书单顶上
      const queue = [...index.lists]
      const results = new Map<string, CuratedList>()
      await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
        for (let id = queue.shift(); id; id = queue.shift()) {
          try {
            const list = validateCuratedList(await fetchJson(`${CURATED_RAW_BASE}${id}.json`, controller.signal))
            if (list && list.id === id) results.set(id, list)
          } catch { /* 用自带的 */ }
        }
      }))
      for (const id of index.lists) {
        const list = results.get(id) ?? bundledById.get(id)
        if (list) lists.push(list)
      }
      if (lists.length) {
        const remote = { lists, updated: index.updated, fromRemote: true }
        writeCache(remote)
        return select(remote)
      }
    }
  } catch { /* 网络失败 */ } finally {
    clearTimeout(timer)
  }
  return select(cached)
}

function writeCache(data: { lists: CuratedList[]; updated: string }) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ...data, at: Date.now() }))
  } catch { /* 存储配额不足不影响本次结果 */ }
}
