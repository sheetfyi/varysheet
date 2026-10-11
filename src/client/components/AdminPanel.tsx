/**
 * 「后台」的两个页面（只有超级管理员进得去，侧边栏「管理」下分成两条入口）：
 *   1. AdminUsersPanel  用户管理：管理注册账号 —— 查看全部注册用户、修改注册信息
 *                       （昵称 / 邮箱）、重置密码、批量删除账号；
 *   2. AdminSystemPanel 系统管理：站点设置（站点名称 / 图标 / 管理员邮箱 / Resend 发信，
 *                       见 SiteSettingsCard）与存储分片（见 ShardsCard）。
 * 权限在服务端（`/api/admin/*` 全部走 `requireAdmin`），这里只是入口的显隐。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AdminUser, BrandingResponse, SessionUser } from '../../shared/types';
import { ApiError, api } from '../api';
import { EditUserDialog } from './EditUserDialog';
import { PolicyEditorCard } from './PolicyEditorCard';
import { ResetResultCard, type ResetResult } from './ResetResultCard';
import { ShardsCard } from './ShardsCard';
import { SiteSettingsCard } from './SiteSettingsCard';

/** 侧边栏「管理」下的两条入口：用户管理 / 系统管理 */
export type AdminSection = 'users' | 'system';

interface AdminUsersPanelProps {
  me: SessionUser | null;
  onToast: (message: string, kind?: 'info' | 'error') => void;
  /** 改了自己的资料 / 重置了自己的密码之后，让 App 重新拉一次会话 */
  onReloadSession: () => void;
}

interface AdminSystemPanelProps {
  onToast: (message: string, kind?: 'info' | 'error') => void;
  onReloadSession: () => void;
  /** 站点设置保存成功：把最新品牌信息交给 App（侧边栏标识 / 页面标题 / favicon 立刻更新） */
  onBrandingChange: (branding: BrandingResponse) => void;
}

const PAGE_SIZE = 50;

/** 列表里的时间统一按本地时区显示 */
export function formatTime(value: number | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

export function AdminUsersPanel({ me, onToast, onReloadSession }: AdminUsersPanelProps) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [busyId, setBusyId] = useState('');
  const [reset, setReset] = useState<ResetResult | null>(null);
  /** 第一列勾选的账号 id（批量删除用） */
  const [selected, setSelected] = useState<string[]>([]);
  const [deleting, setDeleting] = useState(false);
  const selectAllRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    // 勾选状态只针对「当前这一页看到的账号」，重新加载时清空更安全
    setSelected([]);
    try {
      const payload = await api.adminListUsers({ search, limit: PAGE_SIZE, offset });
      setUsers(payload.users);
      setTotal(payload.total);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '用户列表加载失败');
    } finally {
      setLoading(false);
    }
  }, [search, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 能勾选删除的账号：管理员账号与自己不能删（服务端同样会跳过） */
  const selectable = users.filter((user) => !user.isAdmin && user.id !== me?.id);
  const allSelected = selectable.length > 0 && selected.length === selectable.length;

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = selected.length > 0 && selected.length < selectable.length;
    }
  }, [selected, selectable.length]);

  const toggleOne = (id: string, checked: boolean) =>
    setSelected((prev) => (checked ? [...prev, id] : prev.filter((item) => item !== id)));

  /** 批量删除：连同账号自己创建的表格（记录 / 备注 / 上传文件）一起清理 */
  const deleteSelected = async () => {
    const targets = users.filter((user) => selected.includes(user.id));
    if (!targets.length) return;
    const names = targets.map((user) => user.name || user.email).join('、');
    const confirmed = window.confirm(
      `确定删除这 ${targets.length} 个账号吗？\n\n${names}\n\n他们自己创建的表格（含记录、备注、上传文件）会一并删除，且无法恢复。`,
    );
    if (!confirmed) return;

    setDeleting(true);
    try {
      const result = await api.adminDeleteUsers(targets.map((user) => user.id));
      if (result.deleted.length) {
        onToast(
          `已删除 ${result.deleted.length} 个账号${
            result.databaseCount ? `（连同 ${result.databaseCount} 张表格）` : ''
          }`,
        );
      }
      for (const item of result.skipped) {
        onToast(`${item.email || item.id}：${item.reason}`, 'error');
      }
      setSelected([]);
      await load();
    } catch (cause) {
      onToast(cause instanceof ApiError ? cause.message : '删除账号失败', 'error');
    } finally {
      setDeleting(false);
    }
  };

  const resetPassword = async (user: AdminUser) => {
    if (!window.confirm(`确定要重置「${user.name || user.email}」的密码吗？该账号所有设备都会立即下线。`)) return;
    setBusyId(user.id);
    try {
      const result = await api.adminResetUserPassword(user.id);
      setReset({ user: result.user, password: result.password, emailed: result.emailed });
      if (result.resetSelf) {
        onToast('已重置你自己的密码，请用新密码重新登录');
        onReloadSession();
      } else {
        onToast(result.emailed ? '已重置密码，新密码已发送到该用户邮箱' : '已重置密码');
      }
    } catch (cause) {
      onToast(cause instanceof ApiError ? cause.message : '重置密码失败', 'error');
    } finally {
      setBusyId('');
    }
  };

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <section className="admin-panel">
      <div className="admin-head">
        <h2 className="page-title">用户管理</h2>
        <span className="small muted">
          共 {total} 个注册账号{search ? `（匹配「${search}」）` : ''}
        </span>
        <span className="spacer" />
        <form
          className="row gap"
          onSubmit={(event) => {
            event.preventDefault();
            setOffset(0);
            setSearch(draft.trim());
          }}
        >
          <input
            className="input"
            value={draft}
            placeholder="搜索昵称或邮箱"
            onChange={(event) => setDraft(event.target.value)}
            style={{ width: 180 }}
          />
          <button className="btn" type="submit">
            搜索
          </button>
          {search ? (
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                setDraft('');
                setSearch('');
                setOffset(0);
              }}
            >
              清除
            </button>
          ) : null}
        </form>
        <button type="button" className="btn ghost small" onClick={() => void load()} disabled={loading}>
          刷新
        </button>
        <button
          type="button"
          className="btn ghost small"
          disabled={deleting || !selected.length}
          title="删除勾选的账号（连同他们创建的表格）"
          onClick={() => void deleteSelected()}
        >
          {deleting ? '删除中…' : `删除选中${selected.length ? `（${selected.length}）` : ''}`}
        </button>
      </div>

      {error ? <p className="error small">{error}</p> : null}
      {loading ? <p className="muted small">加载中…</p> : null}
      {reset ? <ResetResultCard result={reset} onClose={() => setReset(null)} /> : null}

      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th className="admin-select-col">
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  aria-label="全选可删除的账号"
                  title="全选本页可删除的账号"
                  checked={allSelected}
                  disabled={!selectable.length}
                  onChange={(event) =>
                    setSelected(event.target.checked ? selectable.map((user) => user.id) : [])
                  }
                />
              </th>
              <th>用户</th>
              <th>角色</th>
              <th>表格</th>
              <th>注册时间</th>
              <th>最近登录</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td className="admin-select-col">
                  {user.isAdmin || user.id === me?.id ? (
                    <input
                      type="checkbox"
                      disabled
                      title={user.isAdmin ? '管理员账号不能删除' : '不能删除自己的账号'}
                    />
                  ) : (
                    <input
                      type="checkbox"
                      aria-label={`选择 ${user.email}`}
                      checked={selected.includes(user.id)}
                      disabled={deleting}
                      onChange={(event) => toggleOne(user.id, event.target.checked)}
                    />
                  )}
                </td>
                <td>
                  <div className="row gap">
                    <div className="avatar small-avatar">{(user.name || user.email).slice(0, 1).toUpperCase()}</div>
                    <div style={{ minWidth: 0 }}>
                      <div className="user-name">
                        {user.name || '（未填昵称）'}
                        {user.id === me?.id ? <span className="tag accent">我</span> : null}
                      </div>
                      <div className="small muted">{user.email}</div>
                    </div>
                  </div>
                </td>
                <td>
                  {user.isAdmin ? <span className="tag accent">管理员</span> : <span className="small muted">普通用户</span>}
                </td>
                <td className="small muted">
                  拥有 {user.databaseCount} · 协作 {user.sharedCount}
                </td>
                <td className="small muted">{formatTime(user.createdAt)}</td>
                <td className="small muted">{formatTime(user.lastSeenAt)}</td>
                <td>
                  <div className="row gap">
                    <button type="button" className="btn ghost small" onClick={() => setEditing(user)}>
                      编辑
                    </button>
                    <button
                      type="button"
                      className="btn ghost small"
                      disabled={busyId === user.id}
                      onClick={() => void resetPassword(user)}
                    >
                      {busyId === user.id ? '处理中…' : '重置密码'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {!loading && users.length === 0 ? (
              <tr>
                <td colSpan={7} className="muted small">
                  没有匹配的用户
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {pages > 1 ? (
        <div className="row gap">
          <button
            type="button"
            className="btn ghost small"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            上一页
          </button>
          <span className="small muted">
            第 {page} / {pages} 页
          </span>
          <button
            type="button"
            className="btn ghost small"
            disabled={offset + PAGE_SIZE >= total}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            下一页
          </button>
        </div>
      ) : null}

      {editing ? (
        <EditUserDialog
          user={editing}
          onClose={() => setEditing(null)}
          onToast={onToast}
          onSaved={(updated) => {
            setUsers((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
            if (updated.id === me?.id) onReloadSession();
          }}
        />
      ) : null}
    </section>
  );
}

/**
 * 「系统管理」页：站点设置（站点名称 / 图标 / 管理员邮箱 / 发信）、系统规则与使用说明
 * （注册勾选的条款 + 侧边栏「?」的说明）与存储分片。
 *
 * 与「用户管理」分成两个页面（侧边栏「管理」下两条各自入口）：注册账号的日常管理
 * 与站点级配置混在一页时容易误触，分开后两页各自滚动、各自「刷新」。
 */
export function AdminSystemPanel({ onToast, onReloadSession, onBrandingChange }: AdminSystemPanelProps) {
  return (
    <section className="admin-panel">
      <div className="admin-head">
        <h2 className="page-title">系统管理</h2>
        <span className="small muted">
          站点名称 / 图标 / 管理员邮箱 / 发信设置、系统规则与使用说明，以及表格数据所在的存储分片
        </span>
      </div>

      <SiteSettingsCard
        onToast={onToast}
        onBrandingChange={onBrandingChange}
        onReloadSession={onReloadSession}
      />

      <PolicyEditorCard onToast={onToast} />

      <ShardsCard onToast={onToast} />
    </section>
  );
}
