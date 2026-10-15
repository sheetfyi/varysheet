import { useEffect, useRef, useState } from 'react';
import { TERMS_ACCEPT_LABEL } from '../../shared/policy';
import type { RegistrationPending, SessionUser } from '../../shared/types';
import { ApiError, api } from '../api';
import { DEFAULT_LOGIN_TAGLINE } from '../branding';
import { confirmSessionLanded } from '../lib/session';
import { PolicyDialog } from './PolicyDialog';
import { SiteMark } from './SiteMark';

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

/* ------------------------------------------------------------------ 图标 */
/**
 * 表单里用到的 16px 线性小图标（描边跟随 currentColor，不用彩色 emoji）。
 * 形状是参考站（Sealos 登录页）用的那一套通用线性图形。
 */
const ICON_SHAPES = {
  /** 邮箱 */
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3.6 7 8.4 5.7L20.4 7" />
    </>
  ),
  /** 密码 */
  lock: (
    <>
      <rect x="4" y="10.5" width="16" height="10.5" rx="2" />
      <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
    </>
  ),
  /** 昵称 */
  user: (
    <>
      <circle cx="12" cy="7.5" r="3.8" />
      <path d="M4.8 20.5a7.2 7.2 0 0 1 14.4 0" />
    </>
  ),
  /** 主按钮尾部的前进箭头（参考站「登录 →」用的就是这个图形） */
  arrowRight: (
    <>
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </>
  ),
  /** 注册 */
  userPlus: (
    <>
      <circle cx="9.5" cy="7.5" r="3.8" />
      <path d="M2.8 20.5a6.7 6.7 0 0 1 13.4 0" />
      <path d="M18.5 8v6" />
      <path d="M15.5 11h6" />
    </>
  ),
  /** 找回密码 */
  key: (
    <>
      <circle cx="7.6" cy="15.4" r="4.4" />
      <path d="M10.8 12.2 20.2 2.8" />
      <path d="m16.6 6.4 2.4 2.4" />
      <path d="m19 4 2.2 2.2" />
    </>
  ),
  /** 重新发送 */
  refresh: (
    <>
      <path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1" />
      <path d="M20.5 4.5V10h-5.5" />
    </>
  ),
  /** 返回上一步 */
  arrowLeft: (
    <>
      <path d="M19 12H5" />
      <path d="m12 19-7-7 7-7" />
    </>
  ),
  /** 去登录 */
  logIn: (
    <>
      <path d="M15 3h3.5A2.5 2.5 0 0 1 21 5.5v13a2.5 2.5 0 0 1-2.5 2.5H15" />
      <path d="m9.5 16.5 4.5-4.5-4.5-4.5" />
      <path d="M14 12H3.5" />
    </>
  ),
} as const;

function Icon({ name }: { name: keyof typeof ICON_SHAPES }) {
  return (
    <svg
      className="signin-icon"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICON_SHAPES[name]}
    </svg>
  );
}

/* -------------------------------------------------------------- 左侧插画 */
/**
 * 左侧深色插画上的四步流程：交替排在那条蛇形线的两侧（和参考站一样，
 * 一条线从「创建」串到「协助」）。坐标写死，因为它们要和 `FLOW_PATH` 对位。
 */
const FLOW_STEPS = [
  { title: '创建', desc: '打开网页就能建表，不用装软件', side: 'left' },
  { title: '定制', desc: '字段、视图、筛选，随时调整', side: 'right' },
  { title: '分享', desc: '团队协作，权限分级', side: 'left' },
  { title: '协助', desc: '共同编辑，支持站内短信', side: 'right' },
] as const;

/** 蛇形流程线：每行一段横线，行尾用半径 50 的半圆折回下一行（viewBox 720 × 900） */
const FLOW_PATH = 'M150 250H500A50 50 0 0 1 500 360H150A50 50 0 0 0 150 470H500A50 50 0 0 1 500 580H150';

/** 流程线周围的零星小圆点（参考站那里是几张头像照片，这里换成纯粹的色块） */
const FLOW_DOTS = [
  [150, 165, 26],
  [610, 205, 18],
  [205, 700, 24],
  [560, 780, 20],
] as const;

/**
 * 登录页左半边：黑底 + 插画（`.signin-visual`）。
 *
 * 窄屏（≤900px）时整块隐藏，只留右边的表单，站标改由 `AuthShell` 顶在表单上方显示。
 */
function SigninVisual({ appName, siteIconUrl }: { appName: string; siteIconUrl: string | null }) {
  return (
    <div className="signin-visual">
      <SiteMark appName={appName} siteIconUrl={siteIconUrl} className="signin-brand" />
      {/* 插画是纯矢量：跟着面板等比缩放，不依赖任何图片资源 */}
      <svg
        className="signin-art"
        viewBox="0 0 720 900"
        preserveAspectRatio="xMidYMid slice"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <radialGradient id="signin-glow" cx="50%" cy="45%" r="62%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.05" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="signin-dot" cx="35%" cy="30%" r="80%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.09" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0.02" />
          </radialGradient>
        </defs>

        <rect width="720" height="900" fill="url(#signin-glow)" />

        {FLOW_DOTS.map(([cx, cy, r]) => (
          <circle
            key={`${cx}-${cy}`}
            cx={cx}
            cy={cy}
            r={r}
            fill="url(#signin-dot)"
            stroke="rgba(255,255,255,0.06)"
          />
        ))}

        <path d={FLOW_PATH} fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="1.5" strokeLinecap="round" />

        {FLOW_STEPS.map((step, index) => {
          // 竖坐标与 FLOW_PATH 的四条横线（250 / 360 / 470 / 580）对齐：下移 62 正好落在两线中间
          const y = 312 + index * 110;
          const onLeft = step.side === 'left';
          return (
            <g key={step.title}>
              <text className="signin-art-title" x="380" y={y} textAnchor="middle">
                {step.title}
              </text>
              <text
                className="signin-art-desc"
                x={onLeft ? 310 : 430}
                y={y}
                textAnchor={onLeft ? 'end' : 'start'}
              >
                {step.desc}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/**
 * 登录 / 注册 / 找回密码共用的外壳：左边深色插画，右边白色表单（左右各占一半）。
 * 表单在右半边里水平垂直居中；窄屏时左半边整块收起、站标顶在表单上方。
 */
function AuthShell({
  appName,
  siteIconUrl,
  children,
}: {
  appName: string;
  siteIconUrl: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="signin">
      <SigninVisual appName={appName} siteIconUrl={siteIconUrl} />
      <div className="signin-main">
        <SiteMark appName={appName} siteIconUrl={siteIconUrl} className="signin-mobile-brand" />
        <div className="signin-panel">{children}</div>
      </div>
    </div>
  );
}

/** 带左侧图标的输入框：图标 + 视觉隐藏的字段名 + input 本体 */
function IconField({
  icon,
  label,
  children,
}: {
  icon: keyof typeof ICON_SHAPES;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="signin-field">
      {/* 参考站只有占位符，这里用一个视觉隐藏的 label 保住读屏与自动填充的可读性 */}
      <span className="signin-label">{label}</span>
      <span className="signin-field-icon" aria-hidden="true">
        <Icon name={icon} />
      </span>
      {children}
    </label>
  );
}

/** 主按钮：黑底白字，尾巴上带一个前进箭头（参考站的「登录 →」） */
function PrimaryButton({ busy, disabled, label }: { busy: boolean; disabled: boolean; label: string }) {
  return (
    <button className="signin-btn signin-btn-primary" type="submit" disabled={disabled}>
      {busy ? '处理中…' : label}
      {busy ? null : <Icon name="arrowRight" />}
    </button>
  );
}

/** 「或」分隔线：两条细线夹一个字（分隔主按钮与下面那排次要入口） */
function OrDivider() {
  return (
    <div className="signin-divider">
      <span className="signin-divider-line" />
      <span className="signin-divider-text">或</span>
      <span className="signin-divider-line" />
    </div>
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
      <AuthShell appName={appName} siteIconUrl={siteIconUrl}>
        {/* 保留 auth-card 类：tools/mobile-check 下的脚本用它定位登录表单，视觉上已被 .signin-form 清掉 */}
        <form className="auth-card signin-form" onSubmit={verify}>
          <div className="signin-head">
            <h1 className="signin-title">输入确认码</h1>
            <p className="signin-subtitle">输入邮件里的确认码，完成注册</p>
          </div>

          <p className="small muted">
            确认码收件邮箱：<strong>{email}</strong>
          </p>

          {pending && !pending.emailDelivered && pending.devCode ? (
            <p className="hint-box small">
              📮 邮件服务未配置（或收件人是测试域），确认码是 <strong className="code-echo">{pending.devCode}</strong>
            </p>
          ) : null}

          {notice ? <p className="small muted">{notice}</p> : null}

          <label className="signin-field">
            <span className="signin-label">6 位确认码</span>
            <input
              ref={codeInputRef}
              className="signin-input signin-input-flat code-input"
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

          <PrimaryButton busy={busy} disabled={busy || code.length !== 6} label="完成注册" />

          <OrDivider />

          <div className="signin-actions">
            <button
              type="button"
              className="signin-btn signin-btn-secondary"
              onClick={resend}
              disabled={busy || cooldown > 0}
            >
              <Icon name="refresh" />
              {cooldown > 0 ? `重新发送（${cooldown}s）` : '重新发送确认码'}
            </button>
            <button
              type="button"
              className="signin-btn signin-btn-secondary"
              onClick={() => {
                setStep('form');
                setError('');
                setNotice('');
              }}
            >
              <Icon name="arrowLeft" />
              改注册信息
            </button>
          </div>
        </form>
      </AuthShell>
    );
  }

  // ------------------------------------------------------------- 登录 / 注册 / 找回密码
  return (
    <AuthShell appName={appName} siteIconUrl={siteIconUrl}>
      {/* 保留 auth-card 类：tools/mobile-check 下的脚本用它定位登录表单，视觉上已被 .signin-form 清掉 */}
      <form className="auth-card signin-form" onSubmit={submit}>
        <div className="signin-head">
          <h1 className="signin-title">
            {mode === 'login' ? `欢迎来到 ${appName}` : mode === 'register' ? '创建账号' : '找回密码'}
          </h1>
          <p className="signin-subtitle">
            {mode === 'login'
              ? loginTagline.trim() || DEFAULT_LOGIN_TAGLINE
              : mode === 'register'
                ? '创建账号，开始搭建你的数据库'
                : '输入注册邮箱，我们把新的临时密码发给你'}
          </p>
        </div>

        {mode === 'register' ? (
          <IconField icon="user" label="昵称">
            <input
              className="signin-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="昵称"
              autoComplete="nickname"
              required
            />
          </IconField>
        ) : null}

        <IconField icon="mail" label="邮箱">
          <input
            className="signin-input"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="邮箱"
            autoComplete="email"
            // 手机键盘默认会首字母大写 / 自动更正，邮箱与密码都不需要
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
          />
        </IconField>

        {mode === 'forgot' ? null : (
          <IconField icon="lock" label="密码">
            <input
              className="signin-input"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={mode === 'login' ? '密码' : '密码（至少 8 位）'}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              minLength={8}
              required
            />
          </IconField>
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

        <PrimaryButton
          busy={busy}
          disabled={busy || (mode === 'register' && !acceptedTerms)}
          label={mode === 'login' ? '登录' : mode === 'register' ? '发送确认码' : '发送临时密码'}
        />

        <OrDivider />

        {/* 主按钮下面的那排次要入口，样式对齐参考站的「微信 / GitHub」两颗描边按钮 */}
        <div className="signin-actions">
          {mode === 'login' ? (
            <>
              <button type="button" className="signin-btn signin-btn-secondary" onClick={() => switchMode('register')}>
                <Icon name="userPlus" />
                立即注册
              </button>
              {/* 忘记密码：点「找回密码」只填邮箱，系统发一封新的临时密码 */}
              <button type="button" className="signin-btn signin-btn-secondary" onClick={() => switchMode('forgot')}>
                <Icon name="key" />
                找回密码
              </button>
            </>
          ) : (
            <button type="button" className="signin-btn signin-btn-secondary" onClick={() => switchMode('login')}>
              <Icon name="logIn" />
              去登录
            </button>
          )}
        </div>

        {/*
          底部那行「继续表示您已阅读、理解并同意我们的…」（参考站每个模式都有）：
          注册模式里这件事由勾选框承担，所以那里不再重复一遍。
        */}
        {mode === 'register' ? null : (
          <p className="signin-consent">
            继续表示您已阅读、理解并同意我们的
            <button type="button" className="signin-consent-link" onClick={() => setTermsOpen(true)}>
              《系统规则与内容合规条款》
            </button>
          </p>
        )}
      </form>

      {/* 「查看条款」：正文来自 GET /api/guide（管理员可在后台改），默认展示条款那一份 */}
      {termsOpen ? <PolicyDialog initial="terms" onClose={() => setTermsOpen(false)} /> : null}
    </AuthShell>
  );
}
