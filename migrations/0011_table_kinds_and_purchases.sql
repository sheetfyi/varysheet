-- Varysheet - 表格类型（基础 / 专业）与表格名额购买流水（D1 / SQLite）
-- Applied with:  npx wrangler d1 migrations apply cloudnotion-db --local|--remote
--
-- 1) databases.kind：每张表属于两类之一，规则见 src/shared/tableKind.ts
--      basic 基础表格：500 条记录 / 1GB 附件 / 数据保留 1 年 / 最多 10 列 / 3 个视图
--      pro   专业表格：记录、附件与保留时间都不限 / 最多 20 列 / 10 个视图
--    升级前就存在的表全部按基础表格处理（DEFAULT 'basic'）。
--
-- 2) table_purchases：购买表格名额的流水 —— 买几个名额就多几个可添加的同类型表格。
--    名额口径见 src/shared/quota.ts（新注册账号默认 0 个名额，每分享一次 +1、购买 +n）。
--    支付网关还没接入，`channel` 先留一列记渠道（自助购买写 'self-serve'），
--    以后接支付就写订单号 / 渠道名，不用再改表结构。

ALTER TABLE databases ADD COLUMN kind TEXT NOT NULL DEFAULT 'basic';

CREATE TABLE IF NOT EXISTS table_purchases (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL DEFAULT 'basic',  -- basic（基础表格）| pro（专业表格）
  count      INTEGER NOT NULL DEFAULT 1,     -- 这次买了几个名额
  channel    TEXT NOT NULL DEFAULT 'self-serve',
  note       TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_table_purchases_user ON table_purchases(user_id, kind, created_at);
