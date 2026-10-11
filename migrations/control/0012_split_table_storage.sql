-- Varysheet - 表格数据搬去独立分片库（用户库瘦身）
--
-- 背景：表格数据（表格 / 字段 / 记录 / 视图 / 分享 / 备注 / 改动日志 / 附件 / 邀请）
-- 原来和账号数据挤在同一个 D1 库里，10GB 上限一到就谁都写不进去。现在把表格数据
-- 拆到独立的分片库（见 src/worker/shards.ts、docs/storage.md），用户库只留账号 /
-- 会话 / 站点设置 / 购买记录 / @提醒 和下面的分片注册表。
--
-- ⚠️ 顺序很重要：**先**跑 `node scripts/migrate-split-data.mjs` 把数据搬到分片库，
--    确认搬完（脚本会打印核对结果）**再**执行本迁移；本迁移会把用户库里的旧表删掉。
--
-- 迁移是幂等的：`DROP TABLE IF EXISTS` / `CREATE TABLE IF NOT EXISTS` 重复执行都安全。
-- ⚠️ 本文件由 scripts/sync-shard-schema.mjs 生成，请勿手改（改 src/worker/shardSchema.ts）。

-- 1. 删掉已经搬去分片库的表（顺序：先引用方，后被引用的 databases）
DROP TABLE IF EXISTS invites;
DROP TABLE IF EXISTS database_changes;
DROP TABLE IF EXISTS notes;
DROP TABLE IF EXISTS cell_edits;
DROP TABLE IF EXISTS view_shares;
DROP TABLE IF EXISTS shares;
DROP TABLE IF EXISTS views;
DROP TABLE IF EXISTS records;
DROP TABLE IF EXISTS properties;
DROP TABLE IF EXISTS database_members;
DROP TABLE IF EXISTS files;
DROP TABLE IF EXISTS databases;

-- 2. 分片注册表：有哪些分片库、各自放哪一类表格、用了多少空间
CREATE TABLE IF NOT EXISTS database_shards (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL DEFAULT 'basic',
  database_id TEXT NOT NULL,
  binding     TEXT,
  note        TEXT NOT NULL DEFAULT '',
  file_size   INTEGER,
  checked_at  INTEGER,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_database_shards_kind ON database_shards(kind, is_active);

CREATE INDEX IF NOT EXISTS idx_database_shards_database ON database_shards(database_id);

-- 3. 首次部署说明
--    注册表为空时，运行时会退回 wrangler.jsonc 里绑定的主分片（DB_TABLES_TRIAL /
--    DB_TABLES_BASIC / DB_TABLES_PRO），所以这一步之后站点立刻可用。要让后台看到用量、
--    或者挂载动态新建的备用分片，请在「后台 → 存储分片」里挂载，或直接执行：
--
--    INSERT INTO database_shards
--      (id, name, kind, database_id, binding, note, file_size, checked_at, is_active, created_at, updated_at)
--    VALUES
--      (lower(hex(randomblob(16))), 'cloudnotion-tables-trial', 'trial',
--       '<试用分片库的 database_id>', 'DB_TABLES_TRIAL', '主分片', NULL, NULL, 1,
--       CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
--      (lower(hex(randomblob(16))), 'cloudnotion-tables-basic', 'basic',
--       '<基础分片库的 database_id>', 'DB_TABLES_BASIC', '主分片', NULL, NULL, 1,
--       CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000);
