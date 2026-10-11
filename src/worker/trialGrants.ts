/**
 * 试用表格的赠额流水（用户库的 `trial_table_grants` 表）。
 *
 * 试用名额的口径见 `src/shared/quota.ts`：
 *   - 新注册账号送的 1 个由 `BASE_TABLE_QUOTA.trial` 直接给出，**不写这张表**；
 *   - 每成功邀请一位**真的注册成功了**的新用户（对方从 `/invite/<token>` 完成注册），
 *     邀请人的试用表格名额 +1 —— 这时才写一行流水，`GET /api/quota` 里试用名额的
 *     「赠额」就是这些行的条数。
 *
 * 只记账、不建表：新建的试用表格落在专门的试用分片库（`DB_TABLES_TRIAL`）里。
 * 写库用 `INSERT OR IGNORE` + 部分唯一索引（见 migrations/control/0014_trial_tables.sql），
 * 同一条邀请被重复接受 / 重放都不会重复加名额。
 */
import { newId, sqlNumber, type SqlRow } from './http';
import type { Env } from './types';

/** 流水的原因：目前只有「成功邀请一位新用户注册」这一种 */
export const TRIAL_GRANT_REASON_INVITE = 'invite';

export interface TrialGrantInput {
  /** 拿到赠额的账号（邀请人） */
  userId: string;
  /** 被邀请的邮箱（只用于留痕） */
  invitedEmail?: string;
  /** 对方注册成功后生成的账号 id（幂等键） */
  invitedUserId?: string;
  /** 记账时刻，默认现在 */
  createdAt?: number;
}

/**
 * 给邀请人的试用表格名额 +1；真的写进去了才返回 true
 * （重复调用、或者同一个被邀请人再来一次，都会被唯一索引挡下）。
 */
export async function grantTrialTable(env: Env, input: TrialGrantInput): Promise<boolean> {
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO trial_table_grants
       (id, user_id, reason, invited_email, invited_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      newId(),
      input.userId,
      TRIAL_GRANT_REASON_INVITE,
      input.invitedEmail ?? '',
      input.invitedUserId ?? null,
      input.createdAt ?? Date.now(),
    )
    .run();
  return Number(result.meta?.changes ?? 0) > 0;
}

/** 这个账号靠「邀请新用户」攒到的试用表格名额（流水条数） */
export async function countInviteTrialGrants(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS granted FROM trial_table_grants WHERE user_id = ? AND reason = ?',
  )
    .bind(userId, TRIAL_GRANT_REASON_INVITE)
    .first<SqlRow>();
  return sqlNumber(row ?? {}, 'granted');
}
