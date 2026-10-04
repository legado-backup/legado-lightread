<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useLibrary } from '../stores/library'
import { useSettings } from '../stores/settings'
import { t } from '../i18n'
import { formatReadingTime } from '../composables/useReadingTimer'
import { readerPath } from '../services/readerRoute'
import { loadDaily, localDay, onReadingLogChange } from '../services/readingLog'
import {
  addDays,
  dayOfWeek,
  heatmap,
  rangeSummary,
  streaks,
  totalActiveDays,
  type DailyMap,
  type DayBook,
} from '../services/readingStats'
import type { BookMeta } from '../storage'

const router = useRouter()
const library = useLibrary()
const settings = useSettings()

// ---- 数据: 按天聚合的阅读记录, 记录 / 同步落地 / 导入后实时刷新 ----
const daily = ref<DailyMap>({})
const loaded = ref(false)
const today = ref(localDay())
const selectedDay = ref(today.value)
const heatmapScroller = ref<HTMLElement>()

async function reload() {
  try {
    daily.value = await loadDaily()
  } catch {
    daily.value = {}
  }
  const now = localDay()
  // 跨过午夜: 仍停在「昨天的今天」时跟着走到新的今天
  if (selectedDay.value === today.value) selectedDay.value = now
  today.value = now
  const first = !loaded.value
  loaded.value = true
  if (first) {
    await nextTick()
    scrollHeatmapToEnd()
  }
}

let stopLog: (() => void) | undefined
onMounted(() => {
  if (!library.loaded) void library.refresh()
  void reload()
  stopLog = onReadingLogChange(() => void reload())
})
onBeforeUnmount(() => stopLog?.())

const hasData = computed(() => Object.values(daily.value).some(e => e.seconds > 0))
const booksById = computed(() => new Map(library.books.map(b => [b.id, b])))

// ---- 日期工具 (本地时区, 键为 YYYY-MM-DD) ----
function parseDay(day: string): Date {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d)
}
function dayKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}
function daysBetween(from: string, to: string): number {
  return Math.round((parseDay(to).getTime() - parseDay(from).getTime()) / 86_400_000) + 1
}
const locale = computed(() => (settings.language === 'en' ? 'en-US' : 'zh-CN'))
function fmt(day: string, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(locale.value, opts).format(parseDay(day))
}
function fmtLong(day: string): string {
  return fmt(day, { year: 'numeric', month: 'short', day: 'numeric', weekday: 'short' })
}
function fmtTime(seconds: number): string {
  return seconds > 0 ? formatReadingTime(seconds) : t('stats.noReading')
}

/** 秒 → 大号数字 + 单位 (如 1 小时 12 分钟), 供统计卡片排版 */
function durationParts(seconds: number): Array<{ n: string; u: string }> {
  const mins = Math.floor(seconds / 60)
  if (mins < 60) return [{ n: String(mins), u: t('stats.unitMinutes') }]
  const h = Math.floor(mins / 60)
  const m = mins % 60
  const parts = [{ n: String(h), u: t('stats.unitHours') }]
  if (m) parts.push({ n: String(m), u: t('stats.unitMinutes') })
  return parts
}

// ---- 今日 + 每日目标 ----
const todaySeconds = computed(() => daily.value[today.value]?.seconds ?? 0)
const goal = computed(() => Math.max(0, Math.round(settings.dailyGoalMinutes || 0)))
const goalPct = computed(() =>
  goal.value > 0 ? Math.min(100, Math.round((todaySeconds.value / 60 / goal.value) * 100)) : 0)
const goalReached = computed(() => goal.value > 0 && todaySeconds.value >= goal.value * 60)
const goalRemaining = computed(() => Math.max(1, Math.ceil(goal.value - todaySeconds.value / 60)))
const RING_R = 46
const RING_C = 2 * Math.PI * RING_R
const ringOffset = computed(() => RING_C * (1 - goalPct.value / 100))
const GOAL_PRESETS = [0, 10, 15, 20, 30, 45, 60, 90, 120]
const goalOptions = computed(() =>
  [...new Set([...GOAL_PRESETS, goal.value])].sort((a, b) => a - b))
function setGoal(e: Event) {
  settings.dailyGoalMinutes = Number((e.target as HTMLSelectElement).value) || 0
}

// ---- 概览卡片 ----
const streak = computed(() => streaks(daily.value, today.value))
const activeDays = computed(() => totalActiveDays(daily.value))
const firstLogDay = computed(() => {
  const days = Object.keys(daily.value).filter(d => daily.value[d].seconds > 0).sort()
  return days[0] ?? ''
})
/** 累计时长: 书上的 readingSeconds 包含本功能上线前的历史; 被删的书 / 其他设备的记录可能更多, 取较大者 */
const totalSeconds = computed(() => {
  const fromBooks = library.books.reduce((sum, b) => sum + (b.readingSeconds ?? 0), 0)
  const fromLog = Object.values(daily.value).reduce((sum, e) => sum + e.seconds, 0)
  return Math.max(fromBooks, fromLog)
})
const totalDisplay = computed(() => {
  const secs = totalSeconds.value
  if (secs < 3600) return { n: String(Math.floor(secs / 60)), u: t('stats.unitMinutes') }
  const h = secs / 3600
  return { n: h >= 100 ? String(Math.round(h)) : String(Math.round(h * 10) / 10), u: t('stats.unitHours') }
})
const sinceText = computed(() =>
  firstLogDay.value && firstLogDay.value !== today.value
    ? t('stats.since', { date: fmt(firstLogDay.value, { year: 'numeric', month: 'short', day: 'numeric' }) })
    : t('stats.sinceToday'))

// ---- 热力图: 近 53 周, 周一起 ----
const HEAT_WEEKS = 53
const heatCols = computed(() => heatmap(daily.value, today.value, HEAT_WEEKS, 1))
function level(seconds: number): number {
  if (seconds <= 0) return 0
  const mins = seconds / 60
  if (mins < 15) return 1
  if (mins < 30) return 2
  if (mins < 60) return 3
  return 4
}
const monthLabels = computed(() => {
  const labels: Array<{ col: number; text: string }> = []
  let lastMonth = -1
  heatCols.value.forEach((col, ci) => {
    const first = col.find(c => c)
    if (!first) return
    const month = parseDay(first.day).getMonth()
    if (month !== lastMonth) {
      labels.push({ col: ci, text: fmt(first.day, { month: 'short' }) })
      lastMonth = month
    }
  })
  // 首列落在月中时与下个月标签挤在一起, 让给后者
  if (labels.length > 1 && labels[1].col - labels[0].col < 3) labels.shift()
  return labels
})
const weekdayLabels = computed(() => {
  // 周一起: 第 0/2/4 行是周一/三/五; 2024-01-01 是周一, 用来取本地化星期名
  return [0, 1, 2, 3, 4, 5, 6].map(i =>
    i % 2 === 0 && i < 6 ? fmt(addDays('2024-01-01', i), { weekday: 'short' }) : '')
})
const legendLevels = [0, 1, 2, 3, 4]

function selectDay(day: string) {
  selectedDay.value = day
}
/** 方向键在热力图内移动选中日期 (左右=±1 周, 上下=±1 天), 只有选中格在 Tab 序列里 */
function onHeatKey(e: KeyboardEvent) {
  const delta = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 }[e.key]
  if (!delta) return
  e.preventDefault()
  const firstCol = heatCols.value[0]?.find(c => c)?.day
  const next = addDays(selectedDay.value, delta)
  if (next > today.value || (firstCol && next < firstCol)) return
  selectedDay.value = next
  void nextTick(() => {
    const el = heatmapScroller.value?.querySelector<HTMLElement>(`[data-day="${next}"]`)
    el?.focus()
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  })
}
function scrollHeatmapToEnd() {
  const el = heatmapScroller.value
  if (el) el.scrollLeft = el.scrollWidth
}
const selectedEntry = computed(() => daily.value[selectedDay.value])

// ---- 周 / 月 / 年 ----
type Mode = 'week' | 'month' | 'year'
const MODES: Mode[] = ['week', 'month', 'year']
const mode = ref<Mode>('week')
const offset = ref(0)
watch(mode, () => { offset.value = 0 })

interface Bar { key: string; label: string; title: string; seconds: number; future: boolean; current: boolean }

const period = computed(() => {
  const now = parseDay(today.value)
  const bars: Bar[] = []
  let from: string
  let to: string
  let title: string
  if (mode.value === 'week') {
    const back = (dayOfWeek(today.value) + 6) % 7
    from = addDays(today.value, -back + offset.value * 7)
    to = addDays(from, 6)
    for (let i = 0; i < 7; i++) {
      const day = addDays(from, i)
      const seconds = daily.value[day]?.seconds ?? 0
      bars.push({
        key: day,
        label: fmt(day, { weekday: 'short' }),
        title: t('stats.barLabel', { label: fmt(day, { month: 'short', day: 'numeric', weekday: 'short' }), time: fmtTime(seconds) }),
        seconds,
        future: day > today.value,
        current: day === today.value,
      })
    }
    const sameYear = parseDay(from).getFullYear() === now.getFullYear() && parseDay(to).getFullYear() === now.getFullYear()
    const opts: Intl.DateTimeFormatOptions = sameYear
      ? { month: 'short', day: 'numeric' }
      : { year: 'numeric', month: 'short', day: 'numeric' }
    title = `${fmt(from, opts)} – ${fmt(to, opts)}`
  } else if (mode.value === 'month') {
    const start = new Date(now.getFullYear(), now.getMonth() + offset.value, 1)
    const count = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate()
    from = dayKey(start)
    to = addDays(from, count - 1)
    for (let i = 0; i < count; i++) {
      const day = addDays(from, i)
      const seconds = daily.value[day]?.seconds ?? 0
      const d = i + 1
      bars.push({
        key: day,
        label: d === 1 || d % 5 === 0 ? String(d) : '',
        title: t('stats.barLabel', { label: fmt(day, { month: 'short', day: 'numeric', weekday: 'short' }), time: fmtTime(seconds) }),
        seconds,
        future: day > today.value,
        current: day === today.value,
      })
    }
    title = fmt(from, { year: 'numeric', month: 'long' })
  } else {
    const year = now.getFullYear() + offset.value
    from = `${year}-01-01`
    to = `${year}-12-31`
    const sums = new Array(12).fill(0) as number[]
    const prefix = `${year}-`
    for (const [day, entry] of Object.entries(daily.value)) {
      if (day.startsWith(prefix)) sums[Number(day.slice(5, 7)) - 1] += entry.seconds
    }
    for (let m = 0; m < 12; m++) {
      const day = dayKey(new Date(year, m, 1))
      bars.push({
        key: day,
        label: fmt(day, { month: settings.language === 'en' ? 'short' : 'numeric' }),
        title: t('stats.barLabel', { label: fmt(day, { year: 'numeric', month: 'long' }), time: fmtTime(sums[m]) }),
        seconds: sums[m],
        future: day > today.value,
        current: year === now.getFullYear() && m === now.getMonth(),
      })
    }
    title = fmt(from, { year: 'numeric' })
  }
  const summary = rangeSummary(daily.value, from, to)
  // 日均按已经过去的天数算, 本期还没结束时不把未来的天摊进去
  const end = to < today.value ? to : today.value
  const elapsed = end >= from ? daysBetween(from, end) : 0
  return {
    from,
    to,
    title,
    bars,
    summary,
    avg: elapsed ? summary.seconds / elapsed : 0,
    books: [...summary.books].sort((a, b) => b.seconds - a.seconds),
  }
})

/** 纵轴上限取「整」值: 1 小时内按 15 分钟进位, 以上按常用小时数进位 */
function niceCeil(seconds: number): number {
  const mins = Math.max(1, Math.ceil(seconds / 60))
  if (mins <= 60) return Math.max(15, Math.ceil(mins / 15) * 15) * 60
  const hours = mins / 60
  const steps = [1.5, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60, 80, 100, 120, 150, 200, 250, 300]
  const h = steps.find(s => s >= hours) ?? Math.ceil(hours / 100) * 100
  return h * 3600
}
const goalLineSeconds = computed(() => (mode.value !== 'year' && goal.value > 0 ? goal.value * 60 : 0))
const chartMax = computed(() => {
  const peak = Math.max(0, ...period.value.bars.map(b => b.seconds))
  return niceCeil(Math.max(peak, goalLineSeconds.value, mode.value === 'year' ? 3600 : 15 * 60))
})
function axisLabel(seconds: number): string {
  const mins = Math.round(seconds / 60)
  if (mins < 60) return t('stats.axisMinutes', { m: mins })
  const h = Math.round((mins / 60) * 10) / 10
  return t('stats.axisHours', { h })
}
function barHeight(seconds: number): string {
  if (seconds <= 0) return '0%'
  return `${Math.max(1.5, (seconds / chartMax.value) * 100)}%`
}
const chartAria = computed(() => `${t('stats.chartAria', { range: period.value.title })}, ${t('stats.periodTotal')} ${fmtTime(period.value.summary.seconds)}`)

// ---- 书列表 ----
interface BookRow { key: string; title: string; seconds: number; kind: 'book' | 'paper'; book?: BookMeta; share: number }
function toRows(books: DayBook[]): BookRow[] {
  const top = Math.max(1, ...books.map(b => b.seconds))
  return books.map(b => {
    const book = b.bookId ? booksById.value.get(b.bookId) : undefined
    return { key: b.key, title: book?.title || b.title, seconds: b.seconds, kind: b.kind, book, share: b.seconds / top }
  })
}
const periodRows = computed(() => toRows(period.value.books))
const dayRows = computed(() => toRows(selectedEntry.value?.books ?? []))
function openRow(row: BookRow) {
  if (row.book) void router.push(readerPath(row.book))
}
</script>

<template>
  <div class="stats">
    <h1>{{ t('stats.title') }}</h1>

    <!-- 今日 + 概览 -->
    <div class="overview">
      <section class="card today-card" :aria-label="t('stats.today')">
        <div
          class="ring"
          role="img"
          :aria-label="goal > 0
            ? t('stats.ringAria', { time: fmtTime(todaySeconds), goal, pct: goalPct })
            : `${t('stats.today')} ${fmtTime(todaySeconds)}`"
        >
          <svg viewBox="0 0 108 108" width="108" height="108" aria-hidden="true">
            <circle class="ring-track" cx="54" cy="54" :r="RING_R" />
            <circle
              v-if="goal > 0"
              class="ring-fill"
              :class="{ done: goalReached }"
              cx="54"
              cy="54"
              :r="RING_R"
              :stroke-dasharray="RING_C"
              :stroke-dashoffset="ringOffset"
            />
          </svg>
          <div class="ring-center" :class="{ done: goalReached }" aria-hidden="true">
            <template v-if="goal > 0 && goalReached">
              <svg viewBox="0 0 24 24" width="30" height="30"><path fill="currentColor" d="M9.55 17.3a1 1 0 0 1-.7-.3l-4.2-4.2a1 1 0 1 1 1.41-1.41l3.5 3.49 8.28-8.29a1 1 0 1 1 1.42 1.42l-9 9a1 1 0 0 1-.71.29z" /></svg>
            </template>
            <template v-else-if="goal > 0">
              <span class="ring-pct">{{ goalPct }}</span><span class="ring-unit">%</span>
            </template>
            <template v-else>
              <svg viewBox="0 0 24 24" width="28" height="28"><path fill="currentColor" d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15.5a2.5 2.5 0 0 1-2.5 2.5H6.5A2.5 2.5 0 0 1 4 18.5v-13zM6.5 5A.5.5 0 0 0 6 5.5V16.05c.16-.03.32-.05.5-.05H18V5H6.5zM6 18.5a.5.5 0 0 0 .5.5H18v-1H6.5a.5.5 0 0 0-.5.5z" /></svg>
            </template>
          </div>
        </div>
        <div class="today-body">
          <div class="label">{{ t('stats.today') }}</div>
          <div class="big-value">
            <template v-for="(p, i) in durationParts(todaySeconds)" :key="i">
              <span class="num">{{ p.n }}</span><span class="unit">{{ p.u }}</span>
            </template>
          </div>
          <div class="goal-status">
            <template v-if="goal === 0">{{ t('stats.goalUnset') }}</template>
            <template v-else-if="goalReached">{{ t('stats.goalDone') }}</template>
            <template v-else>{{ t('stats.goalRemaining', { m: goalRemaining }) }}</template>
          </div>
          <label class="goal-picker">
            <span>{{ t('stats.goal') }}</span>
            <select class="input goal-select" :value="goal" @change="setGoal">
              <option v-for="opt in goalOptions" :key="opt" :value="opt">
                {{ opt === 0 ? t('stats.goalNone') : t('stats.goalOption', { m: opt }) }}
              </option>
            </select>
          </label>
        </div>
      </section>

      <div class="tiles">
        <section class="card tile">
          <div class="label">{{ t('stats.streak') }}</div>
          <div class="tile-value"><span class="num">{{ streak.current }}</span><span class="unit">{{ t('stats.unitDays') }}</span></div>
          <div class="hint">{{ t('stats.streakLongest', { n: streak.longest }) }}</div>
        </section>
        <section class="card tile">
          <div class="label">{{ t('stats.activeDays') }}</div>
          <div class="tile-value"><span class="num">{{ activeDays }}</span><span class="unit">{{ t('stats.unitDays') }}</span></div>
          <div class="hint">{{ t('stats.activeDaysHint') }}</div>
        </section>
        <section class="card tile" :title="fmtTime(totalSeconds)">
          <div class="label">{{ t('stats.totalTime') }}</div>
          <div class="tile-value"><span class="num">{{ totalDisplay.n }}</span><span class="unit">{{ totalDisplay.u }}</span></div>
          <div class="hint">{{ sinceText }}</div>
        </section>
      </div>
    </div>

    <template v-if="loaded && !hasData">
      <section class="card empty-card">
        <div class="empty">
          <div class="empty-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path fill="currentColor" d="M4 13a1.5 1.5 0 0 1 3 0v5.5a1.5 1.5 0 0 1-3 0V13zm6.5-5a1.5 1.5 0 0 1 3 0v10.5a1.5 1.5 0 0 1-3 0V8zM17 4.5a1.5 1.5 0 0 1 3 0v14a1.5 1.5 0 0 1-3 0v-14z" /></svg>
          </div>
          <p class="empty-title">{{ t('stats.emptyTitle') }}</p>
          <p class="empty-desc">{{ t('stats.emptyDesc') }}</p>
          <div class="empty-actions">
            <router-link to="/library" class="btn btn-primary">{{ t('stats.emptyAction') }}</router-link>
          </div>
        </div>
      </section>
    </template>

    <template v-else-if="loaded">
      <!-- 年度热力图 -->
      <section class="card section">
        <div class="section-head">
          <h2>{{ t('stats.heatmapTitle') }}</h2>
          <div class="legend" aria-hidden="true">
            <span>{{ t('stats.heatmapLess') }}</span>
            <span v-for="lv in legendLevels" :key="lv" class="hm-swatch" :class="`l${lv}`" />
            <span>{{ t('stats.heatmapMore') }}</span>
          </div>
        </div>
        <div ref="heatmapScroller" class="hm-scroll">
          <div class="hm" role="group" :aria-label="t('stats.heatmapAria')" @keydown="onHeatKey">
            <div class="hm-corner" />
            <div class="hm-months" aria-hidden="true">
              <span
                v-for="m in monthLabels"
                :key="m.col"
                class="hm-month"
                :style="{ gridColumn: `${m.col + 1} / span 4` }"
              >{{ m.text }}</span>
            </div>
            <div class="hm-weekdays" aria-hidden="true">
              <span v-for="(w, i) in weekdayLabels" :key="i">{{ w }}</span>
            </div>
            <div class="hm-grid">
              <template v-for="(col, ci) in heatCols" :key="ci">
                <template v-for="(cell, ri) in col" :key="`${ci}-${ri}`">
                  <button
                    v-if="cell"
                    type="button"
                    class="hm-cell"
                    :class="[`l${level(cell.seconds)}`, { selected: cell.day === selectedDay, today: cell.day === today }]"
                    :data-day="cell.day"
                    :tabindex="cell.day === selectedDay ? 0 : -1"
                    :title="t('stats.cellLabel', { date: fmtLong(cell.day), time: fmtTime(cell.seconds) })"
                    :aria-label="t('stats.cellLabel', { date: fmtLong(cell.day), time: fmtTime(cell.seconds) })"
                    :aria-pressed="cell.day === selectedDay"
                    @click="selectDay(cell.day)"
                  />
                  <span v-else class="hm-cell hm-empty" aria-hidden="true" />
                </template>
              </template>
            </div>
          </div>
        </div>

        <div class="day-detail" aria-live="polite">
          <h3>{{ t('stats.dayTitle', { date: fmtLong(selectedDay), time: fmtTime(selectedEntry?.seconds ?? 0) }) }}</h3>
          <p v-if="!dayRows.length" class="muted">{{ t('stats.dayEmpty') }}</p>
          <ul v-else class="book-list">
            <li v-for="row in dayRows" :key="row.key">
              <component
                :is="row.book ? 'button' : 'div'"
                class="book-row"
                :class="{ missing: !row.book }"
                :type="row.book ? 'button' : undefined"
                :title="row.book ? t('stats.openBook', { title: row.title }) : t('stats.bookMissing')"
                @click="openRow(row)"
              >
                <span class="book-icon" aria-hidden="true">
                  <svg v-if="row.kind === 'paper'" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M6 2h9a1 1 0 0 1 .7.3l4 4a1 1 0 0 1 .3.7v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm8 2H6v16h12V8h-3a1 1 0 0 1-1-1V4zM8 11a1 1 0 0 1 1-1h6a1 1 0 1 1 0 2H9a1 1 0 0 1-1-1zm0 4a1 1 0 0 1 1-1h6a1 1 0 1 1 0 2H9a1 1 0 0 1-1-1z" /></svg>
                  <svg v-else viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15.5a2.5 2.5 0 0 1-2.5 2.5H6.5A2.5 2.5 0 0 1 4 18.5v-13zM6.5 5A.5.5 0 0 0 6 5.5V16.05c.16-.03.32-.05.5-.05H18V5H6.5zM6 18.5a.5.5 0 0 0 .5.5H18v-1H6.5a.5.5 0 0 0-.5.5z" /></svg>
                </span>
                <span class="book-main">
                  <span class="book-title">{{ row.title }}</span>
                  <span v-if="!row.book" class="book-tag">{{ t('stats.bookMissing') }}</span>
                  <span v-else-if="row.kind === 'paper'" class="book-tag">{{ t('stats.kindPaper') }}</span>
                </span>
                <span class="book-time">{{ fmtTime(row.seconds) }}</span>
              </component>
            </li>
          </ul>
        </div>
      </section>

      <!-- 周 / 月 / 年 -->
      <section class="card section">
        <div class="period-head">
          <div class="segmented" role="group" :aria-label="t('stats.periodAria')">
            <button
              v-for="m in MODES"
              :key="m"
              type="button"
              :class="{ active: mode === m }"
              :aria-pressed="mode === m"
              @click="mode = m"
            >{{ t(`stats.${m}`) }}</button>
          </div>
          <div class="period-nav">
            <button type="button" class="btn btn-ghost btn-sm btn-icon" :title="t('stats.prev')" :aria-label="t('stats.prev')" @click="offset--">
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M14.7 5.3a1 1 0 0 1 0 1.4L9.41 12l5.3 5.3a1 1 0 0 1-1.42 1.4l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 1.42 0z" /></svg>
            </button>
            <span class="period-title">{{ period.title }}</span>
            <button type="button" class="btn btn-ghost btn-sm btn-icon" :title="t('stats.next')" :aria-label="t('stats.next')" :disabled="offset >= 0" @click="offset++">
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M9.3 18.7a1 1 0 0 1 0-1.4l5.29-5.3-5.3-5.3a1 1 0 0 1 1.42-1.4l6 6a1 1 0 0 1 0 1.4l-6 6a1 1 0 0 1-1.42 0z" /></svg>
            </button>
            <button v-if="offset !== 0" type="button" class="btn btn-sm" @click="offset = 0">{{ t('stats.backToNow') }}</button>
          </div>
        </div>

        <dl class="period-sum">
          <div><dt>{{ t('stats.periodTotal') }}</dt><dd>{{ fmtTime(period.summary.seconds) }}</dd></div>
          <div><dt>{{ t('stats.dailyAvg') }}</dt><dd>{{ fmtTime(period.avg) }}</dd></div>
          <div><dt>{{ t('stats.periodDays') }}</dt><dd>{{ t('stats.daysValue', { n: period.summary.activeDays }) }}</dd></div>
        </dl>

        <div class="chart" :class="`chart-${mode}`" role="img" :aria-label="chartAria">
          <div class="chart-plot">
            <div class="grid-line top"><span>{{ axisLabel(chartMax) }}</span></div>
            <div class="grid-line mid" />
            <div
              v-if="goalLineSeconds"
              class="goal-line"
              :style="{ bottom: `${(goalLineSeconds / chartMax) * 100}%` }"
            />
            <div class="bars">
              <div
                v-for="bar in period.bars"
                :key="bar.key"
                class="bar-col"
                :class="{ current: bar.current, future: bar.future }"
                :title="bar.future ? undefined : bar.title"
              >
                <div class="bar" :style="{ height: barHeight(bar.seconds) }" />
              </div>
            </div>
          </div>
          <div class="bar-labels" aria-hidden="true">
            <span v-for="bar in period.bars" :key="bar.key" :class="{ current: bar.current }">{{ bar.label }}</span>
          </div>
          <div v-if="goalLineSeconds" class="chart-legend">
            <span class="goal-swatch" aria-hidden="true" />{{ t('stats.goalLine', { m: goal }) }}
          </div>
        </div>

        <h3 class="books-head">{{ t('stats.booksInPeriod') }}</h3>
        <p v-if="!periodRows.length" class="muted">{{ t('stats.periodEmpty') }}</p>
        <ul v-else class="book-list">
          <li v-for="row in periodRows" :key="row.key">
            <component
              :is="row.book ? 'button' : 'div'"
              class="book-row"
              :class="{ missing: !row.book }"
              :type="row.book ? 'button' : undefined"
              :title="row.book ? t('stats.openBook', { title: row.title }) : t('stats.bookMissing')"
              @click="openRow(row)"
            >
              <span class="book-icon" aria-hidden="true">
                <svg v-if="row.kind === 'paper'" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M6 2h9a1 1 0 0 1 .7.3l4 4a1 1 0 0 1 .3.7v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm8 2H6v16h12V8h-3a1 1 0 0 1-1-1V4zM8 11a1 1 0 0 1 1-1h6a1 1 0 1 1 0 2H9a1 1 0 0 1-1-1zm0 4a1 1 0 0 1 1-1h6a1 1 0 1 1 0 2H9a1 1 0 0 1-1-1z" /></svg>
                <svg v-else viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15.5a2.5 2.5 0 0 1-2.5 2.5H6.5A2.5 2.5 0 0 1 4 18.5v-13zM6.5 5A.5.5 0 0 0 6 5.5V16.05c.16-.03.32-.05.5-.05H18V5H6.5zM6 18.5a.5.5 0 0 0 .5.5H18v-1H6.5a.5.5 0 0 0-.5.5z" /></svg>
              </span>
              <span class="book-main">
                <span class="book-title">{{ row.title }}</span>
                <span v-if="!row.book" class="book-tag">{{ t('stats.bookMissing') }}</span>
                <span v-else-if="row.kind === 'paper'" class="book-tag">{{ t('stats.kindPaper') }}</span>
                <span class="share" aria-hidden="true"><span :style="{ width: `${row.share * 100}%` }" /></span>
              </span>
              <span class="book-time">{{ fmtTime(row.seconds) }}</span>
            </component>
          </li>
        </ul>
      </section>
    </template>

    <p class="note">{{ t('stats.note') }}</p>
  </div>
</template>

<style scoped>
.stats {
  padding: 24px 28px calc(40px + var(--lr-safe-bottom));
  max-width: 980px;
  margin: 0 auto;
}
h1 {
  font-size: 20px;
  font-weight: 650;
  letter-spacing: -0.01em;
  margin-bottom: 18px;
}
h2 {
  font-size: 15px;
  font-weight: 650;
}
h3 {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2);
}
.label {
  color: var(--text-2);
  font-size: 13px;
  font-weight: 500;
}
.num {
  font-variant-numeric: tabular-nums;
  font-weight: 650;
  letter-spacing: -0.02em;
  color: var(--text);
}
.unit {
  margin: 0 6px 0 3px;
  color: var(--text-2);
  font-size: 13px;
  font-weight: 500;
}
.unit:last-child {
  margin-right: 0;
}
.muted {
  color: var(--text-3);
  font-size: 13px;
  padding: 6px 0 2px;
}

/* ---- 概览 ---- */
.overview {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(0, 2fr);
  gap: 14px;
  margin-bottom: 14px;
}
.today-card {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 18px 20px;
}
.ring {
  position: relative;
  width: 108px;
  height: 108px;
  flex-shrink: 0;
}
.ring svg {
  display: block;
  transform: rotate(-90deg);
}
.ring-track,
.ring-fill {
  fill: none;
  stroke-width: 10;
}
.ring-track {
  stroke: var(--surface-3);
}
.ring-fill {
  stroke: var(--brand);
  stroke-linecap: round;
  transition: stroke-dashoffset var(--dur-slow) var(--ease);
}
.ring-fill.done {
  stroke: var(--success);
}
.ring-center {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--brand);
}
.ring-center svg {
  transform: none;
}
.ring-center.done {
  color: var(--success);
}
.ring-pct {
  font-size: 24px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  color: var(--text);
}
.ring-unit {
  font-size: 12px;
  color: var(--text-2);
  margin-left: 1px;
}
.today-body {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.big-value .num {
  font-size: 30px;
  line-height: 1.15;
}
.goal-status {
  color: var(--text-2);
  font-size: 13px;
}
.goal-picker {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  color: var(--text-3);
  font-size: 12px;
}
.goal-select {
  height: var(--control-h-sm);
  font-size: 13px;
  padding-left: 10px;
}
.tiles {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
}
.tile {
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.tile-value .num {
  font-size: 28px;
  line-height: 1.2;
}
.hint {
  color: var(--text-3);
  font-size: 12px;
  line-height: 1.4;
}

.section {
  padding: 18px 20px;
  margin-bottom: 14px;
}
.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

/* ---- 热力图: 级别 0 用轨道色, 1–4 级是叠在轨道上的品牌色不同透明度 (不依赖 color-mix) ---- */
.legend {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--text-3);
  font-size: 12px;
}
.legend > span:first-child {
  margin-right: 4px;
}
.legend > span:last-child {
  margin-left: 4px;
}
.hm-scroll {
  --cell: 12px;
  --gap: 3px;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  padding: 2px 2px 6px;
  scrollbar-width: thin;
}
.hm {
  display: inline-grid;
  grid-template-columns: auto auto;
  grid-template-rows: 16px auto;
  column-gap: 6px;
  row-gap: 4px;
}
.hm-months,
.hm-grid {
  display: grid;
  grid-template-columns: repeat(53, var(--cell));
  column-gap: var(--gap);
}
.hm-months {
  position: relative;
  font-size: 11px;
  color: var(--text-3);
  line-height: 16px;
}
.hm-month {
  grid-row: 1;
  white-space: nowrap;
}
.hm-weekdays {
  display: grid;
  grid-template-rows: repeat(7, var(--cell));
  row-gap: var(--gap);
  font-size: 10px;
  line-height: var(--cell);
  color: var(--text-3);
  text-align: right;
}
.hm-grid {
  grid-template-rows: repeat(7, var(--cell));
  grid-auto-flow: column;
  row-gap: var(--gap);
}
.hm-cell,
.hm-swatch {
  position: relative;
  display: block;
  width: var(--cell, 12px);
  height: var(--cell, 12px);
  padding: 0;
  border: 0;
  border-radius: 3px;
  background: var(--surface-3);
  overflow: hidden;
}
.hm-swatch {
  width: 11px;
  height: 11px;
}
.hm-cell::before,
.hm-swatch::before {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--brand);
  opacity: 0;
}
.l1::before { opacity: 0.3; }
.l2::before { opacity: 0.52; }
.l3::before { opacity: 0.76; }
.l4::before { opacity: 1; }
button.hm-cell {
  cursor: pointer;
  overflow: visible;
}
button.hm-cell::before {
  border-radius: inherit;
}
.hm-empty {
  background: transparent;
}
button.hm-cell.today::after {
  content: '';
  position: absolute;
  inset: -2px;
  border: 1px solid var(--text-3);
  border-radius: 4px;
}
button.hm-cell.selected::after {
  content: '';
  position: absolute;
  inset: -2px;
  border: 2px solid var(--text);
  border-radius: 4px;
}
button.hm-cell:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}

.day-detail {
  margin-top: 12px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}
.day-detail h3 {
  margin-bottom: 6px;
}

/* ---- 周 / 月 / 年 ---- */
.period-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
}
.period-nav {
  display: flex;
  align-items: center;
  gap: 4px;
}
.period-title {
  min-width: 120px;
  text-align: center;
  font-size: 14px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.period-sum {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin: 18px 0 14px;
}
.period-sum dt {
  color: var(--text-3);
  font-size: 12px;
}
.period-sum dd {
  margin-top: 2px;
  font-size: 16px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}
.chart {
  margin-bottom: 18px;
}
.chart-plot {
  position: relative;
  height: 168px;
  margin-top: 18px;
  border-bottom: 1px solid var(--border-strong);
}
.grid-line {
  position: absolute;
  left: 0;
  right: 0;
  border-top: 1px dashed var(--border);
}
.grid-line.top {
  top: 0;
}
.grid-line.mid {
  top: 50%;
}
.grid-line span {
  position: absolute;
  right: 0;
  top: -16px;
  font-size: 11px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.goal-line {
  position: absolute;
  left: 0;
  right: 0;
  z-index: 1;
  border-top: 1.5px dashed var(--success);
  pointer-events: none;
}
.chart-legend {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
  color: var(--text-3);
  font-size: 12px;
}
.goal-swatch {
  width: 16px;
  border-top: 1.5px dashed var(--success);
}
.bars,
.bar-labels {
  display: flex;
  gap: 10px;
}
.bars {
  position: absolute;
  inset: 0;
  align-items: flex-end;
}
.chart-month .bars,
.chart-month .bar-labels {
  gap: 3px;
}
.chart-year .bars,
.chart-year .bar-labels {
  gap: 8px;
}
.bar-col {
  flex: 1;
  min-width: 0;
  height: 100%;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}
.bar {
  width: 100%;
  max-width: 44px;
  border-radius: 4px 4px 0 0;
  background: var(--brand);
  opacity: 0.55;
  transition: opacity var(--dur-fast) var(--ease);
}
.bar-col.current .bar,
.bar-col:hover .bar {
  opacity: 1;
}
.chart-month .bar {
  border-radius: 2px 2px 0 0;
}
.bar-labels {
  margin-top: 6px;
}
.bar-labels span {
  flex: 1;
  min-width: 0;
  text-align: center;
  font-size: 11px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: visible;
}
.bar-labels span.current {
  color: var(--brand);
  font-weight: 600;
}

/* ---- 书列表 ---- */
.books-head {
  margin-bottom: 6px;
}
.book-list {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.book-row {
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  min-height: 44px;
  padding: 6px 10px;
  margin: 0 -10px;
  width: calc(100% + 20px);
  border: 0;
  border-radius: var(--radius);
  background: transparent;
  color: var(--text);
  font: inherit;
  text-align: left;
}
button.book-row {
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease);
}
button.book-row:hover {
  background: var(--surface-2);
}
button.book-row:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.book-icon {
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border-radius: var(--radius-sm);
  background: var(--brand-soft);
  color: var(--brand);
}
.book-main {
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  column-gap: 8px;
  row-gap: 4px;
}
.book-title {
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
}
.book-tag {
  flex-shrink: 0;
  padding: 0 6px;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  color: var(--text-3);
  font-size: 11px;
  line-height: 18px;
}
.share {
  flex-basis: 100%;
  height: 3px;
  border-radius: 2px;
  background: var(--surface-2);
  overflow: hidden;
}
.share span {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: var(--brand);
  opacity: 0.6;
}
.book-time {
  color: var(--text-2);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.book-row.missing {
  color: var(--text-3);
}
.book-row.missing .book-icon {
  background: var(--surface-2);
  color: var(--text-3);
}
.book-row.missing .book-time {
  color: var(--text-3);
}
.book-row.missing .share span {
  background: var(--text-3);
}

.empty-card {
  margin-bottom: 14px;
}
.empty-desc {
  max-width: 360px;
  font-size: 13px;
  line-height: 1.6;
}
.note {
  margin-top: 6px;
  color: var(--text-3);
  font-size: 12px;
  line-height: 1.6;
}

@media (max-width: 960px) {
  .overview {
    grid-template-columns: minmax(0, 1fr);
  }
}
@media (max-width: 720px) {
  .stats {
    padding: 16px 16px calc(24px + var(--lr-safe-bottom));
  }
  h1 {
    font-size: 18px;
    margin-bottom: 14px;
  }
  .overview,
  .tiles {
    gap: 10px;
  }
  .today-card {
    padding: 16px;
    gap: 14px;
  }
  .tile {
    padding: 12px;
  }
  .tile-value .num {
    font-size: 22px;
  }
  .section {
    padding: 16px;
  }
  .period-head {
    flex-direction: column;
    align-items: stretch;
  }
  .period-head .segmented {
    align-self: flex-start;
  }
  .period-nav {
    justify-content: space-between;
  }
  .period-title {
    flex: 1;
  }
  .chart-plot {
    height: 140px;
  }
  .period-sum dd {
    font-size: 14px;
  }
  .bars,
  .bar-labels {
    gap: 6px;
  }
  .chart-month .bars,
  .chart-month .bar-labels {
    gap: 2px;
  }
  .chart-year .bars,
  .chart-year .bar-labels {
    gap: 4px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .ring-fill,
  .bar {
    transition: none;
  }
}
</style>
