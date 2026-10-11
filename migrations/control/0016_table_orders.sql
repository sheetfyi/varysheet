-- Varysheet - 表格名额的支付订单（D1 / SQLite）
-- Applied with:  npx wrangler d1 migrations apply cloudnotion-db --local|--remote
--
-- 接入 XorPay 之后，购买分三步走（见 docs/payment-xorpay.md）：
--   1) 下单：服务端算价 → 写一行 status = 'pending' 的订单 → 调 XorPay 拿微信支付二维码；
--   2) 支付：用户微信扫码付款（pay_type = 'native'）；
--   3) 交付：XorPay 回调（或前端轮询触发的主动查单）验签通过、金额核对通过后，
--      把订单改成 'paid' 并写一条 table_purchases（名额从这里来），channel 记 'xorpay:native'。
-- 没配 XorPay（后台「站点设置」里没填 appid / app secret，环境变量也没有）时是**自助直通**：
-- 下单即 'paid'、channel = 'self-serve'，行为与接入支付之前一致（本地开发 / CI / 资质审核期）。
--
-- id 就是我们自己的订单号，同时也是传给 XorPay 的 order_id（平台侧要求唯一）；
-- aoid 是 XorPay 的平台订单号（回调 / 主动查询都用得上）。交付幂等靠
--   UPDATE table_orders SET status='paid' WHERE id=? AND status<>'paid'
-- 的 changes 数判断（见 src/worker/orders.ts 的 deliverOrder），
-- table_purchases.order_id 上的部分唯一索引是第二道闸。

CREATE TABLE IF NOT EXISTS table_orders (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL DEFAULT 'basic',   -- basic（基础表格）| pro（专业表格）
  count            INTEGER NOT NULL DEFAULT 1,      -- 这一单买几个名额
  months           INTEGER NOT NULL DEFAULT 1,      -- 总时长（月），口径同 table_purchases.months
  amount_cents     INTEGER NOT NULL DEFAULT 0,      -- 应付金额（分），服务端算好后冻结在这一行
  paid_cents       INTEGER NOT NULL DEFAULT 0,      -- 回调里的实收金额（分），用于对账
  status           TEXT NOT NULL DEFAULT 'pending', -- pending | paid | expired | canceled | amount_mismatch
  pay_type         TEXT NOT NULL DEFAULT '',        -- native（微信扫码）| ''（自助直通）
  channel          TEXT NOT NULL DEFAULT '',        -- xorpay | self-serve（交付时写进 table_purchases.channel）
  aoid             TEXT NOT NULL DEFAULT '',        -- XorPay 平台订单号
  qr               TEXT NOT NULL DEFAULT '',        -- 支付二维码内容（前端用 xorpay.com/qr?data= 画图）
  transaction_id   TEXT NOT NULL DEFAULT '',        -- 渠道流水号（回调 detail.transaction_id）
  buyer            TEXT NOT NULL DEFAULT '',        -- 付款方（回调 detail.buyer，对账用）
  notify_raw       TEXT NOT NULL DEFAULT '',        -- 最近一次回调原文 / 下单失败原因（排障用，截断保存）
  purchase_id      TEXT NOT NULL DEFAULT '',        -- 交付后写入的 table_purchases.id（自愈用）
  expires_at       INTEGER NOT NULL DEFAULT 0,      -- 订单过期时刻（毫秒）
  paid_at          INTEGER,                         -- 支付确认时刻（毫秒）
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_table_orders_user ON table_orders(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_table_orders_status ON table_orders(status, created_at);

-- 一条流水对应一张订单（幂等 + 对账）：只有订单交付时才写 purchase，且只写一次。
-- 老流水不受影响：order_id 默认空串，索引只覆盖非空值。
ALTER TABLE table_purchases ADD COLUMN order_id TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_table_purchases_order
  ON table_purchases(order_id) WHERE order_id <> '';
