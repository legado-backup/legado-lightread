/**
 * WebDAV 服务商: 设置页「选一下、填账号密码、点连接」的数据与连接校验.
 *
 * 只收录地址固定的服务商 (核实来源见 docs/sync.md「WebDAV 服务商」), 其余走「自建 / 其他」填地址.
 * 网页版: 坚果云 / Koofr 不支持浏览器跨域, 请求经轻阅同步服务 (sync-server 的 /v1/webdav/<id>/) 原样中转,
 * 由 net.ts 在发请求时改写地址; settings.webdavUrl 仍存真实地址, 桌面 / 安卓原生请求直连.
 */
export type WebdavProviderId = 'jianguoyun' | 'koofr' | 'selfhosted' | 'other'

export interface WebdavProvider {
  id: WebdavProviderId
  /** 固定地址 (有则不让用户填地址) */
  url?: string
  /** 生成应用密码的网页 */
  appPasswordUrl?: string
  /** 网页版经同步服务中转 */
  relay?: boolean
}

export const WEBDAV_PROVIDERS: WebdavProvider[] = [
  {
    id: 'jianguoyun',
    url: 'https://dav.jianguoyun.com/dav/',
    appPasswordUrl: 'https://www.jianguoyun.com/#/safety',
    relay: true,
  },
  {
    id: 'koofr',
    url: 'https://app.koofr.net/dav/Koofr',
    appPasswordUrl: 'https://app.koofr.net/app/admin/preferences/password',
    relay: true,
  },
  { id: 'selfhosted' },
  { id: 'other' },
]

export const providerOf = (id: string): WebdavProvider =>
  WEBDAV_PROVIDERS.find(p => p.id === id) ?? WEBDAV_PROVIDERS[WEBDAV_PROVIDERS.length - 1]

const trimSlash = (s: string) => s.trim().replace(/\/+$/, '')

/** 地址是否落在服务商固定地址之下; 是则返回其后的相对路径 (不含开头的 /) */
function relativeTo(base: string, url: string): string | null {
  const b = trimSlash(base).toLowerCase()
  const u = url.trim()
  if (u.toLowerCase() === b) return ''
  if (!u.toLowerCase().startsWith(b + '/')) return null
  return u.slice(b.length + 1)
}

/** 依据已保存的地址识别服务商 (老用户没有 webdavProvider 字段时) */
export function detectProvider(url: string, saved = ''): WebdavProviderId {
  const known = WEBDAV_PROVIDERS.find(p => p.url && relativeTo(p.url, url) !== null)
  if (known) return known.id
  if (saved === 'selfhosted' || saved === 'other') return saved
  return url.trim() ? 'other' : 'jianguoyun'
}

/**
 * 网页版的中转地址: 地址属于需要中转的服务商时返回 `<api>/v1/webdav/<id>/<相对路径>`, 否则 null.
 */
export function webdavRelayUrl(url: string, apiBase: string): string | null {
  for (const p of WEBDAV_PROVIDERS) {
    if (!p.relay || !p.url) continue
    const rest = relativeTo(p.url, url)
    if (rest !== null) return `${trimSlash(apiBase)}/v1/webdav/${p.id}/${rest}`
  }
  return null
}

/** 补全协议; 解析失败返回 null */
export function normalizeAddress(raw: string): URL | null {
  let s = raw.trim()
  if (!s) return null
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null
  } catch {
    return null
  }
}

/**
 * 连接时依次尝试的地址.
 *  - 固定服务商: 只有固定地址
 *  - 其他: 用户填的完整地址 (补 https://)
 *  - 自建: 只填了域名 (没有路径) 时, 依次试 根目录 (群晖 WebDAV Server 等)、
 *    Nextcloud / ownCloud 的 /remote.php/dav/files/<用户名>/、Alist 等的 /dav/; 以返回 207 的为准
 */
export function candidateUrls(provider: WebdavProviderId, address: string, user: string): string[] {
  const p = providerOf(provider)
  if (p.url) return [p.url]
  const u = normalizeAddress(address)
  if (!u) return []
  const full = u.href
  if (provider === 'other' || (u.pathname !== '/' && u.pathname !== '')) return [full]
  const origin = u.origin
  return [...new Set([
    `${origin}/`,
    `${origin}/remote.php/dav/files/${encodeURIComponent(user.trim())}/`,
    `${origin}/dav/`,
  ])]
}

/** 展示用: 固定服务商不显示地址, 自建 / 其他显示主机名 (带非默认端口) */
export function displayHost(url: string): string {
  const u = normalizeAddress(url)
  return u ? u.host : url
}
