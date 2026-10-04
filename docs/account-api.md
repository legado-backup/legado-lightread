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

## 数据库

```sql
users    (id TEXT PK, email TEXT UNIQUE, created_at INTEGER)
codes    (email TEXT PK, code_hash TEXT, expires_at INTEGER, attempts INTEGER, sent_at INTEGER)
sessions (token_hash TEXT PK, user_id TEXT, device_name TEXT, created_at INTEGER, last_seen_at INTEGER)
counters (key TEXT, day TEXT, count INTEGER, PK(key, day))
```

## 客户端

- `src/services/account.ts`：登录状态（localStorage `lightread-account`）与上述接口的封装
- `src/services/sync/accountRemote.ts`：实现 `SyncRemote`，`kind = 'account'`，`supportsFiles = false`，`id = account:<userId>`
- 同步时依次对「账号」和「WebDAV」各跑一次同步（两者都配置时），两边都是同一套 CRDT 文档，可同时使用。**基线全设备共用一份**（记录同步过的远端列表）：分远端存基线会把从 A 远端收到的改动当成本地新编辑推到 B 远端，导致阅读时长重复累计、较新的编辑被旧值覆盖；只有换到同类的另一个远端（另一个账号 / 另一个 WebDAV 地址）才按首次同步处理，见 `src/services/sync/baseline.ts`
- 登录成功后自动打开「自动同步」
- API 地址默认 `https://sync.jiangshu.ai`，可用构建变量 `VITE_SYNC_API` 或 localStorage `lightread-sync-api` 覆盖（仅用于本地测试）
