import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const source = await readFile(new URL('../src/services/githubBooks.ts', import.meta.url), 'utf8')
const formatSource = await readFile(new URL('../src/services/format.ts', import.meta.url), 'utf8')
const bookQuerySource = await readFile(new URL('../src/services/bookQuery.ts', import.meta.url), 'utf8')
const compile = text => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const dataModule = text => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`
let sequence = 0

async function harness(fetchRemote, cache = new Map()) {
  const hook = `__githubBookFetch${sequence++}`
  globalThis[hook] = fetchRemote
  globalThis.localStorage = {
    getItem: key => cache.get(key) ?? null,
    setItem: (key, value) => cache.set(key, value),
  }
  // Compile the real service and replace only IO imports; no source behavior is reimplemented.
  const code = compile(source)
    .replace("'./net'", JSON.stringify(dataModule(`export const fetchRemote = (...args) => globalThis[${JSON.stringify(hook)}](...args)`)))
    .replace("'./format'", JSON.stringify(dataModule(compile(formatSource))))
    .replace("'./bookQuery'", JSON.stringify(dataModule(compile(bookQuerySource))))
  return { service: await import(dataModule(code)), cache }
}

const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })
const blob = (path, size = 5000, extra = {}) => ({ path, size, mode: '100644', type: 'blob', ...extra })

test('no third-party book repositories are bundled or fetched: only what the user added is searched', async () => {
  assert.doesNotMatch(source, /booksources\.json|fetchCommunityRepos|ChinaTextbook/)
  const requested = []
  const { service } = await harness(async url => { requested.push(url); return json({ tree: [blob('book.epub')] }) })
  assert.deepEqual(Object.keys(service).sort(), ['fmtBytes', 'isValidRepo', 'searchGithubBooks'])
  assert.deepEqual(await service.searchGithubBooks([], 'book'), { hits: [], errors: [], truncated: false })
  assert.equal(requested.length, 0)
  await service.searchGithubBooks(['me/my-books'], 'book')
  assert.deepEqual(requested, ['https://api.github.com/repos/me/my-books/git/trees/HEAD?recursive=1'])
})

test('all simultaneous searches share a four-request concurrency limit', async () => {
  let active = 0
  let peak = 0
  const { service } = await harness(async () => {
    active++
    peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, 5))
    active--
    return json({ tree: [blob('book.epub')], truncated: false })
  })
  const repos = Array.from({ length: 12 }, (_, index) => `owner/repo${index}`)
  const results = await Promise.all([service.searchGithubBooks(repos.slice(0, 6), 'book'), service.searchGithubBooks(repos.slice(6), 'book')])
  assert.equal(results.flatMap(result => result.hits).length, 12)
  assert.equal(peak, 4)
})

test('failures remain per-repository and truncated trees are honestly marked', async () => {
  const { service } = await harness(async url => {
    if (url.includes('/bad/')) throw new Error('rate limited')
    return json({ tree: [blob('可读 中文 #1.epub')], truncated: true })
  })
  const result = await service.searchGithubBooks(['owner/good', 'owner/bad', 'owner/../escape'], '中文')
  assert.equal(result.hits.length, 1)
  assert.equal(result.errors.length, 2)
  assert.equal(result.truncated, true)
  assert.match(result.hits[0].url, /%20%E4%B8%AD%E6%96%87%20%231\.epub$/)
})

test('LFS pointers, symlinks, invalid paths and empty files are excluded', async () => {
  const { service } = await harness(async url => url.includes('raw.githubusercontent.com')
    ? new Response(url.endsWith('pointer.pdf') ? 'version https://git-lfs.github.com/spec/v1\noid sha256:abcd\nsize 999999\n' : '一首真实的短诗')
    : json({ tree: [blob('pointer.pdf', 130), blob('poem.txt', 24), blob('book.epub'), blob('empty.epub', 0), blob('link.epub', 30, { mode: '120000' }), blob('../escape.pdf')] }))
  const result = await service.searchGithubBooks(['owner/books'], '')
  assert.deepEqual(result.hits.map(hit => hit.name).sort(), ['book.epub', 'poem.txt'])
})

test('only book files are returned and matched by path', async () => {
  const { service } = await harness(async () => json({ tree: [blob('深度学习/main.pdf'), blob('other/cover.pdf'), blob('README.md')] }))
  const result = await service.searchGithubBooks(['owner/books'], '深度学习')
  assert.deepEqual(result.hits.map(hit => hit.path), ['深度学习/main.pdf'])
})

test('small text and Markdown files do not fan out into content requests', async () => {
  let calls = 0
  const { service } = await harness(async () => {
    calls++
    return json({ tree: Array.from({ length: 120 }, (_, index) => blob(`notes/${index}.md`, 200)) })
  })
  await service.searchGithubBooks(['owner/notes'], 'missing')
  assert.equal(calls, 1)
})

test('file trees are cached for 24 hours and duplicate repo names are searched once', async () => {
  let calls = 0
  const { service, cache } = await harness(async () => { calls++; return json({ tree: [blob('book.epub')] }) })
  assert.equal((await service.searchGithubBooks(['owner/books', 'OWNER/BOOKS'], '')).hits.length, 1)
  await service.searchGithubBooks(['OWNER/BOOKS'], '')
  assert.equal(calls, 1)
  const [key, value] = [...cache.entries()].find(([key]) => key.startsWith('lightread-ghtree-'))
  cache.set(key, JSON.stringify({ ...JSON.parse(value), at: Date.now() - 25 * 60 * 60 * 1000 }))
  await service.searchGithubBooks(['OWNER/BOOKS'], '')
  assert.equal(calls, 2)
})

test('punctuation in the query is ignored and exact titles rank first', async () => {
  const { service } = await harness(async () => json({ tree: [
    blob('a/活着活着就老了.epub'), blob('b/活着-余华.mobi'), blob('c/活着.epub'), blob('d/人生/活着之后.pdf'),
    blob('e/思考快与慢.epub'), blob('f/思考，快与慢（丹尼尔·卡尼曼）.pdf'), blob('g/思考的乐趣.epub'),
  ] }))
  const alive = await service.searchGithubBooks(['owner/books'], '活着')
  assert.equal(alive.hits[0].name, '活着.epub')
  assert.deepEqual(alive.hits.map(hit => hit.name).sort(), ['活着.epub', '活着-余华.mobi', '活着之后.pdf', '活着活着就老了.epub'].sort())
  for (const query of ['思考，快与慢', '《思考 快与慢》', '思考快与慢']) {
    const thinking = await service.searchGithubBooks(['owner/books'], query)
    assert.deepEqual(thinking.hits.map(hit => hit.name).sort(), ['思考快与慢.epub', '思考，快与慢（丹尼尔·卡尼曼）.pdf'].sort(), query)
  }
})
