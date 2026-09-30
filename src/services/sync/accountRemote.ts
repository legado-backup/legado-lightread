/**
 * 轻阅账号同步后端 (sync.jiangshu.ai, 接口见 docs/account-api.md).
 * 只存各设备的 SyncDoc, 不存书籍文件 (supportsFiles = false).
 * 这里也放账号接口共用的请求与错误映射 (account.ts 复用), 本模块不依赖 vue / pinia, 可在 node 里测试.
 * 走全局 fetch: 服务端 CORS 为 `*`, 不能走 net.ts 的 fetchRemote (网页版会绕到用户的 CORS 代理).
 */
import { SYNC_FORMAT } from './types.ts'
import type { SyncDoc, SyncRemote } from './types'

export type TranslateFn = (key: string, params?: Record<string, string | number>) => string

/** fetch 的子集 (测试注入内存假服务器) */
export type FetchFn = (url: string, init: {
  method: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
}) => Promise<{ status: number; text(): Promise<string> }>

export interface AccountRemoteConfig {
  /** 服务地址, 如 https://sync.jiangshu.ai (不带末尾斜杠) */
  base: string
  token: string
  accountId: string
}

/** 账号接口的错误; message 已本地化 */
export class AccountApiError extends Error {
  /** HTTP 状态; 0 为网络错误 / 超时 */
  readonly status: number
  /** 服务端错误码 (`invalid_email` 等), 可能为空 */
  readonly code: string
  /** 限流时服务端建议的等待秒数 */
  readonly retryAfter?: number

  constructor(message: string, status: number, code = '', retryAfter?: number) {
    super(message)
    this.name = 'AccountApiError'
    this.status = status
    this.code = code
    if (retryAfter !== undefined) this.retryAfter = retryAfter
  }

  /** 会话失效 (401): 调用方应清除本地登录状态 */
  get unauthorized(): boolean {
    return this.status === 401
  }
}

export function isAccountUnauthorized(err: unknown): boolean {
  return err instanceof AccountApiError && err.unauthorized
}

const defaultFetch: FetchFn = (url, init) => fetch(url, init)

async function defaultTranslate(key: string, params?: Record<string, string | number>) {
  const { t } = await import('../../i18n/index.ts')
  return t(key, params)
}

/** 登录相关接口的错误码 → 文案 key; 其它接口 (同步文档) 只区分 401 与其它状态 */
const AUTH_CODES: Record<string, string> = {
  invalid_email: 'account.err.invalidEmail',
  rate_limited: 'account.err.rateLimited',
  invalid_code: 'account.err.invalidCode',
  too_many_attempts: 'account.err.tooManyAttempts',
  email_failed: 'account.err.emailFailed',
}

export interface AccountRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  /** 以 / 开头, 如 /v1/docs */
  path: string
  token?: string
  /** JSON 请求体 (已序列化的字符串原样发送) */
  body?: unknown
  /** 是否按登录接口的错误码细分文案 */
  auth?: boolean
  timeoutMs?: number
  fetchFn?: FetchFn
  translate?: TranslateFn
}

/**
 * 请求账号接口. 2xx 返回解析后的 JSON (204 / 空体为 null);
 * 其它状态与网络错误抛出 AccountApiError (message 已本地化).
 */
export async function accountRequest<T = unknown>(base: string, req: AccountRequest): Promise<T | null> {
  const tr = async (key: string, params?: Record<string, string | number>) =>
    req.translate ? req.translate(key, params) : defaultTranslate(key, params)
  const headers: Record<string, string> = {}
  if (req.token) headers.authorization = `Bearer ${req.token}`
  let body: string | undefined
  if (req.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body)
  }
  const signal = typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
    ? AbortSignal.timeout(req.timeoutMs ?? 30_000)
    : undefined

  let status: number
  let text: string
  try {
    const res = await (req.fetchFn ?? defaultFetch)(base.replace(/\/+$/, '') + req.path, {
      method: req.method, headers, body, signal,
    })
    status = res.status
    text = await res.text()
  } catch (err) {
    console.warn('[account] request failed', req.method, req.path, err)
    throw new AccountApiError(await tr('account.err.network'), 0)
  }

  let json: unknown = null
  if (text) {
    try { json = JSON.parse(text) } catch { /* 非 JSON (如网关错误页) */ }
  }
  if (status >= 200 && status < 300) return json as T | null

  const errBody = (json && typeof json === 'object' ? json : {}) as { error?: unknown; retryAfter?: unknown }
  const code = typeof errBody.error === 'string' ? errBody.error : ''
  const retry = Number(errBody.retryAfter)
  const retryAfter = Number.isFinite(retry) && retry > 0 ? Math.ceil(retry) : undefined
  let message: string
  if (status === 401) message = await tr('account.err.unauthorized')
  else if (req.auth && AUTH_CODES[code]) {
    message = await tr(AUTH_CODES[code], code === 'rate_limited' ? { seconds: retryAfter ?? 60 } : undefined)
  } else message = await tr('account.err.server', { status })
  throw new AccountApiError(message, status, code, retryAfter)
}

function isSyncDoc(v: unknown): v is SyncDoc {
  if (!v || typeof v !== 'object') return false
  const d = v as Record<string, unknown>
  const isObj = (x: unknown) => !!x && typeof x === 'object' && !Array.isArray(x)
  return d.format === SYNC_FORMAT && typeof d.deviceId === 'string' && !!d.deviceId
    && isObj(d.books) && isObj(d.annotations) && isObj(d.booklists)
    && isObj(d.booklistItems) && isObj(d.sources)
}

/** 同步文档可达 8MB, 慢网下给足时间 */
const DOC_TIMEOUT_MS = 120_000

export function createAccountRemote(
  cfg: AccountRemoteConfig,
  fetchFn?: FetchFn,
  translate?: TranslateFn,
): SyncRemote {
  const base = cfg.base.trim().replace(/\/+$/, '')
  const call = <T>(method: AccountRequest['method'], path: string, body?: unknown) =>
    accountRequest<T>(base, {
      method, path, body, token: cfg.token, timeoutMs: DOC_TIMEOUT_MS, fetchFn, translate,
    })
  const noFiles = () => Promise.reject(new Error('account remote does not store files'))

  return {
    kind: 'account',
    id: `account:${cfg.accountId}`,
    supportsFiles: false,

    async prepare() { /* 无需准备 */ },

    async listDocs() {
      const res = await call<{ docs?: unknown }>('GET', '/v1/docs')
      const docs = Array.isArray(res?.docs) ? res.docs : []
      // 未来格式 / 损坏的文档跳过
      return docs.filter(isSyncDoc)
    },

    async putDoc(doc) {
      await call('PUT', `/v1/docs/${encodeURIComponent(doc.deviceId)}`, JSON.stringify(doc))
    },

    async listFiles() {
      return new Set<string>()
    },

    putFile: noFiles,
    getFile: noFiles,
  }
}
