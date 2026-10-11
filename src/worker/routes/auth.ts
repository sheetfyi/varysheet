/**
 * /api/auth/* and GET /api/session
 *
 * 注册是两步的（邮箱确认码）：
 *   1. `POST /api/auth/register`        → 202 `{ pending: true, ... }`，只登记待确认的注册并发出 6 位确认码
 *   2. `POST /api/auth/register/verify` → 201 `{ user }`，校验确认码后才真正建账号并自动登录
 *   没收到邮件时可以 `POST /api/auth/register/resend` 重发（同一邮箱 60 秒一次）。
 *
 * 忘记密码（登录页的「忘记密码？找回密码」入口）：
 *   `POST /api/auth/password-reset` → 校验邮箱后**生成一个临时密码**直接换掉旧密码、
 *   作废该账号的全部会话，并把新密码邮件发给本人（与管理端重置密码同一套逻辑）。
 *   邮箱不存在时 404 `email_not_found`（「这个邮箱不存在，请确认是否正确！」）。
 *
 * 会话默认只走 HttpOnly cookie；带 `tokenInBody: true` 时令牌会额外出现在响应体里，
 * 供「Cookie 存不下来」的手机浏览器用 `Authorization: Bearer` 兜底（见 `wantsTokenInBody`）。
 */
import type { LoginResponse, PasswordResetRequested, VerifyRegistrationResponse } from '../../shared/types';
import {
  assertSignupAllowed,
  clearedSessionCookie,
  createSession,
  currentSessionHash,
  destroySession,
  generatePassword,
  getCurrentUser,
  hashPassword,
  isSecureRequest,
  requireUser,
  sessionCookie,
  sessionTokenFrom,
  sessionTokenPayload,
  validatePasswordStrength,
  verifyPassword,
  wantsTokenInBody,
} from '../auth';
import { ensureAdminUser } from '../admin';
import { emailFailure, passwordResetEmail, sendEmail, shouldEchoCode, verificationCodeEmail } from '../email';
import { consumeSignupCode, issueSignupCode, resendSignupCode, type IssuedCode } from '../emailCodes';
import {
  HttpError,
  asFlag,
  asString,
  badRequest,
  conflict,
  json,
  newId,
  normalizeEmail,
  readJson,
  sqlNumber,
  sqlString,
  unauthorized,
  type SqlRow,
} from '../http';
import type { Route, RequestContext, AuthedUser } from '../types';
import { currentTermsVersion, loadSiteSettings, siteIconUrl } from '../settings';
import { listDatabases } from './databases';
import { loadTableQuota } from './quota';

/**
 * 注册（含邀请注册）没勾选条款时的 400：错误码固定为 `terms_not_accepted`，
 * 前端据此把提示写成「请先勾选并阅读《系统规则与内容合规条款》」。
 */
export function termsNotAccepted() {
  return badRequest(
    '请先勾选并阅读《系统规则与内容合规条款》后再注册',
    'terms_not_accepted',
  );
}

function sessionResponse(user: AuthedUser | null) {
  return { user };
}

/**
 * 发确认码：配了 `RESEND_API_KEY` 就真的发邮件；
 * 没配（本地开发）或收件人是保留测试域（`AUTH_ECHO_CODE_DOMAINS`，如 example.com）时，
 * 直接把确认码放在响应里回显，保证注册流程在任何环境都能走完。
 */
async function deliverSignupCode(
  ctx: RequestContext,
  email: string,
  name: string,
  issued: IssuedCode,
): Promise<Response> {
  const base = {
    email,
    ttlMinutes: issued.ttlMinutes,
    expiresInSeconds: Math.max(0, Math.round((issued.expiresAt - Date.now()) / 1000)),
  };

  // 站点名称 / Resend 密钥 / 发件人都以「后台 → 站点设置」里的值为准
  const settings = await loadSiteSettings(ctx.env);
  if (shouldEchoCode(ctx.env, email, settings)) {
    console.log(`[signup] ${email} 的确认码是 ${issued.code}（未发信：邮件服务未配置或测试域）`);
    return json({ pending: true, ...base, emailDelivered: false, devCode: issued.code }, { status: 202 });
  }

  const delivery = await sendEmail(settings, {
    ...verificationCodeEmail(settings, { code: issued.code, name, minutes: issued.ttlMinutes }),
    to: email,
  });
  if (!delivery.ok) emailFailure(delivery);
  return json({ pending: true, ...base, emailDelivered: true }, { status: 202 });
}

async function registerHandler(ctx: RequestContext): Promise<Response> {
  const env = ctx.env;
  assertSignupAllowed(env);
  const body = await readJson(ctx.request);
  const email = normalizeEmail(body.email);
  const password = asString(body.password, '密码', { required: true, max: 200 });
  const fallbackName = email.split('@')[0] || '用户';
  const name = asString(body.name, '昵称', { max: 60 }) || fallbackName;

  // 注册必须先勾选「已了解系统的规则和内容合规的要求」：这一步就拦，别等确认码都发了才拒绝
  if (!asFlag(body.acceptedTerms)) throw termsNotAccepted();

  const problem = validatePasswordStrength(password);
  if (problem) throw badRequest(problem);

  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?')
    .bind(email)
    .first<SqlRow>();
  if (existing) throw conflict('该邮箱已注册，请直接登录', 'email_exists');

  // 第一步只登记「待确认的注册」（昵称 + 已哈希的密码）并发确认码，
  // 确认之前 users 表里不会出现这个邮箱，也不会有半成品账号。
  const issued = await issueSignupCode(env, email, {
    name,
    passwordHash: await hashPassword(password, env),
  });
  return deliverSignupCode(ctx, email, name, issued);
}

async function verifyRegistrationHandler(ctx: RequestContext): Promise<Response> {
  const env = ctx.env;
  assertSignupAllowed(env);
  const body = await readJson(ctx.request);
  const email = normalizeEmail(body.email);
  const code = asString(body.code, '确认码', { required: true, max: 12 }).replace(/[\s-]/g, '');
  if (!/^\d{6}$/.test(code)) throw badRequest('确认码是 6 位数字', 'code_invalid');

  const pending = await consumeSignupCode(env, email, code);

  // 兜底：用户确认期间这个邮箱被别的请求注册掉了
  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?')
    .bind(email)
    .first<SqlRow>();
  if (existing) throw conflict('该邮箱已注册，请直接登录', 'email_exists');

  const userId = newId();
  const now = Date.now();
  const name = pending.name || email.split('@')[0] || '用户';
  // 这一步能走到，说明对方拿到了第一步发出去的确认码 —— 而第一步（register）已经要求
  // 勾选「已了解系统的规则和内容合规的要求」，所以这里直接记下「同意的时刻 + 条款版本」
  // （`terms_version` 是当时生效条款的指纹，见 shared/policy.ts 的 policyVersion）
  const settings = await loadSiteSettings(env);
  await env.DB.prepare(
    `INSERT INTO users (id, email, name, password_hash, created_at, updated_at, is_admin, terms_accepted_at, terms_version)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  )
    .bind(userId, email, name, pending.passwordHash, now, now, now, currentTermsVersion(settings))
    .run();

  // 新账号不再自动生成「我的第一个表格」（也不写任何示例数据）：
  // 注册完成后从空白开始，需要时用户在侧边栏自己新建表格。
  const session = await createSession(env, userId);
  const payload: VerifyRegistrationResponse = {
    user: { id: userId, email, name, isAdmin: false },
    emailVerified: true,
  };
  if (wantsTokenInBody(body)) payload.session = sessionTokenPayload(session);
  return json(payload, {
    status: 201,
    headers: { 'set-cookie': sessionCookie(session.token, isSecureRequest(ctx.request)) },
  });
}

async function resendRegistrationHandler(ctx: RequestContext): Promise<Response> {
  assertSignupAllowed(ctx.env);
  const body = await readJson(ctx.request);
  const email = normalizeEmail(body.email);
  const issued = await resendSignupCode(ctx.env, email);
  return deliverSignupCode(ctx, email, issued.name, issued);
}


async function loginHandler(ctx: RequestContext): Promise<Response> {
  const env = ctx.env;
  const body = await readJson(ctx.request);
  const email = normalizeEmail(body.email);
  const password = asString(body.password, '密码', { required: true, max: 200 });

  // 后台「站点设置」里配置的管理员邮箱（没有就用 ADMIN_EMAIL / 默认值）在这里被创建 / 提升为管理员
  const settings = await loadSiteSettings(env);
  await ensureAdminUser(env, settings.adminEmail);

  const row = await env.DB.prepare('SELECT id, email, name, password_hash, is_admin FROM users WHERE email = ?')
    .bind(email)
    .first<SqlRow>();
  if (!row) throw unauthorized('邮箱或密码不正确');
  const ok = await verifyPassword(password, sqlString(row, 'password_hash'));
  if (!ok) throw unauthorized('邮箱或密码不正确');

  const userId = sqlString(row, 'id');
  const session = await createSession(env, userId);
  const payload: LoginResponse = {
    user: {
      id: userId,
      email: sqlString(row, 'email'),
      name: sqlString(row, 'name'),
      isAdmin: sqlNumber(row, 'is_admin') === 1,
    },
  };
  if (wantsTokenInBody(body)) payload.session = sessionTokenPayload(session);
  return json(payload, {
    headers: { 'set-cookie': sessionCookie(session.token, isSecureRequest(ctx.request)) },
  });
}

async function logoutHandler(ctx: RequestContext): Promise<Response> {
  const token = sessionTokenFrom(ctx.request);
  if (token) await destroySession(ctx.env, token);
  return json({ ok: true }, { headers: { 'set-cookie': clearedSessionCookie(isSecureRequest(ctx.request)) } });
}

/** 登录后自助改密码：校验旧密码 → 换新哈希 → 其它设备的会话立即失效。 */
async function changePasswordHandler(ctx: RequestContext): Promise<Response> {
  const env = ctx.env;
  const user = await requireUser(ctx.request, env);
  const body = await readJson(ctx.request);
  const currentPassword = asString(body.currentPassword, '当前密码', { required: true, max: 200 });
  const newPassword = asString(body.newPassword, '新密码', { required: true, max: 200 });

  const problem = validatePasswordStrength(newPassword);
  if (problem) throw badRequest(problem);
  if (currentPassword === newPassword) throw badRequest('新密码不能与当前密码相同', 'password_unchanged');

  const row = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?')
    .bind(user.id)
    .first<SqlRow>();
  if (!row) throw unauthorized();
  if (!(await verifyPassword(currentPassword, sqlString(row, 'password_hash')))) {
    throw badRequest('当前密码不正确', 'wrong_password');
  }

  const now = Date.now();
  await env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .bind(await hashPassword(newPassword, env), now, user.id)
    .run();

  const keepHash = await currentSessionHash(ctx.request);
  await env.DB.prepare(
    keepHash
      ? 'DELETE FROM sessions WHERE user_id = ? AND token_hash != ?'
      : 'DELETE FROM sessions WHERE user_id = ?',
  )
    .bind(...(keepHash ? [user.id, keepHash] : [user.id]))
    .run();

  return json({ ok: true, sessionsRevoked: true });
}

async function sessionHandler(ctx: RequestContext): Promise<Response> {
  // 品牌信息（站点名称 / 图标）跟在会话里一起下发，前端不用再多打一次 /api/branding
  const settings = await loadSiteSettings(ctx.env);
  // 管理员账号的引导：后台里改过管理员邮箱就立刻生效，重新加载页面就能看到「用户管理」
  await ensureAdminUser(ctx.env, settings.adminEmail);

  const user = await getCurrentUser(ctx.request, ctx.env);
  const branding = {
    appName: settings.siteName,
    siteIconUrl: siteIconUrl(settings),
    // 登录页副标题：未登录时前端拿它显示「登录以继续你的表格」那句话（可在后台改）
    loginTagline: settings.loginTagline,
  };
  if (!user) {
    return json({
      ...sessionResponse(null),
      databases: [],
      // 没登录就没有名额可谈（客户端只在有 `user` 时才读它）
      quota: null,
      maxUploadMb: Number(ctx.env.MAX_UPLOAD_MB ?? 25),
      ...branding,
    });
  }
  // 表格列表与表格名额一起下发：侧边栏底部要显示「还能添加几张表格」
  const [databases, quota] = await Promise.all([
    listDatabases(ctx.env, user.id),
    loadTableQuota(ctx.env, user.id),
  ]);
  return json({
    ...sessionResponse(user),
    databases,
    quota,
    maxUploadMb: Number(ctx.env.MAX_UPLOAD_MB ?? 25),
    ...branding,
  });
}

/**
 * 找回密码（登录页「忘记密码？找回密码」）：给这个邮箱**发一条系统生成的临时密码**。
 *
 * 流程与管理端「重置密码」完全一致（同一个 `passwordResetEmail` 模板 + `generatePassword`）：
 *   1. 邮箱不存在 → 404 `email_not_found`，文案就是「这个邮箱不存在，请确认是否正确！」；
 *   2. 存在 → 先把这个新密码发到邮箱（发信失败就报 502，旧密码不受影响），
 *      再落库换掉密码并作废该账号**所有设备**上的会话
 *      （忘密码多半意味着密码已经泄漏，旧会话不该继续有效）；
 *   3. 没配邮件服务（本地 / CI）或收件人是保留测试域（`AUTH_ECHO_CODE_DOMAINS`，如
 *      example.com）时不发信，直接把密码回显成 `devPassword` —— 口径同注册确认码的
 *      `devCode`，让自动化测试能走完整个流程。
 *
 * ⚠️ 这个接口不需要登录、也不做节流，拿到邮箱就能把人踢下线（安全性等同于
 * 「知道邮箱 = 能重置密码」）。控制点是：真实邮箱得自己去收信才能拿到新密码，
 * 所以别把 `AUTH_ECHO_CODE_DOMAINS` 配上真实域名。
 */
async function requestPasswordResetHandler(ctx: RequestContext): Promise<Response> {
  const env = ctx.env;
  const body = await readJson(ctx.request);
  const email = normalizeEmail(body.email);

  const target = await env.DB.prepare('SELECT id, name FROM users WHERE email = ?')
    .bind(email)
    .first<SqlRow>();
  if (!target) throw new HttpError(404, 'email_not_found', '这个邮箱不存在，请确认是否正确！');

  const userId = sqlString(target, 'id');
  const password = generatePassword();
  const problem = validatePasswordStrength(password); // 理论不会命中，保险起见还是校验一次
  if (problem) throw badRequest(problem);

  // 先把临时密码发出去再改库：邮件发不出去就报 502，用户的旧密码仍然可用
  // （否则「邮件失败 + 密码已换」会把人锁在门外）。
  const settings = await loadSiteSettings(env);
  const echo = shouldEchoCode(env, email, settings);
  if (!echo) {
    const delivery = await sendEmail(settings, {
      ...passwordResetEmail(settings, { name: sqlString(target, 'name'), password }),
      to: email,
    });
    if (!delivery.ok) emailFailure(delivery, '临时密码邮件');
  }

  await env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .bind(await hashPassword(password, env), Date.now(), userId)
    .run();
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();

  if (echo) {
    // 没配邮件服务或收件人是保留测试域：不发信，直接把临时密码回显（口径同注册的 devCode）
    console.log(`[password-reset] ${email} 的临时密码是 ${password}（未发信：邮件服务未配置或测试域）`);
  }

  const payload: PasswordResetRequested = {
    ok: true,
    email,
    emailed: !echo,
    sessionsRevoked: true,
    devPassword: echo ? password : undefined,
  };
  return json(payload);
}

export const authRoutes: Route[] = [
  { method: 'POST', path: '/api/auth/register', handler: registerHandler },
  { method: 'POST', path: '/api/auth/register/verify', handler: verifyRegistrationHandler },
  { method: 'POST', path: '/api/auth/register/resend', handler: resendRegistrationHandler },
  { method: 'POST', path: '/api/auth/login', handler: loginHandler },
  { method: 'POST', path: '/api/auth/logout', handler: logoutHandler },
  { method: 'POST', path: '/api/auth/password', handler: changePasswordHandler },
  { method: 'POST', path: '/api/auth/password-reset', handler: requestPasswordResetHandler },
  { method: 'GET', path: '/api/session', handler: sessionHandler },
];




