/**
 * 视图分享邀请（`invites` 表）。
 *
 * 「视图定向分享」在目标邮箱还没注册时不再直接报错：所有者确认后由这里
 * 生成一条邀请 + 一封邮件，对方点开 `/invite/<token>` 填昵称 + 密码即完成注册，
 * 并自动获得这条视图分享。
 *
 * 和注册确认码同一个思路，邀请只保存「待接受」状态：
 *   - 只有接受的那一刻才插入 users 行（没接受的邀请不占用邮箱，也不出现在用户列表里）；
 *   - token 是一次性随机串，过期（默认 7 天）或已被接受即作废；
 *   - 同一个邮箱 + 同一个视图只保留最新的一条待接受邀请（重发即覆盖）。
 */
import type { ViewInviteInfo } from '../shared/types';
import { emailFailure, sendEmail, shouldEchoCode, viewInviteEmail } from './email';
import { badGateway, newId, randomToken, sqlNullableNumber, sqlNumber, sqlString, type SqlRow } from './http';
import { loadSiteSettings } from './settings';
import { findEntityShard } from './shards';
import type { Env } from './types';

export type InviteRole = 'viewer' | 'editor';

/** 邀请链接有效期（天） */
export const INVITE_TTL_DAYS = 7;

export interface ViewInviteRecord {
  id: string;
  token: string;
  email: string;
  databaseId: string;
  viewId: string;
  role: InviteRole;
  limitEdits: boolean;
  invitedBy: string | null;
  createdAt: number;
  expiresAt: number;
  acceptedAt: number | null;
}

export function inviteFromRow(row: SqlRow): ViewInviteRecord {
  return {
    id: sqlString(row, 'id'),
    token: sqlString(row, 'token'),
    email: sqlString(row, 'email'),
    databaseId: sqlString(row, 'database_id'),
    viewId: sqlString(row, 'view_id'),
    role: sqlString(row, 'role', 'viewer') === 'editor' ? 'editor' : 'viewer',
    limitEdits: sqlNumber(row, 'limit_edits') === 1,
    invitedBy: sqlString(row, 'invited_by') || null,
    createdAt: sqlNumber(row, 'created_at'),
    expiresAt: sqlNumber(row, 'expires_at'),
    acceptedAt: sqlNullableNumber(row, 'accepted_at'),
  };
}

/** 当前是否还有效（没过期、没被接受）。 */
export function inviteIsUsable(invite: ViewInviteRecord, now = Date.now()): boolean {
  return invite.acceptedAt === null && invite.expiresAt > now;
}

/** 邀请 + 它所在的分片（token 是全局唯一的，探测一次就把两样都拿到）。 */
export interface LoadedInvite {
  invite: ViewInviteRecord;
  db: D1Database;
}

/**
 * 按 token 取出邀请。
 *
 * `invites` 表随表格落在分片里，而 token 不是表格 id，所以只能逐分片探测
 * （`findEntityShard` 命中即止，结果按 isolate 缓存）。
 */
export async function loadInviteByToken(env: Env, token: string): Promise<LoadedInvite | null> {
  if (!token) return null;
  const handle = await findEntityShard(env, 'invites', 'token', token);
  if (!handle) return null;
  const row = await handle.db.prepare('SELECT * FROM invites WHERE token = ?').bind(token).first<SqlRow>();
  return row ? { invite: inviteFromRow(row), db: handle.db } : null;
}

/** 邀请链接：`<origin>/invite/<token>`（前端 SPA 路由，见 client/App.tsx）。 */
export function inviteLink(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, '')}/invite/${encodeURIComponent(token)}`;
}

/**
 * 为「还没注册的邮箱」发一条视图分享邀请（同一个视图上的旧邀请会被替换）。
 * 只写库，不投递邮件（投递见 {@link deliverViewInvite}）。
 *
 * `db` 是这张表格所在的分片（调用方已经做过访问检查，传 `tableDb(ctx)`）。
 */
export async function issueViewInvite(
  db: D1Database,
  input: {
    email: string;
    databaseId: string;
    viewId: string;
    role: InviteRole;
    limitEdits: boolean;
    invitedBy: string;
  },
): Promise<ViewInviteRecord> {
  const now = Date.now();
  // 同一个邮箱 + 视图：旧的待接受邀请作废（重发 / 换角色都以最新一次为准）
  await db
    .prepare('DELETE FROM invites WHERE email = ? AND view_id = ? AND accepted_at IS NULL')
    .bind(input.email, input.viewId)
    .run();

  const invite: ViewInviteRecord = {
    id: newId(),
    token: randomToken(24),
    email: input.email,
    databaseId: input.databaseId,
    viewId: input.viewId,
    role: input.role,
    limitEdits: input.limitEdits,
    invitedBy: input.invitedBy,
    createdAt: now,
    expiresAt: now + INVITE_TTL_DAYS * 86_400_000,
    acceptedAt: null,
  };

  await db
    .prepare(
      `INSERT INTO invites (id, token, email, database_id, view_id, role, limit_edits, invited_by, created_at, expires_at, accepted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .bind(
      invite.id,
      invite.token,
      invite.email,
      invite.databaseId,
      invite.viewId,
      invite.role,
      invite.limitEdits ? 1 : 0,
      invite.invitedBy,
      invite.createdAt,
      invite.expiresAt,
    )
    .run();

  // 顺手清掉过期很久的记录，省得表一直长
  if (Math.random() < 0.05) {
    await db.prepare('DELETE FROM invites WHERE expires_at < ?').bind(now - 30 * 86_400_000).run();
  }

  return invite;
}

/** 邀请里需要展示的信息（表格名 / 视图名 / 邀请人）。 */
export async function inviteContext(
  env: Env,
  db: D1Database,
  invite: ViewInviteRecord,
): Promise<{ databaseName: string; viewName: string; inviterName: string }> {
  // 表格名 / 视图名在分片里；邀请人的昵称在用户库（跨库没法 JOIN，查两次再拼）
  const [tableRow, inviterRow] = await Promise.all([
    db
      .prepare(
        `SELECT d.name AS database_name, v.name AS view_name
           FROM databases d JOIN views v ON v.id = ? AND v.database_id = d.id
          WHERE d.id = ?`,
      )
      .bind(invite.viewId, invite.databaseId)
      .first<SqlRow>(),
    invite.invitedBy
      ? env.DB.prepare('SELECT name, email FROM users WHERE id = ?').bind(invite.invitedBy).first<SqlRow>()
      : Promise.resolve(null),
  ]);
  return {
    databaseName: sqlString(tableRow ?? {}, 'database_name', '表格'),
    viewName: sqlString(tableRow ?? {}, 'view_name', '视图'),
    inviterName: sqlString(inviterRow ?? {}, 'name') || sqlString(inviterRow ?? {}, 'email'),
  };
}

/**
 * 把邀请邮件发出去。
 *
 * 和注册确认码一样：没配 `RESEND_API_KEY` 或收件人是保留测试域时**不发信**、
 * 直接把链接回显在响应里（`inviteUrl`），本地开发与自动化测试才能走完整个流程。
 * 真的发信失败时删掉这条邀请并抛 502 —— 保证「库里有邀请 ⇒ 邮件已经寄出」。
 *
 * `db` 是这张表格所在的分片（邀请记录与表格数据同库）。
 */
export async function deliverViewInvite(
  env: Env,
  db: D1Database,
  invite: ViewInviteRecord,
  origin: string,
): Promise<ViewInviteInfo> {
  const { databaseName, viewName, inviterName } = await inviteContext(env, db, invite);
  const url = inviteLink(origin, invite.token);
  const base = {
    email: invite.email,
    role: invite.role,
    limitEdits: invite.limitEdits,
    expiresAt: invite.expiresAt,
    ttlDays: INVITE_TTL_DAYS,
  };

  // 站点名称 / Resend 密钥 / 发件人都以「后台 → 站点设置」里的值为准
  const settings = await loadSiteSettings(env);
  if (shouldEchoCode(env, invite.email, settings)) {
    console.log(`[invite] ${invite.email} 的邀请链接是 ${url}（未发信：邮件服务未配置或测试域）`);
    return { ...base, emailDelivered: false, inviteUrl: url };
  }

  const delivery = await sendEmail(settings, {
    ...viewInviteEmail(settings, {
      inviterName,
      databaseName,
      viewName,
      role: invite.role,
      limitEdits: invite.limitEdits,
      link: url,
      days: INVITE_TTL_DAYS,
    }),
    to: invite.email,
  });

  if (!delivery.ok) {
    await db.prepare('DELETE FROM invites WHERE id = ?').bind(invite.id).run();
    if (delivery.reason === 'not_configured') {
      throw badGateway('邀请邮件发送失败：未配置 RESEND_API_KEY，无法向未注册邮箱发送邀请链接');
    }
    emailFailure(delivery, '邀请邮件');
  }

  return { ...base, emailDelivered: true };
}

/** 标记邀请已被接受（一次性，之后链接失效）。 */
export async function consumeInvite(db: D1Database, inviteId: string): Promise<void> {
  await db.prepare('UPDATE invites SET accepted_at = ? WHERE id = ?').bind(Date.now(), inviteId).run();
}
