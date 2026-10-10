-- Varysheet - 记录备注（评论）+ @提醒私信
-- Applied with:  npx wrangler d1 migrations apply cloudnotion-db --local|--remote

-- 记录上的备注：只能新增，不能修改 / 删除
-- （没有 update / delete 接口，也没有软删除标记，写进去就永久保留）
CREATE TABLE IF NOT EXISTS notes (
  id          TEXT PRIMARY KEY,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  record_id   TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  author_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_record ON notes(record_id, created_at);
CREATE INDEX IF NOT EXISTS idx_notes_database ON notes(database_id, created_at);

-- 备注里 @ 到的人 → 收件箱私信；read_at 为 NULL 表示未读（红点里的数字）
CREATE TABLE IF NOT EXISTS note_mentions (
  id          TEXT PRIMARY KEY,
  note_id     TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  database_id TEXT NOT NULL,
  record_id   TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at     INTEGER,
  created_at  INTEGER NOT NULL,
  UNIQUE (note_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_note_mentions_user ON note_mentions(user_id, read_at, created_at);
