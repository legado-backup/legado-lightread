// 轻阅账号 / 同步后端接口契约 (node --test). 经 wrangler 的本地运行时 (workerd + 本地 D1/R2) 驱动 Worker.
// 运行: cd sync-server && node --test test/   (wrangler 取仓库根目录的 node_modules)
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createTestHarness } from 'wrangler'
import { addDays, beijingDay } from '../src/stats.ts'

const ADMIN_TOKEN = 'test-admin-token-0123456789abcdef'
const root = fileURLToPath(new URL('..', import.meta.url))
const server = createTestHarness({
  root,
  // DEV_EXPOSE_CODE 只在测试里打开: /v1/auth/code 直接返回验证码
  workers: [{ configPath: './wrangler.jsonc', vars: { DEV_EXPOSE_CODE: '1', ADMIN_TOKEN } }],
})

const BASE = 'http://sync.test'
let ipSeq = 0

/** 每次发码 / 心跳用不同 IP, 避免撞上单 IP 每日上限 */
function call(method, path, { body, token, raw, headers = {} } = {}) {
  const h = { ...headers }
  if (token) h.authorization = `Bearer ${token}`
  if (body !== undefined && !raw) h['content-type'] = 'application/json'
  if ((path === '/v1/auth/code' || path === '/v1/ping') && !h['cf-connecting-ip']) {
    ++ipSeq
    h['cf-connecting-ip'] = `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq & 255}`
  }
  return server.fetch(BASE + path, {
    method,
    headers: h,
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  })
}

async function jsonOf(res) {
  return JSON.parse(await res.text())
}

async function requestCode(email) {
  const res = await call('POST', '/v1/auth/code', { body: { email } })
  assert.equal(res.status, 200)
  const { devCode } = await jsonOf(res)
  assert.match(devCode, /^\d{6}$/)
  return devCode
}

async function login(email, deviceName = 'test') {
  const code = await requestCode(email)
  const res = await call('POST', '/v1/auth/verify', { body: { email, code, deviceName } })
  assert.equal(res.status, 200)
  return jsonOf(res)
}

function makeDoc(deviceId, extra = {}) {
  return {
    format: 1,
    deviceId,
    deviceName: deviceId,
    writtenAt: Date.now(),
    books: {},
    annotations: {},
    booklists: {},
    booklistItems: {},
    sources: {},
    ...extra,
  }
}

before(async () => {
  await server.listen()
  const env = await server.getWorker().getEnv()
  // 按 schema.sql 建表 (与生产 wrangler d1 execute 同一份)
  const sql = await readFile(new URL('../schema.sql', import.meta.url), 'utf8')
  const statements = sql
    .replace(/--.*$/gm, '')
    .split(';')
    .map(s => s.trim())
    .filter(Boolean)
  await env.DB.batch(statements.map(s => env.DB.prepare(s)))
})

after(async () => {
  await server.close()
})

test('health', async () => {
  const res = await call('GET', '/health')
  assert.equal(res.status, 200)
  assert.deepEqual(await jsonOf(res), { ok: true })
})

test('CORS 预检与错误响应都带 CORS 头', async () => {
  const pre = await call('OPTIONS', '/v1/docs/abc', {
    headers: { origin: 'https://app.example', 'access-control-request-method': 'PUT' },
  })
  assert.equal(pre.status, 204)
  assert.equal(pre.headers.get('access-control-allow-origin'), '*')
  assert.match(pre.headers.get('access-control-allow-headers'), /authorization/)
  assert.match(pre.headers.get('access-control-allow-headers'), /content-type/)
  for (const m of ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']) {
    assert.match(pre.headers.get('access-control-allow-methods'), new RegExp(m))
  }
  const nf = await call('GET', '/nope')
  assert.equal(nf.status, 404)
  assert.equal(nf.headers.get('access-control-allow-origin'), '*')
  assert.deepEqual(await jsonOf(nf), { error: 'not_found' })
  const unauth = await call('GET', '/v1/me')
  assert.equal(unauth.status, 401)
  assert.equal(unauth.headers.get('access-control-allow-origin'), '*')
  assert.deepEqual(await jsonOf(unauth), { error: 'unauthorized' })
})

test('WebDAV 中转: 预检放行 WebDAV 方法; 只认白名单服务商; 无 Basic 鉴权 / 越级路径不转发', async () => {
  const pre = await call('OPTIONS', '/v1/webdav/jianguoyun/LightRead/', {
    headers: { origin: 'https://app.example', 'access-control-request-method': 'PROPFIND' },
  })
  assert.equal(pre.status, 204)
  assert.equal(pre.headers.get('access-control-allow-origin'), '*')
  assert.match(pre.headers.get('access-control-allow-headers'), /depth/)
  for (const m of ['PROPFIND', 'MKCOL', 'PUT', 'HEAD']) {
    assert.match(pre.headers.get('access-control-allow-methods'), new RegExp(m))
  }
  const unknown = await call('PROPFIND', '/v1/webdav/evil/x', { headers: { authorization: 'Basic eDp5' } })
  assert.equal(unknown.status, 404)
  const noAuth = await call('PROPFIND', '/v1/webdav/koofr/')
  assert.equal(noAuth.status, 401)
  assert.equal(noAuth.headers.get('www-authenticate'), null)
  assert.equal(noAuth.headers.get('access-control-allow-origin'), '*')
  const bearer = await call('GET', '/v1/webdav/koofr/a', { headers: { authorization: 'Bearer x' } })
  assert.equal(bearer.status, 401)
  const traversal = await call('GET', '/v1/webdav/jianguoyun/a/..%2Fb', { headers: { authorization: 'Basic eDp5' } })
  assert.equal(traversal.status, 400)
  const post = await call('POST', '/v1/webdav/jianguoyun/a', { headers: { authorization: 'Basic eDp5' } })
  assert.equal(post.status, 405)
})

test('非法邮箱 → 400 invalid_email', async () => {
  for (const email of ['', 'not-an-email', 'a@b', 'x y@z.com', 123]) {
    const res = await call('POST', '/v1/auth/code', { body: { email } })
    assert.equal(res.status, 400, String(email))
    assert.deepEqual(await jsonOf(res), { error: 'invalid_email' })
  }
  const bad = await call('POST', '/v1/auth/code', { body: '{oops', raw: true })
  assert.equal(bad.status, 400)
})

test('验证码 → 验证 → token; 邮箱 trim + 小写; 同一邮箱再登录是同一账号', async () => {
  const first = await login('  Alice@Example.COM ')
  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(first.account.email, 'alice@example.com')
  assert.ok(first.account.id)
  assert.equal(typeof first.account.createdAt, 'number')

  const me = await call('GET', '/v1/me', { token: first.token })
  assert.equal(me.status, 200)
  assert.deepEqual(await jsonOf(me), { account: first.account })

  // 验证码一次性
  const code = await requestCode('reuse@example.com')
  const ok = await call('POST', '/v1/auth/verify', { body: { email: 'reuse@example.com', code } })
  assert.equal(ok.status, 200)
  const again = await call('POST', '/v1/auth/verify', { body: { email: 'reuse@example.com', code } })
  assert.equal(again.status, 400)
  assert.deepEqual(await jsonOf(again), { error: 'invalid_code' })

  // 同一个邮箱再登录: 同一账号, 另一个 token
  const second = await login('alice@example.com')
  assert.equal(second.account.id, first.account.id)
  assert.notEqual(second.token, first.token)
})

test('60 秒内重发 → 429 rate_limited + retryAfter', async () => {
  await requestCode('resend@example.com')
  const res = await call('POST', '/v1/auth/code', { body: { email: 'RESEND@example.com' } })
  assert.equal(res.status, 429)
  const body = await jsonOf(res)
  assert.equal(body.error, 'rate_limited')
  assert.ok(body.retryAfter > 0 && body.retryAfter <= 60, String(body.retryAfter))
  assert.equal(res.headers.get('retry-after'), String(body.retryAfter))
})

test('错误验证码: 前 4 次 invalid_code, 第 5 次起 too_many_attempts, 正确码也作废', async () => {
  const email = 'brute@example.com'
  const code = await requestCode(email)
  const wrong = code === '000000' ? '111111' : '000000'
  for (let i = 1; i <= 4; i++) {
    const res = await call('POST', '/v1/auth/verify', { body: { email, code: wrong } })
    assert.equal(res.status, 400, `attempt ${i}`)
    assert.deepEqual(await jsonOf(res), { error: 'invalid_code' })
  }
  const fifth = await call('POST', '/v1/auth/verify', { body: { email, code: wrong } })
  assert.equal(fifth.status, 429)
  assert.deepEqual(await jsonOf(fifth), { error: 'too_many_attempts' })
  const right = await call('POST', '/v1/auth/verify', { body: { email, code } })
  assert.equal(right.status, 429)
  assert.deepEqual(await jsonOf(right), { error: 'too_many_attempts' })

  // 没发过码 / 格式不对
  const none = await call('POST', '/v1/auth/verify', { body: { email: 'never@example.com', code: '123456' } })
  assert.equal(none.status, 400)
  const malformed = await call('POST', '/v1/auth/verify', { body: { email, code: '12ab' } })
  assert.equal(malformed.status, 400)
})

test('PUT/GET 文档: 两台设备往返; deviceId 不符 / 格式错 → 400; 超 8MB → 413', async () => {
  const { token } = await login('docs@example.com')
  const empty = await call('GET', '/v1/docs', { token })
  assert.equal(empty.status, 200)
  assert.deepEqual(await jsonOf(empty), { docs: [] })

  const a = makeDoc('dev-A', {
    books: { h1: { meta: { value: { title: '书' }, stamp: { t: 1, d: 'dev-A' } }, reading: { 'dev-A': 5 } } },
  })
  const b = makeDoc('dev_B')
  for (const doc of [a, b]) {
    const res = await call('PUT', `/v1/docs/${doc.deviceId}`, { token, body: doc })
    assert.equal(res.status, 204)
    assert.equal(res.headers.get('access-control-allow-origin'), '*')
  }
  // 覆盖写
  const a2 = { ...a, writtenAt: a.writtenAt + 1 }
  assert.equal((await call('PUT', '/v1/docs/dev-A', { token, body: a2 })).status, 204)

  const got = await jsonOf(await call('GET', '/v1/docs', { token }))
  const byId = Object.fromEntries(got.docs.map(d => [d.deviceId, d]))
  assert.equal(got.docs.length, 2)
  assert.deepEqual(byId['dev-A'], a2)
  assert.deepEqual(byId['dev_B'], b)

  // 另一个账号看不到
  const other = await login('other@example.com')
  assert.deepEqual(await jsonOf(await call('GET', '/v1/docs', { token: other.token })), { docs: [] })

  const expect400 = async (path, body, raw) => {
    const res = await call('PUT', path, { token, body, raw })
    assert.equal(res.status, 400, path)
    assert.deepEqual(await jsonOf(res), { error: 'invalid_doc' })
  }
  await expect400('/v1/docs/dev-A', makeDoc('dev-B'))
  await expect400('/v1/docs/dev-A', { ...makeDoc('dev-A'), format: 2 })
  await expect400('/v1/docs/dev-A', { ...makeDoc('dev-A'), books: [] })
  await expect400('/v1/docs/dev-A', { ...makeDoc('dev-A'), sources: undefined })
  await expect400('/v1/docs/dev-A', '{not json', true)
  await expect400('/v1/docs/bad.id', makeDoc('bad.id'))
  await expect400(`/v1/docs/${'x'.repeat(65)}`, makeDoc('x'.repeat(65)))

  const big = JSON.stringify(makeDoc('dev-A', { pad: 'x'.repeat(8 * 1024 * 1024) }))
  const tooLarge = await call('PUT', '/v1/docs/dev-A', { token, body: big, raw: true })
  assert.equal(tooLarge.status, 413)
  assert.deepEqual(await jsonOf(tooLarge), { error: 'too_large' })
  // 超限的写入不落盘
  const stored = await jsonOf(await call('GET', '/v1/docs', { token }))
  assert.equal(stored.docs.find(d => d.deviceId === 'dev-A').pad, undefined)

  // 未登录
  assert.equal((await call('PUT', '/v1/docs/dev-A', { body: a })).status, 401)
  assert.equal((await call('GET', '/v1/docs')).status, 401)
})

test('登出吊销当前 token, 其它会话不受影响', async () => {
  const s1 = await login('logout@example.com')
  const s2 = await login('logout@example.com')
  const res = await call('POST', '/v1/auth/logout', { token: s1.token })
  assert.equal(res.status, 204)
  assert.equal((await call('GET', '/v1/me', { token: s1.token })).status, 401)
  assert.equal((await call('POST', '/v1/auth/logout', { token: s1.token })).status, 401)
  assert.equal((await call('GET', '/v1/me', { token: s2.token })).status, 200)
})

test('DELETE /v1/me: 删除文档、会话、账号; 再登录是全新账号', async () => {
  const email = 'bye@example.com'
  const s1 = await login(email)
  const s2 = await login(email)
  for (const id of ['d1', 'd2']) {
    assert.equal((await call('PUT', `/v1/docs/${id}`, { token: s1.token, body: makeDoc(id) })).status, 204)
  }
  const del = await call('DELETE', '/v1/me', { token: s1.token })
  assert.equal(del.status, 204)
  assert.equal((await call('GET', '/v1/me', { token: s1.token })).status, 401)
  assert.equal((await call('GET', '/v1/docs', { token: s2.token })).status, 401)

  // R2 里确实没有了
  const env = await server.getWorker().getEnv()
  const left = await env.DOCS.list({ prefix: `u/${s1.account.id}/` })
  assert.equal(left.objects.length, 0)

  const fresh = await login(email)
  assert.notEqual(fresh.account.id, s1.account.id)
  assert.deepEqual(await jsonOf(await call('GET', '/v1/docs', { token: fresh.token })), { docs: [] })
})

test('发码限流: 同一邮箱每天 10 次, 同一 IP 每天 30 次', async () => {
  const env = await server.getWorker().getEnv()
  const day = new Date().toISOString().slice(0, 10)
  // 直接把计数推到上限, 不用真等 60 秒窗口
  await env.DB.prepare("INSERT INTO counters(key, day, count) VALUES(?1, ?2, 10)")
    .bind('code:email:limit@example.com', day)
    .run()
  const byEmail = await call('POST', '/v1/auth/code', { body: { email: 'limit@example.com' } })
  assert.equal(byEmail.status, 429)
  const body = await jsonOf(byEmail)
  assert.equal(body.error, 'rate_limited')
  assert.ok(body.retryAfter > 0 && body.retryAfter <= 86400)

  await env.DB.prepare("INSERT INTO counters(key, day, count) VALUES(?1, ?2, 30)")
    .bind('code:ip:192.0.2.1', day)
    .run()
  const byIp = await call('POST', '/v1/auth/code', {
    body: { email: 'fresh-ip@example.com' },
    headers: { 'cf-connecting-ip': '192.0.2.1' },
  })
  assert.equal(byIp.status, 429)
  assert.equal((await jsonOf(byIp)).error, 'rate_limited')
})

test('同步限流: 每账号每天 PUT 2000 次', async () => {
  const { token, account } = await login('puts@example.com')
  const env = await server.getWorker().getEnv()
  const day = new Date().toISOString().slice(0, 10)
  await env.DB.prepare("INSERT INTO counters(key, day, count) VALUES(?1, ?2, 2000)")
    .bind(`put:${account.id}`, day)
    .run()
  const res = await call('PUT', '/v1/docs/dev', { token, body: makeDoc('dev') })
  assert.equal(res.status, 429)
  assert.equal((await jsonOf(res)).error, 'rate_limited')
})

test('定时清理: 删过期验证码与两天前的计数', async () => {
  const env = await server.getWorker().getEnv()
  await env.DB.batch([
    env.DB.prepare("INSERT INTO codes(email, code_hash, expires_at, attempts, sent_at) VALUES('old@example.com', 'x', 1, 0, 1)"),
    env.DB.prepare("INSERT INTO counters(key, day, count) VALUES('code:ip:old', '2000-01-01', 1)"),
  ])
  const res = await server.getWorker().scheduled({ cron: '17 3 * * *', scheduledTime: new Date() })
  assert.equal(res.outcome, 'ok')
  assert.equal(await env.DB.prepare("SELECT 1 FROM codes WHERE email = 'old@example.com'").first(), null)
  assert.equal(await env.DB.prepare("SELECT 1 FROM counters WHERE day = '2000-01-01'").first(), null)
  // 今天的计数保留
  const kept = await env.DB.prepare('SELECT COUNT(*) AS n FROM counters WHERE day = ?1')
    .bind(new Date().toISOString().slice(0, 10))
    .first()
  assert.ok(kept.n > 0)
})

// 本地 .dev.vars 会被 wrangler 读入 (会打开 DEV_EXPOSE_CODE), 此时这条断言不代表生产配置, 跳过
const hasDevVars = existsSync(new URL('../.dev.vars', import.meta.url))

test('默认配置 (未开 DEV_EXPOSE_CODE, 无 RESEND_API_KEY): 不泄露验证码, 502 email_failed, 可立即重试', { skip: hasDevVars && '存在 .dev.vars' }, async () => {
  const prod = createTestHarness({ root, workers: [{ configPath: './wrangler.jsonc' }] })
  try {
    await prod.listen()
    const env = await prod.getWorker().getEnv()
    assert.equal(env.DEV_EXPOSE_CODE, undefined)
    const sql = await readFile(new URL('../schema.sql', import.meta.url), 'utf8')
    await env.DB.batch(sql.replace(/--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean).map(s => env.DB.prepare(s)))
    for (let i = 0; i < 2; i++) {
      const res = await prod.fetch(BASE + '/v1/auth/code', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'prod@example.com' }),
      })
      assert.equal(res.status, 502)
      assert.deepEqual(await jsonOf(res), { error: 'email_failed' })
    }
  } finally {
    await prod.close()
  }
})

// ---- 匿名使用统计 ----

const pingBody = (over = {}) => ({
  id: randomUUID(),
  platform: 'windows',
  version: '1.8.0',
  lang: 'zh',
  reader: false,
  ...over,
})

const admin = (path, token = ADMIN_TOKEN) =>
  call('GET', path, { headers: token === null ? {} : { authorization: `Bearer ${token}` } })

test('北京日切分: UTC 16:00 起算第二天', () => {
  assert.equal(beijingDay(Date.UTC(2026, 9, 4, 15, 59, 59)), '2026-10-04')
  assert.equal(beijingDay(Date.UTC(2026, 9, 4, 16, 0, 0)), '2026-10-05')
  assert.equal(beijingDay(Date.UTC(2026, 11, 31, 16, 30)), '2027-01-01')
  assert.equal(addDays('2026-03-01', -1), '2026-02-28')
  assert.equal(addDays('2026-12-31', 1), '2027-01-01')
})

test('心跳: 合法 → 204 带 CORS; 预检放行; 严格校验, 多余字段忽略', async () => {
  const pre = await call('OPTIONS', '/v1/ping', {
    headers: { origin: 'https://app.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
  })
  assert.equal(pre.status, 204)
  assert.equal(pre.headers.get('access-control-allow-origin'), '*')
  assert.match(pre.headers.get('access-control-allow-headers'), /content-type/)
  assert.match(pre.headers.get('access-control-allow-methods'), /POST/)

  const ok = await call('POST', '/v1/ping', { body: pingBody({ extra: 'x', email: 'a@b.c' }) })
  assert.equal(ok.status, 204)
  assert.equal(ok.headers.get('access-control-allow-origin'), '*')

  const bad = [
    {},
    pingBody({ id: undefined }),
    pingBody({ id: 'not-a-uuid' }),
    pingBody({ id: '6ba7b810-9dad-11d1-80b4-00c04fd430c8' }), // v1
    pingBody({ id: 123 }),
    pingBody({ platform: 'beos' }),
    pingBody({ platform: 'Windows' }),
    pingBody({ version: '1.2' }),
    pingBody({ version: '1.2.3-beta' }),
    pingBody({ version: 'v1.2.3' }),
    pingBody({ version: '01.2.3' }),
    pingBody({ version: 1 }),
    pingBody({ lang: 'fr' }),
    pingBody({ lang: undefined }),
    pingBody({ reader: 'true' }),
    pingBody({ reader: 1 }),
    pingBody({ reader: undefined }),
    [pingBody()],
    null,
    'ping',
  ]
  for (const body of bad) {
    const res = await call('POST', '/v1/ping', { body })
    assert.equal(res.status, 400, JSON.stringify(body))
    assert.deepEqual(await jsonOf(res), { error: 'invalid_ping' })
  }
  const notJson = await call('POST', '/v1/ping', { body: '{oops', raw: true })
  assert.equal(notJson.status, 400)
  const tooBig = await call('POST', '/v1/ping', { body: pingBody({ pad: 'x'.repeat(2000) }) })
  assert.equal(tooBig.status, 400)
  assert.equal((await call('GET', '/v1/ping')).status, 404)

  // 表里只有约定的列, 没有 IP / UA
  const env = await server.getWorker().getEnv()
  const cols = async table =>
    (await env.DB.prepare(`PRAGMA table_info(${table})`).all()).results.map(r => r.name).sort()
  assert.deepEqual(await cols('pings'), ['day', 'install_id', 'lang', 'platform', 'reader', 'version'])
  assert.deepEqual(await cols('installs'), ['first_day', 'install_id', 'last_day', 'platform', 'version'])
})

test('心跳: 同一安装同一天一行; reader 取或; 平台 / 版本取最新; 按北京日入库', async () => {
  const env = await server.getWorker().getEnv()
  const id = randomUUID()
  const before = beijingDay()
  for (const [over, status] of [
    [{ reader: false, version: '1.7.0', platform: 'android' }, 204],
    [{ reader: true, version: '1.7.0', platform: 'android' }, 204],
    [{ reader: false, version: '1.8.0', platform: 'android', lang: 'en' }, 204],
  ]) {
    // 大写 UUID 也接受, 统一存小写
    const res = await call('POST', '/v1/ping', { body: pingBody({ id: id.toUpperCase(), ...over }) })
    assert.equal(res.status, status)
  }
  const after = beijingDay()
  const rows = (await env.DB.prepare('SELECT * FROM pings WHERE install_id = ?1').bind(id).all()).results
  assert.equal(rows.length, 1)
  const row = rows[0]
  assert.ok([before, after].includes(row.day), `day ${row.day}`)
  assert.equal(row.reader, 1)
  assert.equal(row.version, '1.8.0')
  assert.equal(row.lang, 'en')
  const inst = await env.DB.prepare('SELECT * FROM installs WHERE install_id = ?1').bind(id).first()
  assert.equal(inst.first_day, row.day)
  assert.equal(inst.last_day, row.day)
  assert.equal(inst.version, '1.8.0')
  assert.equal(inst.platform, 'android')
})

test('心跳限流: 每个 IP 每天 120 次; 限流键不含原始 IP', async () => {
  const env = await server.getWorker().getEnv()
  const ip = '203.0.113.77'
  const keysBefore = new Set(
    (await env.DB.prepare("SELECT key FROM counters WHERE key LIKE 'ping:%'").all()).results.map(r => r.key),
  )
  assert.equal((await call('POST', '/v1/ping', { body: pingBody(), headers: { 'cf-connecting-ip': ip } })).status, 204)
  const fresh = (await env.DB.prepare("SELECT key, day, count FROM counters WHERE key LIKE 'ping:%'").all()).results.filter(
    r => !keysBefore.has(r.key),
  )
  assert.equal(fresh.length, 1)
  assert.match(fresh[0].key, /^ping:[0-9a-f]{32}$/)
  assert.equal(fresh[0].count, 1)
  const all = (await env.DB.prepare('SELECT key FROM counters').all()).results
  assert.ok(!all.some(r => r.key.includes(ip)))

  await env.DB.prepare('UPDATE counters SET count = 120 WHERE key = ?1 AND day = ?2').bind(fresh[0].key, fresh[0].day).run()
  const limited = await call('POST', '/v1/ping', { body: pingBody(), headers: { 'cf-connecting-ip': ip } })
  assert.equal(limited.status, 429)
  const body = await jsonOf(limited)
  assert.equal(body.error, 'rate_limited')
  assert.ok(body.retryAfter > 0 && body.retryAfter <= 86400)
  // 非法请求不计数, 其它 IP 不受影响
  assert.equal((await call('POST', '/v1/ping', { body: pingBody(), headers: { 'cf-connecting-ip': '203.0.113.78' } })).status, 204)
})

test('统计接口鉴权: 无令牌 / 错令牌 → 401; days 越界 → 400; /admin 返回统计页', async () => {
  for (const token of [null, 'wrong-token', ADMIN_TOKEN + 'x', '']) {
    const res = await admin('/v1/admin/stats', token)
    assert.equal(res.status, 401, String(token))
    assert.deepEqual(await jsonOf(res), { error: 'unauthorized' })
  }
  const basic = await call('GET', '/v1/admin/stats', { headers: { authorization: `Basic ${ADMIN_TOKEN}` } })
  assert.equal(basic.status, 401)
  const ok = await admin('/v1/admin/stats')
  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get('cache-control'), 'no-store')
  for (const d of ['0', '366', 'abc', '-1', '7.5']) {
    assert.equal((await admin(`/v1/admin/stats?days=${d}`)).status, 400, d)
  }
  const page = await call('GET', '/admin')
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-type'), /text\/html/)
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/)
  const html = await page.text()
  assert.match(html, /轻阅使用统计/)
  assert.match(html, /数据只含随机安装 ID、平台、版本、语言/)
  assert.doesNotMatch(html, /<script[^>]+src=/)
})

/** 清空统计表并写入一组相对今天 (北京日) 的固定数据 */
async function seedStats(env, T) {
  await env.DB.batch(['pings', 'installs', 'ping_daily'].map(t => env.DB.prepare(`DELETE FROM ${t}`)))
  const A = randomUUID(), B = randomUUID(), C = randomUUID(), D = randomUUID()
  const ins = (id, first, last, platform, version) =>
    env.DB.prepare('INSERT INTO installs VALUES(?1, ?2, ?3, ?4, ?5)').bind(id, first, last, platform, version)
  const p = (day, id, platform, version, reader = 0, lang = 'zh') =>
    env.DB.prepare('INSERT INTO pings VALUES(?1, ?2, ?3, ?4, ?5, ?6)').bind(day, id, platform, version, lang, reader)
  await env.DB.batch([
    ins(A, addDays(T, -8), addDays(T, -1), 'windows', '1.7.0'),
    ins(B, addDays(T, -8), addDays(T, -8), 'android', '1.6.0'),
    ins(C, addDays(T, -1), addDays(T, -1), 'android', '1.7.0'),
    ins(D, addDays(T, -100), addDays(T, -40), 'linux', '1.0.0'),
    p(addDays(T, -8), A, 'windows', '1.7.0'),
    p(addDays(T, -7), A, 'windows', '1.7.0', 1),
    p(addDays(T, -1), A, 'windows', '1.7.0', 0, 'en'),
    p(addDays(T, -8), B, 'android', '1.6.0'),
    p(addDays(T, -1), C, 'android', '1.7.0'),
    p(addDays(T, -40), D, 'linux', '1.0.0'),
  ])
  return { A, B, C, D }
}

test('统计: 装机 / 日活 / 周活 / 月活 / 黏性 / 每日序列 / 分布 / 留存', async () => {
  const env = await server.getWorker().getEnv()
  const T = beijingDay()
  const { C } = await seedStats(env, T)
  // 今天: C 再次出现 (打开了阅读器, 升级到 1.8.0), E 首次出现
  assert.equal((await call('POST', '/v1/ping', { body: pingBody({ id: C, platform: 'android', version: '1.8.0', reader: true }) })).status, 204)
  assert.equal((await call('POST', '/v1/ping', { body: pingBody({ platform: 'web', version: '1.8.0' }) })).status, 204)

  const s = await jsonOf(await admin('/v1/admin/stats'))
  assert.equal(s.today, T)
  assert.equal(s.timezone, 'Asia/Shanghai')
  assert.equal(s.days, 30)
  assert.match(s.note, /安装/)
  assert.deepEqual(s.totals, { installs: 5, newToday: 1, new7d: 2, new30d: 4 })
  assert.deepEqual(s.active, { dau: 2, dauYesterday: 2, wau: 3, mau: 4, avgDau30: 0.6, stickiness: 0.1563 })

  assert.equal(s.daily.length, 30)
  assert.equal(s.daily[0].day, addDays(T, -29))
  assert.equal(s.daily.at(-1).day, T)
  const at = k => s.daily.find(d => d.day === addDays(T, k))
  assert.deepEqual(at(-8), { day: addDays(T, -8), actives: 2, readers: 0, newInstalls: 2 })
  assert.deepEqual(at(-7), { day: addDays(T, -7), actives: 1, readers: 1, newInstalls: 0 })
  assert.deepEqual(at(-1), { day: addDays(T, -1), actives: 2, readers: 0, newInstalls: 1 })
  assert.deepEqual(at(0), { day: T, actives: 2, readers: 1, newInstalls: 1 })
  assert.deepEqual(at(-2), { day: addDays(T, -2), actives: 0, readers: 0, newInstalls: 0 })

  assert.equal(s.platforms[0].name, 'android')
  assert.deepEqual(Object.fromEntries(s.platforms.map(p => [p.name, p.installs])), { android: 2, web: 1, windows: 1 })
  assert.deepEqual(s.versions, [{ name: '1.8.0', installs: 2 }, { name: '1.7.0', installs: 1 }])
  assert.deepEqual(
    Object.fromEntries(s.langs.map(l => [l.name, l.installs])),
    { zh: 3, en: 1 }, // A 最近一天是 en
  )

  const r = s.retention
  assert.deepEqual(r.d1, { rate: 0.5, cohortSize: 2 })
  assert.deepEqual(r.d7, { rate: 0.5, cohortSize: 2 })
  assert.deepEqual(r.d30, { rate: null, cohortSize: 0 })
  assert.deepEqual(r.cohorts, [
    { day: addDays(T, -1), size: 1, d1n: null, d7n: null, d30n: null, d1: null, d7: null, d30: null },
    { day: addDays(T, -8), size: 2, d1n: 1, d7n: 1, d30n: null, d1: 0.5, d7: 0.5, d30: null },
  ])

  // 90 天视图能看到 40 天前的那次活跃
  const s90 = await jsonOf(await admin('/v1/admin/stats?days=90'))
  assert.equal(s90.daily.length, 90)
  assert.equal(s90.daily.find(d => d.day === addDays(T, -40)).actives, 1)
})

test('定时任务: 90 天前的心跳聚合进 ping_daily 后删除, installs 保留, 统计仍可见', async () => {
  const env = await server.getWorker().getEnv()
  const T = beijingDay()
  const { A, B, D } = await seedStats(env, T)
  const old = addDays(T, -95)
  await env.DB.batch([
    env.DB.prepare('UPDATE installs SET first_day = ?1 WHERE install_id = ?2').bind(old, A),
    env.DB.prepare('INSERT INTO pings VALUES(?1, ?2, ?3, ?4, ?5, ?6)').bind(old, A, 'windows', '1.5.0', 'zh', 1),
    env.DB.prepare('INSERT INTO pings VALUES(?1, ?2, ?3, ?4, ?5, ?6)').bind(old, B, 'windows', '1.5.0', 'zh', 0),
    env.DB.prepare('INSERT INTO pings VALUES(?1, ?2, ?3, ?4, ?5, ?6)').bind(old, D, 'linux', '1.0.0', 'en', 0),
    env.DB.prepare('INSERT INTO pings VALUES(?1, ?2, ?3, ?4, ?5, ?6)').bind(addDays(T, -91), D, 'linux', '1.0.0', 'en', 0),
    env.DB.prepare('INSERT INTO pings VALUES(?1, ?2, ?3, ?4, ?5, ?6)').bind(addDays(T, -90), D, 'linux', '1.0.0', 'en', 0),
  ])
  const res = await server.getWorker().scheduled({ cron: '17 3 * * *', scheduledTime: new Date() })
  assert.equal(res.outcome, 'ok')

  const daily = (await env.DB.prepare('SELECT * FROM ping_daily ORDER BY day, platform').all()).results
  assert.deepEqual(daily, [
    { day: old, platform: 'linux', version: '1.0.0', actives: 1, readers: 0, new_installs: 0 },
    { day: old, platform: 'windows', version: '1.5.0', actives: 2, readers: 1, new_installs: 1 },
    { day: addDays(T, -91), platform: 'linux', version: '1.0.0', actives: 1, readers: 0, new_installs: 0 },
  ])
  const left = await env.DB.prepare('SELECT MIN(day) AS d FROM pings').first()
  assert.equal(left.d, addDays(T, -90)) // 正好 90 天前的保留
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM installs').first()).n, 4)

  // 重跑不重复累计
  await server.getWorker().scheduled({ cron: '17 3 * * *', scheduledTime: new Date() })
  assert.equal((await env.DB.prepare('SELECT SUM(actives) AS n FROM ping_daily').first()).n, 4)

  const s = await jsonOf(await admin('/v1/admin/stats?days=120'))
  assert.deepEqual(
    s.daily.find(d => d.day === old),
    { day: old, actives: 3, readers: 1, newInstalls: 1 },
  )
})
