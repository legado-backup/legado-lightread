/**
 * 打字声: WebAudio 现场合成 15ms 的噪声脉冲 (带通滤波 + 指数包络), 不需要音频资源文件。
 * AudioContext 在第一次 warm() (用户点「开始」的手势里) 时才创建, 避免自动播放限制和无谓的音频设备占用。
 */
export interface TypingSound {
  /** 在用户手势里调用一次, 创建 / 唤醒 AudioContext */
  warm(): void
  click(): void
  dispose(): void
}

export function createTypingSound(): TypingSound {
  let ctx: AudioContext | null = null
  let noise: AudioBuffer | null = null

  const ensure = (): AudioContext | null => {
    if (!ctx) {
      const AC = (window as any).AudioContext || (window as any).webkitAudioContext
      if (!AC) return null
      try {
        ctx = new AC() as AudioContext
      } catch {
        return null
      }
      const len = Math.max(1, Math.round(ctx.sampleRate * 0.015))
      noise = ctx.createBuffer(1, len, ctx.sampleRate)
      const data = noise.getChannelData(0)
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len)
    }
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
    return ctx
  }

  return {
    warm() { ensure() },
    click() {
      const c = ctx
      if (!c || !noise || c.state !== 'running') return
      try {
        const src = c.createBufferSource()
        src.buffer = noise
        const filter = c.createBiquadFilter()
        filter.type = 'bandpass'
        filter.frequency.value = 1700 + Math.random() * 1500
        filter.Q.value = 0.8
        const gain = c.createGain()
        const t = c.currentTime
        gain.gain.setValueAtTime(0.0001, t)
        gain.gain.exponentialRampToValueAtTime(0.22, t + 0.002)
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.015)
        src.connect(filter)
        filter.connect(gain)
        gain.connect(c.destination)
        src.start(t)
        src.stop(t + 0.02)
      } catch { /* 音频不可用时静默 */ }
    },
    dispose() {
      const c = ctx
      ctx = null
      noise = null
      void c?.close().catch(() => {})
    },
  }
}
