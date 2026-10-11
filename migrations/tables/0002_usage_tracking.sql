-- Varysheet - 表格分片库：记录 / 附件的「最后一次使用」时间（last_used_at）
-- Applied with:  npx wrangler d1 migrations apply cloudnotion-tables-trial --remote
--                （每个分片库各执行一次：trial / basic / pro，以及后台新建的备用分片）
--
-- 背景（见 src/shared/tableKind.ts 与 src/worker/retention.ts）：
--   保留期口径从「创建时间」改成「最后一次使用」——
--     试用表格：1 年内没有使用（编辑或查询）的记录与附件自动清除；
--     基础表格：5 年内没有使用（编辑或查询）的记录与附件自动清除；
--     专业表格：长期保留（不清理，只提示管理员自行清理历史数据）。
--   所以记录 / 附件各自需要一个「最后一次使用」时间列：
--     - 编辑记录（含新建）时写入当前时间；
--     - 列表 / 查询接口把记录返回给用户时（节流一天一次）刷新；
--     - 附件被下载时（节流一天一次）刷新。
--   0 = 还没记过（历史数据），清理时退回 updated_at（记录）/ created_at（附件）。
--
-- 幂等：本迁移只对**还没有这一列**的库执行一次；已经加过（或全新库先跑了 0001 再跑它之外的
-- 路径）会报 `duplicate column name`，所以运行时那条路径（ensureShardSchema）会跳过这个错误，
-- 而 `wrangler d1 migrations apply` 每个库只会执行一次这个文件。
--
-- ⚠️ 与 src/worker/shardSchema.ts 的 `SHARD_COLUMN_MIGRATIONS` 保持一致（改结构请同步两边）。

ALTER TABLE records ADD COLUMN last_used_at INTEGER NOT NULL DEFAULT 0;

ALTER TABLE files ADD COLUMN last_used_at INTEGER NOT NULL DEFAULT 0;
