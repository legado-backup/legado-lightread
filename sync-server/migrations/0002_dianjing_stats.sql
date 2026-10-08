-- 迁移 0002: 点睛阅读的按天汇总 (dj_daily / dj_rollup). 与 schema.sql「匿名使用统计」一段末尾相同, 幂等, 可重跑.
-- 生产: npx wrangler d1 execute lightread-sync -c wrangler.jsonc --remote --file migrations/0002_dianjing_stats.sql
--   (workers token 没有 D1 权限: 改走 Cloudflare MCP 的 D1 query API 执行本文件语句; 需用户确认后再做)
--   先建表再部署 Worker: 新 Worker 写 dj_daily 时表不存在会让整个心跳批次失败.

-- 点睛阅读的按天汇总 (心跳里可选的 dj 字段; 客户端只补报已过完的日子). 只有数字, 不含书名、正文、具体的词.
-- min_*: 读中文书的分钟 (关 / 词与词 / 重点词 / 智能); lv_*: 用重点词时各密度档的分钟;
-- ai_ok / ai_all: 智能版 AI 重点词可用的块 / 请求了重点词的块; kw_missing / kw_all: AI 给的词在正文中找不到的 / 总数
CREATE TABLE IF NOT EXISTS dj_daily (
  day        TEXT    NOT NULL,
  install_id TEXT    NOT NULL,
  platform   TEXT    NOT NULL,
  version    TEXT    NOT NULL,
  min_off    INTEGER NOT NULL DEFAULT 0,
  min_words  INTEGER NOT NULL DEFAULT 0,
  min_key    INTEGER NOT NULL DEFAULT 0,
  min_smart  INTEGER NOT NULL DEFAULT 0,
  lv_low     INTEGER NOT NULL DEFAULT 0,
  lv_mid     INTEGER NOT NULL DEFAULT 0,
  lv_high    INTEGER NOT NULL DEFAULT 0,
  ai_ok      INTEGER NOT NULL DEFAULT 0,
  ai_all     INTEGER NOT NULL DEFAULT 0,
  kw_missing INTEGER NOT NULL DEFAULT 0,
  kw_all     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, install_id)
);

-- 90 天前的 dj_daily 按 (天, 版本) 聚合 (定时任务写入)
CREATE TABLE IF NOT EXISTS dj_rollup (
  day         TEXT    NOT NULL,
  version     TEXT    NOT NULL,
  installs    INTEGER NOT NULL,
  users_key   INTEGER NOT NULL,
  users_smart INTEGER NOT NULL,
  min_off     INTEGER NOT NULL,
  min_words   INTEGER NOT NULL,
  min_key     INTEGER NOT NULL,
  min_smart   INTEGER NOT NULL,
  lv_low      INTEGER NOT NULL,
  lv_mid      INTEGER NOT NULL,
  lv_high     INTEGER NOT NULL,
  ai_ok       INTEGER NOT NULL,
  ai_all      INTEGER NOT NULL,
  kw_missing  INTEGER NOT NULL,
  kw_all      INTEGER NOT NULL,
  PRIMARY KEY (day, version)
);
