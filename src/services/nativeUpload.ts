/**
 * 原生上传 (仅 Tauri, 实现见 src-tauri/src/http_upload.rs).
 *
 * plugin-http 的 fetch 会把请求体转成数字数组再 JSON 序列化走 IPC, 上传整本书极慢、内存暴涨.
 * 这里改走自定义命令 `http_upload`:
 *  - 书库本地文件 (LocalFileRef): 只传路径, Rust 直接读盘, 书的内容不经过 WebView;
 *  - 其他二进制: 走 Tauri 2 的原始二进制 IPC (桌面端是 ipc:// 协议的 POST 体).
 * 请求元数据放在 IPC 请求头里, 值经 encodeURIComponent (请求头只能是 ASCII).
 * Rust 侧: 连接超时 30s, 整体超时 60s + 每 MB 10s (上限 30 分钟), 代理沿用设置页的 httpProxy.
 */
import { isLocalFileRef, type LocalFileRef } from '../storage/types.ts'

export type NativeUploadErrorCode = 'timeout' | 'file' | 'network' | 'request'

export class NativeUploadError extends Error {
  readonly code: NativeUploadErrorCode
  constructor(code: NativeUploadErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'NativeUploadError'
  }
}

export interface NativeUploadInit {
  method: string
  headers: Record<string, string>
  body: Blob | string | LocalFileRef
  /** 私人书库上传禁止跟随重定向，避免把文件发送到其它地址。 */
  redirect?: 'error'
}

export interface NativeUploadResult {
  status: number
  /** 响应正文 (截断到 2000 字符) */
  body: string
}

function toError(err: unknown): NativeUploadError {
  const msg = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err)
  const m = /^(timeout|file|network|request):\s*/.exec(msg)
  return m
    ? new NativeUploadError(m[1] as NativeUploadErrorCode, msg.slice(m[0].length))
    : new NativeUploadError('request', msg)
}

async function invokeUpload(
  url: string,
  init: NativeUploadInit,
  proxy: string,
  file: LocalFileRef | null,
  bytes: Uint8Array,
): Promise<NativeUploadResult> {
  const { invoke } = await import('@tauri-apps/api/core')
  const headers: Record<string, string> = {
    'x-lr-url': encodeURIComponent(url),
    'x-lr-method': encodeURIComponent(init.method),
    'x-lr-headers': encodeURIComponent(JSON.stringify(init.headers)),
  }
  if (proxy) headers['x-lr-proxy'] = encodeURIComponent(proxy)
  if (init.redirect === 'error') headers['x-lr-no-redirect'] = 'true'
  if (file) headers['x-lr-file'] = encodeURIComponent(JSON.stringify({ root: file.root, rel: file.rel }))
  try {
    return await invoke<NativeUploadResult>('http_upload', bytes, { headers })
  } catch (err) {
    throw toError(err)
  }
}

async function bodyBytes(body: Blob | string): Promise<Uint8Array> {
  return typeof body === 'string'
    ? new TextEncoder().encode(body)
    : new Uint8Array(await body.arrayBuffer())
}

export async function nativeUpload(url: string, init: NativeUploadInit): Promise<NativeUploadResult> {
  const { useSettings } = await import('../stores/settings')
  const proxy = useSettings().httpProxy.trim()
  const { body } = init
  if (isLocalFileRef(body)) {
    try {
      return await invokeUpload(url, init, proxy, body, new Uint8Array(0))
    } catch (err) {
      // 原生侧读不到文件 (自定义书库路径异常等): 退回读进 JS 再走原始二进制 IPC
      if (!(err instanceof NativeUploadError) || err.code !== 'file') throw err
      console.warn('[sync] native file read failed, falling back to blob', err.message)
      return invokeUpload(url, init, proxy, null, await bodyBytes(await body.blob()))
    }
  }
  return invokeUpload(url, init, proxy, null, await bodyBytes(body))
}
