-- 轻阅账号 / 同步: 账号、验证码、会话、限流计数. 同步文档本体在 R2 (u/<userId>/devices/<deviceId>.json)
-- 建表 (幂等): npx wrangler d1 execute lightread-sync --remote --file schema.sql
-- 时间戳一律为毫秒

CREATE TABLE IF NOT EXISTS users (
  id         TEXT    PRIMARY KEY,           -- crypto.randomUUID()
  email      TEXT    NOT NULL UNIQUE,       -- trim + 小写
  created_at INTEGER NOT NULL
);

-- 每个邮箱同一时刻只有一个有效验证码, 重发即覆盖
CREATE TABLE IF NOT EXISTS codes (
  email      TEXT    PRIMARY KEY,
  code_hash  TEXT    NOT NULL,              -- sha256(email + ':' + code) hex
  expires_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,    -- 已尝试次数, 满 5 次作废
  sent_at    INTEGER NOT NULL               -- 60 秒内不重发
);

-- token 只存 SHA-256; 登出即删行, 不设过期
CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT    PRIMARY KEY,
  user_id      TEXT    NOT NULL,
  device_name  TEXT,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions(user_id);

-- 按日计数的限流: key 形如 'code:email:<email>' 'code:ip:<ip>' 'put:<userId>' (UTC 日);
-- 'ping:<HMAC(日, IP) 前 32 位十六进制>' (北京日, 不存原始 IP)
CREATE TABLE IF NOT EXISTS counters (
  key   TEXT    NOT NULL,
  day   TEXT    NOT NULL,                   -- YYYY-MM-DD (UTC)
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, day)
);
CREATE INDEX IF NOT EXISTS counters_day ON counters(day);

-- ---- 匿名使用统计 (docs/usage-stats-plan.md) ----
-- 只有随机安装 ID (客户端生成的 UUID v4)、平台、版本、语言、当天是否打开过阅读器. 不存 IP / UA.
-- day 一律为北京时间 (Asia/Shanghai) 日期 YYYY-MM-DD

-- 每个安装每天一行; reader 取「或」(一旦为 1 当天保持 1). 保留 90 天, 之后聚合进 ping_daily
CREATE TABLE IF NOT EXISTS pings (
  day        TEXT    NOT NULL,
  install_id TEXT    NOT NULL,
  platform   TEXT    NOT NULL,              -- windows|macos|linux|android|ios|web|other
  version    TEXT    NOT NULL,              -- x.y.z
  lang       TEXT    NOT NULL,              -- zh|en
  reader     INTEGER NOT NULL DEFAULT 0,    -- 0|1
  PRIMARY KEY (day, install_id)
);
CREATE INDEX IF NOT EXISTS pings_install ON pings(install_id, day);

-- 每个安装一行, 长期保留 (装机量 / 新增 / 留存). platform / version 为最近一次上报
CREATE TABLE IF NOT EXISTS installs (
  install_id TEXT PRIMARY KEY,
  first_day  TEXT NOT NULL,
  last_day   TEXT NOT NULL,
  platform   TEXT NOT NULL,
  version    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS installs_first_day ON installs(first_day);
CREATE INDEX IF NOT EXISTS installs_last_day ON installs(last_day);

-- 90 天前的 pings 按 (天, 平台, 版本) 聚合后的计数 (定时任务写入)
CREATE TABLE IF NOT EXISTS ping_daily (
  day          TEXT    NOT NULL,
  platform     TEXT    NOT NULL,
  version      TEXT    NOT NULL,
  actives      INTEGER NOT NULL,
  readers      INTEGER NOT NULL,
  new_installs INTEGER NOT NULL,
  PRIMARY KEY (day, platform, version)
);
