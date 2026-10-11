/**
 * 「后台 → 系统管理」里的「系统规则与条款 / 系统使用说明」编辑卡片（需求 2026-10）。
 *
 * 两份正文都存 D1 的 `settings` 表（`terms_content` / `guide_content`，见 `src/worker/settings.ts`），
 * 保存后**立刻生效、不用重新部署**：
 *   - 「系统规则与内容合规条款」= 注册页那个勾选框旁边的《…》正文（`GET /api/guide`）；
 *   - 「系统使用说明」= 侧边栏「改密码」左边黄色「?」圆点打开的说明弹窗。
 *
 * 留空保存 = 清掉数据库里的值、退回代码里的默认文案（`src/shared/policy.ts`），
 * 所以「恢复默认」只需要把输入框清空再保存；保存前可以点「预览」看这段文字的样子。
 */
import { useCallback, useEffect, useState } from 'react';
import { GUIDE_TITLE, TERMS_TITLE } from '../../shared/policy';
import type { AdminSettings } from '../../shared/types';
import { ApiError, api } from '../api';
import { Modal } from './Modal';

interface PolicyEditorCardProps {
  onToast: (message: string, kind?: 'info' | 'error') => void;
}

/** 预览弹窗要展示哪一份 */
type PreviewKind = 'terms' | 'guide';

export function PolicyEditorCard({ onToast }: PolicyEditorCardProps) {
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  /** 条款正文（空串 = 用代码默认文案；保存时原样提交） */
  const [terms, setTerms] = useState('');
  /** 使用说明正文（空串 = 用代码默认文案） */
  const [guide, setGuide] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<PreviewKind | null>(null);

  /** 把服务端返回的设置灌进表单 */
  const applySettings = useCallback((next: AdminSettings) => {
    setSettings(next);
    // 默认文案不写回输入框：留空 = 用默认（否则一保存就把默认文案固化成「自定义」了）
    setTerms(next.termsContentIsDefault ? '' : next.termsContent);
    setGuide(next.guideContentIsDefault ? '' : next.guideContent);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const payload = await api.adminSettings();
      applySettings(payload.settings);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [applySettings]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const payload = await api.adminUpdateSettings({ termsContent: terms, guideContent: guide });
      applySettings(payload.settings);
      onToast('系统规则与使用说明已保存，注册页与「?」说明立刻生效');
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  /** 输入框里的内容与服务端不一致（有未保存的修改） */
  const dirty =
    settings !== null &&
    (terms !== (settings.termsContentIsDefault ? '' : settings.termsContent) ||
      guide !== (settings.guideContentIsDefault ? '' : settings.guideContent));

  /** 预览里显示的正文：输入框为空时退回当前生效的文案（默认或已保存的自定义） */
  const previewBody = (kind: PreviewKind) => {
    const value = kind === 'terms' ? terms : guide;
    if (value.trim()) return value;
    return settings ? (kind === 'terms' ? settings.termsContent : settings.guideContent) : '';
  };

  /**
   * 一份正文的编辑块（条款 / 使用说明共用）：标题 + 多行输入 + 预览 / 恢复默认。
   */
  const editorBlock = (
    kind: PreviewKind,
    value: string,
    onChange: (next: string) => void,
    isDefault: boolean,
    hint: string,
  ) => (
    <>
      <label className="field">
        <span>
          {kind === 'terms' ? TERMS_TITLE : GUIDE_TITLE}
          {isDefault ? <em className="small muted">（当前是默认文案）</em> : null}
        </span>
        <textarea
          className="input policy-textarea"
          value={value}
          rows={12}
          placeholder={kind === 'terms' ? '留空 = 使用系统内置的默认条款' : '留空 = 使用系统内置的默认使用说明'}
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
        />
        <span className="small muted">{hint}</span>
      </label>
      <div className="row gap">
        <button type="button" className="btn ghost small" onClick={() => setPreview(kind)}>
          预览
        </button>
        {isDefault ? null : (
          <button type="button" className="btn ghost small" onClick={() => onChange('')}>
            恢复默认文案
          </button>
        )}
      </div>
    </>
  );

  return (
    <section className="card policy-editor">
      <div className="card-head">
        <h3>系统规则与使用说明</h3>
        <span className="small muted">
          注册勾选的《{TERMS_TITLE}》与侧边栏「?」圆点打开的《{GUIDE_TITLE}》，保存后立刻生效
        </span>
      </div>

      {loading ? <p className="muted small">正在载入…</p> : null}
      {error ? <p className="error small">{error}</p> : null}

      {settings ? (
        <>
          {editorBlock(
            'terms',
            terms,
            setTerms,
            settings.termsContentIsDefault,
            '注册（含邀请注册）时必须勾选同意；留空保存 = 清掉自定义文案、退回默认条款',
          )}
          {editorBlock(
            'guide',
            guide,
            setGuide,
            settings.guideContentIsDefault,
            '侧边栏「改密码」左边的黄色「?」圆点打开它；留空保存 = 退回默认使用说明',
          )}

          <div className="row gap settings-actions">
            <button type="button" className="btn primary" disabled={saving || !dirty} onClick={() => void save()}>
              {saving ? '保存中…' : '保存'}
            </button>
            <button type="button" className="btn ghost" disabled={saving} onClick={() => applySettings(settings)}>
              放弃修改
            </button>
            <span className="small muted">正文都是纯文本：换行会原样保留，不接受 HTML</span>
          </div>
        </>
      ) : null}

      {preview ? (
        <Modal title={preview === 'terms' ? TERMS_TITLE : GUIDE_TITLE} wide onClose={() => setPreview(null)}>
          <div className="policy-body">{previewBody(preview)}</div>
        </Modal>
      ) : null}
    </section>
  );
}
