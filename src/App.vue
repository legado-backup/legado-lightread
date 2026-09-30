<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ToastHost from './components/ToastHost.vue'
import BabeldocTaskStatus from './components/BabeldocTaskStatus.vue'
import { useSettings } from './stores/settings'
import { useAppearance } from './services/appearance'
import { t } from './i18n'
import { isTauri } from './storage'
import { startExternalOpen } from './services/externalOpen'
import { toast } from './services/toast'
import { requestAutoSync, startAutoSync } from './services/sync'
import {
  canInAppInstall,
  checkUpdate,
  downloadInstaller,
  openDownload,
  openInstaller,
  pickDownloads,
  type UpdateInfo,
} from './services/updater'

useSettings().persistOnChange()
useAppearance()
const route = useRoute()
const router = useRouter()
let stopExternalOpen: (() => void) | undefined
let stopSync: (() => void) | undefined

const updateInfo = ref<UpdateInfo | null>(null)
const updateBusy = ref(false)
const updateProgress = ref<number | null>(null)
const downloadedInstaller = ref('')
const sidebarDownload = computed(() => {
  const downloads = updateInfo.value ? pickDownloads(updateInfo.value.assets) : []
  return downloads.find(item => item.recommended) ?? downloads[0] ?? null
})
const showSidebarUpdate = computed(() => Boolean(updateInfo.value?.hasUpdate))
const sidebarUpdateLabel = computed(() => {
  if (updateBusy.value) {
    return updateProgress.value == null
      ? t('update.downloadingShort')
      : `${Math.round(updateProgress.value * 100)}%`
  }
  return downloadedInstaller.value ? t('update.openShort') : t('update.action')
})
const sidebarUpdateTitle = computed(() => t('update.sidebarTitle', {
  version: updateInfo.value?.version ?? '',
}))

async function refreshSidebarUpdate() {
  try {
    updateInfo.value = await checkUpdate(false)
  } catch {
    // 启动时静默检查：网络不可用不打扰阅读。
  }
}

async function handleSidebarUpdate() {
  if (updateBusy.value || !updateInfo.value) return

  if (downloadedInstaller.value) {
    try {
      await openInstaller(downloadedInstaller.value)
    } catch (e: any) {
      toast(t('update.openFailed', { msg: e?.message ?? e }), 'error', 6000)
    }
    return
  }

  const download = sidebarDownload.value
  if (!download || !canInAppInstall()) {
    try {
      await openDownload(download?.url ?? updateInfo.value.pageUrl)
      toast(t('update.browserDownloadStarted'), 'success')
    } catch {
      toast(t('update.cannotOpenLink'), 'error')
    }
    return
  }

  updateBusy.value = true
  updateProgress.value = null
  try {
    const encodedName = download.url.split('?')[0].split('/').pop() ?? 'LightRead-installer'
    const fileName = decodeURIComponent(encodedName)
    const path = await downloadInstaller(download.url, fileName, progress => {
      updateProgress.value = progress.fraction
    })
    downloadedInstaller.value = path
    toast(t('update.downloadDoneOpening'), 'success')
    await openInstaller(path)
  } catch (e: any) {
    toast(t('update.downloadFailed', { msg: e?.message ?? e }), 'error', 6000)
  } finally {
    updateBusy.value = false
    updateProgress.value = null
  }
}

onMounted(async () => {
  void refreshSidebarUpdate()
  if (isTauri()) stopExternalOpen = await startExternalOpen(router)
  // 多端同步: 启动一次、切到后台、每 5 分钟 (未开启自动同步时引擎自己跳过)
  stopSync = startAutoSync()
})
onBeforeUnmount(() => {
  stopExternalOpen?.()
  stopSync?.()
})
// 阅读页全屏沉浸, 隐藏侧栏
const immersive = computed(() => String(route.path).startsWith('/read'))
// 退出阅读器 (/read /read-paper /read-djvu) 时同步进度与笔记
watch(immersive, (now, before) => {
  if (before && !now) requestAutoSync('reader-exit')
})

const navs = [
  { path: '/library', labelKey: 'nav.library', icon: 'M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15.5a2.5 2.5 0 0 1-2.5 2.5H6.5A2.5 2.5 0 0 1 4 18.5v-13zM6.5 5A.5.5 0 0 0 6 5.5V16.05c.16-.03.32-.05.5-.05H18V5H6.5zM6 18.5a.5.5 0 0 0 .5.5H18v-1H6.5a.5.5 0 0 0-.5.5z' },
  { path: '/papers', labelKey: 'nav.papers', icon: 'M6 2h9a1 1 0 0 1 .7.3l4 4a1 1 0 0 1 .3.7v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm8 2H6v16h12V8h-3a1 1 0 0 1-1-1V4zm2 .41V6h1.59L16 4.41zM8 11a1 1 0 0 1 1-1h6a1 1 0 1 1 0 2H9a1 1 0 0 1-1-1zm0 4a1 1 0 0 1 1-1h6a1 1 0 1 1 0 2H9a1 1 0 0 1-1-1z' },
  { path: '/catalogs', labelKey: 'nav.catalogs', icon: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM4.06 13h3.97c.1 1.9.5 3.63 1.1 5.02A8.02 8.02 0 0 1 4.06 13zm0-2a8.02 8.02 0 0 1 5.07-7.02c-.6 1.4-1 3.12-1.1 5.02H4.06zM12 4.04c.83.9 1.72 2.87 1.94 6.96h-3.88c.22-4.09 1.1-6.05 1.94-6.96zM10.06 13h3.88c-.22 4.09-1.11 6.05-1.94 6.96-.83-.9-1.72-2.87-1.94-6.96zm5.9 0h3.98a8.02 8.02 0 0 1-5.07 5.02c.6-1.4 1-3.12 1.1-5.02zm0-2c-.1-1.9-.5-3.63-1.1-5.02A8.02 8.02 0 0 1 19.95 11h-3.98z' },
]

// 设置固定在侧栏左下角, 保持主导航干净
const settingsNav = { path: '/settings', labelKey: 'nav.settings', icon: 'M10.83 3.28a1.5 1.5 0 0 1 2.34 0l.94 1.16c.24.3.62.45 1 .4l1.47-.2a1.5 1.5 0 0 1 1.69 1.61l-.12 1.49c-.03.38.14.75.46.97l1.23.85a1.5 1.5 0 0 1 .4 2.3l-.86 1.22c-.22.31-.26.72-.1 1.07l.6 1.36a1.5 1.5 0 0 1-1.17 2.03l-1.47.24c-.38.06-.7.32-.83.68l-.52 1.4a1.5 1.5 0 0 1-2.2.8l-1.28-.77a1.13 1.13 0 0 0-1.08 0l-1.28.76a1.5 1.5 0 0 1-2.2-.79l-.52-1.4a1.13 1.13 0 0 0-.83-.68l-1.47-.24a1.5 1.5 0 0 1-1.17-2.03l.6-1.36c.16-.35.12-.76-.1-1.07l-.87-1.22a1.5 1.5 0 0 1 .41-2.3l1.23-.85c.32-.22.49-.59.46-.97l-.12-1.5a1.5 1.5 0 0 1 1.69-1.6l1.48.2c.37.05.75-.1.99-.4l.94-1.16zM12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z' }
</script>

<template>
  <div class="shell" :class="{ immersive }">
    <aside v-if="!immersive" class="sidebar">
      <div class="logo" aria-hidden="true">
        <svg viewBox="0 0 48 48" width="30" height="30">
          <defs>
            <linearGradient id="logo-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3B82FF" /><stop offset="1" stop-color="#0F4FE3" /></linearGradient>
          </defs>
          <rect width="48" height="48" rx="11" fill="url(#logo-bg)" />
          <g transform="translate(24 25.6) scale(1.5) translate(-12 -12.4)">
            <path d="M11.25 6.2C9.3 4.9 6.6 4.4 3 4.6v13.9c3.5-.2 6.2.3 8.25 1.6z" fill="#fff" />
            <path d="M12.75 6.2c1.95-1.3 4.65-1.8 8.25-1.6v13.9c-3.5-.2-6.2.3-8.25 1.6z" fill="#fff" fill-opacity=".78" />
          </g>
          <path d="M37 7.2c0 2.6.9 3.5 3.5 3.5-2.6 0-3.5.9-3.5 3.5 0-2.6-.9-3.5-3.5-3.5 2.6 0 3.5-.9 3.5-3.5z" fill="#FFC53D" />
        </svg>
        <span class="logo-text">{{ t('app.name') }}</span>
      </div>
      <nav class="nav" :aria-label="t('nav.mainAria')">
        <router-link
          v-for="n in navs"
          :key="n.path"
          :to="n.path"
          class="nav-item"
          :title="t(n.labelKey)"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path :d="n.icon" fill="currentColor" />
          </svg>
          <span class="nav-label">{{ t(n.labelKey) }}</span>
        </router-link>
      </nav>
      <div class="sidebar-bottom">
        <router-link :to="settingsNav.path" class="nav-item sidebar-settings" :title="t(settingsNav.labelKey)">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path :d="settingsNav.icon" fill="currentColor" />
          </svg>
          <span class="nav-label">{{ t(settingsNav.labelKey) }}</span>
        </router-link>
        <button
          v-if="showSidebarUpdate"
          class="sidebar-update"
          :class="{ downloading: updateBusy }"
          type="button"
          :title="sidebarUpdateTitle"
          :aria-label="sidebarUpdateTitle"
          :aria-busy="updateBusy"
          @click="handleSidebarUpdate"
        >
          <span class="sidebar-update-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="21" height="21">
              <path d="M12 3v11m0 0 4-4m-4 4-4-4M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2" />
            </svg>
          </span>
          <span class="sidebar-update-label" aria-hidden="true">{{ sidebarUpdateLabel }}</span>
        </button>
      </div>
    </aside>
    <main class="main">
      <router-view :key="route.fullPath" />
    </main>
    <BabeldocTaskStatus />
    <ToastHost />
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  height: 100%;
}
/* 安卓 edge-to-edge / iOS 刘海屏: 网页铺到系统栏下, 普通页面让出状态栏与横屏两侧;
   阅读页 (immersive) 自行处理, 背景色可延伸到状态栏下 */
.shell:not(.immersive) {
  padding-top: var(--lr-safe-top);
  padding-left: var(--lr-safe-left);
  padding-right: var(--lr-safe-right);
}
.sidebar {
  width: 208px;
  flex-shrink: 0;
  position: relative;
  z-index: 2;
  background: var(--card);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  padding: 18px 12px calc(16px + var(--lr-safe-bottom));
  transition: width var(--dur) var(--ease);
}
.logo {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 40px;
  padding: 0 8px;
  margin-bottom: 14px;
}
.logo svg {
  flex-shrink: 0;
}
.logo-text {
  font-size: 17px;
  font-weight: 650;
  letter-spacing: -0.01em;
  white-space: nowrap;
}
.nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
}
.nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  height: 40px;
  padding: 0 10px;
  border-radius: var(--radius);
  color: var(--text-2);
  font-size: 14px;
  font-weight: 500;
  white-space: nowrap;
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}
.nav-item:hover {
  background: var(--surface-2);
  color: var(--text);
  text-decoration: none;
}
.nav-item:active {
  background: var(--surface-3);
}
.nav-item:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.nav-item.router-link-active {
  background: var(--brand-light);
  color: var(--brand);
  font-weight: 600;
}
.nav-item.router-link-active::before {
  content: '';
  position: absolute;
  left: -12px;
  top: 10px;
  bottom: 10px;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: var(--brand);
}
.nav-item svg {
  flex-shrink: 0;
}
.nav-label {
  overflow: hidden;
  text-overflow: ellipsis;
}
.sidebar-bottom {
  position: relative;
  height: 40px;
  flex: none;
}
.sidebar-settings {
  box-sizing: border-box;
  width: 100%;
  height: 40px;
  padding-right: 56px;
  overflow: hidden;
}
.sidebar-update {
  position: absolute;
  top: 0;
  left: calc(100% - 40px);
  width: 40px;
  height: 40px;
  padding: 0;
  display: flex;
  align-items: center;
  overflow: hidden;
  border: 0;
  border-radius: 999px;
  background: var(--brand);
  color: var(--on-brand);
  box-shadow: 0 5px 16px color-mix(in srgb, var(--brand) 30%, transparent);
  cursor: pointer;
  font: inherit;
  white-space: nowrap;
  transition: width 180ms cubic-bezier(.2, .75, .25, 1), box-shadow 180ms ease;
}
.sidebar-update:hover,
.sidebar-update:focus-visible {
  width: 112px;
  box-shadow: 0 7px 20px color-mix(in srgb, var(--brand) 38%, transparent);
}
.sidebar-update:focus-visible {
  outline: 3px solid color-mix(in srgb, var(--brand) 24%, transparent);
  outline-offset: 2px;
}
.sidebar-update-icon {
  width: 40px;
  height: 40px;
  flex: 0 0 40px;
  display: grid;
  place-items: center;
}
.sidebar-update-icon svg {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.9;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.sidebar-update-label {
  min-width: 58px;
  padding: 0 14px 0 6px;
  text-align: left;
  font-size: 14px;
  font-weight: 600;
  line-height: 40px;
}
.sidebar-update.downloading {
  cursor: progress;
}
.main {
  flex: 1;
  min-width: 0;
  overflow: auto;
  overscroll-behavior: contain;
}
.immersive .main {
  overflow: hidden;
}

/* 平板 / 窄窗口: 收成图标栏, 悬停显示 title */
@media (min-width: 721px) and (max-width: 1023px) {
  .sidebar {
    width: 68px;
    padding-inline: 10px;
    align-items: stretch;
  }
  .logo {
    justify-content: center;
    padding: 0;
  }
  .logo-text,
  .nav-label {
    display: none;
  }
  .nav-item {
    justify-content: center;
    padding: 0;
    height: 44px;
  }
  .nav-item.router-link-active::before {
    left: -10px;
  }
  .sidebar-settings {
    padding-right: 0;
  }
  .sidebar-bottom {
    height: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .sidebar-update {
    position: static;
    width: 100%;
    height: 40px;
    justify-content: center;
    border-radius: var(--radius);
  }
  .sidebar-update:hover,
  .sidebar-update:focus-visible {
    width: 100%;
  }
  .sidebar-update-label {
    display: none;
  }
}

/* 手机: 底部标签栏, 图标在上文字在下, 预留手势区安全边距 */
@media (max-width: 720px) {
  .shell:not(.immersive) {
    flex-direction: column-reverse;
  }
  .sidebar {
    width: 100%;
    flex-direction: row;
    align-items: stretch;
    padding: 4px 6px calc(4px + var(--lr-safe-bottom));
    border-right: none;
    border-top: 1px solid var(--border);
    box-shadow: 0 -1px 0 color-mix(in srgb, var(--border) 50%, transparent);
  }
  .logo {
    display: none;
  }
  .nav {
    flex-direction: row;
    flex: 3;
    gap: 2px;
  }
  .nav-item {
    flex: 1;
    flex-direction: column;
    justify-content: center;
    gap: 3px;
    height: 52px;
    min-width: 0;
    padding: 0 4px;
    font-size: 11px;
    font-weight: 500;
    border-radius: var(--radius);
  }
  .nav-item svg {
    width: 22px;
    height: 22px;
  }
  .nav-item.router-link-active {
    background: transparent;
  }
  .nav-item.router-link-active::before {
    left: 50%;
    top: -4px;
    bottom: auto;
    width: 24px;
    height: 3px;
    transform: translateX(-50%);
    border-radius: 0 0 3px 3px;
  }
  .sidebar-bottom {
    flex: 1;
    height: auto;
    display: flex;
  }
  .sidebar-settings {
    width: 100%;
    height: 52px;
    padding-right: 4px;
    overflow: visible;
  }
  .sidebar-update {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .sidebar,
  .sidebar-update {
    transition: none;
  }
}
</style>
