-- Varysheet - 「限制编辑」改为分享时的可选项（D1 / SQLite）
-- Applied with:  npx wrangler d1 migrations apply cloudnotion-db --local|--remote
--
-- 之前：所有共享出来的可编辑访问者（公开链接访客 / 视图定向分享的 editor）
--       对每一格数据都只有一次修改机会，没有开关。
-- 现在：改成分享上的一个选项 —— 只有创建分享时勾选了「限制编辑」才做这个限制
--       （写入 cell_edits + 第二次修改同一个格子返回 403）；
--       没勾选的分享、以及表格成员，可以反复修改同一个格子。
--
-- limit_edits：0 = 不限制（默认），1 = 限制（每个格子只能改一次）
--   * shares.permission = 'view' 时永远不生效（只读链接本来就不能改）
--   * view_shares.role = 'viewer' 时永远不生效（只读分享本来就不能改）

ALTER TABLE shares ADD COLUMN limit_edits INTEGER NOT NULL DEFAULT 0;
ALTER TABLE view_shares ADD COLUMN limit_edits INTEGER NOT NULL DEFAULT 0;

-- 已经存在的分享沿用旧行为（可编辑的分享 = 限制编辑），新建分享由创建者决定
UPDATE shares SET limit_edits = 1 WHERE permission = 'edit';
UPDATE view_shares SET limit_edits = 1 WHERE role = 'editor';
