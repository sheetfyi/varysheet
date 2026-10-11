/**
 * 表格名额的「时长」与「删表不退」记账（用户库的两张表，见 migrations/control/0017_slot_renewals.sql）。
 *
 * 两件事：
 *   1) **删表不退还名额**：基础 / 专业表格被删掉时写一行 `table_slot_consumptions`，
 *      `GET /api/quota` 的「已用」= 未归档表格数 + 这些流水（见 `routes/quota.ts`）。
 *      试用表格不记账：删掉就退还名额（口径见 `shared/quota.ts`）。
 *   2) **表格的时长与续费**：基础 / 专业表格建表时按「该类型最近一次购买」的时长起算，
 *      写一行 `table_slot_allocations`（`expires_at` = 建表时刻 + 时长）；
 *      剩余不到一周（`SLOT_RENEW_WINDOW_DAYS`）时前端显示「续费」，
 *      续费走同一套下单 / 支付流程，但流水带 `database_id`（不算新增名额），
 *      交付时把 `expires_at` 从 `max(now, 原到期时间)` 往后推。
 *
 * 这里不导入任何 `routes/*`（避免循环依赖）；只依赖用户库、共享口径与分片定位。
 */
import { addMonths, slotRenewable } from '../shared/quota';
import { asTableKind } from '../shared/tableKind';
import type { TableKind } from '../shared/types';
import { newId, sqlNumber, sqlString, type SqlRow } from './http';
import { databaseDb } from './shards';
import type { Env } from './types';

/** 一张基础 / 专业表格的时长记录 */
export interface SlotAllocation {
  databaseId: string;
  userId: string;
  kind: TableKind;
  /** 建表 / 上次续费时用的时长（月） */
  months: number;
  /** 到期时刻（毫秒）；0 = 没有时长记录（迁移前建的老表） */
  expiresAt: number;
}

/** 续费的目标表格（下单前的校验结果） */
export interface RenewTarget {
  databaseId: string;
  kind: TableKind;
  expiresAt: number;
}

/**
 * 记住「这张表把名额带走了」：删表时调用（试用表格不调用，所以这里直接忽略 trial）。
 */
export async function recordSlotConsumption(
  env: Env,
  input: { userId: string; databaseId: string; kind: TableKind | string; reason?: string },
): Promise<void> {
  const kind = asTableKind(input.kind);
  if (kind === 'trial') return;
  await env.DB.prepare(
    `INSERT INTO table_slot_consumptions (id, user_id, database_id, kind, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(newId(), input.userId, input.databaseId, kind, input.reason ?? 'delete', Date.now())
    .run();
}

/** 已经被「带走」的名额数（只有基础 / 专业两类会记账，试用表格恒为 0） */
export async function countConsumedSlots(env: Env, userId: string): Promise<{ basic: number; pro: number }> {
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM table_slot_consumptions WHERE user_id = ? AND kind = 'basic') AS basic,
       (SELECT COUNT(*) FROM table_slot_consumptions WHERE user_id = ? AND kind = 'pro') AS pro`,
  )
    .bind(userId, userId)
    .first<SqlRow>();
  return { basic: sqlNumber(row ?? {}, 'basic'), pro: sqlNumber(row ?? {}, 'pro') };
}

/** 该类型最近一次「新增名额」的购买时长（月）：建表时按它起算，没买过就按 1 个月 */
export async function latestPurchaseMonths(env: Env, userId: string, kind: TableKind | string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT months FROM table_purchases
      WHERE user_id = ? AND kind = ? AND database_id = ''
      ORDER BY created_at DESC, id DESC LIMIT 1`,
  )
    .bind(userId, asTableKind(kind))
    .first<SqlRow>();
  const months = sqlNumber(row ?? {}, 'months', 1);
  return months > 0 ? months : 1;
}

/**
 * 给刚建好的表格记一段时长（按该类型最近一次购买的时长起算），返回到期时刻。
 * 已经有记录时不覆盖（老表补建 / 重复调用都安全）；试用表格返回 0（没有时长概念）。
 */
export async function allocateSlot(
  env: Env,
  input: { userId: string; databaseId: string; kind: TableKind | string },
): Promise<number> {
  const kind = asTableKind(input.kind);
  if (kind === 'trial') return 0;
  const existing = await env.DB.prepare('SELECT expires_at FROM table_slot_allocations WHERE database_id = ?')
    .bind(input.databaseId)
    .first<SqlRow>();
  if (existing) return sqlNumber(existing, 'expires_at');

  const now = Date.now();
  const months = await latestPurchaseMonths(env, input.userId, kind);
  const expiresAt = addMonths(now, months, now);
  await env.DB.prepare(
    `INSERT INTO table_slot_allocations (database_id, user_id, kind, months, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (database_id) DO NOTHING`,
  )
    .bind(input.databaseId, input.userId, kind, months, expiresAt, now, now)
    .run();
  const stored = await env.DB.prepare('SELECT expires_at FROM table_slot_allocations WHERE database_id = ?')
    .bind(input.databaseId)
    .first<SqlRow>();
  return stored ? sqlNumber(stored, 'expires_at') : expiresAt;
}

/** 一次读全这个账号所有表格的到期时间：`databaseId → expiresAt`（表格列表用它填 `slotExpiresAt`） */
export async function loadSlotAllocations(env: Env, userId: string): Promise<Map<string, number>> {
  const { results } = await env.DB.prepare(
    'SELECT database_id, expires_at FROM table_slot_allocations WHERE user_id = ?',
  )
    .bind(userId)
    .all<SqlRow>();
  const map = new Map<string, number>();
  for (const row of results ?? []) {
    map.set(sqlString(row, 'database_id'), sqlNumber(row, 'expires_at'));
  }
  return map;
}

/**
 * 续费：把这张表的到期时间往后推 `months` 个月（从 `max(now, 原到期时间)` 起算），返回新的到期时刻。
 * 老表格（没有时长记录）会先补一条，再往后推。
 */
export async function renewSlot(
  env: Env,
  input: { userId: string; databaseId: string; kind: TableKind | string; months: number },
): Promise<number> {
  const kind = asTableKind(input.kind);
  const now = Date.now();
  const current = await env.DB.prepare(
    'SELECT expires_at, months FROM table_slot_allocations WHERE database_id = ? AND user_id = ?',
  )
    .bind(input.databaseId, input.userId)
    .first<SqlRow>();
  const months = input.months > 0 ? Math.trunc(input.months) : 1;
  const base = Math.max(now, current ? sqlNumber(current, 'expires_at') : 0);
  const expiresAt = addMonths(base, months, now);

  if (current) {
    await env.DB.prepare(
      'UPDATE table_slot_allocations SET months = ?, expires_at = ?, updated_at = ? WHERE database_id = ?',
    )
      .bind(months, expiresAt, now, input.databaseId)
      .run();
    return expiresAt;
  }

  await env.DB.prepare(
    `INSERT INTO table_slot_allocations (database_id, user_id, kind, months, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (database_id) DO UPDATE SET months = excluded.months, expires_at = excluded.expires_at,
       updated_at = excluded.updated_at`,
  )
    .bind(input.databaseId, input.userId, kind, months, expiresAt, now, now)
    .run();
  return expiresAt;
}

/** 这张表现在该不该显示「续费」：有时长记录、且剩余不超过一周（已过期也算） */
export function slotNeedsRenewal(allocation: SlotAllocation | undefined, now = Date.now()): boolean {
  return allocation ? slotRenewable(allocation.expiresAt, now) : false;
}

/**
 * 校验「要续费的是哪张表」：先看时长记录，没有就到分片里确认这张表属于这个账号
 * （迁移之前建的老表现场补一条时长记录）。不存在 / 不是自己的 / 试用表格都返回 null。
 */
export async function resolveRenewTarget(
  env: Env,
  userId: string,
  databaseId: string,
): Promise<RenewTarget | null> {
  const id = databaseId.trim();
  if (!id) return null;

  const row = await env.DB.prepare(
    'SELECT database_id, kind, expires_at FROM table_slot_allocations WHERE database_id = ? AND user_id = ?',
  )
    .bind(id, userId)
    .first<SqlRow>();
  if (row) {
    const kind = asTableKind(sqlString(row, 'kind', 'basic'));
    if (kind === 'trial') return null;
    return { databaseId: id, kind, expiresAt: sqlNumber(row, 'expires_at') };
  }

  // 老表格：到分片里确认归属（找不到分片 / 已经被删掉都当「不存在」）
  let db: D1Database;
  try {
    db = await databaseDb(env, id);
  } catch {
    return null;
  }
  const live = await db
    .prepare('SELECT kind, owner_id FROM databases WHERE id = ? AND is_archived = 0')
    .bind(id)
    .first<SqlRow>();
  if (!live || sqlString(live, 'owner_id') !== userId) return null;

  const kind = asTableKind(sqlString(live, 'kind', 'basic'));
  if (kind === 'trial') return null;
  const expiresAt = await allocateSlot(env, { userId, databaseId: id, kind });
  return { databaseId: id, kind, expiresAt };
}
