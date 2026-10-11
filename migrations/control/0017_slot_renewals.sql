-- Varysheet - 表格名额「删表不退还」与基础 / 专业表格的时长（续费）（D1 / SQLite）
-- Applied with:  npx wrangler d1 migrations apply cloudnotion-db --local|--remote
--
-- 口径（见 src/shared/quota.ts 与 src/worker/slots.ts）：
--   1) 基础表格 / 专业表格**被删除后名额不退还**：删掉一张表就等于把那个名额一起带走
--      （买它的钱也不退）。试用表格保持原样 —— 删掉就把名额还回来。
--      实现：删表时往 `table_slot_consumptions` 写一行，`GET /api/quota` 的「已用」把它算进去。
--   2) 基础表格 / 专业表格各自有一段「时长」：建表时按该类型最近一次购买的时长起算；
--      剩余不到一周（`SLOT_RENEW_WINDOW_DAYS`）时，表格清单里这张表后面会出现「续费」按钮。
--      续费走和购买完全相同的下单 / 支付流程，但**不增加**可添加的名额，只把这张表的到期时间往后推。
--      实现：`table_slot_allocations` 记每张表的到期时间；`table_purchases.database_id` 与
--      `table_orders.database_id` 标出「这一笔是给哪张表续的时长」—— 续费流水不算新增名额。
--
-- 老数据：迁移之前建的表没有 `table_slot_allocations` 行（清单里不显示续费按钮）；
-- 迁移之后建的、以及续费时现场补建的行都有。两个 `database_id` 默认空串，老流水不受影响。

-- 名额流向的流水：谁把哪个名额带走了（只有删表会写）
CREATE TABLE IF NOT EXISTS table_slot_consumptions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- 名额是被谁带走的
  database_id TEXT NOT NULL DEFAULT '',                             -- 被删掉的那张表（留痕）
  kind        TEXT NOT NULL DEFAULT 'basic',                        -- basic | pro（试用表格不记账）
  reason      TEXT NOT NULL DEFAULT 'delete',                       -- delete（删表）| account（账号被清理）
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_table_slot_consumptions_user
  ON table_slot_consumptions(user_id, kind, created_at);

-- 每张基础 / 专业表格的时长（到期时间）；续费就是把它往后推
CREATE TABLE IF NOT EXISTS table_slot_allocations (
  database_id TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'basic', -- basic | pro
  months      INTEGER NOT NULL DEFAULT 1,    -- 建表时按哪个时长起算
  expires_at  INTEGER NOT NULL DEFAULT 0,    -- 到期时刻（毫秒）；0 = 没有时长记录
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_table_slot_allocations_user
  ON table_slot_allocations(user_id, expires_at);

-- 续费流水：`database_id` 非空 = 这一笔给某张表续时长，不算新增名额（名额统计会跳过它）
ALTER TABLE table_purchases ADD COLUMN database_id TEXT NOT NULL DEFAULT '';
-- 下单时也要记住续费哪张表，回调 / 查单交付时才写得出上面那一列
ALTER TABLE table_orders ADD COLUMN database_id TEXT NOT NULL DEFAULT '';
