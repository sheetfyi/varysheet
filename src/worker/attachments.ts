/**
 * 附件的 R2 生命周期：**files 行消失之前，它指向的 R2 对象必须一起删掉**。
 *
 * r2_key 只存在 `files` 这一行里（见 `shardSchema.ts`）：行删了、日志里没记 key，
 * 那个对象就再也找不到，R2 占用只会涨不会跌 —— 这正是「R2 容量失控」的根因。
 *
 * 谁走这里（每一处删掉 files 行的地方都要来）：
 *   - 删记录：单条、批量、分享链接删除（`routes/records.ts`、`routes/public.ts`）
 *   - 编辑记录时把附件从「文件与媒体」列里去掉（同上两个文件）
 *   - 删字段（`routes/properties.ts`）
 *   - 保留期清理（`retention.ts`）
 * 不走这里的只有「整张表 / 整个账号一起删」的两处：它们按 `database_id` / `owner_id`
 * 一次清完（`routes/databases.ts` 的 deleteHandler、`admin.ts` 的注销账号）。
 *
 * 引用计数：复制记录时附件行是**克隆**出来的（同一个 r2_key、新的 id，见
 * `routes/records.ts` 的 duplicateRecordsHandler），所以一个 R2 对象可能被多行引用。
 * 这里删完行再数一遍：还有别的行指着这个 key 就留着对象，都不指了才真删 ——
 * 不然删掉一条记录会把另一条记录的附件一起打碎。
 */
import type { FileValue, Property, RowValues } from '../shared/types';
import { newId, sqlNumber, sqlString, type SqlRow } from './http';
import type { Env } from './types';

/** 一次 SQL 里塞多少个 id：避开 D1 的绑定参数上限 */
const ID_CHUNK = 50;
/** 一次交给 R2 的 key 数量上限 */
const R2_DELETE_BATCH = 500;

/** 一次附件清理的结果 */
export interface AttachmentCleanup {
  /** 删掉的 `files` 行数（容量口径：单表附件占用按这些行求和） */
  files: number;
  /** 这些行合计的字节数 */
  bytes: number;
  /** 真正从 R2 删掉的对象数（还有别的行引用同一个 r2_key 时不算） */
  objects: number;
}

/**
 * 清理范围：**至少要给一个筛选条件**（一个都不给就什么都不做，
 * 免得手滑把整张表的附件删空）。几个条件之间是「或」。
 */
export interface AttachmentScope {
  /** 表格 id（必填；分片库里所有查询都带它） */
  databaseId: string;
  /** 这些记录上的附件（删记录 / 清理保留期数据时用） */
  recordIds?: string[];
  /** 这一列的附件（删「文件与媒体」字段时用） */
  propertyId?: string;
  /** 指定的 `files.id`（编辑时从格子里去掉的那几个） */
  fileIds?: string[];
  /**
   * R2 删不动（权限 / 网络抖动）时是否照旧删 `files` 行：
   * 保留期清理这种批量任务要设 true（不能被一个对象卡住整轮清理，宁可留个孤儿对象），
   * 用户主动删记录不设（先报错、下次重试，别把对象的 key 丢掉）。
   */
  tolerateR2Failure?: boolean;
}

function uniqueIds(values: string[] | undefined): string[] {
  if (!values?.length) return [];
  const set = new Set<string>();
  for (const value of values) {
    const id = String(value ?? '').trim();
    if (id) set.add(id);
  }
  return [...set];
}

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < list.length; index += size) out.push(list.slice(index, index + size));
  return out;
}

function marks(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

/**
 * 按范围删附件：先算清楚哪些 R2 对象真的没人再引用，删对象、再删 `files` 行。
 *
 * 顺序是刻意的：对象删成功之前不动数据库 —— 中途失败时 `files` 行还在，
 * 下次（重试 / 下一轮定时清理）还能拿到 key 重删，不会留下永远找不回来的对象。
 */
export async function deleteAttachments(
  env: Env,
  db: D1Database,
  scope: AttachmentScope,
): Promise<AttachmentCleanup> {
  const recordIds = uniqueIds(scope.recordIds);
  const fileIds = uniqueIds(scope.fileIds);
  const propertyId = scope.propertyId?.trim() ?? '';
  if (!recordIds.length && !fileIds.length && !propertyId) return { files: 0, bytes: 0, objects: 0 };

  // 1) 先把要删的行读出来（id + r2_key + size）：行删掉之后就查不到 key 了
  const doomed: SqlRow[] = [];
  const collect = async (where: string, params: unknown[]): Promise<void> => {
    const { results } = await db
      .prepare(`SELECT id, r2_key, size FROM files WHERE ${where}`)
      .bind(...params)
      .all<SqlRow>();
    for (const row of results ?? []) doomed.push(row);
  };

  for (const chunk of chunks(fileIds, ID_CHUNK)) {
    await collect(`database_id = ? AND id IN (${marks(chunk.length)})`, [scope.databaseId, ...chunk]);
  }
  for (const chunk of chunks(recordIds, ID_CHUNK)) {
    await collect(`database_id = ? AND record_id IN (${marks(chunk.length)})`, [scope.databaseId, ...chunk]);
  }
  if (propertyId) {
    await collect('database_id = ? AND property_id = ?', [scope.databaseId, propertyId]);
  }
  if (!doomed.length) return { files: 0, bytes: 0, objects: 0 };

  // 2) 引用计数：这些行都删掉之后，还有没有别的行指着同一个 r2_key
  const doomedIds = new Set(doomed.map((row) => sqlString(row, 'id')));
  const keys = [...new Set(doomed.map((row) => sqlString(row, 'r2_key')).filter(Boolean))];
  const orphanKeys: string[] = [];
  for (const chunk of chunks(keys, ID_CHUNK)) {
    const { results } = await db
      .prepare(`SELECT id, r2_key FROM files WHERE r2_key IN (${marks(chunk.length)})`)
      .bind(...chunk)
      .all<SqlRow>();
    const survivors = new Set<string>();
    for (const row of results ?? []) {
      if (!doomedIds.has(sqlString(row, 'id'))) survivors.add(sqlString(row, 'r2_key'));
    }
    for (const key of chunk) {
      if (!survivors.has(key)) orphanKeys.push(key);
    }
  }

  // 3) 删 R2 对象（分批），再删 files 行
  let objects = 0;
  for (const batch of chunks(orphanKeys, R2_DELETE_BATCH)) {
    if (scope.tolerateR2Failure) await env.BUCKET.delete(batch).catch(() => undefined);
    else await env.BUCKET.delete(batch);
    objects += batch.length;
  }
  for (const chunk of chunks([...doomedIds], ID_CHUNK)) {
    await db
      .prepare(`DELETE FROM files WHERE database_id = ? AND id IN (${marks(chunk.length)})`)
      .bind(scope.databaseId, ...chunk)
      .run();
  }

  return {
    files: doomed.length,
    bytes: doomed.reduce((sum, row) => sum + sqlNumber(row, 'size'), 0),
    objects,
  };
}

/**
 * 编辑一条记录时从「文件与媒体」列里去掉的附件 id：改之前的 id 集合 − 改之后的 id 集合。
 * 只算 `files` 类型且真的少掉了的 id（值被清空、被替换、只留一部分都算）。
 *
 * 调用方拿到结果就交给 `deleteAttachments({ fileIds })`：**只有真的没人再引用的
 * 对象才会从 R2 删掉**，所以这里不必自己去数别的记录。
 */
export function removedAttachmentIds(properties: Property[], before: RowValues, after: RowValues): string[] {
  const removed = new Set<string>();
  const idsOf = (value: unknown): string[] => {
    if (!Array.isArray(value)) return [];
    return value
      .map((item) => (item && typeof item === 'object' ? String((item as { id?: unknown }).id ?? '') : ''))
      .filter(Boolean);
  };
  for (const property of properties) {
    if (property.type !== 'files') continue;
    const next = new Set(idsOf(after[property.id]));
    for (const id of idsOf(before[property.id])) {
      if (!next.has(id)) removed.add(id);
    }
  }
  return [...removed];
}

/**
 * 复制记录时把「文件与媒体」列里的附件一起复制：给新记录写一份**自己的** files 行
 * （同一个 `r2_key`、新的 id），值里的 id 换成新的。
 *
 * 为什么必须克隆：两行共用一个 files 行时，删除任意一条记录都会把那一行删掉，
 * 另一条的附件就查不到了（下载报「文件不存在」）。克隆之后两条记录各自独立，
 * R2 对象由 `deleteAttachments()` 的引用计数保住。
 *
 * 原文件行已经不在（老数据 / 被清理过）时原样保留引用，不凭空造行。
 */
export async function cloneRecordAttachments(
  db: D1Database,
  input: {
    databaseId: string;
    /** 新的记录 id */
    recordId: string;
    values: RowValues;
    properties: Property[];
    uploadedBy?: string | null;
  },
): Promise<RowValues> {
  const targets = input.properties.filter((property) => {
    const value = input.values[property.id];
    return property.type === 'files' && Array.isArray(value) && value.length > 0;
  });
  if (!targets.length) return input.values;

  const ids = [
    ...new Set(
      targets.flatMap((property) =>
        (input.values[property.id] as FileValue[]).map((file) => String(file.id ?? '')),
      ),
    ),
  ].filter(Boolean);
  if (!ids.length) return input.values;

  const byId = new Map<string, SqlRow>();
  for (const chunk of chunks(ids, ID_CHUNK)) {
    const { results } = await db
      .prepare(
        `SELECT id, r2_key, name, size, mime, created_at FROM files
          WHERE database_id = ? AND id IN (${marks(chunk.length)})`,
      )
      .bind(input.databaseId, ...chunk)
      .all<SqlRow>();
    for (const row of results ?? []) byId.set(sqlString(row, 'id'), row);
  }
  if (!byId.size) return input.values;

  const next: RowValues = { ...input.values };
  const inserts: D1PreparedStatement[] = [];
  for (const property of targets) {
    next[property.id] = (input.values[property.id] as FileValue[]).map((file) => {
      const row = byId.get(String(file.id));
      if (!row) return file;
      const copyId = newId();
      inserts.push(
        db
          .prepare(
            `INSERT INTO files (id, database_id, record_id, property_id, r2_key, name, size, mime, uploaded_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            copyId,
            input.databaseId,
            input.recordId,
            property.id,
            sqlString(row, 'r2_key'),
            sqlString(row, 'name', 'file'),
            sqlNumber(row, 'size'),
            sqlString(row, 'mime', 'application/octet-stream'),
            input.uploadedBy ?? null,
            // 沿用原行的创建时间：保留期清理时两份一起到期（不会出现「原件清了、副本还在」）
            sqlNumber(row, 'created_at') || Date.now(),
          ),
      );
      return { ...file, id: copyId } satisfies FileValue;
    });
  }
  if (inserts.length) await db.batch(inserts);
  return next;
}
