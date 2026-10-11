/**
 * /api/admin/* —— 用户管理 + 站点设置（仅超级管理员）。
 *
 * 只有 `users.is_admin = 1` 的账号能访问，全部经过 `requireAdmin`：
 *   GET    /api/admin/users                注册用户列表（可按昵称 / 邮箱搜索、分页）
 *   PATCH  /api/admin/users/:id            修改某个用户的注册信息（昵称 / 邮箱）
 *   POST   /api/admin/users/:id/password   重置某个用户的密码（可指定，也可随机生成）
 *   POST   /api/admin/users/delete         批量删除账号（用户管理第一列的复选框 → 「删除选中」）
 *   GET    /api/admin/settings             「站点设置」：站点名称 / 图标 / 管理员邮箱 / Resend 密钥与发件人
 *                                            / XorPay 收款（appid + app secret，填好即刻开启微信扫码购买）
 *                                            / 系统规则与内容合规条款 + 系统使用说明（注册勾选与侧边栏「?」）
 *   PATCH  /api/admin/settings             保存上面的设置（Resend / XorPay 密钥只回传掩码）
 *   POST   /api/admin/settings/icon        上传 / 替换站点图标（multipart，字段名 `file`）
 *   DELETE /api/admin/settings/icon        移除站点图标
 *   POST   /api/admin/quota/grants         管理员赠额：给某个账号加表格名额（客服补偿 / 活动赠送）
 *   POST   /api/admin/maintenance/retention 立刻跑一次保留期清理（试用 / 基础表格，和定时任务同一套逻辑）
 *
 * 重置密码会让该用户在所有设备上立即下线，并尽力把新密码邮件通知给本人。
 * 删除账号会连同他拥有的表格（记录 / 备注 / 上传文件）一起清理，
 * 具体范围见 worker/admin.ts 的 `deleteAdminUsers`。
 */
import { hashPassword, requireAdmin, validatePasswordStrength } from '../auth';
import { MAX_DELETE_USERS, deleteAdminUsers, loadAdminUser, loadAdminUsers } from '../admin';
import { passwordResetEmail, sendEmail, shouldEchoCode } from '../email';
import { grantQuota, parsePurchaseInput } from '../orders';
import { purgeExpiredTableData } from '../retention';
import {
  asString,
  badRequest,
  conflict,
  json,
  normalizeEmail,
  notFound,
  readJson,
  sqlString,
  type SqlRow,
} from '../http';
import {
  ICON_MIME_TYPES,
  MAX_ICON_BYTES,
  adminSettingsPayload,
  brandingPayload,
  clearSiteIcon,
  loadSiteSettings,
  normalizeAdminEmail,
  normalizeFromAddress,
  saveSiteIcon,
  saveSiteSettings,
  type SiteSettingsPatch,
} from '../settings';
import type { Route, RequestContext } from '../types';
import { loadTableQuota } from './quota';

/** 大小写字母 + 数字，去掉了容易看错的 I l 1 O 0 */
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

function randomIndex(max: number): number {
  const buffer = new Uint32Array(1);
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  let value = 0;
  do {
    crypto.getRandomValues(buffer);
    value = buffer[0] ?? 0;
  } while (value >= limit);
  return value % max;
}

/** 生成一个满足强度要求（含字母与数字）的临时密码。 */
function generatePassword(length = 12): string {
  let password = '';
  for (let index = 0; index < length; index += 1) password += PASSWORD_ALPHABET[randomIndex(PASSWORD_ALPHABET.length)];
  if (!/\d/.test(password)) {
    const digit = String(randomIndex(10));
    const at = randomIndex(password.length);
    password = `${password.slice(0, at)}${digit}${password.slice(at + 1)}`;
  }
  return password;
}

async function listUsersHandler(ctx: RequestContext): Promise<Response> {
  await requireAdmin(ctx.request, ctx.env);
  const search = ctx.url.searchParams.get('search') ?? '';
  const limit = Number(ctx.url.searchParams.get('limit') ?? 50);
  const offset = Number(ctx.url.searchParams.get('offset') ?? 0);
  const { users, total } = await loadAdminUsers(ctx.env, { search, limit, offset });
  return json({ users, total, limit, offset, search });
}

async function updateUserHandler(ctx: RequestContext): Promise<Response> {
  const admin = await requireAdmin(ctx.request, ctx.env);
  const userId = ctx.params.id ?? '';
  const target = await ctx.env.DB.prepare('SELECT id, email, name FROM users WHERE id = ?')
    .bind(userId)
    .first<SqlRow>();
  if (!target) throw notFound('用户不存在');

  const body = await readJson(ctx.request);
  const nextName = body.name === undefined ? sqlString(target, 'name') : asString(body.name, '昵称', { required: true, max: 60 });

  let nextEmail = sqlString(target, 'email');
  if (body.email !== undefined) {
    nextEmail = normalizeEmail(body.email);
    if (nextEmail !== sqlString(target, 'email')) {
      const clash = await ctx.env.DB.prepare('SELECT id FROM users WHERE email = ? AND id != ?')
        .bind(nextEmail, userId)
        .first<SqlRow>();
      if (clash) throw conflict('该邮箱已被其它账号使用', 'email_exists');
    }
  }

  await ctx.env.DB.prepare('UPDATE users SET name = ?, email = ?, updated_at = ? WHERE id = ?')
    .bind(nextName, nextEmail, Date.now(), userId)
    .run();

  return json({ user: await loadAdminUser(ctx.env, userId), updatedSelf: admin.id === userId });
}

async function resetUserPasswordHandler(ctx: RequestContext): Promise<Response> {
  const admin = await requireAdmin(ctx.request, ctx.env);
  const userId = ctx.params.id ?? '';
  const target = await ctx.env.DB.prepare('SELECT id, email, name FROM users WHERE id = ?')
    .bind(userId)
    .first<SqlRow>();
  if (!target) throw notFound('用户不存在');

  const body = await readJson(ctx.request);
  const requested = body.password === undefined ? '' : asString(body.password, '新密码', { max: 200 });
  const password = requested || generatePassword();
  const problem = validatePasswordStrength(password);
  if (problem) throw badRequest(problem);

  await ctx.env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .bind(await hashPassword(password, ctx.env), Date.now(), userId)
    .run();
  // 管理员重置密码多半是「账号被盗 / 用户忘了密码」，所有设备立即下线
  await ctx.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();

  // 尽力把新密码发到用户邮箱；没配邮件服务时不发信，直接把密码回显给管理员
  const email = sqlString(target, 'email');
  const settings = await loadSiteSettings(ctx.env);
  let emailed = false;
  if (!shouldEchoCode(ctx.env, email, settings)) {
    const delivery = await sendEmail(settings, {
      ...passwordResetEmail(settings, { name: sqlString(target, 'name'), password }),
      to: email,
    });
    emailed = delivery.ok;
  }

  return json({
    ok: true,
    password,
    emailed,
    sessionsRevoked: true,
    resetSelf: admin.id === userId,
    user: { id: userId, email, name: sqlString(target, 'name') },
  });
}

/**
 * 批量删除注册账号（用户管理里的复选框 + 「删除选中」）。
 * 管理员自己、以及其它管理员账号会被跳过（`skipped`），不算失败。
 */
async function deleteUsersHandler(ctx: RequestContext): Promise<Response> {
  const admin = await requireAdmin(ctx.request, ctx.env);
  const body = await readJson(ctx.request);
  const raw = Array.isArray(body.ids) ? body.ids : [];
  if (!raw.length) throw badRequest('请先选择要删除的账号');
  if (raw.length > MAX_DELETE_USERS) throw badRequest(`一次最多删除 ${MAX_DELETE_USERS} 个账号`);

  const ids = raw.map((value) => asString(value, '用户', { required: true, max: 64 }));
  const result = await deleteAdminUsers(ctx.env, ids, admin.id);
  return json({ ok: true, ...result });
}

/* --------------------------------------------------------------- 站点设置 */

/**
 * 校验后台里粘贴的密钥（Resend / XorPay 通用）：去掉首尾空白，空串 = 清空（退回环境变量 / 关闭该功能）。
 * 只挡明显有问题的输入（换行、空格、超长），真正的合法性交给各自的平台去报错。
 */
function normalizeSecret(value: unknown, label: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  if (/\s/.test(raw)) throw badRequest(`${label}里不能有空格或换行`);
  if (raw.length > 200) throw badRequest(`${label}太长，请检查是否复制多了`);
  return raw;
}

/**
 * 校验 XorPay 的 appid（后台「应用配置」里那串）：只收字母 / 数字 / `-` / `_`。
 * 空串 = 关掉收款（购买退回自助直通，见 src/worker/orders.ts）。
 */
function normalizeXorpayAid(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  if (!/^[A-Za-z0-9_-]{2,64}$/.test(raw)) {
    throw badRequest('XorPay 应用 ID 只支持字母 / 数字 / 连字符 / 下划线');
  }
  return raw;
}

/** 「后台 → 站点设置」当前值：站点名称 / 图标 / 管理员邮箱 / Resend 密钥（掩码）与发件人。 */
async function getSettingsHandler(ctx: RequestContext): Promise<Response> {
  await requireAdmin(ctx.request, ctx.env);
  return json({ settings: await adminSettingsPayload(ctx.env) });
}

/** 保存站点设置（只处理请求里出现过的字段，没出现的保持不动）。 */
async function updateSettingsHandler(ctx: RequestContext): Promise<Response> {
  await requireAdmin(ctx.request, ctx.env);
  const body = await readJson(ctx.request);
  const patch: SiteSettingsPatch = {};
  if (body.siteName !== undefined) patch.siteName = asString(body.siteName, '站点名称', { required: true, max: 60 });
  if (body.adminEmail !== undefined) patch.adminEmail = normalizeAdminEmail(body.adminEmail);
  if (body.resendFromEmail !== undefined) patch.resendFromEmail = normalizeFromAddress(body.resendFromEmail);
  // 登录页副标题：留空 = 清掉数据库里的值、退回默认文案（按需求做成后台可改的字段）
  if (body.loginTagline !== undefined) patch.loginTagline = asString(body.loginTagline, '登录页副标题', { max: 60 });
  // 系统规则与内容合规条款 / 系统使用说明：留空 = 退回代码里的默认文案（见 shared/policy.ts）。
  // 上限给得比较宽：条款本身就有两三千字，够管理员写清楚规则。
  if (body.termsContent !== undefined) {
    patch.termsContent = asString(body.termsContent, '系统规则与条款', { max: 20000, trim: false });
  }
  if (body.guideContent !== undefined) {
    patch.guideContent = asString(body.guideContent, '系统使用说明', { max: 20000, trim: false });
  }
  if (body.resendApiKey !== undefined) patch.resendApiKey = normalizeSecret(body.resendApiKey, 'Resend 密钥');
  // XorPay 收款：填上 appid + app secret 就立刻开启「微信扫码购买」（不用重新部署）
  if (body.xorpayAid !== undefined) patch.xorpayAid = normalizeXorpayAid(body.xorpayAid);
  if (body.xorpayAppSecret !== undefined) {
    patch.xorpayAppSecret = normalizeSecret(body.xorpayAppSecret, 'XorPay 密钥');
  }
  if (!Object.keys(patch).length) throw badRequest('没有需要保存的修改');

  const settings = await saveSiteSettings(ctx.env, patch);
  return json({ settings: await adminSettingsPayload(ctx.env), branding: brandingPayload(settings) });
}

/** 上传 / 替换站点图标（multipart 的 `file` 字段；覆盖 R2 里的同一个对象）。 */
async function uploadSettingsIconHandler(ctx: RequestContext): Promise<Response> {
  await requireAdmin(ctx.request, ctx.env);
  const contentType = ctx.request.headers.get('content-type') ?? '';
  if (!contentType.includes('multipart/form-data')) throw badRequest('请使用 multipart/form-data 上传图标');

  let form: FormData;
  try {
    form = await ctx.request.formData();
  } catch {
    throw badRequest('表单解析失败');
  }

  const file = form.get('file');
  if (!(file instanceof File)) throw badRequest('缺少 file 字段');
  if (file.size === 0) throw badRequest('图标文件内容为空');
  if (file.size > MAX_ICON_BYTES) throw badRequest(`图标不能超过 ${Math.round(MAX_ICON_BYTES / 1024)}KB`);

  // 只收图片类型：图标会以 image/* 原样回给浏览器（配合全局 nosniff，不会当成页面执行）
  const mime = (file.type || '').toLowerCase();
  if (!ICON_MIME_TYPES.includes(mime)) {
    throw badRequest('图标格式只支持 PNG / JPEG / WebP / GIF / AVIF / SVG / ICO');
  }

  const settings = await saveSiteIcon(ctx.env, file);
  return json({ settings: await adminSettingsPayload(ctx.env), branding: brandingPayload(settings) });
}

/** 移除站点图标（前端会退回内置的默认标识）。 */
async function deleteSettingsIconHandler(ctx: RequestContext): Promise<Response> {
  await requireAdmin(ctx.request, ctx.env);
  const settings = await clearSiteIcon(ctx.env);
  return json({ settings: await adminSettingsPayload(ctx.env), branding: brandingPayload(settings) });
}

/**
 * 运维入口：立刻跑一次「保留期清理」（试用 / 基础表格，每天 03:00 的定时任务是同一套逻辑）。
 * 返回按类型拆开的记录 / 附件清理数量，等不及定时任务时（或本地验证时）可以直接调它。
 */
async function maintenanceRetentionHandler(ctx: RequestContext): Promise<Response> {
  await requireAdmin(ctx.request, ctx.env);
  return json({ retention: await purgeExpiredTableData(ctx.env) });
}

/**
 * 管理员赠额：给某个账号加表格名额，不产生订单、不走支付 —— 直接写一条 `channel = 'admin-grant'` 的流水。
 *
 * body `{ email, kind, count, months, note? }`：
 *   - `kind` / `count` / `months` 的校验与用户下单共用（`parsePurchaseInput`），所以白名单一致；
 *   - 金额按现价记（`purchaseAmountCents`），方便对账口径统一；
 *   - 用于客服补偿 / 活动赠送；线上开通收款后，冒烟测试也靠它给测试账号发建表名额。
 */
async function grantQuotaHandler(ctx: RequestContext): Promise<Response> {
  const admin = await requireAdmin(ctx.request, ctx.env);
  const body = await readJson(ctx.request);
  const email = normalizeEmail(body.email);
  const input = parsePurchaseInput(body);
  const target = await ctx.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<SqlRow>();
  if (!target) throw notFound('用户不存在');

  const userId = sqlString(target, 'id');
  const purchase = await grantQuota(ctx.env, {
    userId,
    kind: input.kind,
    count: input.count,
    months: input.months,
    note: input.note || `管理员赠额（${admin.email}）`,
    createdBy: admin.id,
  });
  return json({ purchase, quota: await loadTableQuota(ctx.env, userId) }, { status: 201 });
}

export const adminRoutes: Route[] = [
  { method: 'GET', path: '/api/admin/users', handler: listUsersHandler },
  { method: 'PATCH', path: '/api/admin/users/:id', handler: updateUserHandler },
  { method: 'POST', path: '/api/admin/users/:id/password', handler: resetUserPasswordHandler },
  { method: 'POST', path: '/api/admin/users/delete', handler: deleteUsersHandler },
  { method: 'GET', path: '/api/admin/settings', handler: getSettingsHandler },
  { method: 'PATCH', path: '/api/admin/settings', handler: updateSettingsHandler },
  { method: 'POST', path: '/api/admin/settings/icon', handler: uploadSettingsIconHandler },
  { method: 'DELETE', path: '/api/admin/settings/icon', handler: deleteSettingsIconHandler },
  { method: 'POST', path: '/api/admin/quota/grants', handler: grantQuotaHandler },
  { method: 'POST', path: '/api/admin/maintenance/retention', handler: maintenanceRetentionHandler },
];
