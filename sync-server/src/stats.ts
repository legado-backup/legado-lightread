/**
 * 匿名使用统计 (docs/usage-stats-plan.md, 接口见 docs/account-api.md「匿名使用统计」)
 *
 * 只存: 随机安装 ID、平台、版本、界面语言、当天是否打开过阅读器. 不存 IP / UA / 任何阅读内容.
 *  - pings(day, install_id, …): 每个安装每天一行, 按北京时间切天; 保留 90 天
 *  - installs(install_id, first_day, last_day, …): 装机量与新增 / 留存的依据, 长期保留 (只有随机 ID)
 *  - ping_daily(day, platform, version, …): 超过 90 天的 pings 按天聚合后的计数
 *  - dj_daily(day, install_id, …): 点睛阅读的按天汇总 (心跳里可选的 dj 字段, 客户端补报已过完的日子):
 *    各点睛状态的中文阅读分钟、重点词各密度档的分钟、AI 重点词可用块数、找不到的词数。不含书名、正文、具体的词。
 *    保留 90 天, 之后按 (天, 版本) 聚合进 dj_rollup
 */

import type { D1Database } from './index'

export const PLATFORMS = ['windows', 'macos', 'linux', 'android', 'ios', 'web', 'other'] as const
export const LANGS = ['zh', 'en'] as const
export type Platform = (typeof PLATFORMS)[number]

/** 点睛阅读一天的汇总 (客户端 usageStatsCore.DjDay) */
export interface DjDay {
  d: string
  /** 中文阅读分钟 [关, 词与词, 重点词, 智能] */
  m: [number, number, number, number]
  /** 重点词各密度档分钟 [少, 适中, 多] */
  lv: [number, number, number]
  /** AI 重点词可用块数 / 请求块数 */
  ai: [number, number]
  /** AI 重点词找不到的个数 / 总个数 */
  nf: [number, number]
}

export interface Ping {
  id: string
  platform: Platform
  version: string
  lang: 'zh' | 'en'
  reader: boolean
  /** 校验通过的点睛汇总 (没有或全部不合法时为空数组) */
  dj: DjDay[]
}

/** 一次心跳最多补报几天 / 只收最近几天 */
export const DJ_MAX_DAYS = 3
export const DJ_LOOKBACK_DAYS = 7
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

const intArray = (v: unknown, len: number, max: number): number[] | null => {
  if (!Array.isArray(v) || v.length !== len) return null
  for (const x of v) if (typeof x !== 'number' || !Number.isInteger(x) || x < 0 || x > max) return null
  return v as number[]
}

/**
 * 校验心跳里的 dj (可选): 不合法的那一天直接丢掉, 不影响心跳本身。
 * 只收已过完、7 天以内的日子 (按服务端北京日判断), 同一天只取第一条。
 */
export function parseDj(v: unknown, today: string): DjDay[] {
  if (!Array.isArray(v)) return []
  const oldest = addDays(today, -DJ_LOOKBACK_DAYS)
  const out: DjDay[] = []
  for (const item of v.slice(0, DJ_MAX_DAYS)) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const x = item as Record<string, unknown>
    if (typeof x.d !== 'string' || !DAY_RE.test(x.d) || x.d >= today || x.d < oldest) continue
    if (out.some(o => o.d === x.d)) continue
    const m = intArray(x.m, 4, 1440)
    const lv = intArray(x.lv, 3, 1440)
    const ai = intArray(x.ai, 2, 99999)
    const nf = intArray(x.nf, 2, 99999)
    if (!m || !lv || !ai || !nf) continue
    if (ai[0] > ai[1] || nf[0] > nf[1]) continue
    out.push({ d: x.d, m: m as DjDay['m'], lv: lv as DjDay['lv'], ai: ai as DjDay['ai'], nf: nf as DjDay['nf'] })
  }
  return out
}

/** 原始 pings 保留天数 */
export const RAW_RETENTION_DAYS = 90
/** 统计接口最多回看的天数 */
export const MAX_STATS_DAYS = 365

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const VERSION_RE = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/
const DAY_MS = 86_400_000
const BEIJING_OFFSET = 8 * 3_600_000

/** 北京时间 (Asia/Shanghai, 无夏令时) 的日期 YYYY-MM-DD */
export const beijingDay = (now = Date.now()) => new Date(now + BEIJING_OFFSET).toISOString().slice(0, 10)

/** 日期加减天数 (YYYY-MM-DD, 按日历日计算, 与时区无关) */
export const addDays = (day: string, n: number) =>
  new Date(Date.parse(day + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10)

/** 严格校验上报内容; 多余字段忽略, 其它任何偏差都返回 null (可选的 dj 不合法只丢那几天) */
export function parsePing(body: unknown, today = beijingDay()): Ping | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const b = body as Record<string, unknown>
  if (typeof b.id !== 'string' || !UUID_V4_RE.test(b.id)) return null
  if (typeof b.platform !== 'string' || !(PLATFORMS as readonly string[]).includes(b.platform)) return null
  if (typeof b.version !== 'string' || !VERSION_RE.test(b.version)) return null
  if (typeof b.lang !== 'string' || !(LANGS as readonly string[]).includes(b.lang)) return null
  if (typeof b.reader !== 'boolean') return null
  return {
    id: b.id.toLowerCase(),
    platform: b.platform as Platform,
    version: b.version,
    lang: b.lang as 'zh' | 'en',
    reader: b.reader,
    dj: parseDj(b.dj, today),
  }
}

/** 记一次心跳: 同一安装同一天只一行, reader 取「或」, 平台 / 版本 / 语言取最新 */
export async function recordPing(db: D1Database, ping: Ping, day: string): Promise<void> {
  // 点睛汇总: 同一安装同一天一行, 重复上报以最后一次为准 (客户端一天只补报一次)
  const dj = (ping.dj ?? []).map(x =>
    db
      .prepare(
        'INSERT INTO dj_daily(day, install_id, platform, version, min_off, min_words, min_key, min_smart, ' +
          'lv_low, lv_mid, lv_high, ai_ok, ai_all, kw_missing, kw_all) ' +
          'VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15) ' +
          'ON CONFLICT(day, install_id) DO UPDATE SET platform = excluded.platform, version = excluded.version, ' +
          'min_off = excluded.min_off, min_words = excluded.min_words, min_key = excluded.min_key, min_smart = excluded.min_smart, ' +
          'lv_low = excluded.lv_low, lv_mid = excluded.lv_mid, lv_high = excluded.lv_high, ai_ok = excluded.ai_ok, ' +
          'ai_all = excluded.ai_all, kw_missing = excluded.kw_missing, kw_all = excluded.kw_all',
      )
      .bind(x.d, ping.id, ping.platform, ping.version, ...x.m, ...x.lv, ...x.ai, ...x.nf),
  )
  await db.batch([
    db
      .prepare(
        'INSERT INTO pings(day, install_id, platform, version, lang, reader) VALUES(?1, ?2, ?3, ?4, ?5, ?6) ' +
          'ON CONFLICT(day, install_id) DO UPDATE SET platform = excluded.platform, version = excluded.version, ' +
          'lang = excluded.lang, reader = MAX(reader, excluded.reader)',
      )
      .bind(day, ping.id, ping.platform, ping.version, ping.lang, ping.reader ? 1 : 0),
    db
      .prepare(
        'INSERT INTO installs(install_id, first_day, last_day, platform, version) VALUES(?1, ?2, ?2, ?3, ?4) ' +
          'ON CONFLICT(install_id) DO UPDATE SET first_day = MIN(first_day, excluded.first_day), ' +
          'last_day = MAX(last_day, excluded.last_day), platform = excluded.platform, version = excluded.version',
      )
      .bind(ping.id, day, ping.platform, ping.version),
  ])
  // 点睛汇总单独一批: 表还没建 (先部署了 Worker) 或写入失败时, 心跳本身照常记下
  if (dj.length) {
    try {
      await db.batch(dj)
    } catch (e) {
      console.warn('dj_daily write failed', (e as Error)?.message)
    }
  }
}

/**
 * 每日保留策略: 早于 today-90 的原始 pings 按 (天, 平台, 版本) 聚合进 ping_daily 后删除.
 * 两条语句同一批次执行 (原子), 重跑无副作用.
 */
export function rollupStatements(db: D1Database, today: string) {
  const cutoff = addDays(today, -RAW_RETENTION_DAYS)
  return [
    db
      .prepare(
        'INSERT INTO ping_daily(day, platform, version, actives, readers, new_installs) ' +
          'SELECT p.day, p.platform, p.version, COUNT(*), SUM(p.reader), ' +
          'SUM(CASE WHEN i.first_day = p.day THEN 1 ELSE 0 END) ' +
          'FROM pings p LEFT JOIN installs i ON i.install_id = p.install_id ' +
          'WHERE p.day < ?1 GROUP BY p.day, p.platform, p.version ' +
          'ON CONFLICT(day, platform, version) DO UPDATE SET actives = actives + excluded.actives, ' +
          'readers = readers + excluded.readers, new_installs = new_installs + excluded.new_installs',
      )
      .bind(cutoff),
    db.prepare('DELETE FROM pings WHERE day < ?1').bind(cutoff),
  ]
}

/** 点睛汇总的保留策略 (同上, 单独一批: 表还没建时不拖累其他清理) */
export function djRollupStatements(db: D1Database, today: string) {
  const cutoff = addDays(today, -RAW_RETENTION_DAYS)
  return [
    db
      .prepare(
        'INSERT INTO dj_rollup(day, version, installs, users_key, users_smart, min_off, min_words, min_key, min_smart, ' +
          'lv_low, lv_mid, lv_high, ai_ok, ai_all, kw_missing, kw_all) ' +
          'SELECT day, version, COUNT(*), SUM(min_key > 0), SUM(min_smart > 0), SUM(min_off), SUM(min_words), SUM(min_key), ' +
          'SUM(min_smart), SUM(lv_low), SUM(lv_mid), SUM(lv_high), SUM(ai_ok), SUM(ai_all), SUM(kw_missing), SUM(kw_all) ' +
          'FROM dj_daily WHERE day < ?1 GROUP BY day, version ' +
          'ON CONFLICT(day, version) DO UPDATE SET installs = installs + excluded.installs, ' +
          'users_key = users_key + excluded.users_key, users_smart = users_smart + excluded.users_smart, ' +
          'min_off = min_off + excluded.min_off, min_words = min_words + excluded.min_words, ' +
          'min_key = min_key + excluded.min_key, min_smart = min_smart + excluded.min_smart, ' +
          'lv_low = lv_low + excluded.lv_low, lv_mid = lv_mid + excluded.lv_mid, lv_high = lv_high + excluded.lv_high, ' +
          'ai_ok = ai_ok + excluded.ai_ok, ai_all = ai_all + excluded.ai_all, ' +
          'kw_missing = kw_missing + excluded.kw_missing, kw_all = kw_all + excluded.kw_all',
      )
      .bind(cutoff),
    db.prepare('DELETE FROM dj_daily WHERE day < ?1').bind(cutoff),
  ]
}

// ---- 统计 ----

export interface DailyPoint {
  day: string
  actives: number
  readers: number
  newInstalls: number
}
export interface Cohort {
  day: string
  size: number
  /** 第 N 天回访的安装数; 未到期为 null */
  d1n: number | null
  d7n: number | null
  d30n: number | null
  /** 回访率 0..1; 未到期为 null */
  d1: number | null
  d7: number | null
  d30: number | null
}

const n = (v: unknown) => Number(v ?? 0) || 0
const ratio = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 10000) / 10000 : null)

/** 回看的留存群组天数 (首日在 today-COHORT_DAYS .. today-1), 让最早的群组也能算到 30 日留存 */
const COHORT_DAYS = 40

export async function computeStats(db: D1Database, today: string, days: number, now = Date.now()) {
  const start = addDays(today, -(days - 1))
  const d7 = addDays(today, -6)
  const d30 = addDays(today, -29)
  const yesterday = addDays(today, -1)
  const cohortStart = addDays(today, -COHORT_DAYS)

  const [
    totals,
    active,
    rawDaily,
    oldDaily,
    newDaily,
    platforms,
    versions,
    langs,
    cohortRows,
    avgRow,
  ] = await db.batch([
    db
      .prepare(
        'SELECT COUNT(*) AS installs, ' +
          'SUM(first_day = ?1) AS newToday, SUM(first_day >= ?2) AS new7d, SUM(first_day >= ?3) AS new30d ' +
          'FROM installs',
      )
      .bind(today, d7, d30),
    db
      .prepare(
        'SELECT COUNT(DISTINCT install_id) AS mau, ' +
          'COUNT(DISTINCT CASE WHEN day >= ?2 THEN install_id END) AS wau, ' +
          'SUM(day = ?3) AS dau, SUM(day = ?4) AS dauYesterday FROM pings WHERE day >= ?1',
      )
      .bind(d30, d7, today, yesterday),
    db
      .prepare('SELECT day, COUNT(*) AS actives, SUM(reader) AS readers FROM pings WHERE day >= ?1 GROUP BY day')
      .bind(start),
    db
      .prepare(
        'SELECT day, SUM(actives) AS actives, SUM(readers) AS readers FROM ping_daily WHERE day >= ?1 GROUP BY day',
      )
      .bind(start),
    db.prepare('SELECT first_day AS day, COUNT(*) AS n FROM installs WHERE first_day >= ?1 GROUP BY first_day').bind(start),
    // 平台按月活 (installs 记的是最新平台)
    db
      .prepare('SELECT platform AS name, COUNT(*) AS n FROM installs WHERE last_day >= ?1 GROUP BY platform ORDER BY n DESC')
      .bind(d30),
    // 版本按近 7 天活跃 (最新版本)
    db
      .prepare('SELECT version AS name, COUNT(*) AS n FROM installs WHERE last_day >= ?1 GROUP BY version ORDER BY n DESC')
      .bind(d7),
    // 语言按月活, 取每个安装近 30 天里最近一天的语言
    db
      .prepare(
        'SELECT p.lang AS name, COUNT(*) AS n FROM pings p ' +
          'JOIN (SELECT install_id, MAX(day) AS day FROM pings WHERE day >= ?1 GROUP BY install_id) l ' +
          'ON l.install_id = p.install_id AND l.day = p.day GROUP BY p.lang ORDER BY n DESC',
      )
      .bind(d30),
    db
      .prepare(
        'SELECT i.first_day AS day, COUNT(*) AS size, ' +
          "SUM(EXISTS(SELECT 1 FROM pings p WHERE p.day = date(i.first_day, '+1 day') AND p.install_id = i.install_id)) AS r1, " +
          "SUM(EXISTS(SELECT 1 FROM pings p WHERE p.day = date(i.first_day, '+7 day') AND p.install_id = i.install_id)) AS r7, " +
          "SUM(EXISTS(SELECT 1 FROM pings p WHERE p.day = date(i.first_day, '+30 day') AND p.install_id = i.install_id)) AS r30 " +
          'FROM installs i WHERE i.first_day >= ?1 AND i.first_day < ?2 GROUP BY i.first_day ORDER BY i.first_day DESC',
      )
      .bind(cohortStart, today),
    // 近 30 天里第一天有数据的日子, 以及其中完整日子 (今天之前) 的活跃总数
    db.prepare('SELECT MIN(day) AS first, SUM(day < ?2) AS complete FROM pings WHERE day >= ?1').bind(d30, today),
  ])

  // 每日序列: 90 天内来自原始 pings, 更早的来自聚合表; 新增来自 installs (长期保留)
  const byDay = new Map<string, DailyPoint>()
  for (let d = start; d <= today; d = addDays(d, 1)) byDay.set(d, { day: d, actives: 0, readers: 0, newInstalls: 0 })
  for (const r of [...oldDaily.results, ...rawDaily.results] as Record<string, unknown>[]) {
    const p = byDay.get(String(r.day))
    if (p) {
      p.actives += n(r.actives)
      p.readers += n(r.readers)
    }
  }
  for (const r of newDaily.results as Record<string, unknown>[]) {
    const p = byDay.get(String(r.day))
    if (p) p.newInstalls = n(r.n)
  }
  const daily = [...byDay.values()]

  const t = (totals.results[0] ?? {}) as Record<string, unknown>
  const a = (active.results[0] ?? {}) as Record<string, unknown>
  const mau = n(a.mau)

  // 黏性 = 近 30 天的平均日活 / 月活. 平均日活只算完整的日子 (不含今天),
  // 且从开始有数据的那天算起, 免得刚上线时被空白日子拉低; 还没有完整的一天时用今天的日活
  const av = (avgRow.results[0] ?? {}) as Record<string, unknown>
  const windowStart = typeof av.first === 'string' && av.first > d30 ? av.first : d30
  const completeDays = Math.round((Date.parse(today) - Date.parse(windowStart)) / DAY_MS)
  const avgDau = completeDays > 0 ? n(av.complete) / completeDays : n(a.dau)

  const cohorts: Cohort[] = (cohortRows.results as Record<string, unknown>[]).map(r => {
    const day = String(r.day)
    const size = n(r.size)
    const due = (k: number) => addDays(day, k) <= yesterday // 第 k 天已过完才算
    const d1n = due(1) ? n(r.r1) : null
    const d7n = due(7) ? n(r.r7) : null
    const d30n = due(30) ? n(r.r30) : null
    return {
      day,
      size,
      d1n,
      d7n,
      d30n,
      d1: d1n === null ? null : ratio(d1n, size),
      d7: d7n === null ? null : ratio(d7n, size),
      d30: d30n === null ? null : ratio(d30n, size),
    }
  })
  // 汇总留存: 已到期群组按人数加权
  const pooled = (key: 'd1n' | 'd7n' | 'd30n') => {
    let back = 0
    let size = 0
    for (const c of cohorts) {
      if (c[key] === null) continue
      back += c[key]!
      size += c.size
    }
    return { rate: ratio(back, size), cohortSize: size }
  }

  const split = (rows: Record<string, unknown>[]) => rows.map(r => ({ name: String(r.name), installs: n(r.n) }))

  // 点睛阅读 (单独查询: 表还没建时其余统计照常)
  let djResults: Record<string, unknown>[] = []
  try {
    djResults = ((await db
      .prepare(
        'SELECT day, COUNT(*) AS installs, SUM(min_off + min_words + min_key + min_smart > 0) AS readers, ' +
          'SUM(min_words > 0) AS users_words, SUM(min_key > 0) AS users_key, SUM(min_smart > 0) AS users_smart, ' +
          'SUM(min_off) AS min_off, SUM(min_words) AS min_words, SUM(min_key) AS min_key, SUM(min_smart) AS min_smart, ' +
          'SUM(lv_low) AS lv_low, SUM(lv_mid) AS lv_mid, SUM(lv_high) AS lv_high, SUM(ai_ok) AS ai_ok, SUM(ai_all) AS ai_all, ' +
          'SUM(kw_missing) AS kw_missing, SUM(kw_all) AS kw_all FROM dj_daily WHERE day >= ?1 GROUP BY day ORDER BY day',
      )
      .bind(start).all()).results ?? []) as Record<string, unknown>[]
  } catch { /* dj_daily 尚未建表 */ }
  // 点睛阅读: 每天的人数与分钟; 合计里的比例 (重点词采用率、各状态时长占比、密度分布、AI 可用率、找不到率)
  const djDaily = djResults.map(r => ({
    day: String(r.day),
    installs: n(r.installs),
    readers: n(r.readers),
    usersWords: n(r.users_words),
    usersKey: n(r.users_key),
    usersSmart: n(r.users_smart),
    minutes: { off: n(r.min_off), words: n(r.min_words), key: n(r.min_key), smart: n(r.min_smart) },
    density: { low: n(r.lv_low), normal: n(r.lv_mid), high: n(r.lv_high) },
    ai: { usable: n(r.ai_ok), chunks: n(r.ai_all) },
    kw: { missing: n(r.kw_missing), total: n(r.kw_all) },
  }))
  const sum = (f: (x: (typeof djDaily)[number]) => number) => djDaily.reduce((a, x) => a + f(x), 0)
  const djMin = { off: sum(x => x.minutes.off), words: sum(x => x.minutes.words), key: sum(x => x.minutes.key), smart: sum(x => x.minutes.smart) }
  const djTotalMin = djMin.off + djMin.words + djMin.key + djMin.smart
  const djDens = { low: sum(x => x.density.low), normal: sum(x => x.density.normal), high: sum(x => x.density.high) }
  const djDensTotal = djDens.low + djDens.normal + djDens.high
  const dianjing = {
    daily: djDaily,
    totals: {
      minutes: djMin,
      /** 各状态时长占比 (中文阅读分钟) */
      minuteShare: {
        off: ratio(djMin.off, djTotalMin),
        words: ratio(djMin.words, djTotalMin),
        key: ratio(djMin.key, djTotalMin),
        smart: ratio(djMin.smart, djTotalMin),
      },
      /** 重点词采用率: 用过重点词的「安装·天」÷ 读了中文书的「安装·天」 */
      keyAdoption: ratio(sum(x => x.usersKey), sum(x => x.readers)),
      smartAdoption: ratio(sum(x => x.usersSmart), sum(x => x.readers)),
      densityShare: { low: ratio(djDens.low, djDensTotal), normal: ratio(djDens.normal, djDensTotal), high: ratio(djDens.high, djDensTotal) },
      /** 智能版: 有 AI 重点词的块占比; AI 给的词在正文中找不到的比例 */
      aiUsable: ratio(sum(x => x.ai.usable), sum(x => x.ai.chunks)),
      kwMissing: ratio(sum(x => x.kw.missing), sum(x => x.kw.total)),
    },
  }

  return {
    generatedAt: new Date(now).toISOString(),
    timezone: 'Asia/Shanghai',
    today,
    days,
    note:
      '统计的是安装（随机安装 ID），不是人：同一个人的多台设备、重装或清除数据都会算成多个安装；' +
      '关闭了统计的用户不计入。上线前已有的用户会在第一次上报那天计为新增。' +
      '今日数据随上报累积，日活以昨日为准。',
    totals: {
      installs: n(t.installs),
      newToday: n(t.newToday),
      new7d: n(t.new7d),
      new30d: n(t.new30d),
    },
    active: {
      dau: n(a.dau),
      dauYesterday: n(a.dauYesterday),
      wau: n(a.wau),
      mau,
      avgDau30: Math.round(avgDau * 10) / 10,
      /** 平均日活 / 月活, 0..1 */
      stickiness: ratio(avgDau, mau),
    },
    daily,
    platforms: split(platforms.results as Record<string, unknown>[]),
    versions: split(versions.results as Record<string, unknown>[]),
    langs: split(langs.results as Record<string, unknown>[]),
    dianjing,
    retention: {
      d1: pooled('d1n'),
      d7: pooled('d7n'),
      d30: pooled('d30n'),
      cohorts,
    },
  }
}
