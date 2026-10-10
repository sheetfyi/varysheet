-- Varysheet - 管理员账号 + 邮件确认码（D1 / SQLite）
-- Applied with:  npx wrangler d1 migrations apply cloudnotion-db --local|--remote
--
-- 1) users.is_admin：管理员（超级用户）标记。
--    管理员登录后侧边栏会多出「用户管理」页面：查看全部注册用户、修改注册信息（昵称 / 邮箱）、
--    重置密码（重置后该用户的所有会话立即失效）。
--    默认 0 —— 升级前的老账号都不是管理员；`ADMIN_EMAIL` 环境变量指定的账号会在登录时被自动提升 /
--    创建（见 src/worker/admin.ts 的 ensureAdminUser）。
--
-- 2) email_codes：注册确认码。
--    注册第一步只把「待确认的注册信息」写在这里（payload 里是昵称 + 已经哈希过的密码），
--    用户把邮件里的 6 位确认码填回来（POST /api/auth/register/verify）之后才会真正插入 users 行，
--    所以 users 表里不会留下半成品账号，也不会占用邮箱。
--    只存 sha256(email:purpose:code)，不存明文；attempts 超过上限即作废（防暴力猜码）。
ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS email_codes (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  purpose     TEXT NOT NULL,               -- signup（注册确认）| reset（预留）
  code_hash   TEXT NOT NULL,               -- sha256(email:purpose:code)
  payload     TEXT NOT NULL DEFAULT '{}',  -- 待确认的注册信息（昵称 / 密码哈希）
  attempts    INTEGER NOT NULL DEFAULT 0,  -- 试错次数，超过上限作废
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_email_codes_lookup ON email_codes(email, purpose, created_at);
