#!/usr/bin/env node
/**
 * 把用户库里的旧表格数据搬到表格分片库 —— 存储拆分的第一步。
 *
 * 为什么要单独一个脚本：表格数据原来和账号数据在同一个 D1 库（`env.DB`）里，
 * 拆分成「用户库 + 分片库」之后，**先把数据搬过去、核对完了，再跑迁移删掉旧表**
 * （见 migrations/control/0012_split_table_storage.sql 的文件头）。
 * 顺序反了就只能从备份里捞。
 *
 * 做法是「按表格 id 分组导出 + INSERT OR IGNORE 导入」：
 *   1. 从用户库读出所有表格（`databases` 的 id / kind），按类型分给基础 / 专业分片；
 *   2. 逐表（`databases` → `records` → … → `files`）把属于这些表格的行导出成
 *      `INSERT OR IGNORE` 语句，写进对应的分片库；
 *   3. 再数一遍两边的行数核对，最后打印「下一步该跑哪条迁移命令」。
 *
 * 用法：
 *   node scripts/migrate-split-data.mjs             # 本地（wrangler --local）
 *   node scripts/migrate-split-data.mjs --remote    # 线上（需 wrangler 已登录或配好 API Token）
 *   node scripts/migrate-split-data.mjs --dry-run   # 只统计要搬多少行，不写库
 *
 * 重复执行是安全的：`INSERT OR IGNORE` 不会重复写；表格已经搬完（用户库里没有
 * `databases` 表了）会直接提示「无需操作」。
 *
 * 注意：多分片部署（后台挂载了备用分片）时，本脚本只按「表格类型」把数据放进
 * wrangler.jsonc 里绑定的主分片；如果旧数据本来就分散在多个库里，请按
 * `database_shards` 注册表里的绑定关系手工调整。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const CONFIG = join(root, 'wrangler.jsonc');

const argv = process.argv.slice(2);
const remote = argv.includes('--remote');
const dryRun = argv.includes('--dry-run');

/** 搬去分片的表：顺序 = 父表在前（`databases` 先落，子表跟着） */
const MOVED_TABLES = [
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
];

/** 一次 `IN (...)` 里放多少个 id（D1 / SQLite 的绑定参数上限是 100） */
const ID_CHUNK = 90;
/** 一次 `--file` 里放多少条 INSERT（语句太长会拖慢 wrangler 的解析） */
const WRITE_CHUNK = 200;

/** wrangler.jsonc 里的 `binding → database_name` 映射（注释没法 JSON.parse，只能抠） */
function d1Bindings() {
  const text = readFileSync(CONFIG, 'utf8');
  const start = text.indexOf('"d1_databases"');
  if (start < 0) throw new Error('wrangler.jsonc 里找不到 d1_databases');
  const body = text.slice(start, text.indexOf(']', start));
  const bindings = {};
  for (const match of body.matchAll(/"binding"\s*:\s*"([^"]+)"[\s\S]*?"database_name"\s*:\s*"([^"]+)"/g)) {
    bindings[match[1]] = match[2];
  }
  return bindings;
}

/** SQL 字面量（导出的数据里既有字符串也有数字 / NULL） */
function quote(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function chunks(items, size) {
  const slices = [];
  for (let index = 0; index < items.length; index += size) slices.push(items.slice(index, index + size));
  return slices;
}

const workDir = mkdtempSync(join(tmpdir(), 'varysheet-split-'));

/** 把一段 SQL 交给 wrangler 执行（`--json` 保证输出只有结果，好解析） */
function runSqlFile(database, file, { yes = false } = {}) {
  const cliArgs = [
    WRANGLER,
    'd1',
    'execute',
    database,
    remote ? '--remote' : '--local',
    '--json',
    '--file',
    file,
  ];
  if (yes) cliArgs.push('-y'); // 写库时跳过「确认执行」的交互
  const result = spawnSync(process.execPath, cliArgs, { encoding: 'utf8' });
  const stdout = (result.stdout ?? '').trim();
  if (result.status !== 0) {
    throw new Error(`wrangler 执行失败（${database}）:\n${(result.stderr || stdout).trim()}`);
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`wrangler 的输出不是 JSON（${database}）:\n${stdout.slice(0, 500)}`);
  }
}

/** 读查询 */
function query(database, sql) {
  const file = join(workDir, 'query.sql');
  writeFileSync(file, `${sql.trim().replace(/;+$/, '')};\n`, 'utf8');
  const payload = runSqlFile(database, file);
  return (payload[0]?.results ?? []);
}

/** 写库（调用方负责切块） */
function write(database, statements) {
  if (!statements.length) return;
  const file = join(workDir, 'write.sql');
  writeFileSync(file, `${statements.join(';\n')};\n`, 'utf8');
  runSqlFile(database, file, { yes: true });
}

function countRows(database, table, key, ids) {
  let total = 0;
  for (const slice of chunks(ids, ID_CHUNK)) {
    const row = query(
      database,
      `SELECT COUNT(*) AS total FROM ${table} WHERE ${key} IN (${slice.map(quote).join(', ')})`,
    )[0];
    total += Number(row?.total ?? 0);
  }
  return total;
}

function main() {
  const bindings = d1Bindings();
  const control = bindings.DB;
  const shardByKind = { basic: bindings.DB_TABLES_BASIC, pro: bindings.DB_TABLES_PRO };
  if (!control) throw new Error('wrangler.jsonc 里没有用户库绑定（DB）');

  console.log(`目标：${remote ? '线上（--remote）' : '本地（--local）'}${dryRun ? ' · 只统计不写库' : ''}`);

  const tables = query(control, "SELECT name FROM sqlite_master WHERE type='table'").map((row) => row.name);
  if (!tables.includes('databases')) {
    console.log(`用户库 ${control} 里已经没有 \`databases\` 表 —— 数据早就搬完（迁移 0012 已执行），无需操作。`);
    return 0;
  }

  const rows = query(control, 'SELECT id, kind FROM databases');
  const byKind = { basic: [], pro: [] };
  for (const row of rows) (row.kind === 'pro' ? byKind.pro : byKind.basic).push(row.id);
  console.log(
    `用户库里共 ${rows.length} 张表格：基础 ${byKind.basic.length} 张 → ${shardByKind.basic}，` +
      `专业 ${byKind.pro.length} 张 → ${shardByKind.pro}`,
  );

  let failures = 0;
  for (const kind of ['basic', 'pro']) {
    const ids = byKind[kind];
    if (!ids.length) continue;
    const shard = shardByKind[kind];
    if (!shard) throw new Error(`wrangler.jsonc 里没有 ${kind} 分片的绑定（DB_TABLES_${kind.toUpperCase()}）`);

    for (const table of MOVED_TABLES) {
      if (!tables.includes(table)) continue; // 老库可能还没建过这张表（例如没启用邀请）
      const key = table === 'databases' ? 'id' : 'database_id';
      const expected = countRows(control, table, key, ids);
      if (!expected) continue;

      for (const slice of chunks(ids, ID_CHUNK)) {
        const batch = query(control, `SELECT * FROM ${table} WHERE ${key} IN (${slice.map(quote).join(', ')})`);
        if (!batch.length) continue;
        const columns = Object.keys(batch[0]);
        // 列名统一加双引号：`records."values"` 这类保留字不加引号会被 SQLite 拒绝
        const columnList = columns.map((column) => `"${column}"`).join(', ');
        const statements = batch.map(
          (row) =>
            `INSERT OR IGNORE INTO ${table} (${columnList}) VALUES (${columns
              .map((column) => quote(row[column]))
              .join(', ')})`,
        );
        if (dryRun) continue;
        for (const part of chunks(statements, WRITE_CHUNK)) write(shard, part);
      }

      if (dryRun) {
        console.log(`  · ${kind}/${table}: 待搬 ${expected} 行`);
        continue;
      }
      const moved = countRows(shard, table, key, ids);
      const ok = moved >= expected;
      if (!ok) failures += 1;
      console.log(`  ${ok ? '✓' : '✗'} ${kind}/${table}: 用户库 ${expected} 行 → 分片 ${moved} 行`);
    }
  }

  // `files.database_id` 为 NULL 的是「早期没有归属」的附件：分片里放不下，单独提示
  if (tables.includes('files')) {
    const orphan = query(control, 'SELECT COUNT(*) AS total FROM files WHERE database_id IS NULL')[0];
    if (Number(orphan?.total ?? 0) > 0) {
      console.log(`  ! 有 ${orphan.total} 条 files 的 database_id 为空（没有归属的旧附件），没有搬走，请手工处理`);
    }
  }

  if (dryRun) {
    console.log('\n（--dry-run：什么都没有写）');
    return 0;
  }
  if (failures) {
    console.error(`\n有 ${failures} 张表没有搬干净 —— 先别跑迁移 0012（它会删掉旧表），查清上面的 ✗ 再重跑本脚本。`);
    return 1;
  }
  console.log('\n数据已经搬完并核对通过。下一步（会删掉用户库里的旧表）：');
  console.log(remote ? '  npm run db:migrate:remote' : '  npm run db:migrate:local');
  return 0;
}

let code = 1;
try {
  code = main();
} catch (error) {
  console.error(`\n迁移失败：${error instanceof Error ? error.message : String(error)}`);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
process.exit(code);
