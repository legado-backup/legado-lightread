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

-- 按 UTC 日计数的限流: key 形如 'code:email:<email>' 'code:ip:<ip>' 'put:<userId>'
CREATE TABLE IF NOT EXISTS counters (
  key   TEXT    NOT NULL,
  day   TEXT    NOT NULL,                   -- YYYY-MM-DD (UTC)
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, day)
);
CREATE INDEX IF NOT EXISTS counters_day ON counters(day);
