<script setup lang="ts">
/**
 * 打字机运行时的迷你控制条: [暂停/继续] 300 字/分 [−][+] [退出]。
 * 悬浮在底部居中 (工具栏出现时让到底栏上方); 运行 3 秒后淡出, 暂停 / 即将翻页时常驻。
 * 状态文字在 aria-live 区域里播报。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { t } from '../i18n'
import type { ReadingModes } from '../composables/useReadingModes'
import type { ReadingModeProgress } from '../services/readingModes/progress'

const props = defineProps<{
  modes: ReadingModes
  /** 阅读器工具栏是否显示 (ReaderView 的 barsVisible) */
  barsVisible?: boolean
  /** 读到哪 / 还要多久 (阅读器计算) */
  progress?: ReadingModeProgress | null
}>()

const state = computed(() => props.modes.typewriterState.value)
const visible = computed(() => state.value !== 'idle')
const paused = computed(() => state.value === 'paused')

const statusText = computed(() => {
  if (state.value === 'paused') return t('readingMode.statusPaused')
  if (state.value === 'turning') return t('readingMode.statusTurning')
  return t('readingMode.statusRunning')
})

const faded = ref(false)
let fadeTimer: ReturnType<typeof setTimeout> | undefined

function wake() {
  faded.value = false
  clearTimeout(fadeTimer)
  if (state.value === 'running') fadeTimer = setTimeout(() => { faded.value = true }, 3000)
}

watch([state, () => props.barsVisible], wake, { immediate: true })
onBeforeUnmount(() => clearTimeout(fadeTimer))
</script>

<template>
  <div
    v-if="visible"
    class="rm-mini card"
    :class="{ faded: faded && !barsVisible, lifted: barsVisible }"
    role="group"
    :aria-label="t('readingMode.tabTypewriter')"
    @pointerenter="wake"
    @focusin="wake"
  >
    <button
      type="button"
      class="rm-mini-btn primary"
      :title="paused ? t('common.resume') : t('common.pause')"
      :aria-label="paused ? t('common.resume') : t('common.pause')"
      @click="modes.togglePause(); wake()"
    >
      <svg v-if="paused" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M8 5.14v13.72a1 1 0 0 0 1.52.85l11-6.86a1 1 0 0 0 0-1.7l-11-6.86A1 1 0 0 0 8 5.14z"/></svg>
      <svg v-else viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M8 5a1 1 0 0 1 1 1v12a1 1 0 1 1-2 0V6a1 1 0 0 1 1-1zm8 0a1 1 0 0 1 1 1v12a1 1 0 1 1-2 0V6a1 1 0 0 1 1-1z"/></svg>
    </button>
    <span class="rm-mini-status" aria-live="polite">
      <span class="rm-mini-state">{{ statusText }}</span>
      <span class="rm-mini-speed">
        {{ modes.speedText.value }}<template v-if="progress"> · {{ progress.chapterLeftShort ? t('readingMode.miniLeft', { time: progress.chapterLeftShort }) : progress.percent }}</template>
      </span>
    </span>
    <button
      type="button"
      class="rm-mini-btn"
      :title="t('readingMode.slower')"
      :aria-label="t('readingMode.slower')"
      @click="modes.adjustSpeed(-1); wake()"
    >
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M5 12a1 1 0 0 1 1-1h12a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1z"/></svg>
    </button>
    <button
      type="button"
      class="rm-mini-btn"
      :title="t('readingMode.faster')"
      :aria-label="t('readingMode.faster')"
      @click="modes.adjustSpeed(1); wake()"
    >
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 5a1 1 0 0 1 1 1v5h5a1 1 0 1 1 0 2h-5v5a1 1 0 1 1-2 0v-5H6a1 1 0 1 1 0-2h5V6a1 1 0 0 1 1-1z"/></svg>
    </button>
    <button
      type="button"
      class="rm-mini-btn"
      :title="t('readingMode.exitTypewriter')"
      :aria-label="t('readingMode.exitTypewriter')"
      @click="modes.stop()"
    >
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M6.3 6.3a1 1 0 0 1 1.4 0L12 10.58l4.3-4.3a1 1 0 1 1 1.4 1.42L13.42 12l4.3 4.3a1 1 0 0 1-1.42 1.4L12 13.42l-4.3 4.3a1 1 0 0 1-1.4-1.42L10.58 12l-4.3-4.3a1 1 0 0 1 0-1.4z"/></svg>
    </button>
  </div>
</template>

<style scoped>
.rm-mini {
  position: absolute;
  left: 50%;
  bottom: calc(16px + var(--safe-bottom, 0px));
  transform: translateX(-50%);
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px;
  border-radius: var(--radius-pill);
  box-shadow: var(--shadow-md);
  white-space: nowrap;
  transition:
    opacity var(--dur-slow) var(--ease),
    visibility var(--dur-slow) var(--ease),
    bottom var(--dur) var(--ease);
}
.rm-mini.lifted {
  bottom: calc(var(--footer-h, 64px) + 12px + var(--safe-bottom, 0px));
}
.rm-mini.faded {
  opacity: 0;
  visibility: hidden;
}
.rm-mini-btn {
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--text-2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.rm-mini-btn:hover {
  background: var(--brand-light);
  color: var(--brand);
}
.rm-mini-btn:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.rm-mini-btn.primary {
  background: var(--brand);
  color: var(--on-brand);
}
.rm-mini-btn.primary:hover {
  background: var(--brand-hover);
  color: var(--on-brand);
}
.rm-mini-status {
  display: inline-flex;
  flex-direction: column;
  align-items: flex-start;
  padding: 0 6px;
  line-height: 1.25;
  min-width: 64px;
}
.rm-mini-state {
  font-size: 11px;
  color: var(--text-3);
}
.rm-mini-speed {
  font-size: 13px;
  color: var(--text);
  font-variant-numeric: tabular-nums;
}
@media (pointer: coarse), (max-width: 600px) {
  .rm-mini-btn {
    width: 44px;
    height: 44px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .rm-mini {
    transition: none;
  }
}
</style>
