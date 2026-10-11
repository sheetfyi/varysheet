#!/usr/bin/env node
/**
 * 把 `src/worker/shardSchema.ts` 里的建表 SQL 同步成迁移文件：
 *
 *   migrations/tables/0001_init.sql            分片库（表格库）的全部建表语句
 *   migrations/control/0012_split_table_storage.sql
 *                                              用户库里「搬走表格数据 + 登记分片表」的迁移
 *   migrations/control/0013_note_mentions_rebuild.sql
 *                                              用户库里「去掉指向分片库的旧外键」的收尾迁移
 *
 * 另外还会**核对** `migrations/tables/0002_usage_tracking.sql`（手写的「后加的列」迁移）
 * 是否覆盖了 `src/worker/shardSchema.ts` 里的 `SHARD_COLUMN_MIGRATIONS`：
 * 老分片库靠那个迁移文件升级，两边不一致就会出现「运行时有这一列、迁移没加」的漂移。
 *
 * 为什么要有这个脚本：建表脚本必须只有一份 —— 运行时「管理员新建备用分片」执行的是
 * `SHARD_SCHEMA`，而 `wrangler d1 migrations apply` 执行的是 .sql 文件。手抄两份迟早
 * 会漂移，所以这里从 TS 源码里把模板字符串抠出来写成 .sql。
 *
 * 用法：
 *   node scripts/sync-shard-schema.mjs            # 生成 / 覆盖
 *   node scripts/sync-shard-schema.mjs --check    # 只检查是否需要重新生成（CI 用）
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_TS = join(root, 'src', 'worker', 'shardSchema.ts');
const checkOnly = process.argv.includes('--check');

const source = readFileSync(SCHEMA_TS, 'utf8');

/** 抽出一个 `export const NAME = [ ... ]` 里的模板字符串（SQL 语句） */
function sqlStatements(name) {
  return strings(name, /`([^`]*)`/g);
}

/** 抽出一个 `export const NAME = [ ... ]` 里的单引号字符串（表名等） */
function quotedNames(name) {
  return strings(name, /'([^']*)'/g);
}

function strings(name, pattern) {
  const start = source.indexOf(`export const ${name}`);
  if (start < 0) throw new Error(`src/worker/shardSchema.ts 里找不到 ${name}`);
  const open = source.indexOf('[', start);
  if (open < 0) throw new Error(`${name} 不是标准的数组字面量`);
  const rest = source.slice(open);
  const close = /\n\][^\n]*;/.exec(rest);
  if (!close) throw new Error(`${name} 的数组没有正常结束`);
  const body = rest.slice(0, close.index);
  return [...body.matchAll(pattern)].map((match) => match[1]);
}

/** 去掉语句结尾分号再加上一个，保证每个文件都是「一条语句一个分号」 */
function terminated(statement) {
  return `${statement.trim().replace(/;+$/, '')};`;
}

function block(statements) {
  return statements.map(terminated).join('\n\n');
}

/* ------------------------------------------------------------ 分片库建表脚本 */

const shardSql = [
  '-- Varysheet - 表格分片库（试用表格 / 基础表格 / 专业表格）初始化',
  '--',
  '-- 每个分片库都是一样的结构（表格 / 字段 / 记录 / 视图 / 分享 / 备注 / 改动日志 /',
  '-- 附件 / 邀请 + 各自的索引）。管理员在后台新建备用分片时，执行的是同一份 DDL',
  '-- （见 src/worker/shards.ts 的 ensureShardSchema）。',
  '--',
  '-- ⚠️ 本文件由 scripts/sync-shard-schema.mjs 从 src/worker/shardSchema.ts 生成，',
  '--    需要改结构请改那个文件再重新生成，不要手改这里。',
  '--',
  '-- 应用方式（每个分片库各执行一次）：',
  '--   npx wrangler d1 migrations apply cloudnotion-tables-trial --remote',
  '--   npx wrangler d1 migrations apply cloudnotion-tables-basic --remote',
  '--   npx wrangler d1 migrations apply cloudnotion-tables-pro --remote',
  '',
  block(sqlStatements('SHARD_SCHEMA')),
  '',
].join('\n');

/* -------------------------------------------------------- 用户库的拆分迁移 */

const movedOut = quotedNames('MOVED_OUT_TABLES');
const controlSql = [
  '-- Varysheet - 表格数据搬去独立分片库（用户库瘦身）',
  '--',
  '-- 背景：表格数据（表格 / 字段 / 记录 / 视图 / 分享 / 备注 / 改动日志 / 附件 / 邀请）',
  '-- 原来和账号数据挤在同一个 D1 库里，10GB 上限一到就谁都写不进去。现在把表格数据',
  '-- 拆到独立的分片库（见 src/worker/shards.ts、docs/storage.md），用户库只留账号 /',
  '-- 会话 / 站点设置 / 购买记录 / @提醒 和下面的分片注册表。',
  '--',
  '-- ⚠️ 顺序很重要：**先**跑 `node scripts/migrate-split-data.mjs` 把数据搬到分片库，',
  '--    确认搬完（脚本会打印核对结果）**再**执行本迁移；本迁移会把用户库里的旧表删掉。',
  '--',
  '-- 迁移是幂等的：`DROP TABLE IF EXISTS` / `CREATE TABLE IF NOT EXISTS` 重复执行都安全。',
  '-- ⚠️ 本文件由 scripts/sync-shard-schema.mjs 生成，请勿手改（改 src/worker/shardSchema.ts）。',
  '',
  '-- 1. 删掉已经搬去分片库的表（顺序：先引用方，后被引用的 databases）',
  ...movedOut.map((table) => terminated(`DROP TABLE IF EXISTS ${table}`)),
  '',
  '-- 2. 分片注册表：有哪些分片库、各自放哪一类表格、用了多少空间',
  block(sqlStatements('SHARD_REGISTRY_SCHEMA')),
  '',
  '-- 3. 首次部署说明',
  '--    注册表为空时，运行时会退回 wrangler.jsonc 里绑定的主分片（DB_TABLES_TRIAL /',
  '--    DB_TABLES_BASIC / DB_TABLES_PRO），所以这一步之后站点立刻可用。要让后台看到用量、',
  '--    或者挂载动态新建的备用分片，请在「后台 → 存储分片」里挂载，或直接执行：',
  '--',
  '--    INSERT INTO database_shards',
  '--      (id, name, kind, database_id, binding, note, file_size, checked_at, is_active, created_at, updated_at)',
  '--    VALUES',
  '--      (lower(hex(randomblob(16))), \'cloudnotion-tables-trial\', \'trial\',',
  '--       \'<试用分片库的 database_id>\', \'DB_TABLES_TRIAL\', \'主分片\', NULL, NULL, 1,',
  '--       CAST(strftime(\'%s\',\'now\') AS INTEGER) * 1000, CAST(strftime(\'%s\',\'now\') AS INTEGER) * 1000),',
  '--      (lower(hex(randomblob(16))), \'cloudnotion-tables-basic\', \'basic\',',
  '--       \'<基础分片库的 database_id>\', \'DB_TABLES_BASIC\', \'主分片\', NULL, NULL, 1,',
  '--       CAST(strftime(\'%s\',\'now\') AS INTEGER) * 1000, CAST(strftime(\'%s\',\'now\') AS INTEGER) * 1000);',
  '',
].join('\n');

/* ------------------------------------------------------------------- 写文件 */

/**
 * 用户库的收尾迁移：把指向分片库的旧外键重建掉（`note_mentions.note_id → notes`）。
 * 单独一个文件，是因为它必须在 0012（删掉旧表）之后跑，而且老部署里 0012 已经
 * 应用过了 —— 新迁移才会被执行。
 */
const rebuildSql = [
  '-- Varysheet - 去掉用户库里指向分片库的旧外键',
  '--',
  '-- `note_mentions` 留在用户库（收件箱是按人查的），但它的 `note_id` 原来外键指向',
  '-- 用户库里的 `notes`；表格数据拆去分片库之后（见 0012）那个表已经不在用户库了，',
  '-- 于是「新增 @提醒」和「删除账号」都会报 `no such table: main.notes`。',
  '-- 这里把这张表按新结构（去掉指向 notes 的外键）重建一次，数据原样搬过去。',
  '--',
  '-- 幂等：`INSERT OR IGNORE` 配上 `UNIQUE (note_id, user_id)`，重复执行不会重复数据。',
  '-- ⚠️ 本文件由 scripts/sync-shard-schema.mjs 生成，请勿手改（改 src/worker/shardSchema.ts）。',
  '',
  block(sqlStatements('CONTROL_TABLE_REBUILDS')),
  '',
].join('\n');

const outputs = [
  { file: join(root, 'migrations', 'tables', '0001_init.sql'), sql: shardSql },
  { file: join(root, 'migrations', 'control', '0012_split_table_storage.sql'), sql: controlSql },
  { file: join(root, 'migrations', 'control', '0013_note_mentions_rebuild.sql'), sql: rebuildSql },
];

let stale = false;
for (const output of outputs) {
  const label = relative(root, output.file).replaceAll('\\', '/');
  const current = existsSync(output.file) ? readFileSync(output.file, 'utf8') : null;
  if (current === output.sql) {
    console.log(`✓ ${label} 已是最新`);
    continue;
  }
  stale = true;
  if (checkOnly) {
    console.error(`✗ ${label} 与 src/worker/shardSchema.ts 不一致，请运行 node scripts/sync-shard-schema.mjs`);
    continue;
  }
  writeFileSync(output.file, output.sql, 'utf8');
  console.log(`${current === null ? '＋' : '↻'} 已生成 ${label}`);
}

/* ----------------------------------------- 「后加的列」迁移是否覆盖了运行时升级语句 */

/**
 * `SHARD_COLUMN_MIGRATIONS` 是运行时给「新建 / 挂载分片 + 定时清理」用的升级语句，
 * `migrations/tables/0002_usage_tracking.sql` 是老分片库走 `wrangler d1 migrations apply`
 * 用的 —— 两边必须一致，否则线上会出现「代码里有这一列、迁移没加」的漂移。
 * 这里只做核对（那两份文件是手写的，含注释，不能整段生成）。
 */
const columnMigrationFile = join(root, 'migrations', 'tables', '0002_usage_tracking.sql');
const columnStatements = sqlStatements('SHARD_COLUMN_MIGRATIONS');
if (!columnStatements.length) {
  console.error('✗ src/worker/shardSchema.ts 里的 SHARD_COLUMN_MIGRATIONS 是空的（或没找到）');
  process.exitCode = 1;
} else {
  const fileSql = existsSync(columnMigrationFile) ? readFileSync(columnMigrationFile, 'utf8') : '';
  const label = relative(root, columnMigrationFile).replaceAll('\\', '/');
  const normalize = (sql) => sql.replace(/\s+/g, ' ').trim().replace(/;+$/, '').toLowerCase();
  const haystack = normalize(fileSql);
  const missing = columnStatements.filter((statement) => !haystack.includes(normalize(statement)));
  if (missing.length) {
    console.error(`✗ ${label} 缺少 SHARD_COLUMN_MIGRATIONS 里的语句：`);
    for (const statement of missing) console.error(`    - ${statement}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ ${label} 覆盖了 SHARD_COLUMN_MIGRATIONS（${columnStatements.length} 条）`);
  }
}

if (checkOnly && stale) process.exit(1);
