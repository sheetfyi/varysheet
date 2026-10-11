-- Varysheet - 试用表格的赠额流水（每成功邀请一位新用户注册 +1 个试用表格名额）
-- Applied with:  npx wrangler d1 migrations apply cloudnotion-db --local|--remote
--
-- 试用表格（`kind = 'trial'`，见 src/shared/tableKind.ts）：100 条记录 / 0.5GB 附件 /
-- 数据保留半年 / 最多 10 列 / 3 个视图，表格数据落在**专门的试用分片库**
-- （绑定 DB_TABLES_TRIAL，库名 cloudnotion-tables-trial）。名额口径见 src/shared/quota.ts。
--
-- trial_table_grants：谁因为什么多了几个试用表格名额。
--   - 新账号送的 1 个试用表格**不写这张表**：`BASE_TABLE_QUOTA.trial = 1` 是常量规则，
--     每个账号都一样，不需要按账号记账；
--   - 每成功邀请一位**还没注册过**的用户（对方从 `/invite/<token>` 注册成功）时写一行
--     `reason = 'invite'`；`GET /api/quota` 里试用名额的「赠额」就是这些行的条数。
--   只记账、不建表：表格本体在分片库里。
--
-- 幂等：同一个邀请人 + 同一个新用户只记一次（部分唯一索引 + `INSERT OR IGNORE`），
-- 邀请被重复接受 / 重放时不会重复加名额。

CREATE TABLE IF NOT EXISTS trial_table_grants (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- 拿到赠额的邀请人
  reason          TEXT NOT NULL DEFAULT 'invite',                       -- invite（邀请新用户注册）
  invited_email   TEXT NOT NULL DEFAULT '',                             -- 被邀请的邮箱（留痕）
  invited_user_id TEXT,                                                 -- 对方注册后生成的账号 id
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trial_table_grants_user
  ON trial_table_grants(user_id, created_at);
-- 同一位新用户只给同一个邀请人加一次名额（invited_user_id 为空的历史数据不受约束）
CREATE UNIQUE INDEX IF NOT EXISTS idx_trial_table_grants_invited
  ON trial_table_grants(user_id, invited_user_id) WHERE invited_user_id IS NOT NULL;
