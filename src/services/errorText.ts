/**
 * 给用户看的错误文案.
 * 我们自己抛出的错误已经本地化, 可以直接展示; 底层网络库 / 原生层 / 运行时的原始报错
 * (含完整请求地址、`error sending request for url (…)`、`TypeError: Failed to fetch` 等)
 * 既看不懂又会泄露服务器地址, 一律换成调用方给的兜底文案, 原文只进控制台.
 */

/** 原始技术报错的特征 */
const RAW_ERROR = new RegExp([
  String.raw`[a-z][\w+.-]*:\/\/`, // 任何 URL (http / https / webdav / file …)
  String.raw`\b[A-Z]\w*Error\b`, // TypeError / AbortError / QuotaExceededError …
  String.raw`error sending request`,
  String.raw`failed to fetch`,
  String.raw`load failed`,
  String.raw`network ?error`,
  String.raw`os error`,
  String.raw`dns error`,
  String.raw`tcp connect`,
  String.raw`connection (refused|reset|closed|aborted)`,
  String.raw`certificate`,
  String.raw`\bhyper\b|\breqwest\b`,
  String.raw`\bat [\w.$<>]+ \(`, // 堆栈
  String.raw`\[object `,
].join('|'), 'i')

/** 超过这个长度的报错基本是原始响应体 / 堆栈 */
const MAX_LENGTH = 160

/** 是否像未经处理的技术报错 (不该直接展示给用户) */
export function isRawError(message: string): boolean {
  return RAW_ERROR.test(message) || message.length > MAX_LENGTH
}

function messageOf(err: unknown): string {
  if (typeof err === 'string') return err
  if (err && typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message ?? '')
  return ''
}

/**
 * 取错误里可以展示的文案; 没有或像原始报错时返回 fallback (原文记到控制台便于排查).
 * fallback 传 '' 可判断「有没有值得展示的细节」.
 */
export function errorText(err: unknown, fallback: string): string {
  const message = messageOf(err).trim()
  if (message && !isRawError(message)) return message
  if (message) console.warn('[error]', err)
  return fallback
}

/** 弹窗兜底: 去掉消息里漏网的地址, 不让任何提示把服务器 URL 露出来 */
export function redactUrls(message: string): string {
  if (!/[a-z][\w+.-]*:\/\//i.test(message)) return message
  return message
    .replace(/\s*(?:for url\s*)?\(?\s*[a-z][\w+.-]*:\/\/[^\s)）]*\s*\)?/gi, '')
    .replace(/[（(]\s*[)）]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}
