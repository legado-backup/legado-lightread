import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WEB_BOOK_SOURCES, webBookSourceUrl } from '../src/services/webBookSources.ts'

test('website queries preserve reserved characters and cannot replace the provider origin', () => {
  const query = ' 中文 /?a=1&b=2#fragment '
  for (const source of WEB_BOOK_SOURCES) {
    const url = webBookSourceUrl(source, query)
    assert.equal(new URL(url).origin, new URL(source.url).origin)
    assert.equal(new URL(url).protocol, 'https:')
    if (source.searchUrl) assert.ok(url.includes(encodeURIComponent(query.trim())))
    else assert.equal(url, source.url)
    assert.equal(webBookSourceUrl(source, '  '), source.url)
  }
})
