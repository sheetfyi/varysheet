-- Varysheet - view level sharing + structure lock (D1 / SQLite)
-- Applied with:  npx wrangler d1 migrations apply cloudnotion-db --local|--remote

-- 表格锁定：锁定后字段 / 视图等结构只读，记录数据仍可编辑
ALTER TABLE databases ADD COLUMN is_locked INTEGER NOT NULL DEFAULT 0;

-- 视图锁定：锁定后该视图的名称与配置（筛选 / 分组 / 列）不可修改，也无法删除
ALTER TABLE views ADD COLUMN is_locked INTEGER NOT NULL DEFAULT 0;

-- 视图级别的定向分享：把某一个视图（含它的筛选与可见字段）分享给已注册用户
CREATE TABLE IF NOT EXISTS view_shares (
  id          TEXT PRIMARY KEY,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  view_id     TEXT NOT NULL REFERENCES views(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'viewer', -- viewer | editor
  created_by  TEXT,
  created_at  INTEGER NOT NULL,
  UNIQUE (view_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_view_shares_user ON view_shares(user_id);
CREATE INDEX IF NOT EXISTS idx_view_shares_database ON view_shares(database_id, created_at);
