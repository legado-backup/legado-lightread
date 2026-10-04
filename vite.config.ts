import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'
import { readFileSync } from 'node:fs'

import { cloudflare } from '@cloudflare/vite-plugin'
import { BROWSER_TARGET, legacyCssFallbacks, legacyRegexRewrite } from './vite.legacy.ts'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'))

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [legacyRegexRewrite(), vue(), VitePWA({
    // 桌面/移动端 (Tauri) 资源都在本地, 不需要 PWA 离线缓存; Windows WebView2
    // 会把 Service Worker 缓存的旧版界面存进用户数据目录, 升级后仍加载旧代码。
    // 自毁型 SW 让已装机器上的旧 SW 在更新检查时自动注销并清缓存。
    selfDestroying: !!process.env.TAURI_ENV_PLATFORM,
    registerType: 'autoUpdate',
    workbox: {
      // MuPDF wasm 约 10MB，网页版需要完整预缓存以支持离线阅读。
      maximumFileSizeToCacheInBytes: 16 * 1024 * 1024,
    },
    manifest: {
      name: 'LightRead 轻阅',
      short_name: '轻阅',
      description: '开源本地阅读器 · 支持 EPUB / MOBI / AZW3 / FB2 / CBZ / PDF / TXT 等格式，藏书管理与 OPDS 书源',
      theme_color: '#1664FF',
      background_color: '#F7F8FA',
      display: 'standalone',
      icons: [
        { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
        // 安卓桌面自适应图标: 字形在安全区内, 满版底色可被任意形状裁切
        { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
  }),
  // Cloudflare 插件仅用于网页版部署; Tauri 桌面构建不加载 (且其要求 Node ≥22.15)
  ...(process.env.TAURI_ENV_PLATFORM ? [] : [cloudflare()])],
  css: {
    postcss: { plugins: [legacyCssFallbacks()] },
  },
  build: {
    // 旧 WebView 兼容目标 (依据见 vite.legacy.ts); CSS 目标默认跟随, lightningcss 据此补前缀
    target: BROWSER_TARGET,
    chunkSizeWarningLimit: 2048,
    rolldownOptions: {
      output: {
        codeSplitting: {
          // polyfill 单独成块: 入口 chunk 的第一条 import, 先于 vue/设置等共享块求值
          groups: [{ name: 'polyfills', test: /[\\/]src[\\/]polyfills\.ts$/, priority: 100 }],
        },
      },
    },
  },
  worker: {
    // 目前没有模块 Worker (DjVu.js 的 Worker 由函数源码拼成 Blob, 走主包降级结果);
    // 显式写明, 以后新增 `new Worker(new URL(..., import.meta.url))` 时沿用同一目标的 ES 模块产物
    format: 'es',
  },
  // Tauri 开发时使用固定端口
  server: {
    port: 5173,
    strictPort: true,
  },
})
