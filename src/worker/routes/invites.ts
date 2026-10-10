/**
 * /api/invites/* —— 视图分享邀请（公开接口，凭邮件里的 token）。
 *
 *   GET  /api/invites/:token          受邀人打开邀请链接时看到的信息（表格 / 视图 / 邀请人）
 *   POST /api/invites/:token/accept   填昵称 + 密码完成注册，自动获得该视图分享并直接登录
 *
 * 邀请由表格所有者在分享时发出（`POST /api/databases/:id/view-shares` 带 `invite: true`，
 * 见 routes/databases.ts 与 worker/invites.ts）。这里的邮箱以邀请记录为准，
 * 不接受客户端指定，避免把邀请用成「任意邮箱注册」的后门。
 */
import type { InviteAcceptResponse, InviteDetail } from '../../shared/types';
import { assertSignupAllowed, createSession, hashPassword, isSecureRequest, sessionCookie, sessionTokenPayload, validatePasswordStrength, wantsTokenInBody } from '../auth';
import { consumeInvite, inviteContext, loadInviteByToken, type ViewInviteRecord } from '../invites';
import { loadSiteSettings, siteIconUrl } from '../settings';
import {
  HttpError,
  asString,
  badRequest,
  conflict,
  json,
  newId,
  notFound,
  readJson,
  sqlString,
  type SqlRow,
} from '../http';
import type { Env, RequestContext, Route } from '../types';
import { logChanges } from '../changes';
import { touchDatabase } from './databases';

/** 取出一条仍然可用的邀请（不存在 / 用过 / 过期都会给出对应的提示）。 */
async function requireInvite(ctx: RequestContext): Promise<ViewInviteRecord> {
  const invite = await loadInviteByToken(ctx.env, ctx.params.token ?? '');
  if (!invite) throw notFound('邀请链接无效，请让分享者重新发送');
  if (invite.acceptedAt !== null) throw conflict('这个邀请已经用过了，请直接登录', 'invite_used');
  if (invite.expiresAt <= Date.now()) {
    throw new HttpError(410, 'invite_expired', '邀请链接已过期，请让分享者重新发送');
  }
  return invite;
}

/** 把邀请里的那条视图分享写给 `userId`（同一个视图重复接受时更新角色）。 */
async function applyViewShare(env: Env, invite: ViewInviteRecord, userId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO view_shares (id, database_id, view_id, user_id, role, limit_edits, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (view_id, user_id) DO UPDATE SET role = excluded.role, limit_edits = excluded.limit_edits`,
  )
    .bind(
      newId(),
      invite.databaseId,
      invite.viewId,
      userId,
      invite.role,
      invite.limitEdits ? 1 : 0,
      invite.invitedBy,
      Date.now(),
    )
    .run();
  // 表格页开着的人（所有者 / 其它被分享者）跟着刷新
  await touchDatabase(env, invite.databaseId);
  await logChanges(env, invite.databaseId, 'schema');
}

async function inviteDetailHandler(ctx: RequestContext): Promise<Response> {
  const invite = await requireInvite(ctx);
  const { databaseName, viewName, inviterName } = await inviteContext(ctx.env, invite);
  // 站点名称 / 图标由「后台 → 站点设置」决定（受邀人还没登录，也要看到正确的品牌）
  const settings = await loadSiteSettings(ctx.env);
  const detail: InviteDetail = {
    email: invite.email,
    role: invite.role,
    limitEdits: invite.limitEdits,
    databaseName,
    viewName,
    inviterName,
    expiresAt: invite.expiresAt,
    expiresInSeconds: Math.max(0, Math.round((invite.expiresAt - Date.now()) / 1000)),
    appName: settings.siteName,
    siteIconUrl: siteIconUrl(settings),
  };
  return json({ invite: detail });
}

async function acceptInviteHandler(ctx: RequestContext): Promise<Response> {
  const env = ctx.env;
  assertSignupAllowed(env);
  const invite = await requireInvite(ctx);
  const body = await readJson(ctx.request);
  const email = invite.email;
  const name = asString(body.name, '昵称', { max: 60 }) || email.split('@')[0] || '用户';
  const password = asString(body.password, '密码', { required: true, max: 200 });

  const problem = validatePasswordStrength(password);
  if (problem) throw badRequest(problem);

  // 邀请期间对方自己注册了：把这条视图分享补给已有账号，让他直接登录（不再建第二个账号）
  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?')
    .bind(email)
    .first<SqlRow>();
  if (existing) {
    await applyViewShare(env, invite, sqlString(existing, 'id'));
    await consumeInvite(env, invite.id);
    throw conflict('该邮箱已经注册过了，这条视图分享已加到你的账号上，请直接登录查看', 'email_exists');
  }

  const userId = newId();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO users (id, email, name, password_hash, created_at, updated_at, is_admin)
     VALUES (?, ?, ?, ?, ?, ?, 0)`,
  )
    .bind(userId, email, name, await hashPassword(password, env), now, now)
    .run();

  await applyViewShare(env, invite, userId);
  await consumeInvite(env, invite.id);

  // 新账号不再自动建「我的第一个表格」：邀请进来的用户直接看被分享的视图
  const session = await createSession(env, userId);
  const payload: InviteAcceptResponse = {
    user: { id: userId, email, name, isAdmin: false },
    databaseId: invite.databaseId,
    viewId: invite.viewId,
  };
  if (wantsTokenInBody(body)) payload.session = sessionTokenPayload(session);
  return json(payload, {
    status: 201,
    headers: { 'set-cookie': sessionCookie(session.token, isSecureRequest(ctx.request)) },
  });
}

export const inviteRoutes: Route[] = [
  { method: 'GET', path: '/api/invites/:token', handler: inviteDetailHandler },
  { method: 'POST', path: '/api/invites/:token/accept', handler: acceptInviteHandler },
];
