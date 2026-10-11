/**
 * 「系统使用说明 / 系统规则与内容合规条款」弹窗（正文来自公开接口 `GET /api/guide`）。
 *
 * 两个入口共用这一份实现：
 *   1. 侧边栏「改密码」左边的黄色「?」圆点 —— 默认展示「系统使用说明」，可以切到条款；
 *   2. 注册页勾选框旁边的《系统规则与内容合规条款》链接 —— 默认展示条款。
 *
 * 正文是纯文本（管理员在「后台 → 系统管理」里改，见 `src/shared/policy.ts` 的默认文案），
 * 这里按原样换行渲染（`.policy-body` 是 `white-space: pre-wrap`）。
 */
import { useEffect, useState } from 'react';
import type { GuideResponse } from '../../shared/types';
import { ApiError, api } from '../api';
import { Modal } from './Modal';

/** 弹窗里能切的两份文案 */
type PolicyKey = 'guide' | 'terms';

interface PolicyDialogProps {
  /** 打开时先展示哪一份（默认「系统使用说明」） */
  initial?: PolicyKey;
  onClose: () => void;
}

export function PolicyDialog({ initial = 'guide', onClose }: PolicyDialogProps) {
  const [payload, setPayload] = useState<GuideResponse | null>(null);
  const [active, setActive] = useState<PolicyKey>(initial);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    api
      .guide()
      .then((next) => {
        if (!cancelled) setPayload(next);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof ApiError ? cause.message : '内容加载失败，请稍后重试');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const current = payload ? payload[active] : null;

  return (
    <Modal title={current?.title ?? '系统说明'} wide onClose={onClose}>
      {/* 两份文案的切换：用 tab 的样子（弹窗正文很长，标题栏放不下两个入口） */}
      <div className="row gap policy-tabs" role="tablist">
        {(['guide', 'terms'] as PolicyKey[]).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={active === key}
            className={`btn ghost small${active === key ? ' active' : ''}`}
            onClick={() => setActive(key)}
          >
            {key === 'guide' ? '使用说明' : '规则与条款'}
          </button>
        ))}
      </div>

      {error ? <p className="error small">{error}</p> : null}
      {!payload && !error ? <p className="muted small">正在载入…</p> : null}

      {current ? (
        <>
          <div className="policy-body" role="tabpanel">
            {current.content}
          </div>
          <p className="small muted policy-foot">
            {current.isDefault ? '当前使用系统默认文案' : '当前使用站点自定义文案'}
            {current.version ? ` · 版本 ${current.version}` : ''}
          </p>
        </>
      ) : null}
    </Modal>
  );
}
