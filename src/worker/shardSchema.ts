/**
 * 分片库（表格库）的建表脚本 —— 只放纯字符串，不碰数据库。
 *
 * 存储拆分之后，用户库（`migrations/control/`）里只留「账号 / 会话 / 站点设置 /
 * 购买记录 / @提醒」这些全局数据，**表格数据全部分片化**：
 *
 *   databases / database_members / properties / records / views / shares /
 *   view_shares / cell_edits / notes / database_changes / invites / files
 *
 * 每个分片库的结构都一样（就是下面这段 DDL），所以「动态新建一个 D1 库 + 执行这段 DDL」
 * 就得到一个可以立刻挂载的备用分片（见 `shards.ts` 的 `createShardDatabase`）。
 *
 * 建表脚本只有这一份：管理员后台新建分片时执行的和 `wrangler d1 migrations apply`
 * 用的是同一段 SQL（`scripts/sync-shard-schema.mjs` 会把它写成迁移文件），
 * 不会出现「代码建的表」和「迁移建的表」不一致。
 *
 * 注意：跨库不设外键（`owner_id` / `user_id` 指向用户库里的 `users.id`，
 * SQLite 没法跨库约束），所以原来的 `REFERENCES users(id)` 全部去掉；
 * 「表格内部」的父子关系（记录 / 字段 / 视图…）仍然保留外键 + ON DELETE CASCADE。
 */

/** 一张分片库里包含的所有表 */
export const SHARD_TABLES = [
  'databases',
  'database_members',
  'properties',
  'records',
  'views',
  'shares',
  'view_shares',
  'cell_edits',
  'notes',
  'database_changes',
  'invites',
  'files',
] as const;

export type ShardTable = (typeof SHARD_TABLES)[number];

/** 判断某个 id 是否落在某个分片时用的列（`databases` 是主键，其余按 `database_id`） */
export const SHARD_TABLE_KEY: Record<ShardTable, string> = {
  databases: 'id',
  database_members: 'database_id',
  properties: 'database_id',
  records: 'database_id',
  views: 'database_id',
  shares: 'database_id',
  view_shares: 'database_id',
  cell_edits: 'database_id',
  notes: 'database_id',
  database_changes: 'database_id',
  invites: 'database_id',
  files: 'database_id',
};

/** 建表 / 建索引语句（**不带结尾分号**：逐条 prepare 执行，写 .sql 时再补） */
export const SHARD_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS databases (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  name        TEXT NOT NULL,
  icon        TEXT NOT NULL DEFAULT '📋',
  description TEXT NOT NULL DEFAULT '',
  is_archived INTEGER NOT NULL DEFAULT 0,
  is_locked   INTEGER NOT NULL DEFAULT 0,
  kind        TEXT NOT NULL DEFAULT 'basic',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_databases_owner ON databases(owner_id)`,
  `CREATE INDEX IF NOT EXISTS idx_databases_kind ON databases(kind)`,

  `CREATE TABLE IF NOT EXISTS database_members (
  id          TEXT PRIMARY KEY,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'editor',
  created_at  INTEGER NOT NULL,
  UNIQUE (database_id, user_id)
)`,
  `CREATE INDEX IF NOT EXISTS idx_members_user ON database_members(user_id)`,

  `CREATE TABLE IF NOT EXISTS properties (
  id          TEXT PRIMARY KEY,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,
  config      TEXT NOT NULL DEFAULT '{}',
  position    REAL NOT NULL DEFAULT 0,
  width       INTEGER NOT NULL DEFAULT 200,
  is_locked   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_properties_database ON properties(database_id, position)`,

  `CREATE TABLE IF NOT EXISTS records (
  id          TEXT PRIMARY KEY,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  "values"    TEXT NOT NULL DEFAULT '{}',
  position    REAL NOT NULL DEFAULT 0,
  created_by  TEXT,
  updated_by  TEXT,
  is_archived INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_records_database ON records(database_id, position)`,

  `CREATE TABLE IF NOT EXISTS views (
  id          TEXT PRIMARY KEY,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'table',
  config      TEXT NOT NULL DEFAULT '{}',
  position    REAL NOT NULL DEFAULT 0,
  is_locked   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_views_database ON views(database_id, position)`,

  `CREATE TABLE IF NOT EXISTS shares (
  id          TEXT PRIMARY KEY,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  token       TEXT NOT NULL UNIQUE,
  permission  TEXT NOT NULL DEFAULT 'view',
  created_by  TEXT,
  expires_at  INTEGER,
  limit_edits INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_shares_database ON shares(database_id)`,

  `CREATE TABLE IF NOT EXISTS view_shares (
  id          TEXT PRIMARY KEY,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  view_id     TEXT NOT NULL REFERENCES views(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'viewer',
  created_by  TEXT,
  limit_edits INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  UNIQUE (view_id, user_id)
)`,
  `CREATE INDEX IF NOT EXISTS idx_view_shares_user ON view_shares(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_view_shares_database ON view_shares(database_id, created_at)`,

  `CREATE TABLE IF NOT EXISTS cell_edits (
  id          TEXT PRIMARY KEY,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  record_id   TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  editor_key  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE (editor_key, record_id, property_id)
)`,
  `CREATE INDEX IF NOT EXISTS idx_cell_edits_cell ON cell_edits(record_id, editor_key)`,
  `CREATE INDEX IF NOT EXISTS idx_cell_edits_database ON cell_edits(database_id)`,

  `CREATE TABLE IF NOT EXISTS notes (
  id          TEXT PRIMARY KEY,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  record_id   TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  author_id   TEXT,
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_notes_record ON notes(record_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_notes_database ON notes(database_id, created_at)`,

  `CREATE TABLE IF NOT EXISTS database_changes (
  rev         INTEGER PRIMARY KEY AUTOINCREMENT,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  record_id   TEXT,
  kind        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_database_changes_database ON database_changes(database_id, rev)`,
  `CREATE INDEX IF NOT EXISTS idx_database_changes_created ON database_changes(created_at)`,

  `CREATE TABLE IF NOT EXISTS invites (
  id          TEXT PRIMARY KEY,
  token       TEXT NOT NULL UNIQUE,
  email       TEXT NOT NULL,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  view_id     TEXT NOT NULL REFERENCES views(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'viewer',
  limit_edits INTEGER NOT NULL DEFAULT 0,
  invited_by  TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  accepted_at INTEGER
)`,
  `CREATE INDEX IF NOT EXISTS idx_invites_email ON invites(email, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_invites_database ON invites(database_id, created_at)`,

  `CREATE TABLE IF NOT EXISTS files (
  id          TEXT PRIMARY KEY,
  database_id TEXT REFERENCES databases(id) ON DELETE CASCADE,
  record_id   TEXT,
  property_id TEXT,
  r2_key      TEXT NOT NULL,
  name        TEXT NOT NULL,
  size        INTEGER NOT NULL DEFAULT 0,
  mime        TEXT NOT NULL DEFAULT 'application/octet-stream',
  uploaded_by TEXT,
  created_at  INTEGER NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_files_database ON files(database_id)`,
];

/**
 * 分片库的**增量升级语句**（`ALTER TABLE ... ADD COLUMN`）。
 *
 * 为什么需要它：`SHARD_SCHEMA` 里的 `CREATE TABLE IF NOT EXISTS` 对**已经建好**的库不会
 * 补上后加的列，所以结构有变化时必须单独补一条 ALTER。两处都要用到同一组语句：
 *   1) 运行时：管理员后台「新建 / 挂载分片」走 `ensureShardSchema()`
 *      （重复执行时「duplicate column name」会被跳过，见 `shards.ts`）；
 *   2) 迁移：`migrations/tables/0002_usage_tracking.sql`（老分片靠
 *      `wrangler d1 migrations apply <分片库>` 升级）。
 *
 * 注意：这里**故意不改** `SHARD_SCHEMA` 里那两张表的 `CREATE TABLE` —— 迁移文件已经跑过的库
 * 不会重跑 0001，而新库执行 0002 时如果表里已经有这一列就会报错。
 */
export const SHARD_COLUMN_MIGRATIONS: string[] = [
  // 记录 / 附件的「最后一次使用」时间（毫秒；0 = 还没记过，退回 updated_at / created_at）：
  // 保留期清理按它算「多久没有编辑或查询」，见 src/worker/usage.ts 与 src/worker/retention.ts
  `ALTER TABLE records ADD COLUMN last_used_at INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE files ADD COLUMN last_used_at INTEGER NOT NULL DEFAULT 0`,
];

/* ------------------------------------------------------------------ 用户库 */

/**
 * 用户库（`env.DB`）里应该有的表。
 * `note_mentions` 留在用户库：收件箱是「按人」查的，与某一张表格无关；
 * 里面冗余了 `database_id` / `record_id`，展示时再按分片去取表格名与记录标题。
 */
export const CONTROL_TABLES = [
  'users',
  'sessions',
  'email_codes',
  'settings',
  'table_purchases',
  'note_mentions',
  'database_shards',
] as const;

/**
 * 分片注册表：用户库里的 `database_shards`，记录「有哪些分片库、各自放哪一类表格、
 * 用了多少空间」，是运行时的路由依据（见 `shards.ts`）。
 */
export const SHARD_REGISTRY_TABLE = 'database_shards';

export const SHARD_REGISTRY_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS database_shards (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL DEFAULT 'basic',
  database_id TEXT NOT NULL,
  binding     TEXT,
  note        TEXT NOT NULL DEFAULT '',
  file_size   INTEGER,
  checked_at  INTEGER,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_database_shards_kind ON database_shards(kind, is_active)`,
  `CREATE INDEX IF NOT EXISTS idx_database_shards_database ON database_shards(database_id)`,
];

/**
 * 用户库里需要**重建**的旧表：它们的外键原来指向已经搬去分片的表。
 *
 * 跨库没有外键，而且 SQLite 只要父表不存在就会报 `no such table`（插入子表、
 * 删除父表上的行都会触发）—— `note_mentions.note_id` 指向 `notes` 就是这种情况：
 * 拆分之后 `notes` 在分片里，于是「新增 @提醒」和「删账号」都会 500。
 *
 * 重建方式是经典的 SQLite 三件套（建新表 → 搬数据 → 换名）。搬数据用
 * `INSERT OR IGNORE` + `UNIQUE (note_id, user_id)`，重复执行不会造出重复行。
 * 备注删除由分片里的外键负责（记录一删，备注跟着删），这里的 `note_id` 只是引用。
 */
export const CONTROL_TABLE_REBUILDS: string[] = [
  `CREATE TABLE IF NOT EXISTS note_mentions_rebuilt (
  id          TEXT PRIMARY KEY,
  note_id     TEXT NOT NULL,
  database_id TEXT NOT NULL,
  record_id   TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at     INTEGER,
  created_at  INTEGER NOT NULL,
  UNIQUE (note_id, user_id)
)`,
  `INSERT OR IGNORE INTO note_mentions_rebuilt (id, note_id, database_id, record_id, user_id, read_at, created_at)
  SELECT id, note_id, database_id, record_id, user_id, read_at, created_at FROM note_mentions`,
  `DROP TABLE IF EXISTS note_mentions`,
  `ALTER TABLE note_mentions_rebuilt RENAME TO note_mentions`,
  `CREATE INDEX IF NOT EXISTS idx_note_mentions_user ON note_mentions(user_id, read_at, created_at)`,
];

/**
 * 已经搬去分片的表：用户库里留着就是浪费 + 误写的隐患，迁移脚本会 DROP 掉。
 * （顺序反着来：先删引用方，再删被引用的 `databases`。）
 */
export const MOVED_OUT_TABLES = [
  'invites',
  'database_changes',
  'notes',
  'cell_edits',
  'view_shares',
  'shares',
  'views',
  'records',
  'properties',
  'database_members',
  'files',
  'databases',
] as const;

/**
 * 分片库的类型标签：一张分片只服务一种表格类型（试用 / 基础 / 专业）。
 * 试用表格有专门的试用分片库（绑定 `DB_TABLES_TRIAL`，库名 `cloudnotion-tables-trial`）。
 */
export const SHARD_KINDS = ['trial', 'basic', 'pro'] as const;
export type ShardKind = (typeof SHARD_KINDS)[number];

/** D1 单个数据库的硬上限（10GB）：接近时该新建备用分片了 */
export const D1_DATABASE_LIMIT_BYTES = 10 * 1024 * 1024 * 1024;

/** 用量超过这个比例就提示管理员「准备加库」（默认 85%） */
export const SHARD_FILL_WARN_RATIO = 0.85;
