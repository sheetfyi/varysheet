/** /api/public/:token* - read (and optionally write) access through a share link. */
import type { PublicDatabaseResponse } from '../../shared/types';
import { resolveShareToken, type ShareAccess } from '../access';
import {
  applyCellEdits,
  assertCellsEditable,
  changedPropertyIds,
  loadCellEditLocks,
  shareCellEditKey,
} from '../cellEdits';
import { headRev, loadChanges, logChanges } from '../changes';
import { assertDatabaseCanGrow, loadDatabaseCapacity } from '../capacity';
import {
  asNumberValue,
  badRequest,
  forbidden,
  json,
  newId,
  notFound,
  readJson,
  sqlNumber,
  sqlString,
  type SqlRow,
} from '../http';
import { recordFromRow } from '../mappers';
import { loadUserContacts } from '../notes';
import { withDefaultStatus } from '../statusDefaults';
import type { Env, RequestContext, Route } from '../types';
import { countRecords, loadPeopleNames, loadProperties, loadRecords, loadViews, ownerLabel, touchDatabase } from './databases';
import { normalizeValues } from './records';

const DEFAULT_PAGE_SIZE = 500;

async function requireShare(env: Env, token: string, needEdit: boolean): Promise<ShareAccess> {
  const share = await resolveShareToken(env, token);
  if (!share) throw notFound('分享链接无效或已过期');
  if (needEdit && share.permission !== 'edit') throw forbidden('该分享链接仅允许查看');
  return share;
}

async function publicDatabaseHandler(ctx: RequestContext): Promise<Response> {
  const share = await requireShare(ctx.env, ctx.params.token, false);
  const limit = Math.min(Math.max(Math.floor(Number(ctx.url.searchParams.get('limit')) || DEFAULT_PAGE_SIZE), 1), 1000);
  const offset = Math.max(Math.floor(Number(ctx.url.searchParams.get('offset')) || 0), 0);

  const row = await share.db
    .prepare(
      'SELECT d.id, d.name, d.icon, d.description, d.owner_id FROM databases d WHERE d.id = ? AND d.is_archived = 0',
    )
    .bind(share.databaseId)
    .first<SqlRow>();
  if (!row) throw notFound('表格不存在');
  // 所有者的昵称在用户库：跨库没有 JOIN，补查一次
  const owners = await loadUserContacts(ctx.env, [sqlString(row, 'owner_id')]);

  // 增量同步的起点：先读版本号、再读数据（写入顺序是「先数据、后日志」）
  const rev = await headRev(share.db);

  const [properties, views, rows, total, capacity] = await Promise.all([
    loadProperties(share.db, share.databaseId),
    loadViews(share.db, share.databaseId),
    loadRecords(share.db, share.databaseId, limit, offset),
    countRecords(share.db, share.databaseId),
    // 单表容量用量：公开链接页到上限后也只剩「查看和查询」
    loadDatabaseCapacity(ctx.env, share.db, share.databaseId),
  ]);
  // 公开链接也要能显示「创建人 / 最后编辑人」的姓名（表格所有者 + 协作者）
  const people = await loadPeopleNames(ctx.env, rows);
  // 通过该分享链接改过的格子：只读的 + 还在 10 秒计时窗口内的（勾了「限制编辑」才有）
  const cellLocks = await loadCellEditLocks(
    share.db,
    share.databaseId,
    shareCellEditKey(share),
    rows.map((item) => item.id),
  );

  const payload: PublicDatabaseResponse = {
    database: {
      id: sqlString(row, 'id'),
      name: sqlString(row, 'name'),
      icon: sqlString(row, 'icon', '📋'),
      description: sqlString(row, 'description'),
      permission: share.permission,
      // 创建链接时勾选的「限制编辑」：输入不限次数，保存后 10 秒这一格才锁上
      limitEdits: share.limitEdits,
      ownerId: sqlString(row, 'owner_id'),
      ownerName: ownerLabel(owners.get(sqlString(row, 'owner_id'))),
      capacity,
    },
    properties,
    views,
    rows,
    total,
    hasMore: offset + rows.length < total,
    rev,
    people,
    // 只读的格子 + 还在 10 秒计时窗口内的格子
    ...cellLocks,
  };
  return json(payload);
}

async function publicCreateRecordHandler(ctx: RequestContext): Promise<Response> {
  const share = await requireShare(ctx.env, ctx.params.token, true);
  const db = share.db;
  const body = await readJson(ctx.request);
  const properties = await loadProperties(db, share.databaseId);
  if (!properties.length) throw badRequest('该表格还没有字段');
  // 容量满了只拦增长：公开链接页也不能再新增记录（改 / 删已有记录照常）
  await assertDatabaseCanGrow(ctx.env, db, share.databaseId, { rows: 1 });

  const values = await withDefaultStatus(
    db,
    share.databaseId,
    properties,
    normalizeValues(properties, body.values),
  );
  const row = await db
    .prepare('SELECT MAX(position) AS max_position FROM records WHERE database_id = ? AND is_archived = 0')
    .bind(share.databaseId)
    .first<SqlRow>();

  const recordId = newId();
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO records (id, database_id, "values", position, created_by, updated_by, is_archived, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, NULL, 0, ?, ?)`,
    )
    .bind(recordId, share.databaseId, JSON.stringify(values), sqlNumber(row ?? {}, 'max_position', 0) + 1000, now, now)
    .run();
  await touchDatabase(db, share.databaseId);
  // 通过分享链接新建的记录：表格里的协作者也会同步到
  await logChanges(db, share.databaseId, 'row', [recordId]);

  const created = await db.prepare('SELECT * FROM records WHERE id = ?').bind(recordId).first<SqlRow>();
  return json({ record: created ? recordFromRow(created) : null }, { status: 201 });
}

async function publicUpdateRecordHandler(ctx: RequestContext): Promise<Response> {
  const share = await requireShare(ctx.env, ctx.params.token, true);
  const db = share.db;
  const body = await readJson(ctx.request);

  const row = await db
    .prepare('SELECT * FROM records WHERE id = ? AND database_id = ? AND is_archived = 0')
    .bind(ctx.params.recordId, share.databaseId)
    .first<SqlRow>();
  if (!row) throw notFound('记录不存在');
  const current = recordFromRow(row);

  const properties = await loadProperties(db, share.databaseId);
  const values =
    body.values === undefined
      ? current.values
      : normalizeValues(properties, body.values, current.values, (property) => {
          // 字段级锁定：该字段只读，编辑 / 上传都会被拒绝
          throw badRequest(`字段「${property.name}」已锁定，无法修改`);
        });

  // 单元格级「限制编辑」：这条分享链接勾了「限制编辑」时，保存后 10 秒且这一格仍有
  // 内容的格子不能再改（值没变、值为空的请求都不受影响；没勾选时 editorKey 为 null，直接放行）
  const editorKey = shareCellEditKey(share);
  const changed = body.values === undefined
    ? []
    : changedPropertyIds(properties, current.values, values, body.values);
  await assertCellsEditable(db, share.databaseId, editorKey, ctx.params.recordId, changed, properties);

  const fields = ['"values" = ?', 'updated_at = ?'];
  const params: unknown[] = [JSON.stringify(values), Date.now()];
  if (body.position !== undefined) {
    fields.push('position = ?');
    params.push(asNumberValue(body.position, 'position'));
  }
  params.push(ctx.params.recordId);
  await db.prepare(`UPDATE records SET ${fields.join(', ')} WHERE id = ?`)
    .bind(...params)
    .run();
  // 写入成功之后才记账：值非空开始 / 刷新 10 秒计时，值被清空则删掉记账（= 没输入过）
  await applyCellEdits(db, share.databaseId, editorKey, ctx.params.recordId, changed, values);
  await touchDatabase(db, share.databaseId);
  // 通过分享链接改的格子：表格里的协作者几秒内就能看到
  await logChanges(db, share.databaseId, 'row', [ctx.params.recordId]);

  const updated = await db
    .prepare('SELECT * FROM records WHERE id = ?')
    .bind(ctx.params.recordId)
    .first<SqlRow>();
  // 这一行最新的锁定状态：cellEditGrace = 刚改过的格子 10 秒计时窗口的截止时刻
  const cellLocks = await loadCellEditLocks(db, share.databaseId, editorKey, [ctx.params.recordId]);
  return json({ record: updated ? recordFromRow(updated) : null, ...cellLocks });
}

async function publicDeleteRecordHandler(ctx: RequestContext): Promise<Response> {
  const share = await requireShare(ctx.env, ctx.params.token, true);
  const db = share.db;
  const result = await db.prepare('DELETE FROM records WHERE id = ? AND database_id = ?')
    .bind(ctx.params.recordId, share.databaseId)
    .run();
  if (!result.meta.changes) throw notFound('记录不存在');
  await touchDatabase(db, share.databaseId);
  await logChanges(db, share.databaseId, 'delete', [ctx.params.recordId]);
  return json({ ok: true });
}

/**
 * 公开链接页的增量同步：和登录用户的 /api/databases/:id/changes 同一套逻辑，
 * 只是访问权来自分享 token（可看 / 可编辑的链接都能看，写不了）。
 */
async function publicChangesHandler(ctx: RequestContext): Promise<Response> {
  const share = await requireShare(ctx.env, ctx.params.token, false);
  const since = Number(ctx.url.searchParams.get('since') ?? 0);
  const changes = await loadChanges(
    ctx.env,
    share.db,
    share.databaseId,
    { editorKey: shareCellEditKey(share), viewIds: null, viewerId: '' },
    since,
  );
  return json(changes);
}

export const publicRoutes: Route[] = [
  { method: 'GET', path: '/api/public/:token', handler: publicDatabaseHandler },
  { method: 'GET', path: '/api/public/:token/changes', handler: publicChangesHandler },
  { method: 'POST', path: '/api/public/:token/records', handler: publicCreateRecordHandler },
  { method: 'PATCH', path: '/api/public/:token/records/:recordId', handler: publicUpdateRecordHandler },
  { method: 'DELETE', path: '/api/public/:token/records/:recordId', handler: publicDeleteRecordHandler },
];
