import { useEffect, useRef, useState } from 'react';
import { TERMS_ACCEPT_LABEL } from '../../shared/policy';
import type { RegistrationPending, SessionUser } from '../../shared/types';
import { ApiError, api } from '../api';
import { DEFAULT_LOGIN_TAGLINE } from '../branding';
import { confirmSessionLanded } from '../lib/session';
import { PolicyDialog } from './PolicyDialog';

interface AuthPageProps {
  appName: string;
  /** 站点图标（管理员上传过才有）：登录 / 注册卡片顶部跟着站点名称一起显示 */
  siteIconUrl: string | null;
  /**
   * 登录卡片上的那句说明（管理员在「后台 → 站点设置」里改）。
   * 留空时用 `DEFAULT_LOGIN_TAGLINE`，注册模式那句是固定文案。
   */
  loginTagline: string;
  onAuthenticated: (user: SessionUser) => void;
}

/** 重发确认码的冷却秒数，与 Worker 端 `RESEND_COOLDOWN_MS` 一致 */
const RESEND_COOLDOWN_SECONDS = 60;

/** 登录 / 注册卡片顶部的站点标识：上传过图标就显示图标，否则只显示站点名称。 */
function BrandHead({ appName, siteIconUrl }: { appName: string; siteIconUrl: string | null }) {
  return (
    <>
      {siteIconUrl ? <img className="auth-logo" src={siteIconUrl} alt="" /> : null}
      <h1>{appName}</h1>
    </>
  );
}

export function AuthPage({ appName, siteIconUrl, loginTagline, onAuthenticated }: AuthPageProps) {
  /**
   * forgot = 登录页的「忘记密码？找回密码」：只填邮箱，系统会生成一个新的临时密码
   * 发到邮箱（该账号在其它设备上的登录会立即失效），登录后可在侧边栏「改密码」换掉。
   */
  const [mode, setMode] = useState<'login' | 'register' | 'forgot'>('login');
  /** 注册是两步：先填资料（form），再填邮件里的确认码（code） */
  const [step, setStep] = useState<'form' | 'code'>('form');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [pending, setPending] = useState<RegistrationPending | null>(null);
  const [notice, setNotice] = useState('');
  /** 找回密码时接口回显的临时密码（只在「邮件服务未配置 / 收件人是测试域」时出现） */
  const [devPassword, setDevPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  /**
   * 注册时那个「我已阅读并同意《系统规则与内容合规条款》」的勾选：
   * 没勾上不让提交（服务端也会拦，见 `routes/auth.ts` 的 `terms_not_accepted`）。
   */
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  /** 「查看条款」弹窗（点勾选框旁边的《系统规则与内容合规条款》） */
  const [termsOpen, setTermsOpen] = useState(false);
  const codeInputRef = useRef<HTMLInputElement | null>(null);

  // 重发倒计时
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setInterval(() => setCooldown((left) => (left > 0 ? left - 1 : 0)), 1000);
    return () => window.clearInterval(timer);
  }, [cooldown]);

  const describe = (cause: unknown, fallback: string) =>
    cause instanceof ApiError ? cause.message : fallback;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (mode === 'login') {
        const credentials = { email: email.trim(), password };
        const result = await api.login(credentials);
        // 登录接口 200 不代表会话真的存下来了（无痕 / 拦截 Cookie 的浏览器会丢掉 Set-Cookie）
        const landing = await confirmSessionLanded(credentials);
        if (!landing.ok) {
          setError(landing.message ?? '登录状态没能保存，请重试一次');
          return;
        }
        onAuthenticated(result.user);
        return;
      }
      // 找回密码：只填邮箱 → 系统换成一个新的临时密码并邮件通知本人（无需登录）
      if (mode === 'forgot') {
        const result = await api.requestPasswordReset({ email: email.trim() });
        setDevPassword(result.devPassword ?? '');
        setNotice(
          result.emailed
            ? `临时密码已发送到 ${result.email}，请用新密码登录（登录后建议马上在「改密码」里换成自己的密码）。`
            : `邮件服务未配置（或收件人是测试域），临时密码已直接显示在下方。`,
        );
        return;
      }
      // 注册必须先勾选「已了解系统的规则和内容合规的要求」（服务端同样会校验）
      if (!acceptedTerms) {
        setError('请先勾选并阅读《系统规则与内容合规条款》');
        return;
      }
      // 注册第一步：Worker 会把 6 位确认码发到邮箱（本地/测试环境直接在响应里回显）
      const result = await api.register({
        email: email.trim(),
        password,
        name: name.trim(),
        acceptedTerms: true,
      });
      setPending(result);
      setCode('');
      setCooldown(RESEND_COOLDOWN_SECONDS);
      setStep('code');
      setNotice(
        result.emailDelivered
          ? `确认码已发送到 ${result.email}，${result.ttlMinutes} 分钟内有效。`
          : `邮件服务未配置，确认码已直接显示在下方（${result.ttlMinutes} 分钟内有效）。`,
      );
    } catch (cause) {
      setError(describe(cause, '请求失败，请稍后再试'));
    } finally {
      setBusy(false);
    }
  };

  const verify = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const credentials = { email: email.trim(), password };
      const result = await api.verifyRegistration({ email: credentials.email, code: code.trim() });
      // 确认码已经被这次验证消费掉了，所以兜底只能走刚设置的密码重新登录
      const landing = await confirmSessionLanded(credentials);
      if (!landing.ok) {
        setError(`${landing.message ?? '注册完成，但登录状态没能保存'}（账号已创建，可以直接用这个邮箱登录）`);
        return;
      }
      onAuthenticated(result.user);
    } catch (cause) {
      setError(describe(cause, '确认失败，请稍后再试'));
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await api.resendRegistrationCode({ email: email.trim() });
      setPending(result);
      setCooldown(RESEND_COOLDOWN_SECONDS);
      setNotice(
        result.emailDelivered
          ? `确认码已重新发送到 ${result.email}。`
          : `邮件服务未配置，新确认码已直接显示在下方。`,
      );
      codeInputRef.current?.focus();
    } catch (cause) {
      setError(describe(cause, '重新发送失败，请稍后再试'));
    } finally {
      setBusy(false);
    }
  };

  const switchMode = (next: 'login' | 'register' | 'forgot') => {
    setMode(next);
    setStep('form');
    setCode('');
    setPending(null);
    setError('');
    setNotice('');
    setDevPassword('');
    // 每次切到注册都要重新确认一次条款（不能沿用上一次的勾选）
    if (next === 'register') setAcceptedTerms(false);
  };


  // ---------------------------------------------------------- 注册第二步
  if (mode === 'register' && step === 'code') {
    return (
      <div className="centered">
        <form className="auth-card" onSubmit={verify}>
          <BrandHead appName={appName} siteIconUrl={siteIconUrl} />
          <p className="muted">输入邮件里的确认码，完成注册</p>

          <p className="small muted">
            确认码收件邮箱：<strong>{email}</strong>
          </p>

          {pending && !pending.emailDelivered && pending.devCode ? (
            <p className="hint-box small">
              📮 邮件服务未配置（或收件人是测试域），确认码是 <strong className="code-echo">{pending.devCode}</strong>
            </p>
          ) : null}

          {notice ? <p className="small muted">{notice}</p> : null}

          <label className="field">
            <span>6 位确认码</span>
            <input
              ref={codeInputRef}
              className="input code-input"
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="000000"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              autoFocus
              required
            />
          </label>

          {error ? <p className="error small">{error}</p> : null}

          <button
            className="btn primary"
            type="submit"
            disabled={busy || code.length !== 6}
            style={{ width: '100%', justifyContent: 'center' }}
          >
            {busy ? '处理中…' : '完成注册'}
          </button>

          <div className="row gap" style={{ marginTop: 10, justifyContent: 'center' }}>
            <button type="button" className="btn ghost small" onClick={resend} disabled={busy || cooldown > 0}>
              {cooldown > 0 ? `重新发送（${cooldown}s）` : '重新发送确认码'}
            </button>
            <button
              type="button"
              className="btn ghost small"
              onClick={() => {
                setStep('form');
                setError('');
                setNotice('');
              }}
            >
              改注册信息
            </button>
          </div>
        </form>
      </div>
    );
  }

  // ------------------------------------------------------------- 登录 / 注册 / 找回密码
  return (
    <div className="centered">
      <form className="auth-card" onSubmit={submit}>
        <BrandHead appName={appName} siteIconUrl={siteIconUrl} />
        <p className="muted">
          {mode === 'login'
            ? loginTagline.trim() || DEFAULT_LOGIN_TAGLINE
            : mode === 'register'
              ? '创建账号，开始搭建你的数据库'
              : '输入注册邮箱，我们把新的临时密码发给你'}
        </p>

        {mode === 'register' ? (
          <label className="field">
            <span>昵称</span>
            <input
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="你的名字"
              autoComplete="nickname"
              required
            />
          </label>
        ) : null}

        <label className="field">
          <span>邮箱</span>
          <input
            className="input"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
            // 手机键盘默认会首字母大写 / 自动更正，邮箱与密码都不需要
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
          />
        </label>

        {mode === 'forgot' ? null : (
          <label className="field">
            <span>密码</span>
            <input
              className="input"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="至少 8 位"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              minLength={8}
              required
            />
          </label>
        )}

        {mode === 'register' ? (
          <>
            <p className="small muted">注册需要邮箱确认：提交后我们会把 6 位确认码发到这个邮箱。</p>
            {/* 注册勾选：确认已了解系统规则与内容合规要求（服务端同样校验，见 routes/auth.ts） */}
            <div className="terms-accept">
              <label className="terms-accept-check">
                <input
                  type="checkbox"
                  checked={acceptedTerms}
                  onChange={(event) => setAcceptedTerms(event.target.checked)}
                  required
                />
                <span>{TERMS_ACCEPT_LABEL}</span>
              </label>
              <button type="button" className="btn ghost small" onClick={() => setTermsOpen(true)}>
                查看条款
              </button>
            </div>
          </>
        ) : null}

        {mode === 'forgot' ? (
          <p className="small muted">
            我们会把系统生成的临时密码发到这个邮箱，并让这个账号在其它设备上下线；如果一直收不到，请联系管理员。
          </p>
        ) : null}

        {/* 邮件服务没配（或收件人是保留测试域）时接口直接把临时密码回显出来（口径同注册的 devCode） */}
        {mode === 'forgot' && devPassword ? (
          <p className="hint-box small">
            📮 临时密码是 <strong className="code-echo">{devPassword}</strong>
          </p>
        ) : null}

        {notice ? <p className="small muted">{notice}</p> : null}

        {error ? <p className="error small">{error}</p> : null}

        <button
          className="btn primary"
          type="submit"
          disabled={busy || (mode === 'register' && !acceptedTerms)}
          style={{ width: '100%', justifyContent: 'center' }}
        >
          {busy ? '处理中…' : mode === 'login' ? '登录' : mode === 'register' ? '发送确认码' : '发送临时密码'}
        </button>

        <p className="small muted" style={{ textAlign: 'center', marginTop: 12 }}>
          {mode === 'register' ? '已经有账号了？' : '还没有账号？'}
          <button
            type="button"
            className="btn ghost small"
            onClick={() => switchMode(mode === 'register' ? 'login' : 'register')}
          >
            {mode === 'register' ? '去登录' : '立即注册'}
          </button>
        </p>

        {/* 忘记密码入口（登录卡片第二行）：点「找回密码」只填邮箱，系统发一封新的临时密码 */}
        <p className="small muted" style={{ textAlign: 'center' }}>
          {mode === 'forgot' ? '想起密码了？' : '忘记密码？'}
          <button
            type="button"
            className="btn ghost small"
            onClick={() => switchMode(mode === 'forgot' ? 'login' : 'forgot')}
          >
            {mode === 'forgot' ? '去登录' : '找回密码'}
          </button>
        </p>
      </form>

      {/* 「查看条款」：正文来自 GET /api/guide（管理员可在后台改），默认展示条款那一份 */}
      {termsOpen ? <PolicyDialog initial="terms" onClose={() => setTermsOpen(false)} /> : null}
    </div>
  );
}
