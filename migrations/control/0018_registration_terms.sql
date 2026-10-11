-- Varysheet - 用户注册时的「系统规则与内容合规条款」确认记录（D1 / SQLite）
-- Applied with:  npx wrangler d1 migrations apply cloudnotion-db --local|--remote
--
-- 背景（需求 2026-10）：注册（含通过邀请链接注册）时必须勾选
-- 「我已阅读并同意《系统规则与内容合规条款》」，服务端在
--   POST /api/auth/register        （普通注册第一步）
--   POST /api/invites/:token/accept（邀请注册）
-- 都会校验这个勾选（没勾选返回 400 `terms_not_accepted`），并在真正写入 users 时记下：
--   terms_accepted_at：同意的时刻（毫秒）
--   terms_version    ：当时生效条款正文的短指纹（见 src/shared/policy.ts 的 policyVersion）
--                      —— 条款正文由管理员在「后台 → 系统管理」里维护，改文案指纹就会变，
--                      日后可以据此判断某个账号同意的是哪一版。
--
-- 老账号（本迁移之前注册的）两列都是默认值：0 / 空串 = 「没有这条记录」，
-- 不代表同意或不同意，只是当时没有这个流程。
-- 幂等：`ALTER TABLE ... ADD COLUMN` 每个库只执行一次（迁移只会跑一遍）。

ALTER TABLE users ADD COLUMN terms_accepted_at INTEGER NOT NULL DEFAULT 0;

ALTER TABLE users ADD COLUMN terms_version TEXT NOT NULL DEFAULT '';
