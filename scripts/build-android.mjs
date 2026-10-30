#!/usr/bin/env node
// 本机 Android 打包的唯一入口: npm run android:build
// 与 CI (release.yml) 保持同一套参数, 避免手敲命令漏项:
//  - CARGO_PROFILE_DEV_DEBUG=0: `--debug` 走 Cargo dev profile, 默认带完整 DWARF,
//    Gradle 又保留调试符号 (keepDebugSymbols), liblightread_lib.so 会从 ~90MB 涨到 ~290MB;
//  - 先 :app:clean, 防止增量 ZIP 留下整份旧原生库的空洞;
//  - gen/android 不入库: 打包前把入库的 src-tauri/android/MainActivity.kt 覆盖进去并打清单补丁
//    (app-v2.4.0 曾用旧工程里的 MainActivity 打包, 缺了 LightReadLifecycle 桥);
//  - 必须有固定签名 LIGHTREAD_ANDROID_KEYSTORE;
//  - 打完立即跑 verifyApkLayout / verifyNativeLibraries, 不合格直接失败。
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { verifyApkLayout, verifyNativeLibraries } from './apk-layout.mjs'

const env = { ...process.env, CARGO_PROFILE_DEV_DEBUG: '0' }
const sdk = join(homedir(), 'android-sdk')
if (!env.ANDROID_HOME && existsSync(sdk)) env.ANDROID_HOME = env.ANDROID_SDK_ROOT = sdk
if (!env.LIGHTREAD_ANDROID_KEYSTORE) {
  const key = join(homedir(), '.config/lightread/signing/lightread-android.jks')
  if (!existsSync(key)) throw new Error('LIGHTREAD_ANDROID_KEYSTORE 未设置, 且找不到固定签名 ~/.config/lightread/signing/lightread-android.jks')
  env.LIGHTREAD_ANDROID_KEYSTORE = key
}

const project = 'src-tauri/gen/android'
const run = (cmd, args) => execFileSync(cmd, args, { env, stdio: 'inherit' })
const activity = join(project, 'app/src/main/java/com/yzfly/lightread/MainActivity.kt')
if (!existsSync(activity)) throw new Error(`找不到 ${activity}: 先运行 npx tauri android init`)
copyFileSync('src-tauri/android/MainActivity.kt', activity)
run('node', ['scripts/patch-android-project.mjs', project])
run(join(project, 'gradlew'), ['-q', '-p', project, ':app:clean'])
run('npx', ['tauri', 'android', 'build', '--apk', '--target', 'aarch64', '--debug'])

const apk = join(project, 'app/build/outputs/apk/universal/debug/app-universal-debug.apk')
const bytes = readFileSync(apk)
verifyApkLayout(bytes)
const libraries = verifyNativeLibraries(bytes)
console.log(`\n${apk}\n${(statSync(apk).size / 1048576).toFixed(1)} MB; ${libraries.map(lib => `${lib.name} ${(lib.bytes / 1048576).toFixed(1)} MB`).join(', ')}; no debug sections`)
