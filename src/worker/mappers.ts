/** D1 row -> API model conversions. */
import type {
  DatabaseCapacity,
  DatabaseSummary,
  FieldType,
  Member,
  Property,
  PropertyConfig,
  Role,
  RowRecord,
  RowValues,
  Share,
  ViewDef,
  ViewShare,
  ViewType,
} from '../shared/types';
import { mergeViewConfig } from '../shared/views';
import { asTableKind } from '../shared/tableKind';
import { parseJsonObject, sqlNullableString, sqlNumber, sqlString, type SqlRow } from './http';

export function propertyFromRow(row: SqlRow): Property {
  return {
    id: sqlString(row, 'id'),
    databaseId: sqlString(row, 'database_id'),
    name: sqlString(row, 'name'),
    type: sqlString(row, 'type', 'text') as FieldType,
    config: parseJsonObject<PropertyConfig>(row.config, {}),
    position: sqlNumber(row, 'position'),
    width: sqlNumber(row, 'width', 200),
    locked: sqlNumber(row, 'is_locked') === 1,
    createdAt: sqlNumber(row, 'created_at'),
    updatedAt: sqlNumber(row, 'updated_at'),
  };
}

export function recordFromRow(row: SqlRow): RowRecord {
  return {
    id: sqlString(row, 'id'),
    databaseId: sqlString(row, 'database_id'),
    values: parseJsonObject<RowValues>(row.values, {}),
    position: sqlNumber(row, 'position'),
    createdBy: sqlNullableString(row, 'created_by'),
    updatedBy: sqlNullableString(row, 'updated_by'),
    createdAt: sqlNumber(row, 'created_at'),
    updatedAt: sqlNumber(row, 'updated_at'),
  };
}

export function viewFromRow(row: SqlRow): ViewDef {
  const type = sqlString(row, 'type', 'table') as ViewType;
  return {
    id: sqlString(row, 'id'),
    databaseId: sqlString(row, 'database_id'),
    name: sqlString(row, 'name'),
    type,
    config: mergeViewConfig(type, parseJsonObject(row.config, {})),
    locked: sqlNumber(row, 'is_locked') === 1,
    position: sqlNumber(row, 'position'),
    createdAt: sqlNumber(row, 'created_at'),
    updatedAt: sqlNumber(row, 'updated_at'),
  };
}

export function memberFromRow(row: SqlRow): Member {
  return {
    id: sqlString(row, 'id'),
    databaseId: sqlString(row, 'database_id'),
    userId: sqlString(row, 'user_id'),
    email: sqlString(row, 'email'),
    name: sqlString(row, 'name'),
    role: sqlString(row, 'role', 'editor') as Role,
    createdAt: sqlNumber(row, 'created_at'),
  };
}

export function shareFromRow(row: SqlRow): Share {
  return {
    id: sqlString(row, 'id'),
    databaseId: sqlString(row, 'database_id'),
    token: sqlString(row, 'token'),
    permission: sqlString(row, 'permission', 'view') === 'edit' ? 'edit' : 'view',
    // 创建链接时勾选的「限制编辑」：访客每个格子只有一次修改机会
    limitEdits: sqlNumber(row, 'limit_edits') === 1,
    createdAt: sqlNumber(row, 'created_at'),
    expiresAt: row.expires_at === null || row.expires_at === undefined ? null : sqlNumber(row, 'expires_at'),
  };
}

export function databaseSummaryFromRow(
  row: SqlRow,
  role: Role,
  sharedViewNames: string[] = [],
  /** 只通过视图定向分享获得访问权（不是所有者、也不是表格成员） */
  viewScoped = false,
  /**
   * 单表容量用量：查询里顺带算出来的（见 `worker/capacity.ts` 的
   * `DATABASE_USAGE_SELECT`），侧边栏拿它画进度条。
   */
  capacity: DatabaseCapacity,
): DatabaseSummary {
  return {
    id: sqlString(row, 'id'),
    name: sqlString(row, 'name'),
    icon: sqlString(row, 'icon', '📋'),
    // 表格类型：老库（迁移前）里的行没有 kind，按基础表格处理
    kind: asTableKind(sqlString(row, 'kind', 'basic')),
    description: sqlString(row, 'description'),
    ownerId: sqlString(row, 'owner_id'),
    ownerName: sqlNullableString(row, 'owner_name') ?? undefined,
    role,
    locked: false, // 表级锁定已移除：恒为 false
    viewScoped,
    sharedViewNames,
    createdAt: sqlNumber(row, 'created_at'),
    updatedAt: sqlNumber(row, 'updated_at'),
    rowCount: row.record_count === undefined ? undefined : sqlNumber(row, 'record_count'),
    capacity,
  };
}

export function viewShareFromRow(row: SqlRow): ViewShare {
  return {
    id: sqlString(row, 'id'),
    databaseId: sqlString(row, 'database_id'),
    viewId: sqlString(row, 'view_id'),
    viewName: sqlString(row, 'view_name'),
    userId: sqlString(row, 'user_id'),
    email: sqlString(row, 'email'),
    name: sqlString(row, 'name'),
    role: sqlString(row, 'role', 'viewer') === 'editor' ? 'editor' : 'viewer',
    // 分享时勾选的「限制编辑」：被分享者每个格子只有一次修改机会
    limitEdits: sqlNumber(row, 'limit_edits') === 1,
    createdAt: sqlNumber(row, 'created_at'),
  };
}
