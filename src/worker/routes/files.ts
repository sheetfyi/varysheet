/** /api/files* - R2 backed attachments for the `files` field type. */
import { cellLockHint } from '../../shared/fields';
import type { FileValue } from '../../shared/types';
import { requireDatabaseAccess, resolveShareToken } from '../access';
import { getCurrentUser, requireUser } from '../auth';
import { assertDatabaseCanGrow } from '../capacity';
import { isCellLocked, memberCellEditKey, shareCellEditKey } from '../cellEdits';
import { logChanges } from '../changes';
import {
  asString,
  badRequest,
  forbidden,
  json,
  newId,
  notFound,
  sqlNumber,
  sqlString,
  unauthorized,
  type SqlRow,
} from '../http';
import type { Env, RequestContext, Route } from '../types';
import { requireEntityShard } from '../shards';
import { touchFilesUsed } from '../usage';
import { touchDatabase } from './databases';

/** Keep the object key readable but free of characters that upset URLs. */
function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return (cleaned || 'file').slice(0, 120);
}

function maxUploadBytes(env: Env): number {
  const mb = Number(env.MAX_UPLOAD_MB ?? 25);
  return Math.max(1, Number.isFinite(mb) ? mb : 25) * 1024 * 1024;
}

export function fileValueFromRow(row: SqlRow): FileValue {
  return {
    id: sqlString(row, 'id'),
    name: sqlString(row, 'name', 'file'),
    size: sqlNumber(row, 'size'),
    mime: sqlString(row, 'mime', 'application/octet-stream'),
  };
}

async function uploadHandler(ctx: RequestContext): Promise<Response> {
  const user = await getCurrentUser(ctx.request, ctx.env);
  const contentType = ctx.request.headers.get('content-type') ?? '';
  if (!contentType.includes('multipart/form-data')) throw badRequest('请使用 multipart/form-data 上传文件');

  let form: FormData;
  try {
    form = await ctx.request.formData();
  } catch {
    throw badRequest('表单解析失败');
  }

  const file = form.get('file');
  if (!(file instanceof File)) throw badRequest('缺少 file 字段');
  if (file.size === 0) throw badRequest('文件内容为空');
  const limit = maxUploadBytes(ctx.env);
  if (file.size > limit) throw badRequest(`单个文件不能超过 ${Math.round(limit / 1024 / 1024)}MB`);

  // either an authenticated member with edit rights, or a share link with edit permission
  const token = typeof form.get('token') === 'string' ? String(form.get('token')) : '';
  let databaseId = typeof form.get('databaseId') === 'string' ? String(form.get('databaseId')) : '';
  // 附件元数据（`files`）跟表格一起落在分片里：先定下分片库，后面所有读写都走它
  let db: D1Database | null = null;
  // 单元格级「限制编辑」的归属键；表格所有者 / 表格成员 / 没勾选「限制编辑」的
  // 分享都是 null（不受限制）
  let editorKey: string | null = null;
  if (token) {
    const share = await resolveShareToken(ctx.env, token);
    if (!share) throw notFound('分享链接无效或已过期');
    if (share.permission !== 'edit') throw forbidden('该分享链接不允许上传文件');
    databaseId = share.databaseId;
    db = share.db;
    editorKey = shareCellEditKey(share);
  } else if (databaseId) {
    if (!user) throw unauthorized();
    const access = await requireDatabaseAccess(ctx, databaseId, user, 'edit');
    db = access.db;
    editorKey = memberCellEditKey(access);
  } else if (!user) {
    throw unauthorized();
  }
  // 分片存储之后没有「无主附件」：附件必须挂在某张表格上
  if (!db) throw badRequest('缺少 databaseId：附件必须挂在某张表格上');

  const recordId = typeof form.get('recordId') === 'string' ? String(form.get('recordId')) : null;
  const propertyId = typeof form.get('propertyId') === 'string' ? String(form.get('propertyId')) : null;

  // 字段级锁定：锁定字段不接受新的上传
  if (propertyId) {
    const property = await db.prepare('SELECT name, is_locked FROM properties WHERE id = ? AND database_id = ?')
      .bind(propertyId, databaseId)
      .first<SqlRow>();
    if (property && sqlNumber(property, 'is_locked') === 1) {
      throw forbidden(`字段「${sqlString(property, 'name')}」已锁定，无法上传文件`);
    }
    // 单元格级「限制编辑」：已经锁上的格子（计时窗口已过、仍有内容）不再接受新的上传
    if (recordId && property && (await isCellLocked(db, databaseId, editorKey, recordId, propertyId))) {
      throw forbidden(cellLockHint(sqlString(property, 'name')));
    }
  }

  // 附件容量按「表」统计：到上限后不再接受新的上传（已有文件照常下载 / 删除）
  await assertDatabaseCanGrow(ctx.env, db, databaseId, { bytes: file.size });

  const fileId = newId();
  const name = safeFileName(asString(file.name, '文件名', { max: 200 }) || 'file');
  const mime = file.type || 'application/octet-stream';
  const key = `${databaseId}/${fileId}/${name}`;

  await ctx.env.BUCKET.put(key, file.stream(), {
    httpMetadata: { contentType: mime },
    customMetadata: { name, uploader: user?.id ?? '' },
  });

  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO files (id, database_id, record_id, property_id, r2_key, name, size, mime, uploaded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      fileId,
      databaseId,
      recordId,
      propertyId,
      key,
      name,
      file.size,
      mime,
      user?.id ?? null,
      now,
    )
    .run();

  await touchDatabase(db, databaseId);
  // 附件挂在某条记录上时也算这行「有更新」：别人的表格页会立刻同步一次这行
  if (recordId) await logChanges(db, databaseId, 'row', [recordId]);

  const value: FileValue = { id: fileId, name, size: file.size, mime };
  return json({ file: value, url: `/api/files/${fileId}` }, { status: 201 });
}

/**
 * Owners / members can always read; share visitors need a valid `?token=`.
 * 附件行在分片里，所以调用方先把「这个文件在哪个分片」探出来。
 */
async function authorizeDownload(
  ctx: RequestContext,
  row: SqlRow,
): Promise<{ inline: boolean }> {
  const databaseId = sqlString(row, 'database_id');
  const token = ctx.url.searchParams.get('token');
  if (token) {
    const share = await resolveShareToken(ctx.env, token);
    if (share && (!databaseId || share.databaseId === databaseId)) return { inline: true };
  }
  const user = await requireUser(ctx.request, ctx.env);
  if (databaseId) {
    await requireDatabaseAccess(ctx, databaseId, user, 'view');
  } else if (sqlString(row, 'uploaded_by') !== user.id) {
    throw forbidden('没有权限访问该文件');
  }
  return { inline: false };
}

async function downloadHandler(ctx: RequestContext): Promise<Response> {
  // `files` 跟着表格走：文件 id 不是表格 id，只能先逐分片探出归属
  const { db } = await requireEntityShard(ctx.env, 'files', 'id', ctx.params.id, '文件不存在');
  const row = await db
    .prepare('SELECT * FROM files WHERE id = ?')
    .bind(ctx.params.id)
    .first<SqlRow>();
  if (!row) throw notFound('文件不存在');
  await authorizeDownload(ctx, row);
  // 下载也算「使用过」：附件的保留期按最后一次下载算（同一行一天只写一次，见 worker/usage.ts）
  await touchFilesUsed(db, [ctx.params.id]);

  const key = sqlString(row, 'r2_key');
  const object = await ctx.env.BUCKET.get(key);
  if (!object) throw notFound('文件内容已丢失');

  const headers = new Headers();
  const name = sqlString(row, 'name', 'file');
  const mime = sqlString(row, 'mime', 'application/octet-stream');
  headers.set('content-type', mime);
  headers.set('content-length', String(object.size));
  headers.set('etag', object.httpEtag);
  headers.set(
    'content-disposition',
    `${ctx.url.searchParams.get('download') === '1' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`,
  );
  headers.set('cache-control', 'private, max-age=3600');
  return new Response(object.body, { headers });
}

async function deleteHandler(ctx: RequestContext): Promise<Response> {
  const user = await requireUser(ctx.request, ctx.env);
  const { db } = await requireEntityShard(ctx.env, 'files', 'id', ctx.params.id, '文件不存在');
  const row = await db
    .prepare('SELECT * FROM files WHERE id = ?')
    .bind(ctx.params.id)
    .first<SqlRow>();
  if (!row) throw notFound('文件不存在');

  const databaseId = sqlString(row, 'database_id');
  if (databaseId) {
    const access = await requireDatabaseAccess(ctx, databaseId, user, 'edit');
    // 字段级锁定：锁定字段不接受附件删除（记录里仍然引用该文件）
    const propertyId = sqlString(row, 'property_id');
    if (propertyId) {
      const property = await db.prepare('SELECT name, is_locked FROM properties WHERE id = ? AND database_id = ?')
        .bind(propertyId, databaseId)
        .first<SqlRow>();
      if (property && sqlNumber(property, 'is_locked') === 1) {
        throw forbidden(`字段「${sqlString(property, 'name')}」已锁定，无法删除附件`);
      }
      // 单元格级「限制编辑」：已经锁上的格子（计时窗口已过、仍有内容）不再允许删除附件
      const recordId = sqlString(row, 'record_id');
      if (
        recordId
        && property
        && (await isCellLocked(db, databaseId, memberCellEditKey(access), recordId, propertyId))
      ) {
        throw forbidden(cellLockHint(sqlString(property, 'name')));
      }
    }
  } else if (sqlString(row, 'uploaded_by') !== user.id) {
    throw forbidden('没有权限删除该文件');
  }

  await ctx.env.BUCKET.delete(sqlString(row, 'r2_key'));
  await db.prepare('DELETE FROM files WHERE id = ?').bind(ctx.params.id).run();
  if (databaseId) await touchDatabase(db, databaseId);
  return json({ ok: true });
}

export const fileRoutes: Route[] = [
  { method: 'POST', path: '/api/files', handler: uploadHandler },
  { method: 'GET', path: '/api/files/:id', handler: downloadHandler },
  { method: 'DELETE', path: '/api/files/:id', handler: deleteHandler },
];
