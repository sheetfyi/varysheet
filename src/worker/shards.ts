/**
 * 分片路由：表格数据被拆到多个 D1 库（分片）后，「这条数据在哪个库」的判定都走这里。
 *
 * 分工（存储拆分的整体设计见 docs/storage.md）：
 *   用户库 `env.DB`        账号 / 会话 / 站点设置 / 购买记录 / @提醒（`note_mentions`）/
 *                          试用表格的邀请赠额（`trial_table_grants`）/ **分片注册表**
 *   表格分片 `databases…`  表格、字段、记录、视图、分享、备注、改动日志、附件、邀请
 *
 * 分片的两种访问方式：
 *   1. **绑定**：`env.DB_TABLES_TRIAL` / `env.DB_TABLES_BASIC` / `env.DB_TABLES_PRO`
 *      （wrangler.jsonc 里配的），零额外开销，主分片走这里；
 *   2. **HTTP API**：按 `database_id` 走 Cloudflare REST 接口（`d1Remote.ts`），
 *      管理员在后台动态新建的备用分片只能这样访问（Worker 的绑定在部署时固定）。
 *
 * 路由信息存在用户库的 `database_shards` 表里，按 isolate 缓存 15 秒；表格 id → 分片
 * 的映射再单独缓存 5 分钟（表格建好之后就不会再搬家了）。
 */
import { asTableKind, tableKindLabel } from '../shared/tableKind';
import type { TableKind } from '../shared/types';
import {
  applySqlStatements,
  createRemoteDatabase,
  d1Credentials,
  D1_CREDENTIALS_HINT,
  fetchRemoteDatabaseInfo,
  listRemoteDatabases,
  remoteD1,
  type RemoteDatabaseInfo,
} from './d1Remote';
import {
  badRequest,
  conflict,
  HttpError,
  newId,
  notFound,
  sqlNullableNumber,
  sqlNumber,
  sqlString,
  type SqlRow,
} from './http';
import {
  D1_DATABASE_LIMIT_BYTES,
  SHARD_COLUMN_MIGRATIONS,
  SHARD_FILL_WARN_RATIO,
  SHARD_REGISTRY_TABLE,
  SHARD_SCHEMA,
  SHARD_TABLES,
  type ShardTable,
} from './shardSchema';
import type { Env, RequestContext } from './types';

/** 分片注册表在 isolate 里的缓存时长 */
const SHARD_LIST_TTL_MS = 15_000;
/** 「某条数据在哪个分片」的缓存时长 */
const SHARD_LOOKUP_TTL_MS = 5 * 60_000;

/** 分片注册表的一行 */
export interface ShardRecord {
  id: string;
  name: string;
  kind: TableKind;
  /** Cloudflare D1 的 database_id（uuid）；绑定兜底分片没有这个值 */
  databaseId: string;
  /** 走 Worker 绑定时填绑定名（`DB_TABLES_TRIAL` / `DB_TABLES_BASIC` / `DB_TABLES_PRO`），否则为 null（走 HTTP 接口） */
  binding: string | null;
  note: string;
  /** 最近一次读到的库大小（字节）；没读到为 null */
  fileSize: number | null;
  checkedAt: number | null;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 分片 + 它的库句柄（绑定或 HTTP 接口拿到的 `D1Database`） */
export interface ShardHandle {
  shard: ShardRecord;
  db: D1Database;
}

/** 允许用来探测归属的列（白名单：这几个列名会拼进 SQL，不能由调用方随便传） */
const PROBE_COLUMNS = ['id', 'database_id', 'token', 'view_id', 'email'] as const;
export type ProbeColumn = (typeof PROBE_COLUMNS)[number];

let listCache: { at: number; rows: ShardRecord[] } | null = null;
const lookupCache = new Map<string, { at: number; shardId: string }>();

/** 注册表被改过（后台加库 / 停用）之后清缓存，下一个请求立刻生效 */
export function invalidateShards(): void {
  listCache = null;
  lookupCache.clear();
}

function shardFromRow(row: SqlRow): ShardRecord {
  return {
    id: sqlString(row, 'id'),
    name: sqlString(row, 'name'),
    kind: asTableKind(sqlString(row, 'kind', 'basic')),
    databaseId: sqlString(row, 'database_id'),
    binding: sqlString(row, 'binding') || null,
    note: sqlString(row, 'note'),
    fileSize: sqlNullableNumber(row, 'file_size'),
    checkedAt: sqlNullableNumber(row, 'checked_at'),
    isActive: sqlNumber(row, 'is_active', 1) !== 0,
    createdAt: sqlNumber(row, 'created_at'),
    updatedAt: sqlNumber(row, 'updated_at'),
  };
}

/**
 * 注册表读不出来时的兜底：wrangler.jsonc 里绑定的主分片。
 * 这样「刚部署完还没登记注册表」或者「注册表迁移没跑」也能正常用（表格能读能写），
 * 只是看不到用量、也没法自动往备用分片分流。
 */
function boundShards(env: Env): ShardRecord[] {
  const now = Date.now();
  const rows: ShardRecord[] = [];
  const bound: Array<[string, TableKind, D1Database | undefined]> = [
    ['DB_TABLES_TRIAL', 'trial', env.DB_TABLES_TRIAL],
    ['DB_TABLES_BASIC', 'basic', env.DB_TABLES_BASIC],
    ['DB_TABLES_PRO', 'pro', env.DB_TABLES_PRO],
  ];
  for (const [binding, kind, database] of bound) {
    if (!database) continue;
    rows.push({
      id: `bound:${binding}`,
      name: binding,
      kind,
      databaseId: '',
      binding,
      note: '绑定上的主分片（注册表不可用时的兜底）',
      fileSize: null,
      checkedAt: null,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
  }
  return rows;
}

/**
 * 把「绑定上有、注册表里没有」的分片补进列表：绑定分片是代码里钉死的，注册表只是路由
 * 信息，漏登记（或者老部署没跑 0012 里那段登记示例）不该让这一类表格彻底不可用。
 * 注册表为空 / 读失败时等价于直接用绑定分片。
 */
function mergeBoundShards(env: Env, rows: ShardRecord[]): ShardRecord[] {
  const bound = boundShards(env);
  if (!rows.length) return bound;
  const registered = new Set(rows.map((row) => row.binding ?? ''));
  const missing = bound.filter((row) => !registered.has(row.binding ?? ''));
  return missing.length ? [...rows, ...missing] : rows;
}

/**
 * 全部分片（含停用的，调用方按 `isActive` 过滤）。注册表为空 / 读取失败时退回绑定分片。
 */
export async function listShards(env: Env, options: { refresh?: boolean } = {}): Promise<ShardRecord[]> {
  if (!options.refresh && listCache && Date.now() - listCache.at < SHARD_LIST_TTL_MS) {
    return listCache.rows;
  }
  let rows: ShardRecord[] = [];
  try {
    const { results } = await env.DB.prepare(
      `SELECT * FROM ${SHARD_REGISTRY_TABLE} ORDER BY created_at ASC, name ASC`,
    ).all<SqlRow>();
    rows = (results ?? []).map(shardFromRow);
  } catch (error) {
    console.warn('读取分片注册表失败，先只用绑定上的分片：', error);
  }
  rows = mergeBoundShards(env, rows);
  listCache = { at: Date.now(), rows };
  return rows;
}

/** 正在使用的分片 */
export async function activeShards(env: Env, kind?: TableKind): Promise<ShardRecord[]> {
  const rows = await listShards(env);
  return rows.filter((row) => row.isActive && (!kind || row.kind === kind));
}

/* ---------------------------------------------------------------- 拿到库句柄 */

const remoteClients = new Map<string, D1Database>();

/**
 * 分片 → `D1Database`。
 *
 * 同步函数：绑定查找不需要 IO，HTTP 客户端也只是构造一个对象（真正访问时才发请求），
 * 所以调用点可以写成 `const db = shardDb(env, shard)`。
 */
export function shardDb(env: Env, shard: ShardRecord): D1Database {
  if (shard.binding) {
    const holder = env as unknown as Record<string, D1Database | undefined>;
    const bound = holder[shard.binding];
    if (!bound) {
      throw new HttpError(
        503,
        'shard_binding_missing',
        `分片 ${shard.name} 声明了绑定 ${shard.binding}，但 Worker 里没有这个绑定（检查 wrangler.jsonc 后重新部署）`,
      );
    }
    return bound;
  }
  if (!shard.databaseId) {
    throw new HttpError(503, 'shard_database_missing', `分片 ${shard.name} 既没有绑定也没有 database_id`);
  }
  const credentials = d1Credentials(env);
  if (!credentials) {
    throw new HttpError(
      503,
      'd1_api_not_configured',
      `${D1_CREDENTIALS_HINT}（分片 ${shard.name} 只能走 HTTP 接口访问）`,
    );
  }
  const key = `${credentials.accountId}:${shard.databaseId}`;
  let client = remoteClients.get(key);
  if (!client) {
    client = remoteD1(credentials, shard.databaseId);
    remoteClients.set(key, client);
  }
  return client;
}

/** 分片里能不能查到这条数据（`SELECT 1 … LIMIT 1`，走主键 / 索引） */
async function shardHolds(
  env: Env,
  shard: ShardRecord,
  table: ShardTable,
  column: ProbeColumn,
  value: string,
): Promise<boolean> {
  const row = await shardDb(env, shard)
    .prepare(`SELECT 1 AS hit FROM ${table} WHERE ${column} = ? LIMIT 1`)
    .bind(value)
    .first<SqlRow>();
  return Boolean(row);
}

function assertProbe(table: ShardTable, column: ProbeColumn): void {
  if (!SHARD_TABLES.includes(table)) throw new HttpError(500, 'bad_probe', `未知的分片表：${table}`);
  if (!PROBE_COLUMNS.includes(column)) throw new HttpError(500, 'bad_probe', `未知的探测列：${column}`);
}

/**
 * 按「表 + 列 + 值」找出数据所在的分片（逐分片探测，命中即止）。
 * 结果按 isolate 缓存（表格不会搬家）；探测本身并发发出去，分片多时也不会串行等待。
 */
export async function findEntityShard(
  env: Env,
  table: ShardTable,
  column: ProbeColumn,
  value: string,
  options: { refresh?: boolean } = {},
): Promise<ShardHandle | null> {
  if (!value) return null;
  assertProbe(table, column);
  const cacheKey = `${table}:${column}:${value}`;
  if (!options.refresh) {
    const cached = lookupCache.get(cacheKey);
    if (cached && Date.now() - cached.at < SHARD_LOOKUP_TTL_MS) {
      const shard = (await listShards(env)).find((row) => row.id === cached.shardId);
      if (shard) return { shard, db: shardDb(env, shard) };
      lookupCache.delete(cacheKey);
    }
  }

  const shards = await activeShards(env);
  const hits = await Promise.all(
    shards.map(async (shard) => {
      try {
        return (await shardHolds(env, shard, table, column, value)) ? shard : null;
      } catch (error) {
        // 某个分片还没建表 / 连不上时不该让整次探测失败：跳过它，只在命中时缓存
        console.warn(`探测分片 ${shard.name} 失败：`, error);
        return null;
      }
    }),
  );
  const shard = hits.find((row): row is ShardRecord => row !== null);
  if (!shard) {
    lookupCache.delete(cacheKey);
    return null;
  }
  lookupCache.set(cacheKey, { at: Date.now(), shardId: shard.id });
  return { shard, db: shardDb(env, shard) };
}

/** 同上，但找不到就抛 404 / 503（绝大部分调用点都期望「必须找到」）。 */
export async function requireEntityShard(
  env: Env,
  table: ShardTable,
  column: ProbeColumn,
  value: string,
  message = '资源不存在',
): Promise<ShardHandle> {
  const handle = await findEntityShard(env, table, column, value);
  if (handle) return handle;
  // 一个分片都没有时，是配置问题（分片没挂载），别误报成 404
  if (!(await activeShards(env)).length) {
    throw new HttpError(503, 'no_shard_available', '没有可用的表格分片库，请在管理后台挂载一个');
  }
  throw notFound(message);
}

export type DatabaseShard = ShardHandle;

/** 某张表格（`databases` 行）在哪个分片；`null` = 找不到。 */
export function findDatabaseShard(
  env: Env,
  databaseId: string,
  options: { refresh?: boolean } = {},
): Promise<ShardHandle | null> {
  return findEntityShard(env, 'databases', 'id', databaseId, options);
}

/** 某张表格所在的分片；找不到抛 404（表格被删 / id 写错）。 */
export async function requireDatabaseShard(
  env: Env,
  databaseId: string,
  message = '表格不存在',
): Promise<ShardHandle> {
  const handle = await findDatabaseShard(env, databaseId);
  if (handle) return handle;
  if (!(await activeShards(env)).length) {
    throw new HttpError(503, 'no_shard_available', '没有可用的表格分片库，请在管理后台挂载一个');
  }
  throw notFound(message);
}

/** 便捷写法：某张表格所在分片的 `D1Database`（表格的所有数据都在同一个库里）。 */
export async function databaseDb(env: Env, databaseId: string, message?: string): Promise<D1Database> {
  return (await requireDatabaseShard(env, databaseId, message)).db;
}

/**
 * 当前请求的表格分片库：访问检查（`access.ts`）填好的 `ctx.db`。
 *
 * 路由里读写表格数据统一走这里；**没有先做访问检查**就调用会抛 500 ——
 * 这时还没确定表格在哪个分片，硬猜一个库只会更糟。
 */
export function tableDb(ctx: RequestContext): D1Database {
  const db = ctx.db;
  if (!db) {
    throw new HttpError(
      500,
      'table_scope_missing',
      '内部错误：读取表格数据前必须先做访问检查（requireDatabaseAccess / accessForXxx / databaseDb）',
    );
  }
  return db;
}

/**
 * 一批表格 id → 它们所在的分片（同一分片里的多张表格合并成一组）。
 *
 * 跨库没有 JOIN，跨表格的读（收件箱、记录标题…）只能「先分组、再逐分片查、最后在 JS 里合并」，
 * 这个函数就负责第一步。归属探测本身按 5 分钟缓存，重复调用不会反复打库。
 */
export async function groupDatabaseShards(
  env: Env,
  databaseIds: readonly string[],
): Promise<Map<string, { shard: ShardRecord; db: D1Database; databaseIds: string[] }>> {
  const ids = [...new Set(databaseIds)].filter(Boolean);
  const groups = new Map<string, { shard: ShardRecord; db: D1Database; databaseIds: string[] }>();
  if (!ids.length) return groups;
  const handles = await Promise.all(ids.map((id) => findDatabaseShard(env, id)));
  ids.forEach((id, index) => {
    const handle = handles[index];
    if (!handle) return; // 表格已经不存在了：和它相关的数据一并跳过
    const group = groups.get(handle.shard.id) ?? { shard: handle.shard, db: handle.db, databaseIds: [] };
    group.databaseIds.push(id);
    groups.set(handle.shard.id, group);
  });
  return groups;
}

/* ------------------------------------------------------------------ 选择分片 */

/**
 * 给**新建**的表格挑一个分片：绑定分片优先（快），其次挑目前用量最小的。
 * 同类型的表格永远落在同一批分片里，所以按表格类型就能确定候选范围。
 */
export async function pickShard(env: Env, kind: TableKind): Promise<ShardRecord> {
  const shards = await activeShards(env, kind);
  if (!shards.length) {
    throw new HttpError(
      503,
      'no_shard_available',
      `没有可用的${tableKindLabel(kind)}分片库：请到「后台 → 存储分片」新建一个 D1 库并挂载`,
    );
  }
  return [...shards].sort((a, b) => {
    const boundFirst = Number(Boolean(b.binding)) - Number(Boolean(a.binding));
    if (boundFirst !== 0) return boundFirst;
    return (a.fileSize ?? 0) - (b.fileSize ?? 0);
  })[0];
}

/**
 * 在所有分片上跑同一段逻辑（跨分片统计 / 清理用）。
 * 任何一个分片失败都会抛出去：写操作必须知道全部成功才安全。
 * 只读统计请用 {@link forEachShardSafe}。
 */
export async function forEachShard<T>(
  env: Env,
  fn: (shard: ShardRecord, db: D1Database) => Promise<T>,
): Promise<Array<{ shard: ShardRecord; value: T }>> {
  const shards = await activeShards(env);
  return Promise.all(
    shards.map(async (shard) => ({ shard, value: await fn(shard, shardDb(env, shard)) })),
  );
}

export interface ShardScanResult<T> {
  shard: ShardRecord;
  value: T | null;
  error: unknown;
}

/**
 * 同 {@link forEachShard}，但某个分片挂掉 / 超时不影响其它分片（值为 null）。
 * 用于列表、统计这类「尽力而为」的读操作。
 */
export async function forEachShardSafe<T>(
  env: Env,
  fn: (shard: ShardRecord, db: D1Database) => Promise<T>,
): Promise<ShardScanResult<T>[]> {
  const shards = await activeShards(env);
  return Promise.all(
    shards.map(async (shard) => {
      try {
        return { shard, value: await fn(shard, shardDb(env, shard)), error: null };
      } catch (error) {
        console.error(`分片 ${shard.name} 查询失败：`, error);
        return { shard, value: null, error };
      }
    }),
  );
}

/* -------------------------------------------------------------- 注册表管理 */

/** 访问 Cloudflare API 的凭据（没配置就报一句能照着做的错） */
export function requireD1Credentials(env: Env) {
  const credentials = d1Credentials(env);
  if (!credentials) throw new HttpError(501, 'd1_api_not_configured', D1_CREDENTIALS_HINT);
  return credentials;
}

/**
 * Cloudflare API 的凭据配好了没（后台「存储分片」页面据此决定要不要禁用
 * 「新建 / 挂载 / 刷新用量」这几个按钮）。
 */
export function d1ApiConfigured(env: Env): boolean {
  return Boolean(d1Credentials(env));
}

export interface ShardInput {
  name: string;
  kind: TableKind;
  databaseId: string;
  binding?: string | null;
  note?: string;
  isActive?: boolean;
}

/** 往分片注册表里加一行（管理员后台挂载 / 新建分片时调用）。 */
export async function registerShard(env: Env, input: ShardInput): Promise<ShardRecord> {
  const name = input.name.trim();
  const databaseId = input.databaseId.trim();
  if (!name) throw badRequest('分片名称不能为空');
  if (!databaseId) throw badRequest('database_id 不能为空');
  const now = Date.now();
  const shard: ShardRecord = {
    id: newId(),
    name,
    kind: asTableKind(input.kind),
    databaseId,
    binding: input.binding?.trim() || null,
    note: (input.note ?? '').trim(),
    fileSize: null,
    checkedAt: null,
    isActive: input.isActive ?? true,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await env.DB.prepare(
      `INSERT INTO ${SHARD_REGISTRY_TABLE}
         (id, name, kind, database_id, binding, note, file_size, checked_at, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
    )
      .bind(
        shard.id,
        shard.name,
        shard.kind,
        shard.databaseId,
        shard.binding,
        shard.note,
        shard.isActive ? 1 : 0,
        shard.createdAt,
        shard.updatedAt,
      )
      .run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/UNIQUE/i.test(message)) {
      throw conflict(`分片 ${shard.name} 或 ${shard.databaseId} 已经登记过了`, 'shard_exists');
    }
    throw error;
  }

  invalidateShards();
  return shard;
}

/** 分片是不是真的登记在注册表里（注册表为空时的绑定兜底分片改不了、也摘不掉） */
async function shardIsRegistered(env: Env, id: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT 1 AS hit FROM ${SHARD_REGISTRY_TABLE} WHERE id = ? LIMIT 1`)
    .bind(id)
    .first<SqlRow>();
  return Boolean(row);
}

/** 改分片的名称 / 备注 / 启停 / 绑定名（改完立刻生效）。 */
export async function updateShard(
  env: Env,
  id: string,
  patch: { name?: string; note?: string; binding?: string | null; isActive?: boolean },
): Promise<ShardRecord> {
  const current = (await listShards(env, { refresh: true })).find((row) => row.id === id);
  // 兜底分片（注册表为空时由绑定推导出来的）没有对应的数据库行：改不了，也没得改
  if (!current || !(await shardIsRegistered(env, id))) throw notFound('分片不存在（兜底分片需要先登记到 database_shards）');
  const next: ShardRecord = {
    ...current,
    name: patch.name?.trim() || current.name,
    note: patch.note === undefined ? current.note : patch.note.trim(),
    binding: patch.binding === undefined ? current.binding : patch.binding?.trim() || null,
    isActive: patch.isActive === undefined ? current.isActive : patch.isActive,
    updatedAt: Date.now(),
  };
  await env.DB.prepare(
    `UPDATE ${SHARD_REGISTRY_TABLE} SET name = ?, note = ?, binding = ?, is_active = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(next.name, next.note, next.binding, next.isActive ? 1 : 0, next.updatedAt, id)
    .run();
  invalidateShards();
  return next;
}

/**
 * 只从注册表里摘掉这个分片，**不动 D1 库里的数据**（要删库请去 Cloudflare 控制台，
 * 或者用 `wrangler d1 delete`）。
 */
export async function removeShard(env: Env, id: string): Promise<void> {
  if (!(await shardIsRegistered(env, id))) throw notFound('分片不存在（兜底分片不需要摘除）');
  await env.DB.prepare(`DELETE FROM ${SHARD_REGISTRY_TABLE} WHERE id = ?`).bind(id).run();
  invalidateShards();
}

/* ------------------------------------------------------------------ 分片用量 */

/** 分片用量：`file_size` 是 Cloudflare 报的库大小（字节）。 */
export interface ShardUsage {
  shard: ShardRecord;
  usedBytes: number | null;
  limitBytes: number;
  /** 已用比例（0~1）；读不到用量时按 0 算，用于「谁最空」的比较 */
  ratio: number;
  /** 超过 {@link SHARD_FILL_WARN_RATIO} 就该准备新建分片了 */
  nearLimit: boolean;
}

export function shardUsage(shard: ShardRecord): ShardUsage {
  const usedBytes = shard.fileSize;
  const ratio = usedBytes === null ? 0 : Math.min(1, usedBytes / D1_DATABASE_LIMIT_BYTES);
  return {
    shard,
    usedBytes,
    limitBytes: D1_DATABASE_LIMIT_BYTES,
    ratio,
    nearLimit: ratio >= SHARD_FILL_WARN_RATIO,
  };
}

/** 到 Cloudflare 读一次这个分片的用量并写回注册表（走绑定的分片也能读，只要填了 database_id）。 */
export async function refreshShardUsage(env: Env, shard: ShardRecord): Promise<ShardRecord> {
  if (!shard.databaseId) return shard;
  const credentials = requireD1Credentials(env);
  const info = await fetchRemoteDatabaseInfo(credentials, shard.databaseId);
  const checkedAt = Date.now();
  await env.DB.prepare(
    `UPDATE ${SHARD_REGISTRY_TABLE} SET file_size = ?, checked_at = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(info.fileSize, checkedAt, checkedAt, shard.id)
    .run();
  invalidateShards();
  return { ...shard, fileSize: info.fileSize, checkedAt, updatedAt: checkedAt };
}

/** 依次刷新所有分片的用量（管理员点「刷新用量」）。 */
export async function refreshAllShardUsage(env: Env): Promise<ShardRecord[]> {
  const shards = await activeShards(env);
  const refreshed: ShardRecord[] = [];
  for (const shard of shards) {
    try {
      refreshed.push(await refreshShardUsage(env, shard));
    } catch (error) {
      console.warn(`读分片 ${shard.name} 的用量失败：`, error);
      refreshed.push(shard);
    }
  }
  return refreshed;
}

/**
 * 建表脚本（`CREATE TABLE IF NOT EXISTS`）在一个库里执行一遍，重复执行也安全。
 *
 * 之后还会跑一遍**增量升级语句**（`SHARD_COLUMN_MIGRATIONS` 里的 `ALTER TABLE ADD COLUMN`）：
 * `CREATE TABLE IF NOT EXISTS` 不会给已经建好的表补列，所以「新建 / 挂载分片」时要把漏掉的
 * 列补上。已经加过的列会报 `duplicate column name`，这里直接跳过（幂等）。
 */
export async function ensureShardSchema(db: D1Database): Promise<void> {
  await applySqlStatements(db, SHARD_SCHEMA);
  await applyColumnMigrations(db, SHARD_COLUMN_MIGRATIONS);
}

/** 逐条执行「加列」类语句：列已经存在（duplicate column name）时跳过，其它错误照抛 */
export async function applyColumnMigrations(db: D1Database, statements: readonly string[]): Promise<void> {
  for (const statement of statements) {
    try {
      await db.prepare(statement).run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/duplicate column name/i.test(message)) continue;
      throw error;
    }
  }
}

/** 自动生成的库名（Cloudflare 控制台里一眼能看出用途） */
function defaultShardName(kind: TableKind): string {
  const now = new Date();
  const stamp = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
  ].join('');
  const rand = Math.random().toString(36).slice(2, 6);
  return `varysheet-tables-${kind}-${stamp}-${rand}`;
}

/**
 * 管理员在后台**新建**一个 D1 库并直接挂载成备用分片：
 *   1. 调 Cloudflare API 建库；
 *   2. 在新库里执行建表脚本（和迁移脚本同一份 DDL）；
 *   3. 注册到 `database_shards`，之后新表格就会按用量自动落到它上面。
 */
export async function createShardDatabase(
  env: Env,
  input: { kind: TableKind; name?: string; note?: string },
): Promise<ShardRecord> {
  const credentials = requireD1Credentials(env);
  const name = input.name?.trim() || defaultShardName(asTableKind(input.kind));
  const info = await createRemoteDatabase(credentials, name);
  try {
    await ensureShardSchema(remoteD1(credentials, info.uuid));
  } catch (error) {
    console.error(`分片 ${name} 建表失败：`, error);
    throw new HttpError(
      502,
      'shard_init_failed',
      `D1 库 ${name}（${info.uuid}）已创建，但执行建表脚本失败：` +
        `${error instanceof Error ? error.message : String(error)}；可以再点一次「挂载」把这个库补上`,
    );
  }
  const shard = await registerShard(env, {
    name,
    kind: asTableKind(input.kind),
    databaseId: info.uuid,
    note: input.note,
  });
  return { ...shard, fileSize: info.fileSize };
}

/**
 * 把一个**已经存在**的 D1 库挂载成分片（例如先在 wrangler.jsonc 里加绑定，
 * 或者之前手动建过库）：同样是「先建表（幂等）+ 再登记」。
 */
export async function mountExistingShard(
  env: Env,
  input: { databaseId: string; kind: TableKind; name?: string; note?: string; binding?: string | null },
): Promise<ShardRecord> {
  const databaseId = input.databaseId.trim();
  if (!databaseId) throw badRequest('database_id 不能为空');
  const existing = (await listShards(env, { refresh: true })).find(
    (row) => row.databaseId !== '' && row.databaseId === databaseId,
  );
  if (existing) throw conflict(`这个库已经挂载过了：${existing.name}`, 'shard_exists');

  const credentials = requireD1Credentials(env);
  const info = await fetchRemoteDatabaseInfo(credentials, databaseId);
  await ensureShardSchema(remoteD1(credentials, databaseId));
  const shard = await registerShard(env, {
    name: input.name?.trim() || info.name || databaseId,
    kind: asTableKind(input.kind),
    databaseId,
    binding: input.binding ?? null,
    note: input.note,
  });
  return { ...shard, fileSize: info.fileSize };
}

/** 账号下所有的 D1 库（管理员挂载现成的库时用来挑）。 */
export async function accountDatabases(env: Env): Promise<RemoteDatabaseInfo[]> {
  return listRemoteDatabases(requireD1Credentials(env));
}

/** 后台页面用的分片概览：用量 + 访问方式 + 是否可管理（有没有 database_id）。 */
export interface ShardOverview {
  shard: ShardRecord;
  usage: ShardUsage;
  /** 走绑定（快）还是走 HTTP 接口（慢） */
  transport: 'binding' | 'http';
  manageable: boolean;
}

export async function shardOverviews(env: Env): Promise<ShardOverview[]> {
  const shards = await listShards(env);
  return shards.map((shard) => ({
    shard,
    usage: shardUsage(shard),
    transport: shard.binding ? 'binding' : 'http',
    manageable: Boolean(shard.databaseId),
  }));
}
