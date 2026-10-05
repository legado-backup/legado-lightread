<script setup lang="ts">
/**
 * 点睛阅读开关与选项, 放在「阅读模式」面板顶部 (docs/dianjing-reading.md §4.1)。
 * 关: 一行开关 + 副标题; 开: 展开密度、类型、体裁、速读 / 脉络入口与本章状态。
 */
import { computed } from 'vue'
import { t } from '../i18n'
import { useSettings } from '../stores/settings'
import type { Dianjing } from '../composables/useDianjing'

const props = defineProps<{ dj: Dianjing }>()
const emit = defineEmits<{ 'open-settings': []; 'open-outline': []; 'open-skim': [] }>()

const settings = useSettings()
const on = computed(() => props.dj.enabled.value)
const status = computed(() => props.dj.status.value)
const pct = computed(() => Math.round(props.dj.progress.value * 100))

const densities = [
  { value: 'low', key: 'dianjing.densityLow' },
  { value: 'normal', key: 'dianjing.densityNormal' },
  { value: 'high', key: 'dianjing.densityHigh' },
] as const

const kinds = [
  { value: 'key', key: 'dianjing.kindKey' },
  { value: 'term', key: 'dianjing.kindTerm' },
  { value: 'note', key: 'dianjing.kindNote' },
] as const

const statusText = computed(() => {
  const code = props.dj.errorCode.value
  switch (status.value) {
    case 'loading': return t('dianjing.statusLoading', { pct: pct.value })
    case 'ready': return t('dianjing.statusReady', { pct: pct.value })
    case 'quota': return t(code === 'budget' ? 'dianjing.statusBudget' : 'dianjing.statusQuota')
    case 'offline': return t('dianjing.statusOffline')
    case 'unsupported': return t('dianjing.unsupported')
    case 'error':
      if (code === 'config') return t('dianjing.statusConfig')
      if (code === 'auth') return t('dianjing.statusAuth')
      return t('dianjing.statusError')
    default: return ''
  }
})
const needsSettings = computed(() => status.value === 'quota' || (status.value === 'error' && ['config', 'auth'].includes(props.dj.errorCode.value ?? '')))

const genre = computed({
  get: () => settings.dianjing.fiction[props.dj.engine.host.bookId] ?? '',
  set: (v: string) => props.dj.setFiction(v === 'fiction' || v === 'nonfiction' ? v : null),
})
const autoGenreLabel = computed(() =>
  t('dianjing.genreAutoIs', { kind: t(props.dj.fiction.value ? 'dianjing.genreFiction' : 'dianjing.genreNonfiction') }),
)

function openSkim() {
  props.dj.openSkim()
  emit('open-skim')
}
function openOutline() {
  props.dj.openOutline()
  emit('open-outline')
}
</script>

<template>
  <section class="dj-toggle" :class="{ on }">
    <label class="dj-head">
      <span class="dj-head-text">
        <span class="dj-title">{{ t('dianjing.title') }}</span>
        <span class="dj-sub">{{ t('dianjing.subtitle') }}</span>
      </span>
      <span class="dj-switch">
        <input
          type="checkbox"
          role="switch"
          :checked="on"
          :aria-checked="on"
          :disabled="status === 'unsupported'"
          @click.prevent="dj.toggle()"
        />
        <span class="dj-switch-track" aria-hidden="true"></span>
      </span>
    </label>

    <p v-if="status === 'unsupported'" class="dj-status">{{ t('dianjing.unsupported') }}</p>

    <div v-if="on && status !== 'unsupported'" class="dj-body">
      <div class="dj-row">
        <span class="dj-label">{{ t('dianjing.density') }}</span>
        <div class="segmented" role="group" :aria-label="t('dianjing.density')">
          <button
            v-for="d in densities"
            :key="d.value"
            type="button"
            :class="{ active: settings.dianjing.density === d.value }"
            :aria-pressed="settings.dianjing.density === d.value"
            @click="settings.dianjing.density = d.value"
          >{{ t(d.key) }}</button>
        </div>
      </div>

      <div class="dj-row">
        <span class="dj-label">{{ t('dianjing.kinds') }}</span>
        <div class="dj-kinds">
          <label v-for="k in kinds" :key="k.value" class="dj-kind" :class="'dj-kind-' + k.value">
            <input v-model="settings.dianjing.kinds[k.value]" type="checkbox" />
            <span class="dj-kind-sample" aria-hidden="true"></span>
            <span>{{ t(k.key) }}</span>
          </label>
        </div>
      </div>

      <div class="dj-row">
        <span class="dj-label">{{ t('dianjing.genre') }}</span>
        <select v-model="genre" class="input dj-select" :aria-label="t('dianjing.genre')">
          <option value="">{{ autoGenreLabel }}</option>
          <option value="fiction">{{ t('dianjing.genreFiction') }}</option>
          <option value="nonfiction">{{ t('dianjing.genreNonfiction') }}</option>
        </select>
      </div>
      <p v-if="dj.fiction.value" class="dj-hint">{{ t('dianjing.fictionHint') }}</p>

      <div class="dj-actions">
        <button type="button" class="btn btn-sm" @click="openSkim">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M4 6h16M4 12h10M4 18h7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>
          {{ t('dianjing.skim') }}
        </button>
        <button type="button" class="btn btn-sm" @click="openOutline">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M5 5h4v4H5zM11 7h8M8 9v6h3M11 15h8M8 15v4h3M11 19h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
          {{ t('dianjing.outline') }}
        </button>
      </div>

      <p v-if="statusText" class="dj-status" :class="'is-' + status" role="status">
        <span class="dj-dot" aria-hidden="true"></span>
        <span>{{ statusText }}</span>
        <button v-if="needsSettings" type="button" class="btn btn-ghost btn-sm" @click="emit('open-settings')">{{ t('dianjing.openSettings') }}</button>
      </p>
      <p v-if="dj.remaining.value != null && status !== 'quota'" class="dj-hint">{{ t('dianjing.remaining', { n: dj.remaining.value }) }}</p>

      <div class="dj-actions dj-minor">
        <button type="button" class="btn btn-ghost btn-sm" @click="dj.redoSection()">{{ t('dianjing.redo') }}</button>
        <button type="button" class="btn btn-ghost btn-sm" @click="dj.clearBookCache()">{{ t('dianjing.clearCache') }}</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.dj-toggle {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--border);
}
.dj-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  cursor: pointer;
}
.dj-head-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.dj-title {
  font-weight: 600;
  color: var(--text);
}
.dj-sub {
  font-size: 12px;
  color: var(--text-3);
}
.dj-switch {
  position: relative;
  width: 38px;
  height: 22px;
  flex-shrink: 0;
}
.dj-switch input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
  z-index: 1;
}
.dj-switch-track {
  position: absolute;
  inset: 0;
  border-radius: var(--radius-pill);
  background: var(--border-strong);
  transition: background var(--dur) var(--ease);
}
.dj-switch-track::after {
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
.dj-switch input:checked + .dj-switch-track {
  background: var(--brand);
}
.dj-switch input:checked + .dj-switch-track::after {
  transform: translateX(16px);
}
.dj-switch input:focus-visible + .dj-switch-track {
  box-shadow: var(--ring);
}
.dj-switch input:disabled {
  cursor: not-allowed;
}
.dj-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.dj-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  flex-wrap: wrap;
}
.dj-label {
  font-size: 13px;
  color: var(--text-2);
}
.dj-kinds {
  display: flex;
  gap: var(--space-3);
  flex-wrap: wrap;
}
.dj-kind {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text);
  cursor: pointer;
  min-height: 32px;
}
/* 图例: 线型区分类型 (不只靠颜色) */
.dj-kind-sample {
  display: inline-block;
  width: 16px;
  height: 0;
  border-bottom: 2px solid var(--text-2);
}
.dj-kind-term .dj-kind-sample {
  border-bottom: 1px dotted var(--text-2);
}
.dj-kind-note .dj-kind-sample {
  width: 6px;
  height: 6px;
  border: none;
  border-radius: 50%;
  background: var(--text-2);
}
.dj-select {
  width: auto;
  min-width: 140px;
  height: 32px;
  padding-block: 0;
}
.dj-actions {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.dj-minor {
  margin-top: calc(-1 * var(--space-1));
}
.dj-status {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: 12px;
  color: var(--text-2);
  margin: 0;
  flex-wrap: wrap;
}
.dj-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-3);
  flex-shrink: 0;
}
.dj-status.is-ready .dj-dot {
  background: var(--success);
}
.dj-status.is-quota .dj-dot,
.dj-status.is-error .dj-dot {
  background: var(--warning);
}
.dj-hint {
  font-size: 12px;
  color: var(--text-3);
  margin: 0;
}
</style>
