// 私有书库 (自建 / 需登录的 OPDS) 契约: 连接信息解析、搜索入口发现 (带鉴权)、EPUB 优先
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { beforeEach, test } from 'node:test'
import {
  acquisitionLabel, applyOpenSearchOffsets, fillSearchTemplate, findSearchLink, looksLikeConnectionText,
  parseConnectionText, pickOpenSearchUrl, pickPrimaryAcquisition, resolveTemplateHref, sortAcquisitions,
  splitUrlCredentials, TimeoutError, userOpdsSources, withTimeout,
} from '../src/services/privateLibrary.ts'

// ---------------------------------------------------------------------------
// 连接信息
// ---------------------------------------------------------------------------

const SERVER_TEXT = `轻阅 → 书源 → 添加书源
名称：我的百度书库
地址：https://library.jiangshu.ai/opds
用户名：lightread
密码：xxxxxxxx`

test('parses the exact connection text written by the library server', () => {
  assert.deepEqual(parseConnectionText(SERVER_TEXT), {
    title: '我的百度书库',
    url: 'https://library.jiangshu.ai/opds',
    username: 'lightread',
    password: 'xxxxxxxx',
  })
  assert.equal(looksLikeConnectionText(SERVER_TEXT), true)
})

test('tolerates half-width colons, English labels, CRLF, bullets and extra spacing', () => {
  const text = 'Name: Home Library\r\n- URL:  <https://books.example.com/opds/>\r\n* Username : reader\r\nPassword:p@ss:wörd 1\r\n'
  assert.deepEqual(parseConnectionText(text), {
    title: 'Home Library',
    url: 'https://books.example.com/opds/',
    username: 'reader',
    password: 'p@ss:wörd 1',
  })
  const mixed = '名称:我的书库\n地址:https://a.example/opds\n用户名:u\n密码：中文密码'
  assert.deepEqual(parseConnectionText(mixed), {
    title: '我的书库', url: 'https://a.example/opds', username: 'u', password: '中文密码',
  })
})

test('first value wins and unknown labels are ignored', () => {
  const info = parseConnectionText('地址：https://one.example/opds\n地址：https://two.example/opds\n备注：随便\n账号：a')
  assert.equal(info.url, 'https://one.example/opds')
  assert.equal(info.username, 'a')
  assert.equal(info.title, undefined)
})

test('falls back to a bare URL and splits embedded credentials', () => {
  assert.deepEqual(parseConnectionText('请访问 https://u:p%40ss@lib.example/opds 。'), {
    url: 'https://lib.example/opds', username: 'u', password: 'p@ss',
  })
  assert.deepEqual(splitUrlCredentials('https://lib.example/opds'), { url: 'https://lib.example/opds' })
  assert.deepEqual(splitUrlCredentials(' not a url '), { url: 'not a url' })
})

test('rejects text without an http(s) address and plain single-line URLs are not connection text', () => {
  assert.equal(parseConnectionText(''), null)
  assert.equal(parseConnectionText('名称：书库\n用户名：a\n密码：b'), null)
  assert.equal(parseConnectionText('地址：ftp://lib.example/opds'), null)
  assert.equal(looksLikeConnectionText('https://lib.example/opds'), false)
  assert.equal(looksLikeConnectionText('https://lib.example/opds\n'), false)
  assert.equal(looksLikeConnectionText('地址：https://lib.example/opds\n用户名：a'), true)
})

// ---------------------------------------------------------------------------
// 搜索入口
// ---------------------------------------------------------------------------

const FEED = 'https://library.jiangshu.ai/opds?q=&page=1'

test('direct search template on the feed is resolved against the feed URL, keeping {searchTerms}', () => {
  const link = findSearchLink([
    { rel: ['start'], href: '/opds', type: 'application/atom+xml;profile=opds-catalog' },
    { rel: ['search'], href: '/opds?q={searchTerms}', type: 'application/atom+xml;profile=opds-catalog;kind=acquisition' },
  ], FEED)
  assert.deepEqual(link, { kind: 'template', template: 'https://library.jiangshu.ai/opds?q={searchTerms}' })
  assert.equal(
    fillSearchTemplate(link.template, '三体 刘慈欣'),
    'https://library.jiangshu.ai/opds?q=%E4%B8%89%E4%BD%93%20%E5%88%98%E6%85%88%E6%AC%A3',
  )
})

test('templates in the path survive relative resolution (no %7B…%7D)', () => {
  assert.equal(resolveTemplateHref('search/{searchTerms}/{startPage?}', 'https://h.example/opds/root.xml'),
    'https://h.example/opds/search/{searchTerms}/{startPage?}')
  assert.equal(resolveTemplateHref('https://other.example/s?q={searchTerms}', 'https://h.example/'),
    'https://other.example/s?q={searchTerms}')
})

test('OpenSearch description links are recognised and preferred over unknown types; none → null', () => {
  assert.deepEqual(findSearchLink([
    { rel: 'search', href: 'osd.xml', type: 'application/opensearchdescription+xml' },
  ], 'https://h.example/opds/'), { kind: 'opensearch', url: 'https://h.example/opds/osd.xml' })
  // 直接模板优先于描述文档
  assert.equal(findSearchLink([
    { rel: 'search', href: '/osd.xml', type: 'application/opensearchdescription+xml' },
    { rel: 'search', href: '/s?q={searchTerms}', type: 'application/atom+xml' },
  ], 'https://h.example/').kind, 'template')
  // rel 以空格分隔的字符串也认
  assert.equal(findSearchLink([{ rel: 'search alternate', href: '/osd' }], 'https://h.example/').kind, 'opensearch')
  assert.equal(findSearchLink([{ rel: ['next'], href: '/p2' }], 'https://h.example/'), null)
  assert.equal(findSearchLink([{ rel: ['search'], href: '/feed', type: 'application/atom+xml' }], 'https://h.example/'), null)
  assert.equal(findSearchLink(undefined, 'https://h.example/'), null)
})

test('template filling: required defaults, optional and namespaced parameters cleared', () => {
  assert.equal(
    fillSearchTemplate('https://h/s?q={searchTerms}&n={count}&p={startPage?}&a={atom:author?}&l={language}', 'a&b'),
    'https://h/s?q=a%26b&n=50&p=&a=&l=*',
  )
  assert.equal(applyOpenSearchOffsets('/s?q={searchTerms}&i={startIndex}&p={startPage}', '0', null), '/s?q={searchTerms}&i=0&p=1')
  assert.equal(pickOpenSearchUrl([
    { type: 'text/html', template: '/html?q={searchTerms}' },
    { type: 'application/atom+xml', template: '/atom?q={searchTerms}' },
    { type: 'application/atom+xml;profile=opds-catalog', template: '/opds?q={searchTerms}' },
  ]).template, '/opds?q={searchTerms}')
  assert.equal(pickOpenSearchUrl([{ type: 'text/html', template: null }]), undefined)
})

// ---------------------------------------------------------------------------
// 获取格式
// ---------------------------------------------------------------------------

test('acquisition labels come from MIME, with extension fallback only for generic MIME', () => {
  assert.equal(acquisitionLabel('application/epub+zip', '/download/abc.epub'), 'EPUB')
  assert.equal(acquisitionLabel('application/x-mobipocket-ebook'), 'MOBI')
  assert.equal(acquisitionLabel('application/vnd.amazon.ebook'), 'AZW3')
  assert.equal(acquisitionLabel('application/octet-stream', '/download/abc.epub?sig=1'), 'EPUB')
  assert.equal(acquisitionLabel('', '/download/x.pdf'), 'PDF')
  assert.equal(acquisitionLabel('text/html', '/download/x.epub'), null)
  assert.equal(acquisitionLabel('application/octet-stream', '/download/x.rar'), null)
})

test('EPUB is primary, other formats stay available in rank order, duplicates removed', () => {
  const acqs = [
    { href: '/a.pdf', type: 'application/pdf', label: 'PDF' },
    { href: '/a.txt', type: 'text/plain', label: 'TXT' },
    { href: '/a.mobi', type: 'application/x-mobipocket-ebook', label: 'MOBI' },
    { href: '/a.epub', type: 'application/epub+zip', label: 'EPUB' },
    { href: '/a-noimg.epub', type: 'application/epub+zip', label: 'EPUB' },
    { href: '/a.pdf', type: 'application/pdf', label: 'PDF' },
  ]
  const { primary, others } = pickPrimaryAcquisition(acqs)
  assert.equal(primary.href, '/a.epub')
  assert.deepEqual(others.map(a => a.href), ['/a-noimg.epub', '/a.mobi', '/a.pdf', '/a.txt'])
  assert.deepEqual(sortAcquisitions([]), [])
  assert.deepEqual(pickPrimaryAcquisition([]), { primary: undefined, others: [] })
})

test('only user-added OPDS sources join unified search; timeouts reject without waiting', async () => {
  const list = [
    { id: '1', kind: 'opds', builtin: true },
    { id: '2', kind: 'arxiv', builtin: false },
    { id: '3', kind: 'opds', builtin: false },
  ]
  assert.deepEqual(userOpdsSources(list).map(s => s.id), ['3'])

  let aborted = false
  const started = Date.now()
  await assert.rejects(
    withTimeout(new Promise(() => {}), 20, '响应超时', () => { aborted = true }),
    err => err instanceof TimeoutError && err.message === '响应超时',
  )
  assert.ok(aborted)
  assert.ok(Date.now() - started < 1000)
  assert.equal(await withTimeout(Promise.resolve(7), 1000, 'x'), 7)
})

// ---------------------------------------------------------------------------
// opds.ts 编排: 发现 → 缓存 → 搜索, 全程带书源账号 (网络与 foliate 解析用替身)
// ---------------------------------------------------------------------------

const state = { docs: new Map(), calls: [] }
globalThis.__opdsLibraryTest = state
const opdsUrl = new URL('../src/services/opds.ts', import.meta.url).href
const stubs = {
  // getFeed 直接返回替身文档里放好的 foliate 解析结果
  'foliate-js/opds.js': 'export const getFeed = doc => doc.feed; export const SYMBOL = { CONTENT: Symbol("content"), SUMMARY: Symbol("summary") }',
  './net': `export const fetchXml = async (url, auth, init) => {
      const s = globalThis.__opdsLibraryTest
      s.calls.push({ url, auth, signal: init?.signal })
      const doc = s.docs.get(url)
      if (!doc) throw new Error('请求失败: 404 ' + url)
      if (doc instanceof Error) throw doc
      return doc
    }
    export const fetchBlob = async () => { throw new Error('unused') }`,
  './importer': 'export const importFile = async () => ({ ok: true })',
  './format': 'export const detectFormat = () => "epub"',
  '../i18n': 'export const t = key => key',
}
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === opdsUrl && stubs[specifier]) {
      return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}` }
    }
    return nextResolve(specifier, context)
  },
})
const opds = await import(opdsUrl)
hook.deregister()

const ROOT = 'https://library.example/opds'
const AUTH = { username: 'lightread', password: 'secret' }
const source = { id: 'src-1', url: ROOT, ...AUTH }

const pub = (title, links) => ({ metadata: { title, author: [{ name: '作者' }] }, links })
const feedDoc = feed => ({ feed })
const rootFeed = (searchLinks) => feedDoc({
  metadata: { title: '我的书库' },
  links: [{ rel: ['start'], href: '/opds' }, ...searchLinks, { rel: ['next'], href: '/opds?q=&page=2' }],
  publications: [],
})
const resultFeed = feedDoc({
  metadata: { title: '搜索' },
  links: [{ rel: ['next'], href: '/opds?q=%E4%B8%89%E4%BD%93&page=2' }],
  publications: [
    pub('三体', [
      { rel: ['http://opds-spec.org/acquisition'], href: '/download/abc.pdf', type: 'application/pdf' },
      { rel: ['http://opds-spec.org/acquisition'], href: '/download/abc.epub', type: 'application/epub+zip' },
    ]),
  ],
})

beforeEach(() => {
  state.docs.clear()
  state.calls.length = 0
  opds.forgetSearchTemplate()
})

test('direct-template source: root then search, both with credentials; template is cached', async () => {
  state.docs.set(ROOT, rootFeed([{ rel: ['search'], href: '/opds?q={searchTerms}', type: 'application/atom+xml;profile=opds-catalog;kind=acquisition' }]))
  state.docs.set('https://library.example/opds?q=%E4%B8%89%E4%BD%93', resultFeed)

  const page = await opds.searchOpdsSource(source, '三体')
  assert.deepEqual(state.calls.map(c => c.url), [ROOT, 'https://library.example/opds?q=%E4%B8%89%E4%BD%93'])
  assert.ok(state.calls.every(c => c.auth.username === 'lightread' && c.auth.password === 'secret'))
  assert.equal(page.next, 'https://library.example/opds?q=%E4%B8%89%E4%BD%93&page=2')
  // 相对获取链接已解析, EPUB 排第一
  assert.deepEqual(page.publications[0].acquisitions.map(a => [a.label, a.href]), [
    ['EPUB', 'https://library.example/download/abc.epub'],
    ['PDF', 'https://library.example/download/abc.pdf'],
  ])

  state.calls.length = 0
  await opds.searchOpdsSource(source, '三体')
  assert.deepEqual(state.calls.map(c => c.url), ['https://library.example/opds?q=%E4%B8%89%E4%BD%93'], 'root not refetched')
})

test('OpenSearch description is fetched with the source credentials and offsets applied', async () => {
  state.docs.set(ROOT, rootFeed([{ rel: ['search'], href: 'search.xml', type: 'application/opensearchdescription+xml' }]))
  const urlEl = attrs => ({ getAttribute: name => attrs[name] ?? null })
  state.docs.set('https://library.example/search.xml', {
    getElementsByTagNameNS: (ns, name) => name === 'Url' ? [
      urlEl({ type: 'text/html', template: '/html?q={searchTerms}' }),
      urlEl({ type: 'application/atom+xml;profile=opds-catalog', template: 'find/{searchTerms}?p={startPage}', pageOffset: '0' }),
    ] : [],
  })
  state.docs.set('https://library.example/find/dune?p=0', resultFeed)

  const page = await opds.searchOpdsSource(source, 'dune')
  assert.equal(page.publications.length, 1)
  const osdCall = state.calls.find(c => c.url.endsWith('/search.xml'))
  assert.deepEqual(osdCall.auth, AUTH)
  assert.equal(await opds.discoverSearchTemplate('https://h/s?q={searchTerms}'), 'https://h/s?q={searchTerms}')
})

test('sources without search return null; failures are not cached and pass the abort signal through', async () => {
  state.docs.set(ROOT, rootFeed([]))
  assert.equal(await opds.searchOpdsSource(source, 'x'), null)

  const other = { ...source, id: 'src-2', url: 'https://down.example/opds' }
  state.docs.set(other.url, new Error('需要账号授权 (401)'))
  const ctrl = new AbortController()
  await assert.rejects(opds.searchOpdsSource(other, 'x', ctrl.signal), /401/)
  assert.equal(state.calls.at(-1).signal, ctrl.signal)
  state.docs.set(other.url, rootFeed([{ rel: ['search'], href: '/s?q={searchTerms}' }]))
  state.docs.set('https://down.example/s?q=x', resultFeed)
  const page = await opds.searchOpdsSource(other, 'x')
  assert.equal(page.publications.length, 1, 'retried after failure')
})
