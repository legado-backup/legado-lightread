/**
 * 阅读模式与 ReaderView 的对接层 (docs/reading-modes.md §4 §5.2)。
 * 逻辑全部在这里和 services/readingModes/*, ReaderView 只做接线。
 *
 * ## 接线清单 (ReaderView.vue)
 *
 * ```ts
 * const modes = useReadingModes({
 *   getView: () => view,
 *   getColors: () => themeColors.value,
 *   pingReadingAuto,
 *   // 打字机开始前: 停掉自动翻页、暂停听书 (互斥)
 *   onExclusiveStart: () => { stopAutoRead(); if (ttsState.value === 'playing') pauseTTS() },
 *   isAutoReading: () => autoReading.value,
 *   isTTSActive: () => ttsState.value === 'playing',
 *   // 任一浮层 / 面板打开时自动暂停
 *   pauseWhen: () => panel.value !== 'none' || settingsOpen.value || ttsPanel.value || jumpOpen.value || !!activeAnnotation.value,
 *   beforePanelOpen: closeOverlays,
 * })
 * ```
 * 1. onRelocate(e): 开头加 `modes.onRelocate(e.detail)`; 计时改为
 *    `if (ttsState.value === 'playing' || modes.typewriterActive.value) pingReadingAuto() else pingReading()`。
 * 2. onSectionLoad(e): 开头加 `modes.onSectionLoad(e.detail)` (在首次绘制前隐藏新章节)。
 * 3. onContentClick: 在选区 / 链接判断之后、三分区翻页之前加
 *    `const tap = modes.onContentTap(); if (tap) { tap === 'paused' ? showBars() : hideBars(); return }`
 *    (打字机运行时轻点任意处只切换暂停, 不翻页)。
 * 4. handleKeydown: 输入框判断之后第一行 `if (modes.handleKey(e)) return`
 *    (M 面板、Shift+T 开始/退出; 打字机运行时 空格 暂停、→ 显示到段末、← 重打本句、Shift+↑/↓ 调速;
 *    Esc 退出打字机后返回 false, 继续走原有的 Esc 逻辑)。
 * 5. startAutoRead() 开头加 `modes.stopTypewriterFor('auto')`; startTTS() 开头加 `modes.stopTypewriterFor('tts')`。
 * 6. 入口: 底栏「自动」→「模式」, 顶栏「自动阅读」→「阅读模式」, 都调 `modes.togglePanel()`
 *    (打开前会调 beforePanelOpen 收起其他浮层); closeOverlays() 里加 `modes.closePanel()`;
 *    sheetOpen 加上 `|| modes.panelOpen.value`; 按钮 active = `modes.panelOpen.value || autoReading.value || modes.typewriterActive.value`。
 *    删除旧的 autoPanel / .auto-panel 浮条 (自动翻页迁入面板第一栏, 仍用 .auto-panel 类名)。
 * 7. 模板 (替换旧 auto-panel 块):
 *    <ReadingModePanel v-if="modes.panelOpen.value" :modes="modes" :auto-reading="autoReading"
 *      v-model:auto-read-seconds="settings.autoReadSeconds" @start-auto="startAutoRead" @stop-auto="stopAutoRead" />
 *    <ReadingModeMini :modes="modes" :bars-visible="barsVisible" />
 * 8. onBeforeUnmount: `modes.dispose()` (也会随组件作用域自动调用; 显式调用保证在 view.close() 之前清除隐藏)。
 * 9. 目录 / 搜索 / 书签 / 标注跳转前可调 `modes.pause()` (pauseWhen 已覆盖面板打开的情况)。
 */
import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { useSettings } from '../stores/settings'
import { t } from '../i18n'
import { toast } from '../services/toast'
import type { ReaderThemeColors } from '../services/readerTheme'
import {
  adjustSpeed as stepSpeed,
  clampSpeed,
  soundEvery,
  speedPresets,
  speedRange,
  type Script,
} from '../services/readingModes/pacing'
import { TypewriterController, type TypewriterConfig, type TypewriterHost, type TypewriterState } from '../services/readingModes/typewriter'
import { clearReadingModeMarks } from '../services/readingModes/revealLayer'
import { createTypingSound, type TypingSound } from '../services/readingModes/sound'

export type ReadingModeTab = 'auto' | 'typewriter'
export type { TypewriterState }

export interface UseReadingModesOptions {
  /** foliate-view 元素 */
  getView: () => any
  /** 当前正文主题颜色 (回退遮罩用) */
  getColors: () => ReaderThemeColors
  /** 自动推进的阅读计时 (与听书同口径) */
  pingReadingAuto: () => void
  /** 打字机开始前调用: 停止自动翻页、暂停听书 */
  onExclusiveStart?: () => void
  isAutoReading?: () => boolean
  isTTSActive?: () => boolean
  /** 返回 true 时 (面板、浮层、脚注弹层打开) 自动暂停 */
  pauseWhen?: () => boolean
  /** 自动翻页的动作, 默认 view.next() (方向随书, RTL 书也正确) */
  nextPage?: () => unknown
  /** 面板打开前调用 (收起其他浮层, 保持同一时间只开一个) */
  beforePanelOpen?: () => void
}

const REDUCED_DEFAULT_KEY = 'lightread-reading-mode-reduced-default'

export function useReadingModes(opts: UseReadingModesOptions) {
  const settings = useSettings()
  const tw = computed(() => settings.readingMode.typewriter)

  const panelOpen = ref(false)
  const panelTab = ref<ReadingModeTab>('typewriter')
  const typewriterState = ref<TypewriterState>('idle')
  const typewriterActive = computed(() => typewriterState.value !== 'idle')
  /** 书的主文字: 决定速度单位 (字/分 或 词/分) */
  const bookScript = ref<Script>('cjk')
  /** 固定版式 (漫画、PDF 式 EPUB) 不支持打字机 */
  const supported = ref(true)
  const reducedMotion = ref(false)

  const speedUnit = computed<'cpm' | 'wpm'>(() => (bookScript.value === 'cjk' ? 'cpm' : 'wpm'))
  const speedLimits = computed(() => speedRange(bookScript.value))
  const presets = computed(() => speedPresets(bookScript.value))
  const speed = computed<number>({
    get: () => (speedUnit.value === 'cpm' ? tw.value.cpm : tw.value.wpm),
    set: v => {
      const n = clampSpeed(v, bookScript.value)
      if (speedUnit.value === 'cpm') settings.readingMode.typewriter.cpm = n
      else settings.readingMode.typewriter.wpm = n
    },
  })
  const speedText = computed(() => t(speedUnit.value === 'cpm' ? 'readingMode.cpm' : 'readingMode.wpm', { n: speed.value }))

  // ---- 系统「减少动态效果」: 翻页停顿延长; 首次使用时默认粒度改为逐句 (画面跳动更少) ----
  let motionQuery: MediaQueryList | null = null
  const onMotionChange = () => { reducedMotion.value = !!motionQuery?.matches }
  try {
    motionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null
    onMotionChange()
    motionQuery?.addEventListener?.('change', onMotionChange)
    if (reducedMotion.value && localStorage.getItem(REDUCED_DEFAULT_KEY) !== '1') {
      if (settings.readingMode.typewriter.unit === 'char') settings.readingMode.typewriter.unit = 'sentence'
      localStorage.setItem(REDUCED_DEFAULT_KEY, '1')
    }
  } catch { /* 存储或 matchMedia 不可用 */ }

  const config = (): TypewriterConfig => ({
    unit: tw.value.unit,
    unitsPerMinute: speed.value,
    ghost: tw.value.upcoming === 'ghost',
    punctuationPause: tw.value.punctuationPause,
    freshInk: tw.value.freshInk,
    pageDwellMs: reducedMotion.value ? Math.max(1200, tw.value.pageDwellMs) : tw.value.pageDwellMs,
  })

  // ---- foliate 适配 ----
  const host: TypewriterHost = {
    contents: () => {
      const c = opts.getView()?.renderer?.getContents?.()?.[0]
      return c?.doc ? c : null
    },
    visibleRange: () => opts.getView()?.lastLocation?.range ?? null,
    scrolled: () => !!opts.getView()?.renderer?.scrolled,
    atBookEnd: () => {
      const view = opts.getView()
      const r = view?.renderer
      if (!r) return true
      if (!r.scrolled) return !!r.atEnd
      const index = host.contents()?.index ?? -1
      const sections: any[] = view.book?.sections ?? []
      return !sections.slice(index + 1).some(s => s?.linear !== 'no')
    },
    nextPage: () => (opts.nextPage ? opts.nextPage() : opts.getView()?.next()),
    nextSection: () => opts.getView()?.renderer?.nextSection?.(),
    scrollForward: px => {
      const r = opts.getView()?.renderer
      // 只在本节内滚动: 到底时 renderer.next 会跨节, 交给节末逻辑
      if (r && r.viewSize - r.end > 2 && px > 0) void r.next(px)
    },
    viewportRect: () => opts.getView()?.renderer?.getBoundingClientRect?.() ?? null,
    colors: () => opts.getColors(),
    lang: () => {
      const doc = host.contents()?.doc
      return doc?.documentElement?.lang || opts.getView()?.language?.canonical || (bookScript.value === 'cjk' ? 'zh' : 'en')
    },
  }

  let sound: TypingSound | null = null
  let soundCount = 0
  let lastPing = 0

  const controller = shallowRef<TypewriterController | null>(null)
  const ensureController = () => {
    if (!controller.value) {
      controller.value = new TypewriterController(host, config(), {
        onState: s => { typewriterState.value = s },
        onAdvance: ticks => {
          const now = Date.now()
          if (now - lastPing > 1000) {
            lastPing = now
            opts.pingReadingAuto()
          }
          if (!tw.value.sound || ticks <= 0 || opts.isTTSActive?.()) return
          soundCount += ticks
          if (soundCount >= soundEvery(speed.value)) {
            soundCount = 0
            sound?.click()
          }
        },
        onFinish: reason => {
          if (reason === 'book-end') toast(t('readingMode.bookEnd'), 'success')
          else toast(t('readingMode.error'), 'error', 4000)
        },
      })
    }
    return controller.value
  }

  const refreshBookInfo = () => {
    const view = opts.getView()
    supported.value = !!view && !view.isFixedLayout
    const isCJK = view?.language?.isCJK
    bookScript.value = isCJK === false ? 'latin' : 'cjk'
  }

  // ---- 文档级监听: 选区越过光标 ----
  const watchedDocs = new WeakSet<Document>()
  const ensureDocListeners = (doc: Document | null | undefined) => {
    if (!doc || watchedDocs.has(doc)) return
    watchedDocs.add(doc)
    doc.addEventListener('selectionchange', () => {
      const c = controller.value
      if (!c?.active || c.doc !== doc) return
      const sel = doc.getSelection()
      if (!sel || sel.isCollapsed || !sel.rangeCount) return
      // 长按选字: 暂停, 选区越过光标时把光标推进到选区末尾
      c.pause()
      c.revealSelection(sel.getRangeAt(0))
    })
  }

  // ---- 打字机控制 ----
  function start(): boolean {
    refreshBookInfo()
    if (!supported.value) {
      toast(t('readingMode.fixedLayoutUnsupported'), 'error')
      return false
    }
    const hadAuto = !!opts.isAutoReading?.()
    const hadTTS = !!opts.isTTSActive?.()
    opts.onExclusiveStart?.()
    if (hadAuto) toast(t('readingMode.autoStopped'))
    else if (hadTTS) toast(t('readingMode.ttsPaused'))
    if (tw.value.sound) {
      sound ??= createTypingSound()
      sound.warm()
    }
    const c = ensureController()
    c.setConfig(config())
    ensureDocListeners(host.contents()?.doc)
    panelOpen.value = false
    const ok = c.start()
    if (!ok) toast(t('readingMode.startFailed'), 'error')
    return ok
  }

  function pause() { controller.value?.pause() }
  function resume() { controller.value?.resume() }
  function stop() { controller.value?.stop() }

  function togglePause() {
    const s = typewriterState.value
    if (s === 'running' || s === 'turning') pause()
    else if (s === 'paused') {
      panelOpen.value = false
      resume()
    }
  }

  function toggleTypewriter() {
    if (typewriterActive.value) stop()
    else start()
  }

  /** 另一种自动推进 (自动翻页 / 听书) 开始前调用: 退出打字机并提示 */
  function stopTypewriterFor(_reason: 'auto' | 'tts') {
    if (!typewriterActive.value) return
    stop()
    toast(t('readingMode.typewriterStopped'))
  }

  function adjustSpeed(dir: 1 | -1) {
    speed.value = clampSpeed(stepSpeed(speed.value, dir), bookScript.value)
  }

  // ---- 面板 ----
  function openPanel(tab?: ReadingModeTab) {
    opts.beforePanelOpen?.()
    refreshBookInfo()
    if (tab) panelTab.value = tab
    else if (typewriterActive.value) panelTab.value = 'typewriter'
    else if (opts.isAutoReading?.()) panelTab.value = 'auto'
    panelOpen.value = true
  }
  function closePanel() { panelOpen.value = false }
  function togglePanel(tab?: ReadingModeTab) {
    if (panelOpen.value) closePanel()
    else openPanel(tab)
  }

  // 打开任何面板 / 浮层时暂停 (WCAG 2.2.2: 移动内容可暂停, 且不在用户看别处时继续跑)
  watch(panelOpen, open => { if (open) pause() })
  if (opts.pauseWhen) watch(() => opts.pauseWhen!(), v => { if (v) pause() })

  watch(
    () => [tw.value.unit, tw.value.upcoming, tw.value.punctuationPause, tw.value.freshInk, tw.value.pageDwellMs, speed.value, reducedMotion.value],
    () => controller.value?.setConfig(config()),
  )
  watch(() => tw.value.sound, on => {
    if (on && typewriterActive.value) {
      sound ??= createTypingSound()
      sound.warm()
    }
  })
  watch(() => opts.getColors(), () => controller.value?.refreshColors())

  // 切到后台 / 页面隐藏: 暂停
  const onVisibility = () => { if (document.hidden) pause() }
  const onPageHide = () => pause()
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pagehide', onPageHide)

  // ---- ReaderView 事件 ----
  /** foliate relocate 的 e.detail */
  function onRelocate(detail: { range?: Range | null } | null | undefined) {
    controller.value?.onRelocate(detail?.range ?? null)
  }

  /** foliate load 的 e.detail */
  function onSectionLoad(detail: { doc: Document; index: number } | null | undefined) {
    if (!detail?.doc) return
    ensureDocListeners(detail.doc)
    controller.value?.onSectionLoad(detail.doc, detail.index)
  }

  /**
   * 轻点正文。打字机未启用时返回 false (按原逻辑翻页 / 呼出工具栏);
   * 启用时轻点任意位置切换暂停 / 继续, 返回 'paused' 或 'resumed' (不翻页, 防误触)。
   */
  function onContentTap(): false | 'paused' | 'resumed' {
    const s = typewriterState.value
    if (s === 'idle') return false
    if (s === 'paused') {
      resume()
      return 'resumed'
    }
    pause()
    return 'paused'
  }

  /** 键盘; 返回 true 表示已处理 (调用方直接 return) */
  function handleKey(e: KeyboardEvent): boolean {
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return false
    const el = e.target as HTMLElement | null
    if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName ?? ''))) return false
    const key = e.key
    const consume = () => { e.preventDefault(); return true }
    if ((key === 'm' || key === 'M') && !e.shiftKey) {
      togglePanel()
      return consume()
    }
    if ((key === 'T' || key === 't') && e.shiftKey) {
      toggleTypewriter()
      return consume()
    }
    if (key === 'Escape' && panelOpen.value && !typewriterActive.value) {
      closePanel()
      return false
    }
    if (!typewriterActive.value) return false
    const c = controller.value!
    if (key === ' ' || key === 'Spacebar') {
      togglePause()
      return consume()
    }
    if (e.shiftKey && key === 'ArrowUp') {
      adjustSpeed(1)
      return consume()
    }
    if (e.shiftKey && key === 'ArrowDown') {
      adjustSpeed(-1)
      return consume()
    }
    if (key === 'ArrowRight' && !e.shiftKey) {
      c.revealParagraph()
      return consume()
    }
    if (key === 'ArrowLeft' && !e.shiftKey) {
      c.retypeSentence()
      return consume()
    }
    if (key === 'Escape') {
      stop()
      closePanel()
      return false // 让 ReaderView 继续处理 Esc (收起其他面板等)
    }
    return false
  }

  let disposed = false
  function dispose() {
    if (disposed) return
    disposed = true
    controller.value?.dispose()
    controller.value = null
    sound?.dispose()
    sound = null
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('pagehide', onPageHide)
    motionQuery?.removeEventListener?.('change', onMotionChange)
    try {
      for (const c of opts.getView()?.renderer?.getContents?.() ?? []) clearReadingModeMarks(c?.doc)
    } catch { /* 已卸载 */ }
  }
  onScopeDispose(dispose)

  return {
    // 状态
    panelOpen,
    panelTab,
    typewriterState,
    typewriterActive,
    supported,
    reducedMotion,
    bookScript,
    speed,
    speedUnit,
    speedText,
    speedLimits,
    presets,
    // 面板
    openPanel,
    closePanel,
    togglePanel,
    // 打字机
    start,
    pause,
    resume,
    stop,
    togglePause,
    toggleTypewriter,
    stopTypewriterFor,
    adjustSpeed,
    // ReaderView 事件
    onRelocate,
    onSectionLoad,
    onContentTap,
    handleKey,
    dispose,
  }
}

export type ReadingModes = ReturnType<typeof useReadingModes>
