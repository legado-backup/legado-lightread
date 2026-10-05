import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { after, beforeEach, test } from 'node:test'
import { createHash } from 'node:crypto'

const state = { calls: [], fetcher: null, storage: new Map(), native: true, opened: [], written: [] }
globalThis.__updaterTest = state
globalThis.__APP_VERSION__ = '1.3.0'
const updaterUrl = new URL('../src/services/updater.ts', import.meta.url).href
const modules = {
  '../storage/types': 'export const isTauri = () => globalThis.__updaterTest.native',
  './net': 'export const fetchRemote = (...args) => { globalThis.__updaterTest.calls.push(args); return globalThis.__updaterTest.fetcher(...args) }',
  '../i18n': 'export const t = key => key',
  '@tauri-apps/plugin-opener': 'export const openUrl = async url => { globalThis.__updaterTest.opened.push(url) }',
  '@tauri-apps/api/path': 'export const downloadDir = async () => "/dl"; export const join = async (...parts) => parts.join("/")',
  '@tauri-apps/plugin-fs': 'export const writeFile = async (path, data) => { globalThis.__updaterTest.written.push({ path, data }) }',
}
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === updaterUrl && modules[specifier]) {
      return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(modules[specifier])}` }
    }
    return nextResolve(specifier, context)
  },
})
const {
  checkUpdate, pickRecommendedDownload, watchUpdateAvailability, canInAppInstall, openDownload, downloadInstaller,
  mirrorDownloadUrl, parseReleaseDownloadUrl, mirrorLinkFor, downloadPlan, parseSha256Sums, parseMirrorReleases,
  githubUnreachable, SOURCE_TIMEOUTS, RELEASES_URL, MIRROR_RELEASES_URL,
} = await import(updaterUrl)
// 更新器在下载/打开链接时才动态导入 Tauri 插件, 钩子需保留到测试结束 (只拦截 updater.ts 的导入)。
after(() => hook.deregister())

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
  state.opened.length = 0
  state.written.length = 0
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

test('slow GitHub metadata falls back to the mirror after 8 s, then retries GitHub with the old 30 s budget', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const signals = []
  state.fetcher = (_url, _auth, init) => {
    signals.push(init.signal)
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))
  }
  const request = checkUpdate(true)
  request.catch(() => {})
  t.mock.timers.tick(SOURCE_TIMEOUTS.primary.connect - 1)
  assert.equal(signals[0].aborted, false)
  t.mock.timers.tick(1)
  assert.equal(signals[0].aborted, true)
  await settled()
  assert.match(state.calls[1][0], /^https:\/\/api\.gitcode\.com\/api\/v5\/repos\/yzfly\/LightRead\/releases\?/)
  t.mock.timers.tick(SOURCE_TIMEOUTS.mirror.connect)
  await settled()
  assert.equal(signals[1].aborted, true)
  assert.match(state.calls[2][0], /api\.github\.com/)
  t.mock.timers.tick(SOURCE_TIMEOUTS.patient.connect - 1)
  assert.equal(signals[2].aborted, false)
  t.mock.timers.tick(1)
  // 全部失败时报告主源 (第一次 GitHub) 的错误
  await assert.rejects(request, /update\.timeout/)
  assert.equal(SOURCE_TIMEOUTS.patient.connect, 30_000)
})

// ---- GitCode 镜像回退 ----

const GH_DL = 'https://github.com/yzfly/LightRead/releases/download'
const GC_DL = 'https://gitcode.com/yzfly/LightRead/releases/download'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const mirrorRelease = (tag, names, extra = {}) => ({
  tag_name: tag, name: `LightRead 轻阅 ${tag}`, prerelease: false, release_status: 'none',
  body: 'Mirror notes\n\n<!-- lightread-mirror-sizes {"LightRead_v1.4.0_android_arm64.apk":70519328} -->',
  created_at: '2026-10-04T08:00:00+08:00',
  assets: [
    { name: `${tag}.zip`, type: 'source', browser_download_url: `https://raw.gitcode.com/x/${tag}.zip` },
    ...names.map((name, id) => ({ name, type: 'attach', id, browser_download_url: `https://evil.example/${name}` })),
  ],
  ...extra,
})
const json = data => ({ ok: true, json: async () => data })
const binary = (bytes, headers = {}) => new Response(bytes, { headers: { 'content-length': String(bytes.length), ...headers } })
const text = body => new Response(body)
const route = handlers => async (url, ...rest) => {
  for (const [pattern, handler] of handlers) if (pattern.test(url)) return handler(url, ...rest)
  throw new Error(`unexpected request ${url}`)
}

test('mirror URLs are derived from the GitHub tag and file name', () => {
  assert.equal(mirrorDownloadUrl('v1.8.0', 'LightRead_1.8.0_x64-setup.exe'), `${GC_DL}/v1.8.0/LightRead_1.8.0_x64-setup.exe`)
  assert.equal(mirrorDownloadUrl('v1.8.0', 'a b#.deb'), `${GC_DL}/v1.8.0/a%20b%23.deb`)
  assert.deepEqual(parseReleaseDownloadUrl(`${GH_DL}/v1.8.0/LightRead_1.8.0_amd64.AppImage`),
    { source: 'github', tag: 'v1.8.0', name: 'LightRead_1.8.0_amd64.AppImage' })
  assert.deepEqual(parseReleaseDownloadUrl(`${GC_DL}/v1.8.0/a%20b.deb?x=1`), { source: 'gitcode', tag: 'v1.8.0', name: 'a b.deb' })
  assert.equal(parseReleaseDownloadUrl(`${GH_DL}/v1.8.0/sub/dir.exe`), null)
  assert.equal(parseReleaseDownloadUrl(`${GH_DL}/v1.8.0/%2F..%2Fx`), null)
  assert.equal(parseReleaseDownloadUrl('https://github.com/other/repo/releases/download/v1/x.exe'), null)
  assert.equal(parseReleaseDownloadUrl(`${GH_DL}/v1.8.0/%E0%A4%A`), null)
})

test('release page links map to GitCode only for this repository', () => {
  assert.equal(RELEASES_URL, 'https://github.com/yzfly/LightRead/releases')
  assert.equal(MIRROR_RELEASES_URL, 'https://gitcode.com/yzfly/LightRead/releases')
  for (const link of [RELEASES_URL, `${RELEASES_URL}/`, `${RELEASES_URL}/latest`, `${RELEASES_URL}/tag/v1.8.0`]) {
    assert.equal(mirrorLinkFor(link), MIRROR_RELEASES_URL, link)
  }
  assert.equal(mirrorLinkFor(`${GH_DL}/v1.8.0/x.apk`), `${GC_DL}/v1.8.0/x.apk`)
  assert.equal(mirrorLinkFor(`${GC_DL}/v1.8.0/x.apk`), null)
  assert.equal(mirrorLinkFor('https://github.com/yzfly/LightRead/issues'), null)
  assert.equal(mirrorLinkFor('https://github.com/yzfly/LightRead/releasesx'), null)
  assert.equal(mirrorLinkFor('https://github.com/yzfly/LightRead/blob/main/docs/ambient-sources.md'), null)
})

test('download plan tries GitHub fast, then GitCode, then GitHub with the old patience', () => {
  const plan = downloadPlan(`${GH_DL}/v1.8.0/app.dmg`)
  assert.deepEqual(plan.map(step => [step.source, step.url, step.connect]), [
    ['github', `${GH_DL}/v1.8.0/app.dmg`, 8_000],
    ['gitcode', `${GC_DL}/v1.8.0/app.dmg`, 15_000],
    ['github', `${GH_DL}/v1.8.0/app.dmg`, 30_000],
  ])
  assert.deepEqual(downloadPlan(`${GC_DL}/v1.8.0/app.dmg`).map(step => step.source), ['gitcode', 'github'])
  assert.deepEqual(downloadPlan('https://example.com/x.zip').map(step => step.url), ['https://example.com/x.zip'])
})

test('SHA256SUMS parsing accepts text and binary markers', () => {
  const sums = parseSha256Sums(`${'A'.repeat(64)}  a.apk\n${'b'.repeat(64)} *b.dmg\r\njunk\n`)
  assert.deepEqual([...sums], [['a.apk', 'a'.repeat(64)], ['b.dmg', 'b'.repeat(64)]])
})

test('mirror metadata picks the newest complete vX.Y.Z release and rebuilds asset URLs', () => {
  const info = parseMirrorReleases([
    mirrorRelease('tts-models', ['kokoro-multi-lang-v1_1.tar.bz2', 'SHA256SUMS']),
    mirrorRelease('v1.9.0', ['LightRead_v1.9.0_android_arm64.apk']),
    mirrorRelease('v2.0.0', ['x.apk', 'SHA256SUMS'], { prerelease: true }),
    mirrorRelease('v1.4.0', [apk.name, dmg.name, 'SHA256SUMS']),
    mirrorRelease('v1.3.5', ['SHA256SUMS']),
  ])
  assert.equal(info.version, '1.4.0')
  assert.equal(info.hasUpdate, true)
  assert.equal(info.source, 'gitcode')
  assert.equal(info.notes, 'Mirror notes')
  assert.equal(info.publishedAt, '2026-10-04')
  assert.equal(info.pageUrl, MIRROR_RELEASES_URL)
  assert.deepEqual(info.assets.map(a => a.url), [
    `${GC_DL}/v1.4.0/${apk.name}`, `${GC_DL}/v1.4.0/${dmg.name}`, `${GC_DL}/v1.4.0/SHA256SUMS`,
  ])
  assert.equal(info.assets[0].size, 70519328)
  assert.equal(info.assets[1].size, 0)
  assert.equal(pickRecommendedDownload(info.assets).url, `${GC_DL}/v1.4.0/${apk.name}`)
  assert.equal(parseMirrorReleases([mirrorRelease('v1.9.0', ['x.apk'])]), null)
  assert.equal(parseMirrorReleases({ error_code: 404 }), null)
})

test('GitHub failure falls back to GitCode metadata and release links follow the mirror', async () => {
  state.fetcher = route([
    [/api\.github\.com/, async () => { throw new Error('connect timeout') }],
    [/api\.gitcode\.com/, async () => json([mirrorRelease('v1.4.0', [apk.name, dmg.name, 'SHA256SUMS'])])],
  ])
  const info = await checkUpdate(true)
  assert.equal(info.source, 'gitcode')
  assert.equal(info.version, '1.4.0')
  assert.equal(state.calls.length, 2)
  assert.equal(githubUnreachable(), true)
  await openDownload(RELEASES_URL)
  await openDownload(`${GH_DL}/v1.4.0/${apk.name}`)
  await openDownload('https://github.com/yzfly/LightRead/issues')
  assert.deepEqual(state.opened, [MIRROR_RELEASES_URL, `${GC_DL}/v1.4.0/${apk.name}`, 'https://github.com/yzfly/LightRead/issues'])

  // GitHub 恢复后链接回到 GitHub
  state.fetcher = async () => json(release())
  assert.equal((await checkUpdate(true)).source, 'github')
  assert.equal(githubUnreachable(), false)
  await openDownload(RELEASES_URL)
  assert.equal(state.opened.at(-1), RELEASES_URL)
})

test('an older mirror never reports an update the installed version already has', async () => {
  state.fetcher = route([
    [/api\.github\.com/, async () => { throw new Error('offline') }],
    [/api\.gitcode\.com/, async () => json([mirrorRelease('v1.2.0', [apk.name, 'SHA256SUMS'])])],
  ])
  assert.equal((await checkUpdate(true)).hasUpdate, false)
})

test('missing mirror (not set up yet) keeps the old GitHub behaviour via the patient retry', async () => {
  let github = 0
  state.fetcher = route([
    [/api\.github\.com/, async () => { if (++github === 1) throw new Error('slow'); return json(release()) }],
    [/api\.gitcode\.com/, async () => { throw new Error('地址不存在 (404)') }],
  ])
  const info = await checkUpdate(true)
  assert.equal(info.source, 'github')
  assert.deepEqual(state.calls.map(c => new URL(c[0]).host), ['api.github.com', 'api.gitcode.com', 'api.github.com'])
  assert.equal(githubUnreachable(), false)

  state.fetcher = route([
    [/api\.github\.com/, async () => { throw new Error('github down') }],
    [/api\.gitcode\.com/, async () => { throw new Error('mirror down') }],
  ])
  await assert.rejects(checkUpdate(true), /github down/)
})

test('installer download falls back to GitCode and is verified against SHA256SUMS', async () => {
  const bytes = new TextEncoder().encode('installer-bytes')
  const progress = []
  state.fetcher = route([
    [/^https:\/\/github\.com\/.*\/SHA256SUMS$/, async () => { throw new Error('github down') }],
    [/^https:\/\/github\.com\//, async () => { throw new Error('github down') }],
    [/^https:\/\/gitcode\.com\/.*\/SHA256SUMS$/, async () => text(`${sha(bytes)}  app.dmg\n`)],
    [/^https:\/\/gitcode\.com\//, async () => binary(bytes)],
  ])
  const path = await downloadInstaller(`${GH_DL}/v1.4.0/app.dmg`, 'app.dmg', p => progress.push(p))
  assert.equal(path, '/dl/app.dmg')
  assert.deepEqual([...state.written[0].data], [...bytes])
  assert.equal(progress.at(-1).fraction, 1)
  assert.deepEqual(state.calls.map(c => c[0]), [
    `${GH_DL}/v1.4.0/app.dmg`, `${GC_DL}/v1.4.0/app.dmg`, `${GH_DL}/v1.4.0/SHA256SUMS`, `${GC_DL}/v1.4.0/SHA256SUMS`,
  ])
})

test('mirror downloads with a wrong or missing checksum are rejected and never written', async () => {
  const bytes = new TextEncoder().encode('tampered')
  state.fetcher = route([
    [/SHA256SUMS$/, async () => text(`${'0'.repeat(64)}  app.dmg\n`)],
    [/^https:\/\/gitcode\.com\//, async () => binary(bytes)],
  ])
  await assert.rejects(downloadInstaller(`${GC_DL}/v1.4.0/app.dmg`, 'app.dmg', () => {}), /update\.checksumMismatch/)
  // 校验失败不换源重试
  assert.equal(state.calls.filter(c => !c[0].endsWith('SHA256SUMS')).length, 1)

  state.fetcher = route([
    [/SHA256SUMS$/, async () => { throw new Error('地址不存在 (404)') }],
    [/^https:\/\/gitcode\.com\//, async () => binary(bytes)],
  ])
  await assert.rejects(downloadInstaller(`${GC_DL}/v1.4.0/app.dmg`, 'app.dmg', () => {}), /update\.checksumUnavailable/)
  assert.equal(state.written.length, 0)
})

test('GitHub downloads keep working without SHA256SUMS but fail on a mismatch', async () => {
  const bytes = new TextEncoder().encode('github-bytes')
  state.fetcher = route([
    [/SHA256SUMS$/, async () => { throw new Error('404') }],
    [/^https:\/\/github\.com\//, async () => binary(bytes)],
  ])
  await downloadInstaller(`${GH_DL}/v1.4.0/app.dmg`, 'app.dmg', () => {})
  assert.equal(state.written.length, 1)

  state.fetcher = route([
    [/^https:\/\/github\.com\/.*SHA256SUMS$/, async () => text(`${'f'.repeat(64)}  app.dmg\n`)],
    [/^https:\/\/github\.com\//, async () => binary(bytes)],
  ])
  await assert.rejects(downloadInstaller(`${GH_DL}/v1.4.0/app.dmg`, 'app.dmg', () => {}), /update\.checksumMismatch/)
})

test('truncated GitHub responses fall back to the mirror', async () => {
  const bytes = new TextEncoder().encode('full-file')
  state.fetcher = route([
    [/SHA256SUMS$/, async () => text(`${sha(bytes)}  app.dmg\n`)],
    [/^https:\/\/github\.com\//, async () => new Response(bytes.slice(0, 4), { headers: { 'content-length': String(bytes.length) } })],
    [/^https:\/\/gitcode\.com\//, async () => binary(bytes)],
  ])
  await downloadInstaller(`${GH_DL}/v1.4.0/app.dmg`, 'app.dmg', () => {})
  assert.deepEqual([...state.written[0].data], [...bytes])
})

test('a GitHub download that stops making progress switches to the mirror', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const bytes = new TextEncoder().encode('mirror-bytes')
  let cancelled = false
  state.fetcher = route([
    [/SHA256SUMS$/, async () => text(`${sha(bytes)}  app.dmg\n`)],
    [/^https:\/\/github\.com\//, async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([1, 2])) },
      cancel() { cancelled = true },
    }), { headers: { 'content-length': '100' } })],
    [/^https:\/\/gitcode\.com\//, async () => binary(bytes)],
  ])
  const done = downloadInstaller(`${GH_DL}/v1.4.0/app.dmg`, 'app.dmg', () => {})
  await settled()
  t.mock.timers.tick(SOURCE_TIMEOUTS.primary.stall)
  const path = await done
  assert.equal(path, '/dl/app.dmg')
  assert.equal(cancelled, true)
  assert.deepEqual([...state.written[0].data], [...bytes])
})
