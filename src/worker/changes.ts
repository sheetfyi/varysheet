/**
 * 多人协作的增量同步（live sync）。
 *
 * 每一次改动（改单元格 / 增删记录 / 新增备注 / 改字段与视图结构）都会在
 * `database_changes` 里追加一条带**自增版本号 rev** 的日志。前端在表格页开着的时候
 * 每隔几秒带着「自己看过的最大 rev」请求 `GET /api/databases/:id/changes?since=<rev>`，
 * 只拿回比它新的改动 —— 别人改的单元格不用刷新页面就会出现，也不用整表重拉。
 *
 * 两条重要的约定：
 *   1. **日志永远写在数据之后**（每个写接口都是先 UPDATE / INSERT，再 `logChanges`），
 *      而客户端「先读 rev、再读数据」。这样要么数据里已经带上这次改动，要么它的 rev
 *      大于客户端手里的游标，最多只会重复下发一次 —— 客户端按 id 合并，天然幂等；
 *   2. rev 是**全局**自增的（所有表格共用一条序列）：客户端只要记住「看过的最大版本号」，
 *      某张表格暂时没有新改动也不会让游标停住。
 *
 * 这个模块刻意不 import `routes/*`（只依赖 http / mappers / notes / cellEdits），
 * 这样各个路由都可以放心地在写完之后调用 `logChanges` 而不会形成循环依赖。
 */
import { rowMatchesView } from '../shared/viewFilter';
import type { DatabaseChanges, Property, RowRecord, ViewDef } from '../shared/types';
import { loadCellEditLocks } from './cellEdits';
import { sqlNumber, sqlString, type SqlRow } from './http';
import { propertyFromRow, recordFromRow, viewFromRow } from './mappers';
import { loadNotes } from './notes';
import type { Env } from './types';

export type ChangeKind = 'row' | 'delete' | 'note' | 'schema';

/** 一次 batch 里最多写多少条日志（批量导入时按这个切块） */
const LOG_CHUNK = 100;
/** 日志保留时长：更早的记录会在写入时顺手清掉（太久没上线的客户端只能整表重载） */
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** 顺手清理日志的概率：绝大多数写入不会多带这条 DELETE */
const PRUNE_CHANCE = 1 / 20;
/** 单次同步最多下发多少条变更；超过就让客户端整表重载（比下发几百条更省） */
const MAX_CHANGES = 500;
/** IN (...) 查询的分片大小（1 个 database_id + N 个 id） */
const SELECT_CHUNK = 90;

function chunk<T>(items: T[], size: number): T[][] {
  const slices: T[][] = [];
  for (let index = 0; index < items.length; index += size) slices.push(items.slice(index, index + size));
  return slices;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function emptyChanges(rev: number): DatabaseChanges {
  return { rev, reset: true, rows: [], deleted: [], notes: [], lockedCells: [], cellEditGrace: {}, people: {}, total: 0 };
}

/** 当前（全局）版本号。客户端第一次打开表格时拿它当起点。 */
export async function headRev(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COALESCE(MAX(rev), 0) AS rev FROM database_changes').first<SqlRow>();
  return sqlNumber(row ?? {}, 'rev');
}

/**
 * 记下这次改动 —— 必须在**数据写完之后**调用（见文件头的约定）。
 * `recordIds` 省略时记一条「不针对具体记录」的改动（结构类改动）。
 *
 * `db` 是这张表所在的分片库：改动日志跟着表格走（`database_changes` 在分片里），
 * 客户端拿着同一张表的 `since` 游标，所以版本号在分片内部自增就够了。
 */
export async function logChanges(
  db: D1Database,
  databaseId: string,
  kind: ChangeKind,
  recordIds: readonly (string | null)[] = [null],
): Promise<void> {
  if (!databaseId) return;
  const ids: (string | null)[] = recordIds.length ? [...recordIds] : [null];
  const now = Date.now();
  for (const slice of chunk(ids, LOG_CHUNK)) {
    await db.batch(
      slice.map((recordId) =>
        db
          .prepare('INSERT INTO database_changes (database_id, record_id, kind, created_at) VALUES (?, ?, ?, ?)')
          .bind(databaseId, recordId, kind, now),
      ),
    );
  }
  // 顺手清理过期日志（低概率，避免每次写入都多一条 DELETE）
  if (Math.random() < PRUNE_CHANCE) {
    await db.prepare('DELETE FROM database_changes WHERE created_at < ?').bind(now - KEEP_MS).run();
  }
}


export interface ChangesScope {
  /** 「限制编辑」的归属键（`user:<id>` / `share:<id>`）；不受限制时传 null */
  editorKey: string | null;
  /** 定向分享（视图分享）时只能看到这些视图里的行；null 表示整表可见 */
  viewIds: string[] | null;
  /** 定向分享里筛选「当前用户」时解析成谁 */
  viewerId: string;
}

/**
 * 「自 `since` 之后的改动」：改过的行 + 删掉的行 + 新增的备注 + 当前访问者已经用掉的格子。
 * `reset` 为 true 表示攒了太多改动 / 日志已被清理，客户端应该整表重载一次。
 */
export async function loadChanges(
  env: Env,
  db: D1Database,
  databaseId: string,
  scope: ChangesScope,
  since: number,
): Promise<DatabaseChanges> {
  const head = await headRev(db);
  const cursor = Number.isFinite(since) && since > 0 ? Math.floor(since) : 0;
  // 游标永远不会退：日志被清空后 MAX(rev) 会回到 0，但自增序列仍在往前走
  const rev = Math.max(head, cursor);

  if (cursor > 0) {
    const oldest = await db.prepare('SELECT COALESCE(MIN(rev), 0) AS rev FROM database_changes').first<SqlRow>();
    // 现存最老的日志比游标还新（或者日志已被清空）：中间可能被清理过，无法保证完整
    if (sqlNumber(oldest ?? {}, 'rev') > cursor || head === 0) return emptyChanges(rev);
  }

  const { results } = await db
    .prepare(
      `SELECT rev, record_id, kind FROM database_changes
        WHERE database_id = ? AND rev > ?
        ORDER BY rev ASC
        LIMIT ?`,
    )
    .bind(databaseId, cursor, MAX_CHANGES + 1)
    .all<SqlRow>();

  const entries = results ?? [];
  // 攒了太多改动：让客户端整表重载一次，比下发几百条更省
  if (entries.length > MAX_CHANGES) return emptyChanges(rev);

  const changedRows = new Set<string>();
  const deletedRows = new Set<string>();
  const notedRows = new Set<string>();
  let schemaChanged = false;
  for (const entry of entries) {
    const kind = sqlString(entry, 'kind');
    if (kind === 'schema') {
      schemaChanged = true;
      continue;
    }
    const recordId = sqlString(entry, 'record_id');
    if (!recordId) continue;
    if (kind === 'row') changedRows.add(recordId);
    else if (kind === 'delete') deletedRows.add(recordId);
    else if (kind === 'note') notedRows.add(recordId);
  }
  // 结构变了（改名 / 字段 / 视图 / 成员 / 分享）：增量拼不出完整的新结构，
  // 让客户端整表重载一次更省事、也不会漏掉任何东西
  if (schemaChanged) return emptyChanges(rev);

  // 已经删掉的记录不必再下发（删除通知优先）
  for (const recordId of deletedRows) changedRows.delete(recordId);

  const rows = await loadRowsByIds(db, databaseId, [...changedRows], scope);
  const [notes, total] = await Promise.all([
    loadNotes(env, db, [...notedRows]),
    countRecords(db, databaseId),
  ]);
  // 这一轮改动里的单元格锁定状态：只读的格子 + 还在 10 秒计时窗口内的格子
  const cellLocks = await loadCellEditLocks(
    db,
    databaseId,
    scope.editorKey,
    rows.map((row) => row.id),
  );
  return {
    rev,
    reset: false,
    rows,
    deleted: [...deletedRows],
    notes,
    ...cellLocks,
    people: await loadPeopleNames(env, rows),
    total,
  };
}

/** 被分享的视图里能看到的字段：所有被分享视图的可见字段的并集。 */
function scopedProperties(properties: Property[], views: ViewDef[]): Property[] {
  if (!views.some((view) => view.config.visibleProperties)) return properties;
  const allowed = new Set<string>();
  for (const view of views) {
    for (const propertyId of view.config.visibleProperties ?? []) allowed.add(propertyId);
  }
  return properties.filter((property) => allowed.has(property.id));
}

/** 这些记录的最新值（已删除 / 归档的行不返回，定向分享的访客只拿得到被分享视图命中的行）。 */
async function loadRowsByIds(
  db: D1Database,
  databaseId: string,
  ids: string[],
  scope: ChangesScope,
): Promise<RowRecord[]> {
  if (!ids.length) return [];
  const rows: RowRecord[] = [];
  for (const slice of chunk(ids, SELECT_CHUNK)) {
    const { results } = await db
      .prepare(
        `SELECT * FROM records
          WHERE database_id = ? AND is_archived = 0 AND id IN (${placeholders(slice.length)})`,
      )
      .bind(databaseId, ...slice)
      .all<SqlRow>();
    for (const row of results ?? []) rows.push(recordFromRow(row));
  }
  if (!scope.viewIds?.length) return rows;

  // 定向分享的访客只能看到被分享视图命中的行（与整表分页用的是同一套视图筛选）
  const [properties, views] = await Promise.all([
    loadProperties(db, databaseId),
    loadViews(db, databaseId, scope.viewIds),
  ]);
  if (!views.length) return [];
  const visible = scopedProperties(properties, views);
  return rows.filter((row) =>
    views.some((view) => rowMatchesView(visible, row, view.config, { viewerId: scope.viewerId })),
  );
}

async function loadProperties(db: D1Database, databaseId: string): Promise<Property[]> {
  const { results } = await db
    .prepare('SELECT * FROM properties WHERE database_id = ? ORDER BY position ASC, created_at ASC')
    .bind(databaseId)
    .all<SqlRow>();
  return (results ?? []).map(propertyFromRow);
}

async function loadViews(db: D1Database, databaseId: string, viewIds: string[]): Promise<ViewDef[]> {
  const { results } = await db
    .prepare('SELECT * FROM views WHERE database_id = ? ORDER BY position ASC, created_at ASC')
    .bind(databaseId)
    .all<SqlRow>();
  return (results ?? []).map(viewFromRow).filter((view) => viewIds.includes(view.id));
}

async function countRecords(db: D1Database, databaseId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS total FROM records WHERE database_id = ? AND is_archived = 0')
    .bind(databaseId)
    .first<SqlRow>();
  return sqlNumber(row ?? {}, 'total');
}

/**
 * 行元数据（创建人 / 最后编辑人）里出现过的用户 id → 显示名。
 * 别人的改动可能带来看不到的 id（定向分享的访客并不是表格成员），
 * 所以同步接口自己也解析一份姓名，避免界面上出现空白。
 */
async function loadPeopleNames(env: Env, rows: RowRecord[]): Promise<Record<string, string>> {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.createdBy) ids.add(row.createdBy);
    if (row.updatedBy) ids.add(row.updatedBy);
  }
  const names: Record<string, string> = {};
  for (const slice of chunk([...ids], SELECT_CHUNK)) {
    const { results } = await env.DB.prepare(
      `SELECT id, name, email FROM users WHERE id IN (${placeholders(slice.length)})`,
    )
      .bind(...slice)
      .all<SqlRow>();
    for (const row of results ?? []) {
      names[sqlString(row, 'id')] = sqlString(row, 'name') || sqlString(row, 'email');
    }
  }
  return names;
}
