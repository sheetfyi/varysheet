-- Varysheet - 多人协作的增量同步日志（D1 / SQLite）
-- Applied with:  npx wrangler d1 migrations apply cloudnotion-db --local|--remote
--
-- 每一次改动（改单元格 / 增删记录 / 新增备注 / 改字段与视图结构）都往这里**追加**一条，
-- 客户端带着自己看过的最大 rev 轮询 /api/databases/:id/changes?since=<rev>，
-- 只拿回「比它新」的改动：别人改的单元格不用刷新页面就会出现，而且不用整表重拉。
--
-- 两条约定（见 src/worker/changes.ts 的文件头）：
--   1. rev 是全局自增（AUTOINCREMENT，所有表格共用一条序列），客户端只需要记住一个数字；
--   2. 日志永远写在**数据之后**，所以客户端「先读 rev、再读数据」不会漏改动。
--
-- kind 取值：
--   row    记录被改过（值 / 顺序）
--   delete 记录被删除
--   note   这条记录上新增了备注
--   schema 表格结构变了（改名 / 字段 / 视图 / 成员 / 分享）：客户端整表重载一次
CREATE TABLE IF NOT EXISTS database_changes (
  rev         INTEGER PRIMARY KEY AUTOINCREMENT,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  record_id   TEXT,
  kind        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_database_changes_database ON database_changes(database_id, rev);
CREATE INDEX IF NOT EXISTS idx_database_changes_created ON database_changes(created_at);
