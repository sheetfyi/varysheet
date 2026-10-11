/**
 * 表格名额的「时长」与「删表不退」记账（用户库的两张表，见 migrations/control/0017_slot_renewals.sql）。
 *
 * 两件事：
 *   1) **删表带走名额**：表格被删掉时写一行 `table_slot_consumptions`，
 *      `GET /api/quota` 的「已用」= 未归档表格数 + 这些流水（见 `routes/quota.ts`）。
 *      三类表格都记账（2026-10 口径）：
 *        - 基础 / 专业表格：删掉就等于把那个名额一起带走，不给回；
 *        - 试用表格：删掉同样把名额带走（无法恢复），**但**账号里一张试用表格都没有时，
 *          `shared/quota.ts` 的 `TRIAL_FREEBIE_FLOOR` 会保底给回 1 个名额 ——
 *          也就是「试用表格全部删完后系统自动再赠 1 个」，每个人随时都能免费拥有一张。
 *   2) **表格的时长与续费**：基础 / 专业表格建表时按「该类型最近一次购买」的时长起算，
 *      写一行 `table_slot_allocations`（`expires_at` = 建表时刻 + 时长）；
 *      剩余不到一周（`SLOT_RENEW_WINDOW_DAYS`）时前端显示「续费」，
 *      续费走同一套下单 / 支付流程，但流水带 `database_id`（不算新增名额），
 *      交付时把 `expires_at` 从 `max(now, 原到期时间)` 往后推。
 *      **到期没续费只拦增长**：`assertSlotActive()` 把「新增记录 / 新增视图」挡回 403
 *      `slot_expired`，查看、编辑、删除、分享照常（数据都是用户的，不能因为到期就锁住）。
 *
 * 这里不导入任何 `routes/*`（避免循环依赖）；只依赖用户库、共享口径与分片定位。
 */
import { SLOT_EXPIRED, addMonths, slotExpired, slotExpiredHint } from '../shared/quota';
import { asTableKind } from '../shared/tableKind';
import type { TableKind } from '../shared/types';
import { forbidden, newId, sqlNumber, sqlString, type SqlRow } from './http';
import { databaseDb } from './shards';
import type { Env } from './types';

/** 一次 SQL 里塞多少个表格 id */
const SLOT_ID_CHUNK = 50;

/** 续费的目标表格（下单前的校验结果） */
export interface RenewTarget {
  databaseId: string;
  kind: TableKind;
  expiresAt: number;
}

/**
 * 记住「这张表把名额带走了」：删表时调用（三类表格都记账 —— 试用表格删掉同样消耗名额，
 * 但「试用表格全部删完」时由 `shared/quota.ts` 的保底规则再给回 1 个）。
 */
export async function recordSlotConsumption(
  env: Env,
  input: { userId: string; databaseId: string; kind: TableKind | string; reason?: string },
): Promise<void> {
  const kind = asTableKind(input.kind);
  await env.DB.prepare(
    `INSERT INTO table_slot_consumptions (id, user_id, database_id, kind, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(newId(), input.userId, input.databaseId, kind, input.reason ?? 'delete', Date.now())
    .run();
}

/** 已经被「带走」的名额数（三类各自记账；试用表格的保底规则在 `shared/quota.ts` 里补回来） */
export async function countConsumedSlots(
  env: Env,
  userId: string,
): Promise<{ trial: number; basic: number; pro: number }> {
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM table_slot_consumptions WHERE user_id = ? AND kind = 'trial') AS trial,
       (SELECT COUNT(*) FROM table_slot_consumptions WHERE user_id = ? AND kind = 'basic') AS basic,
       (SELECT COUNT(*) FROM table_slot_consumptions WHERE user_id = ? AND kind = 'pro') AS pro`,
  )
    .bind(userId, userId, userId)
    .first<SqlRow>();
  return {
    trial: sqlNumber(row ?? {}, 'trial'),
    basic: sqlNumber(row ?? {}, 'basic'),
    pro: sqlNumber(row ?? {}, 'pro'),
  };
}

/**
 * 该类型最近一次「新增名额」的购买时长（月）：建表时按它起算，没买过就按 1 个月。
 */
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
 * 老表格（迁移 0017 之前建的，没有 `table_slot_allocations` 行）的兜底到期时间：
 * 按该类型**最近一笔**「新增名额」购买算 `created_at + months`；没买过就返回 0（不显示「续费」）。
 *
 * 只用来决定清单里要不要显示「续费」；真正续费时 `resolveRenewTarget()` 会现场补一条时长记录。
 */
export async function latestPurchaseExpiry(
  env: Env,
  userId: string,
  kind: TableKind | string,
): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT created_at, months FROM table_purchases
      WHERE user_id = ? AND kind = ? AND database_id = ''
      ORDER BY created_at DESC, id DESC LIMIT 1`,
  )
    .bind(userId, asTableKind(kind))
    .first<SqlRow>();
  if (!row) return 0;
  const months = sqlNumber(row, 'months', 1);
  return addMonths(sqlNumber(row, 'created_at'), months > 0 ? months : 1);
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

/**
 * 一次读全这些表格的到期时间：`databaseId → expiresAt`（表格列表用它填 `slotExpiresAt`）。
 *
 * 按 id 查（不是按账号）：清单里可能混着「别人分享给我的表」，时长属于表格所有者；
 * 同一张表只会有一行记录，所以按 id 查到的就是最权威的口径。
 * 迁移（0017）之前建的老表格没有记录，调用方再用 `latestPurchaseExpiry()` 兜底。
 */
export async function loadSlotExpiries(env: Env, databaseIds: string[]): Promise<Map<string, number>> {
  const ids = [...new Set(databaseIds.filter(Boolean))];
  const map = new Map<string, number>();
  for (let index = 0; index < ids.length; index += SLOT_ID_CHUNK) {
    const chunk = ids.slice(index, index + SLOT_ID_CHUNK);
    const { results } = await env.DB.prepare(
      `SELECT database_id, expires_at FROM table_slot_allocations
        WHERE database_id IN (${chunk.map(() => '?').join(', ')})`,
    )
      .bind(...chunk)
      .all<SqlRow>();
    for (const row of results ?? []) {
      map.set(sqlString(row, 'database_id'), sqlNumber(row, 'expires_at'));
    }
  }
  return map;
}

/**
 * 一张表的到期时刻（毫秒）：基础 / 专业表格的时长记在用户库的 `table_slot_allocations`。
 * 老表格（0017 之前建的，没有那一行）退回「该类型最近一笔购买的到期时间」——
 * 和表格清单里显示「续费」的口径完全一致；试用表格 / 从没买过 → 0（没有时长，不算到期）。
 */
export async function slotExpiryOf(
  env: Env,
  databaseId: string,
  ownerId: string,
  kind: TableKind | string,
): Promise<number> {
  const resolved = asTableKind(kind);
  if (resolved === 'trial') return 0;
  const row = await env.DB.prepare('SELECT expires_at FROM table_slot_allocations WHERE database_id = ?')
    .bind(databaseId)
    .first<SqlRow>();
  if (row) return sqlNumber(row, 'expires_at');
  return latestPurchaseExpiry(env, ownerId, resolved);
}

/**
 * 「到期未续费」的增长门禁：新增记录 / 批量新建 / 复制记录 / 新增视图之前调用。
 *
 * 到期后**只拦增长** —— 编辑已有记录、删除记录（含删记录时一起清掉的附件）、查询、
 * 增量同步、分享、导出都照常，不然用户到期后连自己的数据都收拾不了了。
 * 表格类型与所有者从分片库里读，所以成员 / 分享链接的写入也能算对账（`meta` 已查过就传进来）。
 */
export async function assertSlotActive(
  env: Env,
  db: D1Database,
  databaseId: string,
  meta?: { kind: TableKind; ownerId: string },
): Promise<void> {
  let kind = meta?.kind;
  let ownerId = meta?.ownerId;
  if (!kind || !ownerId) {
    const row = await db
      .prepare('SELECT kind, owner_id FROM databases WHERE id = ?')
      .bind(databaseId)
      .first<SqlRow>();
    // 表格不存在：交给调用方的 404 去报（这里不当成「到期」）
    if (!row) return;
    kind = asTableKind(sqlString(row, 'kind', 'basic'));
    ownerId = sqlString(row, 'owner_id');
  }
  if (kind === 'trial') return;
  const expiresAt = await slotExpiryOf(env, databaseId, ownerId, kind);
  if (!slotExpired(expiresAt)) return;
  throw forbidden(slotExpiredHint(kind, expiresAt), SLOT_EXPIRED);
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
