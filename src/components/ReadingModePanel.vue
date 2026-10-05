<script setup lang="ts">
/**
 * 「阅读模式」面板: 桌面为顶栏下的浮层卡片, 手机为底部抽屉 (遮罩由 ReaderView 的 sheet-scrim 提供)。
 * 第一栏「自动翻页」沿用 ReaderView 现有的自动阅读实现 (props/emits), 容器保留 .auto-panel 类名供 e2e 使用;
 * 第二栏「打字机」直接读写 settings.readingMode.typewriter, 控制由 useReadingModes 实例 (modes) 负责。
 */
import { computed } from 'vue'
import { t } from '../i18n'
import { useSettings } from '../stores/settings'
import type { ReadingModes, ReadingModeTab } from '../composables/useReadingModes'

const props = defineProps<{
  modes: ReadingModes
  /** 自动翻页是否在运行 (ReaderView 的 autoReading) */
  autoReading: boolean
  /** 自动翻页速度, 秒/页 (v-model:auto-read-seconds) */
  autoReadSeconds: number
}>()

const emit = defineEmits<{
  'start-auto': []
  'stop-auto': []
  'update:autoReadSeconds': [value: number]
  close: []
}>()

const settings = useSettings()
const tw = computed(() => settings.readingMode.typewriter)

const tab = computed<ReadingModeTab>({
  get: () => props.modes.panelTab.value,
  set: v => { props.modes.panelTab.value = v },
})
const state = computed(() => props.modes.typewriterState.value)
const active = computed(() => state.value !== 'idle')
const supported = computed(() => props.modes.supported.value)

const units = [
  { value: 'char', key: 'readingMode.unitChar' },
  { value: 'sentence', key: 'readingMode.unitSentence' },
  { value: 'line', key: 'readingMode.unitLine' },
] as const

const presetLabels = ['readingMode.presetSlow', 'readingMode.presetMedium', 'readingMode.presetFast']

function close() {
  props.modes.closePanel()
  emit('close')
}

function onAutoSeconds(e: Event) {
  const n = Number((e.target as HTMLInputElement).value)
  if (Number.isFinite(n)) emit('update:autoReadSeconds', Math.min(60, Math.max(3, Math.round(n))))
}

function toggleAuto() {
  if (props.autoReading) {
    emit('stop-auto')
    return
  }
  props.modes.stopTypewriterFor('auto')
  emit('start-auto')
}

function onSpeedInput(e: Event) {
  const n = Number((e.target as HTMLInputElement).value)
  if (Number.isFinite(n)) props.modes.speed.value = n
}
</script>

<template>
  <section class="rm-panel card" role="dialog" :aria-label="t('readingMode.title')">
    <header class="rm-head">
      <strong>{{ t('readingMode.title') }}</strong>
      <button class="rm-close" type="button" :title="t('common.close')" :aria-label="t('common.close')" @click="close">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M6.3 6.3a1 1 0 0 1 1.4 0L12 10.58l4.3-4.3a1 1 0 1 1 1.4 1.42L13.42 12l4.3 4.3a1 1 0 0 1-1.42 1.4L12 13.42l-4.3 4.3a1 1 0 0 1-1.4-1.42L10.58 12l-4.3-4.3a1 1 0 0 1 0-1.4z"/></svg>
      </button>
    </header>

    <div class="segmented rm-tabs">
      <button type="button" :class="{ active: tab === 'auto' }" :aria-pressed="tab === 'auto'" @click="tab = 'auto'">
        {{ t('readingMode.tabAuto') }}
      </button>
      <button type="button" :class="{ active: tab === 'typewriter' }" :aria-pressed="tab === 'typewriter'" @click="tab = 'typewriter'">
        {{ t('readingMode.tabTypewriter') }}
      </button>
    </div>

    <!-- 自动翻页 (原自动阅读): 行为不变, 秒/页 3–60 -->
    <div v-if="tab === 'auto'" class="auto-panel rm-body">
      <p class="rm-hint">{{ t('readingMode.autoHint') }}</p>
      <div class="rm-row">
        <span class="rm-label">{{ t('reader.speed') }}</span>
        <input
          class="rm-range"
          type="range"
          min="3"
          max="60"
          step="1"
          :value="autoReadSeconds"
          :aria-label="t('reader.speed')"
          :aria-valuetext="t('reader.secPerPage', { n: autoReadSeconds })"
          @input="onAutoSeconds"
        />
        <span class="rm-value">{{ t('reader.secPerPage', { n: autoReadSeconds }) }}</span>
      </div>
      <button type="button" class="btn btn-primary rm-main" @click="toggleAuto">
        <svg v-if="autoReading" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 5a1 1 0 0 1 1 1v12a1 1 0 1 1-2 0V6a1 1 0 0 1 1-1zm8 0a1 1 0 0 1 1 1v12a1 1 0 1 1-2 0V6a1 1 0 0 1 1-1z"/></svg>
        <svg v-else viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 5.14v13.72a1 1 0 0 0 1.52.85l11-6.86a1 1 0 0 0 0-1.7l-11-6.86A1 1 0 0 0 8 5.14z"/></svg>
        {{ autoReading ? t('common.pause') : t('common.start') }}
      </button>
    </div>

    <!-- 打字机 -->
    <div v-else class="tw-panel rm-body">
      <p v-if="!supported" class="rm-note" role="note">{{ t('readingMode.fixedLayoutUnsupported') }}</p>
      <fieldset class="rm-fields" :disabled="!supported">
        <div class="rm-row">
          <span class="rm-label">{{ t('readingMode.granularity') }}</span>
          <div class="segmented">
            <button
              v-for="u in units"
              :key="u.value"
              type="button"
              :class="{ active: tw.unit === u.value }"
              :aria-pressed="tw.unit === u.value"
              @click="settings.readingMode.typewriter.unit = u.value"
            >
              {{ t(u.key) }}
            </button>
          </div>
        </div>

        <div class="rm-row">
          <span class="rm-label">{{ t('readingMode.speed') }}</span>
          <button type="button" class="rm-step" :title="t('readingMode.slower')" :aria-label="t('readingMode.slower')" @click="modes.adjustSpeed(-1)">
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M5 12a1 1 0 0 1 1-1h12a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1z"/></svg>
          </button>
          <input
            class="rm-range"
            type="range"
            :min="modes.speedLimits.value[0]"
            :max="modes.speedLimits.value[1]"
            step="10"
            :value="modes.speed.value"
            :aria-label="t('readingMode.speed')"
            :aria-valuetext="modes.speedText.value"
            @input="onSpeedInput"
          />
          <button type="button" class="rm-step" :title="t('readingMode.faster')" :aria-label="t('readingMode.faster')" @click="modes.adjustSpeed(1)">
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 5a1 1 0 0 1 1 1v5h5a1 1 0 1 1 0 2h-5v5a1 1 0 1 1-2 0v-5H6a1 1 0 1 1 0-2h5V6a1 1 0 0 1 1-1z"/></svg>
          </button>
          <span class="rm-value">{{ modes.speedText.value }}</span>
        </div>
        <div class="rm-presets">
          <button
            v-for="(n, i) in modes.presets.value"
            :key="n"
            type="button"
            class="rm-chip"
            :class="{ on: modes.speed.value === n }"
            :aria-pressed="modes.speed.value === n"
            @click="modes.speed.value = n"
          >
            {{ t(presetLabels[i]) }} {{ n }}
          </button>
        </div>

        <div class="rm-row">
          <span class="rm-label">{{ t('readingMode.upcoming') }}</span>
          <div class="segmented">
            <button
              type="button"
              :class="{ active: tw.upcoming === 'hidden' }"
              :aria-pressed="tw.upcoming === 'hidden'"
              @click="settings.readingMode.typewriter.upcoming = 'hidden'"
            >
              {{ t('readingMode.upcomingHidden') }}
            </button>
            <button
              type="button"
              :class="{ active: tw.upcoming === 'ghost' }"
              :aria-pressed="tw.upcoming === 'ghost'"
              @click="settings.readingMode.typewriter.upcoming = 'ghost'"
            >
              {{ t('readingMode.upcomingGhost') }}
            </button>
          </div>
        </div>

        <div class="rm-toggles">
          <label class="rm-toggle">
            <span>{{ t('readingMode.punctuationPause') }}</span>
            <span class="rm-switch">
              <input v-model="settings.readingMode.typewriter.punctuationPause" type="checkbox" role="switch" :aria-checked="tw.punctuationPause" />
              <span class="rm-switch-track" aria-hidden="true"></span>
            </span>
          </label>
          <label class="rm-toggle">
            <span>{{ t('readingMode.freshInk') }}</span>
            <span class="rm-switch">
              <input v-model="settings.readingMode.typewriter.freshInk" type="checkbox" role="switch" :aria-checked="tw.freshInk" />
              <span class="rm-switch-track" aria-hidden="true"></span>
            </span>
          </label>
          <label class="rm-toggle">
            <span>{{ t('readingMode.sound') }}</span>
            <span class="rm-switch">
              <input v-model="settings.readingMode.typewriter.sound" type="checkbox" role="switch" :aria-checked="tw.sound" />
              <span class="rm-switch-track" aria-hidden="true"></span>
            </span>
          </label>
        </div>

        <p class="rm-hint">{{ t('readingMode.typewriterHint') }}</p>
        <p v-if="modes.reducedMotion.value" class="rm-hint">{{ t('readingMode.reducedMotionHint') }}</p>
      </fieldset>

      <div class="rm-actions">
        <template v-if="!active">
          <button type="button" class="btn btn-primary rm-main" :disabled="!supported" @click="modes.start()">
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 5.14v13.72a1 1 0 0 0 1.52.85l11-6.86a1 1 0 0 0 0-1.7l-11-6.86A1 1 0 0 0 8 5.14z"/></svg>
            {{ t('readingMode.startFromPage') }}
          </button>
        </template>
        <template v-else>
          <button type="button" class="btn btn-primary rm-main" @click="modes.togglePause()">
            <svg v-if="state === 'paused'" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 5.14v13.72a1 1 0 0 0 1.52.85l11-6.86a1 1 0 0 0 0-1.7l-11-6.86A1 1 0 0 0 8 5.14z"/></svg>
            <svg v-else viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 5a1 1 0 0 1 1 1v12a1 1 0 1 1-2 0V6a1 1 0 0 1 1-1zm8 0a1 1 0 0 1 1 1v12a1 1 0 1 1-2 0V6a1 1 0 0 1 1-1z"/></svg>
            {{ state === 'paused' ? t('common.resume') : t('common.pause') }}
          </button>
          <button type="button" class="btn rm-main" @click="modes.stop()">
            {{ t('readingMode.exitTypewriter') }}
          </button>
        </template>
      </div>
      <p class="rm-keys">{{ t('readingMode.keysHint') }}</p>
    </div>
  </section>
</template>

<style scoped>
.rm-panel {
  position: absolute;
  top: calc(52px + var(--safe-top, 0px));
  right: 12px;
  z-index: 25;
  width: min(400px, calc(100% - 24px));
  max-height: calc(100% - 72px - var(--safe-top, 0px) - var(--safe-bottom, 0px));
  overflow-y: auto;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  color: var(--text);
}
.rm-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.rm-head strong {
  font-size: 15px;
}
.rm-close {
  width: 32px;
  height: 32px;
  border: none;
  border-radius: var(--radius);
  background: transparent;
  color: var(--text-2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.rm-close:hover {
  background: var(--surface-2);
  color: var(--text);
}
.rm-close:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.rm-tabs {
  align-self: flex-start;
}
.rm-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.rm-fields {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 0;
  padding: 0;
  border: none;
  min-width: 0;
}
.rm-fields:disabled {
  opacity: 0.5;
}
.rm-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.rm-label {
  flex-shrink: 0;
  width: 64px;
  font-size: 13px;
  color: var(--text-2);
}
.rm-range {
  flex: 1;
  min-width: 0;
  accent-color: var(--brand);
}
.rm-value {
  flex-shrink: 0;
  min-width: 72px;
  font-size: 12px;
  color: var(--text-3);
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.rm-step {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--card);
  color: var(--text-2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.rm-step:hover {
  color: var(--brand);
  border-color: var(--brand);
}
.rm-step:focus-visible,
.rm-chip:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.rm-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding-left: 74px;
}
.rm-chip {
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-2);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.rm-chip:hover {
  color: var(--text);
}
.rm-chip.on {
  border-color: var(--brand);
  background: var(--brand-light);
  color: var(--brand);
}
.rm-toggles {
  display: flex;
  flex-direction: column;
}
.rm-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 40px;
  font-size: 13px;
  color: var(--text);
  cursor: pointer;
}
.rm-toggle + .rm-toggle {
  border-top: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
}
.rm-switch {
  position: relative;
  width: 38px;
  height: 22px;
  flex-shrink: 0;
}
.rm-switch input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
  z-index: 1;
}
.rm-switch-track {
  position: absolute;
  inset: 0;
  border-radius: var(--radius-pill);
  background: var(--border-strong);
  transition: background var(--dur) var(--ease);
}
.rm-switch-track::after {
  content: '';
  position: absolute;
  top: 3px;
  left: 3px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--on-brand);
  box-shadow: var(--shadow-sm);
  transition: transform var(--dur) var(--ease);
}
.rm-switch input:checked + .rm-switch-track {
  background: var(--brand);
}
.rm-switch input:checked + .rm-switch-track::after {
  transform: translateX(16px);
}
.rm-switch input:focus-visible + .rm-switch-track {
  box-shadow: var(--ring);
}
.rm-hint,
.rm-keys,
.rm-note {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-3);
}
.rm-note {
  padding: 8px 10px;
  border-radius: var(--radius);
  background: var(--surface-2);
  color: var(--text-2);
}
.rm-actions {
  display: flex;
  gap: 8px;
}
.rm-main {
  flex: 1;
  justify-content: center;
}
.auto-panel .rm-main {
  flex: none;
  align-self: stretch;
}
@media (hover: none) {
  .rm-keys {
    display: none;
  }
}
@media (max-width: 600px) {
  .rm-panel {
    top: auto;
    left: 0;
    right: 0;
    bottom: 0;
    width: auto;
    max-height: 78%;
    border-radius: var(--radius-xl) var(--radius-xl) 0 0;
    border-bottom: none;
    padding: 18px max(16px, var(--lr-safe-right, 0px)) calc(16px + var(--safe-bottom, 0px)) max(16px, var(--lr-safe-left, 0px));
    box-shadow: var(--shadow-lg);
    gap: 14px;
    animation: rm-sheet-up var(--dur-slow) var(--ease);
  }
  .rm-panel::before {
    content: '';
    position: absolute;
    top: 7px;
    left: 50%;
    width: 36px;
    height: 4px;
    margin-left: -18px;
    border-radius: 2px;
    background: var(--border-strong);
  }
  .rm-label {
    width: 52px;
  }
  .rm-presets {
    padding-left: 62px;
  }
  .rm-value {
    min-width: 64px;
  }
  .rm-step,
  .rm-close {
    width: 44px;
    height: 44px;
  }
  .rm-chip {
    height: 32px;
  }
  .rm-main {
    min-height: 44px;
  }
}
@keyframes rm-sheet-up {
  from {
    transform: translateY(40px);
    opacity: 0;
  }
  to {
    transform: none;
    opacity: 1;
  }
}
@media (prefers-reduced-motion: reduce) {
  .rm-panel,
  .rm-switch-track,
  .rm-switch-track::after {
    animation: none;
    transition: none;
  }
}
</style>
