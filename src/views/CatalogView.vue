<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { getStorage, type CatalogSourceRec, isTauri } from '../storage'
import {
  discoverSearchTemplate, downloadToLibrary, fillSearchTemplate, forgetSearchTemplate, loadOpdsPage,
  searchGutenberg, searchOpdsSource,
  type OpdsPage, type OpdsPublication,
} from '../services/opds'
import {
  looksLikeConnectionText, parseConnectionText, pickPrimaryAcquisition, splitUrlCredentials,
  userOpdsSources, withTimeout, type ConnectionInfo,
} from '../services/privateLibrary'
import { readerPath } from '../services/readerRoute'
import { arxivRootPage, arxivSearchUrl, isArxivUrl, loadArxivPage } from '../services/arxiv'
import {
  calibreAvailable, importCalibreBook, listCalibreBooks, pickCalibreLibrary,
  calibreCoverUrl, pickBestFormat, type CalibreBook,
} from '../services/calibre'
import {
  searchGithubBooks, isValidRepo, fmtBytes, fetchCommunityRepos,
  BUNDLED_COMMUNITY, COMMUNITY_LIST_PAGE,
  type GithubBookHit, type CommunityRepo,
} from '../services/githubBooks'
import { openDownload } from '../services/updater'
import { searchWikisource, type WikisourceBook } from '../services/wikisource'
import { searchOpenLibrary, type OpenLibraryBook } from '../services/openLibrary'
import { searchInternetArchive, loadArchivePublication, type ArchiveBook } from '../services/internetArchive'
import { WEB_BOOK_SOURCES, webBookSourceUrl } from '../services/webBookSources'
import { normalizeBookQuery, titleRelevance } from '../services/bookQuery'
import { arxivSearchUrl as arxivSearchUrlOf, loadArxivPage as loadArxivPageOf } from '../services/arxiv'
import { importFromUrl } from '../services/urlImport'
import { useSettings } from '../stores/settings'
import { useLibrary } from '../stores/library'
import { useRouter } from 'vue-router'
import { toast } from '../services/toast'
import { t } from '../i18n'
import LibraryUploadDialog from '../components/LibraryUploadDialog.vue'

const library = useLibrary()
const settings = useSettings()
const router = useRouter()
const uploadTarget = ref<CatalogSourceRec | null>(null)

async function refreshAfterUpload() {
  if (activeSource.value) {
    const current = breadcrumbs.value[breadcrumbs.value.length - 1]
    await openUrl(current?.url ?? activeSource.value.url, current?.title ?? activeSource.value.title, false)
  }
  if (uniSearched.value && !uniSearching.value) await uniSearch()
}

// ---- GitHub 书库: 社区清单 + 用户自加 ----
const communityRepos = ref<CommunityRepo[]>(BUNDLED_COMMUNITY.repos)
const communityUpdated = ref(BUNDLED_COMMUNITY.updated)
const communityFromRemote = ref(false)
const ghImporting = ref('')
const ghProgress = ref('')
const ghRepoDraft = ref('')

const allGhRepos = () => [
  ...new Set([...communityRepos.value.map(r => r.repo), ...settings.githubBookRepos]),
]

async function refreshCommunity(force = false) {
  const result = await fetchCommunityRepos(force)
  communityRepos.value = result.repos
  communityUpdated.value = result.updated
  communityFromRemote.value = result.fromRemote
  if (!force) return
  if (result.fromRemote) {
    toast(t('catalog.communityRefreshed', { n: result.repos.length, date: result.updated }), 'success')
  } else {
    toast(t('catalog.communityRefreshFailed', { date: result.updated }), 'error', 5000)
  }
}

function addGhRepo() {
  const repo = ghRepoDraft.value.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\/$/, '')
  if (!isValidRepo(repo)) {
    toast(t('library.ghRepoInvalid'), 'error')
    return
  }
  if (!settings.githubBookRepos.includes(repo) && !communityRepos.value.some(r => r.repo === repo)) {
    settings.githubBookRepos.push(repo)
  }
  ghRepoDraft.value = ''
}

function removeGhRepo(repo: string) {
  settings.githubBookRepos = settings.githubBookRepos.filter(r => r !== repo)
}

async function importGhBook(hit: GithubBookHit) {
  if (ghImporting.value) return
  ghImporting.value = hit.url
  try {
    const result = await importFromUrl(hit.url, p => {
      ghProgress.value = p.fraction != null
        ? t('library.urlDownloading', { pct: (p.fraction * 100).toFixed(0), mb: p.receivedMB })
        : t('library.urlDownloadingMB', { mb: p.receivedMB })
    })
    if (!result.ok) throw new Error(result.error)
    await library.refresh()
    toast(t('library.importSuccess', { count: 1 }), 'success')
  } catch (e: any) {
    toast(t('library.urlImportFailed', { msg: e?.message ?? e }), 'error', 6000)
  } finally {
    ghImporting.value = ''
    ghProgress.value = ''
  }
}

// ---- 统一搜书: 默认优先免登录的公开图书 ----
const uniQuery = ref('')
const uniScopes = reactive({ github: true, gutenberg: true, archive: true, wikisource: true, openlibrary: false, arxiv: false })
const hasSearchScope = computed(() =>
  Object.values(uniScopes).some(Boolean) || myLibraries.value.some(s => myScopeOn(s.id)))
const uniWikisource = ref<WikisourceBook[]>([])
const uniArchive = ref<ArchiveBook[]>([])
const uniOpenLibrary = ref<OpenLibraryBook[]>([])
const archivePublications = reactive<Record<string, OpdsPublication>>(Object.create(null))
const archiveLoading = reactive(new Set<string>())

async function showArchiveDownloads(book: ArchiveBook) {
  if (archiveLoading.has(book.identifier)) return
  archiveLoading.add(book.identifier)
  try {
    archivePublications[book.identifier] = await loadArchivePublication(book)
  } catch (e: any) {
    toast(t('catalog.loadFailed') + ': ' + (e?.message ?? e), 'error', 6000)
  } finally {
    archiveLoading.delete(book.identifier)
  }
}

function openBookWebsite(url: string) {
  void openDownload(url).catch(e => toast(t('catalog.loadFailed') + ': ' + (e?.message ?? e), 'error'))
}
const uniSearching = ref(false)
const uniSearched = ref(false)
const uniErrors = ref<string[]>([])
const uniGithub = ref<GithubBookHit[]>([])
const uniGutenberg = ref<OpdsPublication[]>([])
const uniArxiv = ref<OpdsPublication[]>([])
let uniSession = 0
/** 本次搜索实际发出的 (归一后的) 关键词, 用于结果分组排序 */
const uniActiveQuery = ref('')

// ---- 各公开书源的状态: 搜索中 / 有结果 / 未找到 / 出错, 分组按结果相关度排序 ----
type UniSource = 'wikisource' | 'archive' | 'github' | 'gutenberg' | 'openlibrary' | 'arxiv'
/** 同等相关度时的默认顺序 */
const UNI_SOURCES: UniSource[] = ['wikisource', 'archive', 'github', 'gutenberg', 'openlibrary', 'arxiv']
const uniStatus = reactive<Record<UniSource, 'idle' | 'loading' | 'done' | 'error'>>({
  wikisource: 'idle', archive: 'idle', github: 'idle', gutenberg: 'idle', openlibrary: 'idle', arxiv: 'idle',
})
const uniSourceName = (key: UniSource) => ({
  wikisource: t('catalog.wikisource'), archive: 'Internet Archive', github: 'GitHub',
  gutenberg: t('catalog.gutenberg'), openlibrary: 'Open Library', arxiv: 'arXiv',
})[key]

function uniTitles(key: UniSource): string[] {
  switch (key) {
    case 'wikisource': return uniWikisource.value.map(b => b.title)
    case 'archive': return uniArchive.value.map(b => b.title)
    case 'github': return uniGithub.value.map(h => h.name)
    case 'gutenberg': return uniGutenberg.value.map(p => p.title)
    case 'openlibrary': return uniOpenLibrary.value.map(b => b.title)
    case 'arxiv': return uniArxiv.value.map(p => p.title)
  }
}

/** 该来源最贴切的一条结果的相关度 (维基文库的繁体书名由站点判定, 其余按书名比对) */
function uniBestRelevance(key: UniSource): number {
  if (key === 'wikisource') return Math.max(0, ...uniWikisource.value.map(b => b.relevance))
  // Open Library 只是书目: 只有能公开阅读/借阅的记录才算数, 免得「暂无电子版」排到可下载的来源前面
  const titles = key === 'openlibrary'
    ? uniOpenLibrary.value.filter(b => b.access === 'public' || b.access === 'borrowable').map(b => b.title)
    : uniTitles(key)
  return Math.max(0, ...titles.slice(0, 10).map(title => titleRelevance(title, uniActiveQuery.value)))
}

/** 有结果的来源按「最贴切结果」排序, 搜索中的排在后面; 未找到的折叠成一行 */
const uniVisibleGroups = computed(() => UNI_SOURCES
  .filter(key => uniScopes[key] && (uniStatus[key] === 'loading' || (uniStatus[key] === 'done' && uniTitles(key).length)))
  .map((key, index) => ({ key, rank: uniStatus[key] === 'loading' ? -1 : uniBestRelevance(key), index }))
  .sort((a, b) => b.rank - a.rank || a.index - b.index)
  .map(entry => entry.key))
const uniEmptySources = computed(() => UNI_SOURCES
  .filter(key => uniScopes[key] && uniStatus[key] === 'done' && !uniTitles(key).length)
  .map(uniSourceName))

/** 「Failed to fetch」对用户没有意义: 说明是连不上, 网页版提示书源代理 */
function sourceErrorText(e: any): string {
  const message = String(e?.message ?? e)
  if (e instanceof TypeError || /failed to fetch|networkerror|load failed|network request failed/i.test(message)) {
    return t(isTauri() || settings.corsProxy.trim() ? 'catalog.sourceUnreachable' : 'catalog.sourceUnreachableWeb')
  }
  return message
}

/** 十几个书库各报一遍同样的错 (多为 GitHub 匿名接口限流) 没有意义: 合并成一句 */
function githubErrorText(errors: Array<{ repo: string; message: string }>): string {
  if (errors.some(x => /\b(403|429)\b|rate limit/i.test(x.message))) return `GitHub: ${t('catalog.githubRateLimited')}`
  const messages = [...new Set(errors.map(x => sourceErrorText({ message: x.message })))]
  return errors.length === 1
    ? `${errors[0]!.repo}: ${messages[0]}`
    : `GitHub: ${t('catalog.githubReposFailed', { n: errors.length })} ${messages.slice(0, 2).join('; ')}`
}

async function uniSearch() {
  const raw = uniQuery.value.trim()
  // 书名号、全角标点等统一成空格: 「《思考，快与慢》」与「思考 快与慢」等价
  const query = normalizeBookQuery(raw)
  if (!query || !hasSearchScope.value) return
  // 同一关键词正在搜索时不重复发起; 换了关键词可以直接重搜, 旧结果按会话丢弃
  if (uniSearching.value && query === uniActiveQuery.value) return
  const session = ++uniSession
  uniActiveQuery.value = query
  uniSearching.value = true
  uniSearched.value = true
  uniWikisource.value = []
  uniArchive.value = []
  uniOpenLibrary.value = []
  uniErrors.value = []
  uniGithub.value = []
  uniGutenberg.value = []
  uniArxiv.value = []
  for (const key of UNI_SOURCES) uniStatus[key] = uniScopes[key] ? 'loading' : 'idle'
  const jobs: Promise<void>[] = []
  // 我的书库 (用户添加的 OPDS 书源) 各自独立搜索: 一个慢/失败不影响其它; 用原始关键词, 交给书库自己的搜索
  myResults.value = myLibraries.value.filter(s => myScopeOn(s.id)).map(source => ({
    source, status: 'loading', error: '', publications: [], loadingMore: false,
  }))
  for (const entry of myResults.value) jobs.push(searchMyLibrary(session, entry, raw))
  /** 每个来源独立: 先到先显示, 失败只影响自己 */
  const run = <T>(key: UniSource, request: () => Promise<T>, apply: (result: T) => void) => {
    jobs.push(request().then(result => {
      if (session !== uniSession) return
      apply(result)
      uniStatus[key] = 'done'
    }).catch(e => {
      if (session !== uniSession) return
      uniStatus[key] = 'error'
      if (e?.message !== '') uniErrors.value.push(`${uniSourceName(key)}: ${sourceErrorText(e)}`)
    }))
  }
  if (uniScopes.github) {
    const repos = allGhRepos()
    run('github', () => searchGithubBooks(repos, query), r => {
      uniGithub.value = r.hits
      if (!r.errors.length) return
      uniErrors.value.push(githubErrorText(r.errors))
      // 全部书库都没取到时是「出错」而不是「未找到」
      if (!r.hits.length && r.errors.length >= new Set(repos.map(repo => repo.toLowerCase())).size) throw new Error('')
    })
  }
  if (uniScopes.gutenberg) run('gutenberg', () => searchGutenberg(query, 24), pubs => { uniGutenberg.value = pubs })
  if (uniScopes.wikisource) run('wikisource', () => searchWikisource(query), books => { uniWikisource.value = books })
  if (uniScopes.archive) run('archive', () => searchInternetArchive(query), books => { uniArchive.value = books })
  if (uniScopes.openlibrary) run('openlibrary', () => searchOpenLibrary(query), books => { uniOpenLibrary.value = books })
  if (uniScopes.arxiv) {
    run('arxiv', () => loadArxivPageOf(arxivSearchUrlOf(query)), p => { uniArxiv.value = (p.publications ?? []).slice(0, 20) })
  }
  await Promise.allSettled(jobs)
  if (session === uniSession) {
    uniSearched.value = true
    uniSearching.value = false
  }
}

// These providers omit CORS headers on downloads. Offer a browser download on Web
// when no proxy is configured, instead of failing an otherwise public download.
const publicDownloadInBrowser = computed(() => !isTauri() && !settings.corsProxy.trim())
function downloadPublicBook(pub: OpdsPublication, acq: OpdsPublication['acquisitions'][number], source: string) {
  if (publicDownloadInBrowser.value) openBookWebsite(acq.href)
  else void uniDownloadPub(pub, acq, source)
}

/** 统一搜书里下载 OPDS/arXiv 出版物 */
async function uniDownloadPub(pub: OpdsPublication, acq: OpdsPublication['acquisitions'][number], sourceTitle: string) {
  if (downloading.value.has(acq.href)) return
  downloading.value.add(acq.href)
  try {
    await downloadToLibrary(pub, acq, sourceTitle, undefined, sourceTitle === 'arXiv' ? 'paper' : undefined)
    await library.refresh()
    toast(t('library.importSuccess', { count: 1 }), 'success')
  } catch (e: any) {
    toast(t('library.urlImportFailed', { msg: e?.message ?? e }), 'error', 6000)
  } finally {
    downloading.value.delete(acq.href)
  }
}

const sources = ref<CatalogSourceRec[]>([])
const activeSource = ref<CatalogSourceRec | null>(null)
const page = ref<OpdsPage | null>(null)
const loading = ref(false)
const loadError = ref('')
const breadcrumbs = ref<Array<{ title: string; url: string }>>([])
const searchQuery = ref('')
const downloading = ref<Set<string>>(new Set())
const appendLoading = ref(false)

// 添加书源
const showAdd = ref(false)
const newTitle = ref('')
const newUrl = ref('')
const newUsername = ref('')
const newPassword = ref('')

const sourceAuth = () => ({
  username: activeSource.value?.username,
  password: activeSource.value?.password,
})

// ---- 我的书库: 统一搜书里同时搜索用户自己添加的 OPDS 书源 (带各自账号) ----
interface MyLibraryResult {
  source: CatalogSourceRec
  status: 'loading' | 'done' | 'error' | 'nosearch'
  error: string
  publications: OpdsPublication[]
  next?: string
  loadingMore: boolean
}
const MY_LIBRARY_SEARCH_TIMEOUT = 25_000
const myLibraries = computed(() => userOpdsSources(sources.value))
/** 搜索范围: 默认全选, 只记录用户关掉的 */
const myScopes = reactive<Record<string, boolean>>({})
const myScopeOn = (id: string) => myScopes[id] !== false
const myResults = ref<MyLibraryResult[]>([])
const fetchingNotice = ref('')
const authOf = (s: CatalogSourceRec) => ({ username: s.username, password: s.password })

function toggleMyScope(id: string, e: Event) {
  myScopes[id] = (e.target as HTMLInputElement).checked
}

async function searchMyLibrary(session: number, entry: MyLibraryResult, query: string) {
  const ctrl = new AbortController()
  try {
    const result = await withTimeout(
      searchOpdsSource(entry.source, query, ctrl.signal),
      MY_LIBRARY_SEARCH_TIMEOUT, t('catalog.searchTimeout'), () => ctrl.abort(),
    )
    if (session !== uniSession) return
    if (!result) {
      entry.status = 'nosearch'
      return
    }
    entry.publications = result.publications
    entry.next = result.next
    entry.status = 'done'
  } catch (e: any) {
    if (session !== uniSession) return
    entry.status = 'error'
    entry.error = e?.message ?? String(e)
  }
}

async function loadMoreMine(entry: MyLibraryResult) {
  if (!entry.next || entry.loadingMore) return
  entry.loadingMore = true
  try {
    const more = await loadOpdsPage(entry.next, authOf(entry.source))
    entry.publications = [...entry.publications, ...more.publications]
    entry.next = more.next
  } catch (e: any) {
    toast(`${t('catalog.loadMoreFailed')}: ${e?.message ?? e}`, 'error', 5000)
  } finally {
    entry.loadingMore = false
  }
}

const primaryAcq = (pub: OpdsPublication) => pickPrimaryAcquisition(pub.acquisitions).primary
const otherAcqs = (pub: OpdsPublication) => pickPrimaryAcquisition(pub.acquisitions).others

/** 同书库、同名且同格式才复用本地书，保留其他格式的下载入口。 */
const importedFromSource = (source: CatalogSourceRec, pub: OpdsPublication) =>
  library.books.find(b => b.source === source.title && b.title === pub.title &&
    b.format.toUpperCase() === primaryAcq(pub)?.label.toUpperCase())

function openLibraryBook(book: { id: string; format: any }) {
  router.push(readerPath(book))
}

/** 一步到位: 下载 (带书库账号) → 导入藏书 → 打开阅读; open=false 时只入库 */
async function getFromMyLibrary(
  entry: MyLibraryResult, pub: OpdsPublication, acq: OpdsPublication['acquisitions'][number], open: boolean,
) {
  if (downloading.value.has(acq.href)) return
  downloading.value.add(acq.href)
  fetchingNotice.value = t('catalog.fetchingBook', { title: entry.source.title })
  try {
    const result = await downloadToLibrary(pub, acq, entry.source.title, authOf(entry.source))
    await library.refresh()
    const book = result.bookId ? library.books.find(b => b.id === result.bookId) : undefined
    if (open && book) openLibraryBook(book)
    else toast(t('catalog.bookImported', { title: pub.title }), 'success')
  } catch (e: any) {
    toast(t('catalog.downloadFailed', { msg: e?.message ?? t('common.unknownError') }), 'error', 6000)
  } finally {
    downloading.value.delete(acq.href)
    if (!downloading.value.size) fetchingNotice.value = ''
  }
}

// ---- 添加书源: 粘贴连接信息自动填表 ----
const connText = ref('')
const connStatus = ref<{ ok: boolean; text: string } | null>(null)

function applyConnection(info: ConnectionInfo) {
  if (info.title) newTitle.value = info.title
  if (info.url) newUrl.value = info.url
  if (info.username) newUsername.value = info.username
  if (info.password) newPassword.value = info.password
  const fields = [
    info.title && t('catalog.name'),
    info.url && t('catalog.opdsUrl'),
    info.username && t('catalog.username'),
    info.password && t('catalog.password'),
  ].filter(Boolean)
  connStatus.value = {
    ok: true,
    text: t('catalog.connectionParsed', { fields: fields.join(settings.language === 'en' ? ', ' : '、') }),
  }
}

/** 手动输入/编辑连接信息时同样识别 (粘贴走 onConnectionPaste) */
watch(connText, text => {
  if (!text.trim()) {
    // 清空输入框不抹掉「已识别」提示, 只清掉报错
    if (connStatus.value && !connStatus.value.ok) connStatus.value = null
    return
  }
  const info = parseConnectionText(text)
  if (info) applyConnection(info)
  else connStatus.value = { ok: false, text: t('catalog.connectionNotRecognized') }
})

/**
 * 粘贴即识别: 识别成功时拦下这次粘贴, 只填表单, 不把含密码的原文留在输入框里。
 * 地址栏 (wholeBlockOnly) 只拦整段连接信息, 单个网址照常粘贴。
 */
function onConnectionPaste(e: ClipboardEvent, wholeBlockOnly: boolean) {
  const text = e.clipboardData?.getData('text') ?? ''
  if (wholeBlockOnly && !looksLikeConnectionText(text)) return
  const info = parseConnectionText(text)
  if (!info) return
  e.preventDefault()
  connText.value = ''
  applyConnection(info)
}

function closeAdd() {
  showAdd.value = false
  connText.value = ''
  connStatus.value = null
}

/** 按书源类型选择加载器 */
function loadPage(url: string) {
  return activeSource.value?.kind === 'arxiv' || isArxivUrl(url)
    ? loadArxivPage(url, sourceAuth())
    : loadOpdsPage(url, sourceAuth())
}

async function refreshSources() {
  const storage = await getStorage()
  sources.value = await storage.listSources()
}

onMounted(() => {
  refreshSources()
  refreshCommunity()
  library.refresh()
  if (settings.calibrePath) refreshCalibre()
})

// ---- Calibre 书库直读 (桌面版) ----
const calibreBooks = ref<CalibreBook[]>([])
const calibreCovers = ref<Record<number, string>>({})
const calibreLoading = ref(false)
const calibreBusy = ref<Set<number>>(new Set())
const calibreBatchBusy = ref(false)

/** 已入库判定: 标题+作者与 Calibre 来源匹配 */
const importedTitles = computed(() => new Set(
  library.books.filter(b => b.source === 'Calibre').map(b => b.title)))

async function connectCalibre() {
  const path = await pickCalibreLibrary()
  if (!path) return
  settings.calibrePath = path
  await refreshCalibre()
}

async function refreshCalibre() {
  if (!settings.calibrePath) return
  calibreLoading.value = true
  try {
    calibreBooks.value = await listCalibreBooks(settings.calibrePath)
    // 封面懒加载: 前 100 本, 4 并发
    const queue = calibreBooks.value.filter(b => b.has_cover).slice(0, 100)
    const workers = Array.from({ length: 4 }, async () => {
      while (queue.length) {
        const book = queue.shift()!
        const url = await calibreCoverUrl(settings.calibrePath, book)
        if (url) calibreCovers.value[book.id] = url
      }
    })
    Promise.all(workers)
  } catch (e: any) {
    toast(e?.message ?? t('catalog.calibreReadFailed'), 'error', 5000)
    calibreBooks.value = []
  } finally {
    calibreLoading.value = false
  }
}

function disconnectCalibre() {
  settings.calibrePath = ''
  calibreBooks.value = []
  for (const url of Object.values(calibreCovers.value)) URL.revokeObjectURL(url)
  calibreCovers.value = {}
}

async function calibreImport(book: CalibreBook, thenOpen = false) {
  if (calibreBusy.value.has(book.id)) return
  calibreBusy.value.add(book.id)
  try {
    const result = await importCalibreBook(settings.calibrePath, book)
    if (!result.ok) throw new Error(result.error)
    await library.refresh()
    if (thenOpen && result.bookId) {
      const imported = library.books.find(b => b.id === result.bookId)
      router.push(imported?.format === 'pdf' ? `/read-paper/${result.bookId}` : `/read/${result.bookId}`)
    } else {
      toast(t('catalog.bookImported', { title: book.title }), 'success')
    }
  } catch (e: any) {
    toast(t('catalog.importFailed', { msg: e?.message }), 'error', 5000)
  } finally {
    calibreBusy.value.delete(book.id)
  }
}

function openImported(book: CalibreBook) {
  const imported = library.books.find(b => b.source === 'Calibre' && b.title === book.title)
  if (!imported) return
  router.push(imported.format === 'pdf' ? `/read-paper/${imported.id}` : `/read/${imported.id}`)
}

async function calibreImportAllNew() {
  const fresh = calibreBooks.value.filter(b => !importedTitles.value.has(b.title) && pickBestFormat(b))
  if (!fresh.length) {
    toast(t('catalog.noNewBooks'))
    return
  }
  if (!confirm(t('catalog.importNewConfirm', { count: fresh.length }))) return
  calibreBatchBusy.value = true
  let ok = 0
  for (const book of fresh) {
    const result = await importCalibreBook(settings.calibrePath, book).catch(() => null)
    if (result?.ok) ok++
  }
  calibreBatchBusy.value = false
  await library.refresh()
  toast(t('catalog.syncDone', { ok, total: fresh.length }), 'success', 4000)
}

async function openUrl(url: string, title: string, pushCrumb = true) {
  loading.value = true
  loadError.value = ''
  try {
    const result = await loadPage(url)
    page.value = result
    if (pushCrumb) breadcrumbs.value.push({ title: title || result.title, url })
  } catch (e: any) {
    loadError.value = e?.message ?? t('catalog.loadFailed')
    if (!isTauri()) {
      loadError.value += t('catalog.corsHint')
    }
  } finally {
    loading.value = false
  }
}

function openSource(s: CatalogSourceRec) {
  activeSource.value = s
  breadcrumbs.value = []
  page.value = null
  if (s.kind === 'arxiv') {
    // arXiv 根页面是本地分类导航, 无需网络请求
    page.value = arxivRootPage()
    breadcrumbs.value.push({ title: s.title, url: 'arxiv-root' })
    return
  }
  openUrl(s.url, s.title)
}

function gotoCrumb(i: number) {
  const crumb = breadcrumbs.value[i]
  breadcrumbs.value = breadcrumbs.value.slice(0, i)
  if (crumb.url === 'arxiv-root') {
    page.value = arxivRootPage()
    breadcrumbs.value.push(crumb)
    return
  }
  openUrl(crumb.url, crumb.title)
}

function backToSources() {
  activeSource.value = null
  page.value = null
  breadcrumbs.value = []
  loadError.value = ''
}

async function runSearch() {
  const query = searchQuery.value.trim()
  if (!query || !page.value?.searchUrl) return
  if (page.value.searchUrl === 'arxiv-search') {
    openUrl(arxivSearchUrl(query), t('catalog.searchCrumb', { query }))
    return
  }
  const template = page.value.searchUrl
  if (template.includes('{searchTerms}')) {
    // 直接内联的 OpenSearch 模板
    openUrl(fillSearchTemplate(template, query), t('catalog.searchCrumb', { query }))
    return
  }
  // 指向 OpenSearch description 文档: 需要登录的书源, 描述文档同样带上账号
  try {
    const resolved = await discoverSearchTemplate(template, sourceAuth())
    openUrl(fillSearchTemplate(resolved, query), t('catalog.searchCrumb', { query }))
  } catch (e: any) {
    toast(t('catalog.searchFailed', { msg: e?.message ?? t('common.unknownError') }), 'error')
  }
}

async function loadMore() {
  if (!page.value?.next || appendLoading.value) return
  appendLoading.value = true
  try {
    const nextPage = await loadPage(page.value.next)
    page.value = {
      ...nextPage,
      title: page.value.title,
      navigation: [...page.value.navigation, ...nextPage.navigation],
      publications: [...page.value.publications, ...nextPage.publications],
      searchUrl: page.value.searchUrl ?? nextPage.searchUrl,
    }
  } catch (e: any) {
    toast(e?.message ?? t('catalog.loadMoreFailed'), 'error')
  } finally {
    appendLoading.value = false
  }
}

async function download(pub: OpdsPublication, acq: OpdsPublication['acquisitions'][number]) {
  const key = acq.href
  if (downloading.value.has(key)) return
  downloading.value.add(key)
  try {
    await downloadToLibrary(
      pub, acq, activeSource.value?.title ?? 'OPDS', sourceAuth(),
      activeSource.value?.kind === 'arxiv' ? 'paper' : undefined,
    )
    await library.refresh()
    toast(t('catalog.bookImported', { title: pub.title }), 'success')
  } catch (e: any) {
    toast(t('catalog.downloadFailed', { msg: e?.message ?? t('common.unknownError') }), 'error', 5000)
  } finally {
    downloading.value.delete(key)
  }
}

async function addSource() {
  // 地址里内嵌的 user:pass@ 拆到账号字段 (浏览器 fetch 不接受带凭据的 URL)
  const split = splitUrlCredentials(newUrl.value)
  const url = split.url
  if (!url) return
  const storage = await getStorage()
  await storage.addSource({
    title: newTitle.value.trim() || url,
    url,
    kind: isArxivUrl(url) ? 'arxiv' : 'opds',
    builtin: false,
    addedAt: Date.now(),
    username: newUsername.value.trim() || split.username || undefined,
    password: newPassword.value || split.password || undefined,
  })
  closeAdd()
  newTitle.value = ''
  newUrl.value = ''
  newUsername.value = ''
  newPassword.value = ''
  await refreshSources()
  toast(t('catalog.sourceAdded'), 'success')
}

async function removeSource(s: CatalogSourceRec) {
  if (!confirm(t('catalog.deleteSourceConfirm', { title: s.title }))) return
  const storage = await getStorage()
  await storage.deleteSource(s.id)
  forgetSearchTemplate(s.id)
  delete myScopes[s.id]
  myResults.value = myResults.value.filter(r => r.source.id !== s.id)
  await refreshSources()
}
</script>

<template>
  <div class="catalog">
    <!-- 书源列表 -->
    <template v-if="!activeSource">
      <header class="toolbar">
        <h1>{{ t('catalog.title') }}</h1>
        <div class="spacer" />
        <button class="btn btn-primary" @click="showAdd = true">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M11 13H5a1 1 0 1 1 0-2h6V5a1 1 0 1 1 2 0v6h6a1 1 0 1 1 0 2h-6v6a1 1 0 1 1-2 0v-6z"/></svg>
          {{ t('catalog.add') }}
        </button>
      </header>
      <!-- 统一搜书: 找书是这一页的主要任务, 放在书源列表之前 -->
      <section class="uni-section card">
        <h2>{{ t('catalog.uniTitle') }}</h2>
        <div class="gh-search-row">
          <input
            v-model="uniQuery"
            class="input"
            type="search"
            :placeholder="t('catalog.uniPlaceholder')"
            :aria-label="t('catalog.uniTitle')"
            @keyup.enter="uniSearch"
          />
          <button class="btn btn-primary" :disabled="uniSearching || !uniQuery.trim() || !hasSearchScope" @click="uniSearch">
            {{ uniSearching ? t('library.ghSearching') : t('library.ghSearch') }}
          </button>
        </div>
        <p class="intro">{{ t('catalog.freeSearchHint') }}<template v-if="myLibraries.length"> {{ t('catalog.privateSearchHint') }}</template></p>
        <div class="uni-scopes">
          <label
            v-for="s in myLibraries"
            :key="s.id"
            class="check-chip mine"
            :class="{ on: myScopeOn(s.id) }"
            :title="t('catalog.myLibraryScope', { title: s.title })"
          >
            <input :checked="myScopeOn(s.id)" :disabled="uniSearching" type="checkbox" @change="toggleMyScope(s.id, $event)" />
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h14V9.5"/><path d="M10 20v-5h4v5"/></svg>
            {{ s.title }}
          </label>
          <label class="check-chip" :class="{ on: uniScopes.wikisource }"><input v-model="uniScopes.wikisource" :disabled="uniSearching" type="checkbox" /> {{ t('catalog.wikisource') }}</label>
          <label class="check-chip" :class="{ on: uniScopes.gutenberg }"><input v-model="uniScopes.gutenberg" :disabled="uniSearching" type="checkbox" /> {{ t('catalog.gutenberg') }}</label>
          <label class="check-chip" :class="{ on: uniScopes.archive }"><input v-model="uniScopes.archive" :disabled="uniSearching" type="checkbox" /> Internet Archive</label>
          <label class="check-chip" :class="{ on: uniScopes.arxiv }"><input v-model="uniScopes.arxiv" :disabled="uniSearching" type="checkbox" /> arXiv</label>
          <label class="check-chip" :class="{ on: uniScopes.openlibrary }"><input v-model="uniScopes.openlibrary" :disabled="uniSearching" type="checkbox" /> Open Library</label>
          <label class="check-chip" :class="{ on: uniScopes.github }"><input v-model="uniScopes.github" :disabled="uniSearching" type="checkbox" /> GitHub</label>
        </div>
        <p v-if="!hasSearchScope" class="intro" role="status">{{ t('catalog.chooseSearchSource') }}</p>
        <div v-if="uniErrors.length" class="gh-notice" role="alert">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M10.3 3.9a2 2 0 0 1 3.4 0l8 13.6A2 2 0 0 1 20 20.5H4a2 2 0 0 1-1.7-3l8-13.6zM12 9a1 1 0 0 0-1 1v4a1 1 0 1 0 2 0v-4a1 1 0 0 0-1-1zm0 9.2a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4z"/></svg>
          {{ uniErrors.join('; ') }}
        </div>
        <div v-if="ghProgress" class="gh-progress" role="status">{{ ghProgress }}</div>
        <div v-if="fetchingNotice" class="gh-progress" role="status">{{ fetchingNotice }}</div>

        <template v-if="uniSearched">
          <p v-if="!uniSearching && (UNI_SOURCES.some(key => uniStatus[key] === 'done') || myResults.some(r => r.status === 'done')) && !myResults.some(r => r.publications.length) && !uniWikisource.length && !uniGithub.length && !uniGutenberg.length && !uniArchive.length && !uniOpenLibrary.length && !uniArxiv.length" class="intro" role="status">{{ t('catalog.noSearchResults') }} {{ t('catalog.copyrightHint') }}</p>
          <!-- 我的书库排在最前 -->
          <div v-for="entry in myResults" :key="entry.source.id" class="uni-group mine-group" :aria-busy="entry.status === 'loading'">
            <div class="uni-group-head">
              <span class="tag mine-tag">{{ t('catalog.myLibrary') }}</span>
              {{ entry.source.title }}
              <template v-if="entry.status === 'done'"> · {{ t('reader.resultCount', { n: entry.next ? `${entry.publications.length}+` : entry.publications.length }) }}</template>
              <template v-else-if="entry.status === 'loading'"> · {{ t('catalog.sourceSearching') }}</template>
            </div>
            <p v-if="entry.status === 'error'" class="uni-group-msg error" role="alert">{{ entry.error }}</p>
            <p v-else-if="entry.status === 'nosearch'" class="uni-group-msg">{{ t('catalog.sourceNoSearch') }}</p>
            <div v-for="(pub, i) in entry.publications" :key="i" class="gh-item uni-pub">
              <span class="gh-name">{{ pub.title }}</span>
              <span class="gh-meta">{{ pub.author || t('common.anonymous') }}</span>
              <span class="uni-acts">
                <button
                  v-if="importedFromSource(entry.source, pub)"
                  class="btn btn-sm btn-primary"
                  @click="openLibraryBook(importedFromSource(entry.source, pub)!)"
                >{{ t('catalog.continueReading') }}</button>
                <template v-else-if="primaryAcq(pub)">
                  <button
                    class="btn btn-sm btn-primary"
                    :disabled="downloading.has(primaryAcq(pub)!.href)"
                    :aria-busy="downloading.has(primaryAcq(pub)!.href)"
                    @click.stop="getFromMyLibrary(entry, pub, primaryAcq(pub)!, true)"
                  >{{ downloading.has(primaryAcq(pub)!.href) ? t('catalog.downloading') : t('catalog.readNow', { label: primaryAcq(pub)!.label }) }}</button>
                  <button
                    v-for="acq in otherAcqs(pub)"
                    :key="acq.href"
                    class="btn btn-sm"
                    :disabled="downloading.has(acq.href)"
                    @click.stop="getFromMyLibrary(entry, pub, acq, false)"
                  >{{ downloading.has(acq.href) ? t('catalog.downloading') : t('catalog.download', { label: acq.label }) }}</button>
                </template>
                <span v-else class="gh-meta">{{ t('catalog.noDownloadFormat') }}</span>
              </span>
            </div>
            <div v-if="entry.next" class="uni-more">
              <button class="btn btn-sm" :disabled="entry.loadingMore" @click="loadMoreMine(entry)">
                {{ entry.loadingMore ? t('common.loading') : t('catalog.loadMore') }}
              </button>
            </div>
          </div>
          <!-- 公开书源: 有结果的按最贴切结果排序, 搜索中的在后, 未找到的折叠成一行 -->
          <template v-for="key in uniVisibleGroups" :key="key">
            <div v-if="key === 'wikisource'" class="uni-group" :aria-busy="uniStatus.wikisource === 'loading'">
              <div class="uni-group-head">{{ t('catalog.wikisource') }} · {{ uniStatus.wikisource === 'loading' ? t('catalog.sourceSearching') : t('reader.resultCount', { n: uniWikisource.length }) }}</div>
              <div v-for="book in uniWikisource" :key="book.id" class="gh-item uni-pub">
                <span class="gh-name">{{ book.title }}</span>
                <span v-if="book.disambiguation" class="gh-meta">{{ t('catalog.wikisourceVersions') }}</span>
                <span v-else-if="book.summary" class="gh-meta">{{ book.summary }}</span>
                <span class="uni-acts">
                  <button v-for="acq in book.publication.acquisitions" :key="acq.href" class="btn btn-sm" :disabled="downloading.has(acq.href)" @click="downloadPublicBook(book.publication, acq, t('catalog.wikisource'))">{{ downloading.has(acq.href) ? t('catalog.downloading') : t(publicDownloadInBrowser ? 'catalog.browserDownload' : 'catalog.download', { label: acq.label }) }}</button>
                  <button v-if="!publicDownloadInBrowser && book.publication.acquisitions[0]" class="btn btn-sm" @click="openBookWebsite(book.publication.acquisitions[0].href)">{{ t('catalog.browserDownload', { label: 'EPUB' }) }}</button>
                  <button class="btn btn-sm" @click="openBookWebsite(book.url)">{{ t('catalog.viewOriginal') }}</button>
                </span>
              </div>
            </div>
            <div v-if="key === 'archive'" class="uni-group" :aria-busy="uniStatus.archive === 'loading'">
              <div class="uni-group-head">Internet Archive · {{ uniStatus.archive === 'loading' ? t('catalog.sourceSearching') : t('reader.resultCount', { n: uniArchive.length }) }}</div>
              <div v-for="book in uniArchive" :key="book.identifier" class="gh-item uni-pub">
                <span class="gh-name">{{ book.title }}</span>
                <span class="gh-meta">{{ book.author || t('common.anonymous') }}<template v-if="book.year"> · {{ book.year }}</template></span>
                <span class="uni-acts">
                  <template v-if="archivePublications[book.identifier]">
                    <button v-for="acq in archivePublications[book.identifier].acquisitions" :key="acq.href" class="btn btn-sm" :disabled="downloading.has(acq.href)" @click="downloadPublicBook(archivePublications[book.identifier], acq, 'Internet Archive')">{{ downloading.has(acq.href) ? t('catalog.downloading') : t(publicDownloadInBrowser ? 'catalog.browserDownload' : 'catalog.download', { label: acq.label }) }}</button>
                    <span v-if="!archivePublications[book.identifier].acquisitions.length" class="gh-meta">{{ t('catalog.noDownloadFormat') }}</span>
                  </template>
                  <button v-else class="btn btn-sm" :disabled="archiveLoading.has(book.identifier)" @click="showArchiveDownloads(book)">{{ archiveLoading.has(book.identifier) ? t('catalog.readingLibrary') : t('catalog.showDownloads') }}</button>
                  <button class="btn btn-sm" @click="openBookWebsite(book.url)">{{ t('catalog.viewOriginal') }}</button>
                </span>
              </div>
            </div>
            <div v-if="key === 'openlibrary'" class="uni-group" :aria-busy="uniStatus.openlibrary === 'loading'">
              <div class="uni-group-head">Open Library · {{ uniStatus.openlibrary === 'loading' ? t('catalog.sourceSearching') : t('reader.resultCount', { n: uniOpenLibrary.length }) }}</div>
              <p class="intro">{{ t('catalog.openlibraryHint') }}</p>
              <div v-for="book in uniOpenLibrary" :key="book.key" class="gh-item uni-pub">
                <span class="gh-name">{{ book.title }}</span>
                <span class="gh-meta">{{ book.author || t('common.anonymous') }}<template v-if="book.year"> · {{ book.year }}</template> · {{ t('catalog.access.' + book.access) }}</span>
                <span class="uni-acts"><button class="btn btn-sm" @click="openBookWebsite(book.url)">{{ t('catalog.viewOriginal') }}</button></span>
              </div>
            </div>
            <div v-if="key === 'github'" class="uni-group" :aria-busy="uniStatus.github === 'loading'">
              <div class="uni-group-head">GitHub · {{ uniStatus.github === 'loading' ? t('catalog.sourceSearching') : t('reader.resultCount', { n: uniGithub.length }) }}</div>
              <div v-for="hit in uniGithub.slice(0, 60)" :key="hit.url" class="gh-item" :class="{ busy: ghImporting === hit.url }" role="button" tabindex="0" @click="importGhBook(hit)" @keydown.enter.prevent="importGhBook(hit)">
                <span class="gh-name">{{ hit.name }}</span>
                <span class="gh-meta">{{ hit.repo }}<template v-if="hit.size"> · {{ fmtBytes(hit.size) }}</template></span>
              </div>
            </div>
            <div v-if="key === 'gutenberg'" class="uni-group" :aria-busy="uniStatus.gutenberg === 'loading'">
              <div class="uni-group-head">{{ t('catalog.gutenberg') }} · {{ uniStatus.gutenberg === 'loading' ? t('catalog.sourceSearching') : t('reader.resultCount', { n: uniGutenberg.length }) }}</div>
              <div v-for="(pub, i) in uniGutenberg" :key="i" class="gh-item uni-pub">
                <span class="gh-name">{{ pub.title }}</span>
                <span class="gh-meta">{{ pub.author || t('common.anonymous') }}</span>
                <span class="uni-acts">
                  <button
                    v-for="acq in pub.acquisitions.slice(0, 2)"
                    :key="acq.href"
                    class="btn btn-sm"
                    :disabled="downloading.has(acq.href)"
                    @click.stop="uniDownloadPub(pub, acq, t('catalog.gutenberg'))"
                  >{{ downloading.has(acq.href) ? t('catalog.downloading') : acq.label }}</button>
                  <span v-if="!pub.acquisitions.length" class="gh-meta">{{ t('catalog.noDownloadFormat') }}</span>
                </span>
              </div>
            </div>
            <div v-if="key === 'arxiv'" class="uni-group" :aria-busy="uniStatus.arxiv === 'loading'">
              <div class="uni-group-head">arXiv · {{ uniStatus.arxiv === 'loading' ? t('catalog.sourceSearching') : t('reader.resultCount', { n: uniArxiv.length }) }}</div>
              <div v-for="(pub, i) in uniArxiv" :key="i" class="gh-item uni-pub">
                <span class="gh-name">{{ pub.title }}</span>
                <span class="gh-meta">{{ pub.author || '' }}</span>
                <span class="uni-acts">
                  <button
                    v-for="acq in pub.acquisitions.slice(0, 1)"
                    :key="acq.href"
                    class="btn btn-sm"
                    :disabled="downloading.has(acq.href)"
                    @click.stop="uniDownloadPub(pub, acq, 'arXiv')"
                  >{{ downloading.has(acq.href) ? t('catalog.downloading') : acq.label }}</button>
                </span>
              </div>
            </div>
          </template>
          <p v-if="uniEmptySources.length && uniVisibleGroups.length" class="intro uni-empty-sources" role="status">{{ t('catalog.notFoundIn', { sources: uniEmptySources.join(settings.language === 'en' ? ', ' : '、') }) }}</p>
        </template>
      </section>

      <p class="intro">
        {{ t('catalog.intro') }}
      </p>
      <div class="source-grid">
        <div
          v-for="s in sources"
          :key="s.id"
          class="source-card card"
          role="button"
          tabindex="0"
          @click="openSource(s)"
          @keydown.enter.prevent="openSource(s)"
          @keydown.space.prevent="openSource(s)"
        >
          <div class="source-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1.5" fill="currentColor" stroke="none"/></svg>
          </div>
          <div class="source-body">
            <div class="source-title">{{ s.title }}</div>
            <div class="source-url">{{ s.url }}</div>
            <div class="source-foot">
              <span v-if="s.builtin" class="tag">{{ t('catalog.builtin') }}</span>
              <template v-else>
                <button v-if="s.kind === 'opds'" class="btn btn-sm" @click.stop="uploadTarget = s" @keydown.stop>{{ t('library.addBooks') }}</button>
                <button class="btn btn-sm btn-danger" @click.stop="removeSource(s)" @keydown.stop>{{ t('common.delete') }}</button>
              </template>
            </div>
          </div>
          <svg class="source-chevron" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M9.3 6.3a1 1 0 0 1 1.4 0l5 5a1 1 0 0 1 0 1.4l-5 5a1 1 0 0 1-1.4-1.4L13.58 12 9.3 7.7a1 1 0 0 1 0-1.4z"/></svg>
        </div>
      </div>

      <section class="web-sources">
        <h2>{{ t('catalog.webSourcesTitle') }}</h2>
        <p class="intro">{{ t('catalog.webSourcesHint') }}</p>
        <div class="source-grid">
          <article v-for="source in WEB_BOOK_SOURCES" :key="source.id" class="card web-source-card">
            <div class="source-title">{{ source.title }}</div>
            <p class="intro">{{ t(source.descriptionKey) }}</p>
            <button class="btn btn-sm" @click="openBookWebsite(webBookSourceUrl(source, uniQuery))">{{ uniQuery.trim() && source.searchUrl ? t('catalog.searchWebsite') : t('catalog.openWebsite') }}</button>
          </article>
        </div>
      </section>

      <!-- GitHub 书源列表 (社区共建) -->
      <section class="gh-section">
        <header class="toolbar">
          <h2>{{ t('catalog.ghListTitle') }}</h2>
          <span class="gh-updated">{{ t('catalog.communityMeta', { date: communityUpdated, n: communityRepos.length }) }}{{ communityFromRemote ? '' : t('catalog.communityBundled') }}</span>
          <div class="spacer" />
          <button class="btn btn-sm" @click="refreshCommunity(true)">{{ t('catalog.updateList') }}</button>
          <button class="btn btn-sm" @click="openDownload(COMMUNITY_LIST_PAGE)">{{ t('catalog.contribute') }}</button>
        </header>
        <p class="intro">{{ t('catalog.ghListIntro') }}</p>
        <div class="gh-repos">
          <span v-for="item in communityRepos" :key="item.repo" class="gh-repo-chip community" :title="item.note ?? ''">
            {{ item.repo }}
          </span>
        </div>
        <div class="gh-repos">
          <span v-for="repo in settings.githubBookRepos" :key="repo" class="gh-repo-chip">
            {{ repo }}
            <button class="gh-repo-del" :title="t('common.delete')" :aria-label="`${t('common.delete')} ${repo}`" @click="removeGhRepo(repo)">
              <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M6.7 5.3a1 1 0 0 0-1.4 1.4L10.6 12l-5.3 5.3a1 1 0 1 0 1.4 1.4l5.3-5.3 5.3 5.3a1 1 0 0 0 1.4-1.4L13.4 12l5.3-5.3a1 1 0 0 0-1.4-1.4L12 10.6 6.7 5.3z"/></svg>
            </button>
          </span>
          <input
            v-model="ghRepoDraft"
            class="input gh-repo-add"
            :placeholder="t('library.ghAddRepo')"
            :aria-label="t('library.ghAddRepo')"
            @keyup.enter="addGhRepo"
          />
        </div>
      </section>

      <!-- Calibre 书库直读 (桌面版) -->
      <section v-if="calibreAvailable()" class="calibre-section">
        <header class="toolbar">
          <h2>{{ t('catalog.calibreTitle') }}</h2>
          <div class="spacer" />
          <template v-if="settings.calibrePath">
            <span class="calibre-path" :title="settings.calibrePath">{{ settings.calibrePath }}</span>
            <button class="btn btn-sm" :disabled="calibreLoading" @click="refreshCalibre">{{ t('common.refresh') }}</button>
            <button class="btn btn-sm btn-primary" :disabled="calibreBatchBusy" @click="calibreImportAllNew">
              {{ calibreBatchBusy ? t('catalog.syncing') : t('catalog.importAllNew') }}
            </button>
            <button class="btn btn-sm btn-danger" @click="disconnectCalibre">{{ t('catalog.disconnect') }}</button>
          </template>
          <button v-else class="btn btn-primary" @click="connectCalibre">{{ t('catalog.connectCalibre') }}</button>
        </header>
        <p v-if="!settings.calibrePath" class="intro">
          {{ t('catalog.calibreIntro') }}
        </p>
        <div v-if="calibreLoading" class="empty">{{ t('catalog.readingLibrary') }}</div>
        <div v-else-if="settings.calibrePath && calibreBooks.length" class="calibre-grid">
          <div v-for="book in calibreBooks" :key="book.id" class="calibre-card card">
            <img v-if="calibreCovers[book.id]" class="calibre-cover" :src="calibreCovers[book.id]" loading="lazy" decoding="async" alt="" />
            <div v-else class="calibre-cover placeholder" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
            </div>
            <div class="calibre-info">
              <div class="calibre-title" :title="book.title">{{ book.title }}</div>
              <div class="calibre-authors">{{ book.authors || t('common.anonymous') }}</div>
              <div class="calibre-formats">
                <span v-for="f in book.formats" :key="f.format" class="tag">{{ f.format.toUpperCase() }}</span>
              </div>
              <div class="calibre-actions">
                <template v-if="importedTitles.has(book.title)">
                  <button class="btn btn-sm btn-primary" @click="openImported(book)">{{ t('catalog.continueReading') }}</button>
                </template>
                <template v-else-if="pickBestFormat(book)">
                  <button class="btn btn-sm btn-primary" :disabled="calibreBusy.has(book.id)" @click="calibreImport(book, true)">
                    {{ calibreBusy.has(book.id) ? t('catalog.opening') : t('catalog.read') }}
                  </button>
                  <button class="btn btn-sm" :disabled="calibreBusy.has(book.id)" @click="calibreImport(book)">{{ t('catalog.import') }}</button>
                </template>
                <span v-else class="no-acq">{{ t('catalog.noReadableFormat') }}</span>
              </div>
            </div>
          </div>
        </div>
        <div v-else-if="settings.calibrePath" class="empty"><p>{{ t('catalog.libraryEmpty') }}</p></div>
      </section>
    </template>

    <!-- 目录浏览 -->
    <template v-else>
      <header class="toolbar">
        <button class="btn btn-sm" @click="breadcrumbs.length > 1 ? gotoCrumb(breadcrumbs.length - 2) : backToSources()">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M14.7 6.3a1 1 0 0 1 0 1.4L10.42 12l4.3 4.3a1 1 0 0 1-1.42 1.4l-5-5a1 1 0 0 1 0-1.4l5-5a1 1 0 0 1 1.42 0z"/></svg>
          {{ t('common.back') }}
        </button>
        <nav class="crumbs" aria-label="Breadcrumb">
          <button class="crumb" @click="backToSources">{{ t('catalog.title') }}</button>
          <template v-for="(c, i) in breadcrumbs" :key="i">
            <span class="crumb-sep">/</span>
            <button class="crumb" :class="{ current: i === breadcrumbs.length - 1 }" :aria-current="i === breadcrumbs.length - 1 ? 'page' : undefined" @click="gotoCrumb(i)">
              {{ c.title }}
            </button>
          </template>
        </nav>
        <div class="spacer" />
        <button v-if="!activeSource.builtin && activeSource.kind === 'opds'" class="btn btn-primary" @click="uploadTarget = activeSource">{{ t('library.addBooks') }}</button>
        <form v-if="page?.searchUrl" @submit.prevent="runSearch">
          <input v-model="searchQuery" class="input" type="search" :placeholder="t('catalog.searchThisSource')" :aria-label="t('catalog.searchThisSource')" />
        </form>
      </header>

      <div v-if="loading" class="empty" role="status" aria-busy="true">
        <div class="empty-icon spinner" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 3a9 9 0 1 0 9 9" /></svg>
        </div>
        <p class="hint">{{ t('common.loading') }}</p>
      </div>
      <div v-else-if="loadError" class="empty">
        <div class="empty-icon danger" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9a2 2 0 0 1 3.4 0l8 13.6A2 2 0 0 1 20 20.5H4a2 2 0 0 1-1.7-3l8-13.6z"/><path d="M12 9v5m0 3.5h.01"/></svg>
        </div>
        <p class="hint" style="max-width: 480px">{{ loadError }}</p>
        <div class="empty-actions">
          <button class="btn" @click="backToSources">{{ t('catalog.backToSources') }}</button>
        </div>
      </div>

      <template v-else-if="page">
        <!-- 子目录 -->
        <div v-if="page.navigation.length" class="nav-grid">
          <button
            v-for="(nav, i) in page.navigation"
            :key="i"
            class="nav-card card"
            @click="openUrl(nav.href, nav.title)"
          >
            <span class="nav-title">{{ nav.title }}</span>
            <span v-if="nav.summary" class="nav-summary">{{ nav.summary }}</span>
          </button>
        </div>

        <!-- 出版物 -->
        <div v-if="page.publications.length" class="pub-list">
          <div v-for="(pub, i) in page.publications" :key="i" class="pub card">
            <img v-if="pub.coverUrl" class="pub-cover" :src="pub.coverUrl" loading="lazy" alt="" />
            <div v-else class="pub-cover placeholder" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2V4zm20 0h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7V4z"/></svg>
            </div>
            <div class="pub-info">
              <div class="pub-title">{{ pub.title }}</div>
              <div class="pub-author">{{ pub.author || t('common.anonymous') }}</div>
              <p v-if="pub.summary" class="pub-summary">{{ pub.summary }}</p>
              <div class="pub-actions">
                <button
                  v-for="acq in pub.acquisitions"
                  :key="acq.href"
                  class="btn btn-sm"
                  :disabled="downloading.has(acq.href)"
                  @click="download(pub, acq)"
                >
                  {{ downloading.has(acq.href) ? t('catalog.downloading') : t('catalog.download', { label: acq.label }) }}
                </button>
                <span v-if="!pub.acquisitions.length" class="no-acq">{{ t('catalog.noDownloadFormat') }}</span>
              </div>
            </div>
          </div>
        </div>

        <div v-if="!page.navigation.length && !page.publications.length" class="empty">
          <p>{{ t('catalog.thisDirEmpty') }}</p>
        </div>

        <div v-if="page.next" class="load-more">
          <button class="btn" :disabled="appendLoading" @click="loadMore">
            {{ appendLoading ? t('common.loading') : t('catalog.loadMore') }}
          </button>
        </div>
      </template>
    </template>

    <!-- 添加书源弹窗 -->
    <div v-if="showAdd" class="modal-mask" @click.self="closeAdd" @keydown.esc="closeAdd">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="add-source-title">
        <h3 id="add-source-title">{{ t('catalog.addModalTitle') }}</h3>
        <div class="form-row">
          <label for="src-conn">{{ t('catalog.pasteConnection') }}</label>
          <textarea
            id="src-conn"
            v-model="connText"
            class="input conn-input"
            rows="3"
            autocomplete="off"
            spellcheck="false"
            :placeholder="t('catalog.pasteConnectionPlaceholder')"
            aria-describedby="src-conn-status"
            @paste="onConnectionPaste($event, false)"
          />
          <p id="src-conn-status" class="conn-status" :class="{ error: connStatus && !connStatus.ok }" role="status">{{ connStatus?.text ?? '' }}</p>
        </div>
        <div class="form-row">
          <label for="src-name">{{ t('catalog.name') }}</label>
          <input id="src-name" v-model="newTitle" class="input" :placeholder="t('catalog.namePlaceholder')" autofocus />
        </div>
        <div class="form-row">
          <label for="src-url">{{ t('catalog.opdsUrl') }}</label>
          <input id="src-url" v-model="newUrl" class="input" type="url" inputmode="url" placeholder="https://example.com/opds" @paste="onConnectionPaste($event, true)" />
        </div>
        <div class="form-row-pair">
          <div class="form-row">
            <label for="src-user">{{ t('common.usernameOptional') }}</label>
            <input id="src-user" v-model="newUsername" class="input" autocomplete="off" />
          </div>
          <div class="form-row">
            <label for="src-pass">{{ t('common.passwordOptional') }}</label>
            <input id="src-pass" v-model="newPassword" class="input" type="password" autocomplete="new-password" />
          </div>
        </div>
        <p class="form-hint">
          {{ t('catalog.hintCommon') }} <code>http://host:8083/opds</code>{{ t('catalog.hintServer') }}
          <code>http://host:8080/opds</code>{{ t('catalog.hintAuth') }}
        </p>
        <div class="form-actions">
          <button class="btn" @click="closeAdd">{{ t('common.cancel') }}</button>
          <button class="btn btn-primary" :disabled="!newUrl.trim()" @click="addSource">{{ t('common.add') }}</button>
        </div>
      </div>
    </div>
    <LibraryUploadDialog v-if="uploadTarget" :source="uploadTarget" @close="uploadTarget = null" @uploaded="refreshAfterUpload" />
  </div>
</template>

<style scoped>
.web-sources { margin-top: 24px; }
.web-source-card { padding: 16px; display: flex; flex-direction: column; align-items: flex-start; }
.web-source-card .intro { flex: 1; }
.uni-acts { flex-wrap: wrap; }

.catalog {
  padding: 24px 28px calc(40px + var(--lr-safe-bottom));
  min-height: 100%;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 18px;
  flex-wrap: wrap;
}
.toolbar h1 {
  font-size: 20px;
  font-weight: 650;
  letter-spacing: -0.01em;
}
.toolbar h2,
.uni-section h2 {
  font-size: 15px;
  font-weight: 650;
}
.spacer {
  flex: 1;
}
.intro {
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.8;
  margin-bottom: 20px;
  max-width: 640px;
}
.source-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 14px;
}
.source-card {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 14px 14px 14px 16px;
  cursor: pointer;
  transition:
    box-shadow var(--dur) var(--ease),
    border-color var(--dur) var(--ease),
    transform var(--dur) var(--ease);
}
.source-card:hover {
  box-shadow: var(--shadow-md);
  border-color: color-mix(in srgb, var(--brand) 30%, var(--border));
  transform: translateY(-1px);
}
.source-card:focus-visible {
  outline: none;
  box-shadow: var(--ring), var(--shadow-md);
}
.source-icon {
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  border-radius: 10px;
  display: grid;
  place-items: center;
  background: var(--brand-light);
  color: var(--brand);
}
.source-body {
  flex: 1;
  min-width: 0;
}
.source-chevron {
  color: var(--text-3);
  flex-shrink: 0;
  margin-top: 9px;
  transition: transform var(--dur) var(--ease), color var(--dur) var(--ease);
}
.source-card:hover .source-chevron {
  color: var(--brand);
  transform: translateX(2px);
}
.source-title {
  font-weight: 600;
  margin-bottom: 3px;
}
.source-url {
  font-size: 12px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-bottom: 10px;
}
.source-foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
  min-height: 24px;
}
.crumbs {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  min-width: 0;
}
.crumb {
  border: none;
  background: none;
  color: var(--brand);
  font-size: 13px;
  padding: 4px 6px;
  border-radius: 4px;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.crumb:hover {
  background: var(--brand-light);
}
.crumb.current {
  color: var(--text);
  font-weight: 500;
}
.crumb-sep {
  color: var(--text-3);
  font-size: 12px;
}
.nav-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px;
  margin-bottom: 20px;
}
.nav-card {
  padding: 12px 14px;
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: 4px;
  cursor: pointer;
  transition:
    box-shadow var(--dur) var(--ease),
    border-color var(--dur) var(--ease);
}
.nav-card:hover {
  box-shadow: var(--shadow-md);
  border-color: color-mix(in srgb, var(--brand) 30%, var(--border));
}
.nav-card:focus-visible {
  outline: none;
  box-shadow: var(--ring), var(--shadow-md);
}
.nav-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--text);
}
.nav-summary {
  font-size: 12px;
  color: var(--text-3);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.pub-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.pub {
  display: flex;
  gap: 16px;
  padding: 14px;
}
.pub-cover {
  width: 84px;
  height: 118px;
  object-fit: cover;
  border-radius: 6px;
  flex-shrink: 0;
  background: var(--surface-2);
}
.pub-cover.placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
}
.pub-info {
  min-width: 0;
  flex: 1;
}
.pub-title {
  font-weight: 500;
  margin-bottom: 4px;
}
.pub-author {
  font-size: 13px;
  color: var(--text-3);
  margin-bottom: 6px;
}
.pub-summary {
  font-size: 13px;
  color: var(--text-2);
  line-height: 1.7;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  margin-bottom: 10px;
}
.pub-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.no-acq {
  font-size: 12px;
  color: var(--text-3);
}
.load-more {
  display: flex;
  justify-content: center;
  padding: 20px;
}
.form-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
}
.form-row-pair {
  display: flex;
  gap: 10px;
}
.form-row-pair .form-row {
  flex: 1;
}
.form-row label {
  font-size: 13px;
  color: var(--text-2);
}
.form-hint {
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.7;
  margin-bottom: 16px;
}
.form-hint code {
  font-family: var(--font-mono);
  font-size: 0.92em;
  background: var(--surface-2);
  padding: 1px 5px;
  border-radius: 4px;
}
.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

/* Calibre 书库 */
.calibre-section {
  margin-top: 32px;
}
.calibre-section h2 {
  font-size: 16px;
}
.calibre-path {
  font-size: 12px;
  color: var(--text-3);
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.calibre-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 12px;
}
.calibre-card {
  display: flex;
  gap: 12px;
  padding: 12px;
}
.calibre-cover {
  width: 72px;
  height: 100px;
  object-fit: cover;
  border-radius: 4px;
  flex-shrink: 0;
  background: var(--surface-2);
}
.calibre-cover.placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
}
.calibre-info {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.calibre-title {
  font-weight: 500;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.calibre-authors {
  font-size: 12px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.calibre-formats {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.calibre-actions {
  display: flex;
  gap: 6px;
  margin-top: auto;
}

.gh-section {
  margin-top: 28px;
}
.gh-section h2 {
  font-size: 16px;
}
.gh-search-row {
  display: flex;
  gap: 8px;
  max-width: 560px;
}
.gh-search-row .input {
  flex: 1;
}
.gh-repos {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  align-items: center;
  margin-top: 10px;
}
.gh-repo-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 14px;
  font-size: 12px;
  color: var(--text-2);
  background: var(--card);
}
.gh-repo-del {
  border: none;
  background: none;
  color: var(--text-3);
  width: 20px;
  height: 20px;
  margin-right: -6px;
  border-radius: 50%;
  display: inline-grid;
  place-items: center;
  padding: 0;
}
.gh-repo-del:hover {
  color: var(--danger);
  background: var(--danger-soft);
}
.gh-repo-add {
  height: 28px;
  width: 210px;
  font-size: 12px;
  border-radius: 14px;
}
.gh-notice {
  margin-top: 8px;
  font-size: 12px;
  color: var(--warning);
  display: flex;
  align-items: center;
  gap: 6px;
}
.gh-progress {
  margin-top: 8px;
  font-size: 13px;
  color: var(--brand);
}
.gh-results {
  margin-top: 12px;
  max-width: 720px;
  max-height: 420px;
  overflow: auto;
  padding: 8px;
}
.gh-item {
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.gh-item:hover {
  background: var(--surface-2);
}
.gh-item:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.gh-item.busy {
  opacity: 0.5;
  pointer-events: none;
}
.gh-name {
  font-size: 13px;
  color: var(--text);
  word-break: break-all;
}
.gh-meta {
  font-size: 11px;
  color: var(--text-3);
  word-break: break-all;
}
.gh-empty {
  color: var(--text-3);
  font-size: 13px;
  text-align: center;
  padding: 16px 0;
}
.gh-count {
  font-size: 12px;
  color: var(--text-3);
  padding: 8px 10px 2px;
  border-top: 1px solid var(--border);
}

.uni-section {
  margin-bottom: 24px;
  padding: 16px 18px;
  max-width: 760px;
}
.uni-section h2 {
  font-size: 16px;
  margin-bottom: 10px;
}
.uni-scopes {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 10px;
  font-size: 13px;
  color: var(--text-2);
}
.check-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 12px 0 10px;
  border: 1px solid var(--border);
  border-radius: 15px;
  cursor: pointer;
  user-select: none;
  transition:
    border-color var(--dur-fast) var(--ease),
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}
.check-chip:hover {
  border-color: var(--border-strong);
}
.check-chip.on {
  background: var(--brand-light);
  border-color: color-mix(in srgb, var(--brand) 50%, var(--border));
  color: var(--brand);
}
.check-chip:focus-within {
  box-shadow: var(--ring);
}
.check-chip input {
  width: 14px;
  height: 14px;
}
.uni-group {
  margin-top: 12px;
  border-top: 1px solid var(--border);
  max-height: 300px;
  overflow: auto;
}
.uni-group-head {
  position: sticky;
  top: 0;
  background: var(--card);
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
  padding: 8px 4px 4px;
}
.uni-pub {
  position: relative;
}
.uni-acts {
  display: flex;
  gap: 6px;
  margin-top: 4px;
}
.mine-tag {
  margin-right: 4px;
  background: var(--brand-light);
  color: var(--brand);
}
.uni-group-msg {
  font-size: 12px;
  color: var(--text-3);
  padding: 4px 4px 8px;
}
.uni-group-msg.error {
  color: var(--danger);
}
.uni-more {
  display: flex;
  justify-content: center;
  padding: 6px 0 10px;
}
.check-chip.mine svg {
  flex-shrink: 0;
}
.conn-input {
  min-height: 72px;
  resize: vertical;
  font-size: 13px;
  line-height: 1.6;
  padding: 8px 10px;
  height: auto;
}
.conn-status {
  min-height: 1em;
  font-size: 12px;
  color: var(--success);
  line-height: 1.5;
}
.conn-status:empty {
  display: none;
}
.conn-status.error {
  color: var(--warning);
}
.gh-updated {
  font-size: 12px;
  color: var(--text-3);
  margin-left: 10px;
}
.gh-repo-chip.community {
  background: var(--brand-light);
  border-color: transparent;
  color: var(--brand);
}
.empty-icon.spinner svg {
  animation: spin 0.9s linear infinite;
}
.empty-icon.danger {
  background: var(--danger-soft);
  color: var(--danger);
}
.hint {
  font-size: 13px;
  line-height: 1.8;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 720px) {
  .catalog {
    padding: 16px 16px calc(28px + var(--lr-safe-bottom));
  }
  .source-grid {
    grid-template-columns: 1fr;
  }
  .toolbar {
    gap: 8px;
  }
  .gh-search-row {
    max-width: none;
  }
  .calibre-path {
    display: none;
  }
  .form-row-pair {
    flex-direction: column;
    gap: 0;
  }
  .pub {
    gap: 12px;
    padding: 12px;
  }
  .pub-cover {
    width: 64px;
    height: 90px;
  }
}
</style>
