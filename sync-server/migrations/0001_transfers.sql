-- 迁移 0001: 互传 (transfers / devices / drops). 与 schema.sql 末尾「互传」一段相同, 幂等, 可重跑.
-- 生产: npx wrangler d1 execute lightread-sync -c wrangler.jsonc --remote --file migrations/0001_transfers.sql
--   (workers token 没有 D1 权限: 改走 Cloudflare MCP 的 D1 query API 执行本文件语句; 需用户确认后再做)

-- ---- 互传 (docs/device-transfer.md) ----
-- 文件本体在 R2: 账号互传 transfer/<accountId>/<id>, 取件码 drop/<id>. 过期行与 R2 对象由每日 Cron 删除

-- 账号内设备间的互传条目. to_device 为 NULL 表示发给本账号的全部其他设备.
-- 文件先建记录 (ready = 0, 24 小时内没传完即清理), PUT 完本体后 ready = 1, 再保留 7 天
CREATE TABLE IF NOT EXISTS transfers (
  id          TEXT    PRIMARY KEY,          -- crypto.randomUUID()
  account_id  TEXT    NOT NULL,
  from_device TEXT    NOT NULL,
  from_name   TEXT    NOT NULL DEFAULT '',
  to_device   TEXT,                         -- NULL = 全部
  kind        TEXT    NOT NULL,             -- text|link|file
  title       TEXT    NOT NULL DEFAULT '',
  text        TEXT,                         -- kind = text, ≤ 64 KB (UTF-8)
  url         TEXT,                         -- kind = link, http(s), ≤ 4096
  r2_key      TEXT,                         -- kind = file
  size        INTEGER,                      -- kind = file, 字节
  mime        TEXT,
  filename    TEXT,
  ready       INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS transfers_account_created ON transfers(account_id, created_at);
CREATE INDEX IF NOT EXISTS transfers_expires ON transfers(expires_at);

-- 互传设备登记: 设备轮询 GET /v1/transfers?device= 时写入 (同名且一小时内见过则不写); 90 天没见过即删除
CREATE TABLE IF NOT EXISTS devices (
  account_id   TEXT    NOT NULL,
  device_id    TEXT    NOT NULL,
  name         TEXT    NOT NULL DEFAULT '',
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, device_id)
);

-- 匿名临时取件码. code 只在未过期的取件里唯一 (建码时先删占着该码的过期行);
-- owner_hash = sha256(ownerToken) hex, 发送方凭 ownerToken 上传 / 撤回; account_id 仅已登录发送方有
CREATE TABLE IF NOT EXISTS drops (
  id            TEXT    PRIMARY KEY,        -- crypto.randomUUID()
  code          TEXT    NOT NULL UNIQUE,    -- 6 位数字
  account_id    TEXT,
  owner_hash    TEXT    NOT NULL,
  kind          TEXT    NOT NULL,           -- text|link|file
  title         TEXT    NOT NULL DEFAULT '',
  text          TEXT,
  url           TEXT,
  r2_key        TEXT,
  size          INTEGER,
  mime          TEXT,
  filename      TEXT,
  ready         INTEGER NOT NULL DEFAULT 1,
  downloads     INTEGER NOT NULL DEFAULT 0,
  max_downloads INTEGER NOT NULL DEFAULT 10,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL            -- 创建后 10 分钟或 1 小时
);
CREATE INDEX IF NOT EXISTS drops_expires ON drops(expires_at);
