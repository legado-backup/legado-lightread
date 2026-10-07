# 轻阅账号 / 多端同步后端

Cloudflare Worker（`https://sync.jiangshu.ai`）：邮箱验证码登录 + 按设备存取同步文档（`SyncDoc`）+ 互传。同步只存同步记录，不长期存书籍文件；互传的文件临时存（账号 7 天、取件码 ≤ 1 小时）。接口约定见 [`docs/account-api.md`](../docs/account-api.md)，文档格式见 [`docs/sync.md`](../docs/sync.md)。

- D1 `lightread-sync`：账号、验证码、会话、按 UTC 日的限流计数（`schema.sql`）
- R2 `lightread-sync`：每台设备的文档，键 `u/<userId>/devices/<deviceId>.json`
- 发信：Resend REST API，发件人见 `wrangler.jsonc` 的 `MAIL_FROM`
- 匿名使用统计：`POST /v1/ping` 心跳、`GET /v1/admin/stats` 与 `/admin` 统计页（secret `ADMIN_TOKEN` 保护，本机备份 `~/.config/lightread/stats-admin-token`），见 `src/stats.ts` 与 account-api.md「匿名使用统计」
- 互传（`src/transfer.ts`，设计见 [`docs/device-transfer.md`](../docs/device-transfer.md)）：账号内设备间 `/v1/devices`、`/v1/transfers`（D1 `transfers` / `devices`，文件 R2 `transfer/<userId>/<id>`）；匿名取件码 `/v1/drops`、分享链接 `/d/<code>`（D1 `drops`，文件 R2 `drop/<id>`）。可选变量 `WEB_APP_URL`（网页版地址，`/d/<code>` 据此 302；不写进 `wrangler.jsonc`）
- 每天 UTC 03:17 的 Cron 清理过期验证码与两天前的计数，把 90 天前的统计心跳聚合进 `ping_daily`，并删除过期的互传 / 取件（连同 R2 文件）与 90 天没见过的设备登记
- 调用日志（invocation logs）已关闭，Cloudflare 不留请求头 / IP；`console.error` 等自定义日志照常

## 部署

仓库根目录的 `.wrangler/deploy/config.json`（网页版构建产物）会干扰 wrangler 找配置，所以在本目录下的命令一律带 `-c wrangler.jsonc`。wrangler 用根目录 `node_modules` 里的那份（本目录不要建 `package.json`，否则 `npx` 找不到它）。

```bash
cd sync-server
npx wrangler login                                     # 首次, 浏览器授权
npx wrangler d1 create lightread-sync                  # 把输出的 database_id 填进 wrangler.jsonc (已填则跳过)
npx wrangler d1 execute lightread-sync -c wrangler.jsonc --remote --file schema.sql   # 建表 (幂等, 可重跑)
npx wrangler r2 bucket create lightread-sync           # 已建则跳过
npx wrangler secret put RESEND_API_KEY -c wrangler.jsonc   # 粘贴 Resend API Key
tr -d '\n' < ~/.config/lightread/stats-admin-token | npx wrangler secret put ADMIN_TOKEN -c wrangler.jsonc   # 统计管理员令牌
npx wrangler deploy -c wrangler.jsonc                  # 同时绑定自定义域名 sync.jiangshu.ai
```

建表用的 `schema.sql` 是幂等的。`~/.config/tokenssh-ai/cloudflare-workers-token` 没有 D1 权限，用它部署时改表要走 Cloudflare MCP 的 D1 query API（把 `schema.sql` 里新增的 `CREATE … IF NOT EXISTS` 发过去）。

### 迁移：互传表（0001）

互传新增的三张表在 `migrations/0001_transfers.sql`（与 `schema.sql` 末尾一段相同，幂等）。**上线互传前**要先在生产库执行一次，且需用户确认后再做：

```bash
npx wrangler d1 execute lightread-sync -c wrangler.jsonc --remote --file migrations/0001_transfers.sql
```

workers token 没有 D1 权限，实际走 Cloudflare MCP 的 D1 query API，把文件里的 `CREATE … IF NOT EXISTS` 语句发过去。必须先建表、再部署 Worker：顺序反了互传接口、注销账号（`DELETE /v1/me` 会顺带删互传数据）和 Cron 里的互传清理都会出错。

之后改代码只需重跑最后一条；轮换 Key 重跑 `secret put`。验证：`curl https://sync.jiangshu.ai/health` → `{"ok":true}`。

`workers_dev` 关闭，只走自定义域名。

## 本地开发与测试

```bash
cd sync-server
cp .dev.vars.example .dev.vars                         # DEV_EXPOSE_CODE=1: 发码接口直接返回验证码, 不发邮件
npx wrangler d1 execute lightread-sync -c wrangler.jsonc --local --file schema.sql
npx wrangler dev -c wrangler.jsonc                     # http://localhost:8787, D1/R2 为本地模拟

node --test test/api.test.mjs                          # 接口契约测试 (本地 workerd, 内存 D1/R2, 不连 Cloudflare)
```

> `DEV_EXPOSE_CODE` 只能出现在本地 `.dev.vars` 或测试里，**生产 `vars` / secret 绝不能设**，否则任何人都能拿到任意邮箱的验证码。测试里有一条用 `wrangler.jsonc` 默认配置断言它关闭（本地存在 `.dev.vars` 时这条会跳过）。

客户端指向本地：localStorage `lightread-sync-api` 设为 `http://localhost:8787`（或构建变量 `VITE_SYNC_API`）。
