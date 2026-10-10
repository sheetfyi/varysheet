/**
 * 基础表格的数据保留期清理：超过一年的记录与附件自动清除。
 *
 * 规则（见 `shared/tableKind.ts`）：基础表格限 500 条 / 1GB，**存储时间一年** ——
 * 超过一年的记录与附件会被自动清除；专业表格没有容量与存储时间限制，永远不清理。
 *
 * 两个触发入口：
 *   1. 定时任务：`wrangler.jsonc` 里的 `triggers.crons`（每天 03:00 UTC），
 *      入口是 `src/worker/index.ts` 的 `scheduled()`；
 *   2. 运维手动：`POST /api/admin/maintenance/retention`（管理员），返回清理数量。
 *
 * 判定口径是**创建时间**（`records.created_at` / `files.created_at`）：记录只要还在
 * 保留期内就留着，不会因为「被改过」而续期。删记录时 notes / cell_edits 由外键级联
 * 清掉；附件的 R2 对象必须先删（`files` 行删了就再也拿不到 key）。
 * 保留天数可用 `BASIC_TABLE_RETENTION_DAYS` 覆盖（默认 365；设 0 关闭自动清理，
 * 本地调试时很有用）。
 */
import { logChanges } from './changes';
import { sqlNumber, sqlString, type SqlRow } from './http';
import { forEachShardSafe } from './shards';
import { DAY_MS, tableKindMeta } from '../shared/tableKind';
import type { Env } from './types';

/** 默认保留期：一年（基础表格） */
export const DEFAULT_RETENTION_DAYS = tableKindMeta('basic').retentionDays;

/** 一次删给 R2 的 key 数量上限（多于此就分批） */
const R2_DELETE_BATCH = 500;

/** 保留天数：`BASIC_TABLE_RETENTION_DAYS`；没配 / 非法值退回默认值，0 = 关闭清理 */
export function retentionDays(env: Env): number {
  const raw = Number(env.BASIC_TABLE_RETENTION_DAYS);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_RETENTION_DAYS;
  return Math.floor(raw);
}

export interface RetentionResult {
  /** 清理截止时刻：这个时间**之前**创建的数据会被清掉 */
  cutoff: number;
  /** 本次生效的保留天数（0 = 已关闭，什么都没做） */
  days: number;
  /** 清掉的记录数 */
  records: number;
  /** 清掉的附件数 */
  files: number;
  /** 清掉的附件字节数 */
  bytes: number;
  /** 有数据被清掉的表格数 */
  databases: number;
}

/**
 * 清理所有**基础表格**里超过保留期的记录与附件（专业表格不参与）。
 * 定时任务与管理员手动接口都走它；关掉清理（保留天数为 0）时直接返回空结果。
 *
 * 表格数据在分片里：逐个分片把「这一片上的基础表格」列出来再清理（`databases.kind`
 * 仍然是最权威的口径）。某个分片暂时不可用不影响其它分片，失败会记进日志。
 */
export async function purgeExpiredBasicData(
  env: Env,
  options: { now?: number } = {},
): Promise<RetentionResult> {
  const days = retentionDays(env);
  const now = options.now ?? Date.now();
  const result: RetentionResult = { cutoff: 0, days, records: 0, files: 0, bytes: 0, databases: 0 };
  if (days <= 0) return result;
  const cutoff = now - days * DAY_MS;
  result.cutoff = cutoff;

  const scans = await forEachShardSafe(env, async (_shard, db) => {
    const { results } = await db
      .prepare('SELECT id FROM databases WHERE kind = ?')
      .bind(tableKindMeta('basic').kind)
      .all<SqlRow>();

    let purged = 0;
    for (const row of results ?? []) {
      if (await purgeDatabase(env, db, sqlString(row, 'id'), cutoff, result)) purged += 1;
    }
    return purged;
  });

  for (const scan of scans) result.databases += scan.value ?? 0;
  return result;
}

/**
 * 清一张基础表格里的过期数据；真的清掉了东西才返回 true
 * （顺便往增量日志里记一条 `schema`，别人开着的表格页会整表重载）。
 *
 * `db` 是这张表所在的分片：记录 / 附件 / 改动日志都在里面。
 */
async function purgeDatabase(
  env: Env,
  db: D1Database,
  databaseId: string,
  cutoff: number,
  result: RetentionResult,
): Promise<boolean> {
  const { results: fileRows } = await db
    .prepare('SELECT id, r2_key, size FROM files WHERE database_id = ? AND created_at < ?')
    .bind(databaseId, cutoff)
    .all<SqlRow>();
  const files = fileRows ?? [];

  if (files.length) {
    // R2 里的对象先删：files 行删掉之后就找不到 key 了
    for (let index = 0; index < files.length; index += R2_DELETE_BATCH) {
      const keys = files.slice(index, index + R2_DELETE_BATCH).map((file) => sqlString(file, 'r2_key'));
      await env.BUCKET.delete(keys).catch(() => undefined);
    }
    await db
      .prepare('DELETE FROM files WHERE database_id = ? AND created_at < ?')
      .bind(databaseId, cutoff)
      .run();
    result.files += files.length;
    result.bytes += files.reduce((sum, file) => sum + sqlNumber(file, 'size'), 0);
  }

  // 记录删掉后，它上面的备注 / 格子编辑记录由外键级联清理
  const deleted = await db
    .prepare('DELETE FROM records WHERE database_id = ? AND created_at < ?')
    .bind(databaseId, cutoff)
    .run();
  const records = Number(deleted.meta?.changes ?? 0);
  result.records += records;

  if (files.length || records > 0) {
    await logChanges(db, databaseId, 'schema');
    return true;
  }
  return false;
}
