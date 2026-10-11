-- Varysheet - 购买表格名额的时长与金额（D1 / SQLite）
-- Applied with:  npx wrangler d1 migrations apply cloudnotion-db --local|--remote
--
-- 购买价格（口径见 src/shared/tableKind.ts）：基础表格 9.9 元/月、专业表格 99.9 元/月；
-- 购买时可以按月（1 个月）或按年（12 个月）买。所以每一笔流水都要能回答三件事：
--   买了几个名额（count）、买了多久（months）、这一单多少钱（amount_cents）。
-- 金额在服务端按「每月单价 × 数量 × 月数」算好写进流水（单位：分），客户端只负责展示，
-- 以后接支付时用它跟支付平台对账。老流水按默认值处理（1 个月 / 0 分，当时还没记价）。
--
-- 另外：基础表格的名额只能购买获得（分享不再赠额），名额口径见 src/shared/quota.ts。

ALTER TABLE table_purchases ADD COLUMN months INTEGER NOT NULL DEFAULT 1;
ALTER TABLE table_purchases ADD COLUMN amount_cents INTEGER NOT NULL DEFAULT 0;
