/**
 * 单表容量：记录条数 + 附件占用（R2），以及「只拦增长」的写入门卫。
 *
 * 上限按「表」计算（和侧边栏里每张表后面的进度条一一对应），也按表格类型分：
 *   基础表格 basic  500 条记录 / 1GB 附件（默认值来自 `shared/tableKind.ts`；
 *                   可用 MAX_DATABASE_RECORDS / MAX_DATABASE_STORAGE_MB 覆盖）
 *   专业表格 pro    不限：两个维度都不判满（`unlimited: true`）
 *
 * 任一维度到上限后，**增长类**写入会被 403 `capacity_exceeded` 挡回去：
 * 新建记录 / 批量新建 / 复制记录 / 上传附件。
 * 查看、搜索、筛选、分页、增量同步、修改已有记录、删除记录**都不受限制** ——
 * 不然后台满了就再也清理不出空间了。
 *
 * 基础表格的「数据保留 1 年」不在写入路径上拦，由定时任务清理，见 `retention.ts`。
 */
import { asTableKind, tableKindMeta } from '../shared/tableKind';
import type { DatabaseCapacity, TableKind } from '../shared/types';
import { forbidden, sqlNumber, sqlString, type SqlRow } from './http';
import type { Env } from './types';

/** 默认上限：基础表格单表 500 条记录（专业表格不限，见 shared/tableKind.ts） */
export const DEFAULT_MAX_RECORDS = tableKindMeta('basic').maxRecords;
/** 默认上限：基础表格单表附件合计 1GB */
export const DEFAULT_MAX_STORAGE_MB = tableKindMeta('basic').maxStorageBytes / (1024 * 1024);

const BYTES_PER_MB = 1024 * 1024;

/** 达到上限时返回的错误码：前端据此把提示写成「只能查看和查询」 */
export const CAPACITY_EXCEEDED = 'capacity_exceeded';

export interface CapacityLimits {
  /** 这一份上限属于哪一类表格 */
  kind: TableKind;
  /** true = 不限容量（专业表格）：两个上限都是 0，永远不判满 */
  unlimited: boolean;
  /** 记录数上限；`unlimited` 时是 0 */
  maxRecords: number;
  /** 附件上限（字节）；`unlimited` 时是 0 */
  maxStorageBytes: number;
  /** 数据保留期（天）；0 = 永久保留 */
  retentionDays: number;
}

/**
 * 单表用量的查询片段：两边都用 `d` 这个表别名，方便和表格列表的查询拼在一起
 * （列表页一次查完所有表，避免 N 次往返）。
 */
export const DATABASE_USAGE_SELECT = `(SELECT COUNT(*) FROM records r WHERE r.database_id = d.id AND r.is_archived = 0) AS record_count,
              (SELECT COALESCE(SUM(f.size), 0) FROM files f WHERE f.database_id = d.id) AS storage_bytes`;

export interface DatabaseUsage {
  /** 有效记录数（软删除归档的不算） */
  records: number;
  /** 附件字节数之和 */
  storageBytes: number;
}

/**
 * 某一类表格的上限：专业表格恒为「不限」；基础表格取 `shared/tableKind.ts` 的默认
 * 值，环境变量 MAX_DATABASE_RECORDS / MAX_DATABASE_STORAGE_MB 可以覆盖（老部署不用改）。
 */
export function capacityLimits(
  env: Env,
  kind: TableKind | string | null | undefined = 'basic',
): CapacityLimits {
  const meta = tableKindMeta(kind);
  // 记录数与附件上限都为 0 = 不限（专业表格）
  if (meta.maxRecords <= 0 && meta.maxStorageBytes <= 0) {
    return { kind: meta.kind, unlimited: true, maxRecords: 0, maxStorageBytes: 0, retentionDays: 0 };
  }
  return {
    kind: meta.kind,
    unlimited: false,
    maxRecords: Math.floor(positiveNumber(env.MAX_DATABASE_RECORDS, meta.maxRecords)),
    maxStorageBytes: Math.floor(
      positiveNumber(env.MAX_DATABASE_STORAGE_MB, meta.maxStorageBytes / BYTES_PER_MB) * BYTES_PER_MB,
    ),
    retentionDays: meta.retentionDays,
  };
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** 用量查询结果 → 用量对象（查不到行时全 0） */
export function usageFromRow(row: SqlRow): DatabaseUsage {
  return { records: sqlNumber(row, 'record_count'), storageBytes: sqlNumber(row, 'storage_bytes') };
}

/** 用量 + 上限 → 下发给前端的容量快照（专业表格恒为「不限、没满」） */
export function capacityFromUsage(usage: DatabaseUsage, limits: CapacityLimits): DatabaseCapacity {
  const recordsFull = !limits.unlimited && usage.records >= limits.maxRecords;
  const storageFull = !limits.unlimited && usage.storageBytes >= limits.maxStorageBytes;
  return {
    kind: limits.kind,
    unlimited: limits.unlimited,
    retentionDays: limits.retentionDays,
    records: usage.records,
    maxRecords: limits.maxRecords,
    storageBytes: usage.storageBytes,
    maxStorageBytes: limits.maxStorageBytes,
    recordsFull,
    storageFull,
    atCapacity: recordsFull || storageFull,
  };
}

/** 单表用量的独立查询（表格详情页只关心这一张表） */
export async function loadDatabaseUsage(env: Env, databaseId: string): Promise<DatabaseUsage> {
  const row = await env.DB.prepare(`SELECT ${DATABASE_USAGE_SELECT} FROM databases d WHERE d.id = ?`)
    .bind(databaseId)
    .first<SqlRow>();
  return usageFromRow(row ?? {});
}

/** 单表类型（容量 / 列数 / 视图数上限都按它取；查不到就按基础表格） */
export async function loadDatabaseKind(env: Env, databaseId: string): Promise<TableKind> {
  const row = await env.DB.prepare('SELECT kind FROM databases WHERE id = ?').bind(databaseId).first<SqlRow>();
  return asTableKind(row ? sqlString(row, 'kind', 'basic') : 'basic');
}

/** 单表容量快照（调用方已经查过类型时直接传进来，少一次往返） */
export async function loadDatabaseCapacity(
  env: Env,
  databaseId: string,
  kind?: TableKind,
): Promise<DatabaseCapacity> {
  const [usage, resolved] = await Promise.all([
    loadDatabaseUsage(env, databaseId),
    kind ? Promise.resolve(kind) : loadDatabaseKind(env, databaseId),
  ]);
  return capacityFromUsage(usage, capacityLimits(env, resolved));
}

/**
 * 「只拦增长」的写入门禁：新建 / 批量新建 / 复制记录、上传附件前调用。
 *
 * `rows` 是这次要新增的行数（单条就是 1，删除传 0），`bytes` 是这次要写进 R2 的
 * 字节数（不传 0）。任一维度**已经**到上限、或这次写入会把它顶过上限，都抛
 * 403 `capacity_exceeded`。
 *
 * 编辑 / 删除已有记录不走这里：表满了用户仍然得能把数据清理出来。
 */
export async function assertDatabaseCanGrow(
  env: Env,
  databaseId: string,
  growth: { rows?: number; bytes?: number } = {},
): Promise<void> {
  const limits = capacityLimits(env, await loadDatabaseKind(env, databaseId));
  // 专业表格不限容量：直接放行，连用量都不用查
  if (limits.unlimited) return;
  const label = tableKindMeta(limits.kind).label;
  const capacity = capacityFromUsage(await loadDatabaseUsage(env, databaseId), limits);
  const rows = Math.max(0, Math.floor(growth.rows ?? 0));
  const bytes = Math.max(0, Math.floor(growth.bytes ?? 0));

  if (rows > 0 && capacity.records + rows > limits.maxRecords) {
    throw forbidden(
      `${label}记录数已达上限（${limits.maxRecords} 条）：可以查看和查询，但不能再新增记录，请先删除一些记录`,
      CAPACITY_EXCEEDED,
    );
  }
  if (bytes > 0 && capacity.storageBytes + bytes > limits.maxStorageBytes) {
    throw forbidden(
      `${label}附件容量已达上限（${formatLimit(capacity.storageBytes)}/${formatLimit(capacity.maxStorageBytes)}）：可以查看和查询，但不能再上传附件，请先删除一些附件`,
      CAPACITY_EXCEEDED,
    );
  }
  // 任一维度已满就整表停止增长：记录数满了也不该再往上堆附件，反之亦然
  if (capacity.atCapacity) {
    throw forbidden(
      `${label}已达容量上限（记录 ${capacity.records}/${capacity.maxRecords} 条 · 附件 ${formatLimit(capacity.storageBytes)}/${formatLimit(capacity.maxStorageBytes)}）：可以查看和查询，但不能再新增记录、复制记录或上传附件，请先删除一些数据`,
      CAPACITY_EXCEEDED,
    );
  }
}

/** 错误文案里的容量：MB 用整数（1GB 写成 `1024 MB` 比 `1 GB` 更好对账） */
function formatLimit(bytes: number): string {
  if (bytes < BYTES_PER_MB) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes / BYTES_PER_MB)} MB`;
}
