-- Varysheet - 字段级锁定（D1 / SQLite）
-- Applied with:  npx wrangler d1 migrations apply cloudnotion-db --local|--remote
--
-- 锁定字段：锁定后该字段在所有记录里只读 —— 原有的编辑 / 上传入口全部失效，
-- 但字段名与已有内容照常显示。锁定 / 解锁入口位于表头字段的下拉菜单
-- （「🔒 锁定字段」/「🔓 解锁字段」），锁定状态随字段一起下发。
ALTER TABLE properties ADD COLUMN is_locked INTEGER NOT NULL DEFAULT 0;
