-- Varysheet - 单元格级「只能修改一次」（D1 / SQLite）
-- Applied with:  npx wrangler d1 migrations apply cloudnotion-db --local|--remote
--
-- 共享出来的可编辑用户（公开链接访客 / 被邀请的 editor / 视图定向分享的 editor）
-- 对每一格数据只有一次修改机会：第一次保存成功后在这里登记一条记录，
-- 之后同一个人再改同一个格子就会被拒绝（403），只能请表格所有者代改。
-- 表格所有者不受限制，永远不会写入这张表。
--
-- editor_key 的取值：
--   user:<用户 id>   —— 登录用户（成员 / 视图定向分享）
--   share:<分享 id>  —— 公开分享链接（同一个链接的所有访客共用一次机会）

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
