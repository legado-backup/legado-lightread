// 安装版首次启动跟随系统语言; Windows 安装包 (NSIS) 跟随系统语言
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { systemLanguage } from '../src/stores/settings.ts'

const WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0'
const ANDROID = 'Mozilla/5.0 (Linux; Android 12; M2004J11G) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/135.0 Mobile Safari/537.36'
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)'

test('Chinese systems (simplified and traditional) get Chinese, everything else English', () => {
  for (const lang of ['zh-CN', 'zh-TW', 'zh-Hans-CN', 'zh', 'ZH-hk']) assert.equal(systemLanguage(lang, WIN), 'zh', lang)
  for (const lang of ['en-US', 'en-GB', 'ja-JP', 'de-DE', 'zhx']) assert.equal(systemLanguage(lang, WIN), 'en', lang)
  assert.equal(systemLanguage('en-US', ANDROID), 'en')
  assert.equal(systemLanguage('zh-CN', ANDROID), 'zh')
})

test('unreliable or missing language keeps the default', () => {
  assert.equal(systemLanguage('en-US', MAC), undefined, 'WKWebView often reports English on Chinese macOS')
  assert.equal(systemLanguage('', WIN), undefined)
})

test('Windows installer follows the OS language with English fallback and no selector', () => {
  const conf = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'))
  const nsis = conf.bundle.windows.nsis
  assert.deepEqual(nsis.languages, ['English', 'SimpChinese', 'TradChinese'])
  assert.equal(nsis.displayLanguageSelector, false)
})
