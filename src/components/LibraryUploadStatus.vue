<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { t } from '../i18n'
import { toast } from '../services/toast'
import {
  cancelLibraryUpload, dismissLibraryUpload, isActive, isFinished, libraryUploadTask, retryFailedLibraryUploads,
} from '../services/libraryUploadTask'

const expanded = ref(false)
const rows = computed(() => libraryUploadTask.rows)
const finished = computed(() => rows.value.filter(isFinished).length)
const count = (status: string) => rows.value.filter(row => row.status === status).length
const added = computed(() => count('success'))
const skipped = computed(() => count('duplicate'))
const failed = computed(() => count('failed'))
const current = computed(() => rows.value.find(isActive))
const targets = computed(() => [...new Set(rows.value.map(row => row.source.title))].join('、'))
const visible = computed(() => rows.value.length > 0 && libraryUploadTask.dialogs === 0)

const summary = computed(() => {
  const parts = [t('uploadTask.added', { n: added.value })]
  if (skipped.value) parts.push(t('uploadTask.skipped', { n: skipped.value }))
  if (failed.value) parts.push(t('uploadTask.failedN', { n: failed.value }))
  return parts.join(t('uploadTask.sep'))
})

watch(() => libraryUploadTask.running, (running, was) => {
  if (running || !was || !rows.value.length) return
  // 弹窗开着时用户看得到每一行, 不再弹提示
  if (libraryUploadTask.dialogs) return
  toast(t('uploadTask.doneToast', { summary: summary.value }), failed.value ? 'error' : 'success', 4000)
})
</script>

<template>
  <aside v-if="visible" class="up-task" :class="{ 'is-error': !libraryUploadTask.running && failed }" role="status" aria-live="polite">
    <div class="up-task-head">
      <div>
        <strong>{{ libraryUploadTask.running ? t('uploadTask.title') : t('uploadTask.doneTitle') }}</strong>
        <span>{{ targets }}</span>
      </div>
      <button v-if="!libraryUploadTask.running" class="up-task-close" :aria-label="t('common.close')" :title="t('common.close')" @click="dismissLibraryUpload">×</button>
    </div>
    <div class="up-task-bar"><div :style="{ transform: `scaleX(${finished / Math.max(rows.length, 1)})` }" /></div>
    <p>
      <span v-if="libraryUploadTask.running && current">{{ t(current.status === 'converting' ? 'uploadTask.converting' : 'uploadTask.uploading', { name: current.name }) }}</span>
      <span v-else>{{ summary }}</span>
      <small>{{ finished }} / {{ rows.length }}</small>
    </p>
    <ul v-if="expanded" class="up-task-list">
      <li v-for="row in rows" :key="row.id">
        <span>{{ row.name }}</span>
        <small :class="{ bad: row.status === 'failed', good: row.status === 'success' || row.status === 'duplicate' }">{{ row.error ? t(row.error.key, row.error.params) : t(`upload.${row.status}`) }}</small>
      </li>
    </ul>
    <div class="up-task-actions">
      <button :aria-expanded="expanded" @click="expanded = !expanded">{{ expanded ? t('uploadTask.hide') : t('uploadTask.details') }}</button>
      <button v-if="libraryUploadTask.running" class="danger" :disabled="libraryUploadTask.cancelling" @click="cancelLibraryUpload">{{ libraryUploadTask.cancelling ? t('uploadTask.cancelling') : t('uploadTask.cancel') }}</button>
      <button v-else-if="failed" @click="retryFailedLibraryUploads()">{{ t('upload.retry', { n: failed }) }}</button>
    </div>
  </aside>
</template>

<style scoped>
.up-task{position:fixed;right:18px;bottom:calc(18px + var(--lr-safe-bottom, 0px));z-index:91;width:min(360px,calc(100vw - 36px));padding:14px 16px 10px;border:1px solid var(--border);border-radius:12px;background:var(--card);box-shadow:0 10px 36px rgba(0,0,0,.18)}
.up-task.is-error{border-color:color-mix(in srgb,var(--danger) 35%,var(--border))}
.up-task-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.up-task-head>div{min-width:0}
.up-task-head strong,.up-task-head span{display:block}
.up-task-head strong{font-size:13px}
.up-task-head span{margin-top:2px;overflow:hidden;color:var(--text-3);font-size:12px;text-overflow:ellipsis;white-space:nowrap}
.up-task-close{padding:0 2px;border:0;background:none;color:var(--text-3);cursor:pointer;font-size:20px;line-height:1}
.up-task-bar{height:5px;margin:12px 0 9px;overflow:hidden;border-radius:3px;background:var(--bg)}
.up-task-bar>div{height:100%;border-radius:inherit;background:var(--brand);transform-origin:left;transition:transform .35s}
.up-task p{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:0;color:var(--text-2);font-size:12px}
.up-task p span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.up-task p small{flex:none;color:var(--text-3);font-variant-numeric:tabular-nums}
.up-task-list{max-height:200px;overflow:auto;margin:10px 0 0;padding:0;list-style:none;border-top:1px solid var(--border)}
.up-task-list li{display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid var(--border);font-size:12px}
.up-task-list span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.up-task-list small{flex:none;max-width:55%;color:var(--text-3);text-align:right;overflow-wrap:anywhere}
.up-task-list .bad{color:var(--danger)}
.up-task-list .good{color:var(--success)}
.up-task-actions{display:flex;gap:16px;margin-top:8px}
.up-task-actions button{padding:2px 0;border:0;background:none;color:var(--text-3);cursor:pointer;font-size:12px}
.up-task-actions button:hover{color:var(--brand)}
.up-task-actions button.danger:hover{color:var(--danger)}
.up-task-actions button:disabled{cursor:default;opacity:.55}
/* 手机底部有标签栏, 卡片抬到标签栏上方 */
@media (max-width:720px){.up-task{right:12px;left:12px;width:auto;bottom:calc(72px + var(--lr-safe-bottom, 0px))}}
</style>
