import { useEffect, useRef, useState } from 'react';
import type { RegistrationPending, SessionUser } from '../../shared/types';
import { ApiError, api } from '../api';
import { confirmSessionLanded } from '../lib/session';

interface AuthPageProps {
  appName: string;
  /** 站点图标（管理员上传过才有）：登录 / 注册卡片顶部跟着站点名称一起显示 */
  siteIconUrl: string | null;
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

export function AuthPage({ appName, siteIconUrl, onAuthenticated }: AuthPageProps) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  /** 注册是两步：先填资料（form），再填邮件里的确认码（code） */
  const [step, setStep] = useState<'form' | 'code'>('form');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [pending, setPending] = useState<RegistrationPending | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
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
      // 注册第一步：Worker 会把 6 位确认码发到邮箱（本地/测试环境直接在响应里回显）
      const result = await api.register({ email: email.trim(), password, name: name.trim() });
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

  const switchMode = (next: 'login' | 'register') => {
    setMode(next);
    setStep('form');
    setCode('');
    setPending(null);
    setError('');
    setNotice('');
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

  // ------------------------------------------------------------- 登录 / 注册
  return (
    <div className="centered">
      <form className="auth-card" onSubmit={submit}>
        <BrandHead appName={appName} siteIconUrl={siteIconUrl} />
        <p className="muted">{mode === 'login' ? '登录以继续你的表格' : '创建账号，开始搭建你的数据库'}</p>

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

        {mode === 'register' ? (
          <p className="small muted">注册需要邮箱确认：提交后我们会把 6 位确认码发到这个邮箱。</p>
        ) : null}

        {error ? <p className="error small">{error}</p> : null}

        <button className="btn primary" type="submit" disabled={busy} style={{ width: '100%', justifyContent: 'center' }}>
          {busy ? '处理中…' : mode === 'login' ? '登录' : '发送确认码'}
        </button>

        <p className="small muted" style={{ textAlign: 'center', marginTop: 12 }}>
          {mode === 'login' ? '还没有账号？' : '已经有账号了？'}
          <button
            type="button"
            className="btn ghost small"
            onClick={() => switchMode(mode === 'login' ? 'register' : 'login')}
          >
            {mode === 'login' ? '立即注册' : '去登录'}
          </button>
        </p>
      </form>
    </div>
  );
}
