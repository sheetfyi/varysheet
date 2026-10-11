/**
 * 「后台 → 站点设置」卡片：站点名称 / 图标 / 管理员邮箱 / Resend 发信（密钥 + 发件人）。
 *
 * 值都存在服务端（D1 的 `settings` 表），生效顺序是 **数据库 → Worker secret / 环境变量 → 代码默认值**
 * （见 `src/worker/settings.ts`）：所以这里的输入框留空 = 清掉数据库里的值、退回环境变量。
 *
 * Resend 密钥永远不完整回传：接口只给掩码（`re_ab…wxyz`）。输入框默认显示掩码并当作「没改过」，
 * 只有真的聚焦输入过才提交新值 —— 否则每次保存都会把掩码当成密钥存回去。
 */
import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import type { AdminSettings, BrandingResponse } from '../../shared/types';
import { xorpayPayTypeLabel } from '../../shared/xorpay';
import { ApiError, api } from '../api';
import { SiteMark } from './SiteMark';

interface SiteSettingsCardProps {
  onToast: (message: string, kind?: 'info' | 'error') => void;
  /** 保存成功：把最新的品牌信息交给 App，侧边栏标识 / 页面标题 / favicon 立刻跟着更新 */
  onBrandingChange: (branding: BrandingResponse) => void;
  /** 管理员邮箱改过：让 App 重新拉会话（自己的管理员身份可能因此变化） */
  onReloadSession: () => void;
}

/** 与 Worker 端 `MAX_ICON_BYTES` 一致；超限服务端也会拒，这里先拦一次省一趟往返 */
const MAX_ICON_KB = 512;
/** 允许的图标格式，与 Worker 端 `ICON_MIME_TYPES` 一致 */
const ICON_ACCEPT =
  'image/png,image/jpeg,image/webp,image/gif,image/avif,image/svg+xml,image/x-icon,image/vnd.microsoft.icon';

export function SiteSettingsCard({ onToast, onBrandingChange, onReloadSession }: SiteSettingsCardProps) {
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [siteName, setSiteName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [fromEmail, setFromEmail] = useState('');
  const [apiKey, setApiKey] = useState('');
  /** 密钥框是否被手动改过：false 时显示服务端掩码，保存时不提交这个字段 */
  const [keyEdited, setKeyEdited] = useState(false);
  /** XorPay 收款（表格名额购买）：appid 是明文（要显示出来核对），app secret 只回传掩码 */
  const [xorpayAid, setXorpayAid] = useState('');
  const [xorpaySecret, setXorpaySecret] = useState('');
  const [xorpaySecretEdited, setXorpaySecretEdited] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [iconBusy, setIconBusy] = useState(false);
  const [error, setError] = useState('');

  /** 把服务端返回的设置灌进表单（密钥框回到「显示掩码 + 未修改」状态） */
  const applySettings = useCallback((next: AdminSettings) => {
    setSettings(next);
    setSiteName(next.siteName);
    setAdminEmail(next.adminEmail);
    setFromEmail(next.resendFromEmail);
    setApiKey('');
    setKeyEdited(false);
    setXorpayAid(next.xorpayAid);
    setXorpaySecret('');
    setXorpaySecretEdited(false);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const payload = await api.adminSettings();
      applySettings(payload.settings);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '站点设置加载失败');
    } finally {
      setLoading(false);
    }
  }, [applySettings]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!settings) return;
    const nextAdminEmail = adminEmail.trim().toLowerCase();
    const adminChanged = nextAdminEmail !== settings.adminEmail.toLowerCase();
    setSaving(true);
    try {
      const payload = await api.adminUpdateSettings({
        siteName: siteName.trim(),
        adminEmail: nextAdminEmail,
        resendFromEmail: fromEmail.trim(),
        // 没动过的密钥不提交：PATCH 里没有这个字段 = 保持原样（提交掩码会被当成新密钥存进去）
        ...(keyEdited ? { resendApiKey: apiKey.trim() } : {}),
        // XorPay 收款：appid 是明文，总是提交（留空 = 关掉收款）；密钥只在手动改过时提交
        xorpayAid: xorpayAid.trim(),
        ...(xorpaySecretEdited ? { xorpayAppSecret: xorpaySecret.trim() } : {}),
      });
      applySettings(payload.settings);
      onBrandingChange(payload.branding);
      if (adminChanged) onReloadSession();
      onToast(payload.settings.xorpayConfigured ? '站点设置已保存：微信扫码收款已开启' : '站点设置已保存');
    } catch (cause) {
      onToast(cause instanceof ApiError ? cause.message : '保存站点设置失败', 'error');
    } finally {
      setSaving(false);
    }
  };

  const uploadIcon = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    // 先清空 input：否则再选同一个文件不会触发 change
    event.target.value = '';
    if (!file) return;
    if (file.size > MAX_ICON_KB * 1024) {
      onToast(`图标不能超过 ${MAX_ICON_KB}KB`, 'error');
      return;
    }
    setIconBusy(true);
    try {
      const payload = await api.adminUploadSiteIcon(file);
      applySettings(payload.settings);
      onBrandingChange(payload.branding);
      onToast('站点图标已更新');
    } catch (cause) {
      onToast(cause instanceof ApiError ? cause.message : '图标上传失败', 'error');
    } finally {
      setIconBusy(false);
    }
  };

  const removeIcon = async () => {
    if (!window.confirm('确定移除站点图标吗？移除后界面只显示站点名称。')) return;
    setIconBusy(true);
    try {
      const payload = await api.adminDeleteSiteIcon();
      applySettings(payload.settings);
      onBrandingChange(payload.branding);
      onToast('已移除站点图标');
    } catch (cause) {
      onToast(cause instanceof ApiError ? cause.message : '移除图标失败', 'error');
    } finally {
      setIconBusy(false);
    }
  };

  /** 先把密钥框从「显示掩码」切换成「可以输入」：一聚焦就清空，免得误提交掩码 */
  const editKey = () => {
    if (keyEdited) return;
    setKeyEdited(true);
    setApiKey('');
  };

  if (loading) {
    return (
      <section className="settings-card">
        <p className="muted small">站点设置加载中…</p>
      </section>
    );
  }

  if (!settings) {
    return (
      <section className="settings-card">
        <p className="error small">{error || '站点设置加载失败'}</p>
        <div className="row gap">
          <button type="button" className="btn small" onClick={() => void load()}>
            重试
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="settings-card">
      <div className="row gap settings-head">
        <SiteMark
          appName={siteName.trim() || settings.defaults.siteName}
          siteIconUrl={settings.iconUrl}
          className="brand"
        />
        <span className="tag">{settings.hasIcon ? '已上传图标' : '未上传图标'}</span>
      </div>
      <p className="small muted">
        站点名称与图标用在界面左上角、浏览器标签页（favicon）和登录页；管理员邮箱决定谁进得了后台，
        发件人决定确认码 / 通知邮件看起来像是谁发的。这些值都存在数据库里，优先级高于 Worker 的 secret。
      </p>

      <form className="settings-form" onSubmit={save}>
        <label className="field">
          <span>站点名称</span>
          <input
            className="input"
            value={siteName}
            maxLength={60}
            required
            placeholder={settings.defaults.siteName}
            onChange={(event) => setSiteName(event.target.value)}
          />
          <span className="small muted">不能为空，最多 60 字；内置默认值：{settings.defaults.siteName}</span>
        </label>

        <div className="field">
          <span>站点图标</span>
          <div className="row gap">
            {settings.iconUrl ? (
              <img className="brand-icon large-icon" src={settings.iconUrl} alt="当前站点图标" />
            ) : (
              <span className="small muted">还没有图标</span>
            )}
            <input
              className="icon-file"
              type="file"
              accept={ICON_ACCEPT}
              disabled={iconBusy}
              aria-label="上传站点图标"
              onChange={(event) => void uploadIcon(event)}
            />
            {settings.hasIcon ? (
              <button type="button" className="btn ghost small" disabled={iconBusy} onClick={() => void removeIcon()}>
                移除图标
              </button>
            ) : null}
          </div>
          <span className="small muted">
            PNG / JPEG / WebP / GIF / AVIF / SVG / ICO，不超过 {MAX_ICON_KB}KB；建议方形图（标签页里显示得很小）
          </span>
        </div>

        <label className="field">
          <span>管理员邮箱</span>
          <input
            className="input"
            type="email"
            value={adminEmail}
            placeholder={settings.defaults.adminEmail}
            onChange={(event) => setAdminEmail(event.target.value)}
          />
          <span className="small muted">
            {settings.adminEmailFromEnv
              ? '当前用的是 Worker 环境变量 ADMIN_EMAIL；在这里填一个邮箱保存后，以数据库里的为准'
              : '该邮箱登录时会自动创建 / 提升为管理员；留空保存 = 退回 Worker 环境变量或默认值'}
          </span>
        </label>

        <div className="field">
          <span>Resend API Key</span>
          <div className="row gap">
            <input
              className="input"
              value={keyEdited ? apiKey : settings.resolvedResendApiKey}
              placeholder="re_..."
              autoComplete="off"
              spellCheck={false}
              onFocus={editKey}
              onChange={(event) => {
                setKeyEdited(true);
                setApiKey(event.target.value);
              }}
            />
            {keyEdited ? (
              <button
                type="button"
                className="btn ghost small"
                onClick={() => {
                  setKeyEdited(false);
                  setApiKey('');
                }}
              >
                还原
              </button>
            ) : null}
          </div>
          <span className="small muted">
            {!settings.resendApiKeyConfigured
              ? '还没配密钥：确认码会直接回显在接口响应里（devCode），只适合测试域'
              : settings.resendApiKeyFromEnv
                ? '当前生效的是 Worker secret / .dev.vars 里的密钥；要换就直接填入新的'
                : '当前密钥保存在数据库里；留空保存 = 删掉它，退回 Worker secret'}
          </span>
        </div>

        <label className="field">
          <span>发件人</span>
          <input
            className="input"
            value={fromEmail}
            placeholder={settings.defaults.resendFromEmail}
            onChange={(event) => setFromEmail(event.target.value)}
          />
          <span className="small muted">
            格式：邮箱，或「名称 &lt;邮箱&gt;」；留空 = 用默认值 {settings.defaults.resendFromEmail}
          </span>
        </label>

        {/* XorPay 收款：填好 appid + app secret 保存后立刻开启「微信扫码购买表格名额」 */}
        <div className="field">
          <span>XorPay 应用 ID（appid）</span>
          <input
            className="input"
            value={xorpayAid}
            placeholder="XorPay 后台「应用配置」里的 appid"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setXorpayAid(event.target.value)}
          />
          <span className="small muted">
            {settings.xorpayConfigured
              ? '已开通收款；appid 留空保存 = 关掉收款（购买退回「下单立即到账」）'
              : '还没开通收款：现在购买名额会直接到账、不真的收钱。填上 appid + app secret 保存后立刻开启微信扫码支付'}
          </span>
        </div>

        <div className="field">
          <span>XorPay 应用密钥（app secret）</span>
          <div className="row gap">
            <input
              className="input"
              value={xorpaySecretEdited ? xorpaySecret : settings.resolvedXorpayAppSecret}
              placeholder="XorPay 后台「应用配置」里的 app secret"
              autoComplete="off"
              spellCheck={false}
              onFocus={() => {
                if (!xorpaySecretEdited) {
                  setXorpaySecretEdited(true);
                  setXorpaySecret('');
                }
              }}
              onChange={(event) => {
                setXorpaySecretEdited(true);
                setXorpaySecret(event.target.value);
              }}
            />
            {xorpaySecretEdited ? (
              <button
                type="button"
                className="btn ghost small"
                onClick={() => {
                  setXorpaySecretEdited(false);
                  setXorpaySecret('');
                }}
              >
                还原
              </button>
            ) : null}
          </div>
          <span className="small muted">
            {settings.xorpayAppSecretFromEnv
              ? '当前生效的是 Worker secret / .dev.vars 里的密钥；要换就直接填入新的'
              : `支付方式：${settings.xorpayPayTypes.map((item) => xorpayPayTypeLabel(item)).join(' / ') || '未开通'}；密钥只保存在服务端（不回传完整值），保存后立刻生效、不用重新部署`}
          </span>
        </div>

        <div className="row gap settings-actions">
          <button className="btn primary" type="submit" disabled={saving}>
            {saving ? '保存中…' : '保存设置'}
          </button>
          <button type="button" className="btn ghost" disabled={saving} onClick={() => applySettings(settings)}>
            放弃修改
          </button>
          {error ? <span className="error small">{error}</span> : null}
        </div>
      </form>
    </section>
  );
}
