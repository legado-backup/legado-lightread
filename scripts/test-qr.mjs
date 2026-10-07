import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { encodeQr, qrPath } from '../src/services/qr.ts'

// ---- 工具 ----

const ECLS = ['L', 'M', 'Q', 'H']
const ECL_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 }
const versionOf = (m) => (m.length - 17) / 4
const rowsText = (m) => m.map((r) => r.map((b) => (b ? '1' : '0')).join('')).join('\n')
const sha256 = (m) => createHash('sha256').update(rowsText(m)).digest('hex')
// 确定性 ASCII 填充串, 用于版本边界与大版本用例
const pat = (n) => Array.from({ length: n }, (_, i) => String.fromCharCode(33 + ((i * 7) % 90))).join('')

// 各纠错等级下版本 1–12 与 40 的字节模式容量 (ISO/IEC 18004 表 7)
const BYTE_CAPACITY = {
  L: [17, 32, 53, 78, 106, 134, 154, 192, 230, 271, 321, 367],
  M: [14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287],
  Q: [11, 20, 32, 46, 60, 74, 86, 108, 130, 151, 177, 203],
  H: [7, 14, 24, 34, 44, 58, 64, 84, 98, 119, 137, 155],
}
const BYTE_CAPACITY_V40 = { L: 2953, M: 2331, Q: 1663, H: 1273 }

/** 读出两份格式信息 (15 位, 未去掩码) */
function readFormat(m) {
  const n = m.length
  const bit = (x, y) => (m[y][x] ? 1 : 0)
  let a = 0
  let b = 0
  const first = []
  for (let i = 0; i <= 5; i++) first.push([8, i])
  first.push([8, 7], [8, 8], [7, 8])
  for (let i = 9; i < 15; i++) first.push([14 - i, 8])
  const second = []
  for (let i = 0; i < 8; i++) second.push([n - 1 - i, 8])
  for (let i = 8; i < 15; i++) second.push([8, n - 15 + i])
  first.forEach(([x, y], i) => (a |= bit(x, y) << i))
  second.forEach(([x, y], i) => (b |= bit(x, y) << i))
  return [a, b]
}

/** 多项式除法求 BCH 余数 */
function bchRemainder(value, poly, polyDeg) {
  let v = value
  for (let i = 31; i >= polyDeg; i--) if ((v >>> i) & 1) v ^= poly << (i - polyDeg)
  return v
}

function decodeFormat(m) {
  const [a, b] = readFormat(m)
  assert.equal(a, b, '两份格式信息应一致')
  const raw = a ^ 0x5412
  assert.equal(bchRemainder(raw, 0x537, 10), 0, '格式信息 BCH 校验应通过')
  return { eclBits: raw >>> 13, mask: (raw >>> 10) & 7 }
}

function assertFinder(m, cx, cy) {
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy))
      assert.equal(m[cy + dy][cx + dx], d !== 2, `定位图形 (${cx},${cy}) 偏移 ${dx},${dy}`)
    }
  }
  // 分隔符: 外圈一格全浅色 (在矩阵内的部分)
  for (let k = -4; k <= 4; k++) {
    for (const [x, y] of [[cx + k, cy - 4], [cx + k, cy + 4], [cx - 4, cy + k], [cx + 4, cy + k]]) {
      if (x >= 0 && y >= 0 && x < m.length && y < m.length) assert.equal(m[y][x], false, `分隔符 (${x},${y})`)
    }
  }
}

function assertStructure(m, ecl) {
  const n = m.length
  assert.ok(m.every((r) => r.length === n), '矩阵应为正方形')
  const ver = versionOf(m)
  assert.ok(Number.isInteger(ver) && ver >= 1 && ver <= 40)
  assertFinder(m, 3, 3)
  assertFinder(m, n - 4, 3)
  assertFinder(m, 3, n - 4)
  for (let i = 8; i < n - 8; i++) {
    assert.equal(m[6][i], i % 2 === 0, `横向时序 ${i}`)
    assert.equal(m[i][6], i % 2 === 0, `纵向时序 ${i}`)
  }
  assert.equal(m[n - 8][8], true, '固定深色模块')
  const f = decodeFormat(m)
  assert.equal(f.eclBits, ECL_FORMAT_BITS[ecl], '格式信息里的纠错等级')
  if (ver >= 7) {
    // 版本信息两份 (右上 6×3, 左下 3×6), 18 位, BCH(18,6) 多项式 0x1F25
    let a = 0
    let b = 0
    for (let i = 0; i < 18; i++) {
      const p = n - 11 + (i % 3)
      const q = Math.floor(i / 3)
      a |= (m[q][p] ? 1 : 0) << i
      b |= (m[p][q] ? 1 : 0) << i
    }
    assert.equal(a, b, '两份版本信息应一致')
    assert.equal(a >>> 12, ver, '版本信息中的版本号')
    assert.equal(bchRemainder(a, 0x1f25, 12), 0, '版本信息 BCH 校验应通过')
  }
  return f
}

// ---- 用例 ----

test('短链接默认 M 级: 版本 1–3 的尺寸', () => {
  assert.equal(encodeQr('123456').length, 21)
  assert.equal(encodeQr('https://lr.jiangshu.ai/d/1').length, 25) // 26 字节, M 级版本 2 正好装下
  assert.equal(encodeQr('https://sync.jiangshu.ai/d/123456').length, 29)
  assert.equal(encodeQr('https://sync.jiangshu.ai/d/123456', 'L').length, 29)
})

test('版本随长度增长, 容量边界与标准表一致', () => {
  for (const ecl of ECLS) {
    BYTE_CAPACITY[ecl].forEach((cap, i) => {
      assert.equal(versionOf(encodeQr(pat(cap), ecl)), i + 1, `${ecl} 满容量 ${cap} 字节应为版本 ${i + 1}`)
      assert.equal(versionOf(encodeQr(pat(cap + 1), ecl)), i + 2, `${ecl} ${cap + 1} 字节应升到版本 ${i + 2}`)
    })
  }
  let prev = 0
  for (let n = 1; n <= 300; n += 7) {
    const v = versionOf(encodeQr(pat(n)))
    assert.ok(v >= prev, '版本不应随长度减小')
    prev = v
  }
})

test('UTF-8: 中文按 3 字节计入容量', () => {
  // M 级版本 1 容量 14 字节: 4 个汉字 = 12 字节, 5 个汉字 = 15 字节
  assert.equal(versionOf(encodeQr('轻阅互传')), 1)
  assert.equal(versionOf(encodeQr('轻阅互传码')), 2)
})

test('超过版本 40 容量时报错', () => {
  for (const ecl of ECLS) {
    assert.equal(versionOf(encodeQr(pat(BYTE_CAPACITY_V40[ecl]), ecl)), 40)
    assert.throws(() => encodeQr(pat(BYTE_CAPACITY_V40[ecl] + 1), ecl))
  }
})

test('功能图形、格式信息 (BCH)、版本信息 (v≥7) 正确', () => {
  const samples = [
    'a',
    'https://sync.jiangshu.ai/d/123456',
    'https://example.com/#/transfer?code=123456',
    '轻阅 LightRead 互传 😀',
    pat(150),
    pat(300),
    pat(1000),
  ]
  for (const s of samples) for (const ecl of ECLS) assertStructure(encodeQr(s, ecl), ecl)
})

test('输出确定', () => {
  const s = 'https://example.com/#/transfer?code=123456'
  assert.equal(rowsText(encodeQr(s)), rowsText(encodeQr(s)))
  assert.equal(rowsText(encodeQr(s)), rowsText(encodeQr(s, 'M')))
})

// 以下哈希来自独立实现 (Nayuki qrcodegen 1.8.0 Python 版, 字节模式, 不提升纠错等级),
// 并与 segno 1.6.6 在同一掩码下逐位一致; 矩阵按行 '0'/'1' 串以 \n 连接后取 SHA-256.
const REFERENCE = [
  ['https://sync.jiangshu.ai/d/123456', 'L', 29, 2, '84edee58fbc5cbb4b681662e4b35ae60183b50038dfd7209ca1a062199e975ae'],
  ['https://sync.jiangshu.ai/d/123456', 'M', 29, 2, '1dc97005e0a9e3b192b6e3af800a5d3f82bc44525e16a9493aa09af2d51c3d1b'],
  ['https://example.com/#/transfer?code=123456', 'L', 29, 7, '863b5a9918dd3024adabaeef22564733b9e967b526aa224a55313011ebfef712'],
  ['https://example.com/#/transfer?code=123456', 'M', 29, 3, 'c64e170e0329082314510fd51a1707c98e418e51ca0d53b28c931b066af9eecb'],
  ['https://example.com/#/transfer?code=123456', 'Q', 33, 4, 'c08a5fb2a7ac5b0bc49ba0ec495d551d50693c0160e4ca972250c8d88b6f2b54'],
  ['https://example.com/#/transfer?code=123456', 'H', 37, 2, 'a91bf3883d024f3ebdd3d521b3d8f13b85214838979474e22b0c80f54427522c'],
  ['轻阅 LightRead 互传', 'L', 25, 5, 'e9fa0a5e1e10276db6d9b71eb7611562f6a624a1d1b068242195eb342500870a'],
  ['轻阅 LightRead 互传', 'M', 25, 2, '112acff38c1db684f98f95c2b31b3eb4494be651dd8ef805b3130946ee99085a'],
  ['轻阅 LightRead 互传', 'Q', 29, 0, '0bdf80fd0068a530be25fcfdb67e22582d14789aaf9dfcdadafc073cc3df5ba4'],
  ['轻阅 LightRead 互传', 'H', 29, 3, '01781d280d61c2f70530857463d64d6052dedfe3e1f13e9a44ca16183f8a6fcf'],
  ['😀 emoji ✓ é ü ß', 'Q', 29, 0, '993e3861ae8bf1ba526e9973bc06010f2bc07a83327e58eb530a1851bf4cafe7'],
  ['😀 emoji ✓ é ü ß', 'H', 29, 5, 'e87a7ee32e2de769da8ed459189294e3a2b5f1db10b52705f101fdbec9cc6d3f'],
]

// 大版本 (含版本信息、多块交织、长短块混合): 各纠错等级在版本 7/10/27/40 的满容量 pat(len)
const REFERENCE_BIG = [
  ['L', 154, 7, 4, '8f17dbef3079ab91f8279d2dee55f07745921c27a08135bcbcb9d450a08cc5d0'],
  ['L', 271, 10, 2, 'a02e7f76adf9c5934298076f453aec5e36ec5e25e5e8fef28f37238552d60e83'],
  ['L', 1465, 27, 4, '8502f741ebe4f053cbb0f3c0497909adc0606ae4d574532192224ab41c60c9c1'],
  ['L', 2953, 40, 3, 'eb731e17029b178d3883ac6260dcba0368ea96b6981d92b2c3e3f85c1120624b'],
  ['M', 122, 7, 3, '6f1133d9a315d5ffc2cf9a5122e62c97c38f8b965d7209d0c266ccd275964240'],
  ['M', 213, 10, 7, '3ca43cf6c31cbe80b88614078c8e6fb8a063840cac6401f58008eb7137e6191b'],
  ['M', 1125, 27, 4, '62a87358a77068806aa69a2f3101823776ff823988fee744bf038d000d9a85bc'],
  ['M', 2331, 40, 6, 'd26b8aac3c6383ca3e95280f0a815039a9d432310406a3bcd94fef57ed08a126'],
  ['Q', 86, 7, 1, 'e618d29aed55c2dcec71f0561ed83d72e5c6d45c69b4c777dab292131874453b'],
  ['Q', 151, 10, 6, '26f85ce5b6f4f3e1f7aaf2e4bffadf0263d0a9b09a5cc794f5f995baa54234a7'],
  ['Q', 805, 27, 7, 'cc3a5ef31e9b815bd880b651af01a226b677624be4a08067680cbc243d9ae0cb'],
  ['Q', 1663, 40, 3, 'e3203190145b6f325b5e942ceb5978761b5f29b66d46703d4d02af6e09b2d103'],
  ['H', 64, 7, 2, '25b9028e1ac1681d275be6d21c4c322269ac2e88261e709fdfdce1a273680c4d'],
  ['H', 119, 10, 2, '7a694a134db8fe0351159523182796e4e2c343d1ed5c7718700fd40679a2002f'],
  ['H', 625, 27, 6, 'f7c7ede4bc0dcca6b35170e36a6a3be2213e1f02da8ec2a64dd8d068390e8244'],
  ['H', 1273, 40, 6, 'da4f6d1e841768c697c2e9a1e985a25d4810471fb6d7086dd01b41d0014f69b9'],
]

test('与独立参考实现逐位一致 (含掩码选择)', () => {
  for (const [text, ecl, size, mask, hash] of REFERENCE) {
    const m = encodeQr(text, ecl)
    assert.equal(m.length, size, `${ecl} ${text} 尺寸`)
    assert.equal(decodeFormat(m).mask, mask, `${ecl} ${text} 掩码`)
    assert.equal(sha256(m), hash, `${ecl} ${text} 矩阵`)
  }
})

test('大版本与参考实现逐位一致', () => {
  for (const [ecl, len, ver, mask, hash] of REFERENCE_BIG) {
    const m = encodeQr(pat(len), ecl)
    assert.equal(versionOf(m), ver, `${ecl} ${len} 字节版本`)
    assert.equal(decodeFormat(m).mask, mask, `${ecl} v${ver} 掩码`)
    assert.equal(sha256(m), hash, `${ecl} v${ver} 矩阵`)
  }
})

test('qrPath: 合并同行连续模块, 坐标含 quiet zone', () => {
  const m = [
    [true, true, false],
    [false, false, false],
    [true, false, true],
  ]
  assert.deepEqual(qrPath(m), { d: 'M4 4h2v1h-2zM4 6h1v1h-1zM6 6h1v1h-1z', size: 11 })
  assert.deepEqual(qrPath(m, 0), { d: 'M0 0h2v1h-2zM0 2h1v1h-1zM2 2h1v1h-1z', size: 3 })
  assert.deepEqual(qrPath([[false]], 2), { d: '', size: 5 })

  // 真实二维码: 路径覆盖的模块数 = 深色模块数
  const qr = encodeQr('https://sync.jiangshu.ai/d/123456')
  const { d, size } = qrPath(qr)
  assert.equal(size, qr.length + 8)
  const covered = [...d.matchAll(/h(\d+)v1/g)].reduce((s, x) => s + Number(x[1]), 0)
  assert.equal(covered, qr.flat().filter(Boolean).length)
})
