# 存储结构（用户库 + 表格分片库 + R2）

Varysheet 的表格数据**不再和账号数据放在同一个 D1 库里**。D1 单个库有 10GB 硬上限，
表格数据（记录、备注、附件元数据、改动日志）是最容易把库撑满的部分；一旦撑满，
连登录 / 会话都写不进去。所以现在按用途拆成：

| 库 | 绑定 | 放什么 | 迁移目录 |
| --- | --- | --- | --- |
| 用户库 | `DB`（`cloudnotion-db`） | 账号 / 会话（含注册时勾选条款的 `terms_accepted_at` / `terms_version`） / 注册确认码 / 站点设置（含登录页副标题、系统规则与条款、系统使用说明） / 名额购买流水（`table_purchases`）/ **支付订单（`table_orders`）** / **名额记账（`table_slot_consumptions` 删表带走的名额、`table_slot_allocations` 每张表的时长）** / 试用表格的邀请赠额（`trial_table_grants`）/ @提醒（`note_mentions`）/ **分片注册表** | `migrations/control` |
| 表格分片 | `DB_TABLES_TRIAL`（`cloudnotion-tables-trial`） | 试用表格的全部数据 | `migrations/tables` |
| 表格分片 | `DB_TABLES_BASIC`（`cloudnotion-tables-basic`） | 基础表格的全部数据 | `migrations/tables` |
| 表格分片 | `DB_TABLES_PRO`（`cloudnotion-tables-pro`） | 专业表格的全部数据 | `migrations/tables` |
| 附件 | `BUCKET`（R2） | 上传的文件本体（元数据在分片里） | — |

每个分片库的结构**完全一样**（`src/worker/shardSchema.ts` 的 `SHARD_SCHEMA`）：

```
databases / database_members / properties / records / views / shares /
view_shares / cell_edits / notes / database_changes / invites / files
```

管理员在后台「存储分片」里新建的备用分片执行的就是这同一份 DDL（`ensureShardSchema`），
`migrations/tables/0001_init.sql` 由 `scripts/sync-shard-schema.mjs` 从它生成，两边不会漂移
（CI 跑 `npm run schema:check`）。

后续给分片加列的迁移写在 `migrations/tables/`（`0002_usage_tracking.sql` 给 `records` / `files`
加 `last_used_at`，「最后一次使用」的时间），同时登记在 `src/worker/shardSchema.ts` 的
`SHARD_COLUMN_MIGRATIONS` 里 —— 老分片在读取前由 `ensureShardSchema` 就地补列，
`scripts/sync-shard-schema.mjs` 还会交叉核对两份定义，缺一份 `npm run schema:check` 就报错。

## 路由：这条数据在哪个库？

`src/worker/shards.ts` 是唯一回答这个问题的模块：

- **表格 id → 分片**：`findDatabaseShard` / `requireDatabaseShard`（逐分片探测 `databases.id`，
  isolate 内缓存 5 分钟）；访问检查 `requireDatabaseAccess` 会把命中的库钉在 `ctx.db`，
  路由里后续查询统一用 `tableDb(ctx)`；
- **实体反查归属**：`requireEntityShard(env, 'records', 'id', recordId)`（记录 / 字段 / 视图 /
  分享 / 视图分享 / 邀请 token / 附件 id 都能这样反查）；
- **跨分片扫描**：`forEachShard`（写操作，任一失败即抛）与 `forEachShardSafe`（读统计，
  某个分片挂了只记日志）；跨分片读先 `groupDatabaseShards` 分组，避免 N 张表 N 次探测；
- **分片注册表** `database_shards`（在用户库）：有哪些分片、各自服务哪一类表格、
  用了多少空间。表为空时运行时会退回 `wrangler.jsonc` 里绑定的主分片，所以首次部署
  即使还没登记也能正常工作。

新表格落在哪一片由 `pickShard(env, kind)` 决定：优先绑定分片（走 Worker 绑定最快），
其次挑当前用量最小的。试用表格只在 `trial` 分片里选，基础表格只在 `basic` 分片里选，
专业表格只在 `pro` 分片里选。

## 跨库没有外键

SQLite 的外键不能跨库，拆分之后：

- `databases` 内部的父子关系（记录 / 字段 / 视图 / 分享 / 备注…）仍然用
  `REFERENCES ... ON DELETE CASCADE`，删表格 = 一次 `DELETE FROM databases`；
- 指向用户库的列（`owner_id` / `user_id` / `created_by` 等）只是普通文本列，
  由应用层保证一致；
- 需要「JOIN 用户库」的地方改成**两次查询 + JS 合并**：
  成员 / 视图分享里的邮箱昵称（`loadMembers`、`loadViewShares`）、
  备注作者（`loadNotes`）、收件箱（`loadInboxMessages`）、表格列表的所有者名
  （`listDatabases`）都是这么做的；
- 用户库里的 `note_mentions` 保留，但**去掉了指向 `notes` 的外键**
  （见 `migrations/control/0013_note_mentions_rebuild.sql`）：备注在分片里，
  这条外键只会让「新增 @提醒」「删账号」报 `no such table: main.notes`。

## 增量同步（`database_changes`）

改动日志跟着表格走，`rev` 在**分片内部**自增：客户端拿着同一张表的 `since` 游标，
所以不需要全局序号（`headRev(db)` / `logChanges(db, ...)`）。

## 附件（R2）

`files` 行在分片里（`r2_key` 指向 R2 对象），上传 / 下载 / 删除都要先确定表格（或文件 id
所在的分片）；附件容量按表统计（`DATABASE_USAGE_SELECT` 只查本分片）。
「没有归属」的旧附件（`files.database_id IS NULL`，拆分前的遗留）在数据搬迁脚本里会
被跳过并提示，需要人工处理。

**R2 对象只在 `files` 行的 `r2_key` 里出现**，所以任何删 `files` 行的地方都必须先把对象删掉，
否则那个对象永远找不回来、R2 占用只涨不跌。统一走 `src/worker/attachments.ts`：

| 场景 | 入口 |
| --- | --- |
| 删记录（单条 / 批量 / 公开链接） | `routes/records.ts`、`routes/public.ts` |
| 编辑时把附件从格子里去掉 | 同上两个文件（只删「这次真的少掉的」附件 id） |
| 删掉「文件与媒体」列 | `routes/properties.ts` |
| 保留期清理过期的记录与附件 | `retention.ts`（按 `last_used_at`（回退 `updated_at` / `created_at`）判定，试用 1 年 / 基础 5 年；清理时容忍 R2 失败，下一轮再删） |
| 保留期清理「没有记录指着」的孤儿附件 | `retention.ts`（`files.database_id` 还在但记录已过期删掉的那些 `files` 行） |
| 删整张表格 / 注销账号 | `routes/databases.ts`、`admin.ts`（按 `database_id` / `owner_id` 一次清完） |

顺序是「先删 R2 对象、再删 `files` 行」；同一个 `r2_key` 被多行引用时（复制记录会克隆出
一份自己的 `files` 行）按引用计数处理，还有别的行指着就保留对象。

## 拆分已有数据（老部署升级）

```bash
# 1. 先把用户库里的表格数据搬到分片库，并核对行数（会打印每张表的对照）
node scripts/migrate-split-data.mjs --dry-run   # 只看要搬多少行（本地）
node scripts/migrate-split-data.mjs             # 真正搬（本地，等价于 npm run db:split）
node scripts/migrate-split-data.mjs --remote    # 线上（需要 wrangler 已登录或配好 API Token）

# 2. 搬完并核对通过后，跑迁移（0012 会 DROP 掉用户库里的旧表，并建分片注册表）
npm run db:migrate:remote
```

脚本是 `scripts/migrate-split-data.mjs`：按表格 id 分组导出 + `INSERT OR IGNORE` 导入，
重复执行安全。**顺序不能反**：先搬数据、再删旧表；某张表没搬干净时脚本会以退出码 1
结束并提示「先别跑迁移」。

## 后台「存储分片」

`/api/admin/shards*`（仅超级管理员，见 `src/worker/routes/shards.ts`）：列表 / 新建 /
挂载已有库 / 启停 / 摘除 / 刷新用量 + 账号下的 D1 库列表。新建、挂载与刷新用量走
Cloudflare API，需要 Worker secret：

```bash
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
npx wrangler secret put CLOUDFLARE_API_TOKEN   # 需要 Account > D1 > Edit
```

没配这两个 secret 时列表仍然可用（数据来自注册表 / 绑定），另外三个操作会返回 501
并在后台页面给出配置提示。

## 换账户 / 重建库后对齐 `database_id`

`database_id` 会随账户变，**库名不会变**，所以换 Cloudflare 账户或重建 D1 库之后，用
`scripts/sync-d1-ids.mjs` 按库名把 `wrangler.jsonc` 对齐就行（CI 的 `deploy` job 跑的就是它）：

```bash
node scripts/sync-d1-ids.mjs --create    # 按库名对齐；本账户里没有就现建（= npm run db:sync-ids -- --create）
node scripts/sync-d1-ids.mjs --check     # 只检查差异、不写文件
```

迁移目录不用跟着改：用户库永远是 `migrations/control`，分片库永远是 `migrations/tables`，
换库之后 `npm run db:migrate:remote` 会在新库上把这两个目录重放一遍。
