/** 本地离线神经语音 (sherpa-onnx + Kokoro v1.1-zh), 桌面版专属 */
import { isTauri } from '../storage/types'
import { useSettings } from '../stores/settings'

export const localTtsAvailable = () => isTauri()

export interface LocalTtsStatus {
  installed: boolean
  path: string
}

export interface DownloadProgress {
  downloaded: number
  total: number
  phase: 'downloading' | 'extracting' | 'done'
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(cmd, args)
}

export function localTtsStatus(): Promise<LocalTtsStatus> {
  return invoke('local_tts_status')
}

/** 下载语音包 (~310MB), 进度回调; 走设置中的网络代理 */
export async function localTtsDownload(
  onProgress: (p: DownloadProgress) => void,
): Promise<void> {
  const { listen } = await import('@tauri-apps/api/event')
  const unlisten = await listen<DownloadProgress>('local-tts-progress', e => onProgress(e.payload))
  try {
    const proxy = useSettings().httpProxy.trim()
    await invoke('local_tts_download', { proxy: proxy || null })
  } finally {
    unlisten()
  }
}

export function localTtsRemove(): Promise<void> {
  return invoke('local_tts_remove')
}

/**
 * 预加载模型 (首次约 10–20s, 在后台线程执行); 未安装语音包时 reject。
 * 中文与英文音色使用不同的文本规范化规则 (数字 / 日期读法), 按将要使用的音色预热, 免得首句再重载一次。
 */
export function localTtsWarmup(sid = useSettings().localVoiceId): Promise<void> {
  return invoke('local_tts_warmup', { sid })
}

/** Rust 侧返回 tauri::ipc::Response 原始二进制 (ArrayBuffer), 不经 JSON 数组序列化 */
export async function localTtsSynthesize(text: string, sid: number, speed: number): Promise<Blob> {
  const bytes = await invoke<ArrayBuffer>('local_tts_synthesize', { text, sid, speed })
  return new Blob([bytes], { type: 'audio/wav' })
}
