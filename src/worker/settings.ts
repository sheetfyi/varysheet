/**
 * 站点设置：管理员在「后台 → 站点设置」里改的站点名称、站点图标、Resend 发信密钥与发件人、
 * XorPay 收款（表格名额购买）。
 *
 * 存在 D1 的 `settings` 表里（见 migrations/control/0010_site_settings.sql），读取顺序是
 * **数据库里的值 → 环境变量 / secret → 代码默认值**：
 *   - `site_name`         → `APP_NAME`            → `Varysheet`
 *   - `admin_email`       → `ADMIN_EMAIL`         → `admin@varysheet.com`
 *   - `resend_api_key`    → `RESEND_API_KEY`      → 空（不发信，确认码走回显）
 *   - `resend_from_email` → `RESEND_FROM_EMAIL`   → `Varysheet <admin@varysheet.com>`
 *   - `xorpay_aid`        → `XORPAY_AID`          → 空（不收款，购买走自助直通）
 *   - `xorpay_app_secret` → `XORPAY_APP_SECRET`   → 空
 *
 * 这样升级前用 `wrangler secret` / `.dev.vars` 配好的老部署不用改；管理员想改也在后台直接改，
 * 不用重新部署（XorPay 的收款信息尤其方便：审核下来之后填进后台就立刻能收款）。
 * 图标本体存在 R2 的固定键 `site/branding-icon`，靠 `?v=<updated_at>` 破缓存。
 */
import type { AdminSettings, BrandingResponse } from '../shared/types';
import { enabledPayTypes } from './xorpay';
import { EMAIL_PATTERN, badRequest, sqlNumber, sqlString, type SqlRow } from './http';
import type { Env } from './types';

/** 站点默认名称（品牌） */
export const DEFAULT_SITE_NAME = 'Varysheet';
/** 默认发件人：注册确认码 / 重置密码 / 邀请邮件都用它（可在后台改） */
export const DEFAULT_FROM_EMAIL = 'Varysheet <admin@varysheet.com>';
/** 默认超级管理员邮箱（未配置 ADMIN_EMAIL 时用它，见 worker/admin.ts） */
export const DEFAULT_ADMIN_EMAIL = 'admin@varysheet.com';

/** 站点图标在 R2 里的固定键（每次上传覆盖同一个对象） */
const SITE_ICON_R2_KEY = 'site/branding-icon';
/** 图标大小上限：图标都很小，超过这个尺寸多半是传错了文件 */
export const MAX_ICON_BYTES = 512 * 1024;
/** 允许的图标 MIME（够覆盖浏览器标签页 / 侧边栏要用的格式） */
export const ICON_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/svg+xml',
  'image/x-icon',
  'image/vnd.microsoft.icon',
];

const KEY_SITE_NAME = 'site_name';
const KEY_ADMIN_EMAIL = 'admin_email';
const KEY_ICON_MIME = 'site_icon_mime';
const KEY_ICON_UPDATED_AT = 'site_icon_updated_at';
const KEY_RESEND_API_KEY = 'resend_api_key';
const KEY_RESEND_FROM = 'resend_from_email';
/** XorPay 收款（表格名额购买）：后台填了这两个就自动开启下单 */
const KEY_XORPAY_AID = 'xorpay_aid';
const KEY_XORPAY_APP_SECRET = 'xorpay_app_secret';

export interface SiteSettings {
  siteName: string;
  /** 生效中的超级管理员邮箱（该邮箱登录时会被自动创建 / 提升为管理员） */
  adminEmail: string;
  /** 是否已经上传过站点图标 */
  hasIcon: boolean;
  /** 图标最后上传时间（也是图标 URL 的 `?v=`） */
  iconUpdatedAt: number;
  iconMime: string;
  /** 生效中的 Resend 密钥（没有就是空字符串 = 不发信） */
  resendApiKey: string;
  /** 生效中的发件人 */
  resendFromEmail: string;
  /** 生效中的 XorPay appid（没有就是空字符串 = 不开收款，购买走自助直通） */
  xorpayAid: string;
  /** 生效中的 XorPay app secret */
  xorpayAppSecret: string;
  /** `settings` 表里最后修改时间（0 = 表里什么都没有） */
  updatedAt: number;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 读取当前生效的站点设置；`settings` 表还不存在（没跑迁移）时退回环境变量。 */
export async function loadSiteSettings(env: Env): Promise<SiteSettings> {
  const values = new Map<string, string>();
  let updatedAt = 0;
  try {
    const { results } = await env.DB.prepare('SELECT key, value, updated_at FROM settings').all<SqlRow>();
    for (const row of results ?? []) {
      values.set(sqlString(row, 'key'), sqlString(row, 'value'));
      updatedAt = Math.max(updatedAt, sqlNumber(row, 'updated_at'));
    }
  } catch (error) {
    // 没跑迁移就查不到表：不要因此打挂登录 / 注册，安静地退回环境变量
    console.warn('读取站点设置失败（迁移没跑？），改用环境变量:', error);
  }

  const iconUpdatedAt = Number(values.get(KEY_ICON_UPDATED_AT) ?? 0) || 0;
  return {
    siteName: text(values.get(KEY_SITE_NAME)) || text(env.APP_NAME) || DEFAULT_SITE_NAME,
    adminEmail: text(values.get(KEY_ADMIN_EMAIL)) || text(env.ADMIN_EMAIL) || DEFAULT_ADMIN_EMAIL,
    hasIcon: iconUpdatedAt > 0,
    iconUpdatedAt,
    iconMime: text(values.get(KEY_ICON_MIME)) || 'image/png',
    resendApiKey: text(values.get(KEY_RESEND_API_KEY)) || text(env.RESEND_API_KEY),
    resendFromEmail: text(values.get(KEY_RESEND_FROM)) || text(env.RESEND_FROM_EMAIL) || DEFAULT_FROM_EMAIL,
    // XorPay 收款：后台填的优先，环境变量 / secret 兜底（本地开发与 CI 用后者）
    xorpayAid: text(values.get(KEY_XORPAY_AID)) || text(env.XORPAY_AID),
    xorpayAppSecret: text(values.get(KEY_XORPAY_APP_SECRET)) || text(env.XORPAY_APP_SECRET),
    updatedAt,
  };
}

/** 图标的公开地址（没上传过就是 null）；带 `?v=` 以便长期缓存。 */
export function siteIconUrl(settings: SiteSettings): string | null {
  return settings.hasIcon ? `/api/branding/icon?v=${settings.iconUpdatedAt}` : null;
}

/** 公开的品牌信息：`GET /api/branding`（未登录也能拿，用于页面标题 / favicon / 登录页）。 */
export type BrandingPayload = BrandingResponse;

export function brandingPayload(settings: SiteSettings): BrandingPayload {
  return { siteName: settings.siteName, iconUrl: siteIconUrl(settings), updatedAt: settings.updatedAt };
}

/** 把密钥打成 `re_ab…wxyz` 的样子给管理员看（完整值不回传）。 */
export function maskSecret(secret: string): string {
  if (!secret) return '';
  if (secret.length <= 8) return `${secret.slice(0, 2)}****`;
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`;
}

/** 后台「站点设置」页需要的完整信息（含环境变量兜底情况，前端据此给提示）。 */
export type AdminSettingsPayload = AdminSettings;

export async function adminSettingsPayload(env: Env): Promise<AdminSettingsPayload> {
  const settings = await loadSiteSettings(env);
  const envKey = text(env.RESEND_API_KEY);
  const envXorpaySecret = text(env.XORPAY_APP_SECRET);
  return {
    siteName: settings.siteName,
    iconUrl: siteIconUrl(settings),
    hasIcon: settings.hasIcon,
    adminEmail: settings.adminEmail,
    adminEmailFromEnv: settings.adminEmail === text(env.ADMIN_EMAIL),
    resolvedResendApiKey: maskSecret(settings.resendApiKey),
    resendApiKeyConfigured: settings.resendApiKey !== '',
    resendApiKeyFromEnv: settings.resendApiKey !== '' && settings.resendApiKey === envKey,
    resendFromEmail: settings.resendFromEmail,
    // XorPay 收款：后台填好 appid + app secret 就立刻生效（不用重新部署）
    xorpayAid: settings.xorpayAid,
    resolvedXorpayAppSecret: maskSecret(settings.xorpayAppSecret),
    xorpayConfigured: settings.xorpayAid !== '' && settings.xorpayAppSecret !== '',
    xorpayAppSecretFromEnv:
      settings.xorpayAppSecret !== '' && settings.xorpayAppSecret === envXorpaySecret,
    xorpayPayTypes: enabledPayTypes(env),
    defaults: { siteName: DEFAULT_SITE_NAME, adminEmail: DEFAULT_ADMIN_EMAIL, resendFromEmail: DEFAULT_FROM_EMAIL },
    updatedAt: settings.updatedAt,
  };
}

export interface SiteSettingsPatch {
  siteName?: string;
  /** 传空字符串 = 清掉数据库里的值，退回 Worker secret / 默认值 */
  adminEmail?: string;
  /** 传空字符串 = 清掉数据库里的值，退回 Worker secret / 默认值 */
  resendApiKey?: string;
  resendFromEmail?: string;
  /** XorPay appid；留空保存 = 关掉收款（购买退回自助直通） */
  xorpayAid?: string;
  /** XorPay app secret；留空保存 = 关掉收款 */
  xorpayAppSecret?: string;
}

function upsert(env: Env, key: string, value: string, now: number): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(key, value, now);
}

/** 保存站点名称 / 管理员邮箱 / 发件人 / Resend 密钥，返回保存后的完整设置。 */
export async function saveSiteSettings(env: Env, patch: SiteSettingsPatch): Promise<SiteSettings> {
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  if (patch.siteName !== undefined) statements.push(upsert(env, KEY_SITE_NAME, patch.siteName, now));
  if (patch.adminEmail !== undefined) statements.push(upsert(env, KEY_ADMIN_EMAIL, patch.adminEmail, now));
  if (patch.resendApiKey !== undefined) statements.push(upsert(env, KEY_RESEND_API_KEY, patch.resendApiKey, now));
  if (patch.resendFromEmail !== undefined) statements.push(upsert(env, KEY_RESEND_FROM, patch.resendFromEmail, now));
  if (patch.xorpayAid !== undefined) statements.push(upsert(env, KEY_XORPAY_AID, patch.xorpayAid, now));
  if (patch.xorpayAppSecret !== undefined) {
    statements.push(upsert(env, KEY_XORPAY_APP_SECRET, patch.xorpayAppSecret, now));
  }
  if (statements.length) await env.DB.batch(statements);
  return loadSiteSettings(env);
}

/**
 * 校验管理员邮箱：必须是合法邮箱；空串表示清空（退回 `ADMIN_EMAIL` / 默认 `admin@varysheet.com`）。
 * 统一的 `EMAIL_PATTERN` 只允许 ASCII，邮箱统一小写保存。
 */
export function normalizeAdminEmail(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!raw) return '';
  if (!EMAIL_PATTERN.test(raw)) throw badRequest('管理员邮箱格式不正确');
  return raw;
}

/** 校验发件人：接受 `admin@varysheet.com` 或 `Varysheet <admin@varysheet.com>`；空串表示清空。 */
export function normalizeFromAddress(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  if (/[\r\n]/.test(raw)) throw badRequest('发件人不能包含换行');
  const angled = /<([^<>]+)>\s*$/.exec(raw);
  const address = (angled ? angled[1] : raw).trim().toLowerCase();
  if (!EMAIL_PATTERN.test(address)) {
    throw badRequest('发件人格式应为 admin@varysheet.com 或 Varysheet <admin@varysheet.com>');
  }
  return raw;
}

/** 上传 / 覆盖站点图标（调用方已校验大小与 MIME）。 */
export async function saveSiteIcon(env: Env, file: File): Promise<SiteSettings> {
  const mime = (file.type || 'image/png').toLowerCase();
  await env.BUCKET.put(SITE_ICON_R2_KEY, file.stream(), {
    httpMetadata: { contentType: mime, cacheControl: 'public, max-age=31536000, immutable' },
  });
  const now = Date.now();
  await env.DB.batch([upsert(env, KEY_ICON_MIME, mime, now), upsert(env, KEY_ICON_UPDATED_AT, String(now), now)]);
  return loadSiteSettings(env);
}

/** 移除站点图标（R2 对象 + 设置行）。 */
export async function clearSiteIcon(env: Env): Promise<SiteSettings> {
  await env.BUCKET.delete(SITE_ICON_R2_KEY);
  await env.DB.prepare('DELETE FROM settings WHERE key IN (?, ?)').bind(KEY_ICON_MIME, KEY_ICON_UPDATED_AT).run();
  return loadSiteSettings(env);
}

/** 取出当前图标本体（没上传过 / 对象丢了都返回 null）。 */
export async function loadSiteIcon(
  env: Env,
  settings: SiteSettings,
): Promise<{ body: ReadableStream; size: number; mime: string; etag: string } | null> {
  if (!settings.hasIcon) return null;
  const object = await env.BUCKET.get(SITE_ICON_R2_KEY);
  if (!object) return null;
  return {
    body: object.body,
    size: object.size,
    mime: object.httpMetadata?.contentType || settings.iconMime,
    etag: object.httpEtag,
  };
}

