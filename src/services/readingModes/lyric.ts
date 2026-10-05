/**
 * 歌词模式的纯函数 (docs/research/reading-modes-landscape.md §4): 视觉行 → 行区间与停留时间、聚焦窗口、
 * 定位到 40% 处的滚动量、墨水屏整屏跳、点按命中、跟听书的语速估计。DOM 部分见 lyricController.ts。
 *
 * 行不是自己切的: 每个出字单位 (汉字、西文整词) 取浏览器排版后的 rect.top, 用 pacing.groupLines 归并,
 * 所以中文按字断行、西文按词断行、标点禁则都由浏览器决定。
 */
import { ATOM_MS, PAUSE_PARAGRAPH, groupLines, type Token } from './pacing.ts'

export type LyricLineKind = 'text' | 'heading' | 'code' | 'atom'

export interface LineSpan {
  /** [start, end) 为窗口内偏移; 相邻行首尾相接 (行末的收尾标点、空白归本行, 开引号归下一行) */
  start: number
  end: number
  /** 字当量之和 */
  weight: number
  /** 行内与行末停顿之和 (单字时长的倍数; 相邻标点取最大, 段末 +4) */
  pause: number
  /** 行末是段落结束 */
  para: boolean
}

export interface LyricLine extends LineSpan {
  /** 行框在分节文档坐标里的上下沿 (滚动排版下 iframe 不滚动, 文档坐标即内容坐标) */
  top: number
  bottom: number
  left: number
  kind: LyricLineKind
  /** 原子块 (图片) 的元素与相对视口的高度比 */
  el?: Element
  ratio?: number
}

/** 有 rect 的出字单位 → 视觉行区间 (tops 与 tokens 中 weight > 0 的项一一对应) */
export function lineSpans(
  tokens: readonly Token[],
  tops: readonly number[],
  lineHeight: number,
  breaks: readonly number[] = [],
): LineSpan[] {
  const weighted: number[] = []
  tokens.forEach((t, i) => { if (t.weight > 0) weighted.push(i) })
  if (!weighted.length || tops.length !== weighted.length) return []
  const groups = groupLines(tops, lineHeight)
  const out: LineSpan[] = []
  // 行与行的分界: 本行最后一个出字单位之后, 第一个出字单位或开引号的起点
  const boundaryAfter = (tokIdx: number): number => {
    for (let k = tokIdx + 1; k < tokens.length; k++) {
      if (tokens[k].weight > 0 || tokens[k].open || tokens[k].kind === 'atom') return tokens[k].start
    }
    return tokens[tokens.length - 1].end
  }
  let prevEnd = tokens[weighted[0]].start
  // 第一行前面的开引号
  for (let k = weighted[0] - 1; k >= 0 && tokens[k].open; k--) prevEnd = tokens[k].start
  let bi = 0
  // 窗口第一行之前的段落边界不属于任何行
  while (bi < breaks.length && breaks[bi] <= tokens[weighted[0]].start) bi++
  groups.forEach(([a, b], gi) => {
    const first = weighted[a]
    const last = weighted[b - 1]
    const isLast = gi === groups.length - 1
    const end = isLast ? Math.max(boundaryAfter(last), tokens[last].end) : boundaryAfter(last)
    const nextStart = isLast ? Infinity : tokens[weighted[b]].start
    let weight = 0
    let pause = 0
    let cluster = 0
    for (let k = first; k < tokens.length && tokens[k].start < end; k++) {
      const tok = tokens[k]
      if (tok.weight > 0) {
        if (k > first) {
          // 行内换段 (<br>): 段末停顿记在它之前
          while (bi < breaks.length && breaks[bi] <= tok.start) {
            cluster = Math.max(cluster, PAUSE_PARAGRAPH)
            bi++
          }
          pause += cluster
          cluster = 0
        }
        weight += tok.weight
      } else if (tok.pause) cluster = Math.max(cluster, tok.pause)
    }
    // 行末到下一行第一个字之间的段落边界: 这一行是段末
    let para = false
    while (bi < breaks.length && breaks[bi] <= nextStart) {
      para = true
      bi++
    }
    if (para) cluster = Math.max(cluster, PAUSE_PARAGRAPH)
    pause += cluster
    out.push({ start: prevEnd, end, weight, pause, para })
    prevEnd = end
  })
  return out
}

export interface DwellOptions {
  punctuationPause?: boolean
  /** 停留下限, 默认 300ms (只有标点或极短的行) */
  minMs?: number
}

/**
 * 一行的停留时间 = (字当量 + 标点停顿) ÷ 速度; 标题 ×1.5, 代码 ×0.5 (速度 ×2, 同打字机);
 * 图片等原子块 max(1.2 秒, 高度 ÷ 视口高度 × 2 秒)。
 */
export function lineDwellMs(
  line: { weight: number; pause: number; kind?: LyricLineKind; ratio?: number },
  unitsPerMinute: number,
  opts: DwellOptions = {},
): number {
  if (line.kind === 'atom') return Math.max(ATOM_MS, (line.ratio ?? 0) * 2000)
  const unitMs = 60000 / Math.max(1, unitsPerMinute)
  const pause = opts.punctuationPause === false ? 0 : line.pause
  let ms = (line.weight + pause) * unitMs
  if (line.kind === 'heading') ms *= 1.5
  else if (line.kind === 'code') ms *= 0.5
  return Math.max(opts.minMs ?? 300, ms)
}

/** 面板上的「≈ 2.6 秒/行」 */
export function secondsPerLine(unitsPerLine: number, unitsPerMinute: number): number {
  return Math.round((Math.max(0, unitsPerLine) * 60 / Math.max(1, unitsPerMinute)) * 10) / 10
}

/** 测量前的估计: 一行能放几个字 (字宽约等于字号) */
export function estimateUnitsPerLine(viewportWidth: number, fontSize: number, gapPercent: number, letterSpacingEm = 0): number {
  const usable = viewportWidth * (1 - Math.min(40, Math.max(0, gapPercent)) * 2 / 100)
  return Math.max(4, Math.floor(usable / (Math.max(8, fontSize) * (1 + letterSpacingEm))))
}

/** 聚焦窗口 [lo, hi] (含): 1 行为当前行; 3 行为上下各一行, 到首末行时不越界 */
export function focusWindow(index: number, count: 1 | 3, total: number): [number, number] {
  if (total <= 0) return [0, -1]
  const i = Math.min(total - 1, Math.max(0, index))
  if (count === 1) return [i, i]
  return [Math.max(0, i - 1), Math.min(total - 1, i + 1)]
}

/** 让行中心落在视口 anchor 处需要滚动的量 (正数向下滚, 内容上移) */
export function pinDelta(lineTop: number, lineBottom: number, viewportTop: number, viewportHeight: number, anchor: number): number {
  return (lineTop + lineBottom) / 2 - (viewportTop + viewportHeight * anchor)
}

/**
 * 墨水屏整屏跳: 当前行越过视口 80% 或跑到视口上方时, 一次性把它放到视口 10% 处; 否则不动 (null)。
 * 每行都滚会让墨水屏不停刷新残影。
 */
export function einkJumpDelta(lineTop: number, lineBottom: number, viewportTop: number, viewportHeight: number): number | null {
  const relBottom = (lineBottom - viewportTop) / viewportHeight
  const relTop = (lineTop - viewportTop) / viewportHeight
  if (relBottom <= 0.8 && relTop >= 0) return null
  return lineTop - (viewportTop + viewportHeight * 0.1)
}

/** 行在视口的哪一侧: 'above' / 'below' / null (可见) */
export function lineSide(lineTop: number, lineBottom: number, viewportTop: number, viewportHeight: number): 'above' | 'below' | null {
  if (lineBottom <= viewportTop + 1) return 'above'
  if (lineTop >= viewportTop + viewportHeight - 1) return 'below'
  return null
}

/** 点按的 y (文档坐标) 落在哪一行; 行间空白归最近的行, 离所有行都超过 maxGap 时为 -1 */
export function lineAt(lines: ReadonlyArray<{ top: number; bottom: number }>, y: number, maxGap = 24): number {
  let lo = 0
  let hi = lines.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid].top <= y) {
      ans = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  const candidates = [ans, ans + 1].filter(i => i >= 0 && i < lines.length)
  let best = -1
  let bestDist = Infinity
  for (const i of candidates) {
    const l = lines[i]
    const d = y < l.top ? l.top - y : y > l.bottom ? y - l.bottom : 0
    if (d < bestDist) {
      best = i
      bestDist = d
    }
  }
  return bestDist <= maxGap ? best : -1
}

/** 偏移所在的行 (最后一个 start ≤ offset 的行); 空表为 -1 */
export function lineIndexOf(lines: ReadonlyArray<{ start: number; end: number }>, offset: number): number {
  if (!lines.length) return -1
  let lo = 0
  let hi = lines.length - 1
  let ans = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid].start <= offset) {
      ans = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return ans
}

/**
 * 跟听书: 一句话跨多行时, 按已读比例 (按字当量) 落到第几行。weights 为这句话在各行里的字当量。
 */
export function lineForProgress(weights: readonly number[], fraction: number): number {
  if (!weights.length) return 0
  const total = weights.reduce((s, w) => s + Math.max(0, w), 0)
  if (total <= 0) return 0
  const target = Math.min(1, Math.max(0, fraction)) * total
  let acc = 0
  for (let i = 0; i < weights.length; i++) {
    acc += Math.max(0, weights[i])
    if (target < acc) return i
  }
  return weights.length - 1
}

/**
 * 听书语速估计 (毫秒/字当量): 两句开始的时间差 ÷ 上一句的字当量, 指数平滑;
 * 异常值 (暂停、跳句) 收敛到 60–2000ms。
 */
export function updateFollowRate(prev: number | null, elapsedMs: number, weight: number): number | null {
  if (!(weight > 0) || !(elapsedMs > 0)) return prev
  const sample = Math.min(2000, Math.max(60, elapsedMs / weight))
  return prev == null ? sample : prev * 0.7 + sample * 0.3
}
