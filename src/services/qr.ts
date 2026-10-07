/**
 * 无依赖的 QR 码编码器 (ISO/IEC 18004), 用于互传页展示分享链接.
 *
 * 只实现字节模式 (UTF-8): 分享链接最多几百字节, 不需要数字/字母数字/汉字模式的压缩.
 * 算法参照 Nayuki 的参考实现 (qrcodegen): 选最小版本 → 拼比特流 → Reed–Solomon 纠错 →
 * 分块交织 → 绘制功能图形 → 之字形填数据 → 8 种掩码按标准罚分取最小.
 * 纯函数, 不依赖 vue / DOM, 可直接在 node --test 下运行.
 */

export type QrEcl = 'L' | 'M' | 'Q' | 'H'

// 纠错等级在格式信息里的 2 位编码 (注意不是 L/M/Q/H 的顺序)
const ECL_FORMAT_BITS: Record<QrEcl, number> = { L: 1, M: 0, Q: 3, H: 2 }
const ECL_INDEX: Record<QrEcl, number> = { L: 0, M: 1, Q: 2, H: 3 }

// 每块纠错码字数 [ecl][version], 下标 0 无意义
const ECC_CODEWORDS_PER_BLOCK: number[][] = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
]

// 纠错块数 [ecl][version]
const NUM_ERROR_CORRECTION_BLOCKS: number[][] = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
]

// 罚分权重 (规则 1–4)
const PENALTY_N1 = 3
const PENALTY_N2 = 3
const PENALTY_N3 = 40
const PENALTY_N4 = 10

function getBit(x: number, i: number): boolean {
  return ((x >>> i) & 1) !== 0
}

/** 某版本去掉功能图形后可放数据+纠错的模块数 (含不足一字节的剩余位) */
function numRawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2
    result -= (25 * numAlign - 10) * numAlign - 55
    if (ver >= 7) result -= 36
  }
  return result
}

/** 某版本 + 纠错等级下的数据码字数 */
function numDataCodewords(ver: number, ecl: QrEcl): number {
  const e = ECL_INDEX[ecl]
  return Math.floor(numRawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[e]![ver]! * NUM_ERROR_CORRECTION_BLOCKS[e]![ver]!
}

/** 对齐图形中心坐标 (升序), 版本 1 没有 */
function alignmentPositions(ver: number): number[] {
  if (ver === 1) return []
  const numAlign = Math.floor(ver / 7) + 2
  const step = Math.floor((ver * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2
  const result = [6]
  for (let pos = ver * 4 + 17 - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos)
  return result
}

// ---- GF(256) Reed–Solomon, 本原多项式 x^8+x^4+x^3+x^2+1 (0x11D) ----

function gfMultiply(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z & 0xff
}

/** 生成多项式系数 (去掉最高次项的 1), 根为 α^0..α^(degree-1) */
function rsDivisor(degree: number): number[] {
  const result: number[] = new Array<number>(degree).fill(0)
  result[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j]!, root)
      if (j + 1 < result.length) result[j] = result[j]! ^ result[j + 1]!
    }
    root = gfMultiply(root, 0x02)
  }
  return result
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result: number[] = divisor.map(() => 0)
  for (const b of data) {
    const factor = b ^ result.shift()!
    result.push(0)
    for (let i = 0; i < divisor.length; i++) result[i] = result[i]! ^ gfMultiply(divisor[i]!, factor)
  }
  return result
}

/** 分块加纠错码并交织, 得到最终要填入矩阵的码字序列 */
function addEccAndInterleave(data: number[], ver: number, ecl: QrEcl): number[] {
  const e = ECL_INDEX[ecl]
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[e]![ver]!
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[e]![ver]!
  const rawCodewords = Math.floor(numRawDataModules(ver) / 8)
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks)
  const shortBlockLen = Math.floor(rawCodewords / numBlocks)

  const divisor = rsDivisor(blockEccLen)
  const blocks: number[][] = []
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1))
    k += dat.length
    const ecc = rsRemainder(dat, divisor)
    if (i < numShortBlocks) dat.push(0) // 占位, 交织时跳过, 让短块与长块等长
    blocks.push(dat.concat(ecc))
  }

  const result: number[] = []
  for (let i = 0; i < blocks[0]!.length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]!)
    })
  }
  return result
}

// ---- 矩阵 ----

interface Grid {
  size: number
  modules: boolean[][]
  isFunction: boolean[][]
}

function setFunctionModule(g: Grid, x: number, y: number, dark: boolean): void {
  g.modules[y]![x] = dark
  g.isFunction[y]![x] = true
}

/** 格式信息 15 位: 纠错等级 + 掩码, BCH(15,5) 后与 0x5412 异或 */
function formatBits(ecl: QrEcl, mask: number): number {
  const data = (ECL_FORMAT_BITS[ecl] << 3) | mask
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  return ((data << 10) | rem) ^ 0x5412
}

function drawFormatBits(g: Grid, ecl: QrEcl, mask: number): void {
  const bits = formatBits(ecl, mask)
  const size = g.size
  // 第一份: 左上定位图形周围
  for (let i = 0; i <= 5; i++) setFunctionModule(g, 8, i, getBit(bits, i))
  setFunctionModule(g, 8, 7, getBit(bits, 6))
  setFunctionModule(g, 8, 8, getBit(bits, 7))
  setFunctionModule(g, 7, 8, getBit(bits, 8))
  for (let i = 9; i < 15; i++) setFunctionModule(g, 14 - i, 8, getBit(bits, i))
  // 第二份: 右上 + 左下
  for (let i = 0; i < 8; i++) setFunctionModule(g, size - 1 - i, 8, getBit(bits, i))
  for (let i = 8; i < 15; i++) setFunctionModule(g, 8, size - 15 + i, getBit(bits, i))
  setFunctionModule(g, 8, size - 8, true) // 固定深色模块
}

/** 版本信息 (版本 ≥ 7): 6 位版本号 + BCH(18,6) */
function drawVersion(g: Grid, ver: number): void {
  if (ver < 7) return
  let rem = ver
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
  const bits = (ver << 12) | rem
  for (let i = 0; i < 18; i++) {
    const bit = getBit(bits, i)
    const a = g.size - 11 + (i % 3)
    const b = Math.floor(i / 3)
    setFunctionModule(g, a, b, bit)
    setFunctionModule(g, b, a, bit)
  }
}

/** 定位图形 (7×7) + 分隔符 (外圈一格浅色) */
function drawFinderPattern(g: Grid, x: number, y: number): void {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy))
      const xx = x + dx
      const yy = y + dy
      if (xx >= 0 && xx < g.size && yy >= 0 && yy < g.size) setFunctionModule(g, xx, yy, dist !== 2 && dist !== 4)
    }
  }
}

function drawAlignmentPattern(g: Grid, x: number, y: number): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) setFunctionModule(g, x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
  }
}

function drawFunctionPatterns(g: Grid, ver: number, ecl: QrEcl): void {
  const size = g.size
  // 时序图形
  for (let i = 0; i < size; i++) {
    setFunctionModule(g, 6, i, i % 2 === 0)
    setFunctionModule(g, i, 6, i % 2 === 0)
  }
  drawFinderPattern(g, 3, 3)
  drawFinderPattern(g, size - 4, 3)
  drawFinderPattern(g, 3, size - 4)
  // 对齐图形, 跳过与三个定位图形重叠的角
  const pos = alignmentPositions(ver)
  const n = pos.length
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue
      drawAlignmentPattern(g, pos[i]!, pos[j]!)
    }
  }
  drawFormatBits(g, ecl, 0) // 先占位, 选定掩码后重画
  drawVersion(g, ver)
}

/** 从右下角开始, 两列一组之字形上下交替填入数据位 */
function drawCodewords(g: Grid, data: number[]): void {
  const size = g.size
  let i = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5 // 跳过竖直时序列
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const upward = ((right + 1) & 2) === 0
        const y = upward ? size - 1 - vert : vert
        if (!g.isFunction[y]![x] && i < data.length * 8) {
          g.modules[y]![x] = getBit(data[i >>> 3]!, 7 - (i & 7))
          i++
        }
        // 剩余位 (remainder bits) 保持浅色
      }
    }
  }
}

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0
    case 1: return y % 2 === 0
    case 2: return x % 3 === 0
    case 3: return (x + y) % 3 === 0
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0
    case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
    default: throw new Error('掩码编号无效')
  }
}

/** 对非功能模块异或掩码; 再调用一次即撤销 */
function applyMask(g: Grid, mask: number): void {
  for (let y = 0; y < g.size; y++) {
    for (let x = 0; x < g.size; x++) {
      if (!g.isFunction[y]![x] && maskBit(mask, x, y)) g.modules[y]![x] = !g.modules[y]![x]
    }
  }
}

// ---- 掩码罚分 ----

/** 规则 3: 在最近 7 段游程里找 1:1:3:1:1 且一侧有 ≥4 浅色的类定位图形 */
function finderPenaltyCountPatterns(h: number[]): number {
  const n = h[1]!
  const core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n
  return (core && h[0]! >= n * 4 && h[6]! >= n ? 1 : 0) + (core && h[6]! >= n * 4 && h[0]! >= n ? 1 : 0)
}

function finderPenaltyAddHistory(runLength: number, h: number[], size: number): void {
  if (h[0] === 0) runLength += size // 行首的浅色游程连上左侧静区
  h.pop()
  h.unshift(runLength)
}

function finderPenaltyTerminateAndCount(runColor: boolean, runLength: number, h: number[], size: number): number {
  if (runColor) {
    finderPenaltyAddHistory(runLength, h, size)
    runLength = 0
  }
  runLength += size // 行尾连上右侧静区
  finderPenaltyAddHistory(runLength, h, size)
  return finderPenaltyCountPatterns(h)
}

function penaltyScore(g: Grid): number {
  const { size, modules } = g
  let result = 0

  // 规则 1 + 3: 按行、按列扫描游程
  for (let pass = 0; pass < 2; pass++) {
    for (let a = 0; a < size; a++) {
      let runColor = false
      let run = 0
      const history = [0, 0, 0, 0, 0, 0, 0]
      for (let b = 0; b < size; b++) {
        const dark = pass === 0 ? modules[a]![b]! : modules[b]![a]!
        if (dark === runColor) {
          run++
          if (run === 5) result += PENALTY_N1
          else if (run > 5) result++
        } else {
          finderPenaltyAddHistory(run, history, size)
          if (!runColor) result += finderPenaltyCountPatterns(history) * PENALTY_N3
          runColor = dark
          run = 1
        }
      }
      result += finderPenaltyTerminateAndCount(runColor, run, history, size) * PENALTY_N3
    }
  }

  // 规则 2: 2×2 同色块
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y]![x]
      if (c === modules[y]![x + 1] && c === modules[y + 1]![x] && c === modules[y + 1]![x + 1]) result += PENALTY_N2
    }
  }

  // 规则 4: 深色比例偏离 50% 的程度, 每 5% 一档
  let dark = 0
  for (const row of modules) for (const m of row) if (m) dark++
  const total = size * size
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1
  result += k * PENALTY_N4
  return result
}

// ---- 对外接口 ----

/** 编码为 QR 码模块矩阵 (true = 深色). 字节模式, 纠错等级默认 'M', 自动选最小版本 (1–40), 按标准罚分选掩码 */
export function encodeQr(text: string, ecl: QrEcl = 'M'): boolean[][] {
  const bytes = new TextEncoder().encode(text)

  // 选能装下的最小版本: 4 位模式 + 字符计数 (版本 1–9 为 8 位, 10–40 为 16 位) + 数据
  let ver = 1
  let capacityBits = 0
  for (; ; ver++) {
    if (ver > 40) throw new Error('QR 码数据过长')
    const ccBits = ver <= 9 ? 8 : 16
    capacityBits = numDataCodewords(ver, ecl) * 8
    if (bytes.length < 1 << ccBits && 4 + ccBits + bytes.length * 8 <= capacityBits) break
  }

  // 比特流
  const bits: number[] = []
  const append = (val: number, len: number): void => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1)
  }
  append(0b0100, 4) // 字节模式
  append(bytes.length, ver <= 9 ? 8 : 16)
  for (const b of bytes) append(b, 8)
  append(0, Math.min(4, capacityBits - bits.length)) // 终止符
  append(0, (8 - (bits.length % 8)) % 8) // 补齐字节
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) append(pad, 8) // 填充字节 EC 11 交替

  const data: number[] = new Array<number>(bits.length / 8).fill(0)
  bits.forEach((bit, i) => {
    data[i >>> 3] = data[i >>> 3]! | (bit << (7 - (i & 7)))
  })

  const size = ver * 4 + 17
  const g: Grid = {
    size,
    modules: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
    isFunction: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
  }
  drawFunctionPatterns(g, ver, ecl)
  drawCodewords(g, addEccAndInterleave(data, ver, ecl))

  // 逐个尝试 8 种掩码, 取罚分最小者 (并列取编号小的)
  let bestMask = 0
  let minPenalty = Infinity
  for (let mask = 0; mask < 8; mask++) {
    applyMask(g, mask)
    drawFormatBits(g, ecl, mask)
    const p = penaltyScore(g)
    if (p < minPenalty) {
      bestMask = mask
      minPenalty = p
    }
    applyMask(g, mask) // 撤销
  }
  applyMask(g, bestMask)
  drawFormatBits(g, ecl, bestMask)
  return g.modules
}

/** 生成 SVG path 的 d 属性 (每个深色模块一个 1×1 方块, 合并同一行连续模块), 坐标从 quiet zone 外边开始, quiet 默认 4 */
export function qrPath(matrix: boolean[][], quiet = 4): { d: string; size: number } {
  const n = matrix.length
  const parts: string[] = []
  for (let y = 0; y < n; y++) {
    const row = matrix[y]!
    let x = 0
    while (x < n) {
      if (!row[x]) {
        x++
        continue
      }
      const start = x
      while (x < n && row[x]) x++
      const len = x - start
      parts.push(`M${start + quiet} ${y + quiet}h${len}v1h-${len}z`)
    }
  }
  return { d: parts.join(''), size: n + quiet * 2 }
}
