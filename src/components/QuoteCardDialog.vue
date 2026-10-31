<script setup lang="ts">
/**
 * 金句卡片: 预览即成图 (Canvas 生成的 PNG), 可换版式、底色、字体、字号与显示项.
 * App 存相册 / 系统分享, 桌面另存为 / 复制图片. 绘制见 services/quoteCard.ts.
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import AppModal from './AppModal.vue'
import {
  CARD_BACKGROUNDS, CARD_RATIOS, CARD_TEMPLATES, TEMPLATE_DEFAULT_BG, TEMPLATE_DEFAULT_FONT, cardFileName, canvasToPng, clampQuote,
  ensureCardFonts, parseBackground, renderQuoteCard,
  type CardRatio, type CardSize, type CardTemplate, type QuoteCardData, type QuoteCardStyle,
} from '../services/quoteCard'
import { CARD_FONTS } from '../services/cardFonts'
import { injectFontIntoDoc } from '../services/fonts'
import { canShareFiles, copyImage, copyText, isAndroidApp, saveImage, shareFile } from '../services/shareOut'
import { useSettings } from '../stores/settings'
import { toast } from '../services/toast'
import { t } from '../i18n'

const props = defineProps<{ data: QuoteCardData; coverUrl?: string }>()
const emit = defineEmits<{ close: [] }>()
const settings = useSettings()

// ---- 字体: 内置三种 + 用户导入的字体
interface CardFont { key: string; label: string; family: string; url?: string; custom?: { name: string; file: string } }
const fonts = computed<CardFont[]>(() => [
  ...CARD_FONTS.map(f => ({ key: f.key, label: t(f.labelKey), family: f.family, url: f.url })),
  ...settings.customFonts.map(f => ({ key: `custom:${f.name}`, label: f.name, family: `"${f.name}", serif`, custom: f })),
])
const loadedFaces = new Set<string>()
async function prepareFont(f: CardFont) {
  if (loadedFaces.has(f.key)) return
  if (f.url) {
    const name = f.family.match(/^"([^"]+)"/)?.[1]
    if (name) {
      const face = new FontFace(name, `url(${f.url})`)
      await face.load()
      document.fonts.add(face)
    }
  } else if (f.custom) {
    await injectFontIntoDoc(document, f.custom as any)
  }
  loadedFaces.add(f.key)
}

// ---- 样式 (按设备记住上次的选择)
const STORE_KEY = 'lightread-quote-card'
function loadStyle(): QuoteCardStyle & { fontKey: string } {
  const base = {
    template: CARD_TEMPLATES[0], background: TEMPLATE_DEFAULT_BG[CARD_TEMPLATES[0]], font: '', fontKey: TEMPLATE_DEFAULT_FONT[CARD_TEMPLATES[0]],
    size: 'md' as CardSize, ratio: '3:4' as CardRatio,
    showBook: true, showChapter: true, showNote: true, showDate: true, showBrand: true,
  }
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}')
    if (CARD_TEMPLATES.includes(saved.template)) base.template = saved.template
    if (typeof saved.background === 'string' && parseBackground(saved.background).join(',') === saved.background) base.background = saved.background
    if (CARD_RATIOS.includes(saved.ratio)) base.ratio = saved.ratio
    if (typeof saved.fontKey === 'string') base.fontKey = saved.fontKey
    if (['sm', 'md', 'lg'].includes(saved.size)) base.size = saved.size
    for (const k of ['showBook', 'showChapter', 'showNote', 'showDate', 'showBrand'] as const) if (typeof saved[k] === 'boolean') base[k] = saved[k]
  } catch { /* 默认 */ }
  return base
}
const style = reactive(loadStyle())
if (!fonts.value.some(f => f.key === style.fontKey)) style.fontKey = 'serif'
const currentFont = computed(() => fonts.value.find(f => f.key === style.fontKey) ?? fonts.value[0])
watch(style, () => { try { localStorage.setItem(STORE_KEY, JSON.stringify({ ...style, font: undefined })) } catch { /* 忽略 */ } })

function pickTemplate(tpl: CardTemplate) {
  if (style.template === tpl) return
  style.template = tpl
  style.background = TEMPLATE_DEFAULT_BG[tpl]
  if (fonts.value.some(f => f.key === TEMPLATE_DEFAULT_FONT[tpl])) style.fontKey = TEMPLATE_DEFAULT_FONT[tpl]
}

const clipped = computed(() => clampQuote(props.data.text).clipped)
const hasNote = computed(() => !!props.data.note?.trim())

// ---- 渲染
const canvas = document.createElement('canvas')
const previewUrl = ref('')
const rendering = ref(true)
const fontLoading = ref(false)
let lastBlob: Blob | null = null
let seq = 0
let cover: ImageBitmap | HTMLImageElement | undefined
let coverLoaded = false

async function loadCover() {
  if (coverLoaded) return
  coverLoaded = true
  if (!props.coverUrl) return
  try {
    const blob = await (await fetch(props.coverUrl)).blob()
    cover = await createImageBitmap(blob)
  } catch {
    cover = undefined
  }
}

const cardStyle = (over: Partial<QuoteCardStyle> = {}): QuoteCardStyle => ({ ...style, font: currentFont.value.family, ...over })

async function render() {
  const token = ++seq
  rendering.value = true
  try {
    await loadCover()
    const f = currentFont.value
    if (!loadedFaces.has(f.key)) {
      fontLoading.value = true
      await prepareFont(f).catch(() => {})
      fontLoading.value = false
    }
    await ensureCardFonts(f.family, `${props.data.text}${props.data.title}${props.data.author ?? ''}${props.data.note ?? ''}`)
    if (token !== seq) return
    renderQuoteCard({ ...props.data, cover: cover as any }, cardStyle(), canvas)
    const blob = await canvasToPng(canvas)
    if (token !== seq) return
    lastBlob = blob
    if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
    previewUrl.value = URL.createObjectURL(blob)
  } catch (e) {
    console.warn('quote card render failed', e)
    toast(t('card.renderFailed'), 'error')
  } finally {
    if (token === seq) rendering.value = false
  }
}

let timer: ReturnType<typeof setTimeout> | undefined
watch([style, () => props.data], () => { clearTimeout(timer); timer = setTimeout(render, 40) }, { deep: true })

// ---- 版式缩略图 (用当前字体与文字, 各版式默认底色)
const thumbs = ref<Partial<Record<CardTemplate, string>>>({})
async function renderThumbs() {
  const small = document.createElement('canvas')
  const scratch = document.createElement('canvas')
  for (const tpl of CARD_TEMPLATES) {
    const f = fonts.value.find(x => x.key === TEMPLATE_DEFAULT_FONT[tpl]) ?? currentFont.value
    await prepareFont(f).catch(() => {})
    await ensureCardFonts(f.family, props.data.text.slice(0, 60) + props.data.title)
    renderQuoteCard({ ...props.data, cover: cover as any }, cardStyle({ template: tpl, background: TEMPLATE_DEFAULT_BG[tpl], font: f.family, showNote: false, ratio: '3:4' }), scratch)
    const srcH = Math.min(scratch.height, Math.round(scratch.width * 4 / 3))
    small.width = 240
    small.height = Math.round(240 * srcH / scratch.width)
    const c = small.getContext('2d')!
    c.drawImage(scratch, 0, 0, scratch.width, srcH, 0, 0, small.width, small.height)
    thumbs.value = { ...thumbs.value, [tpl]: small.toDataURL('image/jpeg', 0.82) }
    await new Promise(r => setTimeout(r))
  }
}

onMounted(async () => {
  await render()
  void renderThumbs()
})
onBeforeUnmount(() => {
  seq++
  clearTimeout(timer)
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
})

// ---- 输出
const android = isAndroidApp()
const shareable = canShareFiles()
const busy = ref(false)
const fileName = () => cardFileName(props.data.title)

async function withBlob(fn: (blob: Blob) => Promise<void>) {
  if (busy.value) return
  busy.value = true
  try {
    if (!lastBlob || rendering.value) await render()
    if (lastBlob) await fn(lastBlob)
  } finally {
    busy.value = false
  }
}

const save = () => withBlob(async blob => {
  try {
    const r = await saveImage(blob, fileName())
    if (r === 'gallery') toast(t('card.savedGallery'), 'success')
    else if (r === 'file') toast(t('card.saved'), 'success')
  } catch {
    toast(t('card.saveFailed'), 'error')
  }
})

const share = () => withBlob(async blob => {
  try {
    await shareFile(blob, fileName(), 'image/png', t('card.shareTitle'))
  } catch {
    toast(t('card.shareFailed'), 'error')
  }
})

const copyImg = () => withBlob(async blob => {
  try {
    await copyImage(blob)
    toast(t('card.copiedImage'), 'success')
  } catch {
    toast(t('card.copyImageUnsupported'), 'error', 5000)
  }
})

async function copyQuote() {
  const d = props.data
  const src = d.lang === 'en' ? `— ${d.title}${d.author ? `, ${d.author}` : ''}` : `——《${d.title}》${d.author ? ` ${d.author}` : ''}`
  try {
    await copyText(`${d.text.trim()}\n${src}`)
    toast(t('notes.copied'), 'success')
  } catch {
    toast(t('notes.copyFailed'), 'error')
  }
}

const tplLabel = (tpl: CardTemplate) => t(`card.tpl.${tpl}`)
const swatchStyle = (bg: string) => {
  const [a, b] = parseBackground(bg)
  return { background: b ? `linear-gradient(135deg, ${a}, ${b})` : a }
}
const toggles = computed(() => [
  { key: 'showBook' as const, label: t('card.showBook') },
  { key: 'showChapter' as const, label: t('card.showChapter'), hidden: !props.data.chapter },
  { key: 'showNote' as const, label: t('card.showNote'), hidden: !hasNote.value },
  { key: 'showDate' as const, label: t('card.showDate') },
  { key: 'showBrand' as const, label: t('card.showBrand') },
].filter(x => !x.hidden))
</script>

<template>
  <AppModal wide :title="t('card.title')" @close="emit('close')">
    <div class="qc">
      <div class="qc-stage" :class="{ busy: rendering }">
        <img v-if="previewUrl" class="qc-preview" :src="previewUrl" :alt="t('card.previewAlt')" />
        <div v-else class="qc-placeholder skeleton" />
        <p v-if="fontLoading" class="qc-note">{{ t('card.fontLoading') }}</p>
        <p v-else-if="clipped" class="qc-note">{{ t('card.clipped') }}</p>
      </div>
      <div class="qc-controls">
        <section class="qc-field">
          <span class="qc-label">{{ t('card.template') }}</span>
          <div class="qc-templates" role="radiogroup" :aria-label="t('card.template')">
            <button
              v-for="tpl in CARD_TEMPLATES"
              :key="tpl"
              class="qc-tpl"
              :class="{ on: style.template === tpl }"
              :aria-pressed="style.template === tpl"
              @click="pickTemplate(tpl)"
            >
              <span class="qc-thumb" :style="swatchStyle(TEMPLATE_DEFAULT_BG[tpl])"><img v-if="thumbs[tpl]" :src="thumbs[tpl]" alt="" /></span>
              <span class="qc-tpl-name">{{ tplLabel(tpl) }}</span>
            </button>
          </div>
        </section>
        <section class="qc-field">
          <span class="qc-label">{{ t('card.background') }}</span>
          <div class="qc-swatches">
            <button
              v-for="bg in CARD_BACKGROUNDS"
              :key="bg"
              class="qc-swatch"
              :class="{ on: style.background === bg }"
              :style="swatchStyle(bg)"
              :aria-pressed="style.background === bg"
              :aria-label="bg"
              @click="style.background = bg"
            />
          </div>
        </section>
        <section class="qc-field">
          <span class="qc-label">{{ t('card.ratio') }}</span>
          <div class="segmented qc-seg">
            <button v-for="r in CARD_RATIOS" :key="r" :class="{ active: style.ratio === r }" :aria-pressed="style.ratio === r" @click="style.ratio = r">{{ t(`card.ratio.${r.replace(':', 'x')}`) }}</button>
          </div>
        </section>
        <section class="qc-field">
          <span class="qc-label">{{ t('card.font') }}</span>
          <div class="segmented qc-seg">
            <button v-for="f in fonts" :key="f.key" :class="{ active: style.fontKey === f.key }" :aria-pressed="style.fontKey === f.key" @click="style.fontKey = f.key">{{ f.label }}</button>
          </div>
        </section>
        <section class="qc-field">
          <span class="qc-label">{{ t('card.size') }}</span>
          <div class="segmented qc-seg">
            <button v-for="s in (['sm', 'md', 'lg'] as const)" :key="s" :class="{ active: style.size === s }" :aria-pressed="style.size === s" @click="style.size = s">{{ t(`card.size.${s}`) }}</button>
          </div>
        </section>
        <section class="qc-field">
          <span class="qc-label">{{ t('card.show') }}</span>
          <div class="qc-toggles">
            <button v-for="x in toggles" :key="x.key" class="qc-chip" :class="{ on: style[x.key] }" :aria-pressed="style[x.key]" @click="style[x.key] = !style[x.key]">{{ x.label }}</button>
          </div>
        </section>
      </div>
    </div>
    <template #footer>
      <div class="qc-actions">
        <button class="btn btn-sm qc-text" @click="copyQuote">{{ t('card.copyText') }}</button>
        <button v-if="!android" class="btn btn-sm" :disabled="busy" @click="copyImg">{{ t('card.copyImage') }}</button>
        <button v-if="shareable" class="btn btn-sm" :disabled="busy" @click="share">{{ t('card.share') }}</button>
        <button class="btn btn-sm btn-primary" :disabled="busy" @click="save">{{ android ? t('card.saveGallery') : t('card.save') }}</button>
      </div>
    </template>
  </AppModal>
</template>

<style scoped>
.qc { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: var(--space-5); padding: var(--space-4) var(--space-5); }
.qc-stage { position: relative; display: grid; place-items: center; align-content: start; gap: var(--space-2); min-width: 0; padding: var(--space-4); border-radius: var(--radius-lg); background: var(--surface-2); }
.qc-preview { display: block; width: 100%; max-width: 420px; max-height: 64vh; object-fit: contain; border-radius: var(--radius-sm); box-shadow: var(--shadow-2); transition: opacity 0.15s; }
.qc-stage.busy .qc-preview { opacity: 0.72; }
.qc-placeholder { width: 100%; max-width: 420px; aspect-ratio: 3 / 4; border-radius: var(--radius-sm); }
.qc-note { margin: 0; font-size: var(--fs-caption); color: var(--text-3); text-align: center; }
.qc-controls { display: grid; gap: var(--space-4); align-content: start; min-width: 0; }
.qc-field { display: grid; gap: var(--space-2); }
.qc-label { font-size: var(--fs-caption); color: var(--text-3); }
.qc-templates { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--space-2); }
.qc-tpl { display: grid; gap: var(--space-1); padding: var(--space-1); border: 2px solid transparent; border-radius: var(--radius); background: none; color: var(--text-2); cursor: pointer; }
.qc-tpl.on { border-color: var(--brand); color: var(--brand); }
.qc-thumb { display: block; aspect-ratio: 3 / 4; overflow: hidden; border-radius: var(--radius-xs); border: 1px solid var(--border); }
.qc-thumb img { display: block; width: 100%; height: 100%; object-fit: contain; object-position: center top; }
.qc-tpl-name { font-size: var(--fs-caption); }
.qc-swatches { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.qc-swatch { width: 32px; height: 32px; padding: 0; border: 1px solid var(--border-strong); border-radius: var(--radius-pill); cursor: pointer; }
.qc-swatch.on { outline: 2px solid var(--brand); outline-offset: 2px; }
.qc-seg { flex-wrap: wrap; }
.qc-toggles { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.qc-chip { min-height: 32px; padding: 0 var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-pill); background: var(--card); color: var(--text-2); font-size: var(--fs-small); cursor: pointer; }
.qc-chip.on { border-color: var(--brand); background: var(--brand-soft); color: var(--brand); }
.qc-actions { display: flex; justify-content: flex-end; gap: var(--space-2); flex-wrap: wrap; }
.qc-text { margin-right: auto; }
@media (max-width: 720px) {
  .qc { grid-template-columns: minmax(0, 1fr); padding: var(--space-3) var(--space-4); gap: var(--space-4); }
  .qc-stage { padding: var(--space-3); }
  .qc-preview { max-height: 46vh; max-height: 46dvh; }
  .qc-templates { grid-template-columns: repeat(15, 76px); overflow-x: auto; padding-bottom: var(--space-1); }
  .qc-swatch { width: 36px; height: 36px; }
  .qc-chip { min-height: 40px; }
  .qc-actions .btn { flex: 1; min-height: 44px; }
  .qc-text { margin-right: 0; }
}
</style>
