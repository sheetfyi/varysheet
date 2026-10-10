/**
 * 单元格级「限制编辑」：勾选了「限制编辑」的分享（公开链接 / 视图定向分享）里的
 * 访问者对**每一格**的输入次数不限，但有时间限制 ——
 *
 * - 每次保存成功（这一格有内容）都从那一刻开始计时 `CELL_EDIT_GRACE_MS`（10 秒）：
 *   窗口内想改多少遍都行，每次保存都把窗口重新起算；
 * - 10 秒一到，只要这一格**仍然有内容**，就不能再输入 / 上传 / 清空（403），
 *   只能请表格所有者代改；
 * - 如果这 10 秒内把这一格清空，就当作「没输入过」：连记账一起删掉，之后可以
 *   重新输入（重新开始计时），不受任何限制；
 * - 判断锁定时会一起看这一格**现在的值**：值为空的格子永远不算锁上
 *   （历史遗留的记账、或经别的路径清空过的格子都能自愈）。
 *
 * - 只有带 `limit_edits = 1` 的分享才受限制：公开链接（shares）/ 视图定向分享
 *   （view_shares）在创建时勾选了「限制编辑」才算；
 * - 表格所有者、表格成员、以及没勾选「限制编辑」的分享都不受限制，
 *   也永远不会写入 `cell_edits`；
 * - 值没变的 noop 保存不算「输入」，既不开始计时也不刷新窗口。
 */
import { CELL_EDIT_GRACE_MS, cellLockHint, cellLockKey, isEmptyValue, sameCellValue } from '../shared/fields';
import type { CellEditLocks, Property, RowValues } from '../shared/types';
import type { DatabaseAccess, ShareAccess } from './access';
import { forbidden, newId, parseJsonObject, sqlNumber, sqlString, type SqlRow } from './http';

/** D1 单条 SQL 最多绑定 100 个参数：每行 6 列，因此一次最多写 10 行 */
const INSERT_CHUNK = 10;
/** IN (...) 查询的分片大小：1 个 database_id + 1 个 editor_key + N 个记录 id */
const SELECT_CHUNK = 90;
/** DELETE ... property_id IN (...) 的分片大小：3 个绑定参数 + N 个字段 id */
const DELETE_CHUNK = 90;

/**
 * 登录用户（视图定向分享的 editor）的归属键。
 * 表格所有者与表格成员返回 null（不受限制）。
 */
export function memberCellEditKey(
  access: Pick<DatabaseAccess, 'role' | 'userId' | 'limitCellEdits'>,
): string | null {
  if (access.role === 'owner' || !access.limitCellEdits) return null;
  return `user:${access.userId}`;
}

/**
 * 公开分享链接的归属键：同一个链接的所有访客共用这一套记账。
 * 没勾选「限制编辑」的链接返回 null（不受限制）。
 */
export function shareCellEditKey(share: Pick<ShareAccess, 'shareId' | 'limitEdits'>): string | null {
  return share.limitEdits ? `share:${share.shareId}` : null;
}

/**
 * 本次请求真正改动的字段 id。
 * 值没变（例如前端把整行原样提交回来）不算改动，不该消耗那次机会。
 */
export function changedPropertyIds(
  properties: Property[],
  current: RowValues,
  next: RowValues,
  incoming: unknown,
): string[] {
  if (!incoming || typeof incoming !== 'object') return [];
  const keys = new Set(Object.keys(incoming as Record<string, unknown>));
  return properties
    .filter((property) => keys.has(property.id) && !sameCellValue(current[property.id], next[property.id]))
    .map((property) => property.id);
}

/**
 * 访问者在这些记录里的单元格状态：
 * - `lockedCells`：保存过、计时窗口已过、且这一格**现在仍有内容**的格子（只读）；
 * - `cellEditGrace`：还在 10 秒计时窗口内（可以继续改）的格子 → 窗口截止时刻。
 * 两个列表里的键都是 `记录 id:字段 id`（见 `cellLockKey`）。
 *
 * 现在的值是空字符串 / 空数组的格子一律不算锁上（窗口内被清空 = 没输入过），
 * 所以这里要连 `records."values"` 一起查。
 */
export async function loadCellEditLocks(
  db: D1Database,
  databaseId: string,
  editorKey: string | null,
  recordIds: string[],
): Promise<CellEditLocks> {
  const locks: CellEditLocks = { lockedCells: [], cellEditGrace: {} };
  if (!editorKey || !recordIds.length) return locks;
  const now = Date.now();
  for (let index = 0; index < recordIds.length; index += SELECT_CHUNK) {
    const slice = recordIds.slice(index, index + SELECT_CHUNK);
    const { results } = await db.prepare(
      `SELECT ce.record_id, ce.property_id, ce.created_at, r."values" AS row_values
         FROM cell_edits ce JOIN records r ON r.id = ce.record_id
        WHERE ce.database_id = ? AND ce.editor_key = ? AND ce.record_id IN (${slice.map(() => '?').join(', ')})`,
    )
      .bind(databaseId, editorKey, ...slice)
      .all<SqlRow>();
    for (const row of results ?? []) {
      const propertyId = sqlString(row, 'property_id');
      const rowValues = parseJsonObject<RowValues>(sqlString(row, 'row_values'), {});
      // 这一格现在是空的：说明最后一次输入被清掉了，不算锁、也不用倒计时
      if (isEmptyValue(rowValues[propertyId])) continue;
      const key = cellLockKey(sqlString(row, 'record_id'), propertyId);
      const until = sqlNumber(row, 'created_at') + CELL_EDIT_GRACE_MS;
      if (until > now) locks.cellEditGrace[key] = until;
      else locks.lockedCells.push(key);
    }
  }
  return locks;
}

/**
 * 这些格子里只要有一个「保存过、计时窗口已过、且现在还有内容」就拒绝本次保存。
 *
 * - 还在 10 秒窗口内的格子照常放行（每次保存都把窗口重新起算，改多少遍都行）；
 * - 现在值为空的格子也放行（窗口内被清空 = 没输入过）；
 * - `editorKey` 为 null（表格所有者 / 表格成员 / 不受限的分享）时直接放行。
 */
export async function assertCellsEditable(
  db: D1Database,
  databaseId: string,
  editorKey: string | null,
  recordId: string,
  propertyIds: string[],
  properties: Property[],
): Promise<void> {
  if (!editorKey || !propertyIds.length) return;
  const { results } = await db.prepare(
    `SELECT ce.property_id, ce.created_at, r."values" AS row_values
       FROM cell_edits ce JOIN records r ON r.id = ce.record_id
      WHERE ce.database_id = ? AND ce.editor_key = ? AND ce.record_id = ?`,
  )
    .bind(databaseId, editorKey, recordId)
    .all<SqlRow>();
  if (!results?.length) return;

  const now = Date.now();
  const rowValues = parseJsonObject<RowValues>(sqlString(results[0], 'row_values'), {});
  const spent = new Set<string>();
  for (const row of results) {
    // 还在计时窗口内：允许继续重新输入 / 修改
    if (sqlNumber(row, 'created_at') + CELL_EDIT_GRACE_MS > now) continue;
    const propertyId = sqlString(row, 'property_id');
    // 这一格现在是空的（窗口内被清掉了）：视为没输入过，允许重新填
    if (isEmptyValue(rowValues[propertyId])) continue;
    spent.add(propertyId);
  }
  const hitId = propertyIds.find((propertyId) => spent.has(propertyId));
  if (!hitId) return;

  const name = properties.find((property) => property.id === hitId)?.name ?? '该字段';
  throw forbidden(cellLockHint(name));
}

/**
 * 单个格子是否已经锁上（保存过、计时窗口已过、且现在还有内容）。
 * 文件上传 / 删除附件这类绕过 PATCH 的入口用它，窗口内与空值同样放行。
 */
export async function isCellLocked(
  db: D1Database,
  databaseId: string,
  editorKey: string | null,
  recordId: string,
  propertyId: string,
): Promise<boolean> {
  if (!editorKey) return false;
  const row = await db.prepare(
    `SELECT ce.created_at, r."values" AS row_values
       FROM cell_edits ce JOIN records r ON r.id = ce.record_id
      WHERE ce.database_id = ? AND ce.editor_key = ? AND ce.record_id = ? AND ce.property_id = ?`,
  )
    .bind(databaseId, editorKey, recordId, propertyId)
    .first<SqlRow>();
  if (!row) return false;
  if (sqlNumber(row, 'created_at') + CELL_EDIT_GRACE_MS > Date.now()) return false;
  const rowValues = parseJsonObject<RowValues>(sqlString(row, 'row_values'), {});
  // 这一格现在是空的：说明最后是被清掉的，不算锁
  return !isEmptyValue(rowValues[propertyId]);
}

/**
 * 记住这次保存过的格子（写入成功后调用），决定这几格接下来受不受限制：
 *
 * - 值非空：登记 / 刷新 `created_at` 为**本次保存的时刻** —— 计时窗口每次都从最新
 *   一次输入重新起算，所以窗口内想改多少遍都行；
 * - 值为空：删掉记账 —— 10 秒内把内容清掉等于「没输入过」，之后可以重新输入。
 *
 * `editorKey` 为 null（表格所有者 / 表格成员 / 不受限的分享）时什么都不做。
 */
export async function applyCellEdits(
  db: D1Database,
  databaseId: string,
  editorKey: string | null,
  recordId: string,
  propertyIds: string[],
  values: RowValues,
): Promise<void> {
  if (!editorKey || !propertyIds.length) return;
  const cleared: string[] = [];
  const filled: string[] = [];
  for (const propertyId of propertyIds) {
    if (isEmptyValue(values[propertyId])) cleared.push(propertyId);
    else filled.push(propertyId);
  }

  for (let index = 0; index < cleared.length; index += DELETE_CHUNK) {
    const slice = cleared.slice(index, index + DELETE_CHUNK);
    await db
      .prepare(
      `DELETE FROM cell_edits
        WHERE database_id = ? AND editor_key = ? AND record_id = ?
          AND property_id IN (${slice.map(() => '?').join(', ')})`,
    )
      .bind(databaseId, editorKey, recordId, ...slice)
      .run();
  }

  if (!filled.length) return;
  const now = Date.now();
  for (let index = 0; index < filled.length; index += INSERT_CHUNK) {
    const slice = filled.slice(index, index + INSERT_CHUNK);
    const placeholders = slice.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
    // 已有记录就刷新时刻：每次输入都重新开始 10 秒计时
    await db
      .prepare(
      `INSERT INTO cell_edits (id, database_id, record_id, property_id, editor_key, created_at)
       VALUES ${placeholders}
       ON CONFLICT (editor_key, record_id, property_id) DO UPDATE SET created_at = excluded.created_at`,
    )
      .bind(
        ...slice.flatMap((propertyId) => [
          newId(),
          databaseId,
          recordId,
          propertyId,
          editorKey,
          now,
        ]),
      )
      .run();
  }
}
