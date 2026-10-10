/** /api/views* - saved table / board / gallery views (filters, sorts, grouping). */
import { FIELD_META } from '../../shared/fields';
import { TABLE_LIMIT_EXCEEDED, tableKindMeta } from '../../shared/tableKind';
import type { ViewConfig, ViewDef, ViewType } from '../../shared/types';
import { defaultViewConfig, mergeViewConfig } from '../../shared/views';
import { accessForView, assertStructureEditable, assertViewEditable, requireDatabaseAccess } from '../access';
import { requireUser } from '../auth';
import { loadDatabaseKind } from '../capacity';
import { logChanges } from '../changes';
import {
  asEnum,
  asNumberValue,
  badRequest,
  forbidden,
  json,
  newId,
  notFound,
  readJson,
  sqlNumber,
  type SqlRow,
} from '../http';
import { viewFromRow } from '../mappers';
import { tableDb } from '../shards';
import type { RequestContext, Route } from '../types';
import { loadProperties, loadViews, touchDatabase } from './databases';

const VIEW_TYPES: ViewType[] = ['table', 'board', 'gallery'];
const OPERATORS = [
  'contains',
  'not_contains',
  'is',
  'is_not',
  'is_empty',
  'is_not_empty',
  'eq',
  'neq',
  'gt',
  'lt',
  'gte',
  'lte',
  'before',
  'after',
  'on_or_before',
  'on_or_after',
  'is_true',
  'is_false',
] as const;

/** Keep only well formed rules that reference existing properties. */
export function sanitizeViewConfig(
  type: ViewType,
  incoming: unknown,
  fallback: ViewConfig,
  propertyIds: Set<string>,
  groupableIds: Set<string>,
): ViewConfig {
  if (incoming === undefined || incoming === null) return fallback;
  if (typeof incoming !== 'object') throw badRequest('视图配置必须是对象');
  const source = incoming as Partial<ViewConfig>;
  const base = mergeViewConfig(type, { ...fallback, ...source });

  const conditions = (Array.isArray(source.filters?.conditions) ? source.filters.conditions : base.filters.conditions)
    .filter((rule) => rule && typeof rule === 'object' && propertyIds.has(String(rule.propertyId)))
    .map((rule) => ({
      id: typeof rule.id === 'string' && rule.id ? rule.id : newId(),
      propertyId: String(rule.propertyId),
      operator: (OPERATORS as readonly string[]).includes(rule.operator) ? rule.operator : 'contains',
      value: rule.value ?? null,
      // 这条条件自己的「必须满足（and）/ 任意满足（or）」；没写就不落库，
      // 求值时退回视图级 conjunction（老数据兼容，见 shared/viewFilter.ts）
      conjunction: rule.conjunction === 'or' ? ('or' as const) : rule.conjunction === 'and' ? ('and' as const) : undefined,
    }));

  const sorts = (Array.isArray(source.sorts) ? source.sorts : base.sorts)
    .filter((rule) => rule && typeof rule === 'object' && propertyIds.has(String(rule.propertyId)))
    .map((rule) => ({
      propertyId: String(rule.propertyId),
      direction: rule.direction === 'desc' ? ('desc' as const) : ('asc' as const),
    }));

  const visible = Array.isArray(source.visibleProperties)
    ? source.visibleProperties.map(String).filter((id) => propertyIds.has(id))
    : source.visibleProperties === null
      ? null
      : base.visibleProperties;

  const groupByRaw = source.groupBy === undefined ? base.groupBy : source.groupBy;
  const groupBy = groupByRaw && groupableIds.has(String(groupByRaw)) ? String(groupByRaw) : null;

  const previewRaw =
    source.cardPreviewPropertyId === undefined ? base.cardPreviewPropertyId : source.cardPreviewPropertyId;
  const cardPreviewPropertyId = previewRaw && propertyIds.has(String(previewRaw)) ? String(previewRaw) : null;

  return {
    filters: {
      conjunction: source.filters?.conjunction === 'or' ? 'or' : base.filters.conjunction,
      conditions,
    },
    sorts,
    groupBy,
    visibleProperties: visible,
    rowHeight: asEnum(base.rowHeight ?? 'short', ['short', 'medium', 'tall'] as const, '行高'),
    cardSize: asEnum(base.cardSize ?? 'medium', ['small', 'medium', 'large'] as const, '卡片大小'),
    cardPreviewPropertyId,
  };
}

async function nextViewPosition(db: D1Database, databaseId: string): Promise<number> {
  const row = await db
    .prepare('SELECT MAX(position) AS max_position FROM views WHERE database_id = ?')
    .bind(databaseId)
    .first<SqlRow>();
  const value = row?.max_position;
  return (value === null || value === undefined ? 0 : Number(value)) + 1000;
}

/** 现有视图数：视图数上限的判断用 */
async function countViews(db: D1Database, databaseId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS total FROM views WHERE database_id = ?')
    .bind(databaseId)
    .first<SqlRow>();
  return sqlNumber(row ?? {}, 'total');
}

async function createViewHandler(ctx: RequestContext): Promise<Response> {
  const user = await requireUser(ctx.request, ctx.env);
  const access = await requireDatabaseAccess(ctx, ctx.params.id, user, 'edit');
  assertStructureEditable(access);
  const db = tableDb(ctx);

  // 视图数上限：基础表格最多 3 个视图、专业表格 10 个（只拦新增 ——
  // 已经超限的老表仍然能改名 / 改配置 / 删视图）
  const meta = tableKindMeta(await loadDatabaseKind(db, ctx.params.id));
  const viewCount = await countViews(db, ctx.params.id);
  if (viewCount >= meta.maxViews) {
    throw forbidden(
      `${meta.label}最多 ${meta.maxViews} 个视图（当前 ${viewCount} 个）：删掉一些视图后再添加，或换成专业表格`,
      TABLE_LIMIT_EXCEEDED,
    );
  }

  const body = await readJson(ctx.request);

  const type = asEnum(body.type ?? 'table', VIEW_TYPES, '视图类型');
  const fallbackName = type === 'table' ? '表格视图' : type === 'board' ? '看板视图' : '画廊视图';
  const name = (typeof body.name === 'string' && body.name.trim()) || fallbackName;

  const properties = await loadProperties(db, ctx.params.id);
  const propertyIds = new Set(properties.map((property) => property.id));
  const groupableIds = new Set(
    properties.filter((property) => FIELD_META[property.type].groupable).map((property) => property.id),
  );

  // "duplicate view" - start from the config of an existing view
  let base = defaultViewConfig(type);
  if (body.copyOfViewId) {
    const source = await db
      .prepare('SELECT * FROM views WHERE id = ? AND database_id = ?')
      .bind(String(body.copyOfViewId), ctx.params.id)
      .first<SqlRow>();
    if (!source) throw notFound('被复制的视图不存在');
    base = mergeViewConfig(type, viewFromRow(source).config);
  }

  const config = sanitizeViewConfig(type, body.config, base, propertyIds, groupableIds);
  const position =
    body.position === undefined
      ? await nextViewPosition(db, ctx.params.id)
      : asNumberValue(body.position, 'position');

  const viewId = newId();
  const now = Date.now();
  const locked = body.locked === true ? 1 : 0;
  await db
    .prepare(
      `INSERT INTO views (id, database_id, name, type, config, is_locked, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(viewId, ctx.params.id, name.slice(0, 80), type, JSON.stringify(config), locked, position, now, now)
    .run();
  await touchDatabase(db, ctx.params.id);
  // 多了一个视图：别人的视图栏也跟着刷新
  await logChanges(db, ctx.params.id, 'schema');

  return json({ views: await loadViews(db, ctx.params.id), viewId }, { status: 201 });
}

async function updateViewHandler(ctx: RequestContext): Promise<Response> {
  const user = await requireUser(ctx.request, ctx.env);
  const access = await accessForView(ctx, ctx.params.id, user, 'edit');
  assertStructureEditable(access);
  assertViewEditable(access, ctx.params.id);
  const db = tableDb(ctx);
  const body = await readJson(ctx.request);

  const row = await db.prepare('SELECT * FROM views WHERE id = ?').bind(ctx.params.id).first<SqlRow>();
  if (!row) throw notFound('视图不存在');
  const current: ViewDef = viewFromRow(row);

  // A locked view only accepts a plain unlock request.
  if (current.locked) {
    const onlyUnlock = body.locked === false && Object.keys(body).every((key) => key === 'locked');
    if (!onlyUnlock) throw forbidden('视图已锁定，请先解锁');
    if (access.role !== 'owner') throw forbidden('只有所有者可以解锁视图');
    await db.prepare('UPDATE views SET is_locked = 0, updated_at = ? WHERE id = ?')
      .bind(Date.now(), ctx.params.id)
      .run();
    await touchDatabase(db, access.databaseId);
    await logChanges(db, access.databaseId, 'schema');
    return json({ views: await loadViews(db, access.databaseId) });
  }

  const type = body.type === undefined ? current.type : asEnum(body.type, VIEW_TYPES, '视图类型');
  const properties = await loadProperties(db, access.databaseId);
  const propertyIds = new Set(properties.map((property) => property.id));
  const groupableIds = new Set(
    properties.filter((property) => FIELD_META[property.type].groupable).map((property) => property.id),
  );

  const fields: string[] = [];
  const params: unknown[] = [];

  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) throw badRequest('视图名称不能为空');
    fields.push('name = ?');
    params.push(name.slice(0, 80));
  }
  if (body.type !== undefined) {
    fields.push('type = ?');
    params.push(type);
  }
  if (body.config !== undefined || body.type !== undefined) {
    const fallback = body.type !== undefined ? defaultViewConfig(type) : current.config;
    const config = sanitizeViewConfig(type, body.config ?? current.config, fallback, propertyIds, groupableIds);
    fields.push('config = ?');
    params.push(JSON.stringify(config));
  }
  if (body.position !== undefined) {
    fields.push('position = ?');
    params.push(asNumberValue(body.position, 'position'));
  }
  if (body.locked !== undefined) {
    fields.push('is_locked = ?');
    params.push(body.locked ? 1 : 0);
  }

  if (fields.length) {
    fields.push('updated_at = ?');
    params.push(Date.now(), ctx.params.id);
    await db.prepare(`UPDATE views SET ${fields.join(', ')} WHERE id = ?`).bind(...params).run();
    await touchDatabase(db, access.databaseId);
    // 视图改名 / 改筛选 / 排序 / 可见字段 / 锁定：结构改动，别人那边整表重载
    await logChanges(db, access.databaseId, 'schema');
  }

  return json({ views: await loadViews(db, access.databaseId) });
}

async function deleteViewHandler(ctx: RequestContext): Promise<Response> {
  const user = await requireUser(ctx.request, ctx.env);
  const access = await accessForView(ctx, ctx.params.id, user, 'edit');
  assertStructureEditable(access);
  assertViewEditable(access, ctx.params.id);
  const db = tableDb(ctx);

  const row = await db.prepare('SELECT is_locked FROM views WHERE id = ?')
    .bind(ctx.params.id)
    .first<SqlRow>();
  if (row && Number(row.is_locked ?? 0) === 1) throw forbidden('视图已锁定，请先解锁再删除');

  const views = await loadViews(db, access.databaseId);
  if (views.length <= 1) throw badRequest('至少需要保留一个视图');

  await db.prepare('DELETE FROM views WHERE id = ?').bind(ctx.params.id).run();
  await touchDatabase(db, access.databaseId);
  await logChanges(db, access.databaseId, 'schema');
  return json({ views: await loadViews(db, access.databaseId) });
}

export const viewRoutes: Route[] = [
  { method: 'POST', path: '/api/databases/:id/views', handler: createViewHandler },
  { method: 'PATCH', path: '/api/views/:id', handler: updateViewHandler },
  { method: 'DELETE', path: '/api/views/:id', handler: deleteViewHandler },
];

