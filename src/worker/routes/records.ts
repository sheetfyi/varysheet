/** /api/records* - rows of a table (create / update / delete / duplicate). */
import { FIELD_META, normalizeCellValue } from '../../shared/fields';
import type { Property, RowRecord, RowValues } from '../../shared/types';
import { accessForRecord, requireDatabaseAccess } from '../access';
import { requireUser } from '../auth';
import {
  applyCellEdits,
  assertCellsEditable,
  changedPropertyIds,
  loadCellEditLocks,
  memberCellEditKey,
} from '../cellEdits';
import { logChanges } from '../changes';
import {
  asNumberValue,
  badRequest,
  json,
  newId,
  notFound,
  positionBetween,
  readJson,
  sqlNumber,
  sqlString,
  type SqlRow,
} from '../http';
import { recordFromRow } from '../mappers';
import { assertDatabaseCanGrow } from '../capacity';
import { loadNotes } from '../notes';
import { tableDb } from '../shards';
import { withDefaultStatus } from '../statusDefaults';
import type { RequestContext, Route } from '../types';
import { countRecords, loadProperties, loadRecord, loadRecords, touchDatabase } from './databases';

const MAX_BULK = 200;

/**
 * Merge incoming cell values into `base`, ignoring unknown / read-only / locked
 * properties. `onLocked` (when provided) is called for every rejected locked
 * property - update paths use it to report a 400, create paths stay silent so
 * imports never fail on locked columns.
 */
export function normalizeValues(
  properties: Property[],
  incoming: unknown,
  base: RowValues = {},
  onLocked?: (property: Property) => void,
): RowValues {
  const next: RowValues = { ...base };
  if (!incoming || typeof incoming !== 'object') return next;
  const byId = new Map(properties.map((property) => [property.id, property]));
  for (const [key, raw] of Object.entries(incoming as Record<string, unknown>)) {
    const property = byId.get(key);
    if (!property || FIELD_META[property.type].computed) continue;
    if (property.locked) {
      onLocked?.(property);
      continue;
    }
    const value = normalizeCellValue(property.type, raw, property.config);
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

async function nextRecordPosition(db: D1Database, databaseId: string): Promise<number> {
  const row = await db
    .prepare('SELECT MAX(position) AS max_position FROM records WHERE database_id = ? AND is_archived = 0')
    .bind(databaseId)
    .first<SqlRow>();
  return sqlNumber(row ?? {}, 'max_position', 0) + 1000;
}

/** Position for a row inserted directly after `anchorId` (fractional indexing). */
async function positionAfter(db: D1Database, databaseId: string, anchorId: string | null): Promise<number> {
  if (!anchorId) return nextRecordPosition(db, databaseId);
  const anchor = await db
    .prepare('SELECT position FROM records WHERE id = ? AND database_id = ?')
    .bind(anchorId, databaseId)
    .first<SqlRow>();
  if (!anchor) return nextRecordPosition(db, databaseId);
  const anchorPosition = sqlNumber(anchor, 'position');
  const following = await db
    .prepare(
      `SELECT MIN(position) AS next_position FROM records
        WHERE database_id = ? AND is_archived = 0 AND position > ?`,
    )
    .bind(databaseId, anchorPosition)
    .first<SqlRow>();
  const rawNext = following?.next_position;
  const nextPosition = rawNext === null || rawNext === undefined ? null : sqlNumber(following ?? {}, 'next_position');
  return positionBetween(anchorPosition, nextPosition);
}

/** Create one row; `afterId` inserts it directly below an existing row. */
async function createRecordHandler(ctx: RequestContext): Promise<Response> {
  const user = await requireUser(ctx.request, ctx.env);
  await requireDatabaseAccess(ctx, ctx.params.id, user, 'edit');
  const db = tableDb(ctx);
  // 容量满了只拦增长：新建记录会被 403 capacity_exceeded 挡回去（编辑 / 删除照常）
  await assertDatabaseCanGrow(ctx.env, db, ctx.params.id, { rows: 1 });
  const body = await readJson(ctx.request);

  const properties = await loadProperties(db, ctx.params.id);
  if (!properties.length) throw badRequest('该表格还没有字段');

  // 新建的记录状态默认落到「录入中」（字段里还没有这个选项时自动补一个）
  const values = await withDefaultStatus(
    db,
    ctx.params.id,
    properties,
    normalizeValues(properties, body.values),
  );
  const position = await positionAfter(db, ctx.params.id, body.afterId ? String(body.afterId) : null);

  const recordId = newId();
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO records (id, database_id, "values", position, created_by, updated_by, is_archived, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .bind(
      recordId,
      ctx.params.id,
      JSON.stringify(values),
      position,
      user.id,
      user.id,
      now,
      now,
    )
    .run();
  await touchDatabase(db, ctx.params.id);
  // 攒一条改动日志：别人的表格页几秒内就会把这一行补上（见 worker/changes.ts）
  await logChanges(db, ctx.params.id, 'row', [recordId]);

  return json(
    {
      record: await loadRecord(db, recordId),
      total: await countRecords(db, ctx.params.id),
    },
    { status: 201 },
  );
}

/** Create many rows at once (import / paste). `records` is an array of value maps. */
async function bulkCreateHandler(ctx: RequestContext): Promise<Response> {
  const user = await requireUser(ctx.request, ctx.env);
  await requireDatabaseAccess(ctx, ctx.params.id, user, 'edit');
  const db = tableDb(ctx);
  const body = await readJson(ctx.request);

  const list: unknown[] = Array.isArray(body.records)
    ? body.records
    : Array.isArray(body.rows)
      ? body.rows
      : [];
  if (!list.length) throw badRequest('请至少提交一行数据');
  if (list.length > MAX_BULK) throw badRequest(`单次最多创建 ${MAX_BULK} 行`);
  // 批量新建按行数预检：整批要么进得去、要么整批拒绝（别写一半）
  await assertDatabaseCanGrow(ctx.env, db, ctx.params.id, { rows: list.length });

  const properties = await loadProperties(db, ctx.params.id);
  if (!properties.length) throw badRequest('该表格还没有字段');

  let position = await positionAfter(db, ctx.params.id, body.afterId ? String(body.afterId) : null);
  const now = Date.now();
  const ids: string[] = [];
  const statements: D1PreparedStatement[] = [];
  for (const item of list) {
    const source = item && typeof item === 'object' && 'values' in (item as Record<string, unknown>)
      ? (item as { values: unknown }).values
      : item;
    // 批量新建同样带上状态默认值（值没传时才补）
    const values = await withDefaultStatus(
      db,
      ctx.params.id,
      properties,
      normalizeValues(properties, source),
    );
    const id = newId();
    ids.push(id);
    statements.push(
      db.prepare(
        `INSERT INTO records (id, database_id, "values", position, created_by, updated_by, is_archived, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      ).bind(id, ctx.params.id, JSON.stringify(values), position, user.id, user.id, now, now),
    );
    position += 1;
  }

  await db.batch(statements);
  await touchDatabase(db, ctx.params.id);
  await logChanges(db, ctx.params.id, 'row', ids);

  const loaded = await Promise.all(ids.map((id) => loadRecord(db, id)));
  return json(
    {
      records: loaded.filter((record): record is RowRecord => record !== null),
      total: await countRecords(db, ctx.params.id),
    },
    { status: 201 },
  );
}

async function updateRecordHandler(ctx: RequestContext): Promise<Response> {
  const user = await requireUser(ctx.request, ctx.env);
  const access = await accessForRecord(ctx, ctx.params.id, user, 'edit');
  const db = tableDb(ctx);
  const body = await readJson(ctx.request);

  const row = await db.prepare('SELECT * FROM records WHERE id = ?')
    .bind(ctx.params.id)
    .first<SqlRow>();
  if (!row) throw notFound('记录不存在');
  const current = recordFromRow(row);

  const properties = await loadProperties(db, access.databaseId);
  const values =
    body.values === undefined
      ? current.values
      : normalizeValues(properties, body.values, current.values, (property) => {
          // 字段级锁定：该字段只读，编辑 / 上传都会被拒绝
          throw badRequest(`字段「${property.name}」已锁定，无法修改`);
        });

  // 单元格级「限制编辑」：勾选了「限制编辑」的分享在「保存后 10 秒、这一格仍有
  // 内容」之后不能再改（表格所有者 / 表格成员 / 没勾选的分享 editorKey 为 null，直接放行）
  const editorKey = memberCellEditKey(access);
  const changed = body.values === undefined
    ? []
    : changedPropertyIds(properties, current.values, values, body.values);
  await assertCellsEditable(db, access.databaseId, editorKey, ctx.params.id, changed, properties);

  const fields = ['"values" = ?', 'updated_by = ?', 'updated_at = ?'];
  const params: unknown[] = [JSON.stringify(values), user.id, Date.now()];
  if (body.position !== undefined) {
    fields.push('position = ?');
    params.push(asNumberValue(body.position, 'position'));
  }
  params.push(ctx.params.id);
  await db.prepare(`UPDATE records SET ${fields.join(', ')} WHERE id = ?`)
    .bind(...params)
    .run();
  // 写入成功之后才记账：值非空开始 / 刷新 10 秒计时，值被清空则删掉记账（= 没输入过）
  await applyCellEdits(db, access.databaseId, editorKey, ctx.params.id, changed, values);
  await touchDatabase(db, access.databaseId);
  // 顺序很重要：数据先落库、日志后写（见 worker/changes.ts 的文件头）
  await logChanges(db, access.databaseId, 'row', [ctx.params.id]);

  return json({
    record: await loadRecord(db, ctx.params.id),
    total: await countRecords(db, access.databaseId),
    // 受限访问者（勾了「限制编辑」的分享）拿到这一行最新的锁定状态：
    // cellEditGrace 给出这次改过的格子 10 秒计时窗口的截止时刻（值为空的格子不会出现）
    ...(await loadCellEditLocks(db, access.databaseId, editorKey, [ctx.params.id])),
  });
}

async function deleteRecordHandler(ctx: RequestContext): Promise<Response> {
  const user = await requireUser(ctx.request, ctx.env);
  const access = await accessForRecord(ctx, ctx.params.id, user, 'edit');
  const db = tableDb(ctx);
  await db.prepare('DELETE FROM records WHERE id = ?').bind(ctx.params.id).run();
  await touchDatabase(db, access.databaseId);
  await logChanges(db, access.databaseId, 'delete', [ctx.params.id]);
  return json({ ok: true, total: await countRecords(db, access.databaseId) });
}

async function duplicateRecordsHandler(ctx: RequestContext): Promise<Response> {
  const user = await requireUser(ctx.request, ctx.env);
  await requireDatabaseAccess(ctx, ctx.params.id, user, 'edit');
  const db = tableDb(ctx);
  const body = await readJson(ctx.request);
  const recordIds = Array.isArray(body.recordIds) ? body.recordIds.map(String) : [];
  if (!recordIds.length) throw badRequest('请选择要复制的记录');
  if (recordIds.length > MAX_BULK) throw badRequest(`单次最多复制 ${MAX_BULK} 行`);
  // 复制也是增长（已归档 / 不存在的 id 会被跳过，这里按请求条数保守预检）
  await assertDatabaseCanGrow(ctx.env, db, ctx.params.id, { rows: recordIds.length });

  const now = Date.now();
  const created: RowRecord[] = [];
  for (const recordId of recordIds) {
    const source = await db
      .prepare('SELECT * FROM records WHERE id = ? AND database_id = ? AND is_archived = 0')
      .bind(recordId, ctx.params.id)
      .first<SqlRow>();
    if (!source) continue;
    const position = await positionAfter(db, ctx.params.id, sqlString(source, 'id'));
    const id = newId();
    await db
      .prepare(
        `INSERT INTO records (id, database_id, "values", position, created_by, updated_by, is_archived, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .bind(id, ctx.params.id, sqlString(source, 'values', '{}'), position, user.id, user.id, now, now)
      .run();
    const record = await loadRecord(db, id);
    if (record) created.push(record);
  }
  if (!created.length) throw notFound('没有找到可复制的记录');
  await touchDatabase(db, ctx.params.id);
  await logChanges(db, ctx.params.id, 'row', created.map((record) => record.id));
  return json(
    { records: created, total: await countRecords(db, ctx.params.id) },
    { status: 201 },
  );
}

async function bulkDeleteHandler(ctx: RequestContext): Promise<Response> {
  const user = await requireUser(ctx.request, ctx.env);
  await requireDatabaseAccess(ctx, ctx.params.id, user, 'edit');
  const db = tableDb(ctx);
  const body = await readJson(ctx.request);
  const recordIds = Array.isArray(body.recordIds) ? body.recordIds.map(String) : [];
  if (!recordIds.length) throw badRequest('请选择要删除的记录');
  if (recordIds.length > MAX_BULK) throw badRequest(`单次最多删除 ${MAX_BULK} 行`);

  const placeholders = recordIds.map(() => '?').join(', ');
  await db.prepare(`DELETE FROM records WHERE database_id = ? AND id IN (${placeholders})`)
    .bind(ctx.params.id, ...recordIds)
    .run();
  await touchDatabase(db, ctx.params.id);
  await logChanges(db, ctx.params.id, 'delete', recordIds);
  return json({ deleted: recordIds.length, total: await countRecords(db, ctx.params.id) });
}

/** Fresh page of rows (used by "load more" when a table holds more than one page). */
async function pageHandler(ctx: RequestContext): Promise<Response> {
  const user = await requireUser(ctx.request, ctx.env);
  const access = await requireDatabaseAccess(ctx, ctx.params.id, user, 'view');
  const db = tableDb(ctx);
  const limit = Math.min(Math.max(Math.floor(Number(ctx.url.searchParams.get('limit')) || 200), 1), 1000);
  const offset = Math.max(Math.floor(Number(ctx.url.searchParams.get('offset')) || 0), 0);
  const [rows, total] = await Promise.all([
    loadRecords(db, ctx.params.id, limit, offset),
    countRecords(db, ctx.params.id),
  ]);
  // 保存过、计时窗口已过、且仍有内容的格子 + 还在 10 秒窗口内的格子（不受限制的访问者恒为空）
  const cellLocks = await loadCellEditLocks(
    db,
    ctx.params.id,
    memberCellEditKey(access),
    rows.map((row) => row.id),
  );
  // 这一页记录上的备注（只能新增，不能修改 / 删除）
  const notes = await loadNotes(
    ctx.env,
    db,
    rows.map((row) => row.id),
  );
  return json({ rows, total, hasMore: offset + rows.length < total, ...cellLocks, notes });
}

/**
 * 单条记录的同步接口：只返回这一条记录的最新值 + 它的备注 + 当前访问者在这条记录上
 * 已经用掉的格子。
 *
 * 记录卡片打开（含从收件箱私信跳转）与卡片打开期间的定时刷新都用它：别人刚加的备注 /
 * 刚改的单元格不用刷新整张表格就能看到，而且比整表分页（最多 1000 行 + 全部备注）轻得多，
 * 也不受「目标记录不在当前这一页」的限制。
 */
async function syncRecordHandler(ctx: RequestContext): Promise<Response> {
  const user = await requireUser(ctx.request, ctx.env);
  const access = await accessForRecord(ctx, ctx.params.id, user, 'view');
  const db = tableDb(ctx);
  const record = await loadRecord(db, access.recordId);
  if (!record) throw notFound('记录不存在');
  const [notes, cellLocks] = await Promise.all([
    loadNotes(ctx.env, db, [access.recordId]),
    loadCellEditLocks(db, access.databaseId, memberCellEditKey(access), [access.recordId]),
  ]);
  return json({ record, notes, ...cellLocks });
}

export const recordRoutes: Route[] = [
  { method: 'POST', path: '/api/databases/:id/records', handler: createRecordHandler },
  { method: 'POST', path: '/api/databases/:id/records/bulk', handler: bulkCreateHandler },
  { method: 'POST', path: '/api/databases/:id/records/duplicate', handler: duplicateRecordsHandler },
  { method: 'POST', path: '/api/databases/:id/records/delete', handler: bulkDeleteHandler },
  { method: 'GET', path: '/api/databases/:id/rows', handler: pageHandler },
  { method: 'GET', path: '/api/records/:id', handler: syncRecordHandler },
  { method: 'PATCH', path: '/api/records/:id', handler: updateRecordHandler },
  { method: 'DELETE', path: '/api/records/:id', handler: deleteRecordHandler },
];


