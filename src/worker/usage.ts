/**
 * 「最后一次使用」记账（`records.last_used_at` / `files.last_used_at`）。
 *
 * 保留期清理的判定口径是**最后一次使用**而不是创建时间（需求 2026-10）：
 *   试用表格：1 年内没有使用（编辑或查询）的记录与附件自动清除；
 *   基础表格：5 年内没有使用（编辑或查询）的记录与附件自动清除；
 *   专业表格：长期保留（不清理）。
 *
 * 什么算「使用」（见 `src/worker/retention.ts` 的判定）：
 *   1. **编辑**：新建 / 修改记录时直接写入 `last_used_at`（在 `routes/records.ts`、
 *      `routes/public.ts` 的 INSERT / UPDATE 里一起写，不经过这里）；
 *   2. **查询**：列表 / 详情接口把记录返回给用户时调 {@link touchRecordsUsed}；
 *   3. 附件被下载时调 {@link touchFilesUsed}（附件是「用过才留」）。
 *
 * 两个关键设计：
 *   - **节流**：同一行一天只写一次（`USAGE_TOUCH_THROTTLE_MS`）。保留期是「年」级，
 *     精确到天足够；否则每次列表 / 轮询都要写一遍，D1 的写次数会被白白烧掉。
 *   - **尽力而为**：记账失败（分片还没跑 0002 迁移、库暂时抖动）**不影响这次读取** ——
 *     只记一条日志，用户的列表照常返回。少记一次最多让这条记录早一天到期。
 */
import { sqlNumber, type SqlRow } from './http';

/** 同一行多久记一次「使用过」：保留期是年 / 月级，一天一次足够省掉绝大部分写操作 */
export const USAGE_TOUCH_THROTTLE_MS = 24 * 60 * 60 * 1000;

/** 一条 SQL 里塞多少个 id（D1 的绑定参数上限是 999，这里留足余量） */
const TOUCH_CHUNK = 200;

function uniqueIds(values: readonly string[] | undefined): string[] {
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

export interface TouchOptions {
  /** 记账时刻，默认现在 */
  now?: number;
  /** 节流窗口：`last_used_at` 比「现在 - 窗口」还新就不写（默认一天） */
  throttleMs?: number;
}

/**
 * 把这一页记录标成「刚被使用过」（用户查询到了它们）。
 * 返回真正更新了几行（被节流 / id 不存在都会少算），失败不抛错。
 *
 * `db` = 表格所在的分片；`databaseId` 一起作为条件，避免被别处的 id 影响。
 */
export async function touchRecordsUsed(
  db: D1Database,
  databaseId: string,
  recordIds: readonly string[],
  options: TouchOptions = {},
): Promise<number> {
  const ids = uniqueIds(recordIds);
  if (!databaseId || !ids.length) return 0;
  const now = options.now ?? Date.now();
  const threshold = now - (options.throttleMs ?? USAGE_TOUCH_THROTTLE_MS);

  let changed = 0;
  for (const chunk of chunks(ids, TOUCH_CHUNK)) {
    try {
      const result = await db
        .prepare(
          `UPDATE records SET last_used_at = ?
            WHERE database_id = ? AND id IN (${marks(chunk.length)})
              AND (last_used_at = 0 OR last_used_at < ?)`,
        )
        .bind(now, databaseId, ...chunk, threshold)
        .run();
      changed += Number(result.meta?.changes ?? 0);
    } catch (error) {
      console.warn('记录使用时间记账失败（不影响读取）：', error);
    }
  }
  return changed;
}

/**
 * 把附件标成「刚被使用过」（用户下载了它）。返回更新行数，失败不抛错。
 * 附件行按 id 定位（`files` 跟着表格落在分片里，调用方已经拿着那一行）。
 */
export async function touchFilesUsed(
  db: D1Database,
  fileIds: readonly string[],
  options: TouchOptions = {},
): Promise<number> {
  const ids = uniqueIds(fileIds);
  if (!ids.length) return 0;
  const now = options.now ?? Date.now();
  const threshold = now - (options.throttleMs ?? USAGE_TOUCH_THROTTLE_MS);

  let changed = 0;
  for (const chunk of chunks(ids, TOUCH_CHUNK)) {
    try {
      const result = await db
        .prepare(
          `UPDATE files SET last_used_at = ?
            WHERE id IN (${marks(chunk.length)})
              AND (last_used_at = 0 OR last_used_at < ?)`,
        )
        .bind(now, ...chunk, threshold)
        .run();
      changed += Number(result.meta?.changes ?? 0);
    } catch (error) {
      console.warn('附件使用时间记账失败（不影响下载）：', error);
    }
  }
  return changed;
}

/**
 * 一行记录的「最后一次使用」时刻：`last_used_at` 没记过（0 / 空）时退回 `updated_at`
 * —— 迁移之前的老数据没记过这一列，用「最后编辑时间」兜底，口径不变。
 * 与 `retention.ts` 里的 SQL 口径一致，页面上要展示时用它。
 */
export function lastUsedAtOf(row: SqlRow): number {
  return sqlNumber(row, 'last_used_at') || sqlNumber(row, 'updated_at') || sqlNumber(row, 'created_at');
}
