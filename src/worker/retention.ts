/**
 * 试用 / 基础表格的数据保留期清理：超过保留期的记录与附件自动清除。
 *
 * 规则（见 `shared/tableKind.ts`）：
 *   试用表格 100 条 / 0.5GB，**数据保留半年**（默认 180 天，`TRIAL_TABLE_RETENTION_DAYS` 可覆盖）；
 *   基础表格 500 条 / 1GB，**数据保留一年**（默认 365 天，`BASIC_TABLE_RETENTION_DAYS` 可覆盖）；
 *   专业表格 没有容量与存储时间限制，永远不清理。
 * 两类各按各的天数清理；把某一类的天数设成 0 就关掉那一类的自动清理（本地调试时很有用）。
 *
 * 两个触发入口：
 *   1. 定时任务：`wrangler.jsonc` 里的 `triggers.crons`（每天 03:00 UTC），
 *      入口是 `src/worker/index.ts` 的 `scheduled()`；
 *   2. 运维手动：`POST /api/admin/maintenance/retention`（管理员），返回按类型拆开的清理数量。
 *
 * 判定口径是**创建时间**（`records.created_at` / `files.created_at`）：记录只要还在
 * 保留期内就留着，不会因为「被改过」而续期。清一条记录的顺序是「先删附件、再删记录」：
 * 先把它的 `files` 行指向的 R2 对象删掉（行删了就再也拿不到 key，见 `worker/attachments.ts`），
 * 再删记录本身（notes / cell_edits 由外键级联清掉）。
 */
import { deleteAttachments } from './attachments';
import { logChanges } from './changes';
import { sqlString, type SqlRow } from './http';
import { forEachShardSafe } from './shards';
import { DAY_MS, tableKindMeta } from '../shared/tableKind';
import type { TableKind } from '../shared/types';
import type { Env } from './types';

/** 默认保留期：一年（基础表格） */
export const DEFAULT_RETENTION_DAYS = tableKindMeta('basic').retentionDays;
/** 默认保留期：半年（试用表格） */
export const DEFAULT_TRIAL_RETENTION_DAYS = tableKindMeta('trial').retentionDays;

/** 参与自动清理的类型（专业表格永久保留，永远不清理） */
const PURGE_KINDS: readonly TableKind[] = ['trial', 'basic'];

/**
 * 某一类表格的保留天数：试用看 `TRIAL_TABLE_RETENTION_DAYS`（默认 180）、基础看
 * `BASIC_TABLE_RETENTION_DAYS`（默认 365）；没配 / 非法值退回默认值，
 * 0 = 关闭这一类的清理（专业表格恒为 0）。
 */
export function retentionDaysFor(env: Env, kind: TableKind): number {
  const meta = tableKindMeta(kind);
  if (meta.retentionDays <= 0) return 0;
  const raw = Number(kind === 'trial' ? env.TRIAL_TABLE_RETENTION_DAYS : env.BASIC_TABLE_RETENTION_DAYS);
  if (!Number.isFinite(raw) || raw < 0) return meta.retentionDays;
  return Math.floor(raw);
}

/** 基础表格的保留天数（等价于 `retentionDaysFor(env, 'basic')`） */
export function retentionDays(env: Env): number {
  return retentionDaysFor(env, 'basic');
}

/** 一类表格（试用 / 基础）的清理结果 */
export interface RetentionKindResult {
  /** 这一条属于哪一类表格 */
  kind: TableKind;
  /** 这一类本次生效的保留天数（0 = 已关闭，这一类什么都没做） */
  days: number;
  /** 清理截止时刻：这个时间**之前**创建的数据会被清掉（关闭时为 0） */
  cutoff: number;
  /** 清掉的记录数 */
  records: number;
  /** 清掉的附件数 */
  files: number;
  /** 清掉的附件字节数 */
  bytes: number;
  /** 有数据被清掉的表格数 */
  databases: number;
}

export interface RetentionResult {
  /** 合计：清掉的记录数 */
  records: number;
  /** 合计：清掉的附件数 */
  files: number;
  /** 合计：清掉的附件字节数 */
  bytes: number;
  /** 合计：有数据被清掉的表格数 */
  databases: number;
  /** 按类型拆开的结果（试用 / 基础各一条；专业表格不参与，永久保留） */
  kinds: RetentionKindResult[];
}

/**
 * 清理所有**试用 / 基础表格**里超过保留期的记录与附件（专业表格不参与）。
 * 定时任务与管理员手动接口都走它；某一类的保留天数为 0 就跳过那一类。
 *
 * 表格数据在分片里：逐个分片把「这一片上的这一类表格」列出来再清理（`databases.kind`
 * 仍然是最权威的口径）。某个分片暂时不可用不影响其它分片，失败会记进日志。
 */
export async function purgeExpiredTableData(
  env: Env,
  options: { now?: number } = {},
): Promise<RetentionResult> {
  const now = options.now ?? Date.now();
  const kinds: RetentionKindResult[] = PURGE_KINDS.map((kind) => {
    const days = retentionDaysFor(env, kind);
    return {
      kind,
      days,
      cutoff: days > 0 ? now - days * DAY_MS : 0,
      records: 0,
      files: 0,
      bytes: 0,
      databases: 0,
    };
  });
  const result: RetentionResult = { records: 0, files: 0, bytes: 0, databases: 0, kinds };

  for (const entry of kinds) {
    if (entry.days <= 0) continue;
    const scans = await forEachShardSafe(env, async (_shard, db) => {
      const { results } = await db
        .prepare('SELECT id FROM databases WHERE kind = ?')
        .bind(entry.kind)
        .all<SqlRow>();

      let purged = 0;
      for (const row of results ?? []) {
        if (await purgeDatabase(env, db, sqlString(row, 'id'), entry.cutoff, entry)) purged += 1;
      }
      return purged;
    });

    for (const scan of scans) entry.databases += scan.value ?? 0;
    result.records += entry.records;
    result.files += entry.files;
    result.bytes += entry.bytes;
    result.databases += entry.databases;
  }
  return result;
}

/**
 * 清一张试用 / 基础表格里的过期数据；真的清掉了东西才返回 true
 * （顺便往增量日志里记一条 `schema`，别人开着的表格页会整表重载）。
 *
 * 顺序：先删附件（R2 对象 + files 行）、再删记录 —— 记录删掉后它的附件就再也
 * 没人引用了，反过来（先删记录）就会留下一堆查不到 key 的 files 行，R2 占用只涨不跌。
 * R2 暂时删不动时也不卡住清理（见 `deleteAttachments` 的 `tolerateR2Failure`），
 * 那种对象留到下一轮再删。
 *
 * `db` 是这张表所在的分片：记录 / 附件 / 改动日志都在里面。
 */
async function purgeDatabase(
  env: Env,
  db: D1Database,
  databaseId: string,
  cutoff: number,
  result: RetentionKindResult,
): Promise<boolean> {
  // 1) 过期的记录先列出来：记录一走，挂在它上面的附件（哪怕是保留期内新传的）也一起走
  const { results: recordRows } = await db
    .prepare('SELECT id FROM records WHERE database_id = ? AND created_at < ?')
    .bind(databaseId, cutoff)
    .all<SqlRow>();
  const recordIds = (recordRows ?? []).map((row) => sqlString(row, 'id'));
  if (recordIds.length) {
    const removed = await deleteAttachments(env, db, { databaseId, recordIds, tolerateR2Failure: true });
    result.files += removed.files;
    result.bytes += removed.bytes;
  }

  // 2) 保留期到点的附件：含历史上遗留的孤儿行（记录早被删掉、行还躺在 files 里）
  const { results: fileRows } = await db
    .prepare('SELECT id FROM files WHERE database_id = ? AND created_at < ?')
    .bind(databaseId, cutoff)
    .all<SqlRow>();
  const fileIds = (fileRows ?? []).map((row) => sqlString(row, 'id'));
  if (fileIds.length) {
    const removed = await deleteAttachments(env, db, { databaseId, fileIds, tolerateR2Failure: true });
    result.files += removed.files;
    result.bytes += removed.bytes;
  }

  // 3) 记录删掉后，它上面的备注 / 格子编辑记录由外键级联清理
  const deleted = await db
    .prepare('DELETE FROM records WHERE database_id = ? AND created_at < ?')
    .bind(databaseId, cutoff)
    .run();
  const records = Number(deleted.meta?.changes ?? 0);
  result.records += records;

  if (recordIds.length || fileIds.length || records > 0) {
    await logChanges(db, databaseId, 'schema');
    return true;
  }
  return false;
}
