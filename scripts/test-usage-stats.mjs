// 匿名使用统计客户端契约: 北京时间切天 / 平台识别 / 每天最多两次
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { beijingDay, detectPlatform, needsPing } from '../src/services/usageStatsCore.ts'

test('按北京时间切天', () => {
  assert.equal(beijingDay(Date.UTC(2026, 9, 4, 15, 59)), '2026-10-04')
  assert.equal(beijingDay(Date.UTC(2026, 9, 4, 16, 0)), '2026-10-05')
})

test('平台识别: 网页版统一记 web', () => {
  const win = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/135 Safari/537.36'
  const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15'
  const linux = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'
  const android = 'Mozilla/5.0 (Linux; Android 12; M2007J3SC) AppleWebKit/537.36 Chrome/135 Mobile Safari/537.36'
  assert.equal(detectPlatform(win, true), 'windows')
  assert.equal(detectPlatform(mac, true), 'macos')
  assert.equal(detectPlatform(linux, true), 'linux')
  assert.equal(detectPlatform(android, true), 'android')
  assert.equal(detectPlatform(android, false), 'web')
  assert.equal(detectPlatform(win, false), 'web')
})

test('每天: 打开应用一次, 第一次打开书再一次', () => {
  assert.equal(needsPing(null, '2026-10-05', false), true)
  assert.equal(needsPing('2026-10-04:reader', '2026-10-05', false), true)
  assert.equal(needsPing('2026-10-05:app', '2026-10-05', false), false)
  assert.equal(needsPing('2026-10-05:app', '2026-10-05', true), true)
  assert.equal(needsPing('2026-10-05:reader', '2026-10-05', true), false)
  assert.equal(needsPing('2026-10-05:reader', '2026-10-05', false), false)
})

import { isTestEnvironment } from '../src/services/usageStatsCore.ts'
test('自动化测试与本机预览不上报, App 内 (tauri.localhost) 照常', () => {
  assert.equal(isTestEnvironment({ webdriver: true }, 'lightread.example', false), true)
  assert.equal(isTestEnvironment({}, 'localhost', false), true)
  assert.equal(isTestEnvironment({}, '127.0.0.1', false), true)
  assert.equal(isTestEnvironment({}, 'tauri.localhost', true), false)
  assert.equal(isTestEnvironment({}, 'localhost', true), false, 'macOS App 的 tauri://localhost')
  assert.equal(isTestEnvironment({ webdriver: false }, 'lightread.ethereal-ai.workers.dev', false), false)
})
