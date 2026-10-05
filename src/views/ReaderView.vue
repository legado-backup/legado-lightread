<script setup lang="ts">
import { pingUsage } from '../services/usageStats'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getStorage, type AnnotationRec, type BookMeta } from '../storage'
import { useSettings } from '../stores/settings'
import { useLibrary } from '../stores/library'
import { isTextLike } from '../services/format'
import { convertToEpub, TEXT_EPUB_LAYOUT } from '../services/textToEpub'
import { getReaderCSS, resolveReaderColors, resolveReaderTheme, READER_THEME_CHOICES, FONT_FAMILIES, HIGHLIGHT_COLORS } from '../services/readerTheme'
import { resolvedTheme } from '../services/appearance'
import { setPageBarsDark, setSystemBarsHidden, setKeepScreenOn } from '../services/systemBars'
import { listSystemFonts, importFontFile, injectFontIntoDoc, resolveFontFamily } from '../services/fonts'
import { isTauri } from '../storage/types'
import { listVoicesSorted, warmUpSpeech, resetEdgeFailure } from '../services/tts'
import { ListenPlayer, type ListenFeed } from '../services/listenPlayer'
import { SentenceCursor, loadListenBookmark, saveListenBookmark, agoBucket, type CursorPos, type ListenBookmark } from '../services/readAloud'
import { EDGE_VOICES, edgeAvailable, playAudio } from '../services/edgeTts'
import { KOKORO_VOICES, DEFAULT_KOKORO_SID, kokoroVoiceLabel } from '../services/kokoroVoices'
import { localPack, localTtsSynthesize, refreshLocalPack } from '../services/localTts'
import LocalTtsPack from '../components/LocalTtsPack.vue'
import { useReadingTimer } from '../composables/useReadingTimer'
import { toast } from '../services/toast'
import { t } from '../i18n'
import { searchBook, type SearchHit } from '../services/bookSearch'
import { chatStream, aiConfigured, readerSystemPrompt, explainPrompt, providerById, type AiMessage } from '../services/ai'
import TocList, { type TocItem } from '../components/TocList.vue'
import ReadingModePanel from '../components/ReadingModePanel.vue'
import ReadingModeMini from '../components/ReadingModeMini.vue'
import { useReadingModes } from '../composables/useReadingModes'
import AmbientPanel from '../components/AmbientPanel.vue'
import ReadingModeLayer from '../components/ReadingModeLayer.vue'
import DianjingToggle from '../components/DianjingToggle.vue'
import DianjingConsent from '../components/DianjingConsent.vue'
import DianjingCard from '../components/DianjingCard.vue'
import DianjingChapterCard from '../components/DianjingChapterCard.vue'
import DianjingOutline from '../components/DianjingOutline.vue'
import DianjingSkim from '../components/DianjingSkim.vue'
import DianjingStatus from '../components/DianjingStatus.vue'
import { useDianjing } from '../composables/useDianjing'
import { djThemeName } from '../services/dianjing/theme'
import { useAmbient } from '../services/ambient'
import type { ReadingModeProgress } from '../services/readingModes/progress'
import { buildSmartToc, findCurrentSmartItem, flattenToc } from '../services/smartToc'
import {
  sectionSizes, sectionPageCounts, fallbackBytesPerPage, pagePosition, pageToFraction, fractionToPage, parseJumpInput,
  type PageMeasure, type PagePosition,
} from '../services/readerPages'
import { countSpeechChars, recordPace, paceCps, humanizeDuration, finishClock, type SpeechPace } from '../services/listenEta'

const route = useRoute()
const router = useRouter()
const settings = useSettings()
const library = useLibrary()
const bookId = String(route.params.id)

const container = ref<HTMLElement>()
const meta = ref<BookMeta>()
const loading = ref(true)
const error = ref('')
const toc = ref<TocItem[]>([])
/** 书本身无目录时由正文识别生成 (见 services/smartToc); 章节定位改按 CFI 判定 */
const tocAuto = ref(false)
let smartTocFlat: Array<{ label: string; href: string }> = []
const currentTocHref = ref<string>()
const fraction = ref(0)
const chapterLabel = ref('')
const panel = ref<'none' | 'toc' | 'annotations' | 'search' | 'ai'>('none')
const panelEl = ref<HTMLElement>()
const settingsOpen = ref(false)

// ---- 沉浸式阅读: 工具栏悬浮, 自动隐藏, 正文占满全窗 ----
const barsVisible = ref(true)
let barsTimer: ReturnType<typeof setTimeout> | undefined

const anyOverlayOpen = () =>
  panel.value !== 'none' || settingsOpen.value || ttsPanel.value || modes.panelOpen.value || ambientPanel.value || !!activeAnnotation.value || jumpOpen.value || dj.overlayOpen.value

/** 显示工具栏; autoHide 时若几秒内无交互且无面板打开则自动隐去 */
function showBars(autoHide = false) {
  barsVisible.value = true
  clearTimeout(barsTimer)
  if (autoHide) {
    barsTimer = setTimeout(() => {
      if (!anyOverlayOpen()) barsVisible.value = false
    }, 3000)
  }
}

function hideBars() {
  clearTimeout(barsTimer)
  if (!anyOverlayOpen()) barsVisible.value = false
}

const cancelBarsTimer = () => clearTimeout(barsTimer)

// ---- 面板开关: 同一时间只开一个浮层 (手机端它们都是底部抽屉, 叠在一起会互相遮挡) ----
type PanelName = 'toc' | 'annotations' | 'search' | 'ai'

function closeOverlays() {
  panel.value = 'none'
  settingsOpen.value = false
  ttsPanel.value = false
  modes.closePanel()
  dj.closeOverlays()
  ambientPanel.value = false
  activeAnnotation.value = null
  jumpOpen.value = false
}

function togglePanel(name: PanelName) {
  const next = panel.value === name ? 'none' : name
  closeOverlays()
  panel.value = next
}

function toggleSettings() {
  const next = !settingsOpen.value
  closeOverlays()
  settingsOpen.value = next
}

/** 手机端抽屉打开时显示遮罩 (桌面端遮罩由 CSS 隐藏) */
const sheetOpen = computed(() => panel.value !== 'none' || settingsOpen.value || ttsPanel.value || modes.panelOpen.value || ambientPanel.value)

// ---- 一键全屏沉浸 ----
const isFullscreen = ref(false)

async function toggleFullscreen() {
  try {
    if (isTauri()) {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      const win = getCurrentWindow()
      const next = !(await win.isFullscreen())
      await win.setFullscreen(next)
      isFullscreen.value = next
    } else if (document.fullscreenElement) {
      await document.exitFullscreen()
      isFullscreen.value = false
    } else {
      await document.documentElement.requestFullscreen()
      isFullscreen.value = true
    }
    // 进入全屏后稍候隐去工具栏, 直接进入纯文字状态
    if (isFullscreen.value) setTimeout(hideBars, 400)
  } catch { /* 平台拒绝全屏时忽略 */ }
}

/** Web 端用户可能按 Esc 或系统手势退出全屏, 同步状态 */
const syncFullscreenState = () => {
  if (!isTauri()) isFullscreen.value = !!document.fullscreenElement
}

// 打开目录时把当前章节滚到可视区中间
watch(panel, async p => {
  if (p !== 'toc') return
  await nextTick()
  panelEl.value?.querySelector('.toc-item.active')?.scrollIntoView({ block: 'center' })
})

// 高亮选区
const selection = ref<{ cfi: string; text: string } | null>(null)
const annotations = ref<AnnotationRec[]>([])
const activeAnnotation = ref<AnnotationRec | null>(null)
const noteDraft = ref('')
const annoTab = ref<'highlight' | 'bookmark'>('highlight')
const highlights = computed(() => annotations.value.filter(a => a.kind !== 'bookmark'))
const bookmarks = computed(() => annotations.value.filter(a => a.kind === 'bookmark'))

// 书签
const currentCfi = ref('')
const isBookmarked = computed(() => bookmarks.value.some(b => b.cfi === currentCfi.value))

// 听书
const ttsPanel = ref(false)
/** 背景音面板 (见 services/ambient); 背景音本身是全局单例, 只在阅读器里提供入口 */
const ambientPanel = ref(false)
const ambient = useAmbient()

function toggleAmbientPanel() {
  const next = !ambientPanel.value
  closeOverlays()
  ambientPanel.value = next
}

async function showAmbientSources() {
  const { openDownload } = await import('../services/updater')
  openDownload('https://github.com/yzfly/LightRead/blob/main/docs/ambient-sources.md')
}
const ttsState = ref<'stopped' | 'playing' | 'paused'>('stopped')
const ttsVoices = ref<{ name: string; lang: string }[]>([])
let sectionLoadResolvers: Array<() => void> = []

// 翻页 / 位置变化 / 朗读推进时 ping: 正文在 iframe 里, 其中的操作不会冒泡到 window
const { ping: pingReading, pingAuto: pingReadingAuto } = useReadingTimer(bookId)

// 书内搜索 (VSCode 风格: 多关键词 / 正则 / 大小写 / 全词)
const searchQuery = ref('')
const searchResults = ref<SearchHit[]>([])
const searchProgress = ref(0)
const searching = ref(false)
const searchTruncated = ref(false)
const searchOpts = reactive({ caseSensitive: false, wholeWord: false, regex: false })
let searchSession = 0

// ---- AI 阅读助手 ----
const aiMessages = ref<Array<{ role: 'user' | 'assistant'; content: string }>>([])
const aiInput = ref('')
const aiStreaming = ref(false)
const aiListEl = ref<HTMLElement>()
let aiSession = 0

const aiReady = () => aiConfigured()

function aiScrollToEnd() {
  nextTick(() => {
    if (aiListEl.value) aiListEl.value.scrollTop = aiListEl.value.scrollHeight
  })
}

async function sendAi(text?: string) {
  const content = (text ?? aiInput.value).trim()
  if (!content || aiStreaming.value) return
  if (!text) aiInput.value = ''
  const session = ++aiSession
  aiMessages.value.push({ role: 'user', content })
  aiMessages.value.push({ role: 'assistant', content: '' })
  const reply = aiMessages.value[aiMessages.value.length - 1]
  aiStreaming.value = true
  aiScrollToEnd()
  try {
    const history: AiMessage[] = [
      { role: 'system', content: readerSystemPrompt(
        { title: meta.value?.title, author: meta.value?.author },
        chapterLabel.value,
        settings.language,
      ) },
      // 只带最近 8 轮, 控制上下文长度
      ...aiMessages.value.slice(0, -1).slice(-16).map(m => ({ role: m.role, content: m.content })),
    ]
    for await (const delta of chatStream(history)) {
      if (session !== aiSession) return
      reply.content += delta
      aiScrollToEnd()
    }
    if (!reply.content) reply.content = t('ai.emptyReply')
  } catch (e: any) {
    if (session === aiSession) {
      reply.content = `⚠️ ${t('ai.requestFailed')}: ${e?.message ?? e}`
    }
  } finally {
    if (session === aiSession) aiStreaming.value = false
  }
}

/** 划词 → AI 解读 */
function aiExplainSelection() {
  if (!selection.value) return
  const text = selection.value.text.slice(0, 1500)
  selection.value = null
  panel.value = 'ai'
  showBars()
  sendAi(explainPrompt(text, settings.language))
}

/** 一键改用内置试用通道 (服务端中转, 免注册免密钥) */
function useTrialAi() {
  const trial = providerById('trial')
  settings.aiProvider = trial.id
  settings.aiBaseUrl = trial.baseUrl
  settings.aiModel = trial.defaultModel
}

const THEME_LABEL_KEYS: Record<string, string> = {
  light: 'reader.themeLight', sepia: 'reader.themeSepia', green: 'reader.themeGreen', dark: 'reader.themeDark', auto: 'reader.themeAuto',
}
const themeLabel = (name: string) => (THEME_LABEL_KEYS[name] ? t(THEME_LABEL_KEYS[name]) : name)

async function openRegister() {
  const { openDownload } = await import('../services/updater')
  openDownload('https://cloud.siliconflow.cn/i/TxUlXG3u')
}

function clearAi() {
  aiSession++
  aiStreaming.value = false
  aiMessages.value = []
}

function stopAi() {
  aiSession++
  aiStreaming.value = false
}

// 自动阅读
const autoReading = ref(false)
let autoTimer: ReturnType<typeof setInterval> | undefined

let view: any = null
let Overlayer: any = null
let saveTimer: ReturnType<typeof setTimeout> | undefined

const appDark = computed(() => resolvedTheme.value === 'dark')
// 阅读模式与点睛在下方声明, 二者初始化时会互相 / 回头读取这里的值;
// 先用响应式占位, 声明完再填入, 避免初始化顺序问题 (TDZ), 填入后依赖它们的 computed 自动重算
const lateModes = shallowRef<ReturnType<typeof useReadingModes>>()
const lateDj = shallowRef<ReturnType<typeof useDianjing>>()
// 墨水屏等阅读模式会改写正文配色 (纯黑白)
const themeColors = computed(() => resolveReaderColors(settings.reader.theme, appDark.value, lateModes.value?.readerStyle.value))
// 正文主题铺满全屏 (含状态栏下方), 安卓系统栏图标按正文深浅切换
watch(
  () => resolveReaderTheme(settings.reader.theme, appDark.value) === 'dark',
  dark => setPageBarsDark(dark),
  { immediate: true },
)

/** 当前选中的自定义字体 (settings.reader.fontFamily 为 custom:Name 时) */
function selectedCustomFont() {
  const m = settings.reader.fontFamily.match(/^custom:(.+)$/)
  return m ? settings.customFonts.find(f => f.name === m[1]) : undefined
}

function applyPrefs() {
  if (!view) return
  const prefs = settings.reader
  try {
    // 墨水屏: 去掉翻页动画 (残影)
    if (modes.einkActive.value) view.renderer.removeAttribute('animated')
    else view.renderer.setAttribute('animated', '')
    view.renderer.setAttribute('flow', prefs.flow)
    view.renderer.setAttribute('gap', `${prefs.gap}%`)
    // 大字 / 歌词运行时强制单栏, 不改用户自己的分栏设置
    view.renderer.setAttribute('max-column-count', String(modes.forceSingleColumn.value ? 1 : prefs.maxColumnCount))
    // 页眉页脚带 (章节名 / 进度) 的高度; 手机屏幕矮, 收窄些把空间留给正文
    view.renderer.setAttribute('margin', window.innerWidth <= 600 ? '36px' : '48px')
    view.renderer.setStyles?.(getReaderCSS({ ...prefs, fontFamily: resolveFontFamily(prefs.fontFamily) }, appDark.value, modes.readerStyle.value))
    const custom = selectedCustomFont()
    if (custom) {
      for (const content of view.renderer.getContents?.() ?? []) {
        injectFontIntoDoc(content.doc, custom)
      }
    }
  } catch { /* 章节切换瞬间 iframe 文档可能已卸载, 下次 relocate 会重新应用 */ }
}

/** 精准输入字号, 越界收敛到 8-64 */
function setFontSize(raw: string) {
  const n = Math.round(Number(raw))
  if (!Number.isFinite(n)) return
  settings.reader.fontSize = Math.min(64, Math.max(8, n))
}

// ---- 字体选择 ----
const systemFonts = ref<string[]>([])

watch(settingsOpen, async open => {
  if (open && isTauri() && !systemFonts.value.length) {
    try {
      systemFonts.value = await listSystemFonts()
    } catch { /* 枚举失败不影响预设字体 */ }
  }
})

async function importFont() {
  try {
    const font = await importFontFile()
    if (!font) return
    if (!settings.customFonts.some(f => f.file === font.file)) {
      settings.customFonts.push(font)
    }
    settings.reader.fontFamily = `custom:${font.name}`
    toast(t('reader.fontImported', { name: font.name }), 'success')
  } catch (e: any) {
    toast(t('reader.fontImportFailed', { msg: e?.message ?? e }), 'error', 5000)
  }
}

let prefsTimer: ReturnType<typeof setTimeout> | undefined
watch([() => settings.reader, appDark], () => {
  clearTimeout(prefsTimer)
  prefsTimer = setTimeout(applyPrefs, 120)
}, { deep: true })

function onRelocate(e: CustomEvent) {
  modes.onRelocate(e.detail)
  dj.onRelocate(e.detail)
  // 朗读跟随翻页 / 打字机、歌词自动推进都不能无限续命计时
  if (ttsState.value === 'playing' || modes.progressActive.value) pingReadingAuto()
  else pingReading()
  const { cfi, fraction: frac, tocItem } = e.detail
  fraction.value = frac ?? 0
  chapterLabel.value = tocItem?.label?.trim() ?? ''
  currentTocHref.value = tocItem?.href
  currentCfi.value = cfi ?? ''
  if (tocAuto.value) syncSmartTocPosition()
  updatePages(e.detail)
  updateMarginals()
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    if (cfi) library.saveProgress(bookId, cfi, frac ?? 0)
  }, 600)
}

/**
 * 翻页模式的页眉页脚: 淡色显示章节名与阅读进度, 工具栏收起时也知道读到哪。
 * foliate 每次重排都会重建这些节点, 所以随 relocate 一起刷新。
 */
function updateMarginals() {
  const r = view?.renderer
  if (!r?.heads?.length || !r?.feet?.length) return
  // 沉浸等模式可要求页眉 / 页脚留白
  const policy = modes.marginalsPolicy.value
  r.heads.forEach((el: HTMLElement, i: number) => {
    el.textContent = i === 0 && policy.head ? (chapterLabel.value || meta.value?.title || '') : ''
  })
  // 左下: 本章剩余; 右下: 页码 / 百分比。双栏时分居左右两栏, 单栏时同一行两端对齐
  const feet: HTMLElement[] = r.feet
  // 打字机 / 歌词运行时, 页脚留白给阅读模式的状态条用
  const guiding = modes.progressActive.value
  const left = policy.footLeft && !guiding ? chapterLeftText.value : ''
  const right = policy.footRight && !guiding ? progressText.value : ''
  feet.forEach(el => {
    el.replaceChildren()
    el.style.display = 'flex'
    el.style.gap = '1em'
  })
  const put = (el: HTMLElement, text: string, end: boolean) => {
    const span = document.createElement('span')
    span.textContent = text
    span.style.cssText = end ? 'margin-inline-start:auto;flex-shrink:0' : 'min-width:0;overflow:hidden;text-overflow:ellipsis'
    el.append(span)
  }
  if (left) put(feet[0], left, false)
  if (right) put(feet[feet.length - 1], right, true)
}

// ---- 页码 ----
// 重排书的页数随排版变化: 读到的章记实测页数, 其余按密度推算 (见 services/readerPages)。
// 同一排版下的实测按书存本地, 下次打开总页数直接稳定。
const pageInfo = ref<PagePosition | null>(null)
/** 固定版式 (漫画 / 版式 EPUB): 页数固定, 不需要「随排版变化」的提示 */
const fixedLayout = ref(false)
/** EPUB 自带纸书页码 (page-list) 时的当前页标签 */
const printPage = ref('')
/** 本章 (按目录) 剩余页; null 为未知 */
const chapterLeft = ref<number | null>(null)
let secSizes: number[] = []
let secCounts: number[] = []
let pagesPerScreen = 1
let pageMeasure: PageMeasure = { key: '', pages: {} }
let pageSaveTimer: ReturnType<typeof setTimeout> | undefined
const PAGE_MEASURE_KEY = `lightread-pages:${bookId}`
/** 目录项落点, 用于算「本章剩几页」(TXT 等一个分节会装多章, 不能按分节算) */
let tocAnchors: Array<{ index: number; label: string; anchor?: (doc: Document) => Element | Range | null }> = []
let tocFractions: Array<{ fraction: number; label: string }> = []
/** tocFractions 是普通数组, 用它通知依赖方重算 */
const tocFractionsReady = ref(0)
let tocFractionTimer: ReturnType<typeof setTimeout> | undefined

const showPage = computed(() => !!pageInfo.value && settings.reader.progressDisplay !== 'percent')
const showPercent = computed(() => !pageInfo.value || settings.reader.progressDisplay !== 'page')
const percentText = computed(() => `${(fraction.value * 100).toFixed(1)}%`)
const pageRangeText = computed(() => {
  const p = pageInfo.value
  if (!p) return ''
  return p.last > p.current ? `${p.current}–${p.last}` : String(p.current)
})
/** 页脚右侧 / 底栏的进度文案 */
const progressText = computed(() => {
  const parts: string[] = []
  if (showPage.value) parts.push(`${pageRangeText.value} / ${pageInfo.value!.total}`)
  if (showPercent.value) parts.push(percentText.value)
  return parts.join(' · ')
})
const chapterLeftText = computed(() => {
  if (!showPage.value || chapterLeft.value == null) return ''
  return chapterLeft.value > 0 ? t('reader.chapterPagesLeft', { n: chapterLeft.value }) : t('reader.chapterLastPage')
})
watch(() => settings.reader.progressDisplay, () => updateMarginals())

function loadPageMeasure() {
  try {
    const saved = JSON.parse(localStorage.getItem(PAGE_MEASURE_KEY) || 'null')
    if (saved && typeof saved.key === 'string' && saved.pages && typeof saved.pages === 'object') pageMeasure = saved
  } catch { /* 存储不可用: 本次现测 */ }
}

function savePageMeasure() {
  clearTimeout(pageSaveTimer)
  pageSaveTimer = setTimeout(() => {
    try { localStorage.setItem(PAGE_MEASURE_KEY, JSON.stringify(pageMeasure)) } catch { /* 忽略 */ }
  }, 1500)
}

/** 排版指纹: 影响分页的设置与版面尺寸; 取整到 8px, 避免亚像素抖动让测量反复作废 */
function layoutSignature(per: number, scrolled: boolean) {
  const p = settings.reader
  const rect = container.value?.getBoundingClientRect()
  const q = (n = 0) => Math.round(n / 8)
  return [p.fontSize, p.lineHeight, p.gap, p.fontFamily, p.justify ? 1 : 0, scrolled ? 's' : 'p', per, q(rect?.width), q(rect?.height)].join('|')
}

async function buildTocAnchors() {
  const v = view
  const items = tocAuto.value ? smartTocFlat : flattenToc(toc.value)
  const out: typeof tocAnchors = []
  for (const item of items) {
    if (!item.href) continue
    try {
      const resolved = await v.resolveNavigation(item.href)
      if (typeof resolved?.index === 'number') {
        out.push({
          index: resolved.index,
          label: item.label?.trim() ?? '',
          anchor: typeof resolved.anchor === 'function' ? resolved.anchor : undefined,
        })
      }
    } catch { /* 解析不了的目录项跳过 */ }
  }
  if (v !== view) return
  // 按分节排序 (稳定排序保留同一分节内的目录顺序)
  tocAnchors = out.sort((a, b) => a.index - b.index)
  tocFractions = []
  tocFractionsReady.value = 0
  clearTimeout(tocFractionTimer)
  tocFractionTimer = setTimeout(() => void buildTocFractions(v), 1200)
}

/**
 * 每个目录项在全书中的进度位置, 供拖动进度条时显示「将跳到哪一章」。
 * TXT 等一个分节装多章, 不能按分节取章名, 需要在分节文档里按字数定位标题。
 * 打开书后空闲时算一次; 算不出 (格式不支持单独解析分节) 时退回按分节取章名。
 */
async function buildTocFractions(v: any) {
  const sizeTotal = secSizes.reduce((a, b) => a + b, 0)
  if (!sizeTotal || !tocAnchors.length) return
  const docs = new Map<number, { doc: Document; length: number } | null>()
  const out: typeof tocFractions = []
  for (const a of tocAnchors) {
    if (v !== view) return
    if (!secSizes[a.index]) continue
    let ratio = 0
    if (a.anchor) {
      if (!docs.has(a.index)) {
        try {
          const doc: Document = await v.book.sections[a.index].createDocument()
          docs.set(a.index, { doc, length: doc.body?.textContent?.length ?? 0 })
        } catch { docs.set(a.index, null) }
      }
      const entry = docs.get(a.index)
      if (entry?.length) {
        try {
          const target = a.anchor(entry.doc)
          if (target) {
            const r = entry.doc.createRange()
            r.setStart(entry.doc.body, 0)
            if (isRange(target)) r.setEnd(target.startContainer, target.startOffset)
            else r.setEndBefore(target)
            ratio = Math.min(1, r.toString().length / entry.length)
          }
        } catch { /* 定位失败按分节开头算 */ }
      }
    }
    const before = secSizes.slice(0, a.index).reduce((x, y) => x + y, 0)
    out.push({ fraction: (before + ratio * secSizes[a.index]) / sizeTotal, label: a.label })
  }
  if (v === view) {
    tocFractions = out.sort((x, y) => x.fraction - y.fraction)
    tocFractionsReady.value++
  }
}

/** 全书进度所在章名 */
function chapterAtFraction(value: number, index: number): string {
  if (tocFractions.length) {
    let label = ''
    for (const item of tocFractions) {
      if (item.fraction <= value + 1e-6) label = item.label
      else break
    }
    return label
  }
  try { return view?.getProgressOf?.(index)?.tocItem?.label?.trim() ?? '' } catch { return '' }
}

function updatePages(detail: any) {
  const r = view?.renderer
  const index: number | undefined = detail?.section?.current
  printPage.value = detail?.pageItem?.label?.trim?.() ?? ''
  if (!r || typeof index !== 'number') return
  // 固定版式 (漫画 / 版式 EPUB): 一个分节就是一页
  fixedLayout.value = !!view.isFixedLayout
  if (view.isFixedLayout) {
    const total = view.book?.sections?.length || 1
    pageInfo.value = { current: index + 1, last: index + 1, total, sectionLeft: total - index - 1 }
    chapterLeft.value = null
    return
  }
  if (!secSizes.length) return
  const scrolled = !!r.scrolled
  const per = scrolled ? 1 : Math.max(1, Number(r.columnCount) || 1)
  const size = Number(r.size) || 0
  let screens = 0
  let screen = 1
  if (scrolled) {
    screens = size > 0 ? Math.max(1, Math.ceil(r.viewSize / size - 0.01)) : 0
    screen = size > 0 ? Math.min(screens, Math.max(1, Math.ceil((r.start + size) / size - 0.01))) : 1
  } else {
    screens = Math.max(0, Number(r.pages) - 2)
    screen = Math.min(screens, Math.max(1, Number(r.page) || 1))
  }
  if (!screens) return
  const key = layoutSignature(per, scrolled)
  if (pageMeasure.key !== key) pageMeasure = { key, pages: {} }
  if (secSizes[index] && pageMeasure.pages[index] !== screens * per) {
    pageMeasure.pages[index] = screens * per
    savePageMeasure()
  }
  const rect = container.value?.getBoundingClientRect()
  const fallback = fallbackBytesPerPage({
    width: (rect?.width ?? 360) / per * 0.85,
    height: (rect?.height ?? 640) - 96,
    fontSize: settings.reader.fontSize,
    lineHeight: settings.reader.lineHeight,
    cjk: !!view.language?.isCJK,
  })
  secCounts = sectionPageCounts(secSizes, pageMeasure.pages, fallback)
  pagesPerScreen = per
  const pos = pagePosition(secCounts, index, (screen - 1) * per + 1, per)
  pageInfo.value = pos
  calibrateCharsPerPage(index)
  chapterLeft.value = computeChapterLeft(index, pos, detail?.range, per, scrolled, size)
}

/**
 * 本章还剩几页: 当前分节里位于可见区之后的下一个目录项决定本章终点;
 * 本分节没有后续目录项时, 本章延续到下一个有目录项的分节之前。
 */
function computeChapterLeft(index: number, pos: PagePosition, range: Range | undefined, per: number, scrolled: boolean, size: number): number | null {
  if (!tocAnchors.length || !secCounts[index]) return null
  const before = secCounts.slice(0, index).reduce((a, b) => a + b, 0)
  const localLast = pos.last - before
  const r = view.renderer
  const doc: Document | undefined = r.getContents?.()?.find((c: any) => c.index === index)?.doc
  // 横排从左到右才能由坐标直接换算页; 竖排 / 从右到左只按分节估算
  const plain = scrolled || (r.getAttribute?.('dir') !== 'rtl' && !doc?.defaultView?.getComputedStyle(doc.body).writingMode?.startsWith('vertical'))
  if (doc && range && plain && size > 0) {
    const start = range.cloneRange()
    start.collapse(true)
    const colSize = scrolled ? size : size / per
    const lineBox = settings.reader.fontSize * settings.reader.lineHeight * 1.5
    for (const a of tocAnchors) {
      if (a.index !== index || !a.anchor) continue
      let target: Element | Range | null = null
      try { target = a.anchor(doc) } catch { continue }
      if (!target) continue
      const node = isRange(target) ? target.startContainer : target
      const offset = isRange(target) ? target.startOffset : 0
      try { if (start.comparePoint(node, offset) <= 0) continue } catch { continue }
      const box = target.getBoundingClientRect()
      const at = scrolled ? box.top : box.left
      let page = Math.floor(at / colSize) + 1
      // 章标题正好在页首: 本章到上一页结束
      const topInPage = scrolled ? box.top - (page - 1) * colSize : box.top
      if (topInPage < lineBox && page > 1) page--
      return Math.max(0, page - localLast)
    }
  }
  let left = pos.sectionLeft
  const next = tocAnchors.find(a => a.index > index)
  const end = next ? next.index : secCounts.length
  for (let i = index + 1; i < end; i++) left += secCounts[i]
  return left
}

/** 智能目录不经 foliate 的 TOC 进度, 按当前 CFI 自行判定所在章节 */
function syncSmartTocPosition() {
  const item = findCurrentSmartItem(smartTocFlat, currentCfi.value)
  chapterLabel.value = item?.label ?? ''
  currentTocHref.value = item?.href
}

/** 书没有目录 (或只有一项) 时, 扫描正文识别章节; 失败静默, 不影响阅读 */
async function applySmartToc() {
  const v = view
  try {
    const { items, flat } = await buildSmartToc(v)
    if (v !== view || !items.length) return
    smartTocFlat = flat
    toc.value = items
    tocAuto.value = true
    syncSmartTocPosition()
    void buildTocAnchors()
  } catch (e) {
    console.warn('smart toc failed', e)
  }
}

/**
 * 手动翻页 / 跳转与听书的协调: 朗读不中断 (连续播放的体验最重要), 只是不再把视图拉回朗读位置;
 * 胶囊和面板上给出「回到朗读位置」「从这页开始听」两个去处。
 */
function interruptTTSForReposition() {
  if (ttsState.value === 'stopped') return
  listenDetached.value = true
}

function turnPage(dir: 'left' | 'right') {
  interruptTTSForReposition()
  hideBars()
  dir === 'left' ? view?.goLeft() : view?.goRight()
}

function handleKeydown(e: KeyboardEvent) {
  // 在输入框里打字 (跳页 / 搜索 / AI) 时, 方向键和空格属于输入框
  const el = e.target as HTMLElement | null
  if (e.key !== 'Escape' && el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return
  // 阅读模式快捷键 (M 面板 / Shift+T 打字机; 打字机运行中空格暂停等)
  if (modes.handleKey(e)) return
  if (dj.handleKey(e)) return
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') turnPage('left')
  else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') turnPage('right')
  else if (e.key === 'Escape') {
    if (isFullscreen.value && isTauri()) toggleFullscreen()
    panel.value = 'none'
    settingsOpen.value = false
    jumpOpen.value = false
    stopAutoRead()
  }
}

function startAutoRead() {
  modes.stopForExternal('auto')
  // 带读同一时间只运行一个: 自动翻页开始时暂停听书 (听书会自己跟着翻页, 两者抢位置)
  if (ttsState.value === 'playing') pauseTTS()
  stopAutoRead()
  autoReading.value = true
  autoTimer = setInterval(() => {
    if (fraction.value >= 0.999) {
      stopAutoRead()
      return
    }
    turnPage('right')
  }, settings.autoReadSeconds * 1000)
}

function stopAutoRead() {
  autoReading.value = false
  clearInterval(autoTimer)
}

watch(() => settings.autoReadSeconds, () => {
  if (autoReading.value) startAutoRead()
})

// ---- 听书 ----

// ---- 听书胶囊: 默认停在页眉留白处 (不挡正文), 可拖到任意位置并记住 ----
const MINI_POS_KEY = 'lightread-tts-mini-pos'
/** 胶囊中心点占阅读区宽高的比例; null 为默认停靠位置 */
const miniPos = ref<{ x: number; y: number } | null>(null)
try {
  const saved = JSON.parse(localStorage.getItem(MINI_POS_KEY) || 'null')
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) miniPos.value = saved
} catch { /* 用默认位置 */ }
const miniEl = ref<HTMLElement>()
let miniDrag: { id: number; sx: number; sy: number; moved: boolean; dx: number; dy: number } | null = null
const miniStyle = computed(() => miniPos.value
  ? { left: `${miniPos.value.x * 100}%`, top: `${miniPos.value.y * 100}%` }
  : undefined)

/** 浮动胶囊: 沉浸阅读时停在页眉留白; 用户拖过则一直停在那里 */
const ttsMiniFloating = computed(() => !ttsPanel.value && ttsState.value !== 'stopped' && (!barsVisible.value || !!miniPos.value))
/** 工具栏显示且胶囊未被拖走时, 改为嵌在顶栏中间 */
const ttsChipInBar = computed(() => ttsState.value !== 'stopped' && barsVisible.value && !miniPos.value)

function onMiniDown(e: PointerEvent) {
  if (e.button !== 0 || !miniEl.value) return
  const r = miniEl.value.getBoundingClientRect()
  miniDrag = {
    id: e.pointerId, sx: e.clientX, sy: e.clientY, moved: false,
    dx: e.clientX - (r.left + r.width / 2), dy: e.clientY - (r.top + r.height / 2),
  }
  miniEl.value.setPointerCapture?.(e.pointerId)
}

function onMiniMove(e: PointerEvent) {
  const d = miniDrag
  const el = miniEl.value
  const host = el?.offsetParent as HTMLElement | null
  if (!d || !el || !host || e.pointerId !== d.id) return
  if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 6) return
  d.moved = true
  const h = host.getBoundingClientRect()
  const halfW = el.offsetWidth / 2 + 6
  const halfH = el.offsetHeight / 2 + 6
  const cx = Math.min(h.width - halfW, Math.max(halfW, e.clientX - d.dx - h.left))
  const cy = Math.min(h.height - halfH, Math.max(halfH, e.clientY - d.dy - h.top))
  miniPos.value = { x: cx / h.width, y: cy / h.height }
}

function onMiniUp(e: PointerEvent) {
  const d = miniDrag
  if (!d || e.pointerId !== d.id) return
  miniDrag = null
  if (!d.moved) {
    ttsPanel.value = true
    return
  }
  try { localStorage.setItem(MINI_POS_KEY, JSON.stringify(miniPos.value)) } catch { /* 忽略 */ }
}

/** 双击胶囊回到默认停靠位置 */
function resetMiniPos() {
  miniPos.value = null
  try { localStorage.removeItem(MINI_POS_KEY) } catch { /* 忽略 */ }
}

// ---- 听书进度与剩余时间 (见 services/listenEta) ----
/** 每页字数 (只数文字), 由当前分节正文字数 / 页数得出; 0 为未知 */
const charsPerPage = ref(0)
const sectionChars = new Map<number, number>()
const bookCjk = ref(true)
/** 按引擎分别记语速: 在线 / 离线 / 系统语音快慢差别很大 */
const paceKey = () => `lightread-tts-pace:${settings.ttsEngine}`
const pace = ref<SpeechPace>({ cps: 0, samples: 0 })
let pausedAt = 0
let pausedTotal = 0
/** 每分钟刷新一次「几点听完」 */
const nowTick = ref(Date.now())
let nowTimer: ReturnType<typeof setInterval> | undefined

function loadPace() {
  try {
    const saved = JSON.parse(localStorage.getItem(paceKey()) || 'null')
    pace.value = saved && saved.cps > 0 ? { cps: saved.cps, samples: Math.min(saved.samples, 5) } : { cps: 0, samples: 0 }
  } catch { pace.value = { cps: 0, samples: 0 } }
}
loadPace()
watch(() => settings.ttsEngine, loadPace)

function notePace(text: string, seconds: number) {
  const next = recordPace(pace.value, countSpeechChars(text), seconds, settings.ttsRate)
  if (next === pace.value) return
  pace.value = next
  try { localStorage.setItem(paceKey(), JSON.stringify(next)) } catch { /* 忽略 */ }
}

function calibrateCharsPerPage(index: number) {
  if (!sectionChars.has(index)) {
    const doc: Document | undefined = view?.renderer?.getContents?.()?.find((c: any) => c.index === index)?.doc
    if (!doc?.body) return
    sectionChars.set(index, countSpeechChars(doc.body.textContent))
  }
  const chars = sectionChars.get(index) ?? 0
  // 只有插图的分节 (封面等) 字数太少, 用它算每页字数会严重偏低
  if (chars >= 200 && secCounts[index]) charsPerPage.value = chars / secCounts[index]
}

/** 本章 / 全书还要听多少秒 */
const listenEta = computed(() => {
  const p = pageInfo.value
  if (!p || fixedLayout.value || !charsPerPage.value) return null
  const cps = paceCps(pace.value, settings.ttsRate, bookCjk.value)
  // 当前这一屏按读了一半算
  const chapterPages = (chapterLeft.value ?? p.sectionLeft) + (p.last - p.current + 1) / 2
  const bookPages = p.total - p.last + (p.last - p.current + 1) / 2
  return {
    chapter: chapterPages * charsPerPage.value / cps,
    book: bookPages * charsPerPage.value / cps,
  }
})

function humanTime(seconds: number) {
  const d = humanizeDuration(seconds)
  if (d.kind === 'lessThanMinute') return t('tts.lessThanMinute')
  if (d.kind === 'minutes') return t('tts.aboutMinutes', { n: d.m })
  if (d.kind === 'hours') return t('tts.aboutHours', { n: d.h })
  return t('tts.aboutHoursMinutes', { h: d.h, m: d.m })
}

function clockText(seconds: number, kind: 'listen' | 'read' = 'listen') {
  const c = finishClock(seconds, new Date(nowTick.value))
  if (!c) return ''
  const clock = `${c.hh}:${c.mm}`
  if (kind === 'read') return c.dayOffset > 0 ? t('readingMode.finishTomorrow', { clock }) : t('readingMode.finishAt', { clock })
  return c.dayOffset > 0 ? t('tts.finishTomorrow', { clock }) : t('tts.finishAt', { clock })
}

const chapterEtaText = computed(() => listenEta.value ? t('tts.chapterLeft', { time: humanTime(listenEta.value.chapter) }) : '')
const chapterFinishText = computed(() => listenEta.value ? clockText(listenEta.value.chapter) : '')
const bookFinishText = computed(() => listenEta.value ? clockText(listenEta.value.book) : '')

/** 本章进度 (0–1): 按目录项在全书的位置; 目录位置还没算出时为 null */
const chapterProgress = computed(() => {
  const f = fraction.value
  if (!tocFractionsReady.value || !tocFractions.length) return null
  let start = 0
  let end = 1
  for (const item of tocFractions) {
    if (item.fraction <= f + 1e-6) start = item.fraction
    else { end = item.fraction; break }
  }
  return end > start ? Math.min(1, Math.max(0, (f - start) / (end - start))) : null
})

watch(() => ttsState.value !== 'stopped' || ttsPanel.value, on => {
  clearInterval(nowTimer)
  if (on) {
    nowTick.value = Date.now()
    nowTimer = setInterval(() => { nowTick.value = Date.now() }, 30000)
  }
})

// ---- 本地离线语音包 ----
/** 语音包已装好且可用 (未因闪退暂停); 下载 / 恢复由 LocalTtsPack 处理 */
const localInstalled = computed(() => localPack.installed && !localPack.crashed)
const refreshLocalStatus = () => refreshLocalPack()

async function auditionLocal() {
  try {
    await playAudio(await localTtsSynthesize(t('tts.sampleText'), settings.localVoiceId, settings.ttsRate))
  } catch (e: any) {
    toast(e?.message ?? t('tts.auditionFailed'), 'error')
  }
}

async function openTTSPanel() {
  const next = !ttsPanel.value
  closeOverlays()
  ttsPanel.value = next
  if (ttsPanel.value) {
    refreshLocalStatus()
    // 离线模型首次加载需 10–20s, 打开面板时就在后台加载
    warmUpSpeech()
    void refreshBookmarkOnPage()
  }
  if (ttsPanel.value && !ttsVoices.value.length) {
    ttsVoices.value = (await listVoicesSorted()).map(v => ({ name: v.name, lang: v.lang }))
  }
}

// ---- 听书主流程: 句子游标定位 + 连续播放器出声 (见 services/readAloud, services/listenPlayer) ----
// 句子键 "分节:段:句"; 播放器在某句开始出声时回调, 这里负责高亮、跟随翻页、记断点。
const ttsBuffering = ref(false)
/** 用户在朗读中翻页 / 跳转: 继续朗读但不再拉回视图, 提供「回到朗读位置 / 从这页听」 */
const listenDetached = ref(false)
const currentListenKey = ref('')
let displayCursor: SentenceCursor | null = null
const offscreenDocs = new Map<number, Document>()
const listenTexts = new Map<string, string>()
/** 本次会话离线合成跟不上的次数; 达到 2 次在面板上给出「改用在线模型」 */
let localStutters = 0
const localTooSlow = ref(false)

function switchToOnline() {
  localTooSlow.value = false
  localStutters = 0
  resetEdgeFailure()
  settings.ttsEngine = 'edge'
}
let listenChain: Promise<void> = Promise.resolve()
let lastSentenceStart: { key: string; at: number; pausedBefore: number } | null = null

const listenPlayer = new ListenPlayer({
  onSentenceStart: key => { listenChain = listenChain.then(() => onListenSentence(key)).catch(() => {}) },
  onEnd: reason => {
    ttsBuffering.value = false
    if (reason === 'error') toast(t('tts.error'), 'error')
    if (reason === 'finished') toast(t('tts.bookFinished'), 'success')
    if (reason !== 'stopped') finishListenSession()
  },
  onBuffering: waiting => {
    ttsBuffering.value = waiting
    // 已经出声后又缓冲 = 合成跟不上播放; 离线模型连续两次即提示改用在线模型
    if (waiting && currentListenKey.value && settings.ttsEngine === 'local') {
      localStutters++
      if (localStutters === 2) {
        localTooSlow.value = true
        toast(t('tts.localSlow'), 'info', 5000)
      }
    }
  },
})

function displayedContent(): { doc: Document; index: number } | null {
  const c = view?.renderer?.getContents?.()?.[0]
  return c?.doc ? { doc: c.doc, index: c.index } : null
}

function cursorForDisplayed(): { cursor: SentenceCursor; index: number } | null {
  const shown = displayedContent()
  if (!shown) return null
  if (displayCursor?.doc !== shown.doc) displayCursor = new SentenceCursor(shown.doc)
  return { cursor: displayCursor, index: shown.index }
}

/** 预读后续分节用离屏文档, 与显示文档同源同结构, 句子编号一致 */
async function docForSection(index: number): Promise<Document | null> {
  const shown = displayedContent()
  if (shown?.index === index) return shown.doc
  const cached = offscreenDocs.get(index)
  if (cached) return cached
  try {
    const doc: Document = await view.book.sections[index].createDocument()
    if (offscreenDocs.size >= 3) offscreenDocs.delete(offscreenDocs.keys().next().value!)
    offscreenDocs.set(index, doc)
    return doc
  } catch { return null }
}

function rememberText(key: string, text: string) {
  listenTexts.set(key, text)
  if (listenTexts.size > 400) listenTexts.delete(listenTexts.keys().next().value!)
}

/** 从 (分节, 位置) 起依次产出句子; 本节读完自动续下一节, 书末返回 null */
function makeFeed(startIndex: number, startPos: CursorPos | null): ListenFeed {
  let index = startIndex
  let cur: SentenceCursor | null = null
  let fresh = false
  const total = view.book?.sections?.length ?? 0
  return {
    async next() {
      for (let guard = 0; guard < 100000; guard++) {
        if (!cur) {
          if (index >= total) return null
          if (!secSizes[index]) { index++; continue }
          const doc = await docForSection(index)
          if (!doc) { index++; continue }
          cur = new SentenceCursor(doc)
          if (startPos && index === startIndex) {
            cur.pos = startPos
            fresh = !!cur.current() || cur.first()
          } else fresh = cur.first()
          startPos = null
          if (!fresh) { cur = null; index++; continue }
        } else if (!fresh && !cur.next()) {
          cur = null
          index++
          continue
        }
        fresh = false
        const { block, sentence } = cur.pos
        const text = cur.text()
        const paragraphEnd = sentence === cur.sentencesOf(block).length - 1
        const sectionEnd = paragraphEnd && cur.peek(1).length === 0
        const key = `${index}:${block}:${sentence}`
        rememberText(key, text)
        return { key, text, paragraphEnd, sectionEnd }
      }
      return null
    },
  }
}

const parseKey = (key: string) => {
  const [index, block, sentence] = key.split(':').map(Number)
  return { index, pos: { block, sentence } as CursorPos }
}

/** iframe 里的 Range 来自另一个全局, instanceof Range 不成立, 按特征判断 */
const isRange = (x: unknown): x is Range => !!x && typeof (x as Range).startContainer === 'object' && typeof (x as Range).collapse === 'function'

/** 当前朗读句的 Range (仅当它在显示中的分节里) */
function listenRange(key = currentListenKey.value): Range | null {
  if (!key) return null
  const { index, pos } = parseKey(key)
  const shown = cursorForDisplayed()
  if (!shown || shown.index !== index) return null
  shown.cursor.pos = pos
  return shown.cursor.current()
}

/**
 * 朗读句高亮画在 foliate 的标注叠层上, 不借用文档选区: 否则每读一句都会冲掉用户正在划的词,
 * 听书时没法划线、写想法、「从这里听」。
 */
const TTS_MARK = 'lr-tts-sentence'
const TTS_MARK_COLOR = '#4f7cff'
function highlightListen(range: Range, scroll = true) {
  clearListenHighlight()
  const doc = range.startContainer.ownerDocument
  const target = view.renderer.getContents?.()?.find((c: any) => c.doc === doc)
  try { target?.overlayer?.add(TTS_MARK, range, Overlayer.highlight, { color: TTS_MARK_COLOR, padding: 1 }) } catch { /* 叠层未就绪 */ }
  if (scroll) view.renderer.scrollToAnchor?.(range)
}

function clearListenHighlight() {
  for (const c of view?.renderer?.getContents?.() ?? []) {
    try { c.overlayer?.remove(TTS_MARK) } catch { /* 忽略 */ }
  }
}

async function onListenSentence(key: string) {
  measurePace(key)
  pingReadingAuto()
  currentListenKey.value = key
  const { index } = parseKey(key)
  if (!listenDetached.value) {
    // 朗读进入下一分节: 翻过去
    if (displayedContent()?.index !== index) {
      try { await view.renderer.goTo({ index }) } catch { /* 留在原处, 继续读 */ }
    }
    const range = listenRange(key)
    if (range) {
      // 歌词跟读: 由歌词把当前行固定在 40% 处, 朗读这里只画高亮不滚动 (否则两者抢位置)
      if (modes.lyricFollowing.value) {
        modes.followRange(range)
        highlightListen(range, false)
      } else highlightListen(range)
    }
  }
  saveBookmarkFor(key)
  updateMediaSession()
}

/** 两句起点的时间差 ÷ 上一句字数 = 实际语速 (扣除暂停) */
function measurePace(key: string) {
  const now = performance.now()
  const prev = lastSentenceStart
  lastSentenceStart = { key, at: now, pausedBefore: pausedTotal }
  if (!prev || ttsBuffering.value) return
  const text = listenTexts.get(prev.key)
  if (text) notePace(text, (now - prev.at - (pausedTotal - prev.pausedBefore)) / 1000)
}

// ---- 断点续读: 每句开始时记下位置 (CFI), 下次从这句接着听 ----
const listenBookmark = ref<ListenBookmark | null>(loadListenBookmark(bookId))
let bookmarkTimer: ReturnType<typeof setTimeout> | undefined

function saveBookmarkFor(key: string) {
  clearTimeout(bookmarkTimer)
  bookmarkTimer = setTimeout(async () => {
    const { index, pos } = parseKey(key)
    const doc = await docForSection(index)
    if (!doc) return
    const c = new SentenceCursor(doc)
    c.pos = pos
    const range = c.current()
    if (!range) return
    let cfi = ''
    try { cfi = view.getCFI(index, range) } catch { return }
    // 翻到别处时页面上的章名不是朗读处的, 沿用上一次的
    const chapter = listenDetached.value ? (listenBookmark.value?.chapter ?? chapterLabel.value) : chapterLabel.value
    const mark: ListenBookmark = { cfi, chapter, snippet: c.text(range).slice(0, 28), at: Date.now() }
    listenBookmark.value = mark
    saveListenBookmark(bookId, mark)
  }, 400)
}

/** 断点所在句的位置; 断点在显示中的分节时同时给出 Range */
async function resolveBookmark(mark: ListenBookmark): Promise<{ index: number; pos: CursorPos; range: Range | null } | null> {
  try {
    const { index, anchor } = await view.resolveNavigation(mark.cfi)
    const doc = await docForSection(index)
    if (!doc || typeof anchor !== 'function') return null
    const target: Range | Element | null = anchor(doc)
    if (!target) return null
    const c = new SentenceCursor(doc)
    const node = isRange(target) ? target.startContainer : target
    const offset = isRange(target) ? target.startOffset : 0
    if (!c.seek(node, offset)) return null
    return { index, pos: c.pos, range: displayedContent()?.index === index ? c.current() : null }
  } catch { return null }
}

/** 断点就在当前页上: 「开始」直接从断点那句接着读 */
const bookmarkOnPage = ref(false)
async function refreshBookmarkOnPage() {
  const mark = listenBookmark.value
  const visible: Range | undefined = view?.lastLocation?.range
  if (!mark || !visible) { bookmarkOnPage.value = false; return }
  const hit = await resolveBookmark(mark)
  bookmarkOnPage.value = !!hit?.range && visible.comparePoint(hit.range.startContainer, hit.range.startOffset) === 0
}

const bookmarkAgo = computed(() => {
  const mark = listenBookmark.value
  if (!mark) return ''
  const b = agoBucket(mark.at, nowTick.value)
  if (b.kind === 'justNow') return t('tts.agoJustNow')
  if (b.kind === 'minutes') return t('tts.agoMinutes', { n: b.n })
  if (b.kind === 'hours') return t('tts.agoHours', { n: b.n })
  if (b.kind === 'yesterday') return t('tts.agoYesterday')
  return t('tts.agoDays', { n: b.n })
})

type ListenFrom = 'auto' | 'page' | 'bookmark' | { range: Range }

/** 开始朗读: auto = 断点在本页则接着断点, 否则从本页第一句 */
async function startTTS(from: ListenFrom = 'auto') {
  if (!view) return
  modes.stopForExternal('tts')
  stopAutoRead()
  if (view.isFixedLayout) {
    toast(t('tts.fixedLayoutUnsupported'), 'error')
    return
  }
  resetEdgeFailure()
  let index: number
  let pos: CursorPos | null = null
  if (from === 'bookmark' || (from === 'auto' && bookmarkOnPage.value && listenBookmark.value)) {
    const hit = listenBookmark.value ? await resolveBookmark(listenBookmark.value) : null
    if (hit) {
      index = hit.index
      pos = hit.pos
      if (displayedContent()?.index !== index) await view.goTo(listenBookmark.value!.cfi).catch(() => {})
    } else return startTTS('page')
  } else {
    const shown = cursorForDisplayed()
    if (!shown) return
    index = shown.index
    const c = shown.cursor
    if (typeof from === 'object') {
      if (!c.seek(from.range.startContainer, from.range.startOffset)) return
    } else {
      const visible: Range | undefined = view.lastLocation?.range
      if (!visible || !c.seek(visible.startContainer, visible.startOffset)) c.first()
      // 本页第一句若始于上一页, 从本页完整的第一句开始, 免得视图被拉回上一页
      const cur = c.current()
      if (cur && visible && cur.compareBoundaryPoints(Range.START_TO_START, visible) < 0 && c.pos.sentence > 0) c.next()
    }
    pos = c.pos
  }
  listenDetached.value = false
  lastSentenceStart = null
  localStutters = 0
  localTooSlow.value = false
  ttsState.value = 'playing'
  listenPlayer.play(makeFeed(index!, pos))
  setupMediaSession()
}

function pauseTTS() {
  if (ttsState.value !== 'playing') return
  ttsState.value = 'paused'
  pausedAt = performance.now()
  listenPlayer.pause()
  modes.setFollowPaused(true)
  updateMediaSession()
}

function resumeTTS() {
  if (ttsState.value !== 'paused') return
  ttsState.value = 'playing'
  if (pausedAt) pausedTotal += performance.now() - pausedAt
  pausedAt = 0
  listenPlayer.resume()
  modes.setFollowPaused(false)
  updateMediaSession()
}

function stopTTS() {
  if (pausedAt) pausedTotal += performance.now() - pausedAt
  pausedAt = 0
  listenPlayer.stop()
  finishListenSession()
}

function finishListenSession() {
  ttsState.value = 'stopped'
  ttsBuffering.value = false
  listenDetached.value = false
  currentListenKey.value = ''
  clearListenHighlight()
  setSleep(0)
  clearMediaSession()
  void refreshBookmarkOnPage()
}

// ---- 跳句 / 跳段: 立即移到目标句并高亮, 连按时合并为一次重新合成 ----
let skipTimer: ReturnType<typeof setTimeout> | undefined
let skipTarget: { index: number; pos: CursorPos } | null = null

async function skipListen(kind: 'sentence' | 'paragraph', dir: 1 | -1) {
  const key = skipTarget ? `${skipTarget.index}:${skipTarget.pos.block}:${skipTarget.pos.sentence}` : currentListenKey.value
  if (ttsState.value === 'stopped' || !key) return
  let { index, pos } = parseKey(key)
  let doc = await docForSection(index)
  if (!doc) return
  let c = new SentenceCursor(doc)
  c.pos = pos
  let moved = kind === 'sentence' ? (dir > 0 ? c.next() : c.prev()) : (dir > 0 ? c.nextBlock() : c.prevBlock())
  // 跨分节
  for (let i = index + dir; !moved && i >= 0 && i < (view.book?.sections?.length ?? 0); i += dir) {
    if (!secSizes[i]) continue
    doc = await docForSection(i)
    if (!doc) continue
    c = new SentenceCursor(doc)
    moved = dir > 0 ? c.first() : (kind === 'paragraph' ? c.last() && c.prevBlock() || c.last() : c.last())
    if (moved) index = i
  }
  if (!moved) return
  skipTarget = { index, pos: c.pos }
  listenDetached.value = false
  const nextKey = `${index}:${c.pos.block}:${c.pos.sentence}`
  currentListenKey.value = nextKey
  if (displayedContent()?.index !== index) await view.renderer.goTo({ index }).catch(() => {})
  const range = listenRange(nextKey)
  if (range) highlightListen(range)
  clearTimeout(skipTimer)
  skipTimer = setTimeout(() => {
    const target = skipTarget
    skipTarget = null
    if (!target || ttsState.value === 'stopped') return
    ttsState.value = 'playing'
    lastSentenceStart = null
    listenPlayer.play(makeFeed(target.index, target.pos))
  }, 350)
}

/** 回到正在朗读的那一句 (翻页走开后) */
async function returnToListening() {
  listenDetached.value = false
  const key = currentListenKey.value
  if (!key) return
  const { index } = parseKey(key)
  if (displayedContent()?.index !== index) await view.renderer.goTo({ index }).catch(() => {})
  const range = listenRange(key)
  if (range) highlightListen(range)
}

/** 从朗读中翻到 / 跳到的这一页重新开始读 */
function listenFromHere() {
  void startTTS('page')
}

/** 划词时记下的选区 (点浮条按钮时 iframe 选区可能已变) */
let selectionRange: Range | null = null

/** 选中文字 → 从这里开始听 */
function listenFromSelection() {
  const range = selectionRange
  selection.value = null
  selectionRange = null
  range?.startContainer.ownerDocument?.getSelection()?.removeAllRanges()
  if (range) void startTTS({ range })
}

// 听书出声时压低背景音
watch(ttsState, s => ambient.duck(s === 'playing'), { immediate: true })

// 换音色 / 倍速 / 引擎: 已合成的预读作废, 从下一句起按新设置
watch(() => [settings.ttsEngine, settings.ttsRate, settings.edgeVoice, settings.localVoiceId, settings.ttsVoice], () => {
  if (ttsState.value !== 'stopped') listenPlayer.invalidate()
})

// ---- 定时关闭: 15 / 30 / 60 / 90 分钟, 或听完本章 ----
type SleepMode = 0 | 15 | 30 | 60 | 90 | 'chapter'
const sleepMode = ref<SleepMode>(0)
const sleepAt = ref(0)
let sleepTimer: ReturnType<typeof setTimeout> | undefined
let sleepChapter: string | undefined

function setSleep(mode: SleepMode) {
  clearTimeout(sleepTimer)
  sleepMode.value = mode
  sleepAt.value = 0
  sleepChapter = undefined
  if (typeof mode === 'number' && mode > 0) {
    sleepAt.value = Date.now() + mode * 60000
    sleepTimer = setTimeout(() => sleepNow(), mode * 60000)
  } else if (mode === 'chapter') {
    sleepChapter = currentTocHref.value ?? chapterLabel.value
  }
}

function sleepNow() {
  setSleep(0)
  // 听书定时到点, 背景音跟着慢慢淡出
  if (ambient.state.playing) ambient.fadeOutAndStop(30)
  if (ttsState.value === 'playing') {
    pauseTTS()
    toast(t('tts.sleepDone'))
  }
}

watch([currentTocHref, chapterLabel], () => {
  if (sleepMode.value !== 'chapter' || ttsState.value !== 'playing' || listenDetached.value) return
  if ((currentTocHref.value ?? chapterLabel.value) !== sleepChapter) sleepNow()
})

const sleepText = computed(() => {
  if (sleepMode.value === 'chapter') return t('tts.sleepAfterChapter')
  if (!sleepAt.value) return ''
  const d = new Date(sleepAt.value)
  return t('tts.sleepAtClock', { clock: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` })
})

// ---- 系统媒体控制: 锁屏 / 耳机键 / 键盘媒体键 ----
function setupMediaSession() {
  const ms = (navigator as any).mediaSession
  if (!ms) return
  const on = (action: string, fn: () => void) => { try { ms.setActionHandler(action, fn) } catch { /* 不支持的动作 */ } }
  on('play', () => (ttsState.value === 'paused' ? resumeTTS() : void startTTS()))
  on('pause', pauseTTS)
  on('stop', stopTTS)
  on('previoustrack', () => void skipListen('paragraph', -1))
  on('nexttrack', () => void skipListen('paragraph', 1))
  on('seekbackward', () => void skipListen('sentence', -1))
  on('seekforward', () => void skipListen('sentence', 1))
  updateMediaSession()
}

function updateMediaSession() {
  const ms = (navigator as any).mediaSession
  if (!ms) return
  try {
    const MM = (window as any).MediaMetadata
    if (MM) ms.metadata = new MM({ title: chapterLabel.value || meta.value?.title || '', artist: meta.value?.author ?? '', album: meta.value?.title ?? '' })
    ms.playbackState = ttsState.value === 'playing' ? 'playing' : ttsState.value === 'paused' ? 'paused' : 'none'
  } catch { /* 忽略 */ }
}

function clearMediaSession() {
  const ms = (navigator as any).mediaSession
  if (!ms) return
  try {
    ms.playbackState = 'none'
    ms.metadata = null
    for (const a of ['play', 'pause', 'stop', 'previoustrack', 'nexttrack', 'seekbackward', 'seekforward']) ms.setActionHandler(a, null)
  } catch { /* 忽略 */ }
}

function onSectionLoad(e: CustomEvent) {
  // 打字机: 在新章节首次绘制前隐藏未打出的文字
  modes.onSectionLoad(e.detail)
  dj.onSectionLoad(e.detail)
  const { doc, index } = e.detail
  for (const resolve of sectionLoadResolvers.splice(0)) resolve()
  const custom = selectedCustomFont()
  if (custom) injectFontIntoDoc(doc, custom)
  doc.addEventListener('keydown', handleKeydown)
  const updateSelection = () => {
    const sel = doc.getSelection()
    if (!sel || sel.isCollapsed) {
      selection.value = null
      return
    }
    const text = sel.toString().trim()
    if (!text) {
      selection.value = null
      return
    }
    try {
      const cfi = view.getCFI(index, sel.getRangeAt(0))
      selectionRange = sel.getRangeAt(0).cloneRange()
      selection.value = cfi ? { cfi, text } : null
      dj.onSelection(index, selectionRange)
    } catch {
      selection.value = null
    }
  }
  doc.addEventListener('mouseup', () => setTimeout(updateSelection, 0))
  doc.addEventListener('touchend', () => setTimeout(updateSelection, 0))
  // 点击正文时收起目录等侧栏和浮层; 若这一下是为了收面板, 不再触发翻页
  doc.addEventListener('mousedown', () => {
    overlayDismissed = panel.value !== 'none' || settingsOpen.value || !!activeAnnotation.value
    panel.value = 'none'
    settingsOpen.value = false
    activeAnnotation.value = null
  })
  doc.addEventListener('click', (e: MouseEvent) => {
    // 触屏轻点已在 touchend 处理过, 吞掉其后的合成 click
    if (Date.now() < suppressClickUntil) return
    onContentClick(e.clientX, doc, e.target as Element, e.clientY)
  })

  // 触屏轻点: 触摸设备上合成 click 与 foliate 的 touch 吸附赛跑, 时有丢失/弹回
  // (Windows 触屏的"点击翻不动/翻了又弹回")。轻点在 touchend 直接判定并翻页,
  // 与滑动走同一条触摸管线; 之后的合成 click 一律吞掉。
  let touchStart: { x: number; y: number; t: number; atTop: boolean; atBottom: boolean; crossed?: boolean } | null = null
  doc.addEventListener('touchstart', (e: TouchEvent) => {
    const t0 = e.changedTouches[0]
    // 滚动模式下记下起手时是否已停在本节顶 / 底: 只有停稳后再滑才跨章, 避免惯性一滑到底就跳走
    const r = view?.renderer
    const scrolled = settings.reader.flow === 'scrolled' && r
    touchStart = t0
      ? {
          x: t0.clientX,
          y: t0.clientY,
          t: Date.now(),
          atTop: !!scrolled && r.start <= 1,
          atBottom: !!scrolled && r.viewSize - r.end <= 2,
        }
      : null
    pointerTs = Date.now()
  }, { passive: true })
  // 滚动模式: foliate 只在一节内滚动, 滑到头就停住。停在节尾继续上滑 (手指不用抬起)
  // 即进入下一节, 停在节首继续下滑回到上一节末尾; renderer.next / prev 在边界处切换分节
  doc.addEventListener('touchmove', (e: TouchEvent) => {
    const st = touchStart
    const t0 = e.changedTouches[0]
    if (!st || !t0 || st.crossed || settings.reader.flow !== 'scrolled') return
    const dy = t0.clientY - st.y
    if (Math.abs(dy) < 48 || Math.abs(dy) < Math.abs(t0.clientX - st.x) * 1.5) return
    const sel = doc.getSelection()
    if (sel && !sel.isCollapsed) return
    if (dy < 0 && st.atBottom) {
      st.crossed = true
      interruptTTSForReposition()
      view?.renderer?.next()
    } else if (dy > 0 && st.atTop) {
      st.crossed = true
      interruptTTSForReposition()
      view?.renderer?.prev()
    }
  }, { passive: true })
  // 捕获阶段先于 foliate 的 touchend 监听: 轻点时阻断其"吸附回当前页"动画,
  // 否则吸附动画与我们的翻页动画并发抢写滚动位置, 随机弹回 (Windows 触屏的病根)
  doc.addEventListener('touchend', (e: TouchEvent) => {
    const t0 = e.changedTouches[0]
    const st = touchStart
    touchStart = null
    if (!st || !t0) return
    const dx = t0.clientX - st.x
    const dy = t0.clientY - st.y
    // 翻页模式下明显的上下滑动也翻页 (上滑下一页 / 下滑上一页), 单手竖向阅读更顺手;
    // 正在选字 (长按后拖动) 不算。foliate 对竖向滑动本无动作, 但其 touchend 会做
    // 吸附动画, 与翻页动画抢滚动位置, 先拦掉
    if (settings.reader.flow === 'paginated' && Math.abs(dy) >= 60 && Math.abs(dy) >= Math.abs(dx) * 1.5) {
      const sel = doc.getSelection()
      if (sel && !sel.isCollapsed) return
      e.stopImmediatePropagation()
      suppressClickUntil = Date.now() + 700
      turnPage(dy < 0 ? 'right' : 'left')
      return
    }
    if (st.crossed) return
    // 滚动模式也能「翻页」: 明显的左右横滑按一屏滚动 (左滑下一屏 / 右滑上一屏)
    if (settings.reader.flow === 'scrolled' && Math.abs(dx) >= 60 && Math.abs(dx) >= Math.abs(dy) * 1.5) {
      const sel = doc.getSelection()
      if (sel && !sel.isCollapsed) return
      suppressClickUntil = Date.now() + 700
      turnPage(dx < 0 ? 'right' : 'left')
      return
    }
    // 有位移是滑动, 长按是选字, 都交给原有流程
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) return
    if (Date.now() - st.t > 350) return
    e.stopImmediatePropagation()
    if (panel.value !== 'none' || settingsOpen.value || activeAnnotation.value) {
      panel.value = 'none'
      settingsOpen.value = false
      activeAnnotation.value = null
    } else {
      onContentClick(t0.clientX, doc, e.target as Element, t0.clientY)
    }
    // 吞掉这次轻点随后的合成 click (必须在处理之后设置)
    suppressClickUntil = Date.now() + 700
  }, { passive: true, capture: true })

  // 指针/触摸引发的 focusin 会让 foliate 回滚到旧锚点 (表现为翻页弹回), 拦掉;
  // 键盘 Tab 导航的 focusin 不受影响
  doc.addEventListener('pointerdown', () => { pointerTs = Date.now() }, true)
  doc.addEventListener('focusin', (e: FocusEvent) => {
    if (Date.now() - pointerTs < 1000) e.stopImmediatePropagation()
  }, true)
}

let pointerTs = 0
let suppressClickUntil = 0

// 点正文左/右侧翻页
let overlayDismissed = false

function onContentClick(clientX: number, doc: Document, target?: Element | null, clientY = 0) {
  if (overlayDismissed) {
    overlayDismissed = false
    return
  }
  // 开书未就绪时点击会被 view.init 的落点覆盖, 表现为翻过去又弹回
  if (loading.value) return
  // 正在选字或点了链接时不翻页 (滚动模式下左右区同样生效: 按一屏平滑滚动)
  if (selection.value) return
  const sel = doc.getSelection()
  if (sel && !sel.isCollapsed) return
  if (target?.closest?.('a[href]')) return
  // 点睛: 点到概念 / 注释时弹出解释卡, 不翻页
  if (dj.onContentTap(doc, clientX, clientY)) return
  // 打字机 / 歌词运行时轻点只切换暂停或移动当前行, 不翻页
  const tap = modes.onContentTap({ y: clientY })
  if (tap) {
    if (tap === 'paused') showBars()
    else if (tap === 'menu') barsVisible.value ? hideBars() : showBars()
    else hideBars()
    return
  }
  // iframe 内坐标换算到窗口坐标 (分页模式下 iframe 比可视区宽且随翻页平移)
  const frameRect = doc.defaultView?.frameElement?.getBoundingClientRect()
  const contentRect = container.value?.getBoundingClientRect()
  if (!frameRect || !contentRect) return
  const x = frameRect.left + clientX - contentRect.left
  if (x < contentRect.width / 3) turnPage('left')
  else if (x > contentRect.width * 2 / 3) turnPage('right')
  // 中间 1/3: 呼出 / 隐藏工具栏 (沉浸式)
  else barsVisible.value ? hideBars() : showBars()
}

/**
 * 页眉页脚 (章节名 / 进度那条带) 在正文 iframe 之外, 点这里的事件落在 foliate-view 上,
 * 原本什么也不发生; 手机上拇指常点到页面最下沿, 按同样的左/中/右分区处理
 */
function onMarginClick(e: MouseEvent) {
  if (e.target !== view || loading.value) return
  if (panel.value !== 'none' || settingsOpen.value || activeAnnotation.value) {
    panel.value = 'none'
    settingsOpen.value = false
    activeAnnotation.value = null
    return
  }
  const rect = container.value?.getBoundingClientRect()
  if (!rect) return
  const x = e.clientX - rect.left
  if (x < rect.width / 3) turnPage('left')
  else if (x > rect.width * 2 / 3) turnPage('right')
  else barsVisible.value ? hideBars() : showBars()
}

function drawStoredAnnotations() {
  for (const a of highlights.value) {
    try {
      view.addAnnotation({ value: a.cfi, color: a.color })
    } catch { /* 不属于当前分节的标注忽略 */ }
  }
}

async function addHighlight(color: string, withNote = false) {
  if (!selection.value) return
  const storage = await getStorage()
  const rec: Omit<AnnotationRec, 'id'> = {
    bookId,
    kind: 'highlight',
    cfi: selection.value.cfi,
    text: selection.value.text.slice(0, 300),
    color,
    createdAt: Date.now(),
  }
  const id = await storage.addAnnotation(rec)
  const saved = { ...rec, id }
  annotations.value.push(saved)
  try {
    view.addAnnotation({ value: rec.cfi, color })
  } catch { /* 绘制失败不影响保存 */ }
  selection.value = null
  if (withNote) {
    noteDraft.value = ''
    activeAnnotation.value = saved
  } else {
    toast(t('reader.highlighted'), 'success')
  }
}

async function saveNote() {
  if (!activeAnnotation.value) return
  const storage = await getStorage()
  const note = noteDraft.value.trim() || undefined
  await storage.updateAnnotation(activeAnnotation.value.id, { note })
  activeAnnotation.value.note = note
  const item = annotations.value.find(a => a.id === activeAnnotation.value!.id)
  if (item) item.note = note
  activeAnnotation.value = null
  toast(t('reader.noteSaved'), 'success')
}

async function toggleBookmark() {
  if (!currentCfi.value) return
  const existing = bookmarks.value.find(b => b.cfi === currentCfi.value)
  const storage = await getStorage()
  if (existing) {
    await storage.deleteAnnotation(existing.id)
    annotations.value = annotations.value.filter(a => a.id !== existing.id)
    toast(t('reader.bookmarkRemoved'))
    return
  }
  const rec: Omit<AnnotationRec, 'id'> = {
    bookId,
    kind: 'bookmark',
    cfi: currentCfi.value,
    text: `${chapterLabel.value || meta.value?.title || t('reader.position')} · ${(fraction.value * 100).toFixed(1)}%`,
    color: 'bookmark',
    createdAt: Date.now(),
  }
  const id = await storage.addAnnotation(rec)
  annotations.value.push({ ...rec, id })
  toast(t('reader.bookmarkAdded'), 'success')
}

async function removeAnnotation(a: AnnotationRec) {
  const storage = await getStorage()
  await storage.deleteAnnotation(a.id)
  annotations.value = annotations.value.filter(x => x.id !== a.id)
  try {
    view.deleteAnnotation({ value: a.cfi })
  } catch { /* 当前分节未绘制时忽略 */ }
  activeAnnotation.value = null
}

async function gotoAnnotation(a: AnnotationRec) {
  panel.value = 'none'
  interruptTTSForReposition()
  await untilLoaded()
  view?.goTo(a.cfi).catch(() => toast(t('reader.cantGotoAnnotation'), 'error'))
}

async function runSearch() {
  const query = searchQuery.value.trim()
  if (!query || !view) return
  const session = ++searchSession
  searching.value = true
  searchResults.value = []
  searchTruncated.value = false
  searchProgress.value = 0
  try {
    for await (const ev of searchBook(view, query, searchOpts)) {
      if (session !== searchSession) return
      searchProgress.value = ev.progress
      if (ev.hits.length) searchResults.value.push(...ev.hits)
      if (ev.truncated) searchTruncated.value = true
    }
  } catch (e) {
    console.error(e)
    toast(searchOpts.regex ? t('reader.invalidRegex') : t('reader.searchFailed'), 'error')
  } finally {
    if (session === searchSession) searching.value = false
  }
}

/** 切换搜索选项后, 若已有关键词则立即重搜 */
function toggleSearchOpt(key: 'caseSensitive' | 'wholeWord' | 'regex') {
  searchOpts[key] = !searchOpts[key]
  if (searchQuery.value.trim()) runSearch()
}

function gotoSearchHit(hit: SearchHit) {
  panel.value = 'none'
  interruptTTSForReposition()
  view?.goTo(hit.cfi).catch(() => toast(t('reader.cantGoto'), 'error'))
}

function closeSearch() {
  searchSession++
  searching.value = false
  panel.value = 'none'
  searchResults.value = []
}

/** 打开书的瞬间 view.init 尚未归位, 此时跳转会被 init 落点覆盖 — 等它完成 */
async function untilLoaded() {
  for (let i = 0; i < 50 && loading.value; i++) {
    await new Promise(r => setTimeout(r, 100))
  }
}

async function navigateToc(href: string) {
  panel.value = 'none'
  interruptTTSForReposition()
  await untilLoaded()
  view?.goTo(href).catch(() => toast(t('reader.cantGoto'), 'error'))
}

/** 上一章 / 下一章: 按目录条目跳转; 书无目录时退回按分节跳 */
function gotoChapter(dir: -1 | 1) {
  interruptTTSForReposition()
  const flat = flattenToc(toc.value).filter(item => item.href)
  const i = flat.findIndex(item => item.href === currentTocHref.value)
  if (flat.length && i >= 0) {
    const target = flat[i + dir]
    if (target) view?.goTo(target.href).catch(() => toast(t('reader.cantGoto'), 'error'))
    return
  }
  // 当前位置在首个目录项之前 (如扉页): 下一章即第一项
  if (flat.length && dir > 0 && !currentTocHref.value) {
    view?.goTo(flat[0].href).catch(() => toast(t('reader.cantGoto'), 'error'))
    return
  }
  if (dir < 0) view?.renderer?.prevSection?.()
  else view?.renderer?.nextSection?.()
}

function onSlide(e: Event) {
  const value = parseFloat((e.target as HTMLInputElement).value)
  slidePreview.value = null
  void jumpTo({ fraction: value })
}

// ---- 拖动进度条预览: 松手前就知道会跳到哪一章、第几页 ----
const slidePreview = ref<{ fraction: number; label: string; text: string } | null>(null)

function onSlideInput(e: Event) {
  const value = parseFloat((e.target as HTMLInputElement).value)
  let label = ''
  let page = 0
  let total = 0
  if (view?.isFixedLayout) {
    total = pageInfo.value?.total ?? 0
    page = total ? Math.min(total, Math.floor(value * total) + 1) : 0
  } else {
    const hit = fractionToPage(secSizes, secCounts, value)
    if (hit) {
      page = hit.page
      total = pageInfo.value?.total ?? 0
      label = chapterAtFraction(value, hit.index)
    }
  }
  const parts: string[] = []
  if (page && total && settings.reader.progressDisplay !== 'percent') parts.push(`${page} / ${total}`)
  if (!parts.length || settings.reader.progressDisplay !== 'page') parts.push(`${(value * 100).toFixed(1)}%`)
  slidePreview.value = { fraction: value, label, text: parts.join(' · ') }
}

// ---- 跳页: 点底栏页码输入页码或百分比; 跳转后可一键回到原来的位置 ----
const jumpOpen = ref(false)
const jumpText = ref('')
const jumpError = ref('')
const jumpInputEl = ref<HTMLInputElement>()
const jumpPopEl = ref<HTMLElement>()
/** 跳转前的位置; 有值时底栏上方出现「回到第 N 页」 */
const jumpBack = ref<{ cfi: string; label: string } | null>(null)
let jumpBackTimer: ReturnType<typeof setTimeout> | undefined

const jumpMeta = computed(() => {
  const p = pageInfo.value
  const parts: string[] = []
  if (p) parts.push(t('reader.pageOfTotal', { page: pageRangeText.value, total: p.total }))
  if (printPage.value) parts.push(t('reader.printPage', { n: printPage.value }))
  return parts.join(' · ')
})

function toggleJump() {
  const next = !jumpOpen.value
  closeOverlays()
  jumpOpen.value = next
  if (!next) return
  jumpText.value = ''
  jumpError.value = ''
  showBars()
  void nextTick(() => jumpInputEl.value?.focus())
}

/** 点浮层以外的地方收起 (桌面端没有遮罩) */
function onJumpOutside(e: PointerEvent) {
  const el = e.target as Node
  if (jumpPopEl.value?.contains(el) || (el as HTMLElement).closest?.('.progress-label')) return
  jumpOpen.value = false
}
watch(jumpOpen, open => {
  if (open) document.addEventListener('pointerdown', onJumpOutside, true)
  else document.removeEventListener('pointerdown', onJumpOutside, true)
})

async function jumpTo(target: { fraction: number } | number) {
  if (!view) return
  const from = currentCfi.value
  const label = pageInfo.value && settings.reader.progressDisplay !== 'percent'
    ? t('reader.jumpBack', { page: pageInfo.value.current })
    : `${t('common.back')} ${percentText.value}`
  interruptTTSForReposition()
  try {
    await view.goTo(target)
  } catch {
    toast(t('reader.cantGoto'), 'error')
    return
  }
  if (!from || from === currentCfi.value) return
  jumpBack.value = { cfi: from, label }
  clearTimeout(jumpBackTimer)
  jumpBackTimer = setTimeout(() => { jumpBack.value = null }, 12000)
  showBars(true)
}

async function confirmJump() {
  const total = pageInfo.value?.total ?? 0
  const parsed = parseJumpInput(jumpText.value, total)
  if (!parsed) {
    jumpError.value = t('reader.jumpInvalid', { total: total || 1 })
    return
  }
  let target: { fraction: number } | number | null
  if ('fraction' in parsed) target = { fraction: parsed.fraction }
  else if (view?.isFixedLayout) target = parsed.page - 1
  else {
    const f = pageToFraction(secSizes, secCounts, parsed.page, {
      perScreen: pagesPerScreen,
      scrolled: settings.reader.flow === 'scrolled',
    })
    target = f == null ? null : { fraction: f }
  }
  if (target == null) return
  jumpOpen.value = false
  await jumpTo(target)
}

function goJumpBack() {
  const back = jumpBack.value
  jumpBack.value = null
  clearTimeout(jumpBackTimer)
  if (!back) return
  interruptTTSForReposition()
  view?.goTo(back.cfi).catch(() => toast(t('reader.cantGoto'), 'error'))
}

// ---- 阅读模式 (打字机等, 见 docs/reading-modes.md); 选项都是闭包, 用到时才取值 ----
const modes = useReadingModes({
  getView: () => view,
  getColors: () => themeColors.value,
  pingReadingAuto,
  appDark: () => appDark.value,
  onExclusiveStart: () => {
    stopAutoRead()
    if (ttsState.value === 'playing') pauseTTS()
  },
  stopAutoRead,
  pauseTTS: () => { if (ttsState.value === 'playing') pauseTTS() },
  isAutoReading: () => autoReading.value,
  isTTSActive: () => ttsState.value === 'playing',
  pauseWhen: () => panel.value !== 'none' || settingsOpen.value || ttsPanel.value || jumpOpen.value || ambientPanel.value
    || !!activeAnnotation.value || !!lateDj.value?.overlayOpen.value,
  beforePanelOpen: closeOverlays,
  // 沉浸: 安卓隐藏系统栏 + 常亮 (网页 / 桌面用 Wake Lock), 并收起工具栏
  onImmersiveChange: on => {
    setSystemBarsHidden(on)
    void setKeepScreenOn(on)
    if (on) hideBars()
  },
  refreshMarginals: () => updateMarginals(),
  onReminder: () => stopAutoRead(),
  // 跟听书的歌词: 点了另一行 → 听书从那一句读
  onLyricSeek: range => { void startTTS({ range }) },
  isDianjingActive: () => !!lateDj.value?.active.value,
  onWordGuideEnabled: () => { if (lateDj.value?.active.value) lateDj.value.toggle() },
})
lateModes.value = modes

// ---- 点睛阅读 (docs/dianjing-reading.md) ----
const dj = useDianjing({
  getView: () => view,
  bookId,
  getMeta: () => meta.value && {
    title: meta.value.title,
    author: meta.value.author,
    language: (meta.value as any).language,
    tags: (meta.value as any).tags,
    subjects: (view?.book?.metadata?.subject ?? []).map((x: any) => (typeof x === 'string' ? x : x?.name ?? '')),
  },
  getThemeName: () => djThemeName(resolveReaderTheme(settings.reader.theme, appDark.value), !!lateModes.value?.einkActive.value),
  isEink: () => !!lateModes.value?.einkActive.value,
  // 「我也觉得」: 收为自己的划线 (与划词划线同一份存储, 会随同步)
  adoptHighlight: async ({ index, range, text, withNote }) => {
    let cfi = ''
    try { cfi = view.getCFI(index, range) } catch { return }
    const storage = await getStorage()
    const rec: Omit<AnnotationRec, 'id'> = { bookId, kind: 'highlight', cfi, text: text.slice(0, 300), color: 'yellow', createdAt: Date.now() }
    const id = await storage.addAnnotation(rec)
    const saved = { ...rec, id }
    annotations.value.push(saved)
    try { view.addAnnotation({ value: cfi, color: 'yellow' }) } catch { /* 绘制失败不影响保存 */ }
    if (withNote) {
      noteDraft.value = ''
      activeAnnotation.value = saved
    } else toast(t('reader.highlighted'), 'success')
  },
  openAi: prompt => {
    closeOverlays()
    panel.value = 'ai'
    void sendAi(prompt)
  },
  beforeOverlay: closeOverlays,
})
lateDj.value = dj

// 排版相关的阅读模式 (大字 / 墨水屏 / 歌词等) 切换后重排正文; 放在 modes 声明之后 (watch 立即求值)
watch(() => modes.renderKey.value, () => {
  clearTimeout(prefsTimer)
  prefsTimer = setTimeout(applyPrefs, 60)
})
const readingModeActive = computed(() => modes.panelOpen.value || autoReading.value || modes.progressActive.value)

/**
 * 打字机的进度与剩余时间: 与听书同一套页码模型 (每页字数 × 剩余页数), 速度取设定值;
 * 西文按词/分换算为字母/分 (约 5 个字母一个词), 开了标点停顿再放宽一成。
 */
const typewriterProgress = computed<ReadingModeProgress | null>(() => {
  if (!modes.progressActive.value) return null
  const p = pageInfo.value
  let eta: { chapter: number; book: number } | null = null
  if (p && charsPerPage.value && !fixedLayout.value) {
    const perMinute = modes.speedUnit.value === 'cpm' ? modes.speed.value : modes.speed.value * 5
    const factor = settings.readingMode.typewriter.punctuationPause ? 1.1 : 1
    const secondsPerPage = charsPerPage.value / (perMinute / 60) * factor
    const halfScreen = (p.last - p.current + 1) / 2
    eta = {
      chapter: ((chapterLeft.value ?? p.sectionLeft) + halfScreen) * secondsPerPage,
      book: (p.total - p.last + halfScreen) * secondsPerPage,
    }
  }
  return {
    chapter: chapterLabel.value || meta.value?.title || '',
    chapterProgress: chapterProgress.value ?? fraction.value,
    chapterLeft: eta ? t('tts.chapterLeft', { time: humanTime(eta.chapter) }) : '',
    chapterLeftShort: eta ? humanTime(eta.chapter) : '',
    finish: eta ? clockText(eta.chapter, 'read') : '',
    book: eta ? t('tts.bookSummary', { pct: percentText.value, time: humanTime(eta.book) }) : t('readingMode.bookPercent', { pct: percentText.value }),
    percent: percentText.value,
  }
})

// 「几点读完」随时间刷新
let twClockTimer: ReturnType<typeof setInterval> | undefined
// 打字机 / 歌词开始: 收起工具栏, 页脚让给状态条; 结束后恢复页脚
watch(() => modes.progressActive.value, on => {
  if (on) hideBars()
  updateMarginals()
})

watch(() => modes.progressActive.value, on => {
  clearInterval(twClockTimer)
  if (on) {
    nowTick.value = Date.now()
    twClockTimer = setInterval(() => { nowTick.value = Date.now() }, 30000)
  }
})

onMounted(async () => {
  // 匿名使用统计: 今天打开过书 (每天一次, 设置 → 隐私 可关闭)
  void pingUsage(true)
  // 手机切后台时背景音暂停, 但听书在播时跟随听书的后台策略
  ambient.setPauseWhenHidden(() => ttsState.value !== 'playing')
  window.addEventListener('keydown', handleKeydown)
  document.addEventListener('fullscreenchange', syncFullscreenState)
  showBars(true)
  try {
    const storage = await getStorage()
    meta.value = await storage.getBook(bookId)
    if (!meta.value) {
      error.value = t('reader.bookNotFound')
      return
    }
    if (meta.value.format === 'pdf') {
      router.replace(`/read-paper/${bookId}`)
      return
    }
    if (meta.value.format === 'djvu') {
      router.replace(`/read-djvu/${bookId}`)
      return
    }
    annotations.value = await storage.listAnnotations(bookId)

    const blob = await storage.getBookFile(bookId)
    let file: File
    if (isTextLike(meta.value.format)) {
      const { epub } = await convertToEpub(blob, meta.value.fileName, meta.value.format as 'txt' | 'md' | 'html')
      file = new File([epub], `${meta.value.title}.epub`, { type: 'application/epub+zip' })
    } else if (meta.value.format === 'cbr') {
      const { cbrToCbz } = await import('../services/comic')
      file = new File([await cbrToCbz(blob)], `${meta.value.title}.cbz`)
    } else {
      file = new File([blob], meta.value.fileName)
    }

    await import('foliate-js/view.js')
    Overlayer = (await import('foliate-js/overlayer.js')).Overlayer

    view = document.createElement('foliate-view')
    view.style.width = '100%'
    view.style.height = '100%'
    container.value!.append(view)

    view.addEventListener('relocate', onRelocate)
    view.addEventListener('click', onMarginClick)
    view.addEventListener('load', onSectionLoad)
    view.addEventListener('create-overlay', () => drawStoredAnnotations())
    view.addEventListener('draw-annotation', (e: CustomEvent) => {
      const { draw, annotation } = e.detail
      draw(Overlayer.highlight, { color: HIGHLIGHT_COLORS[annotation.color] ?? annotation.color })
    })
    view.addEventListener('show-annotation', (e: CustomEvent) => {
      const found = annotations.value.find(a => a.cfi === e.detail.value)
      if (found) {
        noteDraft.value = found.note ?? ''
        activeAnnotation.value = found
      }
    })

    const { makeFoliateBook } = await import('../services/foliateBook')
    await view.open(await makeFoliateBook(file))
    toc.value = view.book?.toc ?? []
    secSizes = sectionSizes(view.book?.sections ?? [])
    bookCjk.value = view.language?.isCJK ?? true
    loadPageMeasure()
    void buildTocAnchors()
    applyPrefs()
    // 文本类书籍的内存 EPUB 版式变过 (v2: 多章合为一个分节), 旧版式下存的 CFI 指向别处;
    // 这类书首次用新版式打开时按阅读进度比例定位, 之后照常用 CFI
    const layoutKey = `lightread-text-layout:${bookId}`
    let staleTextLocation = false
    if (isTextLike(meta.value.format) && meta.value.location) {
      try { staleTextLocation = localStorage.getItem(layoutKey) !== TEXT_EPUB_LAYOUT } catch { /* 存储不可用时按新版式处理 */ }
    }
    if (staleTextLocation) {
      await view.init({})
      if (meta.value.progress) await view.goToFraction(meta.value.progress)
    } else {
      await view.init({ lastLocation: meta.value.location })
    }
    if (isTextLike(meta.value.format)) {
      try { localStorage.setItem(layoutKey, TEXT_EPUB_LAYOUT) } catch { /* 忽略 */ }
    }
    loading.value = false
    if (flattenToc(toc.value).length <= 1) void applySmartToc()
  } catch (e: any) {
    console.error(e)
    error.value = e?.message ?? t('reader.cantOpenBook')
  } finally {
    loading.value = false
  }
})

onBeforeUnmount(() => {
  setPageBarsDark(null)
  window.removeEventListener('keydown', handleKeydown)
  document.removeEventListener('fullscreenchange', syncFullscreenState)
  // 回藏书页时恢复窗口状态
  if (isFullscreen.value) toggleFullscreen()
  clearTimeout(saveTimer)
  clearTimeout(pageSaveTimer)
  clearTimeout(jumpBackTimer)
  clearTimeout(tocFractionTimer)
  clearInterval(nowTimer)
  clearInterval(twClockTimer)
  document.removeEventListener('pointerdown', onJumpOutside, true)
  if (pageMeasure.key) {
    try { localStorage.setItem(PAGE_MEASURE_KEY, JSON.stringify(pageMeasure)) } catch { /* 忽略 */ }
  }
  stopAutoRead()
  stopTTS()
  modes.dispose()
  dj.dispose()
  // 背景音属于阅读场景, 离开阅读器即淡出停止
  ambient.stop()
  ambient.setPauseWhenHidden(null)
  view?.close?.()
  view?.remove()
})
</script>

<template>
  <div class="reader" :class="[{ 'bars-on': barsVisible }, modes.shellClass.value]" :style="{ background: themeColors.bg, color: themeColors.fg }">
    <!-- 工具栏隐藏时: 鼠标移到上下边缘呼出 -->
    <div v-if="!barsVisible" class="bar-peek top" @mouseenter="showBars()" />
    <div v-if="!barsVisible" class="bar-peek bottom" @mouseenter="showBars()" />

    <!-- 全屏时右上角悬浮退出按钮 -->
    <button
      v-if="isFullscreen && !barsVisible"
      class="fs-exit"
      :title="t('reader.exitFullscreen')"
      @click="toggleFullscreen"
    >
      <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M8 3a1 1 0 0 1 1 1v3a2 2 0 0 1-2 2H4a1 1 0 0 1 0-2h3V4a1 1 0 0 1 1-1zm8 0a1 1 0 0 1 1 1v3h3a1 1 0 1 1 0 2h-3a2 2 0 0 1-2-2V4a1 1 0 0 1 1-1zM4 15h3a2 2 0 0 1 2 2v3a1 1 0 1 1-2 0v-3H4a1 1 0 0 1 0-2zm13 0h3a1 1 0 1 1 0 2h-3v3a1 1 0 1 1-2 0v-3a2 2 0 0 1 2-2z"/></svg>
    </button>

    <!-- 顶栏 -->
    <header class="bar top" :class="{ hidden: !barsVisible }" @mouseenter="cancelBarsTimer">
      <button class="icon-btn" :title="t('reader.backToLibrary')" @click="router.push('/library')">
        <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M14.7 5.3a1 1 0 0 1 0 1.4L9.42 12l5.3 5.3a1 1 0 0 1-1.42 1.4l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 1.42 0z"/></svg>
      </button>
      <div class="book-title">
        <strong>{{ meta?.title }}</strong>
        <span v-if="chapterLabel" class="chapter">{{ chapterLabel }}</span>
      </div>
      <!-- 听书中且工具栏显示时, 胶囊收进顶栏中间 -->
      <div v-if="ttsChipInBar" class="tts-chip" role="group" :aria-label="t('tts.title')">
        <button class="tts-chip-main" :title="t('tts.expandPanel')" @click="openTTSPanel">
          <span class="tts-mini-dot" :class="{ paused: ttsState === 'paused' }" />
          <span class="tts-chip-text">{{ ttsBuffering ? t('tts.buffering') : listenEta ? humanTime(listenEta.chapter) : (ttsState === 'playing' ? t('tts.reading') : t('tts.paused')) }}</span>
        </button>
        <button v-if="listenDetached" class="tts-mini-btn" :title="t('tts.backToListening')" :aria-label="t('tts.backToListening')" @click="returnToListening"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M12 2a1 1 0 0 1 1 1v1.06A8 8 0 0 1 19.94 11H21a1 1 0 1 1 0 2h-1.06A8 8 0 0 1 13 19.94V21a1 1 0 1 1-2 0v-1.06A8 8 0 0 1 4.06 13H3a1 1 0 1 1 0-2h1.06A8 8 0 0 1 11 4.06V3a1 1 0 0 1 1-1zm0 4a6 6 0 1 0 0 12 6 6 0 0 0 0-12zm0 3a3 3 0 1 1 0 6 3 3 0 0 1 0-6z"/></svg></button>
        <button
          class="tts-mini-btn"
          :title="ttsState === 'playing' ? t('common.pause') : t('common.resume')"
          :aria-label="ttsState === 'playing' ? t('common.pause') : t('common.resume')"
          @click="ttsState === 'playing' ? pauseTTS() : resumeTTS()"
        >
          <template v-if="ttsState === 'playing'"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 5a1.5 1.5 0 0 1 1.5 1.5v11a1.5 1.5 0 0 1-3 0v-11A1.5 1.5 0 0 1 8 5zm8 0a1.5 1.5 0 0 1 1.5 1.5v11a1.5 1.5 0 0 1-3 0v-11A1.5 1.5 0 0 1 16 5z"/></svg></template>
          <template v-else><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8.5 5.2a1 1 0 0 1 1.02.03l9 5.95a1 1 0 0 1 0 1.66l-9 5.95A1 1 0 0 1 8 17.95V6.05a1 1 0 0 1 .5-.85z"/></svg></template>
        </button>
      </div>
      <div class="bar-actions">
        <button class="icon-btn desk-only" :title="t('reader.toc')" @click="togglePanel('toc')">
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M4 6a1 1 0 0 1 1-1h1a1 1 0 0 1 0 2H5a1 1 0 0 1-1-1zm5 0a1 1 0 0 1 1-1h9a1 1 0 1 1 0 2h-9a1 1 0 0 1-1-1zM4 12a1 1 0 0 1 1-1h1a1 1 0 1 1 0 2H5a1 1 0 0 1-1-1zm5 0a1 1 0 0 1 1-1h9a1 1 0 1 1 0 2h-9a1 1 0 0 1-1-1zM4 18a1 1 0 0 1 1-1h1a1 1 0 1 1 0 2H5a1 1 0 0 1-1-1zm5 0a1 1 0 0 1 1-1h9a1 1 0 1 1 0 2h-9a1 1 0 0 1-1-1z"/></svg>
        </button>
        <button class="icon-btn desk-only" :title="t('reader.annotationsBookmarks')" @click="togglePanel('annotations')">
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19a1 1 0 0 1 1 1v15a2 2 0 0 1-2 2H6.5A2.5 2.5 0 0 1 4 18.5v-13zM6.5 5a.5.5 0 0 0-.5.5v11.34c.16-.05.33-.08.5-.08H18V5H6.5z"/></svg>
        </button>
        <button
          class="icon-btn"
          :class="{ 'auto-on': isBookmarked }"
          :title="isBookmarked ? t('reader.removeBookmark') : t('reader.addBookmark')"
          @click="toggleBookmark"
        >
          <svg viewBox="0 0 24 24" width="18" height="18">
            <path v-if="isBookmarked" fill="currentColor" d="M6 3h12a1 1 0 0 1 1 1v16.2a.8.8 0 0 1-1.24.67L12 17.6l-5.76 3.27A.8.8 0 0 1 5 20.2V4a1 1 0 0 1 1-1z"/>
            <path v-else fill="currentColor" d="M6 3h12a1 1 0 0 1 1 1v16.2a.8.8 0 0 1-1.24.67L12 17.6l-5.76 3.27A.8.8 0 0 1 5 20.2V4a1 1 0 0 1 1-1zm1 2v13.48l4.5-2.55a1 1 0 0 1 .99 0l4.51 2.55V5H7z"/>
          </svg>
        </button>
        <button class="icon-btn desk-only" :class="{ 'auto-on': ttsState !== 'stopped' }" :title="t('tts.title')" @click="openTTSPanel">
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 3a7 7 0 0 0-7 7v1.1A3.5 3.5 0 0 0 3 14.5v2A3.5 3.5 0 0 0 6.5 20H8a1 1 0 0 0 1-1v-7a1 1 0 0 0-1-1h-.9A5 5 0 0 1 12 5a5 5 0 0 1 4.9 6H16a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h1.5a3.5 3.5 0 0 0 3.5-3.5v-2a3.5 3.5 0 0 0-2-3.16V10a7 7 0 0 0-7-7z"/></svg>
        </button>
        <button class="icon-btn" :class="{ 'auto-on': panel === 'ai' }" :title="t('ai.title')" @click="togglePanel('ai')">
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 2.5a1 1 0 0 1 .95.69l1.4 4.3a3 3 0 0 0 1.92 1.92l4.3 1.4a1 1 0 0 1 0 1.9l-4.3 1.4a3 3 0 0 0-1.92 1.92l-1.4 4.3a1 1 0 0 1-1.9 0l-1.4-4.3a3 3 0 0 0-1.92-1.92l-4.3-1.4a1 1 0 0 1 0-1.9l4.3-1.4a3 3 0 0 0 1.92-1.92l1.4-4.3A1 1 0 0 1 12 2.5zm7.5 12.7a.8.8 0 0 1 .76.55l.42 1.28a1.6 1.6 0 0 0 1.02 1.02l1.28.42a.8.8 0 0 1 0 1.52l-1.28.42a1.6 1.6 0 0 0-1.02 1.02l-.42 1.28a.8.8 0 0 1-1.52 0l-.42-1.28a1.6 1.6 0 0 0-1.02-1.02l-1.28-.42a.8.8 0 0 1 0-1.52l1.28-.42a1.6 1.6 0 0 0 1.02-1.02l.42-1.28a.8.8 0 0 1 .76-.55z"/></svg>
        </button>
        <button
          class="icon-btn ambient-btn"
          :class="{ 'auto-on': ambientPanel || ambient.state.playing }"
          :title="t('ambient.title')"
          :aria-label="t('ambient.title')"
          @click="toggleAmbientPanel"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 3a1 1 0 0 1 1 1v16a1 1 0 1 1-2 0V4a1 1 0 0 1 1-1zM8 7a1 1 0 0 1 1 1v8a1 1 0 1 1-2 0V8a1 1 0 0 1 1-1zm8 0a1 1 0 0 1 1 1v8a1 1 0 1 1-2 0V8a1 1 0 0 1 1-1zM4 10a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0v-2a1 1 0 0 1 1-1zm16 0a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0v-2a1 1 0 0 1 1-1z"/></svg>
          <span v-if="ambient.state.playing" class="ambient-dot" aria-hidden="true" />
        </button>
        <button class="icon-btn" :title="t('reader.searchInBook')" @click="togglePanel('search')">
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M10.5 3a7.5 7.5 0 1 0 4.55 13.46l3.75 3.75a1 1 0 0 0 1.4-1.42l-3.74-3.74A7.5 7.5 0 0 0 10.5 3zM5 10.5a5.5 5.5 0 1 1 11 0 5.5 5.5 0 0 1-11 0z"/></svg>
        </button>
        <button
          class="icon-btn desk-only"
          :class="{ 'auto-on': readingModeActive }"
          :title="t('readingMode.title')"
          :aria-label="t('readingMode.title')"
          @click="modes.togglePanel()"
        >
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm0 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16zm-1.8 4.4 5.4 3.1a.6.6 0 0 1 0 1l-5.4 3.1a.6.6 0 0 1-.9-.5V8.9a.6.6 0 0 1 .9-.5z"/></svg>
        </button>
        <button class="icon-btn desk-only" :title="t('reader.typography')" @click="toggleSettings">
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M11.1 4.55a1 1 0 0 1 1.8 0l5.6 12.02a1 1 0 1 1-1.81.86L15.3 14.5H8.7l-1.39 2.93a1 1 0 1 1-1.8-.86L11.1 4.55zM9.64 12.5h4.72L12 7.36 9.64 12.5z"/></svg>
        </button>
        <button class="icon-btn desk-only" :class="{ 'auto-on': isFullscreen }" :title="isFullscreen ? t('reader.exitFullscreen') : t('reader.fullscreen')" @click="toggleFullscreen">
          <svg v-if="!isFullscreen" viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M4 9a1 1 0 0 1-1-1V5a2 2 0 0 1 2-2h3a1 1 0 0 1 0 2H5v3a1 1 0 0 1-1 1zm16 0a1 1 0 0 1-1-1V5h-3a1 1 0 1 1 0-2h3a2 2 0 0 1 2 2v3a1 1 0 0 1-1 1zM4 15a1 1 0 0 1 1 1v3h3a1 1 0 1 1 0 2H5a2 2 0 0 1-2-2v-3a1 1 0 0 1 1-1zm16 0a1 1 0 0 1 1 1v3a2 2 0 0 1-2 2h-3a1 1 0 1 1 0-2h3v-3a1 1 0 0 1 1-1z"/></svg>
          <svg v-else viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M8 3a1 1 0 0 1 1 1v3a2 2 0 0 1-2 2H4a1 1 0 0 1 0-2h3V4a1 1 0 0 1 1-1zm8 0a1 1 0 0 1 1 1v3h3a1 1 0 1 1 0 2h-3a2 2 0 0 1-2-2V4a1 1 0 0 1 1-1zM4 15h3a2 2 0 0 1 2 2v3a1 1 0 1 1-2 0v-3H4a1 1 0 0 1 0-2zm13 0h3a1 1 0 1 1 0 2h-3v3a1 1 0 1 1-2 0v-3a2 2 0 0 1 2-2z"/></svg>
        </button>
      </div>
    </header>

    <!-- 正文 -->
    <div ref="container" class="content" />

    <div v-if="loading" class="state">{{ t('reader.opening') }}</div>
    <div v-if="error" class="state">
      <p>{{ error }}</p>
      <button class="btn" @click="router.push('/library')">{{ t('reader.backToLibrary') }}</button>
    </div>

    <!-- 翻页按钮 -->
    <button v-if="!loading && !error" class="nav prev" :title="t('reader.prevPage')" @click="turnPage('left')">
      <svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M14.7 5.3a1 1 0 0 1 0 1.4L9.42 12l5.3 5.3a1 1 0 0 1-1.42 1.4l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 1.42 0z"/></svg>
    </button>
    <button v-if="!loading && !error" class="nav next" :title="t('reader.nextPage')" @click="turnPage('right')">
      <svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M9.3 5.3a1 1 0 0 1 1.4 0l6 6a1 1 0 0 1 0 1.4l-6 6a1 1 0 0 1-1.4-1.4l5.29-5.3-5.3-5.3a1 1 0 0 1 0-1.4z"/></svg>
    </button>

    <!-- 底栏: 章节跳转 + 进度; 手机端下方再加一排常用入口 (目录 / 笔记 / 听书 / 自动 / 排版) -->
    <footer class="bar bottom" :class="{ hidden: !barsVisible }" @mouseenter="cancelBarsTimer">
      <div class="progress-row">
        <button class="icon-btn chapter-btn" :title="t('reader.prevChapter')" :aria-label="t('reader.prevChapter')" @click="gotoChapter(-1)">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M18.7 5.3a1 1 0 0 1 0 1.4L13.42 12l5.3 5.3a1 1 0 0 1-1.42 1.4l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 1.42 0zM7 5a1 1 0 0 1 1 1v12a1 1 0 1 1-2 0V6a1 1 0 0 1 1-1z"/></svg>
        </button>
        <div class="slider-wrap">
          <input
            class="slider"
            type="range"
            min="0"
            max="1"
            step="0.0005"
            :value="slidePreview ? slidePreview.fraction : fraction"
            :aria-label="t('reader.progress')"
            :aria-valuetext="progressText"
            @input="onSlideInput"
            @change="onSlide"
            @blur="slidePreview = null"
          />
          <div
            v-if="slidePreview"
            class="slide-bubble"
            :style="{ left: `clamp(64px, ${slidePreview.fraction * 100}%, calc(100% - 64px))` }"
            aria-hidden="true"
          >
            <strong v-if="slidePreview.label">{{ slidePreview.label }}</strong>
            <span>{{ slidePreview.text }}</span>
          </div>
        </div>
        <button class="icon-btn chapter-btn" :title="t('reader.nextChapter')" :aria-label="t('reader.nextChapter')" @click="gotoChapter(1)">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M5.3 5.3a1 1 0 0 1 1.4 0l6 6a1 1 0 0 1 0 1.4l-6 6a1 1 0 0 1-1.4-1.4l5.29-5.3-5.3-5.3a1 1 0 0 1 0-1.4zM17 5a1 1 0 0 1 1 1v12a1 1 0 1 1-2 0V6a1 1 0 0 1 1-1z"/></svg>
        </button>
        <button
          class="percent progress-label"
          :class="{ active: jumpOpen }"
          :title="t('reader.jumpTo')"
          :aria-label="`${t('reader.jumpTo')} · ${progressText}`"
          :aria-expanded="jumpOpen"
          @click="toggleJump"
        >
          <template v-if="showPage">
            <b>{{ pageRangeText }}</b><span class="of">/{{ pageInfo!.total }}</span>
          </template>
          <span v-if="showPage && showPercent" class="sep" aria-hidden="true">·</span>
          <span v-if="showPercent" class="pct">{{ percentText }}</span>
        </button>
      </div>
      <nav class="dock" :aria-label="t('reader.readerTools')">
        <button :class="{ active: panel === 'toc' }" @click="togglePanel('toc')">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M4 6a1 1 0 0 1 1-1h1a1 1 0 0 1 0 2H5a1 1 0 0 1-1-1zm5 0a1 1 0 0 1 1-1h9a1 1 0 1 1 0 2h-9a1 1 0 0 1-1-1zM4 12a1 1 0 0 1 1-1h1a1 1 0 1 1 0 2H5a1 1 0 0 1-1-1zm5 0a1 1 0 0 1 1-1h9a1 1 0 1 1 0 2h-9a1 1 0 0 1-1-1zM4 18a1 1 0 0 1 1-1h1a1 1 0 1 1 0 2H5a1 1 0 0 1-1-1zm5 0a1 1 0 0 1 1-1h9a1 1 0 1 1 0 2h-9a1 1 0 0 1-1-1z"/></svg>
          <span>{{ t('reader.toc') }}</span>
        </button>
        <button :class="{ active: panel === 'annotations' }" @click="togglePanel('annotations')">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19a1 1 0 0 1 1 1v15a2 2 0 0 1-2 2H6.5A2.5 2.5 0 0 1 4 18.5v-13zM6.5 5a.5.5 0 0 0-.5.5v11.34c.16-.05.33-.08.5-.08H18V5H6.5z"/></svg>
          <span>{{ t('reader.dockNotes') }}</span>
        </button>
        <button :class="{ active: ttsPanel || ttsState !== 'stopped' }" @click="openTTSPanel">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M12 3a7 7 0 0 0-7 7v1.1A3.5 3.5 0 0 0 3 14.5v2A3.5 3.5 0 0 0 6.5 20H8a1 1 0 0 0 1-1v-7a1 1 0 0 0-1-1h-.9A5 5 0 0 1 12 5a5 5 0 0 1 4.9 6H16a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h1.5a3.5 3.5 0 0 0 3.5-3.5v-2a3.5 3.5 0 0 0-2-3.16V10a7 7 0 0 0-7-7z"/></svg>
          <span>{{ t('tts.title') }}</span>
        </button>
        <button :class="{ active: readingModeActive }" :aria-label="t('readingMode.title')" @click="modes.togglePanel()">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M6 3h9.59L20 7.41V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm1 2v14h11V8.24L14.76 5H7zm2 4h6a1 1 0 1 1 0 2H9a1 1 0 1 1 0-2zm0 4h3a1 1 0 1 1 0 2H9a1 1 0 1 1 0-2zm6 0h.5a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0v-2a1 1 0 0 1 .5-1z"/></svg>
          <span>{{ t('readingMode.dock') }}</span>
        </button>
        <button :class="{ active: settingsOpen }" @click="toggleSettings">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M11.1 4.55a1 1 0 0 1 1.8 0l5.6 12.02a1 1 0 1 1-1.81.86L15.3 14.5H8.7l-1.39 2.93a1 1 0 1 1-1.8-.86L11.1 4.55zM9.64 12.5h4.72L12 7.36 9.64 12.5z"/></svg>
          <span>{{ t('reader.dockTypography') }}</span>
        </button>
      </nav>
    </footer>

    <!-- 手机端面板为底部抽屉, 点遮罩收起 -->
    <div v-if="sheetOpen" class="sheet-scrim" aria-hidden="true" @click="closeOverlays" />

    <!-- 跳页: 输入页码或百分比 -->
    <div
      v-if="jumpOpen"
      ref="jumpPopEl"
      class="jump-pop card"
      role="dialog"
      :aria-label="t('reader.jumpTo')"
    >
      <form class="jump-form" @submit.prevent="confirmJump">
        <input
          ref="jumpInputEl"
          v-model="jumpText"
          class="input jump-input"
          inputmode="decimal"
          enterkeyhint="go"
          autocomplete="off"
          :placeholder="t('reader.jumpPlaceholder')"
          :aria-label="t('reader.jumpPlaceholder')"
          :aria-invalid="!!jumpError"
          @input="jumpError = ''"
          @keydown.esc.prevent="jumpOpen = false"
        />
        <span v-if="pageInfo" class="jump-total">/ {{ pageInfo.total }}</span>
        <button class="btn btn-primary btn-sm" type="submit">{{ t('reader.jumpGo') }}</button>
      </form>
      <p v-if="jumpError" class="jump-meta error" role="alert">{{ jumpError }}</p>
      <template v-else>
        <p v-if="jumpMeta" class="jump-meta">{{ jumpMeta }}</p>
        <p v-if="pageInfo && !fixedLayout" class="jump-hint">{{ t('reader.pageHint') }}</p>
      </template>
    </div>

    <!-- 跳转后一键回到原处 -->
    <button v-if="jumpBack && barsVisible && !slidePreview" class="jump-back" @click="goJumpBack">
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M9.7 5.3a1 1 0 0 1 0 1.4L7.42 9H14a6 6 0 1 1 0 12h-3a1 1 0 1 1 0-2h3a4 4 0 0 0 0-8H7.41l2.3 2.3a1 1 0 0 1-1.42 1.4l-4-4a1 1 0 0 1 0-1.4l4-4a1 1 0 0 1 1.42 0z"/></svg>
      {{ jumpBack.label }}
    </button>

    <!-- 阅读模式: 自动翻页 / 打字机 -->
    <ReadingModePanel
      v-if="modes.panelOpen.value"
      :modes="modes"
      :progress="typewriterProgress"
      :auto-reading="autoReading"
      :tts-active="ttsState === 'playing'"
      v-model:auto-read-seconds="settings.autoReadSeconds"
      @start-auto="startAutoRead"
      @stop-auto="stopAutoRead"
      @open-tts="openTTSPanel"
      @close="modes.closePanel()"
    >
      <template #top>
        <DianjingToggle :dj="dj" @open-settings="router.push('/settings')" @open-outline="dj.openOutline()" @open-skim="dj.openSkim()" />
      </template>
    </ReadingModePanel>
    <ReadingModeMini :modes="modes" :bars-visible="barsVisible" :progress="typewriterProgress" />
    <ReadingModeLayer :modes="modes" :bars-visible="barsVisible" :suggest-eink="modes.einkSuggested.value" />

    <!-- 点睛阅读: 首次同意 / 解释卡 / 章首要义 / 脉络 / 速读 / 状态 -->
    <DianjingConsent v-if="dj.consentOpen.value" :dj="dj" />
    <DianjingCard v-if="dj.card.value" :dj="dj" />
    <DianjingChapterCard v-if="dj.chapterCard.value" :dj="dj" />
    <DianjingOutline v-if="dj.outlineOpen.value" :dj="dj" />
    <DianjingSkim v-if="dj.skimOpen.value" :dj="dj" />
    <DianjingStatus :dj="dj" @open-settings="router.push('/settings')" />

    <!-- 高亮选区浮条 -->
    <div v-if="selection" class="highlight-bar card">
      <span class="hl-hint">{{ t('reader.highlight') }}</span>
      <button
        v-for="(hex, name) in HIGHLIGHT_COLORS"
        :key="name"
        class="hl-color"
        :style="{ background: hex }"
        @click="addHighlight(name as string)"
      />
      <button class="btn btn-sm" @click="addHighlight('yellow', true)"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H10l-4.3 3.4A1 1 0 0 1 4 19.6V6a2 2 0 0 1 1-2zm1 2v11.5L9.3 15H19V6H6zm2 2.5h8a1 1 0 1 1 0 2H8a1 1 0 1 1 0-2zm0 3h5a1 1 0 1 1 0 2H8a1 1 0 1 1 0-2z"/></svg>{{ t('reader.writeNote') }}</button>
      <button class="btn btn-sm" @click="aiExplainSelection"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M10 3a1 1 0 0 1 .95.68l1.3 3.9a3 3 0 0 0 1.9 1.9l3.9 1.3a1 1 0 0 1 0 1.9l-3.9 1.3a3 3 0 0 0-1.9 1.9l-1.3 3.9a1 1 0 0 1-1.9 0l-1.3-3.9a3 3 0 0 0-1.9-1.9l-3.9-1.3a1 1 0 0 1 0-1.9l3.9-1.3a3 3 0 0 0 1.9-1.9l1.3-3.9A1 1 0 0 1 10 3zm8-1a1 1 0 0 1 .95.68l.4 1.2.97.32a1 1 0 0 1 0 1.9l-.97.32-.4 1.2a1 1 0 0 1-1.9 0l-.4-1.2-.97-.32a1 1 0 0 1 0-1.9l.97-.32.4-1.2A1 1 0 0 1 18 2z"/></svg>{{ t('ai.explain') }}</button>
      <button v-if="dj.selectionKey.value" class="btn btn-sm" @click="dj.openKeyCard(); selection = null">{{ t('dianjing.why') }}</button>
      <button v-if="!fixedLayout" class="btn btn-sm" @click="listenFromSelection"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M12 3a7 7 0 0 0-7 7v1.1A3.5 3.5 0 0 0 3 14.5v2A3.5 3.5 0 0 0 6.5 20H8a1 1 0 0 0 1-1v-7a1 1 0 0 0-1-1h-.9A5 5 0 0 1 12 5a5 5 0 0 1 4.9 6H16a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h1.5a3.5 3.5 0 0 0 3.5-3.5v-2a3.5 3.5 0 0 0-2-3.16V10a7 7 0 0 0-7-7z"/></svg>{{ t('tts.listenFromSelection') }}</button>
      <button class="icon-btn" :title="t('common.cancel')" :aria-label="t('common.cancel')" @click="selection = null"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M6.3 6.3a1 1 0 0 1 1.4 0L12 10.58l4.3-4.3a1 1 0 1 1 1.4 1.42L13.42 12l4.3 4.3a1 1 0 0 1-1.42 1.4L12 13.42l-4.3 4.3a1 1 0 0 1-1.4-1.42L10.58 12l-4.3-4.3a1 1 0 0 1 0-1.4z"/></svg></button>
    </div>

    <!-- 标注详情 / 想法编辑浮层 -->
    <div v-if="activeAnnotation" class="annotation-pop card">
      <p class="quote">{{ activeAnnotation.text }}</p>
      <textarea
        v-model="noteDraft"
        class="note-input"
        rows="3"
        :placeholder="t('reader.notePlaceholder')"
      />
      <div class="pop-actions">
        <button class="btn btn-sm btn-danger" @click="removeAnnotation(activeAnnotation)">{{ t('reader.deleteHighlight') }}</button>
        <span style="flex: 1" />
        <button class="btn btn-sm" @click="activeAnnotation = null">{{ t('common.cancel') }}</button>
        <button class="btn btn-sm btn-primary" @click="saveNote">{{ t('reader.saveNote') }}</button>
      </div>
    </div>

    <!-- 听书迷你胶囊: 面板收起但会话未停止时显示 -->
    <div
      v-if="ttsMiniFloating"
      ref="miniEl"
      class="tts-mini card"
      :class="{ placed: !!miniPos }"
      :style="miniStyle"
      :title="t('tts.miniHint')"
      role="button"
      tabindex="0"
      :aria-label="t('tts.expandPanel')"
      @pointerdown="onMiniDown"
      @pointermove="onMiniMove"
      @pointerup="onMiniUp"
      @pointercancel="miniDrag = null"
      @dblclick="resetMiniPos"
      @keydown.enter.prevent="ttsPanel = true"
    >
      <span class="tts-mini-dot" :class="{ paused: ttsState === 'paused' }" />
      <span class="tts-mini-label">
        <template v-if="ttsBuffering">{{ t('tts.buffering') }}</template>
        <template v-else>{{ ttsState === 'playing' ? t('tts.reading') : t('tts.paused') }}<template v-if="listenEta"> · <span class="tts-mini-eta">{{ chapterEtaText }}</span></template></template>
      </span>
      <button
        class="tts-mini-btn"
        :title="ttsState === 'playing' ? t('common.pause') : t('common.resume')"
        :aria-label="ttsState === 'playing' ? t('common.pause') : t('common.resume')"
        @pointerdown.stop
        @click.stop="ttsState === 'playing' ? pauseTTS() : resumeTTS()"
      >
        <template v-if="ttsState === 'playing'"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 5a1.5 1.5 0 0 1 1.5 1.5v11a1.5 1.5 0 0 1-3 0v-11A1.5 1.5 0 0 1 8 5zm8 0a1.5 1.5 0 0 1 1.5 1.5v11a1.5 1.5 0 0 1-3 0v-11A1.5 1.5 0 0 1 16 5z"/></svg></template>
        <template v-else><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8.5 5.2a1 1 0 0 1 1.02.03l9 5.95a1 1 0 0 1 0 1.66l-9 5.95A1 1 0 0 1 8 17.95V6.05a1 1 0 0 1 .5-.85z"/></svg></template>
      </button>
      <button v-if="listenDetached" class="tts-mini-btn" :title="t('tts.backToListening')" :aria-label="t('tts.backToListening')" @pointerdown.stop @click.stop="returnToListening"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M12 2a1 1 0 0 1 1 1v1.06A8 8 0 0 1 19.94 11H21a1 1 0 1 1 0 2h-1.06A8 8 0 0 1 13 19.94V21a1 1 0 1 1-2 0v-1.06A8 8 0 0 1 4.06 13H3a1 1 0 1 1 0-2h1.06A8 8 0 0 1 11 4.06V3a1 1 0 0 1 1-1zm0 4a6 6 0 1 0 0 12 6 6 0 0 0 0-12zm0 3a3 3 0 1 1 0 6 3 3 0 0 1 0-6z"/></svg></button>
      <button class="tts-mini-btn" :title="t('common.stop')" :aria-label="t('common.stop')" @pointerdown.stop @click.stop="stopTTS()"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor"/></svg></button>
    </div>

    <!-- 背景音 -->
    <AmbientPanel
      v-if="ambientPanel"
      :tts-active="ttsState === 'playing'"
      @close="ambientPanel = false"
      @show-sources="showAmbientSources"
    />

    <!-- 听书面板 -->
    <div v-if="ttsPanel" class="tts-panel card" role="dialog" :aria-label="t('tts.title')">
      <div class="tts-head">
        <strong>{{ t('tts.title') }}</strong>
        <span v-if="ttsBuffering" class="tts-buffering">{{ t('tts.buffering') }}</span>
        <span v-else-if="sleepText" class="tts-sleep-badge">{{ sleepText }}</span>
        <span style="flex: 1" />
        <button v-if="ttsState !== 'stopped'" class="btn btn-sm" @click="stopTTS"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor"/></svg>{{ t('common.stop') }}</button>
        <button class="icon-btn" :title="t('tts.collapseHint')" :aria-label="t('tts.collapse')" @click="ttsPanel = false"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M5.3 8.3a1 1 0 0 1 1.4 0L12 13.6l5.3-5.3a1 1 0 1 1 1.4 1.4l-6 6a1 1 0 0 1-1.4 0l-6-6a1 1 0 0 1 0-1.4z"/></svg></button>
      </div>
      <!-- 听到哪了、还要多久 -->
      <div v-if="listenEta" class="tts-progress">
        <div class="tts-progress-head">
          <span class="tts-progress-chapter">{{ chapterLabel || meta?.title }}</span>
          <span class="tts-progress-eta">{{ chapterEtaText }}</span>
        </div>
        <div
          class="tts-progress-track"
          role="progressbar"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="Math.round((chapterProgress ?? fraction) * 100)"
          :aria-label="chapterProgress != null ? t('tts.chapterProgress') : t('reader.progress')"
        >
          <span :style="{ transform: `scaleX(${(chapterProgress ?? fraction)})` }" />
        </div>
        <div class="tts-progress-sub">
          <span>{{ chapterFinishText }}</span>
          <span :title="bookFinishText">{{ t('tts.bookSummary', { pct: percentText, time: listenEta ? humanTime(listenEta.book) : '' }) }}</span>
        </div>
        <p v-if="!pace.samples" class="tts-progress-hint">{{ t('tts.etaLearning') }}</p>
      </div>

      <!-- 离线合成跟不上: 推荐在线模型 -->
      <div v-if="localTooSlow && settings.ttsEngine === 'local'" class="tts-notice">
        <span class="tts-notice-text">{{ t('tts.localSlow') }}</span>
        <button class="btn btn-sm btn-primary" @click="switchToOnline">{{ t('tts.switchToOnline') }}</button>
      </div>
      <!-- 朗读中翻到了别处 -->
      <div v-if="listenDetached && ttsState !== 'stopped'" class="tts-notice">
        <span class="tts-notice-text">{{ t('tts.detached') }}</span>
        <button class="btn btn-sm" @click="returnToListening"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M12 2a1 1 0 0 1 1 1v1.06A8 8 0 0 1 19.94 11H21a1 1 0 1 1 0 2h-1.06A8 8 0 0 1 13 19.94V21a1 1 0 1 1-2 0v-1.06A8 8 0 0 1 4.06 13H3a1 1 0 1 1 0-2h1.06A8 8 0 0 1 11 4.06V3a1 1 0 0 1 1-1zm0 4a6 6 0 1 0 0 12 6 6 0 0 0 0-12zm0 3a3 3 0 1 1 0 6 3 3 0 0 1 0-6z"/></svg>{{ t('tts.backToListening') }}</button>
        <button class="btn btn-sm btn-primary" @click="listenFromHere">{{ t('tts.listenFromHere') }}</button>
      </div>
      <!-- 断点续读 -->
      <div v-else-if="ttsState === 'stopped' && listenBookmark && !bookmarkOnPage" class="tts-notice">
        <span class="tts-notice-text">
          <strong>{{ t('tts.lastListened') }}</strong> {{ listenBookmark.chapter }} · {{ bookmarkAgo }}
          <span class="tts-snippet">「{{ listenBookmark.snippet }}…」</span>
        </span>
        <button class="btn btn-sm btn-primary" @click="startTTS('bookmark')">{{ t('tts.resumeListening') }}</button>
      </div>

      <!-- 走带: 上一段 / 上一句 / 播放 / 下一句 / 下一段 -->
      <div class="tts-transport">
        <button class="tts-skip" :disabled="ttsState === 'stopped'" :title="t('tts.prevParagraph')" @click="skipListen('paragraph', -1)"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M6 5a1 1 0 0 1 1 1v12a1 1 0 1 1-2 0V6a1 1 0 0 1 1-1zm12.4.62v12.76a.8.8 0 0 1-1.22.68l-8.3-5.13a1.08 1.08 0 0 1 0-1.86l8.3-5.13a.8.8 0 0 1 1.22.68z"/></svg><span>{{ t('tts.prevParagraph') }}</span></button>
        <button class="tts-skip" :disabled="ttsState === 'stopped'" :title="t('tts.prevSentence')" @click="skipListen('sentence', -1)"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M11 6.6v10.8a.8.8 0 0 1-1.28.64l-6.9-5.4a.8.8 0 0 1 0-1.28l6.9-5.4A.8.8 0 0 1 11 6.6zm9.5 0v10.8a.8.8 0 0 1-1.28.64l-6.9-5.4a.8.8 0 0 1 0-1.28l6.9-5.4a.8.8 0 0 1 1.28.64z"/></svg><span>{{ t('tts.prevSentence') }}</span></button>
        <button
          class="tts-play"
          :title="ttsState === 'playing' ? t('common.pause') : ttsState === 'paused' ? t('common.resume') : t('tts.startReading')"
          :aria-label="ttsState === 'playing' ? t('common.pause') : ttsState === 'paused' ? t('common.resume') : t('tts.startReading')"
          @click="ttsState === 'playing' ? pauseTTS() : ttsState === 'paused' ? resumeTTS() : startTTS()"
        >
          <template v-if="ttsState === 'playing'"><svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path fill="currentColor" d="M8 5a1.5 1.5 0 0 1 1.5 1.5v11a1.5 1.5 0 0 1-3 0v-11A1.5 1.5 0 0 1 8 5zm8 0a1.5 1.5 0 0 1 1.5 1.5v11a1.5 1.5 0 0 1-3 0v-11A1.5 1.5 0 0 1 16 5z"/></svg></template>
          <template v-else><svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path fill="currentColor" d="M8.5 5.2a1 1 0 0 1 1.02.03l9 5.95a1 1 0 0 1 0 1.66l-9 5.95A1 1 0 0 1 8 17.95V6.05a1 1 0 0 1 .5-.85z"/></svg></template>
        </button>
        <button class="tts-skip" :disabled="ttsState === 'stopped'" :title="t('tts.nextSentence')" @click="skipListen('sentence', 1)"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M13 6.6v10.8a.8.8 0 0 0 1.28.64l6.9-5.4a.8.8 0 0 0 0-1.28l-6.9-5.4A.8.8 0 0 0 13 6.6zm-9.5 0v10.8a.8.8 0 0 0 1.28.64l6.9-5.4a.8.8 0 0 0 0-1.28l-6.9-5.4A.8.8 0 0 0 3.5 6.6z"/></svg><span>{{ t('tts.nextSentence') }}</span></button>
        <button class="tts-skip" :disabled="ttsState === 'stopped'" :title="t('tts.nextParagraph')" @click="skipListen('paragraph', 1)"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M18 5a1 1 0 0 1 1 1v12a1 1 0 1 1-2 0V6a1 1 0 0 1 1-1zM5.6 5.62v12.76a.8.8 0 0 0 1.22.68l8.3-5.13a1.08 1.08 0 0 0 0-1.86l-8.3-5.13a.8.8 0 0 0-1.22.68z"/></svg><span>{{ t('tts.nextParagraph') }}</span></button>
      </div>
      <p v-if="ttsState === 'stopped'" class="tts-start-hint">
        {{ bookmarkOnPage ? t('tts.startFromBookmark') : t('tts.startFromPage') }} · {{ t('tts.selectHint') }}
      </p>

      <div class="tts-row">
        <label>{{ t('tts.rate') }}</label>
        <input v-model.number="settings.ttsRate" type="range" min="0.5" max="2" step="0.1" :aria-label="t('tts.rate')" />
        <span class="tts-value">{{ settings.ttsRate.toFixed(1) }}x</span>
      </div>
      <div class="tts-row">
        <label>{{ t('tts.sleep') }}</label>
        <div class="seg" style="flex: 1">
          <button :class="{ active: sleepMode === 0 }" @click="setSleep(0)">{{ t('tts.sleepOff') }}</button>
          <button v-for="m in ([15, 30, 60, 90] as const)" :key="m" :class="{ active: sleepMode === m }" @click="setSleep(m)">{{ m }}</button>
          <button :class="{ active: sleepMode === 'chapter' }" @click="setSleep('chapter')">{{ t('tts.sleepChapter') }}</button>
        </div>
      </div>
      <div v-if="edgeAvailable()" class="tts-row">
        <label>{{ t('tts.engine') }}</label>
        <div class="seg" style="flex: 1">
          <button :class="{ active: settings.ttsEngine === 'edge' }" @click="settings.ttsEngine = 'edge'; resetEdgeFailure()">{{ t('tts.engineEdge') }}</button>
          <button :class="{ active: settings.ttsEngine === 'local' }" :title="t('tts.engineLocalTitle')" @click="settings.ttsEngine = 'local'; resetEdgeFailure(); refreshLocalStatus()">{{ t('tts.engineLocal') }}</button>
          <button :class="{ active: settings.ttsEngine === 'system' }" @click="settings.ttsEngine = 'system'">{{ t('tts.engineSystem') }}</button>
        </div>
      </div>
      <div v-if="edgeAvailable() && settings.ttsEngine === 'edge'" class="tts-row">
        <label>{{ t('tts.voice') }}</label>
        <select v-model="settings.edgeVoice" class="input" :aria-label="t('tts.voice')">
          <option v-for="v in EDGE_VOICES" :key="v.id" :value="v.id">{{ v.label }}</option>
        </select>
      </div>
      <div v-else-if="edgeAvailable() && settings.ttsEngine === 'local'" class="tts-row">
        <label>{{ t('tts.voice') }}</label>
        <template v-if="localInstalled">
          <select v-model.number="settings.localVoiceId" class="input" :aria-label="t('tts.voice')">
            <option v-for="v in KOKORO_VOICES" :key="v.sid" :value="v.sid">{{ kokoroVoiceLabel(v, settings.language === 'en' ? 'en' : 'zh') }}{{ v.sid === DEFAULT_KOKORO_SID ? t('tts.voiceDefault') : '' }}</option>
          </select>
          <button class="btn btn-sm" :disabled="ttsState !== 'stopped'" @click="auditionLocal">{{ t('tts.audition') }}</button>
        </template>
        <LocalTtsPack v-else />
      </div>
      <div v-else class="tts-row">
        <label>{{ t('tts.voice') }}</label>
        <select v-model="settings.ttsVoice" class="input" :aria-label="t('tts.voice')">
          <option value="">{{ t('tts.autoVoice') }}</option>
          <option v-for="v in ttsVoices" :key="v.name" :value="v.name">{{ v.name }} ({{ v.lang }})</option>
        </select>
      </div>
      <p class="tts-hint">
        {{ !edgeAvailable() ? t('tts.hintSystem') : settings.ttsEngine === 'edge' ? t('tts.hintEdge') : settings.ttsEngine === 'local' ? t('tts.hintLocal') : t('tts.hintSystem') }}
        {{ t('tts.hintApply') }}
      </p>
    </div>

    <!-- 侧栏面板 -->
    <aside v-if="panel !== 'none'" ref="panelEl" class="panel card">
      <template v-if="panel === 'toc'">
        <h3>{{ t('reader.toc') }}</h3>
        <div class="panel-body">
          <p v-if="tocAuto" class="panel-tip">{{ t('reader.tocAuto') }}</p>
          <TocList :items="toc" :current-href="currentTocHref" @navigate="navigateToc" />
          <p v-if="!toc.length" class="panel-empty">{{ t('reader.noToc') }}</p>
        </div>
      </template>

      <template v-else-if="panel === 'annotations'">
        <div class="anno-tabs">
          <button :class="{ active: annoTab === 'highlight' }" @click="annoTab = 'highlight'">
            {{ t('reader.highlightsTab') }} ({{ highlights.length }})
          </button>
          <button :class="{ active: annoTab === 'bookmark' }" @click="annoTab = 'bookmark'">
            {{ t('reader.bookmarksTab') }} ({{ bookmarks.length }})
          </button>
        </div>
        <div class="panel-body">
          <template v-if="annoTab === 'highlight'">
            <div v-for="a in highlights" :key="a.id" class="anno-item" @click="gotoAnnotation(a)">
              <span class="anno-dot" :style="{ background: HIGHLIGHT_COLORS[a.color] ?? a.color }" />
              <span class="anno-body">
                <span class="anno-text">{{ a.text }}</span>
                <span v-if="a.note" class="anno-note"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H10l-4.3 3.4A1 1 0 0 1 4 19.6V6a2 2 0 0 1 1-2zm1 2v11.5L9.3 15H19V6H6zm2 2.5h8a1 1 0 1 1 0 2H8a1 1 0 1 1 0-2zm0 3h5a1 1 0 1 1 0 2H8a1 1 0 1 1 0-2z"/></svg>{{ a.note }}</span>
              </span>
            </div>
            <p v-if="!highlights.length" class="panel-empty">{{ t('reader.highlightEmptyHint') }}</p>
          </template>
          <template v-else>
            <div v-for="a in bookmarks" :key="a.id" class="anno-item" @click="gotoAnnotation(a)">
              <svg viewBox="0 0 24 24" width="14" height="14" style="flex-shrink: 0; margin-top: 3px"><path fill="var(--brand)" d="M6 3h12a1 1 0 0 1 1 1v16.2a.8.8 0 0 1-1.24.67L12 17.6l-5.76 3.27A.8.8 0 0 1 5 20.2V4a1 1 0 0 1 1-1z"/></svg>
              <span class="anno-body">
                <span class="anno-text">{{ a.text }}</span>
              </span>
              <button class="icon-btn anno-del" :title="t('common.delete')" :aria-label="t('common.delete')" @click.stop="removeAnnotation(a)"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M6.3 6.3a1 1 0 0 1 1.4 0L12 10.58l4.3-4.3a1 1 0 1 1 1.4 1.42L13.42 12l4.3 4.3a1 1 0 0 1-1.42 1.4L12 13.42l-4.3 4.3a1 1 0 0 1-1.4-1.42L10.58 12l-4.3-4.3a1 1 0 0 1 0-1.4z"/></svg></button>
            </div>
            <p v-if="!bookmarks.length" class="panel-empty">{{ t('reader.bookmarkEmptyHint') }}</p>
          </template>
        </div>
      </template>

      <template v-else-if="panel === 'ai'">
        <h3 class="ai-title"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M10 3a1 1 0 0 1 .95.68l1.3 3.9a3 3 0 0 0 1.9 1.9l3.9 1.3a1 1 0 0 1 0 1.9l-3.9 1.3a3 3 0 0 0-1.9 1.9l-1.3 3.9a1 1 0 0 1-1.9 0l-1.3-3.9a3 3 0 0 0-1.9-1.9l-3.9-1.3a1 1 0 0 1 0-1.9l3.9-1.3a3 3 0 0 0 1.9-1.9l1.3-3.9A1 1 0 0 1 10 3zm8-1a1 1 0 0 1 .95.68l.4 1.2.97.32a1 1 0 0 1 0 1.9l-.97.32-.4 1.2a1 1 0 0 1-1.9 0l-.4-1.2-.97-.32a1 1 0 0 1 0-1.9l.97-.32.4-1.2A1 1 0 0 1 18 2z"/></svg>{{ t('ai.title') }}</h3>
        <div v-if="!aiReady()" class="ai-setup">
          <p>{{ t('ai.setupHint') }}</p>
          <ol class="ai-steps">
            <li>{{ t('ai.step1') }}</li>
            <li>{{ t('ai.step2') }}</li>
            <li>{{ t('ai.step3') }}</li>
          </ol>
          <div class="ai-setup-actions">
            <button class="btn btn-sm btn-primary" @click="useTrialAi">{{ t('ai.useTrial') }}</button>
            <button class="btn btn-sm" @click="openRegister">{{ t('ai.register') }}</button>
            <button class="btn btn-sm" @click="router.push('/settings')">{{ t('ai.goSettings') }}</button>
          </div>
          <p class="ai-setup-alt">{{ t('ai.setupAlt') }}</p>
        </div>
        <template v-else>
          <div ref="aiListEl" class="panel-body ai-list">
            <p v-if="!aiMessages.length" class="panel-empty">{{ t('ai.intro') }}</p>
            <div v-for="(m, i) in aiMessages" :key="i" class="ai-msg" :class="m.role">
              <div class="ai-bubble">{{ m.content }}<span v-if="m.role === 'assistant' && aiStreaming && i === aiMessages.length - 1" class="ai-cursor">▍</span></div>
            </div>
          </div>
          <div class="ai-input-row">
            <input
              v-model="aiInput"
              class="input"
              :placeholder="t('ai.placeholder')"
              :disabled="aiStreaming"
              @keyup.enter="sendAi()"
            />
            <button v-if="aiStreaming" class="btn btn-sm" @click="stopAi">{{ t('common.stop') }}</button>
            <button v-else class="btn btn-sm btn-primary" :disabled="!aiInput.trim()" @click="sendAi()">{{ t('ai.send') }}</button>
          </div>
          <button v-if="aiMessages.length" class="btn btn-sm ai-clear" @click="clearAi">{{ t('ai.clear') }}</button>
        </template>
      </template>

      <template v-else>
        <h3>{{ t('reader.searchInBook') }}</h3>
        <form class="search-form" @submit.prevent="runSearch">
          <input v-model="searchQuery" class="input" type="search" :placeholder="t('reader.searchPlaceholder')" />
        </form>
        <div class="search-opts">
          <button type="button" class="search-opt" :class="{ active: searchOpts.caseSensitive }" :title="t('reader.matchCase')" @click="toggleSearchOpt('caseSensitive')">Aa</button>
          <button type="button" class="search-opt" :class="{ active: searchOpts.wholeWord }" :title="t('reader.wholeWord')" @click="toggleSearchOpt('wholeWord')">\b</button>
          <button type="button" class="search-opt" :class="{ active: searchOpts.regex }" :title="t('reader.useRegex')" @click="toggleSearchOpt('regex')">.*</button>
          <span v-if="searching" class="search-count">{{ Math.round(searchProgress * 100) }}%</span>
          <span v-else-if="searchQuery && searchResults.length" class="search-count">
            {{ t('reader.resultCount', { n: searchResults.length }) }}{{ searchTruncated ? '+' : '' }}
          </span>
        </div>
        <div class="panel-body">
          <template v-for="(r, i) in searchResults" :key="i">
            <div
              v-if="i === 0 || r.chapter !== searchResults[i - 1].chapter"
              class="search-chapter"
            >{{ r.chapter || '·' }}</div>
            <div class="search-item" @click="gotoSearchHit(r)"><template v-for="(seg, j) in r.segments" :key="j"><mark v-if="seg.hit">{{ seg.text }}</mark><template v-else>{{ seg.text }}</template></template></div>
          </template>
          <p v-if="!searching && searchQuery && !searchResults.length" class="panel-empty">{{ t('reader.noResults') }}</p>
        </div>
        <button class="btn btn-sm" style="margin-top: 8px" @click="closeSearch">{{ t('reader.clearAndClose') }}</button>
      </template>
    </aside>

    <!-- 排版设置浮层 -->
    <div v-if="settingsOpen" class="settings-pop card">
      <div class="set-row">
        <label>{{ t('reader.fontSize') }}</label>
        <button class="step-btn" :title="t('reader.fontSmaller')" :aria-label="t('reader.fontSmaller')" @click="setFontSize(String(settings.reader.fontSize - 1))">A−</button>
        <input v-model.number="settings.reader.fontSize" type="range" min="8" max="64" step="1" :aria-label="t('reader.fontSize')" />
        <button class="step-btn big" :title="t('reader.fontLarger')" :aria-label="t('reader.fontLarger')" @click="setFontSize(String(settings.reader.fontSize + 1))">A+</button>
        <input
          class="input set-num"
          type="number"
          min="8"
          max="64"
          step="1"
          :value="settings.reader.fontSize"
          @change="setFontSize(($event.target as HTMLInputElement).value)"
        />
      </div>
      <div class="set-row">
        <label>{{ t('reader.lineHeight') }}</label>
        <input v-model.number="settings.reader.lineHeight" type="range" min="1.2" max="2.6" step="0.1" />
        <span>{{ settings.reader.lineHeight.toFixed(1) }}</span>
      </div>
      <div class="set-row">
        <label>{{ t('reader.margin') }}</label>
        <input v-model.number="settings.reader.gap" type="range" min="2" max="16" step="1" />
        <span>{{ settings.reader.gap }}%</span>
      </div>
      <div class="set-row">
        <label>{{ t('reader.font') }}</label>
        <select v-model="settings.reader.fontFamily" class="input">
          <option v-for="f in FONT_FAMILIES" :key="f.labelKey" :value="f.value">{{ t(f.labelKey) }}</option>
          <optgroup v-if="settings.customFonts.length" :label="t('reader.customFonts')">
            <option v-for="f in settings.customFonts" :key="f.file" :value="`custom:${f.name}`">{{ f.name }}</option>
          </optgroup>
          <optgroup v-if="systemFonts.length" :label="t('reader.systemFonts')">
            <option v-for="name in systemFonts" :key="name" :value="`&quot;${name}&quot;`">{{ name }}</option>
          </optgroup>
        </select>
      </div>
      <div v-if="isTauri()" class="set-row">
        <label></label>
        <button class="btn btn-sm" @click="importFont">{{ t('reader.importFont') }}</button>
        <span class="font-hint">ttf / otf / woff2</span>
      </div>
      <div class="set-row">
        <label>{{ t('reader.theme') }}</label>
        <div class="theme-btns">
          <button
            v-for="choice in READER_THEME_CHOICES"
            :key="choice.name"
            class="theme-btn"
            :class="{ active: settings.reader.theme === choice.name }"
            :style="{ background: choice.bg, color: choice.fg }"
            :title="themeLabel(choice.name)"
            :aria-label="themeLabel(choice.name)"
            @click="settings.reader.theme = choice.name"
          >{{ t('reader.themeSample') }}</button>
        </div>
      </div>
      <div class="set-row">
        <label>{{ t('reader.mode') }}</label>
        <div class="seg">
          <button :class="{ active: settings.reader.flow === 'paginated' }" @click="settings.reader.flow = 'paginated'">{{ t('reader.paginated') }}</button>
          <button :class="{ active: settings.reader.flow === 'scrolled' }" @click="settings.reader.flow = 'scrolled'">{{ t('reader.scrolled') }}</button>
        </div>
      </div>
      <div class="set-row">
        <label>{{ t('reader.columns') }}</label>
        <div class="seg">
          <button :class="{ active: settings.reader.maxColumnCount === 1 }" @click="settings.reader.maxColumnCount = 1">{{ t('reader.singleColumn') }}</button>
          <button :class="{ active: settings.reader.maxColumnCount === 2 }" @click="settings.reader.maxColumnCount = 2">{{ t('reader.autoTwoColumns') }}</button>
        </div>
      </div>
      <div class="set-row">
        <label>{{ t('reader.progressDisplay') }}</label>
        <div class="seg">
          <button :class="{ active: settings.reader.progressDisplay === 'both' }" @click="settings.reader.progressDisplay = 'both'">{{ t('reader.progressBoth') }}</button>
          <button :class="{ active: settings.reader.progressDisplay === 'page' }" @click="settings.reader.progressDisplay = 'page'">{{ t('reader.progressPage') }}</button>
          <button :class="{ active: settings.reader.progressDisplay === 'percent' }" @click="settings.reader.progressDisplay = 'percent'">{{ t('reader.progressPercent') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.reader {
  /* 底栏高度: 浮层 (自动阅读 / 听书胶囊) 在工具栏显示时让到它上方 */
  --footer-h: 50px;
  --safe-top: var(--lr-safe-top);
  --safe-bottom: var(--lr-safe-bottom);
  position: relative;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.bar {
  position: absolute;
  left: 0;
  right: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px max(14px, var(--lr-safe-right)) 8px max(14px, var(--lr-safe-left));
  background: color-mix(in srgb, var(--card) 86%, transparent);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--border);
  transition: transform 0.25s, opacity 0.25s;
  color: var(--text);
}
/* 全屏时的悬浮退出按钮: 平时低调, 悬停清晰 */
.fs-exit {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 12;
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 50%;
  background: color-mix(in srgb, var(--card) 70%, transparent);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  color: var(--text-3);
  opacity: 0.45;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: opacity 0.2s;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12);
}
.fs-exit:hover {
  opacity: 1;
  color: var(--text);
}
/* 工具栏隐藏时的边缘呼出热区 */
.bar-peek {
  position: absolute;
  left: 0;
  right: 0;
  height: 14px;
  z-index: 9;
}
.bar-peek.top {
  top: 0;
}
.bar-peek.bottom {
  bottom: 0;
}
.bar.top {
  top: 0;
  padding-top: calc(8px + var(--safe-top));
}
.bar.bottom {
  bottom: 0;
  top: auto;
  flex-direction: column;
  align-items: stretch;
  gap: 2px;
  padding-top: 6px;
  padding-bottom: calc(6px + var(--safe-bottom));
  border-bottom: none;
  border-top: 1px solid var(--border);
}
.progress-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
/* 手机端底部入口, 桌面端这些都在顶栏 */
.dock {
  display: none;
}
.book-title {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 10px;
  overflow: hidden;
}
.book-title strong {
  font-size: 14px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.chapter {
  font-size: 12px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bar-actions {
  display: flex;
  gap: 4px;
}
.icon-btn {
  width: 32px;
  height: 32px;
  border: none;
  background: none;
  border-radius: 6px;
  color: var(--text-2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.icon-btn:hover {
  background: var(--bg);
  color: var(--brand);
}
/* 正文让出状态栏 / 手势条 / 横屏刘海; 阅读背景仍铺满整屏 */
.content {
  flex: 1;
  height: 100%;
  padding: var(--safe-top) var(--lr-safe-right) var(--safe-bottom) var(--lr-safe-left);
}
.state {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
}
.nav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  z-index: 5;
  width: 40px;
  height: 72px;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: transparent;
  transition: all 0.2s;
}
.reader:hover .nav {
  color: var(--text-3);
}
.nav:hover {
  background: rgba(29, 33, 41, 0.08);
  color: var(--text) !important;
}
.nav.prev {
  left: 6px;
}
.nav.next {
  right: 6px;
}
.slider {
  flex: 1;
  accent-color: var(--brand);
}
/* 底栏进度: 页码为主、百分比为辅; 整块可点开跳页 */
.progress-label {
  flex-shrink: 0;
  display: inline-flex;
  align-items: baseline;
  justify-content: flex-end;
  gap: 3px;
  min-width: 48px;
  height: 30px;
  padding: 0 8px;
  border: none;
  border-radius: var(--radius-pill);
  background: none;
  color: var(--text-3);
  font-size: 12px;
  line-height: 30px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.progress-label b {
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
}
.progress-label .sep {
  margin: 0 2px;
}
.progress-label:hover,
.progress-label.active {
  background: var(--brand-soft);
  color: var(--brand);
}
.progress-label:hover b,
.progress-label.active b {
  color: var(--brand);
}
.progress-label:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 1px;
}
.slider-wrap {
  flex: 1;
  min-width: 0;
  position: relative;
  display: flex;
  align-items: center;
}
.slider-wrap .slider {
  width: 100%;
}
/* 拖动进度条时的落点预览 */
.slide-bubble {
  position: absolute;
  bottom: calc(100% + 10px);
  transform: translateX(-50%);
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  max-width: 220px;
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--card);
  box-shadow: var(--shadow-md);
  color: var(--text-2);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  pointer-events: none;
}
.slide-bubble strong {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
}
.jump-pop {
  position: absolute;
  right: max(14px, var(--lr-safe-right));
  bottom: calc(var(--footer-h) + 8px + var(--safe-bottom));
  z-index: 20;
  width: 300px;
  padding: 12px;
  box-shadow: var(--shadow-lg);
}
.jump-form {
  display: flex;
  align-items: center;
  gap: 8px;
}
.jump-input {
  flex: 1;
  min-width: 0;
  font-variant-numeric: tabular-nums;
}
.jump-total {
  flex-shrink: 0;
  color: var(--text-3);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.jump-meta {
  margin: 8px 0 0;
  color: var(--text-2);
  font-size: 12px;
}
.jump-meta.error {
  color: var(--danger);
}
.jump-hint {
  margin: 2px 0 0;
  color: var(--text-3);
  font-size: 11px;
}
.jump-back {
  position: absolute;
  left: max(14px, var(--lr-safe-left));
  bottom: calc(var(--footer-h) + 12px + var(--safe-bottom));
  z-index: 19;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 14px 0 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: var(--card);
  box-shadow: var(--shadow-md);
  color: var(--brand);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.jump-back:hover {
  background: var(--brand-light);
}
.icon-btn.auto-on {
  color: var(--brand);
}
.highlight-bar {
  position: absolute;
  top: calc(56px + var(--safe-top));
  left: 50%;
  transform: translateX(-50%);
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
}
.hl-hint {
  font-size: 13px;
  color: var(--text-2);
}
.hl-color {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2px solid #fff;
  box-shadow: 0 0 0 1px var(--border);
}
.annotation-pop {
  position: absolute;
  bottom: calc(60px + var(--safe-bottom));
  left: 50%;
  transform: translateX(-50%);
  z-index: 20;
  width: min(420px, calc(100% - 40px));
  padding: 14px 16px;
}
.quote {
  font-size: 13px;
  color: var(--text-2);
  max-height: 80px;
  overflow: auto;
  border-left: 3px solid var(--brand);
  padding-left: 10px;
  margin-bottom: 10px;
}
.pop-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
.panel {
  position: absolute;
  top: calc(52px + var(--safe-top));
  right: 12px;
  bottom: calc(50px + var(--safe-bottom));
  z-index: 15;
  width: min(320px, calc(100% - 24px));
  padding: 16px;
  display: flex;
  flex-direction: column;
}
.panel h3 {
  font-size: 14px;
  margin-bottom: 10px;
}
.panel-body {
  flex: 1;
  overflow: auto;
}
.panel-empty {
  color: var(--text-3);
  font-size: 13px;
  padding: 20px 0;
  text-align: center;
}
.panel-tip {
  font-size: 12px;
  color: var(--text-3);
  margin-bottom: 8px;
}
.anno-item {
  display: flex;
  gap: 8px;
  padding: 8px;
  border-radius: 6px;
  cursor: pointer;
  align-items: flex-start;
}
.anno-item:hover {
  background: var(--bg);
}
.anno-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  margin-top: 4px;
  flex-shrink: 0;
}
.anno-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.anno-text {
  font-size: 13px;
  color: var(--text-2);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.anno-note {
  font-size: 12px;
  color: var(--text);
  background: var(--bg);
  border-radius: 6px;
  padding: 6px 8px;
}
.anno-del {
  width: 24px;
  height: 24px;
  font-size: 12px;
  flex-shrink: 0;
}
.anno-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 10px;
}
.anno-tabs button {
  flex: 1;
  height: 30px;
  border: none;
  border-radius: 6px;
  background: none;
  color: var(--text-2);
  font-size: 13px;
}
.anno-tabs button.active {
  background: var(--brand-light);
  color: var(--brand);
  font-weight: 500;
}
.note-input {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 8px 10px;
  font-size: 13px;
  resize: vertical;
  outline: none;
  margin-bottom: 10px;
  font-family: inherit;
}
.note-input:focus {
  border-color: var(--brand);
}
/* 听书胶囊: 默认停在页眉留白 (章节名那一条), 不压正文; 工具栏出现时让到其下方; 拖动后停在用户放的位置 */
.tts-mini {
  --head-band: 48px;
  position: absolute;
  top: calc(var(--safe-top) + (var(--head-band) - 32px) / 2);
  left: 50%;
  transform: translateX(-50%);
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 4px 0 12px;
  border-radius: var(--radius-pill);
  box-shadow: var(--shadow-md);
  cursor: grab;
  user-select: none;
  -webkit-user-select: none;
  touch-action: none;
  white-space: nowrap;
  transition: top 0.25s;
}
.tts-mini:active {
  cursor: grabbing;
}
.tts-mini.placed {
  transform: translate(-50%, -50%);
  transition: none;
}
.tts-mini-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--brand);
  animation: tts-pulse 1.6s ease-in-out infinite;
}
.tts-mini-dot.paused {
  background: var(--text-3);
  animation: none;
}
@keyframes tts-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.75); }
}
.tts-mini-label {
  font-size: 12px;
  color: var(--text-2);
}
.tts-mini-btn {
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 50%;
  background: var(--bg);
  color: var(--text-2);
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.tts-mini-btn:hover {
  background: var(--brand-light);
  color: var(--brand);
}
.tts-mini-eta {
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.ambient-btn {
  position: relative;
}
.ambient-dot {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--brand);
}
.tts-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tts-head strong {
  font-size: 15px;
}
.tts-buffering,
.tts-sleep-badge {
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  background: var(--surface-2);
  color: var(--text-3);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.tts-sleep-badge {
  background: var(--brand-soft);
  color: var(--brand);
}
.tts-notice {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-radius: var(--radius);
  background: var(--surface-2);
  font-size: 12px;
  color: var(--text-2);
}
.tts-notice-text {
  flex: 1 1 160px;
  min-width: 0;
}
.tts-notice-text strong {
  color: var(--text);
}
.tts-snippet {
  display: block;
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-3);
}
/* 走带: 中间大播放键, 两侧跳句 / 跳段, 下方小字说明 */
.tts-transport {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
}
.tts-skip {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  width: 58px;
  padding: 6px 0;
  border: none;
  border-radius: var(--radius);
  background: none;
  color: var(--text-2);
  font-size: 10px;
}
.tts-skip:hover:not(:disabled) {
  background: var(--surface-2);
  color: var(--brand);
}
.tts-skip:disabled {
  opacity: 0.35;
}
.tts-play {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  margin: 0 6px;
  border: none;
  border-radius: 50%;
  background: var(--brand);
  color: var(--on-brand);
  box-shadow: var(--shadow-md);
  transition: transform 0.12s;
}
.tts-play:hover {
  background: var(--brand-hover);
}
.tts-play:active {
  transform: scale(0.95);
}
.tts-start-hint {
  margin: -4px 0 0;
  text-align: center;
  color: var(--text-3);
  font-size: 11px;
}
.tts-progress {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--border);
}
.tts-progress-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.tts-progress-chapter {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-2);
  font-size: 12px;
}
.tts-progress-eta {
  flex-shrink: 0;
  color: var(--text);
  font-size: 15px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.tts-progress-track {
  height: 4px;
  border-radius: var(--radius-pill);
  background: var(--surface-3);
  overflow: hidden;
}
.tts-progress-track span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--brand);
  transform-origin: left center;
  transition: transform 0.4s ease;
}
.tts-progress-sub {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  color: var(--text-3);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.tts-progress-sub span {
  white-space: nowrap;
}
.tts-progress-sub span:last-child {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: right;
}
/* 顶栏里的听书胶囊 */
.tts-chip {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  height: 30px;
  padding: 0 2px 0 4px;
  border-radius: var(--radius-pill);
  background: var(--brand-soft);
}
.tts-chip-main {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 100%;
  padding: 0 6px;
  border: none;
  background: none;
  color: var(--brand);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.tts-chip .tts-mini-btn {
  background: var(--card);
}
.tts-progress-hint {
  margin: 0;
  color: var(--text-3);
  font-size: 11px;
}
.tts-panel {
  position: absolute;
  top: calc(52px + var(--safe-top));
  right: 12px;
  z-index: 25;
  width: min(400px, calc(100% - 24px));
  padding: 14px 16px;
  max-height: calc(100% - 72px - var(--safe-top) - var(--safe-bottom));
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.tts-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.tts-row label {
  font-size: 13px;
  color: var(--text-2);
  width: 32px;
  flex-shrink: 0;
}
.tts-row input[type='range'] {
  flex: 1;
  accent-color: var(--brand);
}
.tts-row .input {
  flex: 1;
  height: 30px;
}
.tts-value {
  font-size: 12px;
  color: var(--text-3);
  width: 36px;
  text-align: right;
}
.tts-hint {
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.6;
}
.ai-setup {
  font-size: 13px;
  color: var(--text-2);
  line-height: 1.8;
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: flex-start;
}
.ai-steps {
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  color: var(--text-2);
}
.ai-setup-actions {
  display: flex;
  gap: 8px;
}
.ai-setup-alt {
  font-size: 12px;
  color: var(--text-3);
}
.ai-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-right: 2px;
}
.ai-msg {
  display: flex;
}
.ai-msg.user {
  justify-content: flex-end;
}
.ai-bubble {
  max-width: 92%;
  padding: 8px 10px;
  border-radius: 10px;
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}
.ai-msg.user .ai-bubble {
  background: var(--brand-light);
  color: var(--text);
}
.ai-msg.assistant .ai-bubble {
  background: var(--bg);
  color: var(--text-2);
}
.ai-cursor {
  color: var(--brand);
  animation: tts-pulse 1s ease-in-out infinite;
}
.ai-input-row {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}
.ai-input-row .input {
  flex: 1;
  min-width: 0;
}
.ai-clear {
  margin-top: 6px;
}
.search-form {
  margin-bottom: 8px;
}
.search-opts {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}
.search-opt {
  height: 24px;
  min-width: 30px;
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--card);
  color: var(--text-3);
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.search-opt.active {
  background: var(--brand-light);
  border-color: var(--brand);
  color: var(--brand);
}
.search-count {
  margin-left: auto;
  font-size: 12px;
  color: var(--text-3);
}
.search-chapter {
  position: sticky;
  top: 0;
  background: var(--card);
  font-size: 12px;
  font-weight: 500;
  color: var(--text-2);
  padding: 6px 8px 4px;
  border-bottom: 1px solid var(--border);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.search-form .input {
  width: 100%;
}
.search-item {
  font-size: 13px;
  color: var(--text-2);
  padding: 8px;
  border-radius: 6px;
  cursor: pointer;
  line-height: 1.6;
}
.search-item:hover {
  background: var(--bg);
}
.search-item mark {
  background: #ffe58f;
  border-radius: 2px;
}
.settings-pop {
  position: absolute;
  top: calc(52px + var(--safe-top));
  right: 12px;
  z-index: 25;
  width: 300px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.set-row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}
.set-row label {
  width: 32px;
  color: var(--text-2);
  flex-shrink: 0;
}
.set-row input[type='range'] {
  flex: 1;
  accent-color: var(--brand);
}
.set-row span {
  width: 42px;
  text-align: right;
  color: var(--text-3);
  font-size: 12px;
}
.set-num {
  width: 58px !important;
  flex: none !important;
  height: 26px;
  font-size: 12px;
  text-align: center;
  padding: 0 4px;
}
.set-row .input {
  flex: 1;
  height: 30px;
}
.font-hint {
  font-size: 12px;
  color: var(--text-3);
  width: auto !important;
}
.theme-btns {
  display: flex;
  gap: 8px;
}
.theme-btn {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: 2px solid var(--border);
  font-size: 14px;
}
.theme-btn.active {
  border-color: var(--brand);
}
.seg {
  display: flex;
  flex: 1;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}
.seg button {
  flex: 1;
  height: 30px;
  border: none;
  background: var(--card);
  color: var(--text-2);
  font-size: 13px;
}
.seg button.active {
  background: var(--brand-light);
  color: var(--brand);
  font-weight: 500;
}
.bar.hidden {
  opacity: 0;
  pointer-events: none;
}
.bar.top.hidden {
  transform: translateY(-100%);
}
.bar.bottom.hidden {
  transform: translateY(100%);
}
.chapter-btn {
  flex-shrink: 0;
}
.step-btn {
  flex-shrink: 0;
  width: 34px;
  height: 30px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--card);
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
}
.step-btn.big {
  font-size: 15px;
}
.step-btn:active {
  background: var(--brand-light);
  color: var(--brand);
}
.sheet-scrim {
  display: none;
}

@media (max-width: 600px) {
  /* 手机页眉留白较窄 (见 applyPrefs 的 margin) */
  .tts-mini {
    --head-band: 36px;
  }
  .reader {
    --footer-h: 112px;
  }
  .chapter,
  .desk-only {
    display: none;
  }
  .bar {
    gap: 4px;
    padding-inline: max(8px, var(--lr-safe-left)) max(8px, var(--lr-safe-right));
  }
  .bar.top {
    padding-top: calc(6px + var(--safe-top));
    padding-bottom: 6px;
  }
  .icon-btn {
    width: 40px;
    height: 40px;
    border-radius: 10px;
  }
  .icon-btn:hover {
    background: none;
    color: var(--text-2);
  }
  .icon-btn:active {
    background: var(--surface-2);
  }
  .icon-btn.auto-on,
  .icon-btn.auto-on:hover {
    color: var(--brand);
  }
  .book-title strong {
    font-size: 15px;
    font-weight: 600;
  }
  .bar.bottom {
    padding-top: 4px;
    padding-bottom: calc(2px + var(--safe-bottom));
  }
  .progress-label {
    padding: 0 4px;
  }
  .jump-pop {
    left: 12px;
    right: 12px;
    width: auto;
  }
  /* 16px 以下 iOS 会在聚焦时放大页面 */
  .jump-input {
    font-size: 16px;
  }
  .jump-back {
    left: 12px;
  }
  .dock {
    display: flex;
  }
  .dock button {
    flex: 1;
    min-width: 0;
    height: 54px;
    border: none;
    border-radius: 10px;
    background: none;
    color: var(--text-2);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    font-size: 11px;
  }
  .dock button:active {
    background: var(--surface-2);
  }
  .dock button.active {
    color: var(--brand);
  }

  /* 面板改为底部抽屉 */
  .sheet-scrim {
    display: block;
    position: absolute;
    inset: 0;
    z-index: 14;
    background: var(--overlay);
    animation: scrim-in var(--dur) var(--ease);
  }
  .panel,
  .settings-pop,
  .tts-panel {
    top: auto;
    left: 0;
    right: 0;
    bottom: 0;
    width: auto;
    max-height: 78%;
    border-radius: var(--radius-xl) var(--radius-xl) 0 0;
    border-bottom: none;
    padding: 18px max(16px, var(--lr-safe-right)) calc(16px + var(--safe-bottom)) max(16px, var(--lr-safe-left));
    box-shadow: var(--shadow-lg);
    animation: sheet-up var(--dur-slow) var(--ease);
  }
  .panel {
    height: 72%;
  }
  .settings-pop,
  .tts-panel {
    overflow-y: auto;
    gap: 16px;
  }
  /* 抽屉顶部的拖拽指示条 */
  .panel::before,
  .settings-pop::before,
  .tts-panel::before {
    content: '';
    position: absolute;
    top: 7px;
    left: 50%;
    width: 36px;
    height: 4px;
    margin-left: -18px;
    border-radius: 2px;
    background: var(--border-strong);
  }
  .set-row {
    font-size: 14px;
  }
  .set-row label {
    width: 36px;
  }
  .set-row .input,
  .seg button {
    height: 36px;
  }
  .theme-btns {
    flex: 1;
    justify-content: space-between;
  }
  .theme-btn {
    width: 40px;
    height: 40px;
  }
  .anno-item,
  .search-item {
    padding: 10px 8px;
  }
  .anno-tabs button {
    height: 36px;
  }
  .highlight-bar {
    left: 8px;
    right: 8px;
    transform: none;
    flex-wrap: wrap;
    justify-content: center;
  }
  .hl-color {
    width: 28px;
    height: 28px;
  }
  .nav {
    display: none;
  }
}
@keyframes sheet-up {
  from {
    transform: translateY(40px);
    opacity: 0;
  }
  to {
    transform: none;
    opacity: 1;
  }
}
@keyframes scrim-in {
  from {
    opacity: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .bar,
  .sheet-scrim,
  .panel,
  .settings-pop,
  .tts-panel {
    transition: none;
    animation: none;
  }
}
</style>
