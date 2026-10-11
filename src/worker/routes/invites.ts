/**
 * /api/invites/* —— 视图分享邀请（公开接口，凭邮件里的 token）。
 *
 *   GET  /api/invites/:token          受邀人打开邀请链接时看到的信息（表格 / 视图 / 邀请人）
 *   POST /api/invites/:token/accept   填昵称 + 密码完成注册，自动获得该视图分享并直接登录
 *
 * 邀请由表格所有者在分享时发出（`POST /api/databases/:id/view-shares` 带 `invite: true`，
 * 见 routes/databases.ts 与 worker/invites.ts）。这里的邮箱以邀请记录为准，
 * 不接受客户端指定，避免把邀请用成「任意邮箱注册」的后门。
 *
 * 接受邀请 = 真的新注册了一个账号，所以邀请人会因此多 1 个**试用表格**名额
 * （见 worker/trialGrants.ts）；对方本来就有账号时不算「新用户」，不加名额。
 */
import type { InviteAcceptResponse, InviteDetail } from '../../shared/types';
import { assertSignupAllowed, createSession, hashPassword, isSecureRequest, sessionCookie, sessionTokenPayload, validatePasswordStrength, wantsTokenInBody } from '../auth';
import { consumeInvite, inviteContext, loadInviteByToken, type LoadedInvite, type ViewInviteRecord } from '../invites';
import { loadSiteSettings, siteIconUrl, currentTermsVersion } from '../settings';
import {
  HttpError,
  asFlag,
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
import type { RequestContext, Route } from '../types';
import { logChanges } from '../changes';
import { grantTrialTable } from '../trialGrants';
import { termsNotAccepted } from './auth';
import { touchDatabase } from './databases';

/** 取出一条仍然可用的邀请（不存在 / 用过 / 过期都会给出对应的提示）。 */
async function requireInvite(ctx: RequestContext): Promise<LoadedInvite> {
  const loaded = await loadInviteByToken(ctx.env, ctx.params.token ?? '');
  if (!loaded) throw notFound('邀请链接无效，请让分享者重新发送');
  const { invite } = loaded;
  if (invite.acceptedAt !== null) throw conflict('这个邀请已经用过了，请直接登录', 'invite_used');
  if (invite.expiresAt <= Date.now()) {
    throw new HttpError(410, 'invite_expired', '邀请链接已过期，请让分享者重新发送');
  }
  return loaded;
}

/** 把邀请里的那条视图分享写给 `userId`（同一个视图重复接受时更新角色）。 */
async function applyViewShare(db: D1Database, invite: ViewInviteRecord, userId: string): Promise<void> {
  await db
    .prepare(
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
  await touchDatabase(db, invite.databaseId);
  await logChanges(db, invite.databaseId, 'schema');
}

async function inviteDetailHandler(ctx: RequestContext): Promise<Response> {
  const { invite, db } = await requireInvite(ctx);
  const { databaseName, viewName, inviterName } = await inviteContext(ctx.env, db, invite);
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
  const { invite, db } = await requireInvite(ctx);
  const body = await readJson(ctx.request);
  const email = invite.email;
  const name = asString(body.name, '昵称', { max: 60 }) || email.split('@')[0] || '用户';
  const password = asString(body.password, '密码', { required: true, max: 200 });
  // 邀请注册同样是「注册」：必须先勾选「已了解系统的规则和内容合规的要求」
  if (!asFlag(body.acceptedTerms)) throw termsNotAccepted();

  const problem = validatePasswordStrength(password);
  if (problem) throw badRequest(problem);

  // 邀请期间对方自己注册了：把这条视图分享补给已有账号，让他直接登录（不再建第二个账号）
  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?')
    .bind(email)
    .first<SqlRow>();
  if (existing) {
    await applyViewShare(db, invite, sqlString(existing, 'id'));
    await consumeInvite(db, invite.id);
    throw conflict('该邮箱已经注册过了，这条视图分享已加到你的账号上，请直接登录查看', 'email_exists');
  }

  const userId = newId();
  const now = Date.now();
  // 记下「同意的时刻 + 条款版本」（口径同 `/api/auth/register/verify`）
  const settings = await loadSiteSettings(env);
  await env.DB.prepare(
    `INSERT INTO users (id, email, name, password_hash, created_at, updated_at, is_admin, terms_accepted_at, terms_version)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  )
    .bind(userId, email, name, await hashPassword(password, env), now, now, now, currentTermsVersion(settings))
    .run();

  await applyViewShare(db, invite, userId);
  await consumeInvite(db, invite.id);

  // 真的注册了一位**新用户**才算一次成功邀请：邀请人的试用表格名额 +1
  // （上面「邮箱已经注册过」那条分支不加 —— 对方本来就有账号，不是新用户；
  //  同一条邀请重复接受会被 requireInvite 挡成 409，同一个新用户也不会重复加，见 trialGrants.ts）
  if (invite.invitedBy && invite.invitedBy !== userId) {
    await grantTrialTable(env, {
      userId: invite.invitedBy,
      invitedEmail: email,
      invitedUserId: userId,
    });
  }

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
