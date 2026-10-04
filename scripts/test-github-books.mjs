import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const source = await readFile(new URL('../src/services/githubBooks.ts', import.meta.url), 'utf8')
const formatSource = await readFile(new URL('../src/services/format.ts', import.meta.url), 'utf8')
const bundled = JSON.parse(await readFile(new URL('../booksources.json', import.meta.url), 'utf8'))
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
    .replace("'../../booksources.json'", JSON.stringify(dataModule(`export default ${JSON.stringify(bundled)}`)))
  return { service: await import(dataModule(code)), cache }
}

const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })
const blob = (path, size = 5000, extra = {}) => ({ path, size, mode: '100644', type: 'blob', ...extra })
const cacheKey = 'lightread-community-sources'

test('at least six new repositories contain curated book paths', () => {
  const repos = bundled.githubRepos.filter(repo => repo.include?.length)
  assert.equal(repos.length, 6)
  for (const repo of repos) assert.ok(repo.include.every(path => /\.(epub|pdf)$/.test(path)))
})

test('old and same-date remote manifests cannot hide newly bundled repositories', async () => {
  for (const updated of ['2026-07-12', bundled.updated, 'not-a-date']) {
    const { service } = await harness(async () => json({ updated, githubRepos: [{ repo: 'old/books' }] }))
    const list = await service.fetchCommunityRepos(true)
    assert.equal(list.updated, bundled.updated)
    assert.equal(list.fromRemote, false)
    assert.ok(list.repos.some(repo => repo.repo === 'nndl/nndl'))
  }
})

test('fresh or expired old caches cannot override the newer bundled manifest', async () => {
  for (const at of [Date.now(), 0]) {
    let calls = 0
    const cache = new Map([[cacheKey, JSON.stringify({ at, updated: '2026-07-12', repos: [{ repo: 'old/books' }] })]])
    const { service } = await harness(async () => { calls++; throw new Error('offline') }, cache)
    const list = await service.fetchCommunityRepos()
    assert.equal(list.repos.length, bundled.githubRepos.length)
    assert.equal(calls, at ? 0 : 1)
  }
})

test('a newer remote list can add/remove sources and survives cache storage failure', async () => {
  const { service } = await harness(async () => json({
    updated: '2026-10-04', githubRepos: [{ repo: ' newer/books ', include: ['books/*.epub'] }, { repo: '../invalid' }],
  }))
  globalThis.localStorage.setItem = () => { throw new Error('quota') }
  const list = await service.fetchCommunityRepos(true)
  assert.equal(list.fromRemote, true)
  assert.deepEqual(list.repos.map(repo => repo.repo), ['newer/books'])
  assert.deepEqual(list.repos[0].include, ['books/*.epub'])
})

test('a newer cached manifest is retained when upstream returns an older list', async () => {
  const cache = new Map([[cacheKey, JSON.stringify({ at: 0, updated: '2026-10-05', repos: [{ repo: 'newest/books' }] })]])
  const { service } = await harness(async () => json({ updated: '2026-10-04', githubRepos: [{ repo: 'older/books' }] }), cache)
  assert.deepEqual((await service.fetchCommunityRepos(true)).repos.map(repo => repo.repo), ['newest/books'])
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

test('curated repositories return book files and match their descriptive titles', async () => {
  const { service } = await harness(async () => json({ tree: [blob('legacy/nndl-v1/main.pdf'), blob('legacy/nndl-v1/cover.pdf'), blob('README.md')] }))
  const result = await service.searchGithubBooks(['nndl/nndl'], '深度学习')
  assert.deepEqual(result.hits.map(hit => hit.path), ['legacy/nndl-v1/main.pdf'])
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
