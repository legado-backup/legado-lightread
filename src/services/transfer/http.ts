/**
 * 互传的 HTTP 传输层 (账号与取件码通道共用). 可注入, node 测试用假服务器.
 *  - JSON 请求走全局 fetch (服务端 CORS 为 `*`, 与 account.ts 相同; 桌面 / 安卓的 WebView 同样可用)
 *  - 上传走 XMLHttpRequest: 只有它能报告上传进度; 大文件不阻塞界面
 *  - 下载走 fetch 流式读取, 按 content-length 报告进度
 */
import { TransferError, type ProgressFn, type TranslateFn } from './types.ts'

export type FetchFn = (url: string, init: {
  method: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
}) => Promise<{ status: number; text(): Promise<string> }>

export type UploadFn = (url: string, init: {
  method: 'PUT'
  headers: Record<string, string>
  body: Blob
  onProgress?: ProgressFn
  signal?: AbortSignal
}) => Promise<{ status: number; text: string }>

export type DownloadFn = (url: string, init: {
  headers: Record<string, string>
  onProgress?: ProgressFn
  signal?: AbortSignal
}) => Promise<{ status: number; blob: Blob | null; text: string }>

export interface Transport {
  fetch: FetchFn
  upload: UploadFn
  download: DownloadFn
}

const defaultFetch: FetchFn = (url, init) => fetch(url, init)

const xhrUpload: UploadFn = (url, init) => new Promise((resolve, reject) => {
  if (typeof XMLHttpRequest === 'undefined') {
    // 没有 XHR (理论上不会发生): 退回 fetch, 进度未知
    init.onProgress?.(null)
    fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: init.signal })
      .then(async res => resolve({ status: res.status, text: await res.text() }), reject)
    return
  }
  const xhr = new XMLHttpRequest()
  xhr.open(init.method, url)
  for (const [k, v] of Object.entries(init.headers)) xhr.setRequestHeader(k, v)
  xhr.upload.onprogress = e => {
    if (e.lengthComputable && e.total > 0) init.onProgress?.(e.loaded / e.total)
  }
  xhr.onload = () => resolve({ status: xhr.status, text: String(xhr.responseText ?? '') })
  xhr.onerror = () => reject(new Error('network'))
  xhr.ontimeout = () => reject(new Error('timeout'))
  xhr.onabort = () => reject(new DOMException('aborted', 'AbortError'))
  if (init.signal) {
    if (init.signal.aborted) return reject(new DOMException('aborted', 'AbortError'))
    init.signal.addEventListener('abort', () => xhr.abort(), { once: true })
  }
  xhr.send(init.body)
})

const fetchDownload: DownloadFn = async (url, init) => {
  const res = await fetch(url, { headers: init.headers, signal: init.signal })
  if (!res.ok) return { status: res.status, blob: null, text: await res.text().catch(() => '') }
  const total = Number(res.headers.get('content-length') ?? 0)
  const type = res.headers.get('content-type') ?? ''
  const reader = res.body?.getReader?.()
  if (!reader) return { status: res.status, blob: await res.blob(), text: '' }
  const chunks: BlobPart[] = []
  let received = 0
  init.onProgress?.(total ? 0 : null)
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value as BlobPart)
    received += value.byteLength
    init.onProgress?.(total ? Math.min(1, received / total) : null)
  }
  return { status: res.status, blob: new Blob(chunks, { type }), text: '' }
}

export const defaultTransport: Transport = { fetch: defaultFetch, upload: xhrUpload, download: fetchDownload }

async function loadTranslate(translate?: TranslateFn): Promise<TranslateFn> {
  if (translate) return translate
  const { t } = await import('../../i18n/index.ts')
  return t
}

const ERROR_KEYS: Record<string, string> = {
  too_large: 'transfer.err.tooLarge',
  not_found: 'transfer.err.notFound',
  gone: 'transfer.err.gone',
  forbidden: 'transfer.err.forbidden',
  invalid_code: 'transfer.err.badCode',
}

/** 「x 分钟 / x 小时」形式的等待时间 */
function waitText(seconds: number, tr: TranslateFn): string {
  if (seconds < 90) return tr('transfer.wait.seconds', { n: seconds })
  if (seconds < 90 * 60) return tr('transfer.wait.minutes', { n: Math.ceil(seconds / 60) })
  return tr('transfer.wait.hours', { n: Math.ceil(seconds / 3600) })
}

/** 状态码 + 服务端错误码 → 已本地化的 TransferError */
export async function errorFor(
  status: number,
  body: string,
  translate?: TranslateFn,
): Promise<TransferError> {
  const tr = await loadTranslate(translate)
  let code = ''
  let retryAfter: number | undefined
  try {
    const j = JSON.parse(body) as { error?: unknown; retryAfter?: unknown }
    if (typeof j.error === 'string') code = j.error
    const r = Number(j.retryAfter)
    if (Number.isFinite(r) && r > 0) retryAfter = Math.ceil(r)
  } catch { /* 非 JSON (网关错误页等) */ }
  let message: string
  if (status === 0) message = tr('transfer.err.network')
  else if (status === 401) message = tr('account.err.unauthorized')
  else if (status === 429) message = tr('transfer.err.rateLimited', { time: waitText(retryAfter ?? 60, tr) })
  else if (status === 413) message = tr('transfer.err.tooLarge')
  else if (ERROR_KEYS[code]) message = tr(ERROR_KEYS[code])
  else if (status === 404) message = tr('transfer.err.notFound')
  else if (status === 410) message = tr('transfer.err.gone')
  else if (status === 400) message = tr('transfer.err.invalid')
  else message = tr('transfer.err.server', { status })
  return new TransferError(message, status, code, retryAfter)
}

export interface JsonCall {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  token?: string
  headers?: Record<string, string>
  body?: unknown
  timeoutMs?: number
}

/** JSON 请求: 2xx 返回解析后的 JSON (204 为 null), 其它抛出 TransferError */
export async function jsonCall<T>(
  base: string,
  call: JsonCall,
  transport: Pick<Transport, 'fetch'>,
  translate?: TranslateFn,
): Promise<T | null> {
  const headers: Record<string, string> = { ...(call.headers ?? {}) }
  if (call.token) headers.authorization = `Bearer ${call.token}`
  let body: string | undefined
  if (call.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(call.body)
  }
  const signal = typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
    ? AbortSignal.timeout(call.timeoutMs ?? 30_000)
    : undefined
  let status: number
  let text: string
  try {
    const res = await transport.fetch(base.replace(/\/+$/, '') + call.path, { method: call.method, headers, body, signal })
    status = res.status
    text = await res.text()
  } catch (err) {
    console.warn('[transfer] request failed', call.method, call.path, err)
    throw await errorFor(0, '', translate)
  }
  if (status >= 200 && status < 300) {
    if (!text) return null
    try { return JSON.parse(text) as T } catch { return null }
  }
  throw await errorFor(status, text, translate)
}

/** 上传文件本体; 非 2xx 抛出 TransferError */
export async function uploadBlob(
  url: string,
  blob: Blob,
  headers: Record<string, string>,
  transport: Pick<Transport, 'upload'>,
  opts: { onProgress?: ProgressFn; signal?: AbortSignal },
  translate?: TranslateFn,
): Promise<void> {
  let res: { status: number; text: string }
  try {
    res = await transport.upload(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream', ...headers },
      body: blob,
      onProgress: opts.onProgress,
      signal: opts.signal,
    })
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') throw err
    throw await errorFor(0, '', translate)
  }
  if (res.status < 200 || res.status >= 300) throw await errorFor(res.status, res.text, translate)
  opts.onProgress?.(1)
}

/** 下载文件本体; 非 2xx 抛出 TransferError */
export async function downloadBlob(
  url: string,
  headers: Record<string, string>,
  transport: Pick<Transport, 'download'>,
  opts: { onProgress?: ProgressFn; signal?: AbortSignal },
  translate?: TranslateFn,
): Promise<Blob> {
  let res: { status: number; blob: Blob | null; text: string }
  try {
    res = await transport.download(url, { headers, onProgress: opts.onProgress, signal: opts.signal })
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') throw err
    throw await errorFor(0, '', translate)
  }
  if (res.status < 200 || res.status >= 300 || !res.blob) throw await errorFor(res.status, res.text, translate)
  return res.blob
}
