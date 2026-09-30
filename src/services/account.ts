/**
 * 轻阅账号 (可选, 用于多端同步). 接口见 docs/account-api.md.
 * 导出签名是设置页依赖的契约, 不要改.
 * 请求走全局 fetch (服务端 CORS 为 `*`); 出错抛出已本地化的 Error (AccountApiError, 限流时带 retryAfter).
 */
import { reactive } from 'vue'
import { t } from '../i18n/index.ts'
import { accountRequest, isAccountUnauthorized, type AccountRequest } from './sync/accountRemote.ts'
import { deviceName, waitForSync } from './sync/shared.ts'

export interface AccountInfo {
  id: string
  email: string
  createdAt: number
}

const STORAGE_KEY = 'lightread-account'
const API_OVERRIDE_KEY = 'lightread-sync-api'
const DEFAULT_API = 'https://sync.jiangshu.ai'

function parseAccount(v: unknown): AccountInfo | null {
  if (!v || typeof v !== 'object') return null
  const a = v as Record<string, unknown>
  if (typeof a.id !== 'string' || !a.id || typeof a.email !== 'string') return null
  const createdAt = Number(a.createdAt)
  return { id: a.id, email: a.email, createdAt: Number.isFinite(createdAt) ? createdAt : 0 }
}

function loadState(): { token: string; account: AccountInfo | null } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const v = raw ? JSON.parse(raw) : null
    const account = parseAccount(v?.account)
    if (account && typeof v.token === 'string' && v.token) return { token: v.token, account }
  } catch { /* 存储不可用或内容损坏: 视为未登录 */ }
  return { token: '', account: null }
}

/** 登录状态; 持久化在 localStorage `lightread-account` */
export const accountState = reactive(loadState())

function persist() {
  try {
    if (accountState.token && accountState.account) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ token: accountState.token, account: accountState.account }))
    } else {
      localStorage.removeItem(STORAGE_KEY)
    }
  } catch { /* 存储不可用: 只在本次会话内保持登录 */ }
}

/**
 * 清除本地登录状态 (不联网). 会话失效 (401) 时调用;
 * 传入 token 时只在它仍是当前 token 时清除 (避免旧请求的 401 清掉刚完成的新登录).
 */
export function clearLocalLogin(token?: string): void {
  if (token !== undefined && token !== accountState.token) return
  accountState.token = ''
  accountState.account = null
  persist()
}

/** 同步服务地址 (VITE_SYNC_API / localStorage `lightread-sync-api` 可覆盖) */
export function accountApiBase(): string {
  let override = ''
  try {
    override = localStorage.getItem(API_OVERRIDE_KEY)?.trim() ?? ''
  } catch { /* 存储不可用 */ }
  const env = (import.meta as { env?: Record<string, unknown> }).env?.VITE_SYNC_API
  const fromEnv = typeof env === 'string' ? env.trim() : ''
  return (override || fromEnv || DEFAULT_API).replace(/\/+$/, '')
}

export function isLoggedIn(): boolean {
  return !!accountState.token && !!accountState.account
}

/** 请求账号接口; 带 token 的请求遇到 401 时清除本地登录 */
async function api<T>(req: Omit<AccountRequest, 'translate'>): Promise<T | null> {
  try {
    return await accountRequest<T>(accountApiBase(), { ...req, translate: t })
  } catch (err) {
    if (req.token && isAccountUnauthorized(err)) clearLocalLogin(req.token)
    throw err
  }
}

/** 发送邮箱验证码. 失败抛出已本地化的 Error (无效邮箱 / 太频繁 / 网络 / 发信失败) */
export async function requestLoginCode(email: string): Promise<void> {
  await api({ method: 'POST', path: '/v1/auth/code', body: { email: email.trim() }, auth: true })
}

/** 用验证码登录 (首次即注册). 成功后写入 accountState 并持久化 */
export async function verifyLoginCode(email: string, code: string): Promise<AccountInfo> {
  const res = await api<{ token?: unknown; account?: unknown }>({
    method: 'POST',
    path: '/v1/auth/verify',
    body: { email: email.trim(), code: code.trim(), deviceName: deviceName() },
    auth: true,
  })
  const account = parseAccount(res?.account)
  const token = typeof res?.token === 'string' ? res.token : ''
  if (!account || !token) throw new Error(t('account.err.server', { status: 200 }))
  accountState.token = token
  accountState.account = account
  persist()
  return { ...account }
}

/**
 * 退出登录: 尽力吊销服务端 token, 清除本地登录状态.
 * 同步基线保留 (它描述的是本机书库, 各远端共用); 之后登录另一个账号时引擎会按首次同步处理, 见 sync/baseline.ts.
 */
export async function logout(): Promise<void> {
  // 正在同步时等它结束, 再清状态 (之后的同步不再带上账号)
  await waitForSync()
  const token = accountState.token
  clearLocalLogin()
  if (!token) return
  try {
    await accountRequest(accountApiBase(), {
      method: 'POST', path: '/v1/auth/logout', token, timeoutMs: 10_000, translate: t,
    })
  } catch { /* 尽力而为: 网络不通或 token 已失效都不影响本地退出 */ }
}

/** 注销账号: 删除云端账号与全部同步数据, 然后同 logout 清理本地. 本地书库不受影响 */
export async function deleteAccount(): Promise<void> {
  await waitForSync()
  const token = accountState.token
  if (!token) throw new Error(t('account.err.unauthorized'))
  await api({ method: 'DELETE', path: '/v1/me', token })
  clearLocalLogin(token)
}
