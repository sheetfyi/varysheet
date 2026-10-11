/** /api/properties* - user defined fields (name, type, config, order, width). */
import { FIELD_META, normalizeCellValue } from '../../shared/fields';
import { TABLE_LIMIT_EXCEEDED, tableKindMeta } from '../../shared/tableKind';
import type { FieldType, PropertyConfig, RowValues, SelectOption } from '../../shared/types';
import { accessForProperty, assertStructureEditable, requireDatabaseAccess } from '../access';
import { deleteAttachments } from '../attachments';
import { requireUser } from '../auth';
import { loadDatabaseKind } from '../capacity';
import { logChanges } from '../changes';
import {
  asEnum,
  asNumberValue,
  asString,
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
import { propertyFromRow } from '../mappers';
import { tableDb } from '../shards';
import type { RequestContext, Route } from '../types';
import { loadProperties, touchDatabase } from './databases';

const FIELD_TYPES = Object.keys(FIELD_META) as FieldType[];
const OPTION_COLORS = [
  'default',
  'gray',
  'brown',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'red',
] as const;
const NUMBER_FORMATS = ['plain', 'comma', 'percent', 'currency'] as const;
const DATE_FORMATS = ['YYYY-MM-DD', 'DD/MM/YYYY', 'MMM D, YYYY', 'YYYY年M月D日'] as const;

function normalizeOptions(raw: unknown): SelectOption[] {
  if (!Array.isArray(raw)) throw badRequest('选项必须是数组');
  if (raw.length > 200) throw badRequest('选项数量不能超过 200 个');
  const seen = new Set<string>();
  const options: SelectOption[] = [];
  raw.forEach((item, index) => {
    if (!item || typeof item !== 'object') return;
    const source = item as Partial<SelectOption>;
    const name = asString(source.name, '选项名称', { max: 80 });
    if (!name) return;
    const id = typeof source.id === 'string' && source.id ? source.id : newId();
    if (seen.has(id)) return;
    seen.add(id);
    const color =
      typeof source.color === 'string' && (OPTION_COLORS as readonly string[]).includes(source.color)
        ? (source.color as SelectOption['color'])
        : OPTION_COLORS[index % (OPTION_COLORS.length - 1)];
    options.push({ id, name, color });
  });
  return options;
}

/** Validate / coerce an incoming config for the given field type. */
export function normalizeConfig(type: FieldType, raw: unknown, existing: PropertyConfig): PropertyConfig {
  const source = raw && typeof raw === 'object' ? (raw as PropertyConfig) : {};
  const config: PropertyConfig = { ...existing };

  if (type === 'select' || type === 'multi_select' || type === 'status') {
    config.options = normalizeOptions(source.options ?? existing.options ?? []);
  } else {
    delete config.options;
  }

  if (type === 'number') {
    config.format = asEnum(source.format ?? existing.format ?? 'plain', NUMBER_FORMATS, '数字格式');
    config.precision = Math.min(Math.max(Math.round(Number(source.precision ?? existing.precision ?? 0)), 0), 8);
    if (config.format === 'currency') {
      const currency = asString(source.currency ?? existing.currency ?? 'CNY', '货币', { max: 8 }) || 'CNY';
      config.currency = currency.toUpperCase();
    } else {
      delete config.currency;
    }
  } else {
    delete config.format;
    delete config.precision;
    delete config.currency;
  }

  if (type === 'date' || type === 'created_time' || type === 'updated_time') {
    config.dateFormat = asEnum(source.dateFormat ?? existing.dateFormat ?? 'YYYY-MM-DD', DATE_FORMATS, '日期格式');
    config.includeTime = Boolean(source.includeTime ?? existing.includeTime ?? false);
  } else {
    delete config.dateFormat;
    delete config.includeTime;
  }

  return config;
}

/** Re-normalise all stored values of a property (used when its type changes). */
async function migrateValues(
  db: D1Database,
  databaseId: string,
  propertyId: string,
  type: FieldType,
  config: PropertyConfig,
): Promise<number> {
  const { results } = await db
    .prepare('SELECT id, "values" FROM records WHERE database_id = ? AND is_archived = 0 LIMIT 5000')
    .bind(databaseId)
    .all<SqlRow>();
  const updates: D1PreparedStatement[] = [];
  for (const row of results ?? []) {
    let values: RowValues;
    try {
      values = JSON.parse(sqlString(row, 'values', '{}')) as RowValues;
    } catch {
      continue;
    }
    if (!(propertyId in values)) continue;
    const next = normalizeCellValue(type, values[propertyId], config);
    if (next === null) delete values[propertyId];
    else values[propertyId] = next;
    updates.push(
      db.prepare('UPDATE records SET "values" = ? WHERE id = ?')
        .bind(JSON.stringify(values), sqlString(row, 'id')),
    );
  }
  if (updates.length) await db.batch(updates);
  return updates.length;
}

async function nextPosition(db: D1Database, databaseId: string): Promise<number> {
  const row = await db
    .prepare('SELECT MAX(position) AS max_position FROM properties WHERE database_id = ?')
    .bind(databaseId)
    .first<SqlRow>();
  return sqlNumber(row ?? {}, 'max_position', 0) + 1000;
}

/** 现有字段（列）数：列数上限的判断用 */
async function countProperties(db: D1Database, databaseId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS total FROM properties WHERE database_id = ?')
    .bind(databaseId)
    .first<SqlRow>();
  return sqlNumber(row ?? {}, 'total');
}

async function createPropertyHandler(ctx: RequestContext): Promise<Response> {
  const user = await requireUser(ctx.request, ctx.env);
  const access = await requireDatabaseAccess(ctx, ctx.params.id, user, 'edit');
  assertStructureEditable(access);
  const db = tableDb(ctx);

  // 列数上限：基础表格最多 10 列、专业表格 20 列（只拦新增 —— 已经超限的老表
  // 仍然能改名 / 改类型 / 删列，不然用户没法把它收拾回上限以内）
  const meta = tableKindMeta(await loadDatabaseKind(db, ctx.params.id));
  const columns = await countProperties(db, ctx.params.id);
  if (columns >= meta.maxProperties) {
    throw forbidden(
      `${meta.label}最多 ${meta.maxProperties} 列（当前 ${columns} 列）：删掉一些字段后再添加，或换成专业表格`,
      TABLE_LIMIT_EXCEEDED,
    );
  }

  const body = await readJson(ctx.request);

  const name = asString(body.name, '字段名称', { required: true, max: 120 });
  const type = asEnum(body.type ?? 'text', FIELD_TYPES, '字段类型');
  const config = normalizeConfig(type, body.config, {});
  const width = Number.isFinite(Number(body.width))
    ? Number(body.width)
    : FIELD_META[type].defaultWidth;
  const position =
    body.position === undefined ? await nextPosition(db, ctx.params.id) : asNumberValue(body.position, 'position');

  const propertyId = newId();
  const locked = body.locked === true ? 1 : 0;
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO properties (id, database_id, name, type, config, is_locked, position, width, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      propertyId,
      ctx.params.id,
      name,
      type,
      JSON.stringify(config),
      locked,
      position,
      Math.min(Math.max(Math.round(width), 80), 800),
      now,
      now,
    )
    .run();
  await touchDatabase(db, ctx.params.id);
  // 结构变了（多 / 少了一个字段）：别人的表格页整表刷新一次
  await logChanges(db, ctx.params.id, 'schema');

  return json({ properties: await loadProperties(db, ctx.params.id), propertyId }, { status: 201 });
}

async function updatePropertyHandler(ctx: RequestContext): Promise<Response> {
  const user = await requireUser(ctx.request, ctx.env);
  const access = await accessForProperty(ctx, ctx.params.id, user, 'edit');
  assertStructureEditable(access);
  const db = tableDb(ctx);
  const body = await readJson(ctx.request);

  const row = await db
    .prepare('SELECT * FROM properties WHERE id = ?')
    .bind(ctx.params.id)
    .first<SqlRow>();
  if (!row) throw notFound('字段不存在');
  const current = propertyFromRow(row);

  const fields: string[] = [];
  const values: unknown[] = [];
  let typeChanged = false;
  let nextType = current.type;
  let nextConfig = current.config;

  if (body.name !== undefined) {
    fields.push('name = ?');
    values.push(asString(body.name, '字段名称', { required: true, max: 120 }));
  }
  if (body.type !== undefined) {
    nextType = asEnum(body.type, FIELD_TYPES, '字段类型');
    typeChanged = nextType !== current.type;
  }
  if (body.config !== undefined || typeChanged) {
    nextConfig = normalizeConfig(nextType, body.config ?? current.config, current.config);
    fields.push('config = ?');
    values.push(JSON.stringify(nextConfig));
  }
  if (typeChanged) {
    fields.push('type = ?');
    values.push(nextType);
  }
  if (body.width !== undefined) {
    fields.push('width = ?');
    values.push(Math.min(Math.max(Math.round(asNumberValue(body.width, '列宽')), 80), 800));
  }
  if (body.position !== undefined) {
    fields.push('position = ?');
    values.push(asNumberValue(body.position, 'position'));
  }
  // 字段锁定（表头菜单里的「锁定字段」）
  if (body.locked !== undefined) {
    fields.push('is_locked = ?');
    values.push(body.locked ? 1 : 0);
  }
  if (!fields.length) {
    return json({ property: current, properties: await loadProperties(db, access.databaseId) });
  }

  fields.push('updated_at = ?');
  values.push(Date.now(), ctx.params.id);
  await db.prepare(`UPDATE properties SET ${fields.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();
  // 字段改名 / 改类型 / 改宽 / 排序 / 锁定：结构改动，别人那边整表重载
  await logChanges(db, access.databaseId, 'schema');

  let migrated = 0;
  if (typeChanged) {
    migrated = await migrateValues(db, access.databaseId, ctx.params.id, nextType, nextConfig);
  }
  await touchDatabase(db, access.databaseId);

  const updated = await db
    .prepare('SELECT * FROM properties WHERE id = ?')
    .bind(ctx.params.id)
    .first<SqlRow>();
  return json({
    property: updated ? propertyFromRow(updated) : current,
    properties: await loadProperties(db, access.databaseId),
    migrated,
  });
}

async function deletePropertyHandler(ctx: RequestContext): Promise<Response> {
  const user = await requireUser(ctx.request, ctx.env);
  const access = await accessForProperty(ctx, ctx.params.id, user, 'edit');
  assertStructureEditable(access);
  const db = tableDb(ctx);

  const properties = await loadProperties(db, access.databaseId);
  if (properties.length <= 1) throw badRequest('至少需要保留一个字段');

  // 「文件与媒体」列里的附件跟着这一列一起删（R2 对象 + files 行）：下面马上会把记录值里的
  // 引用清掉，清完就再没有任何地方引用这些文件了（不删的话它们会永远留在 R2 里占容量）
  await deleteAttachments(ctx.env, db, { databaseId: access.databaseId, propertyId: ctx.params.id });

  await db.prepare('DELETE FROM properties WHERE id = ?').bind(ctx.params.id).run();

  // drop the now orphaned cell values
  const { results } = await db
    .prepare('SELECT id, "values" FROM records WHERE database_id = ? AND is_archived = 0 LIMIT 5000')
    .bind(access.databaseId)
    .all<SqlRow>();
  const updates: D1PreparedStatement[] = [];
  for (const record of results ?? []) {
    let values: RowValues;
    try {
      values = JSON.parse(sqlString(record, 'values', '{}')) as RowValues;
    } catch {
      continue;
    }
    if (!(ctx.params.id in values)) continue;
    delete values[ctx.params.id];
    updates.push(
      db.prepare('UPDATE records SET "values" = ? WHERE id = ?')
        .bind(JSON.stringify(values), sqlString(record, 'id')),
    );
  }
  if (updates.length) await db.batch(updates);

  await touchDatabase(db, access.databaseId);
  await logChanges(db, access.databaseId, 'schema');
  return json({ properties: await loadProperties(db, access.databaseId) });
}

export const propertyRoutes: Route[] = [
  { method: 'POST', path: '/api/databases/:id/properties', handler: createPropertyHandler },
  { method: 'PATCH', path: '/api/properties/:id', handler: updatePropertyHandler },
  { method: 'DELETE', path: '/api/properties/:id', handler: deletePropertyHandler },
];

