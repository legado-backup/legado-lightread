/**
 * WebDAV: 设置页的「连接」校验, 以及整库备份 zip 的推送 / 恢复 (坚果云 / Nextcloud / Alist …).
 * 桌面 / 安卓走原生请求无跨域限制; 网页版见 webdavProviders.ts 的中转说明.
 */
import { fetchRemote, type RequestAuth } from './net'
import { exportBackup, importBackup } from './backup'
import { useSettings } from '../stores/settings'
import { isTauri } from '../storage/types'
import { t } from '../i18n'
import { candidateUrls, providerOf, type WebdavProviderId } from './webdavProviders'

const FOLDER = 'LightRead'
const FILE = 'lightread-backup.zip'

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>'

function davConfig(): { base: string; auth: RequestAuth } {
  const settings = useSettings()
  const base = settings.webdavUrl.trim().replace(/\/+$/, '')
  if (!base) throw new Error(t('sync.err.notConfigured'))
  return {
    base,
    auth: { username: settings.webdavUser, password: settings.webdavPass },
  }
}

const backupUrl = (base: string) => `${base}/${FOLDER}/${FILE}`

/** PROPFIND depth 0; 返回状态码, 网络层失败 (断网 / 跨域被拦) 抛错 */
async function propfindStatus(url: string, auth: RequestAuth): Promise<number> {
  const res = await fetchRemote(url.replace(/\/*$/, '/'), auth, {
    method: 'PROPFIND',
    headers: { depth: '0', 'content-type': 'application/xml; charset=utf-8' },
    body: PROPFIND_BODY,
    raw: true,
  })
  return res.status
}

/** 已带出处的连接错误 (设置页据 kind 给出操作入口, 如「去生成应用密码」) */
export class WebdavConnectError extends Error {
  readonly kind: 'auth' | 'network' | 'notDav' | 'input'
  constructor(message: string, kind: WebdavConnectError['kind']) {
    super(message)
    this.kind = kind
  }
}

export interface WebdavDraft {
  provider: WebdavProviderId
  /** 自建 / 其他的地址; 固定服务商忽略 */
  address: string
  user: string
  pass: string
}

/**
 * 校验能否连上, 返回可用的 WebDAV 地址 (自建只填域名时自动探测常见路径).
 * 失败抛 WebdavConnectError, 文案已本地化并说明怎么解决.
 */
export async function verifyWebdav(draft: WebdavDraft): Promise<string> {
  const provider = providerOf(draft.provider)
  if (!provider.url && !draft.address.trim()) throw new WebdavConnectError(t('webdav.err.noAddress'), 'input')
  if (!draft.user.trim()) throw new WebdavConnectError(t('webdav.err.noUser'), 'input')
  if (!draft.pass) throw new WebdavConnectError(t('webdav.err.noPass'), 'input')
  const urls = candidateUrls(draft.provider, draft.address, draft.user)
  if (!urls.length) throw new WebdavConnectError(t('webdav.err.badAddress'), 'input')

  const auth = { username: draft.user.trim(), password: draft.pass }
  let authFailed = false
  let networkFailed = false
  let lastStatus = 0
  for (const url of urls) {
    let status: number
    try {
      status = await propfindStatus(url, auth)
    } catch {
      networkFailed = true
      continue
    }
    if (status === 207) return url
    if (status === 401 || status === 403) authFailed = true
    lastStatus = status
  }
  if (authFailed) {
    throw new WebdavConnectError(t(provider.appPasswordUrl ? 'webdav.err.authAppPassword' : 'webdav.err.auth', {
      name: t(`webdav.provider.${provider.id}`),
    }), 'auth')
  }
  if (networkFailed && !lastStatus) {
    const key = isTauri() ? 'webdav.err.network' : provider.relay ? 'webdav.err.relay' : 'webdav.err.cors'
    throw new WebdavConnectError(t(key), 'network')
  }
  // 网页版中转尚未上线时同步服务返回 404
  if (!isTauri() && provider.relay && lastStatus === 404) throw new WebdavConnectError(t('webdav.err.relay'), 'network')
  // 404 / 409 (坚果云对不存在的路径返回 409): 地址里的目录不存在
  if (lastStatus === 404 || lastStatus === 409) throw new WebdavConnectError(t('webdav.err.noFolder', { status: lastStatus }), 'notDav')
  throw new WebdavConnectError(t('webdav.err.notDav', { status: lastStatus }), 'notDav')
}

/** 测试已保存配置的连通性, 顺带查询云端整库备份 */
export async function testWebdav(): Promise<{ size: number; modified: string } | null> {
  const { base, auth } = davConfig()
  let status: number
  try {
    status = await propfindStatus(base, auth)
  } catch {
    throw new Error(t(isTauri() ? 'webdav.err.network' : 'webdav.err.cors'))
  }
  if (status === 401 || status === 403) throw new Error(t('sync.err.auth'))
  if (status >= 400) throw new Error(t('sync.err.http', { status }))
  return webdavBackupInfo()
}

/** 备份到云端 */
export async function backupToWebdav(onProgress?: (msg: string) => void): Promise<void> {
  const { base, auth } = davConfig()
  const blob = await exportBackup(onProgress)
  onProgress?.(t('webdav.creatingFolder'))
  await fetchRemote(`${base}/${FOLDER}`, auth, { method: 'MKCOL', raw: true })
  onProgress?.(t('webdav.uploadingBackup', { size: (blob.size / 1024 / 1024).toFixed(1) }))
  const res = await fetchRemote(backupUrl(base), auth, {
    method: 'PUT',
    body: blob,
    headers: { 'content-type': 'application/zip' },
    raw: true,
  })
  if (res.status >= 400) throw new Error(t('sync.err.http', { status: res.status }))
}

/** 云端备份信息 (不存在返回 null) */
export async function webdavBackupInfo(): Promise<{ size: number; modified: string } | null> {
  const { base, auth } = davConfig()
  const res = await fetchRemote(backupUrl(base), auth, { method: 'HEAD', raw: true })
  if (res.status === 404) return null
  if (res.status >= 400) throw new Error(t('sync.err.http', { status: res.status }))
  return {
    size: parseInt(res.headers.get('content-length') ?? '0', 10),
    modified: res.headers.get('last-modified') ?? '',
  }
}

/** 从云端恢复 (增量合并, 已有书籍跳过) */
export async function restoreFromWebdav(
  onProgress?: (msg: string) => void,
): Promise<{ books: number; annotations: number; sources: number }> {
  const { base, auth } = davConfig()
  onProgress?.(t('webdav.downloadingBackup'))
  const res = await fetchRemote(backupUrl(base), auth, { raw: true })
  if (res.status === 404) throw new Error(t('webdav.noBackup'))
  if (res.status >= 400) throw new Error(t('sync.err.http', { status: res.status }))
  const blob = await res.blob()
  return importBackup(new File([blob], FILE), onProgress)
}
