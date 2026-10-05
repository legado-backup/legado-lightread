<script setup lang="ts">
import { resetInstallId } from '../services/usageStats'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { getStorage, isTauri } from '../storage'
import { useSettings } from '../stores/settings'
import { useLibrary } from '../stores/library'
import {
  exportBackup,
  importBackup,
  LIBRARY_ARCHIVE_EXTENSION,
} from '../services/backup'
import { backupToWebdav, restoreFromWebdav, testWebdav, verifyWebdav, WebdavConnectError, type WebdavDraft } from '../services/webdav'
import { detectProvider, displayHost, providerOf, WEBDAV_PROVIDERS, type WebdavProviderId } from '../services/webdavProviders'
import { requestAutoSync, syncConfigured, syncNow, syncState, waitForSync } from '../services/sync'
import type { SyncResult } from '../services/sync/types'
import { accountState, isLoggedIn } from '../services/account'
import AccountCard from '../components/settings/AccountCard.vue'
import { fetchRemote } from '../services/net'
import { toast } from '../services/toast'
import {
  CURRENT_VERSION, RELEASES_URL, REPO_URL, ISSUES_URL,
  checkUpdate, pickDownloads, openDownload, canInAppInstall,
  downloadInstaller, openInstaller, copyLink,
  type UpdateInfo, type DownloadOption,
} from '../services/updater'
import { t } from '../i18n'
import { AI_PROVIDERS, providerById, chatStream } from '../services/ai'
import {
  paperAgentRuntimeAvailable,
  paperAgentEngineStatus,
  type PaperAgentEngine,
  type PaperAgentEngineStatus,
} from '../services/paperAgent.ts'

const settings = useSettings()
const isAndroid = /Android/i.test(navigator.userAgent)
const library = useLibrary()

const storageKind = ref('')
const busy = ref('')
/** busy 提示显示在哪张卡片: WebDAV 操作在「账号与同步」, 本地导入导出在「数据」 */
const busyScope = ref<'dav' | 'local'>('local')
const backupInput = ref<HTMLInputElement>()

// ---- WebDAV 网盘 ----
// 未连接: 选服务商 → 填账号与 (应用) 密码 → 「连接」一次完成校验、保存、开自动同步与首次同步.
// 已连接: 折叠为状态卡; 「修改」重新展开表单 (草稿), 校验通过才写回 settings.
/** 地址与账号已从其他设备同步过来、但没带密码 (未开「同步密码与密钥」): 需要本机补填密码才能连接 */
const davNeedsPass = computed(() => !!settings.webdavUrl.trim() && !!settings.webdavUser && !settings.webdavPass)
const davConnected = computed(() => !!settings.webdavUrl.trim() && !davNeedsPass.value)
const davProviderId = computed(() => detectProvider(settings.webdavUrl, settings.webdavProvider))
const davProvider = computed(() => providerOf(davProviderId.value))
const davEditing = ref(false)
const davShowForm = computed(() => !davConnected.value || davEditing.value)
const davHasAddress = computed(() => !!settings.webdavUrl.trim())
const davDraft = reactive<WebdavDraft>({ provider: 'jianguoyun', address: '', user: '', pass: '' })
const draftProvider = computed(() => providerOf(davDraft.provider))
/** 连接进度: '' 空闲 / verify 校验中 / sync 首次同步中 */
const davStage = ref<'' | 'verify' | 'sync'>('')
const davError = ref('')
const davErrorKind = ref('')
const davInfo = ref<{ text: string; error: boolean } | null>(null)
const davPassInput = ref<HTMLInputElement>()
/** 网页版直连服务商时要提醒跨域 (固定服务商经中转, 无需提醒) */
const davWebNote = computed(() => {
  if (isTauri()) return ''
  return draftProvider.value.relay ? t('webdav.relayNote') : t('webdav.corsNote')
})

function resetDavDraft() {
  // 已连接或待补密码时以 settings 为准预填 (同步可能刚改过这些字段)
  const connected = davHasAddress.value
  davDraft.provider = connected ? davProviderId.value : 'jianguoyun'
  davDraft.address = connected && !davProvider.value.url ? settings.webdavUrl : ''
  davDraft.user = connected ? settings.webdavUser : ''
  davDraft.pass = connected ? settings.webdavPass : ''
  davError.value = ''
  davErrorKind.value = ''
}
resetDavDraft()

/** 未连接时先只列出服务商, 选中一个才展开表单 (渐进展开; 修改已有连接时直接展开) */
const davPicked = ref(davNeedsPass.value)

// 同步过程中 WebDAV 配置可能被其他设备的设置改写: 不在编辑 / 连接中时, 让表单跟上 settings
watch(() => [settings.webdavUrl, settings.webdavUser, settings.webdavPass, settings.webdavProvider], () => {
  if (davEditing.value || davStage.value) return
  resetDavDraft()
  davPicked.value = davNeedsPass.value
})

async function pickDavProvider(id: WebdavProviderId) {
  if (davStage.value) return
  const first = !davPicked.value
  davDraft.provider = id
  davPicked.value = true
  davError.value = ''
  davErrorKind.value = ''
  if (first) {
    await nextTick()
    document.getElementById(providerOf(id).url ? 'dav-user' : 'dav-address')?.focus({ preventScroll: true })
  }
}

// 改了表单就清掉上次的错误提示
watch(() => [davDraft.address, davDraft.user, davDraft.pass], () => {
  if (!davStage.value) { davError.value = ''; davErrorKind.value = '' }
})

function startDavEdit() {
  resetDavDraft()
  davEditing.value = true
  davPicked.value = true
  davInfo.value = null
}

function cancelDavEdit() {
  if (davStage.value) return
  davEditing.value = false
  davPicked.value = davNeedsPass.value
  resetDavDraft()
}

async function openExternalUrl(url: string) {
  try {
    await openDownload(url)
  } catch {
    toast(t('update.cannotOpenLink'), 'error')
  }
}

const davStageText = computed(() => {
  if (davStage.value === 'verify') return t('webdav.verifying')
  if (davStage.value === 'sync') return syncState.message || t('webdav.firstSync')
  return ''
})

async function connectWebdav() {
  if (davStage.value) return
  davError.value = ''
  davErrorKind.value = ''
  davStage.value = 'verify'
  let url: string
  try {
    url = await verifyWebdav(davDraft)
  } catch (e: any) {
    davStage.value = ''
    davError.value = e?.message || t('common.unknownError')
    davErrorKind.value = e instanceof WebdavConnectError ? e.kind : ''
    if (davErrorKind.value === 'auth') {
      await nextTick()
      davPassInput.value?.select()
    }
    return
  }
  settings.webdavProvider = davDraft.provider
  settings.webdavUrl = url
  settings.webdavUser = davDraft.user.trim()
  settings.webdavPass = davDraft.pass
  // 连网盘就是为了同步: 打开自动同步, 立刻同步一次
  settings.webdavSyncAuto = true
  davStage.value = 'sync'
  const name = t(`webdav.provider.${davDraft.provider}`)
  try {
    const r = await syncNow()
    // 有实际下载 / 待补文件时才附上同步明细, 否则一句「已连接」即可
    const detail = r.downloadedBooks > 0 || r.pendingBooks > 0 ? ' · ' + syncResultText(r) : ''
    toast(t('webdav.connectedToast', { name }) + detail, 'success', detail ? 6000 : 4000)
  } catch (e: any) {
    // 已通过校验并保存; 首次同步的错误留在同步状态行
    toast(t('sync.failed', { msg: e?.message ?? t('common.unknownError') }), 'error', 6000)
  } finally {
    davStage.value = ''
    davEditing.value = false
    davPicked.value = false
  }
}

const showDavDisconnect = ref(false)
const davDisconnectCancel = ref<HTMLButtonElement>()

async function openDavDisconnect() {
  showDavDisconnect.value = true
  await nextTick()
  davDisconnectCancel.value?.focus()
}

async function confirmDavDisconnect() {
  // 正在同步时等它结束, 免得半路换掉配置
  await waitForSync()
  settings.webdavUrl = ''
  settings.webdavUser = ''
  settings.webdavPass = ''
  settings.webdavProvider = ''
  showDavDisconnect.value = false
  davEditing.value = false
  davPicked.value = false
  davInfo.value = null
  resetDavDraft()
  toast(t('webdav.disconnected'), 'success')
}

async function davTest() {
  busyScope.value = 'dav'
  busy.value = t('webdav.testing')
  davInfo.value = null
  try {
    const info = await testWebdav()
    davInfo.value = {
      error: false,
      text: info
        ? t('webdav.testOk', { size: (info.size / 1024 / 1024).toFixed(1), date: info.modified.slice(0, 22) })
        : t('webdav.testOkEmpty'),
    }
  } catch (e: any) {
    davInfo.value = { error: true, text: e?.message || t('common.unknownError') }
  } finally {
    busy.value = ''
  }
}

async function davBackup() {
  busyScope.value = 'dav'
  busy.value = t('webdav.preparingBackup')
  davInfo.value = null
  try {
    await backupToWebdav(msg => (busy.value = msg))
    toast(t('webdav.backedUp'), 'success')
  } catch (e: any) {
    toast(t('webdav.backupFailed', { msg: e?.message }), 'error', 6000)
  } finally {
    busy.value = ''
  }
}

async function davRestore() {
  if (!confirm(t('webdav.restoreConfirm'))) return
  busyScope.value = 'dav'
  busy.value = t('webdav.connectingCloud')
  davInfo.value = null
  try {
    const result = await restoreFromWebdav(msg => (busy.value = msg))
    await library.refresh()
    toast(t('webdav.restoreDone', { books: result.books, annotations: result.annotations }), 'success', 5000)
  } catch (e: any) {
    toast(t('settings.restoreFailed', { msg: e?.message }), 'error', 6000)
  } finally {
    busy.value = ''
  }
}

const DAV_PROVIDER_ICONS: Record<WebdavProviderId, string> = {
  // 云
  jianguoyun: 'M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 8.5a4.75 4.75 0 0 1-.25 9.5H7z',
  koofr: 'M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 8.5a4.75 4.75 0 0 1-.25 9.5H7z',
  // 服务器
  selfhosted: 'M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v4a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 9.5v-4zm0 9A1.5 1.5 0 0 1 5.5 13h13a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-4zM8 7.5h.01M8 16.5h.01',
  // 链接
  other: 'M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1',
}

// ---- 轻阅账号 (登录流程见 components/settings/AccountCard.vue) ----
const loggedIn = computed(() => {
  void accountState.token
  try {
    return isLoggedIn()
  } catch {
    return !!accountState.token
  }
})

// ---- 多端同步 ----
// accountState.token / settings.webdavUrl 是响应式的, 放进 computed 后登录状态或地址变化会重新判断
const syncReady = computed(() => {
  void accountState.token
  void settings.webdavUrl
  try {
    return syncConfigured()
  } catch {
    return false
  }
})
const syncTargetNames = computed(() => {
  const names: string[] = []
  if (loggedIn.value) names.push(t('account.title'))
  if (davConnected.value) names.push(t(`webdav.provider.${davProviderId.value}`))
  return names.join(t('sync.targetSep'))
})
const syncNowTick = ref(Date.now())
const syncTicker = window.setInterval(() => (syncNowTick.value = Date.now()), 30_000)
onBeforeUnmount(() => window.clearInterval(syncTicker))

function formatSyncTime(at: number, now: number): string {
  const locale = settings.language === 'en' ? 'en' : 'zh-CN'
  const diff = now - at
  if (diff < 60_000) return t('sync.justNow')
  if (diff < 3_600_000) {
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-Math.floor(diff / 60_000), 'minute')
  }
  const then = new Date(at)
  const sameDay = then.toDateString() === new Date(now).toDateString()
  return new Intl.DateTimeFormat(locale, sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(then)
}

const syncStatus = computed(() => {
  if (syncState.running) return { text: syncState.message || t('sync.running'), error: false }
  if (syncState.lastError) return { text: syncState.lastError, error: true }
  // 没有同步目标时提示去登录或填 WebDAV (不算错误)
  if (!syncReady.value) return { text: t('sync.err.notConfigured'), error: false }
  if (syncState.lastSyncAt) {
    return { text: t('sync.lastAt', { time: formatSyncTime(syncState.lastSyncAt, syncNowTick.value) }), error: false }
  }
  return { text: t('sync.never'), error: false }
})

function syncResultText(r: SyncResult): string {
  let msg = t('sync.done', { applied: r.applied, downloaded: r.downloadedBooks, uploaded: r.uploadedFiles })
  if (r.pendingBooks > 0) msg += t('sync.pending', { pending: r.pendingBooks })
  if (r.settingsApplied) msg += t('sync.settingsAppliedSuffix', { n: r.settingsApplied })
  return msg
}

async function doSyncNow() {
  if (syncState.running) return
  try {
    const r = await syncNow()
    toast(syncResultText(r), 'success', r.pendingBooks > 0 ? 6000 : 4000)
  } catch (e: any) {
    toast(t('sync.failed', { msg: e?.message ?? t('common.unknownError') }), 'error', 6000)
  }
}

// ---- 设置同步: 密码与密钥需显式确认才开启 ----
const showSecretsConfirm = ref(false)
const secretsCancelBtn = ref<HTMLButtonElement>()

async function onSecretsToggle(e: Event) {
  const input = e.target as HTMLInputElement
  if (!input.checked) {
    settings.syncSecrets = false
    return
  }
  // 先复原开关, 确认后才真正打开
  input.checked = false
  showSecretsConfirm.value = true
  await nextTick()
  secretsCancelBtn.value?.focus()
}

function confirmSecrets() {
  settings.syncSecrets = true
  showSecretsConfirm.value = false
  requestAutoSync('settings')
}

// 打开「同步设置」后尽快同步一次 (遵循自动同步开关)
watch(() => settings.syncSettings, on => {
  if (on) requestAutoSync('settings')
})

// ---- 分区导航 (吸顶, 随滚动高亮当前分区) ----
const navSections = computed(() => [
  { id: 'sync', label: t('settings.syncSection') },
  { id: 'general', label: t('settings.general') },
  { id: 'reading', label: t('settings.navReading') },
  { id: 'ai', label: t('settings.aiTitle') },
  ...(paperAgentRuntimeAvailable() ? [{ id: 'agents', label: t('settings.paperAgentsTitle') }] : []),
  { id: 'data', label: t('settings.data') },
  { id: 'network', label: t('settings.network') },
  { id: 'privacy', label: t('settings.privacy') },
  { id: 'about', label: t('settings.about') },
])
const activeSection = ref('sync')
const rootEl = ref<HTMLElement>()
const navEl = ref<HTMLElement>()
let scroller: HTMLElement | null = null
let spyFrame = 0
/** 点击跳转的平滑滚动期间不随滚动改高亮, 免得高亮在途经的分区间跳动 */
let spyLockUntil = 0

function updateActiveSection() {
  spyFrame = 0
  if (!scroller || Date.now() < spyLockUntil) return
  const navBottom = navEl.value?.getBoundingClientRect().bottom ?? 0
  let current = navSections.value[0]?.id ?? ''
  for (const s of navSections.value) {
    const el = document.getElementById(`settings-${s.id}`)
    if (el && el.getBoundingClientRect().top <= navBottom + 32) current = s.id
  }
  // 滚到底时最后几个短分区够不到顶部, 直接高亮最后一个
  if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) {
    current = navSections.value[navSections.value.length - 1]?.id ?? current
  }
  setActiveSection(current)
}

function setActiveSection(id: string) {
  if (activeSection.value === id) return
  activeSection.value = id
  // 横向滚动的导航条把当前项带进可视区 (只滚导航条自身)
  nextTick(() => {
    const nav = navEl.value
    const chip = nav?.querySelector<HTMLElement>(`[data-section="${id}"]`)
    if (!nav || !chip) return
    const left = chip.offsetLeft - 16
    const right = chip.offsetLeft + chip.offsetWidth + 16 - nav.clientWidth
    if (nav.scrollLeft > left) nav.scrollTo({ left, behavior: 'smooth' })
    else if (nav.scrollLeft < right) nav.scrollTo({ left: right, behavior: 'smooth' })
  })
}

function onSettingsScroll() {
  if (!spyFrame) spyFrame = requestAnimationFrame(updateActiveSection)
}

function jumpTo(id: string) {
  const el = document.getElementById(`settings-${id}`)
  if (!el) return
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  spyLockUntil = Date.now() + (reduce ? 50 : 700)
  setActiveSection(id)
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
  // 焦点跟到分区标题, 读屏与键盘用户也能接着往下走
  el.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true })
}

onMounted(() => {
  scroller = rootEl.value?.closest<HTMLElement>('.main') ?? null
  scroller?.addEventListener('scroll', onSettingsScroll, { passive: true })
})
onBeforeUnmount(() => {
  scroller?.removeEventListener('scroll', onSettingsScroll)
  if (spyFrame) cancelAnimationFrame(spyFrame)
})

// ---- 代理配置 (桌面端) ----
const PROXY_SCHEMES: Array<{ label?: string; labelKey?: string; value: string }> = [
  { labelKey: 'settings.proxyNone', value: '' },
  { label: 'HTTP', value: 'http' },
  { label: 'HTTPS', value: 'https' },
  { label: 'SOCKS5', value: 'socks5' },
  { labelKey: 'settings.proxySocks5h', value: 'socks5h' },
  { label: 'SOCKS4', value: 'socks4' },
]

const proxy = reactive({ scheme: '', host: '127.0.0.1', port: '7890', username: '', password: '' })

function parseProxyUrl(raw: string) {
  const m = raw.trim().match(
    /^(https?|socks5h?|socks4a?):\/\/(?:([^:@/]+)(?::([^@/]*))?@)?([^:/@]+)(?::(\d+))?$/i)
  if (!m) return
  proxy.scheme = m[1].toLowerCase()
  proxy.username = m[2] ? decodeURIComponent(m[2]) : ''
  proxy.password = m[3] ? decodeURIComponent(m[3]) : ''
  proxy.host = m[4]
  proxy.port = m[5] ?? ''
}

function composeProxyUrl(): string {
  if (!proxy.scheme || !proxy.host.trim()) return ''
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}${proxy.password ? ':' + encodeURIComponent(proxy.password) : ''}@`
    : ''
  const port = proxy.port.trim() ? `:${proxy.port.trim()}` : ''
  return `${proxy.scheme}://${auth}${proxy.host.trim()}${port}`
}

watch(proxy, () => {
  settings.httpProxy = composeProxyUrl()
})

// ---- 代理连通性测试 ----
const testing = ref(false)
const testResult = ref('')

async function testProxy() {
  testing.value = true
  testResult.value = ''
  const start = performance.now()
  try {
    await fetchRemote('https://www.google.com/generate_204')
    testResult.value = t('settings.proxyOk', { ms: Math.round(performance.now() - start) })
  } catch (e: any) {
    testResult.value = `❌ ${e?.message ?? t('settings.connectionFailed')}`
  } finally {
    testing.value = false
  }
}

onMounted(async () => {
  parseProxyUrl(settings.httpProxy)
  doCheckUpdate(false)
  const storage = await getStorage()
  storageKind.value = storage.kind
  await refreshPaperAgentStatuses()
})

// ---- AI 助手 ----
const aiTesting = ref(false)
const aiTestResult = ref('')

function onAiProviderChange() {
  const preset = providerById(settings.aiProvider)
  if (preset.id !== 'custom') {
    settings.aiBaseUrl = preset.baseUrl
    settings.aiModel = preset.defaultModel
  }
  aiTestResult.value = ''
}

/** 预设服务商的接口地址已自动填好, 默认收起; 自定义或改过时展开 */
const aiBaseUrlOpen = ref(false)
const aiShowBaseUrl = computed(() => {
  const preset = providerById(settings.aiProvider)
  return aiBaseUrlOpen.value || preset.id === 'custom' || !settings.aiBaseUrl || settings.aiBaseUrl !== preset.baseUrl
})

const aiDocsUrl = computed(() => providerById(settings.aiProvider).docsUrl ?? '')

const paperAgentEngines: Array<{ id: PaperAgentEngine; label: string }> = [
  { id: 'pi', label: 'Pi Agent' },
  { id: 'codex', label: 'Codex' },
  { id: 'claude', label: 'Claude Code' },
]
const paperAgentStatuses = ref<Record<PaperAgentEngine, PaperAgentEngineStatus | null>>({
  codex: null, claude: null, pi: null,
})
const checkingPaperAgents = ref(false)

async function refreshPaperAgentStatuses() {
  if (!paperAgentRuntimeAvailable() || checkingPaperAgents.value) return
  checkingPaperAgents.value = true
  try {
    const entries = await Promise.all(paperAgentEngines.map(async ({ id }) => [
      id,
      await paperAgentEngineStatus(id, settings.paperAgentExecutables[id] || undefined),
    ] as const))
    paperAgentStatuses.value = Object.fromEntries(entries) as Record<PaperAgentEngine, PaperAgentEngineStatus>
  } finally {
    checkingPaperAgents.value = false
  }
}

async function choosePaperAgentExecutable(engine: PaperAgentEngine) {
  const { open } = await import('@tauri-apps/plugin-dialog')
  const picked = await open({
    directory: false,
    multiple: false,
    title: t('settings.paperAgentsBrowseTitle'),
  })
  if (typeof picked !== 'string') return
  settings.paperAgentExecutables[engine] = picked
  await refreshPaperAgentStatuses()
}

async function testAi() {
  if (aiTesting.value) return
  aiTesting.value = true
  aiTestResult.value = ''
  const started = performance.now()
  try {
    let got = ''
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout 20s')), 20000))
    await Promise.race([
      (async () => {
        for await (const delta of chatStream([{ role: 'user', content: '请回复: OK' }])) {
          got += delta
          if (got.length >= 2) break
        }
      })(),
      timeout,
    ])
    aiTestResult.value = `✅ ${t('settings.aiTestOk', { ms: Math.round(performance.now() - started), reply: got.slice(0, 20) })}`
  } catch (e: any) {
    aiTestResult.value = `❌ ${e?.message ?? e}`
  } finally {
    aiTesting.value = false
  }
}

// ---- 版本与更新 ----
const updateInfo = ref<UpdateInfo | null>(null)
const checking = ref(false)
const checkError = ref('')
/** 手动检查过才显示"已是最新", 静默检查只在有新版时提示 */
const checkedManually = ref(false)
const downloads = computed(() => updateInfo.value ? pickDownloads(updateInfo.value.assets) : [])

async function doCheckUpdate(manual = true) {
  if (checking.value) return
  checking.value = true
  checkError.value = ''
  if (manual) checkedManually.value = true
  try {
    updateInfo.value = await checkUpdate(manual)
  } catch (e: any) {
    if (manual) checkError.value = e?.message ?? t('update.checkFailed')
  } finally {
    checking.value = false
  }
}

const fmtSize = (bytes: number) => `${(bytes / 1048576).toFixed(0)} MB`

async function download(url: string) {
  try {
    await openDownload(url)
    return true
  } catch {
    toast(t('update.cannotOpenLink'), 'error')
    return false
  }
}

// ---- 应用内下载安装 (桌面端, 走已配置的网络代理) ----
const installing = ref('')
const installedPath = ref('')

async function downloadOption(d: DownloadOption) {
  if (!canInAppInstall()) {
    if (await download(d.url)) toast(t('update.browserDownloadStarted'), 'success')
    return
  }
  if (installing.value) return
  installing.value = t('common.connecting')
  installedPath.value = ''
  try {
    const fileName = decodeURIComponent(d.url.split('/').pop() ?? 'LightRead-installer')
    const path = await downloadInstaller(d.url, fileName, p => {
      installing.value = p.fraction != null
        ? t('update.downloadingPct', { pct: (p.fraction * 100).toFixed(0), received: p.receivedMB, total: p.totalMB })
        : t('update.downloadingMB', { received: p.receivedMB })
    })
    installing.value = ''
    installedPath.value = path
    toast(t('update.downloadDoneOpening'), 'success')
    await openInstaller(path)
  } catch (e: any) {
    installing.value = ''
    toast(t('update.downloadFailed', { msg: e?.message ?? e }), 'error', 6000)
  }
}

async function doCopyLink(url: string) {
  const ok = await copyLink(url)
  toast(ok ? t('update.linkCopied') : t('common.copyFailed'), ok ? 'success' : 'error')
}

// ---- 存储位置 (桌面端) ----
const migrating = ref('')

async function changeLibraryRoot() {
  const { open } = await import('@tauri-apps/plugin-dialog')
  const picked = await open({ directory: true, title: t('settings.pickLibraryFolder') })
  if (typeof picked !== 'string') return
  const { hasLibraryAt, migrateLibraryTo } = await import('../storage/tauri')

  try {
    if (await hasLibraryAt(picked)) {
      if (!confirm(t('settings.useExistingLibrary', { path: picked }))) return
    } else {
      if (!confirm(t('settings.migrateConfirm', { path: picked }))) return
      migrating.value = t('settings.preparingMigration')
      await migrateLibraryTo(picked, msg => (migrating.value = msg))
    }
    settings.libraryRoot = picked
    // 设置持久化有 300ms 防抖, 直接落盘后重载
    localStorage.setItem('lightread-settings', JSON.stringify(settings.$state))
    toast(t('settings.locationSwitched'), 'success')
    setTimeout(() => location.reload(), 800)
  } catch (e: any) {
    migrating.value = ''
    toast(t('settings.switchFailed', { msg: e?.message ?? t('common.unknownError') }), 'error', 6000)
  }
}

function resetLibraryRoot() {
  if (!confirm(t('settings.resetLocationConfirm'))) return
  settings.libraryRoot = ''
  localStorage.setItem('lightread-settings', JSON.stringify(settings.$state))
  setTimeout(() => location.reload(), 300)
}

async function doExport() {
  busyScope.value = 'local'
  busy.value = t('settings.preparingExport')
  try {
    const blob = await exportBackup(msg => (busy.value = msg))
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `lightread-library-${new Date().toISOString().slice(0, 10)}${LIBRARY_ARCHIVE_EXTENSION}`
    a.click()
    URL.revokeObjectURL(a.href)
    toast(t('settings.backupExported'), 'success')
  } catch (e: any) {
    toast(t('settings.exportFailed', { msg: e?.message }), 'error', 5000)
  } finally {
    busy.value = ''
  }
}

async function doImport(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  busyScope.value = 'local'
  busy.value = t('settings.readingBackup')
  try {
    const result = await importBackup(file, msg => (busy.value = msg))
    await library.refresh()
    toast(t('settings.importDone', { books: result.books, annotations: result.annotations, sources: result.sources }), 'success', 5000)
  } catch (e: any) {
    toast(t('settings.restoreFailed', { msg: e?.message }), 'error', 5000)
  } finally {
    busy.value = ''
  }
}

const APPEARANCE_OPTIONS = [
  { value: 'system', labelKey: 'settings.appearanceSystem', icon: 'M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5zm4 16h8m-4-5v5' },
  { value: 'light', labelKey: 'settings.appearanceLight', icon: 'M12 3v2m0 14v2M5.6 5.6l1.4 1.4m10 10 1.4 1.4M3 12h2m14 0h2M5.6 18.4l1.4-1.4m10-10 1.4-1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z' },
  { value: 'dark', labelKey: 'settings.appearanceDark', icon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z' },
] as const
</script>

<template>
  <div ref="rootEl" class="settings">
    <h1>{{ t('settings.title') }}</h1>

    <nav ref="navEl" class="settings-nav" :aria-label="t('settings.navLabel')">
      <button
        v-for="s in navSections"
        :key="s.id"
        type="button"
        class="nav-chip"
        :class="{ active: activeSection === s.id }"
        :aria-current="activeSection === s.id ? 'true' : undefined"
        :data-section="s.id"
        @click="jumpTo(s.id)"
      >{{ s.label }}</button>
    </nav>

    <!-- 账号与同步 -->
    <section id="settings-sync" class="card section sync-section" :class="{ 'account-first': loggedIn }" aria-labelledby="settings-sync-heading">
      <h2 id="settings-sync-heading" tabindex="-1">{{ t('settings.syncSection') }}</h2>

      <!-- 同步状态: 账号与 WebDAV 共用, 有同步目标时显示 -->
      <div v-if="syncReady" class="sync-bar">
        <div class="sync-bar-main">
          <span class="sync-bar-icon" :class="{ error: syncStatus.error }" aria-hidden="true">
            <svg v-if="syncStatus.error" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v5m0 3.5h.01M10.3 3.9 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg>
            <svg v-else viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 8.5a4.75 4.75 0 0 1-.25 9.5H7z" /><path d="m9.5 13.5 2 2 3.5-4" /></svg>
          </span>
          <div class="sync-bar-text">
            <div class="row-title">{{ t('sync.targets', { targets: syncTargetNames }) }}</div>
            <span class="sync-status" :class="{ error: syncStatus.error }" role="status" aria-live="polite">{{ syncStatus.text }}</span>
          </div>
          <button class="btn btn-primary sync-now" :disabled="syncState.running || !!busy || !!davStage" @click="doSyncNow">
            <svg :class="{ spinning: syncState.running }" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 0 1-15.5 6.2M3 12a9 9 0 0 1 15.5-6.2" /><path d="M18.5 2.5v3.7h-3.7M5.5 21.5v-3.7h3.7" /></svg>
            {{ syncState.running ? t('sync.running') : t('sync.now') }}
          </button>
        </div>
        <div class="sync-toggles">
          <label class="toggle-row">
            <span class="toggle-text">
              <span class="row-title">{{ t('sync.auto') }}</span>
              <span class="row-desc">{{ t('sync.autoHint') }}</span>
            </span>
            <span class="switch">
              <input v-model="settings.webdavSyncAuto" type="checkbox" role="switch" :aria-checked="settings.webdavSyncAuto" />
              <span class="switch-track" aria-hidden="true"></span>
            </span>
          </label>
          <label class="toggle-row">
            <span class="toggle-text">
              <span class="row-title">{{ t('sync.settings') }}</span>
              <span class="row-desc">{{ t('sync.settingsHint') }}</span>
            </span>
            <span class="switch">
              <input v-model="settings.syncSettings" type="checkbox" role="switch" :aria-checked="settings.syncSettings" />
              <span class="switch-track" aria-hidden="true"></span>
            </span>
          </label>
          <label v-if="settings.syncSettings" class="toggle-row toggle-sub">
            <span class="toggle-text">
              <span class="row-title">
                {{ t('sync.secrets') }}
                <svg class="lock" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
              </span>
              <span class="row-desc">{{ t('sync.secretsHint') }}</span>
            </span>
            <span class="switch">
              <input type="checkbox" role="switch" :checked="settings.syncSecrets" :aria-checked="settings.syncSecrets" @change="onSecretsToggle" />
              <span class="switch-track" aria-hidden="true"></span>
            </span>
          </label>
        </div>
      </div>

      <!-- 轻阅账号 -->
      <div class="sync-block account-block">
        <AccountCard />
      </div>

      <!-- WebDAV 网盘 -->
      <div class="sync-block webdav-block">
        <template v-if="!davShowForm">
          <div class="conn-card">
            <span class="conn-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path :d="DAV_PROVIDER_ICONS[davProviderId]" /></svg>
            </span>
            <div class="conn-id">
              <div class="row-title">
                {{ t(`webdav.provider.${davProviderId}`) }}
                <span class="conn-chip">{{ t('webdav.connected') }}</span>
              </div>
              <div class="conn-sub">
                {{ settings.webdavUser }}<template v-if="!davProvider.url"> · {{ displayHost(settings.webdavUrl) }}</template>
              </div>
            </div>
            <div class="conn-actions">
              <button class="btn btn-sm" :disabled="!!busy" @click="startDavEdit">{{ t('webdav.edit') }}</button>
              <button class="btn btn-sm" :disabled="!!busy" @click="openDavDisconnect">{{ t('webdav.disconnect') }}</button>
            </div>
          </div>
          <label class="toggle-row sync-files">
            <span class="toggle-text">
              <span class="row-title">{{ t('sync.files') }}</span>
              <span class="row-desc">{{ t('sync.filesHint') }}</span>
            </span>
            <span class="switch">
              <input v-model="settings.webdavSyncFiles" type="checkbox" role="switch" :aria-checked="settings.webdavSyncFiles" />
              <span class="switch-track" aria-hidden="true"></span>
            </span>
          </label>
          <details class="more">
            <summary>
              <svg class="more-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
              {{ t('webdav.more') }}
            </summary>
            <div class="more-body">
              <div class="action-row">
                <button class="btn btn-sm" :disabled="!!busy || syncState.running" @click="davTest">{{ t('settings.testConnection') }}</button>
                <button class="btn btn-sm" :disabled="!!busy || syncState.running" @click="davBackup">{{ t('webdav.backup') }}</button>
                <button class="btn btn-sm" :disabled="!!busy || syncState.running" @click="davRestore">{{ t('webdav.restore') }}</button>
              </div>
              <div class="row-desc">{{ t('webdav.backupDesc') }}</div>
              <div v-if="busy && busyScope === 'dav'" class="busy" role="status">{{ busy }}</div>
              <div v-else-if="davInfo" class="dav-info" :class="{ error: davInfo.error }" role="status">{{ davInfo.text }}</div>
            </div>
          </details>
        </template>

        <template v-else>
          <div class="block-head">
            <div class="row-title">{{ t('webdav.title') }}</div>
            <div class="row-desc">{{ t(syncReady && !davConnected ? 'webdav.descAlt' : 'webdav.desc') }}</div>
          </div>
          <div v-if="davNeedsPass && !davEditing" class="dav-notice" role="status">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
            <span>{{ t('webdav.passNeeded') }}</span>
          </div>
          <div class="dav-providers" role="group" :aria-label="t('webdav.chooseProvider')">
            <button
              v-for="p in WEBDAV_PROVIDERS"
              :key="p.id"
              type="button"
              class="dav-provider"
              :class="{ active: davPicked && davDraft.provider === p.id }"
              :aria-pressed="davPicked && davDraft.provider === p.id"
              :disabled="!!davStage"
              @click="pickDavProvider(p.id)"
            >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="DAV_PROVIDER_ICONS[p.id]" /></svg>
              <span class="dav-provider-text">
                <span class="dav-provider-name">{{ t(`webdav.provider.${p.id}`) }}</span>
                <span class="dav-provider-hint">{{ t(`webdav.providerHint.${p.id}`) }}</span>
              </span>
            </button>
          </div>

          <form v-if="davPicked" class="dav-form" novalidate @submit.prevent="connectWebdav">
            <div v-if="!draftProvider.url" class="field">
              <label class="field-label" for="dav-address">{{ t('webdav.address') }}</label>
              <input
                id="dav-address"
                v-model="davDraft.address"
                class="input"
                type="url"
                inputmode="url"
                autocapitalize="off"
                autocomplete="url"
                spellcheck="false"
                :placeholder="t(`webdav.addressPlaceholder.${davDraft.provider}`)"
                :disabled="!!davStage"
              />
              <div class="field-hint">{{ t(`webdav.addressHint.${davDraft.provider}`) }}</div>
            </div>
            <div class="dav-grid">
              <div class="field">
                <label class="field-label" for="dav-user">{{ t('webdav.user') }}</label>
                <input
                  id="dav-user"
                  v-model="davDraft.user"
                  class="input"
                  autocomplete="username"
                  autocapitalize="off"
                  spellcheck="false"
                  :placeholder="t(`webdav.userPlaceholder.${draftProvider.url ? davDraft.provider : 'default'}`)"
                  :disabled="!!davStage"
                />
              </div>
              <div class="field">
                <label class="field-label" for="dav-pass">{{ draftProvider.appPasswordUrl ? t('webdav.appPassword') : t('webdav.password') }}</label>
                <input
                  id="dav-pass"
                  ref="davPassInput"
                  v-model="davDraft.pass"
                  class="input"
                  type="password"
                  autocomplete="current-password"
                  :placeholder="draftProvider.appPasswordUrl ? t('webdav.appPasswordPlaceholder') : t('webdav.passwordPlaceholder')"
                  :aria-invalid="davErrorKind === 'auth'"
                  :aria-describedby="davError ? 'dav-error' : undefined"
                  :disabled="!!davStage"
                />
              </div>
            </div>
            <div v-if="draftProvider.appPasswordUrl" class="field-hint dav-app-pass">
              {{ t(`webdav.appPasswordHint.${davDraft.provider}`) }}
              <button type="button" class="link-btn" @click="openExternalUrl(draftProvider.appPasswordUrl!)">
                {{ t(`webdav.getAppPassword.${davDraft.provider}`) }}
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" /></svg>
              </button>
            </div>
            <div v-if="davWebNote" class="field-hint">{{ davWebNote }}</div>
            <div v-if="davError" id="dav-error" class="dav-error" role="alert">{{ davError }}</div>
            <div class="dav-submit">
              <button type="submit" class="btn btn-primary dav-connect" :disabled="!!davStage">
                <svg v-if="davStage" class="spinning" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.2-8.56" /></svg>
                {{ davStage ? t('webdav.connecting') : t('webdav.connect') }}
              </button>
              <button v-if="davEditing" type="button" class="btn" :disabled="!!davStage" @click="cancelDavEdit">{{ t('common.cancel') }}</button>
              <button v-else-if="davNeedsPass" type="button" class="btn" :disabled="!!davStage" @click="openDavDisconnect">{{ t('webdav.disconnect') }}</button>
              <span v-if="davStageText" class="dav-stage" role="status" aria-live="polite">{{ davStageText }}</span>
            </div>
          </form>
        </template>
      </div>
    </section>

    <!-- 通用 -->
    <section id="settings-general" class="card section" aria-labelledby="settings-general-heading">
      <h2 id="settings-general-heading" tabindex="-1">{{ t('settings.general') }}</h2>
      <div class="row">
        <div class="row-text">
          <div class="row-title">{{ t('settings.language') }}</div>
        </div>
        <div class="segmented" role="group" :aria-label="t('settings.language')">
          <button :aria-pressed="settings.language === 'zh'" :class="{ active: settings.language === 'zh' }" @click="settings.language = 'zh'">中文</button>
          <button :aria-pressed="settings.language === 'en'" :class="{ active: settings.language === 'en' }" @click="settings.language = 'en'">English</button>
        </div>
      </div>
      <div class="row">
        <div class="row-text">
          <div class="row-title">{{ t('settings.appearance') }}</div>
          <div class="row-desc">{{ t('settings.appearanceDesc') }}</div>
        </div>
        <div class="segmented" role="group" :aria-label="t('settings.appearance')">
          <button
            v-for="opt in APPEARANCE_OPTIONS"
            :key="opt.value"
            :aria-pressed="settings.appearance === opt.value"
            :class="{ active: settings.appearance === opt.value }"
            @click="settings.appearance = opt.value"
          >
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="opt.icon" /></svg>
            {{ t(opt.labelKey) }}
          </button>
        </div>
      </div>
    </section>

    <!-- 阅读 -->
    <section id="settings-reading" class="card section" aria-labelledby="settings-reading-heading">
      <h2 id="settings-reading-heading" tabindex="-1">{{ t('settings.reading') }}</h2>
      <div class="row">
        <div class="row-text">
          <div class="row-title">{{ t('settings.pdfRenderer') }}</div>
          <div class="row-desc">{{ t('settings.pdfRendererDesc') }}</div>
        </div>
        <div class="segmented" role="group" :aria-label="t('settings.pdfRenderer')">
          <button :aria-pressed="settings.pdf.renderer === 'mupdf'" :class="{ active: settings.pdf.renderer === 'mupdf' }" @click="settings.pdf.renderer = 'mupdf'">MuPDF</button>
          <button :aria-pressed="settings.pdf.renderer === 'pdfium'" :class="{ active: settings.pdf.renderer === 'pdfium' }" @click="settings.pdf.renderer = 'pdfium'">PDFium</button>
        </div>
      </div>
      <div class="row row-inline">
        <div class="row-text">
          <div class="row-title">{{ t('settings.resetTypography') }}</div>
          <div class="row-desc">{{ t('settings.resetTypographyDesc') }}</div>
        </div>
        <button class="btn" @click="settings.resetReader(); toast(t('settings.resetDone'), 'success')">{{ t('settings.restoreDefault') }}</button>
      </div>
    </section>

    <!-- AI 助手 -->
    <section id="settings-ai" class="card section" aria-labelledby="settings-ai-heading">
      <h2 id="settings-ai-heading" tabindex="-1">{{ t('settings.aiTitle') }}</h2>
      <p class="section-desc">{{ t('settings.aiDesc') }}</p>
      <div class="field-grid">
        <div class="field">
          <label class="field-label" for="ai-provider">{{ t('settings.aiProvider') }}</label>
          <select id="ai-provider" v-model="settings.aiProvider" class="input" @change="onAiProviderChange">
            <option v-for="p in AI_PROVIDERS" :key="p.id" :value="p.id">
              {{ p.label }}{{ p.id === 'trial' ? t('settings.aiTrialTag') : p.id === 'siliconflow' || p.id === 'zhipu' ? t('settings.aiFreeTag') : '' }}
            </option>
          </select>
        </div>
        <div class="field">
          <label class="field-label" for="ai-model">{{ t('settings.aiModelLabel') }}</label>
          <input id="ai-model" v-model="settings.aiModel" class="input" autocapitalize="off" spellcheck="false" :placeholder="t('settings.aiModelPh')" />
        </div>
        <div v-if="aiShowBaseUrl" class="field field-wide">
          <label class="field-label" for="ai-base-url">{{ t('settings.aiBaseUrlLabel') }}</label>
          <input id="ai-base-url" v-model="settings.aiBaseUrl" class="input" type="url" inputmode="url" autocapitalize="off" spellcheck="false" placeholder="https://api.siliconflow.cn/v1" />
        </div>
        <div class="field field-wide">
          <label class="field-label" for="ai-key">API Key</label>
          <input id="ai-key" v-model="settings.aiApiKey" class="input" type="password" :placeholder="t('settings.aiKeyPh')" autocomplete="new-password" />
        </div>
      </div>
      <div class="ai-actions">
        <button class="btn btn-primary" :disabled="aiTesting || !settings.aiBaseUrl || !settings.aiModel" @click="testAi">
          {{ aiTesting ? t('settings.testing') : t('settings.aiTest') }}
        </button>
        <button v-if="!aiShowBaseUrl" type="button" class="link-btn" @click="aiBaseUrlOpen = true">{{ t('settings.aiEditBaseUrl') }}</button>
        <button v-if="aiDocsUrl" type="button" class="link-btn" @click="download(aiDocsUrl)">{{ t('settings.aiGetKey') }}</button>
      </div>
      <div v-if="aiTestResult" class="dav-info ai-result" role="status">{{ aiTestResult }}</div>
    </section>

    <section v-if="paperAgentRuntimeAvailable()" id="settings-agents" class="card section" aria-labelledby="settings-agents-heading">
      <h2 id="settings-agents-heading" tabindex="-1">{{ t('settings.paperAgentsTitle') }}</h2>
      <div class="row row-inline">
        <div class="row-text">
          <div class="row-title">{{ t('settings.paperAgentsEngine') }}</div>
          <div class="row-desc">{{ t('settings.paperAgentsDesc') }}</div>
        </div>
        <button class="btn btn-sm" :disabled="checkingPaperAgents" @click="refreshPaperAgentStatuses">
          {{ checkingPaperAgents ? t('settings.testing') : t('settings.paperAgentsCheck') }}
        </button>
      </div>
      <div class="agent-default-row">
        <span>{{ t('settings.paperAgentsDefault') }}</span>
        <select v-model="settings.paperAgentEngine" class="input" :aria-label="t('settings.paperAgentsDefault')">
          <option v-for="engine in paperAgentEngines" :key="engine.id" :value="engine.id">{{ engine.label }}</option>
        </select>
      </div>
      <div v-for="engine in paperAgentEngines" :key="engine.id" class="agent-engine-setting">
        <div class="agent-engine-title">
          <strong>{{ engine.label }}</strong>
          <span
            v-if="paperAgentStatuses[engine.id]"
            :class="paperAgentStatuses[engine.id]?.compatible && paperAgentStatuses[engine.id]?.authenticated ? 'agent-ok' : 'agent-bad'"
          >
            {{ paperAgentStatuses[engine.id]?.compatible && paperAgentStatuses[engine.id]?.authenticated ? t('settings.paperAgentsReady') : paperAgentStatuses[engine.id]?.reason }}
          </span>
        </div>
        <div class="agent-path-row">
          <input
            v-model="settings.paperAgentExecutables[engine.id]"
            class="input"
            :placeholder="t('settings.paperAgentsPathPlaceholder')"
            :aria-label="`${engine.label} · ${t('settings.paperAgentsPathPlaceholder')}`"
            @change="refreshPaperAgentStatuses"
          />
          <button type="button" class="btn btn-sm" @click="choosePaperAgentExecutable(engine.id)">
            {{ t('settings.paperAgentsBrowse') }}
          </button>
        </div>
        <div v-if="paperAgentStatuses[engine.id]?.path" class="agent-engine-meta">
          {{ paperAgentStatuses[engine.id]?.version }} · {{ paperAgentStatuses[engine.id]?.path }}
        </div>
      </div>
      <p class="agent-settings-note">{{ t('settings.paperAgentsNote') }}</p>
    </section>

    <!-- 数据 -->
    <section id="settings-data" class="card section" aria-labelledby="settings-data-heading">
      <h2 id="settings-data-heading" tabindex="-1">{{ t('settings.data') }}</h2>
      <div class="row">
        <div class="row-text">
          <div class="row-title">{{ t('settings.storageBackend') }}</div>
          <div class="row-desc">{{ storageKind === 'filesystem' ? t('settings.storageDesktop') : t('settings.storageWeb') }}</div>
        </div>
      </div>
      <div v-if="isTauri()" class="row">
        <div class="row-text">
          <div class="row-title">{{ t('settings.storageLocation') }}</div>
          <div class="row-desc">
            {{ t('settings.storageLocationDesc') }}<br />
            {{ t('common.current') }}: <code>{{ settings.libraryRoot || t('settings.defaultAppData') }}</code>
          </div>
        </div>
        <div class="row-actions">
          <button class="btn" :disabled="!!migrating" @click="changeLibraryRoot">{{ t('settings.changeLocation') }}</button>
          <button v-if="settings.libraryRoot" class="btn" :disabled="!!migrating" @click="resetLibraryRoot">{{ t('settings.restoreDefault') }}</button>
        </div>
      </div>
      <div v-if="migrating" class="busy">{{ migrating }}</div>
      <div class="row">
        <div class="row-text">
          <div class="row-title">{{ t('settings.backupRestore') }}</div>
          <div class="row-desc">{{ t('settings.backupDesc') }}</div>
        </div>
        <div class="row-actions">
          <button class="btn" :disabled="!!busy" @click="doExport">{{ t('settings.exportBackup') }}</button>
          <button class="btn" :disabled="!!busy" @click="backupInput?.click()">{{ t('settings.importBackup') }}</button>
          <input ref="backupInput" type="file" accept=".okf.zip,.lightread,.zip" hidden @change="doImport" />
        </div>
      </div>
      <div v-if="busy && busyScope === 'local'" class="busy">{{ busy }}</div>
    </section>

    <!-- 网络 -->
    <section id="settings-network" class="card section" aria-labelledby="settings-network-heading">
      <h2 id="settings-network-heading" tabindex="-1">{{ t('settings.network') }}</h2>
      <template v-if="isTauri()">
        <div class="row">
          <div class="row-text">
            <div class="row-title">{{ t('settings.proxyTitle') }}</div>
            <div class="row-desc">
              {{ t('settings.proxyDesc') }}
              ({{ t('settings.proxyDescPort') }} <code>7890</code>)
            </div>
          </div>
        </div>
        <div class="proxy-grid">
          <select v-model="proxy.scheme" class="input" :aria-label="t('settings.proxyTitle')">
            <option v-for="s in PROXY_SCHEMES" :key="s.value" :value="s.value">{{ s.labelKey ? t(s.labelKey) : s.label }}</option>
          </select>
          <input v-model="proxy.host" class="input" :placeholder="t('settings.proxyHostPlaceholder')" :aria-label="t('settings.proxyHostPlaceholder')" :disabled="!proxy.scheme" />
          <input v-model="proxy.port" class="input port" inputmode="numeric" :placeholder="t('settings.proxyPort')" :aria-label="t('settings.proxyPort')" :disabled="!proxy.scheme" />
        </div>
        <div v-if="proxy.scheme" class="proxy-grid">
          <input v-model="proxy.username" class="input" :placeholder="t('common.usernameOptional')" :aria-label="t('common.usernameOptional')" autocomplete="off" />
          <input v-model="proxy.password" class="input" type="password" :placeholder="t('common.passwordOptional')" :aria-label="t('common.passwordOptional')" autocomplete="new-password" />
          <button class="btn port" :disabled="testing" @click="testProxy">
            {{ testing ? t('settings.testingProxy') : t('settings.testConnection') }}
          </button>
        </div>
        <div v-if="settings.httpProxy" class="proxy-current">{{ t('common.current') }}: <code>{{ settings.httpProxy }}</code></div>
        <div v-if="testResult" class="proxy-result">{{ testResult }}</div>
      </template>
      <template v-else>
        <div class="field">
          <label class="row-title" for="cors-proxy">{{ t('settings.corsTitle') }}</label>
          <div class="row-desc cors-desc">
            {{ t('settings.corsDesc1') }}
            {{ t('settings.corsDesc2pre') }} <code>{url}</code> {{ t('settings.corsDesc2post') }}
          </div>
          <input
            id="cors-proxy"
            v-model="settings.corsProxy"
            class="input proxy-input"
            type="url"
            inputmode="url"
            autocapitalize="off"
            spellcheck="false"
            placeholder="https://your-proxy.example.com/?url={url}"
          />
        </div>
      </template>
    </section>

    <!-- 隐私 -->
    <section id="settings-privacy" class="card section" aria-labelledby="settings-privacy-heading">
      <h2 id="settings-privacy-heading" tabindex="-1">{{ t('settings.privacy') }}</h2>
      <label class="toggle-row">
        <span class="toggle-text">
          <span class="row-title">{{ t('settings.usageStats') }}</span>
          <span class="row-desc">{{ t('settings.usageStatsShort') }}</span>
        </span>
        <span class="switch">
          <input v-model="settings.usageStats" type="checkbox" role="switch" :aria-checked="settings.usageStats" />
          <span class="switch-track" aria-hidden="true"></span>
        </span>
      </label>
      <details class="more">
        <summary>
          <svg class="more-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
          {{ t('settings.usageStatsMore') }}
        </summary>
        <div class="more-body">
          <p class="row-desc">{{ t('settings.usageStatsDesc') }}</p>
          <div class="row row-inline">
            <div class="row-text">
              <div class="row-title">{{ t('settings.resetStatsId') }}</div>
              <div class="row-desc">{{ t('settings.resetStatsIdDesc') }}</div>
            </div>
            <button class="btn" @click="resetInstallId(); toast(t('settings.resetStatsIdDone'), 'success')">{{ t('settings.resetStatsIdAction') }}</button>
          </div>
        </div>
      </details>
    </section>

    <!-- 关于 -->
    <section id="settings-about" class="card section" aria-labelledby="settings-about-heading">
      <h2 id="settings-about-heading" tabindex="-1">{{ t('settings.about') }}</h2>

      <div class="app-identity">
        <img class="app-icon" src="/icon-192.png" alt="LightRead" />
        <div class="app-meta">
          <div class="app-name">
            LightRead 轻阅
            <span class="version-chip">v{{ CURRENT_VERSION }}</span>
            <span class="env-chip">{{ !isTauri() ? t('settings.webVersion') : isAndroid ? t('settings.androidVersion') : t('settings.desktopVersion') }}</span>
          </div>
          <div class="app-tagline">{{ t('settings.tagline') }}</div>
        </div>
        <div class="about-actions">
          <button class="btn" @click="$router.push('/manual')">{{ t('manual.title') }}</button>
          <button class="btn" :disabled="checking" @click="doCheckUpdate()">
            {{ checking ? t('update.checking') : t('update.check') }}
          </button>
        </div>
      </div>

      <!-- 检查结果 -->
      <div v-if="checkError" class="update-state error" role="alert">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm0 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16zm0 3a1 1 0 0 1 1 1v5a1 1 0 1 1-2 0V8a1 1 0 0 1 1-1zm0 8.5a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5z"/></svg>
        {{ checkError }}
      </div>
      <div v-else-if="checkedManually && !checking && updateInfo && !updateInfo.hasUpdate" class="update-state ok" role="status">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm0 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16zm4.2 5.3a1 1 0 0 1 0 1.4l-4.9 4.9a1 1 0 0 1-1.4 0l-2.1-2.1a1 1 0 1 1 1.4-1.4l1.4 1.4 4.2-4.2a1 1 0 0 1 1.4 0z"/></svg>
        {{ t('update.latest') }}
      </div>

      <!-- 新版本卡片 -->
      <div v-if="updateInfo?.hasUpdate" class="update-card">
        <div class="update-head">
          <span class="update-badge">{{ t('update.newVersion') }}</span>
          <strong>v{{ updateInfo.version }}</strong>
          <span class="update-date">{{ updateInfo.publishedAt }}</span>
        </div>
        <pre v-if="updateInfo.notes" class="update-notes">{{ updateInfo.notes }}</pre>
        <div class="update-actions">
          <template v-for="(d, i) in downloads.filter(x => x.recommended)" :key="d.url">
            <button
              class="btn btn-sm"
              :class="{ 'btn-primary': i === 0 }"
              :disabled="!!installing"
              @click="downloadOption(d)"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v11m0 0 4-4m-4 4-4-4M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2"/></svg>
              {{ d.label }} · {{ fmtSize(d.size) }}
            </button>
            <button class="copy-link-btn" :title="t('update.copyLinkTitle')" :aria-label="t('update.copyLinkTitle')" @click="doCopyLink(d.url)">
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 5a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-2v-2h2a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1h-8a1 1 0 0 0-1 1v2H8V5zM2 11a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3v-8zm3-1a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1H5z"/></svg>
            </button>
          </template>
          <a class="all-downloads" href="javascript:void 0" @click="download(updateInfo.pageUrl)">
            {{ t('update.allPlatforms') }}
          </a>
        </div>
        <div v-if="installing" class="install-progress">
          {{ installing }}
          <span v-if="settings.httpProxy" class="install-hint">{{ t('update.viaProxy', { proxy: settings.httpProxy }) }}</span>
        </div>
        <div v-else-if="installedPath" class="install-done">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm0 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16zm4.2 5.3a1 1 0 0 1 0 1.4l-4.9 4.9a1 1 0 0 1-1.4 0l-2.1-2.1a1 1 0 1 1 1.4-1.4l1.4 1.4 4.2-4.2a1 1 0 0 1 1.4 0z"/></svg>
          {{ t('update.downloadedTo') }} <code>{{ installedPath }}</code>
          <button class="btn btn-sm" @click="openInstaller(installedPath)">{{ t('update.openInstaller') }}</button>
        </div>
        <p v-else-if="canInAppInstall()" class="install-tip">
          {{ t('update.installTipMain') }}{{ settings.httpProxy ? t('update.installTipProxied') : t('update.installTipNoProxy') }}{{ t('update.installTipEnd') }}
        </p>
      </div>

      <div class="star-callout">
        <div class="star-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M12 2.5a1 1 0 0 1 .9.56l2.44 4.95 5.46.8a1 1 0 0 1 .56 1.7l-3.95 3.85.93 5.44a1 1 0 0 1-1.45 1.05L12 18.28l-4.89 2.57a1 1 0 0 1-1.45-1.05l.93-5.44-3.95-3.85a1 1 0 0 1 .56-1.7l5.46-.8 2.44-4.95A1 1 0 0 1 12 2.5z"/></svg>
        </div>
        <div class="star-copy">
          <div class="star-title">{{ t('settings.starTitle') }}</div>
          <div class="star-desc">{{ t('settings.starDesc') }}</div>
        </div>
        <button class="btn btn-primary star-action" @click="download(REPO_URL)">
          {{ t('settings.starAction') }}
        </button>
      </div>

      <div class="about">
        <p>
          {{ t('settings.aboutFormats') }}
        </p>
        <p class="about-links">
          <a href="javascript:void 0" @click="download(REPO_URL)">{{ t('settings.repoLink') }}</a>
          <a href="javascript:void 0" @click="download(ISSUES_URL)">{{ t('settings.issuesLink') }}</a>
          <a href="javascript:void 0" @click="download(RELEASES_URL)">{{ t('settings.releasesLink') }}</a>
        </p>
        <p class="muted">
          {{ t('settings.author') }}: 云中江树 ({{ t('settings.wechat') }}: 云中江树) · {{ t('settings.license') }}: GNU AGPL v3.0+
        </p>
      </div>
    </section>

    <div v-if="showSecretsConfirm" class="modal-mask" @click.self="showSecretsConfirm = false" @keydown.esc="showSecretsConfirm = false">
      <div class="modal confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="secrets-title" aria-describedby="secrets-desc">
        <h3 id="secrets-title">{{ t('sync.secretsConfirmTitle') }}</h3>
        <p id="secrets-desc" class="modal-text">{{ t('sync.secretsConfirmBody') }}</p>
        <p class="modal-text">{{ t('sync.secretsConfirmAdvice') }}</p>
        <div class="modal-actions">
          <button ref="secretsCancelBtn" class="btn" @click="showSecretsConfirm = false">{{ t('common.cancel') }}</button>
          <button class="btn btn-primary" @click="confirmSecrets">{{ t('sync.secretsConfirmAction') }}</button>
        </div>
      </div>
    </div>

    <div v-if="showDavDisconnect" class="modal-mask" @click.self="showDavDisconnect = false" @keydown.esc="showDavDisconnect = false">
      <div class="modal confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="dav-disconnect-title" aria-describedby="dav-disconnect-desc">
        <h3 id="dav-disconnect-title">{{ t('webdav.disconnectTitle', { name: t(`webdav.provider.${davProviderId}`) }) }}</h3>
        <p id="dav-disconnect-desc" class="modal-text">{{ t('webdav.disconnectConfirm') }}</p>
        <div class="modal-actions">
          <button ref="davDisconnectCancel" class="btn" @click="showDavDisconnect = false">{{ t('common.cancel') }}</button>
          <button class="btn btn-danger" @click="confirmDavDisconnect">{{ t('webdav.disconnect') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ================= 页面骨架 ================= */
.settings {
  --nav-h: 52px;
  padding: 24px 28px calc(40px + var(--lr-safe-bottom));
  max-width: 820px;
  margin: 0 auto;
}
h1 {
  font-size: 22px;
  font-weight: 650;
  letter-spacing: -0.01em;
  margin-bottom: 6px;
}

/* 分区导航: 在 .main 这个滚动容器里吸顶 */
.settings-nav {
  position: sticky;
  top: 0;
  z-index: 3;
  display: flex;
  gap: 6px;
  margin: 0 -28px 10px;
  padding: 10px 28px;
  overflow-x: auto;
  scrollbar-width: none;
  background: var(--bg);
  box-shadow: 0 1px 0 color-mix(in srgb, var(--border) 70%, transparent);
}
.settings-nav::-webkit-scrollbar {
  display: none;
}
.nav-chip {
  flex-shrink: 0;
  height: 32px;
  padding: 0 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: var(--card);
  color: var(--text-2);
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease),
    border-color var(--dur-fast) var(--ease);
}
.nav-chip:hover {
  color: var(--text);
  border-color: var(--border-strong);
}
.nav-chip.active {
  background: var(--brand);
  border-color: var(--brand);
  color: var(--on-brand);
}
.nav-chip:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}

.section {
  padding: 4px 20px 6px;
  margin-bottom: 14px;
  scroll-margin-top: calc(var(--nav-h) + 8px);
}
h2 {
  font-size: 12px;
  font-weight: 650;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-3);
  padding: 14px 0 4px;
}
h2:focus {
  outline: none;
}
.section-desc {
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--text-3);
  margin: 4px 0 2px;
}

/* ================= 行: 标题 + 一行说明, 控件在右 (手机上可换到下方) ================= */
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 0;
}
.row + .row,
.row + .busy + .row {
  border-top: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
}
.row-text {
  min-width: 0;
}
.row-title {
  font-size: 14px;
  font-weight: 550;
  color: var(--text);
}
.row-desc {
  font-size: 12.5px;
  color: var(--text-3);
  margin-top: 3px;
  line-height: 1.6;
}
.row-desc code,
.proxy-current code,
.install-done code {
  font-family: var(--font-mono);
  font-size: 0.92em;
  background: var(--surface-2);
  padding: 1px 5px;
  border-radius: 4px;
}
.row > .btn {
  flex-shrink: 0;
}
.row-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.busy {
  font-size: 12px;
  color: var(--brand);
  padding: 0 0 10px;
}

/* ---- 开关行 ---- */
.toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 0;
  cursor: pointer;
}
.toggle-row + .toggle-row {
  border-top: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
}
.toggle-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.toggle-text .row-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.toggle-sub {
  padding-left: 14px;
  margin-left: 2px;
  border-left: 2px solid var(--border);
}
.toggle-row.toggle-sub {
  border-top: none;
  padding-top: 2px;
  padding-bottom: 2px;
  margin-bottom: 12px;
  min-height: 0;
}
.lock {
  color: var(--warning);
}
.switch {
  position: relative;
  width: 40px;
  height: 24px;
  flex-shrink: 0;
}
.switch input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
  z-index: 1;
}
.switch-track {
  position: absolute;
  inset: 0;
  border-radius: var(--radius-pill);
  background: var(--border-strong);
  transition: background var(--dur) var(--ease);
}
.switch-track::after {
  content: '';
  position: absolute;
  top: 3px;
  left: 3px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--on-brand);
  box-shadow: var(--shadow-sm);
  transition: transform var(--dur) var(--ease);
}
.switch input:checked + .switch-track {
  background: var(--brand);
}
.switch input:checked + .switch-track::after {
  transform: translateX(16px);
}
.switch input:focus-visible + .switch-track {
  box-shadow: var(--ring);
}
.switch input:disabled + .switch-track {
  opacity: 0.5;
}

/* ---- 表单 ---- */
.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}
.field-label {
  font-size: 12.5px;
  font-weight: 550;
  color: var(--text-2);
}
.field-hint {
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.field-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-top: 12px;
}
.field-wide {
  grid-column: 1 / -1;
}
.link-btn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  font-weight: 550;
  color: var(--brand);
  cursor: pointer;
}
.link-btn:hover {
  text-decoration: underline;
}
.link-btn:focus-visible {
  outline: none;
  box-shadow: var(--ring);
  border-radius: 4px;
}

/* ---- 折叠: 更多操作 / 统计详情 ---- */
.more {
  border-top: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
}
.more summary {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: var(--tap-min);
  font-size: 13px;
  color: var(--text-2);
  cursor: pointer;
  list-style: none;
}
.more summary::-webkit-details-marker {
  display: none;
}
.more summary:hover {
  color: var(--text);
}
.more summary:focus-visible {
  outline: none;
  box-shadow: var(--ring);
  border-radius: 4px;
}
.more-chevron {
  transition: transform var(--dur-fast) var(--ease);
}
.more[open] .more-chevron {
  transform: rotate(90deg);
}
.more-body {
  padding-bottom: 12px;
}
.more-body > .row-desc {
  margin-top: 0;
}
.more-body .row {
  border-top: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
  margin-top: 10px;
}
.action-row {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.more-body .action-row + .row-desc {
  margin-top: 8px;
}

/* ================= 账号与同步 ================= */
.sync-bar {
  background: var(--surface-2);
  border-radius: var(--radius-lg);
  padding: 14px 14px 2px;
  margin: 8px 0 4px;
}
.sync-bar-main {
  display: flex;
  align-items: center;
  gap: 12px;
}
.sync-bar-icon {
  width: 38px;
  height: 38px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border-radius: 10px;
  background: var(--success-soft);
  color: var(--success);
}
.sync-bar-icon.error {
  background: var(--danger-soft);
  color: var(--danger);
}
.sync-bar-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.sync-status {
  font-size: 12.5px;
  color: var(--text-3);
  min-width: 0;
  overflow-wrap: anywhere;
}
.sync-status.error {
  color: var(--danger);
}
.sync-now {
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.spinning {
  animation: sync-spin 1s linear infinite;
}
@keyframes sync-spin {
  to { transform: rotate(360deg); }
}
.sync-toggles {
  margin-top: 10px;
  border-top: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
}
.sync-section {
  display: flex;
  flex-direction: column;
}
/* 已登录: 身份卡在最上, 其次同步状态; 未登录: 同步状态 (若有 WebDAV) 在前, 登录表单随后 */
.account-first .account-block {
  order: -1;
}
.account-first h2 {
  order: -2;
}
.account-first .sync-bar {
  margin-top: 0;
  margin-bottom: 8px;
}
.sync-block {
  padding: 16px 0;
}
.sync-block + .sync-block {
  border-top: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
}
.webdav-block {
  padding-bottom: 6px;
}
.block-head .row-desc {
  margin-top: 2px;
}
.conn-card {
  display: flex;
  align-items: center;
  gap: 12px;
}
.conn-icon {
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border-radius: 10px;
  background: var(--brand-light);
  color: var(--brand);
}
.conn-id {
  flex: 1;
  min-width: 0;
}
.conn-id .row-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.conn-chip {
  font-size: 11.5px;
  font-weight: 500;
  color: var(--success);
  background: var(--success-soft);
  border-radius: var(--radius-pill);
  padding: 0 8px;
  line-height: 20px;
}
.conn-sub {
  font-size: 13px;
  color: var(--text-2);
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.conn-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
.sync-files {
  margin-top: 6px;
}
.dav-info {
  font-size: 12px;
  color: var(--success);
  margin-top: 6px;
  overflow-wrap: anywhere;
}
.dav-info.error {
  color: var(--danger);
}
.dav-providers {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  margin-top: 12px;
}
.dav-provider {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 52px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--card);
  color: var(--text-2);
  text-align: left;
  cursor: pointer;
  transition: border-color var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease);
}
.dav-provider svg {
  flex-shrink: 0;
  color: var(--text-3);
}
.dav-provider:hover:not(:disabled) {
  border-color: var(--border-strong);
}
.dav-provider.active {
  border-color: var(--brand);
  background: var(--brand-soft);
  color: var(--text);
}
.dav-provider.active svg {
  color: var(--brand);
}
.dav-provider:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.dav-provider:disabled {
  cursor: default;
  opacity: 0.7;
}
.dav-provider-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.dav-provider-name {
  font-size: 13.5px;
  font-weight: 550;
}
.dav-provider-hint {
  font-size: 11.5px;
  color: var(--text-3);
  margin-top: 1px;
}
.dav-form {
  margin-top: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.dav-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.dav-error {
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--danger);
  background: var(--danger-soft);
  border-radius: var(--radius);
  padding: 8px 10px;
  overflow-wrap: anywhere;
}
.dav-notice {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: var(--radius);
  background: var(--warning-soft);
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.55;
}
.dav-notice svg {
  flex-shrink: 0;
  margin-top: 2px;
  color: var(--warning);
}
.dav-submit {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.dav-connect {
  min-width: 112px;
}
.dav-stage {
  font-size: 12px;
  color: var(--text-3);
  min-width: 0;
  overflow-wrap: anywhere;
}

/* ================= AI ================= */
.ai-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 16px;
  margin: 14px 0 12px;
  font-size: 13px;
}
.ai-result {
  margin: -4px 0 12px;
}

/* ================= 网络 ================= */
.cors-desc {
  margin: 0 0 6px;
}
#settings-network .field {
  padding: 8px 0 14px;
}

/* ================= 弹层 ================= */
.confirm-modal {
  width: min(440px, 100%);
}
.modal-text {
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-2);
  margin: 0 0 8px;
  overflow-wrap: anywhere;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}

/* ================= 论文 Agent / 代理 / 关于 (沿用) ================= */
.about-actions {
  display: flex;
  flex-shrink: 0;
  gap: 8px;
}
.agent-default-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 10px; font-size: 13px; }
.agent-default-row .input { width: 180px; }
.agent-engine-setting { margin-top: 10px; padding: 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); }
.agent-engine-title { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 7px; font-size: 12px; }
.agent-engine-title span { color: var(--text-3); font-size: 11px; text-align: right; }
.agent-engine-title .agent-ok { color: var(--success, #238b50); }
.agent-engine-title .agent-bad { color: var(--danger, #c94545); }
.agent-path-row { display: flex; gap: 7px; }
.agent-path-row .input { flex: 1; min-width: 0; }
.agent-engine-meta { margin-top: 5px; color: var(--text-3); font-size: 10.5px; overflow-wrap: anywhere; }
.agent-settings-note { margin: 10px 0 0; color: var(--text-3); font-size: 11px; line-height: 1.55; }
.proxy-input {
  width: 100%;
  margin-top: 8px;
}
.proxy-grid {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
.proxy-grid .input:first-child,
.proxy-grid select {
  width: 200px;
  flex-shrink: 0;
}
.proxy-grid .input {
  flex: 1;
  min-width: 0;
}
.proxy-grid .port {
  width: 110px;
  flex: none;
}
.proxy-current {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-3);
}
.proxy-result {
  margin-top: 6px;
  font-size: 13px;
}
.app-identity {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 14px;
  padding: 6px 0 14px;
}
.app-icon {
  width: 56px;
  height: 56px;
  border-radius: 14px;
  flex-shrink: 0;
}
.app-meta {
  flex: 1;
  min-width: 0;
}
.app-name {
  font-size: 16px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.version-chip {
  font-size: 12px;
  font-weight: 500;
  color: var(--brand);
  background: var(--brand-light);
  border-radius: 999px;
  padding: 1px 10px;
}
.env-chip {
  font-size: 12px;
  font-weight: 400;
  color: var(--text-3);
  background: var(--bg);
  border-radius: 999px;
  padding: 1px 10px;
}
.app-tagline {
  font-size: 12px;
  color: var(--text-3);
  margin-top: 4px;
}
.update-state {
  font-size: 13px;
  padding: 8px 0;
  display: flex;
  align-items: center;
  gap: 6px;
}
.update-state.error {
  color: var(--danger);
}
.update-state.ok {
  color: var(--success);
}
.update-card {
  border: 1px solid var(--brand-light);
  background: linear-gradient(135deg, var(--brand-light), transparent 70%);
  border-radius: var(--radius);
  padding: 14px 16px;
  margin-bottom: 12px;
}
.update-head {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 15px;
}
.update-badge {
  font-size: 12px;
  color: var(--on-brand);
  background: var(--brand);
  border-radius: 999px;
  padding: 1px 10px;
}
.update-date {
  font-size: 12px;
  color: var(--text-3);
}
.update-notes {
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.8;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
  max-height: 160px;
  overflow: auto;
  margin: 10px 0 0;
}
.update-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 12px;
}
.all-downloads {
  font-size: 12px;
  color: var(--text-3);
}
.all-downloads:hover {
  color: var(--brand);
}
.copy-link-btn {
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 6px;
  background: none;
  color: var(--text-3);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-left: -4px;
}
.copy-link-btn:hover {
  background: var(--bg);
  color: var(--brand);
}
.install-progress {
  font-size: 13px;
  color: var(--brand);
  margin-top: 10px;
}
.install-hint {
  font-size: 12px;
  color: var(--text-3);
  margin-left: 8px;
}
.install-done {
  font-size: 12px;
  color: var(--text-2);
  margin-top: 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.install-done code {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.install-tip {
  font-size: 12px;
  color: var(--text-3);
  margin-top: 10px;
  line-height: 1.7;
}
.star-callout {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  margin: 4px 0 16px;
  border: 1px solid var(--brand-light);
  border-radius: var(--radius);
  background: linear-gradient(135deg, var(--brand-light), var(--card) 72%);
}
.star-mark {
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border-radius: 10px;
  background: var(--card);
  color: var(--warning);
  box-shadow: var(--shadow);
}
.star-copy {
  flex: 1;
  min-width: 0;
}
.star-title {
  color: var(--text);
  font-size: 14px;
  font-weight: 600;
}
.star-desc {
  color: var(--text-3);
  font-size: 12px;
  line-height: 1.6;
  margin-top: 2px;
}
.star-action {
  flex-shrink: 0;
  white-space: nowrap;
}
.about {
  border-top: 1px solid var(--border);
  padding-top: 12px;
}
.about p {
  font-size: 13px;
  line-height: 1.9;
  color: var(--text-2);
  margin-bottom: 8px;
}
.about-links {
  display: flex;
  gap: 16px;
}
.about-links a {
  color: var(--brand);
}
.muted {
  color: var(--text-3);
  font-size: 12px;
}

@media (prefers-reduced-motion: reduce) {
  .spinning { animation: none; }
  .switch-track, .switch-track::after, .more-chevron { transition: none; }
}

/* ================= 平板 / 窄窗口 ================= */
@media (max-width: 860px) {
  .dav-providers {
    grid-template-columns: 1fr 1fr;
  }
}

/* ================= 手机 ================= */
@media (max-width: 600px) {
  .settings {
    --nav-h: 56px;
    padding: 14px 16px calc(28px + var(--lr-safe-bottom));
  }
  h1 {
    font-size: 26px;
    margin: 2px 0 4px;
  }
  .settings-nav {
    margin: 0 -16px 8px;
    padding: 10px 16px;
  }
  .nav-chip {
    height: 36px;
    padding: 0 14px;
    font-size: 13.5px;
  }
  .section {
    padding: 2px 16px 4px;
    margin-bottom: 12px;
  }
  h2 {
    padding-top: 14px;
  }

  /* 行: 文本在上, 分段控件 / 按钮组铺满在下; 单个小按钮 (.row-inline) 留在右侧 */
  .row {
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
    padding: 14px 0;
  }
  .row.row-inline {
    flex-direction: row;
    align-items: center;
    gap: 12px;
  }
  .row .segmented {
    display: flex;
    width: 100%;
  }
  .row .segmented button {
    flex: 1;
    justify-content: center;
    height: 36px;
    padding: 0 8px;
    font-size: 14px;
  }
  .row-actions {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    width: 100%;
  }
  .row-actions .btn,
  .row.row-inline > .btn {
    height: 40px;
  }
  .toggle-row {
    padding: 14px 0;
    min-height: 56px;
  }

  /* 表单: 单列, 输入框 16px 字号 (iOS 低于 16px 聚焦会放大页面), 44px 高 */
  .field-grid,
  .dav-grid {
    grid-template-columns: 1fr;
  }
  .settings .input {
    height: 44px;
    font-size: 16px;
  }
  .ai-actions .btn,
  .dav-connect {
    flex: 1;
    height: 44px;
  }
  .ai-actions .link-btn,
  .field-hint .link-btn {
    min-height: 36px;
  }
  .ai-actions {
    gap: 4px 16px;
  }
  .ai-actions .btn {
    flex-basis: 100%;
  }

  /* 同步状态: 「立即同步」换到下一行铺满 */
  .sync-bar {
    padding: 14px 14px 0;
  }
  .sync-bar-main {
    flex-wrap: wrap;
  }
  .sync-bar-main .sync-now {
    width: 100%;
    height: 44px;
  }
  .conn-card {
    flex-wrap: wrap;
  }
  .conn-actions {
    width: 100%;
    padding-left: 52px;
  }
  .conn-actions .btn {
    flex: 1;
    height: 36px;
  }
  .more-body .action-row {
    display: grid;
    grid-template-columns: 1fr;
  }
  .more-body .action-row .btn {
    height: 40px;
  }
  .dav-provider {
    min-height: 56px;
    padding: 10px;
    gap: 8px;
  }
  .dav-providers {
    grid-template-columns: 1fr 1fr;
  }
  .dav-submit .btn {
    height: 44px;
  }
  .modal-actions .btn {
    flex: 1;
    height: 44px;
  }

  /* 论文 Agent / 代理 (桌面专属, 窄窗口兜底) */
  .proxy-grid {
    flex-direction: column;
  }
  .proxy-grid .input,
  .proxy-grid .btn,
  .proxy-grid .input:first-child,
  .proxy-grid select,
  .proxy-grid .port,
  .agent-default-row .input {
    flex: none;
    width: 100%;
  }
  .agent-default-row {
    flex-direction: column;
    align-items: stretch;
    gap: 6px;
  }

  /* 关于: 按钮另起一行铺满, 不挤压应用名与简介 */
  .about-actions {
    width: 100%;
  }
  .about-actions .btn {
    flex: 1;
    height: 40px;
  }
  .star-callout {
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .star-action {
    width: 100%;
    height: 40px;
  }
  .about-links a {
    display: inline-flex;
    align-items: center;
    min-height: 36px;
  }
}
</style>
