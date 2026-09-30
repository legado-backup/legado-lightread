# 轻阅账号 / 多端同步后端

Cloudflare Worker（`https://sync.jiangshu.ai`）：邮箱验证码登录 + 按设备存取同步文档（`SyncDoc`）。只存同步记录，**不存书籍文件**。接口约定见 [`docs/account-api.md`](../docs/account-api.md)，文档格式见 [`docs/sync.md`](../docs/sync.md)。

- D1 `lightread-sync`：账号、验证码、会话、按 UTC 日的限流计数（`schema.sql`）
- R2 `lightread-sync`：每台设备的文档，键 `u/<userId>/devices/<deviceId>.json`
- 发信：Resend REST API，发件人见 `wrangler.jsonc` 的 `MAIL_FROM`
- 每天 UTC 03:17 的 Cron 清理过期验证码与两天前的计数

## 部署

仓库根目录的 `.wrangler/deploy/config.json`（网页版构建产物）会干扰 wrangler 找配置，所以在本目录下的命令一律带 `-c wrangler.jsonc`。wrangler 用根目录 `node_modules` 里的那份（本目录不要建 `package.json`，否则 `npx` 找不到它）。

```bash
cd sync-server
npx wrangler login                                     # 首次, 浏览器授权
npx wrangler d1 create lightread-sync                  # 把输出的 database_id 填进 wrangler.jsonc (已填则跳过)
npx wrangler d1 execute lightread-sync -c wrangler.jsonc --remote --file schema.sql   # 建表 (幂等, 可重跑)
npx wrangler r2 bucket create lightread-sync           # 已建则跳过
npx wrangler secret put RESEND_API_KEY -c wrangler.jsonc   # 粘贴 Resend API Key
npx wrangler deploy -c wrangler.jsonc                  # 同时绑定自定义域名 sync.jiangshu.ai
```

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
