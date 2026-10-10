/**
 * 邮件发送（Resend API）。
 *
 * 发信身份不再写死：密钥与发件人都来自「后台 → 站点设置」（D1 `settings` 表），
 * 没配时回落到 `RESEND_API_KEY` / `RESEND_FROM_EMAIL` 环境变量，再回落默认值：
 *   - 密钥：`npx wrangler secret put RESEND_API_KEY`（本地开发放 `.dev.vars`），
 *     也可以直接在后台粘贴（优先用后台里配的那份）；
 *   - 发件人：默认 `Varysheet <admin@varysheet.com>`，用自备域名时在后台改成
 *     例如 `Varysheet <noreply@your-domain.com>`。
 *
 * 两种「不发真邮件」的情形都不会抛错，而是返回 `{ ok: false, reason: 'not_configured' }`，
 * 由调用方把确认码直接回显在响应里，这样本地开发和自动化测试都能跑通完整注册流程：
 *   1. 没有配置 Resend 密钥（后台和环境变量里都没有）；
 *   2. 收件人域在 `AUTH_ECHO_CODE_DOMAINS` 里（默认 example.com / test / invalid 这类**保留域**，
 *      永远收不到邮件，所以回显不会削弱真实邮箱的验证强度）。
 */
import { badGateway } from './http';
import type { SiteSettings } from './settings';
import type { Env } from './types';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export type EmailResult =
  | { ok: true }
  | { ok: false; reason: 'not_configured' | 'api_error'; detail: string };

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** 收件人是否属于「直接回显确认码」的域名（保留测试域）。 */
export function shouldEchoCode(env: Env, email: string, settings: SiteSettings): boolean {
  if (!settings.resendApiKey) return true;
  const domain = email.split('@')[1]?.toLowerCase() ?? '';
  if (!domain) return false;
  const allow = (env.AUTH_ECHO_CODE_DOMAINS ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return allow.includes(domain);
}

export async function sendEmail(settings: SiteSettings, message: EmailMessage): Promise<EmailResult> {
  if (!settings.resendApiKey) {
    return { ok: false, reason: 'not_configured', detail: '未配置 Resend API Key' };
  }

  let response: Response;
  try {
    response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${settings.resendApiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: settings.resendFromEmail,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
    });
  } catch (error) {
    return {
      ok: false,
      reason: 'api_error',
      detail: error instanceof Error ? error.message : '网络异常',
    };
  }

  if (!response.ok) {
    const raw = await response.text();
    let detail = raw.slice(0, 300);
    try {
      const parsed = JSON.parse(raw) as { message?: string; name?: string; error?: string };
      detail = parsed.message || parsed.error || parsed.name || detail;
    } catch {
      // 保留原始文本
    }
    console.error('Resend rejected the email:', response.status, detail);
    return { ok: false, reason: 'api_error', detail: `${response.status} ${detail}` };
  }
  return { ok: true };
}

/** 发不出邮件时的统一错误（调用方会先判断 `shouldEchoCode`）。 */
export function emailFailure(result: Extract<EmailResult, { ok: false }>, label = '确认邮件'): never {
  throw badGateway(
    `${label}发送失败：${result.detail}（请检查后台「站点设置」里的 Resend 密钥与发件人，或 Worker secret / .dev.vars）`,
  );
}


/* --------------------------------------------------------------- 邮件模板 */

const MAIL_PAGE = (app: string, body: string) => `<!doctype html>
<html lang="zh-CN">
  <body style="margin:0;padding:24px;background:#f7f7f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'PingFang SC','Microsoft YaHei',sans-serif;color:#29292a;">
    <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e6e6e3;border-radius:14px;padding:24px;">
      <h1 style="margin:0 0 12px;font-size:18px;">${escapeHtml(app)}</h1>
      ${body}
    </div>
  </body>
</html>`;

/** 注册确认码邮件。 */
export function verificationCodeEmail(
  settings: SiteSettings,
  input: { code: string; name: string; minutes: number },
): EmailMessage {
  const app = settings.siteName;
  const who = escapeHtml(input.name || '你好');
  const subject = `${app} 注册确认码：${input.code}`;
  const text = [
    `${input.name || '你好'}，`,
    '',
    `你的 ${app} 注册确认码是：${input.code}`,
    `${input.minutes} 分钟内有效，请在注册页面填入以完成注册。`,
    '',
    '如果不是你本人操作，忽略这封邮件即可。',
  ].join('\n');

  const html = MAIL_PAGE(
    app,
    `<p style="margin:0 0 16px;color:#6b6b68;font-size:13px;">完成注册的确认码</p>
      <p style="margin:0 0 8px;font-size:14px;">${who}，你好：</p>
      <p style="margin:0 0 12px;font-size:14px;">请把下面的确认码填回注册页面：</p>
      <p style="margin:0 0 16px;font-size:30px;letter-spacing:8px;font-weight:700;padding:12px 16px;background:#f2f2ef;border-radius:10px;text-align:center;">${input.code}</p>
      <p style="margin:0 0 8px;font-size:13px;color:#6b6b68;">确认码 ${input.minutes} 分钟内有效，超时后可以重新发送。</p>
      <p style="margin:0;font-size:13px;color:#6b6b68;">如果不是你本人操作，忽略这封邮件即可。</p>`,
  );

  return { to: '', subject, html, text };
}

/** 管理员重置密码后，把新密码通知给用户（尽力而为，失败不影响重置本身）。 */
export function passwordResetEmail(settings: SiteSettings, input: { name: string; password: string }): EmailMessage {
  const app = settings.siteName;
  const who = escapeHtml(input.name || '你好');
  const subject = `${app} 密码已被管理员重置`;
  const text = [
    `${input.name || '你好'}，`,
    '',
    `你的 ${app} 登录密码已被管理员重置为：${input.password}`,
    '请尽快登录并在右上角「改密码」里换成你自己的密码。',
  ].join('\n');

  const html = MAIL_PAGE(
    app,
    `<p style="margin:0 0 12px;font-size:14px;">${who}，你好：</p>
      <p style="margin:0 0 12px;font-size:14px;">你的登录密码已被管理员重置，新的临时密码是：</p>
      <p style="margin:0 0 16px;font-size:22px;letter-spacing:3px;font-weight:700;padding:12px 16px;background:#f2f2ef;border-radius:10px;text-align:center;">${escapeHtml(input.password)}</p>
      <p style="margin:0;font-size:13px;color:#6b6b68;">登录后请尽快在「改密码」里换成你自己的密码。</p>`,
  );

  return { to: '', subject, html, text };
}

/**
 * 视图分享邀请：受邀邮箱还没注册时，表格所有者能把这条视图分享用链接邀请出去。
 * 对方点链接进 `/invite/<token>`，填昵称 + 密码即完成注册，并自动获得这条视图分享。
 */
export function viewInviteEmail(
  settings: SiteSettings,
  input: {
    inviterName: string;
    databaseName: string;
    viewName: string;
    role: 'viewer' | 'editor';
    limitEdits: boolean;
    link: string;
    days: number;
  },
): EmailMessage {
  const app = settings.siteName;
  const inviter = input.inviterName || '有人';
  const database = input.databaseName || '表格';
  const view = input.viewName || '视图';
  const ability =
    input.role === 'editor'
      ? input.limitEdits
        ? '可以编辑（限制编辑：每次输入保存后 10 秒内还能改，之后该格只能查看）'
        : '可以编辑'
      : '只能查看';
  const subject = `${inviter}邀请你查看「${database} · ${view}」`;
  const link = escapeHtml(input.link);
  const text = [
    '你好，',
    '',
    `${inviter} 在 ${app} 上把「${database}」的视图「${view}」分享给你（${ability}）。`,
    '',
    '点击下面的链接，填昵称和密码即可完成注册并直接查看：',
    input.link,
    '',
    `链接 ${input.days} 天内有效。注册完成的账号也可以直接登录 ${app}。`,
    '如果不是你本人预期收到的邀请，忽略这封邮件即可。',
  ].join('\n');

  const html = MAIL_PAGE(
    app,
    `<p style="margin:0 0 16px;color:#6b6b68;font-size:13px;">${escapeHtml(inviter)} 邀请你协作一个视图</p>
      <p style="margin:0 0 12px;font-size:14px;">你好：</p>
      <p style="margin:0 0 12px;font-size:14px;">${escapeHtml(inviter)} 把「${escapeHtml(database)}」的视图「${escapeHtml(view)}」分享给你，${escapeHtml(ability)}。</p>
      <p style="margin:0 0 16px;"><a href="${link}" style="display:inline-block;padding:10px 18px;background:#29292a;color:#fff;border-radius:8px;text-decoration:none;font-size:14px;">接受邀请并完成注册</a></p>
      <p style="margin:0 0 8px;font-size:13px;color:#6b6b68;">按钮点不开时，把下面的链接复制到浏览器打开：</p>
      <p style="margin:0 0 16px;font-size:12px;word-break:break-all;">${link}</p>
      <p style="margin:0 0 8px;font-size:13px;color:#6b6b68;">链接 ${input.days} 天内有效，注册时填写昵称和密码即可，不需要邮箱确认码。</p>
      <p style="margin:0;font-size:13px;color:#6b6b68;">如果不是你本人预期收到的邀请，忽略这封邮件即可。</p>`,
  );

  return { to: '', subject, html, text };
}
