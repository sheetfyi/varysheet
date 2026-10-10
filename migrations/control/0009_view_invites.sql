-- Varysheet - 视图分享邀请（D1 / SQLite）
-- Applied with:  npx wrangler d1 migrations apply cloudnotion-db --local|--remote
--
-- 背景：视图定向分享以前只能分享给**已经注册**的账号（邮箱不存在就直接报错）。
-- 现在表格所有者可以邀请还没注册的邮箱：先在这里存一条「待接受的邀请」，
-- 邮件里发出 /invite/<token> 链接，对方点开填昵称 + 密码即完成注册，
-- 并自动获得这条视图分享（写入 view_shares）。
--
-- 只有「接受」那一刻才会真正创建 users 行，所以没接受的邀请不会出现在
-- 管理员的用户列表里，也不会占用邮箱（和注册确认码同一个思路）。
-- accepted_at 为 NULL 表示还没接受；过期时间默认 7 天（见 src/worker/invites.ts）。

CREATE TABLE IF NOT EXISTS invites (
  id          TEXT PRIMARY KEY,
  token       TEXT NOT NULL UNIQUE,
  email       TEXT NOT NULL,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  view_id     TEXT NOT NULL REFERENCES views(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'viewer', -- viewer（可查看）| editor（可编辑）
  limit_edits INTEGER NOT NULL DEFAULT 0,     -- 1 = 该视图分享勾选了「限制编辑」
  invited_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  accepted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_invites_email ON invites(email, created_at);
CREATE INDEX IF NOT EXISTS idx_invites_database ON invites(database_id, created_at);
