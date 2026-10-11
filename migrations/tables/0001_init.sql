-- Varysheet - 表格分片库（试用表格 / 基础表格 / 专业表格）初始化
--
-- 每个分片库都是一样的结构（表格 / 字段 / 记录 / 视图 / 分享 / 备注 / 改动日志 /
-- 附件 / 邀请 + 各自的索引）。管理员在后台新建备用分片时，执行的是同一份 DDL
-- （见 src/worker/shards.ts 的 ensureShardSchema）。
--
-- ⚠️ 本文件由 scripts/sync-shard-schema.mjs 从 src/worker/shardSchema.ts 生成，
--    需要改结构请改那个文件再重新生成，不要手改这里。
--
-- 应用方式（每个分片库各执行一次）：
--   npx wrangler d1 migrations apply cloudnotion-tables-trial --remote
--   npx wrangler d1 migrations apply cloudnotion-tables-basic --remote
--   npx wrangler d1 migrations apply cloudnotion-tables-pro --remote

CREATE TABLE IF NOT EXISTS databases (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  name        TEXT NOT NULL,
  icon        TEXT NOT NULL DEFAULT '📋',
  description TEXT NOT NULL DEFAULT '',
  is_archived INTEGER NOT NULL DEFAULT 0,
  is_locked   INTEGER NOT NULL DEFAULT 0,
  kind        TEXT NOT NULL DEFAULT 'basic',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_databases_owner ON databases(owner_id);

CREATE INDEX IF NOT EXISTS idx_databases_kind ON databases(kind);

CREATE TABLE IF NOT EXISTS database_members (
  id          TEXT PRIMARY KEY,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'editor',
  created_at  INTEGER NOT NULL,
  UNIQUE (database_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_members_user ON database_members(user_id);

CREATE TABLE IF NOT EXISTS properties (
  id          TEXT PRIMARY KEY,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,
  config      TEXT NOT NULL DEFAULT '{}',
  position    REAL NOT NULL DEFAULT 0,
  width       INTEGER NOT NULL DEFAULT 200,
  is_locked   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_properties_database ON properties(database_id, position);

CREATE TABLE IF NOT EXISTS records (
  id          TEXT PRIMARY KEY,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  "values"    TEXT NOT NULL DEFAULT '{}',
  position    REAL NOT NULL DEFAULT 0,
  created_by  TEXT,
  updated_by  TEXT,
  is_archived INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_records_database ON records(database_id, position);

CREATE TABLE IF NOT EXISTS views (
  id          TEXT PRIMARY KEY,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'table',
  config      TEXT NOT NULL DEFAULT '{}',
  position    REAL NOT NULL DEFAULT 0,
  is_locked   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_views_database ON views(database_id, position);

CREATE TABLE IF NOT EXISTS shares (
  id          TEXT PRIMARY KEY,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  token       TEXT NOT NULL UNIQUE,
  permission  TEXT NOT NULL DEFAULT 'view',
  created_by  TEXT,
  expires_at  INTEGER,
  limit_edits INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shares_database ON shares(database_id);

CREATE TABLE IF NOT EXISTS view_shares (
  id          TEXT PRIMARY KEY,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  view_id     TEXT NOT NULL REFERENCES views(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'viewer',
  created_by  TEXT,
  limit_edits INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  UNIQUE (view_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_view_shares_user ON view_shares(user_id);

CREATE INDEX IF NOT EXISTS idx_view_shares_database ON view_shares(database_id, created_at);

CREATE TABLE IF NOT EXISTS cell_edits (
  id          TEXT PRIMARY KEY,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  record_id   TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  editor_key  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE (editor_key, record_id, property_id)
);

CREATE INDEX IF NOT EXISTS idx_cell_edits_cell ON cell_edits(record_id, editor_key);

CREATE INDEX IF NOT EXISTS idx_cell_edits_database ON cell_edits(database_id);

CREATE TABLE IF NOT EXISTS notes (
  id          TEXT PRIMARY KEY,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  record_id   TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  author_id   TEXT,
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notes_record ON notes(record_id, created_at);

CREATE INDEX IF NOT EXISTS idx_notes_database ON notes(database_id, created_at);

CREATE TABLE IF NOT EXISTS database_changes (
  rev         INTEGER PRIMARY KEY AUTOINCREMENT,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  record_id   TEXT,
  kind        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_database_changes_database ON database_changes(database_id, rev);

CREATE INDEX IF NOT EXISTS idx_database_changes_created ON database_changes(created_at);

CREATE TABLE IF NOT EXISTS invites (
  id          TEXT PRIMARY KEY,
  token       TEXT NOT NULL UNIQUE,
  email       TEXT NOT NULL,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  view_id     TEXT NOT NULL REFERENCES views(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'viewer',
  limit_edits INTEGER NOT NULL DEFAULT 0,
  invited_by  TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  accepted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_invites_email ON invites(email, created_at);

CREATE INDEX IF NOT EXISTS idx_invites_database ON invites(database_id, created_at);

CREATE TABLE IF NOT EXISTS files (
  id          TEXT PRIMARY KEY,
  database_id TEXT REFERENCES databases(id) ON DELETE CASCADE,
  record_id   TEXT,
  property_id TEXT,
  r2_key      TEXT NOT NULL,
  name        TEXT NOT NULL,
  size        INTEGER NOT NULL DEFAULT 0,
  mime        TEXT NOT NULL DEFAULT 'application/octet-stream',
  uploaded_by TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_files_database ON files(database_id);
