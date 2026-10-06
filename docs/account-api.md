# 轻阅账号 API（sync.jiangshu.ai）

可选账号，用于多端同步。只存同步记录（`SyncDoc`，见 `docs/sync.md`），**不存书籍文件**；书文件仍走用户自己的 WebDAV，或在各设备导入同一本书时按内容指纹自动匹配。

- 服务：Cloudflare Worker，源码 `sync-server/`，域名 `https://sync.jiangshu.ai`
- 存储：D1 `lightread-sync`（账号、验证码、会话、限流）+ R2 `lightread-sync`（各设备的 SyncDoc，键 `u/<userId>/devices/<deviceId>.json`；D1 单行 2MB 放不下大文档）
- 登录：邮箱验证码（Resend，发件人 `轻阅 LightRead <noreply@jiangshu.ai>`），6 位数字，10 分钟有效，每个验证码最多试 5 次
- 鉴权：`Authorization: Bearer <token>`；token 为 32 字节随机数的 base64url，服务端只存 SHA-256；登出即吊销，不设过期
- CORS：`Access-Control-Allow-Origin: *`（纯 Bearer，无 Cookie），允许 `authorization, content-type`，方法 `GET, POST, PUT, DELETE, OPTIONS`
- 错误统一为 JSON `{ "error": "<code>", "retryAfter"?: 秒 }`

## 接口

| 方法 路径 | 请求 | 成功 | 失败 |
|---|---|---|---|
| `POST /v1/auth/code` | `{ email }` | `204` | `400 invalid_email`；`429 rate_limited`（带 `retryAfter`）；`502 email_failed` |
| `POST /v1/auth/verify` | `{ email, code, deviceName? }` | `200 { token, account: { id, email, createdAt } }`（首次验证即注册） | `400 invalid_code`（错误 / 过期 / 已用）；`429 too_many_attempts` |
| `GET /v1/me` | — | `200 { account }` | `401 unauthorized` |
| `POST /v1/auth/logout` | — | `204`（吊销当前 token） | `401` |
| `DELETE /v1/me` | — | `204`（删除账号、全部会话、全部同步文档） | `401` |
| `GET /v1/docs` | — | `200 { docs: SyncDoc[] }`（该账号所有设备的文档） | `401` |
| `PUT /v1/docs/:deviceId` | `SyncDoc`（JSON，`deviceId` 须与路径一致，`format === 1`） | `204` | `400 invalid_doc`；`413 too_large`（> 8MB）；`401` |
| `GET /health` | — | `200 { ok: true }` | — |
| `PROPFIND/GET/HEAD/PUT/DELETE/MKCOL /v1/webdav/:provider/*` | 原样转发（`Authorization: Basic …`） | 上游状态码与响应体 | `404 not_found`（未知服务商）；`401 unauthorized`（无 Basic 鉴权，不带 `WWW-Authenticate`）；`400 invalid_path`；`405` |

`deviceId` 限 `[A-Za-z0-9_-]{1,64}`。邮箱统一 trim + 小写。

### WebDAV 中转（仅网页版）

坚果云、Koofr 的 WebDAV 不支持浏览器跨域（CORS 预检直接 401），网页版经 `/v1/webdav/<provider>/<路径>` 转发：`jianguoyun → https://dav.jianguoyun.com/dav/`，`koofr → https://app.koofr.net/dav/Koofr/`。只转发到这两个固定地址（不是开放代理），不存储、不记录账号密码与内容；去掉上游的 `WWW-Authenticate`，避免浏览器弹出原生登录框。客户端在 `src/services/net.ts` 里按地址改写（`webdavRelayUrl`），桌面 / 安卓走原生请求直连。

## 限流（按 UTC 日计数）

- 发验证码：同一邮箱 60 秒内 1 次、每天 10 次；同一 IP 每天 30 次
- 验证：每个验证码 5 次，超出作废
- 同步：每个账号每天 `PUT /v1/docs` 2000 次（自动同步每 5 分钟一次，一台设备一天 288 次）
- 统计心跳：每个 IP 每个**北京日** 120 次（见「匿名使用统计」）

## 数据库

```sql
users    (id TEXT PK, email TEXT UNIQUE, created_at INTEGER)
codes    (email TEXT PK, code_hash TEXT, expires_at INTEGER, attempts INTEGER, sent_at INTEGER)
sessions (token_hash TEXT PK, user_id TEXT, device_name TEXT, created_at INTEGER, last_seen_at INTEGER)
counters (key TEXT, day TEXT, count INTEGER, PK(key, day))
-- 匿名使用统计 (day 为北京时间日期)
pings      (day TEXT, install_id TEXT, platform TEXT, version TEXT, lang TEXT, reader INTEGER, PK(day, install_id))
installs   (install_id TEXT PK, first_day TEXT, last_day TEXT, platform TEXT, version TEXT)
ping_daily (day TEXT, platform TEXT, version TEXT, actives INTEGER, readers INTEGER, new_installs INTEGER, PK(day, platform, version))
```

## 匿名使用统计

应用每天最多上报两次匿名心跳（打开应用一次；当天第一次打开书再一次），用于装机量、日活 / 月活、留存。方案与隐私边界见 [`usage-stats-plan.md`](usage-stats-plan.md)。实现：`sync-server/src/stats.ts`。

| 方法 路径 | 请求 | 成功 | 失败 |
|-----------|------|------|------|
| `POST /v1/ping` | `{ id, platform, version, lang, reader }`（见下） | `204` | `400 invalid_ping`；`429 rate_limited`（`retryAfter` 为到北京时间零点的秒数） |
| `GET /v1/admin/stats?days=30` | `Authorization: Bearer <ADMIN_TOKEN>`；`days` 1–365，默认 30 | `200` 统计 JSON（`cache-control: no-store`） | `401 unauthorized`（无 / 错令牌，或服务端未设 `ADMIN_TOKEN`）；`400 invalid_days` |
| `GET /admin` | — | 自包含的统计页（HTML，无外部脚本，CSP `default-src 'none'`） | — |

心跳请求体（≤1 KB，严格校验，多余字段忽略不存，CORS 对所有来源开放）：

- `id`：客户端生成的随机 UUID v4（大小写均可，存小写）
- `platform`：`windows | macos | linux | android | ios | web | other`
- `version`：`x.y.z`（纯数字 semver，无前缀 / 预发布后缀）
- `lang`：`zh | en`
- `reader`：布尔，当天是否打开过阅读器

服务端按**北京时间**（Asia/Shanghai）切天：`pings` 每个安装每天一行，`reader` 取「或」（一旦为真当天保持），平台 / 版本 / 语言取最新；`installs` 记首次 / 最近出现日。**不存 IP、UA 或其它任何字段**；Worker 关闭了调用日志（`observability.logs.invocation_logs = false`），Cloudflare 侧也不留请求头。

限流：每个 IP 每个北京日 120 次心跳（客户端每天至多 2 次，相当于约 60 个安装共用一个出口 IP）。计数键是 `ping:<HMAC-SHA256(ADMIN_TOKEN, 日期|IP) 前 32 位十六进制>`，不含原始 IP，两天后由定时任务删除。

保留：每天 UTC 03:17 的定时任务把 90 天前的 `pings` 按（天, 平台, 版本）聚合进 `ping_daily` 后删除；`installs` 长期保留（只有随机 ID，装机量与新增依赖它）。

统计 JSON（字段均以「安装」计，不是人）：

```jsonc
{
  "generatedAt": "…", "timezone": "Asia/Shanghai", "today": "2026-10-05", "days": 30,
  "note": "统计的是安装（随机安装 ID），不是人…",
  "totals":  { "installs": 0, "newToday": 0, "new7d": 0, "new30d": 0 },
  "active":  { "dau": 0, "dauYesterday": 0, "wau": 0, "mau": 0, "avgDau30": 0, "stickiness": 0.25 },
  "daily":   [{ "day": "2026-09-06", "actives": 0, "readers": 0, "newInstalls": 0 }],   // days 天, 旧到新
  "platforms": [{ "name": "android", "installs": 0 }],   // 按月活 (最近 30 天出现过), 最新平台
  "versions":  [{ "name": "1.8.0", "installs": 0 }],     // 近 7 天活跃, 最新版本
  "langs":     [{ "name": "zh", "installs": 0 }],        // 按月活
  "retention": {
    "d1": { "rate": 0.35, "cohortSize": 120 }, "d7": { … }, "d30": { … },   // 已到期群组按人数加权
    "cohorts": [{ "day": "2026-10-04", "size": 3, "d1n": 1, "d7n": null, "d30n": null, "d1": 0.3333, "d7": null, "d30": null }]
  }
}
```

- 日活 / 周活 / 月活：截至今天（北京时间）最近 1 / 7 / 30 天出现过的安装数；今天的日活随上报累积，`dauYesterday` 是完整的一天
- 黏性 `stickiness` = 近 30 天平均日活 / 月活；平均日活只算今天之前的完整日子，并从开始有数据的那天算起
- 留存：按 `installs.first_day` 分组（最近 40 天的群组，新到旧），`dN` 为第 N 天当天回来的比例；第 N 天还没过完的为 `null`
- 每日序列 90 天内来自 `pings`，更早的来自 `ping_daily`；新增来自 `installs`
- 上线前已有的用户会在第一次上报那天计为新增

管理员令牌是 Worker secret `ADMIN_TOKEN`，本机备份在 `~/.config/lightread/stats-admin-token`（600）。轮换：生成新值写入该文件，再 `tr -d '\n' < ~/.config/lightread/stats-admin-token | npx wrangler secret put ADMIN_TOKEN -c wrangler.jsonc`。查看：浏览器打开 <https://sync.jiangshu.ai/admin>（首次输入令牌，只存在该浏览器的 localStorage），或在仓库里 `npm run stats`（`-- --days 90`、`-- --json`）。

## 客户端

- `src/services/account.ts`：登录状态（localStorage `lightread-account`）与上述接口的封装
- `src/services/sync/accountRemote.ts`：实现 `SyncRemote`，`kind = 'account'`，`supportsFiles = false`，`id = account:<userId>`
- 同步时依次对「账号」和「WebDAV」各跑一次同步（两者都配置时），两边都是同一套 CRDT 文档，可同时使用。**基线全设备共用一份**（记录同步过的远端列表）：分远端存基线会把从 A 远端收到的改动当成本地新编辑推到 B 远端，导致阅读时长重复累计、较新的编辑被旧值覆盖；只有换到同类的另一个远端（另一个账号 / 另一个 WebDAV 地址）才按首次同步处理，见 `src/services/sync/baseline.ts`
- 登录成功后自动打开「自动同步」
- 设置随同步：文档里的可选字段 `settings`（见 `docs/sync.md`「设置同步」）。服务端不解析、原样存储；登录后先同步账号，账号带来的 WebDAV 配置在同一次同步里就能用上。开启「同步密码与密钥」时 WebDAV 密码、AI API Key 也在文档里，以明文存在 R2（只有本账号的 Bearer token 能读）
- 私人书库 / 自定义书源随同步：文档的 `sources` 字段（见 `docs/sync.md`「私人书库（自定义书源）」），**始终**包含 OPDS 账号密码（不受「同步密码与密钥」开关控制），同样以明文存在 R2、只有本账号能读。服务端只校验 `sources` 是对象，不解析内容，键的规范化与修改时间都在客户端，后端与 D1 无需改动
- API 地址默认 `https://sync.jiangshu.ai`，可用构建变量 `VITE_SYNC_API` 或 localStorage `lightread-sync-api` 覆盖（仅用于本地测试）
