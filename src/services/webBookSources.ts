/** Website sources use the system browser so sign-in stays on the provider's site. */
export interface WebBookSource {
  id: string
  title: string
  url: string
  searchUrl?: string
  descriptionKey: string
}

export const WEB_BOOK_SOURCES: WebBookSource[] = [
  { id: 'standardebooks', title: 'Standard Ebooks', url: 'https://standardebooks.org/ebooks', searchUrl: 'https://standardebooks.org/ebooks?query={query}', descriptionKey: 'catalog.standardebooksHint' },
  { id: 'shuge', title: '书格 · Shuge', url: 'https://www.shuge.org/', searchUrl: 'https://www.shuge.org/?s={query}&post_type=portfolio', descriptionKey: 'catalog.shugeHint' },
  { id: 'globalgrey', title: 'Global Grey', url: 'https://www.globalgreyebooks.com/index.html', descriptionKey: 'catalog.globalgreyHint' },
  { id: 'fadedpage', title: 'Faded Page', url: 'https://www.fadedpage.com/csearch.php', descriptionKey: 'catalog.fadedpageHint' },
  { id: 'zlibrary', title: 'Z-Library', url: 'https://z-library.sk/', searchUrl: 'https://z-library.sk/s/{query}', descriptionKey: 'catalog.zlibraryHint' },
  { id: 'annas', title: "Anna’s Archive", url: 'https://annas-archive.gl/', searchUrl: 'https://annas-archive.gl/search?q={query}', descriptionKey: 'catalog.annasHint' },
]

export function webBookSourceUrl(source: WebBookSource, query: string): string {
  const trimmed = query.trim()
  return trimmed && source.searchUrl
    ? source.searchUrl.replace('{query}', encodeURIComponent(trimmed))
    : source.url
}
