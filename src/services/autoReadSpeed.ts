/**
 * 自动翻页 / 自动滚动的速度档位。读者只需要「快一点 / 慢一点」, 不需要换算「几秒一屏」;
 * 底层仍存 settings.autoReadSeconds (秒/屏, 翻页时即秒/页), 老数据与多端同步不变,
 * 不在档位上的旧值显示为最接近的一档。
 */
export type AutoSpeedLevel = 'verySlow' | 'slow' | 'medium' | 'fast' | 'veryFast'

export const AUTO_SPEED_LEVELS: ReadonlyArray<{ level: AutoSpeedLevel; seconds: number; key: string }> = [
  { level: 'verySlow', seconds: 30, key: 'reader.speedVerySlow' },
  { level: 'slow', seconds: 20, key: 'reader.speedSlow' },
  { level: 'medium', seconds: 15, key: 'reader.speedMedium' },
  { level: 'fast', seconds: 10, key: 'reader.speedFast' },
  { level: 'veryFast', seconds: 6, key: 'reader.speedVeryFast' },
]

/** 秒数对应的档位下标 (最接近的一档; 同样接近时取较慢的一档) */
export function autoSpeedIndex(seconds: number): number {
  let best = 2
  let bestDist = Infinity
  AUTO_SPEED_LEVELS.forEach((l, i) => {
    const d = Math.abs(l.seconds - seconds)
    if (d < bestDist) {
      best = i
      bestDist = d
    }
  })
  return best
}

/** 快一档 (dir = 1) / 慢一档 (dir = -1) 后的秒数; 已到头时不变 */
export function stepAutoSpeed(seconds: number, dir: 1 | -1): number {
  const i = Math.min(AUTO_SPEED_LEVELS.length - 1, Math.max(0, autoSpeedIndex(seconds) + dir))
  return AUTO_SPEED_LEVELS[i].seconds
}

/** 档位名的 i18n key */
export function autoSpeedKey(seconds: number): string {
  return AUTO_SPEED_LEVELS[autoSpeedIndex(seconds)].key
}

/**
 * 滑动条位置 (0 = 很慢 … 4 = 很快, 可停在两档之间) 与秒数互换: 相邻两档之间按秒数的对数插值,
 * 拖动时快慢变化均匀。
 */
export function speedPosition(seconds: number): number {
  const L = AUTO_SPEED_LEVELS
  if (seconds >= L[0].seconds) return 0
  if (seconds <= L[L.length - 1].seconds) return L.length - 1
  for (let i = 0; i < L.length - 1; i++) {
    const a = L[i].seconds
    const b = L[i + 1].seconds
    if (seconds <= a && seconds >= b) return i + Math.log(a / seconds) / Math.log(a / b)
  }
  return 2
}

export function secondsAtPosition(pos: number): number {
  const L = AUTO_SPEED_LEVELS
  const p = Math.min(L.length - 1, Math.max(0, pos))
  const i = Math.min(L.length - 2, Math.floor(p))
  const a = L[i].seconds
  const b = L[i + 1].seconds
  const s = a * Math.pow(b / a, p - i)
  // 停在档位上时取整档的秒数, 其余保留一位小数
  return Math.abs(p - Math.round(p)) < 0.02 ? L[Math.round(p)].seconds : Math.round(s * 10) / 10
}
