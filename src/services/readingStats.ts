/**
 * 阅读记录的聚合计算: 纯函数, 不依赖 vue / dexie, 可在 node 里直接测试.
 * 日期一律是 `YYYY-MM-DD` 字符串, 加减与星期按 UTC 运算 (与时区、夏令时无关);
 * 「今天」由调用方用 readingLog.localDay() 按本地时区给出.
 */

export interface DayBook {
  /** 聚合键: `id:<bookId>` / `h:<hash>` / `t:<书名>` */
  key: string
  bookId?: string
  title: string
  kind: 'book' | 'paper'
  seconds: number
}

export interface DayEntry {
  seconds: number
  /** 按秒数降序 */
  books: DayBook[]
}

/** 键: YYYY-MM-DD */
export type DailyMap = Record<string, DayEntry>

/** 当天读满 1 分钟才算「阅读天」 */
export const ACTIVE_DAY_SECONDS = 60

const DAY_MS = 86_400_000
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

function dayToUtc(day: string): number {
  const m = DAY_RE.exec(day)
  if (!m) throw new RangeError(`invalid day: ${day}`)
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

function utcToDay(ms: number): string {
  const d = new Date(ms)
  const y = d.getUTCFullYear()
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0')
  const da = String(d.getUTCDate()).padStart(2, '0')
  return `${String(y).padStart(4, '0')}-${mo}-${da}`
}

export function addDays(day: string, n: number): string {
  return utcToDay(dayToUtc(day) + n * DAY_MS)
}

/** 0 = 周日 … 6 = 周六 */
export function dayOfWeek(day: string): number {
  return new Date(dayToUtc(day)).getUTCDay()
}

const isActive = (e: DayEntry | undefined) => !!e && e.seconds >= ACTIVE_DAY_SECONDS

/**
 * 连续阅读天数. current: 今天读满就从今天往前数; 今天还没读满则从昨天往前数
 * (今天还有机会续上, 不算断). longest: 历史最长连续天数.
 */
export function streaks(daily: DailyMap, today: string): { current: number; longest: number } {
  let current = 0
  let cursor = isActive(daily[today]) ? today : addDays(today, -1)
  while (isActive(daily[cursor])) {
    current++
    cursor = addDays(cursor, -1)
  }

  const days = Object.keys(daily).filter(d => DAY_RE.test(d) && isActive(daily[d])).sort()
  let longest = 0
  let run = 0
  let prev: string | undefined
  for (const d of days) {
    run = prev !== undefined && addDays(prev, 1) === d ? run + 1 : 1
    if (run > longest) longest = run
    prev = d
  }
  return { current, longest: Math.max(longest, current) }
}

/** [from, to] 两端都含的汇总; books 跨天按 key 合并, 按秒数降序 */
export function rangeSummary(
  daily: DailyMap,
  from: string,
  to: string,
): { seconds: number; activeDays: number; books: DayBook[] } {
  let seconds = 0
  let activeDays = 0
  const books = new Map<string, DayBook>()
  for (const [day, entry] of Object.entries(daily)) {
    if (!DAY_RE.test(day) || day < from || day > to) continue
    seconds += entry.seconds
    if (isActive(entry)) activeDays++
    for (const b of entry.books) {
      const prev = books.get(b.key)
      if (prev) {
        prev.seconds += b.seconds
        if (!prev.bookId && b.bookId) prev.bookId = b.bookId
      } else {
        books.set(b.key, { ...b })
      }
    }
  }
  return { seconds, activeDays, books: sortBooks([...books.values()]) }
}

export function sortBooks(books: DayBook[]): DayBook[] {
  return books.sort((a, b) => b.seconds - a.seconds || a.title.localeCompare(b.title) || a.key.localeCompare(b.key))
}

/**
 * 年度热力图: 返回若干列, 每列是一周 7 格 (从 weekStart 开始), 最后一列含今天.
 * 今天之后的格子为 null. 默认 53 周、周一起.
 */
export function heatmap(
  daily: DailyMap,
  today: string,
  weeks = 53,
  weekStart: 0 | 1 = 1,
): Array<Array<{ day: string; seconds: number } | null>> {
  const offset = (dayOfWeek(today) - weekStart + 7) % 7
  const lastWeekStart = addDays(today, -offset)
  const first = addDays(lastWeekStart, -7 * (Math.max(1, weeks) - 1))
  const cols: Array<Array<{ day: string; seconds: number } | null>> = []
  for (let w = 0; w < Math.max(1, weeks); w++) {
    const col: Array<{ day: string; seconds: number } | null> = []
    for (let i = 0; i < 7; i++) {
      const day = addDays(first, w * 7 + i)
      col.push(day > today ? null : { day, seconds: daily[day]?.seconds ?? 0 })
    }
    cols.push(col)
  }
  return cols
}

export function totalActiveDays(daily: DailyMap): number {
  return Object.values(daily).filter(isActive).length
}
