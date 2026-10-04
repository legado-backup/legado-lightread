import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { beforeEach, test } from 'node:test'

const state = { calls: [], fetcher: null, storage: new Map(), native: true }
globalThis.__updaterTest = state
globalThis.__APP_VERSION__ = '1.3.0'
const updaterUrl = new URL('../src/services/updater.ts', import.meta.url).href
const modules = {
  '../storage/types': 'export const isTauri = () => globalThis.__updaterTest.native',
  './net': 'export const fetchRemote = (...args) => { globalThis.__updaterTest.calls.push(args); return globalThis.__updaterTest.fetcher(...args) }',
  '../i18n': 'export const t = key => key',
}
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === updaterUrl && modules[specifier]) {
      return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(modules[specifier])}` }
    }
    return nextResolve(specifier, context)
  },
})
const { checkUpdate, pickRecommendedDownload, watchUpdateAvailability, canInAppInstall } = await import(updaterUrl)
hook.deregister()

const apk = { name: 'LightRead_v1.4.0_android_arm64.apk', url: 'https://github.com/yzfly/LightRead/releases/download/v1.4.0/app.apk', size: 4096 }
const dmg = { name: 'LightRead_1.4.0_aarch64.dmg', url: 'https://github.com/yzfly/LightRead/releases/download/v1.4.0/app.dmg', size: 4096 }
const release = (assets = [apk], version = '1.4.0') => ({
  tag_name: `v${version}`, body: 'Release notes', published_at: '2026-10-03T12:00:00Z',
  html_url: `https://github.com/yzfly/LightRead/releases/tag/v${version}`,
  assets: assets.map(asset => ({ name: asset.name, browser_download_url: asset.url, size: asset.size })),
})
const cached = (assets, at, version = '1.4.0') => {
  state.storage.set('lightread-update-check', JSON.stringify({ at, info: {
    version, hasUpdate: true, notes: '', publishedAt: '', pageUrl: 'https://github.com/yzfly/LightRead/releases', assets,
  } }))
}
const settled = () => new Promise(resolve => setImmediate(resolve))

beforeEach(() => {
  state.calls.length = 0
  state.storage.clear()
  state.native = true
  state.fetcher = async () => ({ json: async () => release() })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Mozilla/5.0 (Linux; Android 12)' } })
  globalThis.localStorage = {
    getItem: key => state.storage.get(key) ?? null,
    setItem: (key, value) => state.storage.set(key, value),
  }
  globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  globalThis.window = new EventTarget()
})

test('Android never falls back to another platform installer when APK is missing', () => {
  assert.equal(pickRecommendedDownload([dmg]), null)
  assert.equal(pickRecommendedDownload([dmg, apk]).url, apk.url)
  assert.equal(pickRecommendedDownload([dmg, apk], 'Macintosh').url, dmg.url)
  assert.equal(pickRecommendedDownload([apk], 'Windows NT 10.0'), null)
  assert.equal(canInAppInstall(), false)
})

test('incomplete Android releases expire quickly so a later uploaded APK becomes visible', async t => {
  const now = 1_800_000_000_000
  t.mock.method(Date, 'now', () => now)
  cached([dmg], now - 59_000)
  assert.equal(pickRecommendedDownload((await checkUpdate()).assets), null)
  assert.equal(state.calls.length, 0)
  cached([dmg], now - 61_000)
  const result = await checkUpdate()
  assert.equal(pickRecommendedDownload(result.assets).url, apk.url)
  assert.equal(state.calls.length, 1)
  assert.equal(result.hasUpdate, true)
})

test('complete cached releases use six hours, recompute installed version and allow forced refresh', async t => {
  const now = 1_800_000_000_000
  t.mock.method(Date, 'now', () => now)
  cached([apk], now - 2 * 60 * 60 * 1000, '1.2.0')
  assert.equal((await checkUpdate()).hasUpdate, false)
  assert.equal(state.calls.length, 0)
  assert.equal((await checkUpdate(true)).version, '1.4.0')
  assert.equal(state.calls.length, 1)
  cached([apk], now - 6 * 60 * 60 * 1000 - 1)
  await checkUpdate()
  assert.equal(state.calls.length, 2)
})

test('automatic foreground checks bypass old cache and throttle duplicate lifecycle events', async t => {
  let now = 1_800_000_000_000
  t.mock.method(Date, 'now', () => now)
  cached([apk], now, '1.3.0')
  const updates = []
  const stop = watchUpdateAvailability(info => updates.push(info))
  t.after(stop)
  await settled()
  assert.equal(state.calls.length, 0)
  assert.equal(updates[0].hasUpdate, false)

  window.dispatchEvent(new Event('focus'))
  window.dispatchEvent(new Event('online'))
  await settled()
  assert.equal(state.calls.length, 0)

  now += 60_001
  document.visibilityState = 'hidden'
  document.dispatchEvent(new Event('visibilitychange'))
  await settled()
  assert.equal(state.calls.length, 0)
  document.visibilityState = 'visible'
  document.dispatchEvent(new Event('visibilitychange'))
  window.dispatchEvent(new Event('focus'))
  window.dispatchEvent(new Event('online'))
  await settled()
  assert.equal(state.calls.length, 1)
  assert.equal(updates.at(-1).version, '1.4.0')

  stop()
  now += 60_001
  window.dispatchEvent(new Event('focus'))
  document.dispatchEvent(new Event('visibilitychange'))
  await settled()
  assert.equal(state.calls.length, 1)
})

test('stopped update observers ignore requests completing after unmount', async () => {
  let resolve
  state.fetcher = () => new Promise(done => { resolve = done })
  const updates = []
  const stop = watchUpdateAvailability(info => updates.push(info))
  assert.equal(state.calls.length, 1)
  stop()
  resolve({ json: async () => release() })
  await settled()
  assert.deepEqual(updates, [])
})

test('failed automatic checks retry on a later foreground event without erasing the last update', async t => {
  let now = 1_800_000_000_000
  t.mock.method(Date, 'now', () => now)
  state.fetcher = async () => { throw new Error('offline') }
  const updates = []
  const stop = watchUpdateAvailability(info => updates.push(info))
  t.after(stop)
  await settled()
  assert.deepEqual(updates, [])
  state.fetcher = async () => ({ json: async () => release() })
  now += 60_001
  window.dispatchEvent(new Event('online'))
  await settled()
  assert.equal(updates[0].version, '1.4.0')
})

test('storage write failure does not hide a successfully fetched update', async () => {
  localStorage.setItem = () => { throw new Error('quota exceeded') }
  const result = await checkUpdate(true)
  assert.equal(result.hasUpdate, true)
  assert.equal(result.version, '1.4.0')
})

test('update request aborts after 30 seconds so future foreground checks can retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let signal
  state.fetcher = (_url, _auth, init) => {
    signal = init.signal
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))
  }
  const request = checkUpdate(true)
  t.mock.timers.tick(29_999)
  assert.equal(signal.aborted, false)
  t.mock.timers.tick(1)
  await assert.rejects(request, /aborted/)
})
