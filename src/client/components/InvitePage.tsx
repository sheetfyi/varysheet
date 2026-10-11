/**
 * 视图分享邀请页（`/invite/:token`）。
 *
 * 表格所有者把某个视图分享给一个还没注册的邮箱时，邀请链接会发到那个邮箱；
 * 对方点开后在这里填昵称 + 密码即完成注册（不需要邮箱确认码），
 * 注册成功会自动登录并直接看到被分享的视图。
 */
import { useEffect, useState } from 'react';
import { TERMS_ACCEPT_LABEL } from '../../shared/policy';
import type { InviteDetail, SessionUser } from '../../shared/types';
import { ApiError, api } from '../api';
import { confirmSessionLanded } from '../lib/session';
import { PolicyDialog } from './PolicyDialog';

interface InvitePageProps {
  token: string;
  /** 注册成功：App 会重新拉会话（自动打开被分享的表格） */
  onAuthenticated: (user: SessionUser) => void;
  /** 「我已经有账号了」：回到普通登录页 */
  onGoToLogin: () => void;
}

export function InvitePage({ token, onAuthenticated, onGoToLogin }: InvitePageProps) {
  const [detail, setDetail] = useState<InviteDetail | null>(null);
  const [loadError, setLoadError] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  /** 邀请注册同样要勾选「已了解系统的规则和内容合规的要求」（服务端会拦） */
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [termsOpen, setTermsOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .invite(token)
      .then((payload) => {
        if (cancelled) return;
        setDetail(payload.invite);
        // 昵称默认填邮箱前缀，用户可以直接改
        setName(payload.invite.email.split('@')[0] ?? '');
      })
      .catch((cause) => {
        if (!cancelled) setLoadError(cause instanceof ApiError ? cause.message : '邀请链接无效或已过期');
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    if (!acceptedTerms) {
      setError('请先勾选并阅读《系统规则与内容合规条款》');
      return;
    }
    setBusy(true);
    try {
      const result = await api.acceptInvite(token, { name: name.trim(), password, acceptedTerms: true });
      // 邀请已经消费掉了，兜底只能走刚设置的密码重新登录（cookie 存不下来的浏览器）
      const landing = await confirmSessionLanded({ email: detail?.email ?? '', password });
      if (!landing.ok) {
        setError(`${landing.message ?? '注册完成，但登录状态没能保存'}（账号已创建，可以直接登录）`);
        return;
      }
      onAuthenticated(result.user);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '注册失败，请稍后再试');
    } finally {
      setBusy(false);
    }
  };

  if (loadError) {
    return (
      <div className="centered">
        <div className="empty-state">
          <h2>无法打开邀请链接</h2>
          <p className="error">{loadError}</p>
          <div className="empty-actions">
            <button type="button" className="btn" onClick={onGoToLogin}>
              去登录
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="centered">
        <p className="muted">正在载入邀请…</p>
      </div>
    );
  }

  const days = Math.max(1, Math.ceil(detail.expiresInSeconds / 86_400));

  return (
    <div className="centered">
      <form className="auth-card" onSubmit={submit}>
        {detail.siteIconUrl ? <img className="auth-logo" src={detail.siteIconUrl} alt="" /> : null}
        <h1>{detail.appName}</h1>
        <p className="muted">
          {detail.inviterName || '有人'}把「{detail.databaseName}」的视图「{detail.viewName}」分享给你，
          {detail.role === 'editor' ? '可以编辑' : '可以查看'}。
        </p>
        <p className="small muted">
          用 {detail.email} 注册后即可打开该视图（链接 {days} 天内有效，不需要邮箱确认码）。
        </p>

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

        <label className="field">
          <span>密码</span>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="至少 8 位"
            autoComplete="new-password"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            minLength={8}
            required
          />
        </label>

        <p className="small muted">密码需要同时包含字母和数字，至少 8 位。</p>

        {/* 邀请注册同样要确认已了解系统规则与内容合规要求 */}
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

        {error ? <p className="error small">{error}</p> : null}

        <button
          className="btn primary"
          type="submit"
          disabled={busy || !acceptedTerms}
          style={{ width: '100%', justifyContent: 'center' }}
        >
          {busy ? '处理中…' : '完成注册并查看'}
        </button>

        <p className="small muted" style={{ textAlign: 'center', marginTop: 12 }}>
          已经有账号了？
          <button type="button" className="btn ghost small" onClick={onGoToLogin}>
            去登录
          </button>
        </p>
      </form>

      {termsOpen ? <PolicyDialog initial="terms" onClose={() => setTermsOpen(false)} /> : null}
    </div>
  );
}
