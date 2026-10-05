<script setup lang="ts">
/**
 * 设置 → 账号与同步 → 轻阅账号.
 * 未登录: 说明同步什么 → 邮箱 → 验证码 (两步, 输满 6 位自动提交); 已登录: 身份卡 + 退出 / 注销.
 * e2e 依赖: 文本框名 /邮箱/ /验证码/、按钮「发送验证码」「退出登录」、已登录卡片 .conn-card 含邮箱.
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useSettings } from '../../stores/settings'
import { syncNow, syncState } from '../../services/sync'
import {
  accountState,
  deleteAccount,
  isLoggedIn,
  logout,
  requestLoginCode,
  verifyLoginCode,
} from '../../services/account'
import { toast } from '../../services/toast'
import { t } from '../../i18n'

const settings = useSettings()

const loggedIn = computed(() => {
  void accountState.token
  try {
    return isLoggedIn()
  } catch {
    return !!accountState.token
  }
})

const email = computed(() => accountState.account?.email ?? '')
const avatarLetter = computed(() => (email.value.trim()[0] ?? '?').toUpperCase())
const deviceCount = computed(() => syncState.lastResult?.devices ?? 0)

// ---- 登录: 邮箱 → 验证码 ----
const loginEmail = ref('')
const loginCode = ref('')
const codeSent = ref(false)
const sendingCode = ref(false)
const verifying = ref(false)
const accountError = ref('')
const accountBusy = ref(false)
const emailInput = ref<HTMLInputElement>()
const codeInput = ref<HTMLInputElement>()

const RESEND_SECONDS = 60
const resendLeft = ref(0)
/** 倒计时属于哪个邮箱 (服务端按邮箱限制重发间隔), 换了邮箱不受影响 */
const cooldownEmail = ref('')
let resendTimer = 0

const normEmail = (s: string) => s.trim().toLowerCase()

function startResendCountdown(seconds: number, forEmail = normEmail(loginEmail.value)) {
  window.clearInterval(resendTimer)
  resendLeft.value = Math.max(0, Math.ceil(seconds))
  cooldownEmail.value = forEmail
  if (!resendLeft.value) return
  resendTimer = window.setInterval(() => {
    resendLeft.value -= 1
    if (resendLeft.value <= 0) window.clearInterval(resendTimer)
  }, 1000)
}
onBeforeUnmount(() => window.clearInterval(resendTimer))

const cooling = computed(() => resendLeft.value > 0 && cooldownEmail.value === normEmail(loginEmail.value))
const cooldownText = computed(() => {
  const s = resendLeft.value
  return s > 120
    ? t('account.resendWaitMin', { minutes: Math.ceil(s / 60) })
    : t('account.resendWait', { seconds: s })
})

// 改了邮箱就清掉上一封邮件的错误提示
watch(loginEmail, () => {
  if (!codeSent.value) accountError.value = ''
})

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

async function sendLoginCode() {
  if (sendingCode.value || cooling.value) return
  const addr = loginEmail.value.trim()
  if (!EMAIL_RE.test(addr)) {
    accountError.value = t('account.err.invalidEmail')
    emailInput.value?.focus()
    return
  }
  accountError.value = ''
  sendingCode.value = true
  try {
    await requestLoginCode(addr)
    codeSent.value = true
    loginCode.value = ''
    startResendCountdown(RESEND_SECONDS, normEmail(addr))
    await nextTick()
    codeInput.value?.focus()
  } catch (e: any) {
    accountError.value = e?.message || t('common.unknownError')
    // 服务端限流时 (Error 带 retryAfter) 按剩余秒数倒计时
    const retryAfter = Number(e?.retryAfter)
    if (Number.isFinite(retryAfter) && retryAfter > 0) startResendCountdown(retryAfter, normEmail(addr))
  } finally {
    sendingCode.value = false
  }
}

async function changeEmail() {
  if (verifying.value) return
  codeSent.value = false
  loginCode.value = ''
  accountError.value = ''
  await nextTick()
  emailInput.value?.focus()
  emailInput.value?.select()
}

function onCodeInput() {
  loginCode.value = loginCode.value.replace(/\D/g, '').slice(0, 6)
  if (accountError.value && loginCode.value.length < 6) accountError.value = ''
  // 输满 6 位 (含粘贴 / 短信自动填充) 直接登录, 不用再点按钮
  if (loginCode.value.length === 6 && !verifying.value) submitLogin()
}

async function submitLogin() {
  if (verifying.value) return
  const code = loginCode.value.trim()
  if (!/^\d{6}$/.test(code)) {
    accountError.value = t('account.err.codeLength')
    codeInput.value?.focus()
    return
  }
  accountError.value = ''
  verifying.value = true
  try {
    await verifyLoginCode(loginEmail.value.trim(), code)
    toast(t('account.loggedIn'), 'success')
    loginCode.value = ''
    codeSent.value = false
    startResendCountdown(0)
    // 登录账号就是为了同步: 打开自动同步, 并立刻同步一次 (失败信息出现在同步状态行)
    settings.webdavSyncAuto = true
    syncNow().catch(() => {})
  } catch (e: any) {
    accountError.value = e?.message || t('common.unknownError')
    // 验证码不对: 选中已输入的内容, 直接重输
    await nextTick()
    codeInput.value?.focus()
    codeInput.value?.select()
  } finally {
    verifying.value = false
  }
}

function onEnter(e: KeyboardEvent, action: () => void) {
  if (e.isComposing) return
  e.preventDefault()
  action()
}

async function doLogout() {
  if (accountBusy.value) return
  accountBusy.value = true
  const prev = email.value
  try {
    await logout()
    // 方便重新登录: 预填刚才的邮箱
    loginEmail.value = prev
    toast(t('account.loggedOut'), 'success')
  } catch (e: any) {
    toast(e?.message || t('common.unknownError'), 'error', 5000)
  } finally {
    accountBusy.value = false
  }
}

// ---- 注销 ----
const showDeleteAccount = ref(false)
const deleteError = ref('')
const deleteCancelBtn = ref<HTMLButtonElement>()

async function openDeleteAccount() {
  deleteError.value = ''
  showDeleteAccount.value = true
  // 默认焦点放在「取消」上, 回车不会误删; 也让 Esc 能被弹层接住
  await nextTick()
  deleteCancelBtn.value?.focus()
}

function closeDeleteAccount() {
  if (accountBusy.value) return
  showDeleteAccount.value = false
}

async function confirmDeleteAccount() {
  if (accountBusy.value) return
  accountBusy.value = true
  deleteError.value = ''
  try {
    await deleteAccount()
    showDeleteAccount.value = false
    toast(t('account.deleted'), 'success')
  } catch (e: any) {
    deleteError.value = e?.message || t('common.unknownError')
  } finally {
    accountBusy.value = false
  }
}

const WHAT_SYNCS = ['account.what.progress', 'account.what.notes', 'account.what.lists', 'account.what.settings']
</script>

<template>
  <div class="account">
    <!-- 已登录: 身份卡 -->
    <template v-if="loggedIn">
      <div class="conn-card account-id">
        <span class="avatar" aria-hidden="true">{{ avatarLetter }}</span>
        <div class="id-text">
          <div class="id-email" :title="email">{{ email }}</div>
          <div class="id-sub">
            <span class="chip-ok">{{ t('account.loggedIn') }}</span>
            <span>{{ t('account.title') }}</span>
            <template v-if="deviceCount > 1"><span aria-hidden="true">·</span><span>{{ t('account.devices', { count: deviceCount }) }}</span></template>
          </div>
        </div>
        <button class="btn btn-sm id-logout" :disabled="accountBusy" @click="doLogout">{{ t('account.logout') }}</button>
      </div>
      <div class="id-foot">
        <span class="foot-text">{{ t('account.loggedInDesc') }}</span>
        <button type="button" class="link-danger" :disabled="accountBusy" @click="openDeleteAccount">{{ t('account.delete') }}</button>
      </div>
    </template>

    <!-- 未登录: 两步登录 -->
    <template v-else>
      <div class="login-head">
        <span class="login-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4" /><path d="M4 20.5a8 8 0 0 1 16 0" /></svg>
        </span>
        <div class="login-head-text">
          <h3 class="login-title">{{ t('account.title') }}</h3>
          <p class="login-tagline">{{ t('account.tagline') }}</p>
        </div>
      </div>

      <ul class="what-syncs" :aria-label="t('account.whatSyncs')">
        <li v-for="key in WHAT_SYNCS" :key="key">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
          {{ t(key) }}
        </li>
      </ul>
      <p class="no-files">{{ t('account.noFiles') }}</p>

      <!-- 第 1 步: 邮箱 -->
      <form v-if="!codeSent" class="login-step" novalidate @submit.prevent="sendLoginCode">
        <label class="field-label" for="account-email">{{ t('account.email') }}</label>
        <div class="login-line">
          <input
            id="account-email"
            ref="emailInput"
            v-model="loginEmail"
            class="input"
            type="email"
            inputmode="email"
            autocomplete="email"
            autocapitalize="off"
            spellcheck="false"
            enterkeyhint="send"
            :placeholder="t('account.emailPlaceholder')"
            :aria-label="t('account.email')"
            :aria-invalid="!!accountError"
            :aria-describedby="accountError ? 'account-error' : undefined"
            :disabled="sendingCode"
            @keydown.enter="onEnter($event, sendLoginCode)"
          />
          <button
            type="submit"
            class="btn btn-primary login-btn"
            :disabled="sendingCode || cooling || !loginEmail.trim()"
          >
            <svg v-if="sendingCode" class="spinning" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.2-8.56" /></svg>
            {{ sendingCode ? t('account.sending') : cooling ? cooldownText : t('account.sendCode') }}
          </button>
        </div>
      </form>

      <!-- 第 2 步: 验证码 -->
      <form v-else class="login-step" novalidate @submit.prevent="submitLogin">
        <div class="sent-to" role="status">
          <span class="sent-text">{{ t('account.codeSent', { email: loginEmail.trim() }) }}</span>
          <button type="button" class="link-btn" :disabled="verifying" @click="changeEmail">{{ t('account.changeEmail') }}</button>
        </div>
        <label class="field-label" for="account-code">{{ t('account.code') }}</label>
        <div class="login-line">
          <input
            id="account-code"
            ref="codeInput"
            v-model="loginCode"
            class="input code-input"
            type="text"
            inputmode="numeric"
            autocomplete="one-time-code"
            enterkeyhint="done"
            pattern="[0-9]*"
            maxlength="6"
            :placeholder="t('account.codePlaceholder')"
            :aria-label="t('account.code')"
            :aria-invalid="!!accountError"
            :aria-describedby="accountError ? 'account-error' : 'account-code-hint'"
            :readonly="verifying"
            @input="onCodeInput"
            @keydown.enter="onEnter($event, submitLogin)"
          />
          <button type="submit" class="btn btn-primary login-btn" :disabled="verifying || loginCode.length !== 6">
            <svg v-if="verifying" class="spinning" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.2-8.56" /></svg>
            {{ verifying ? t('account.loggingIn') : t('account.login') }}
          </button>
        </div>
        <div id="account-code-hint" class="code-hint">
          <span>{{ t('account.noCode') }}</span>
          <span v-if="cooling" class="cooldown" aria-live="off">{{ cooldownText }}</span>
          <button v-else type="button" class="link-btn" :disabled="sendingCode || verifying" @click="sendLoginCode">
            {{ sendingCode ? t('account.sending') : t('account.resend') }}
          </button>
        </div>
      </form>

      <div v-if="accountError" id="account-error" class="account-error" role="alert">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5m0 3.2h.01" /></svg>
        <span>{{ accountError }}</span>
      </div>
    </template>

    <div v-if="showDeleteAccount" class="modal-mask" @click.self="closeDeleteAccount" @keydown.esc="closeDeleteAccount">
      <div class="modal confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="delete-account-title" aria-describedby="delete-account-desc">
        <h3 id="delete-account-title">{{ t('account.deleteTitle') }}</h3>
        <p id="delete-account-desc" class="modal-text">{{ t('account.deleteConfirm') }}</p>
        <p v-if="email" class="modal-text"><code>{{ email }}</code></p>
        <div v-if="deleteError" class="account-error" role="alert"><span>{{ deleteError }}</span></div>
        <div class="modal-actions">
          <button ref="deleteCancelBtn" class="btn" :disabled="accountBusy" @click="closeDeleteAccount">{{ t('common.cancel') }}</button>
          <button class="btn btn-danger" :disabled="accountBusy" @click="confirmDeleteAccount">
            {{ accountBusy ? t('account.deleting') : t('account.deleteAction') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ---- 已登录 ---- */
.account-id {
  display: flex;
  align-items: center;
  gap: 12px;
}
.avatar {
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--brand-light);
  color: var(--brand);
  font-size: 17px;
  font-weight: 650;
}
.id-text {
  flex: 1;
  min-width: 0;
}
.id-email {
  font-size: 15px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.id-sub {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 6px;
  margin-top: 3px;
  font-size: 12.5px;
  color: var(--text-3);
}
.chip-ok {
  font-size: 11.5px;
  font-weight: 500;
  color: var(--success);
  background: var(--success-soft);
  border-radius: var(--radius-pill);
  padding: 0 8px;
  line-height: 20px;
}
.id-logout {
  flex-shrink: 0;
}
.id-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 10px;
}
.foot-text {
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text-3);
}
.link-danger {
  flex-shrink: 0;
  min-height: 32px;
  border: none;
  background: none;
  padding: 0 2px;
  font-size: 12.5px;
  color: var(--danger);
  cursor: pointer;
}
.link-danger:hover:not(:disabled) {
  text-decoration: underline;
}

/* ---- 未登录 ---- */
.login-head {
  display: flex;
  align-items: center;
  gap: 12px;
}
.login-icon {
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--brand-light);
  color: var(--brand);
}
.login-head-text {
  min-width: 0;
}
.login-title {
  font-size: 15px;
  font-weight: 600;
}
.login-tagline {
  font-size: 12.5px;
  color: var(--text-3);
  margin-top: 2px;
  line-height: 1.5;
}
.what-syncs {
  list-style: none;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 14px;
}
.what-syncs li {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12.5px;
  color: var(--text-2);
  background: var(--surface-2);
  border-radius: var(--radius-pill);
  padding: 3px 10px 3px 8px;
}
.what-syncs svg {
  color: var(--success);
}
.no-files {
  font-size: 12px;
  color: var(--text-3);
  margin-top: 8px;
  line-height: 1.6;
}
.login-step {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 14px;
}
.field-label {
  font-size: 12.5px;
  font-weight: 550;
  color: var(--text-2);
}
.login-line {
  display: flex;
  gap: 8px;
}
.login-line .input {
  flex: 1;
  min-width: 0;
}
.login-btn {
  flex-shrink: 0;
  min-width: 120px;
  font-variant-numeric: tabular-nums;
}
.code-input {
  font-family: var(--font-mono);
  font-size: 18px;
  letter-spacing: 0.32em;
  font-variant-numeric: tabular-nums;
}
.code-input::placeholder {
  font-family: var(--font);
  font-size: 14px;
  letter-spacing: normal;
}
.sent-to {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  margin-bottom: 6px;
  border-radius: var(--radius);
  background: var(--success-soft);
  font-size: 13px;
  line-height: 1.55;
  color: var(--text-2);
}
.sent-to .link-btn {
  flex-shrink: 0;
  min-height: 32px;
}
.sent-text {
  min-width: 0;
  overflow-wrap: anywhere;
}
.code-hint {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 4px 12px;
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.6;
  margin-top: 2px;
}
.cooldown {
  font-variant-numeric: tabular-nums;
}
.link-btn {
  display: inline-flex;
  align-items: center;
  min-height: 28px;
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  font-weight: 550;
  color: var(--brand);
  cursor: pointer;
}
.link-btn:hover:not(:disabled) {
  text-decoration: underline;
}
.link-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.link-btn:focus-visible,
.link-danger:focus-visible {
  outline: none;
  box-shadow: var(--ring);
  border-radius: 4px;
}
.account-error {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin-top: 10px;
  padding: 8px 10px;
  border-radius: var(--radius);
  background: var(--danger-soft);
  color: var(--danger);
  font-size: 12.5px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}
.account-error svg {
  flex-shrink: 0;
  margin-top: 2px;
}
.spinning {
  animation: account-spin 1s linear infinite;
}
@keyframes account-spin {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .spinning { animation: none; }
}

/* ---- 弹层 ---- */
.confirm-modal {
  width: min(420px, 100%);
}
.modal-text {
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-2);
  margin: 0 0 8px;
  overflow-wrap: anywhere;
}
.modal-text code {
  font-family: var(--font-mono);
  font-size: 0.92em;
  background: var(--surface-2);
  padding: 1px 5px;
  border-radius: 4px;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}

/* ---- 手机 ---- */
@media (max-width: 600px) {
  .login-line {
    flex-direction: column;
  }
  .login-line .input {
    flex: none;
    width: 100%;
    height: 44px;
    font-size: 16px; /* iOS: < 16px 聚焦时会放大页面 */
  }
  .login-line .code-input {
    font-size: 20px;
    text-align: center;
    padding-left: calc(12px + 0.32em);
  }
  .code-input::placeholder {
    font-size: 15px;
  }
  .login-btn {
    width: 100%;
    height: 44px;
    font-size: 15px;
  }
  .id-logout {
    height: 36px;
  }
  .link-btn,
  .link-danger {
    min-height: 44px;
  }
  .code-hint {
    margin-top: 0;
  }
  .modal-actions .btn {
    flex: 1;
    height: 44px;
  }
}
</style>
