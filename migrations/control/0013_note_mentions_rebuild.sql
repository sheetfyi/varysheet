-- Varysheet - 去掉用户库里指向分片库的旧外键
--
-- `note_mentions` 留在用户库（收件箱是按人查的），但它的 `note_id` 原来外键指向
-- 用户库里的 `notes`；表格数据拆去分片库之后（见 0012）那个表已经不在用户库了，
-- 于是「新增 @提醒」和「删除账号」都会报 `no such table: main.notes`。
-- 这里把这张表按新结构（去掉指向 notes 的外键）重建一次，数据原样搬过去。
--
-- 幂等：`INSERT OR IGNORE` 配上 `UNIQUE (note_id, user_id)`，重复执行不会重复数据。
-- ⚠️ 本文件由 scripts/sync-shard-schema.mjs 生成，请勿手改（改 src/worker/shardSchema.ts）。

CREATE TABLE IF NOT EXISTS note_mentions_rebuilt (
  id          TEXT PRIMARY KEY,
  note_id     TEXT NOT NULL,
  database_id TEXT NOT NULL,
  record_id   TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at     INTEGER,
  created_at  INTEGER NOT NULL,
  UNIQUE (note_id, user_id)
);

INSERT OR IGNORE INTO note_mentions_rebuilt (id, note_id, database_id, record_id, user_id, read_at, created_at)
  SELECT id, note_id, database_id, record_id, user_id, read_at, created_at FROM note_mentions;

DROP TABLE IF EXISTS note_mentions;

ALTER TABLE note_mentions_rebuilt RENAME TO note_mentions;

CREATE INDEX IF NOT EXISTS idx_note_mentions_user ON note_mentions(user_id, read_at, created_at);
