/**
 * 「后台 → 存储分片」卡片。
 *
 * 表格数据在存储拆分之后分散在若干 D1 分片库里（见 docs/storage.md）：注册表
 * （`database_shards`）记着「有哪些分片、各自放哪一类表格、用了多少空间」，新表格
 * 会自动落到同类型里最空的那一片。库快满（默认 85%）时管理员在这里新建 / 挂载分片。
 *
 * 「新建」「挂载」「刷新用量」都要调 Cloudflare API，需要 Worker secret
 * `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`（Account > D1 > Edit）；没配时
 * 接口返回 501，卡片会把按钮禁用并说明要配什么。列表本身永远可看（注册表为空时
 * 会回退到 wrangler.jsonc 里绑定的主分片）。
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { capacityLevelOfRatio, formatBytes } from '../../shared/capacity';
import { TABLE_KINDS, tableKindLabel } from '../../shared/tableKind';
import type { AdminAccountDatabase, AdminShard, AdminShardSummary, TableKind } from '../../shared/types';
import { ApiError, api } from '../api';
import { formatDateTime } from '../lib/time';

interface ShardsCardProps {
  onToast: (message: string, kind?: 'info' | 'error') => void;
}

/** 用量告警比例：和 Worker 端 `SHARD_FILL_WARN_RATIO` 保持一致 */
const FILL_WARN_PERCENT = 85;

function countText(value: number | null): string {
  return value === null ? '—' : String(value);
}

function bytesText(value: number | null): string {
  return value === null ? '—' : formatBytes(value);
}

export function ShardsCard({ onToast }: ShardsCardProps) {
  const [shards, setShards] = useState<AdminShard[]>([]);
  const [summary, setSummary] = useState<AdminShardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  /** 正在进行的操作名（按钮上显示「处理中…」并禁用） */
  const [busy, setBusy] = useState('');
  const [kind, setKind] = useState<TableKind>('basic');
  const [newName, setNewName] = useState('');
  const [newNote, setNewNote] = useState('');
  /** 账号下的 D1 库（点「挂载已有的库」之后才有） */
  const [candidates, setCandidates] = useState<AdminAccountDatabase[] | null>(null);

  const apply = useCallback((payload: { shards: AdminShard[]; summary: AdminShardSummary }) => {
    setShards(payload.shards);
    setSummary(payload.summary);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      apply(await api.adminShards());
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '分片列表加载失败');
    } finally {
      setLoading(false);
    }
  }, [apply]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 统一的「跑一步、失败弹提示」包装 */
  const run = async (label: string, task: () => Promise<void>) => {
    setBusy(label);
    try {
      await task();
    } catch (cause) {
      onToast(cause instanceof ApiError ? cause.message : `${label}失败`, 'error');
    } finally {
      setBusy('');
    }
  };

  const createShard = (event: FormEvent) => {
    event.preventDefault();
    void run('新建', async () => {
      const payload = await api.adminCreateShard({ kind, name: newName.trim(), note: newNote.trim() });
      apply(payload);
      setNewName('');
      setNewNote('');
      onToast('已新建分片库并挂载，后续新建的表格会自动分流过去');
    });
  };

  const toggleShard = (shard: AdminShard) =>
    void run('启停', async () => {
      const payload = await api.adminUpdateShard(shard.id, { isActive: !shard.isActive });
      apply(payload);
      onToast(shard.isActive ? `已停用 ${shard.name}（不再接收新表格）` : `已启用 ${shard.name}`);
    });

  const refreshUsage = () =>
    void run('刷新用量', async () => {
      const payload = await api.adminRefreshShards();
      apply(payload);
      onToast(`已刷新 ${payload.refreshed} 个分片的用量${payload.failed ? `（${payload.failed} 个失败）` : ''}`);
    });

  const removeShard = (shard: AdminShard) => {
    const confirmed = window.confirm(
      `确定从注册表里摘掉「${shard.name}」吗？\n\nD1 库和里面的数据不会动（要删库请去 Cloudflare 控制台），但这一片上的表格会立刻读不到。`,
    );
    if (!confirmed) return;
    void run('摘除', async () => {
      apply(await api.adminRemoveShard(shard.id));
      onToast(`已摘除 ${shard.name}`);
    });
  };

  const listCandidates = () =>
    void run('列出库', async () => {
      setCandidates((await api.adminAccountDatabases()).databases);
    });

  const mountShard = (candidate: AdminAccountDatabase) =>
    void run('挂载', async () => {
      const payload = await api.adminMountShard({ databaseId: candidate.uuid, kind, name: candidate.name });
      apply(payload);
      setCandidates(null);
      onToast(`已挂载 ${candidate.name}（表结构已按分片脚本补齐）`);
    });

  const d1Ready = summary?.d1ApiConfigured ?? false;

  return (
    <>
      <div className="admin-head">
        <h2 className="page-title">存储分片</h2>
        <span className="small muted">
          {summary
            ? `${summary.shards} 个分片（启用 ${summary.activeShards}）· 表格 ${countText(summary.databases)} 张 · 记录 ${countText(summary.records)} 条 · 附件 ${bytesText(summary.fileBytes)}`
            : '加载中…'}
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="btn ghost small"
          disabled={loading || Boolean(busy)}
          onClick={() => void refreshUsage()}
        >
          {busy === '刷新用量' ? '刷新中…' : '刷新用量'}
        </button>
        <button type="button" className="btn ghost small" disabled={loading || Boolean(busy)} onClick={() => void load()}>
          重新加载
        </button>
      </div>

      {summary && summary.nearLimit > 0 ? (
        <p className="capacity-notice" role="status">
          ⚠️ 有 {summary.nearLimit} 个分片已用到 {FILL_WARN_PERCENT}% 以上（单个 D1 库上限 10GB）：
          建议先「新建」一个同类型分片，新表格会自动分流过去。
        </p>
      ) : null}

      {summary && !d1Ready ? (
        <p className="small muted">
          未配置 Cloudflare API 凭据（`CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`，需要 Account &gt; D1 &gt; Edit
          权限），所以「新建 / 挂载 / 刷新用量」不可用；表格仍按 wrangler.jsonc 里绑定的主分片正常工作。
        </p>
      ) : null}

      {error ? <p className="error small">{error}</p> : null}

      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>分片</th>
              <th>类型</th>
              <th>访问方式</th>
              <th>已用 / 上限</th>
              <th>表格 / 记录 / 附件</th>
              <th>上次读取</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {shards.map((shard) => (
              <tr key={shard.id}>
                <td>
                  <div style={{ minWidth: 0 }}>
                    <div className="user-name">
                      {shard.name}
                      {shard.transport === 'binding' ? <span className="tag accent">绑定</span> : null}
                      {shard.nearLimit ? <span className="tag">接近上限</span> : null}
                    </div>
                    <div
                      className="small muted"
                      title={shard.databaseId || '注册表为空时的兜底分片（没有 database_id）'}
                    >
                      {shard.note || shard.databaseId || '绑定兜底分片'}
                    </div>
                  </div>
                </td>
                <td className="small muted">{tableKindLabel(shard.kind)}</td>
                <td className="small muted">
                  {shard.transport === 'binding' ? `绑定 ${shard.binding ?? ''}` : 'Cloudflare HTTP'}
                </td>
                <td>
                  <div className="small muted">
                    {bytesText(shard.usedBytes)} / {formatBytes(shard.limitBytes)}
                    {shard.usedBytes === null ? '（用量未知）' : ` · ${Math.round(shard.ratio * 100)}%`}
                  </div>
                  <span className="capacity-pop-bar" style={{ width: 120 }}>
                    <span
                      className={`capacity-pop-fill ${capacityLevelOfRatio(shard.ratio)}`}
                      style={{ width: `${Math.max(2, Math.round(Math.min(1, shard.ratio) * 100))}%` }}
                    />
                  </span>
                </td>
                <td className="small muted">
                  {countText(shard.databases)} / {countText(shard.records)} / {bytesText(shard.fileBytes)}
                </td>
                <td className="small muted">{shard.checkedAt ? formatDateTime(shard.checkedAt) : '—'}</td>
                <td>{shard.isActive ? <span className="tag accent">启用</span> : <span className="small muted">已停用</span>}</td>
                <td>
                  <div className="row gap">
                    <button
                      type="button"
                      className="btn ghost small"
                      disabled={Boolean(busy)}
                      onClick={() => void toggleShard(shard)}
                    >
                      {shard.isActive ? '停用' : '启用'}
                    </button>
                    <button type="button" className="btn ghost small" disabled={Boolean(busy)} onClick={() => removeShard(shard)}>
                      摘除
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {!loading && shards.length === 0 ? (
              <tr>
                <td colSpan={8} className="muted small">
                  还没有登记任何分片：运行时会用 wrangler.jsonc 里绑定的主分片（DB_TABLES_TRIAL / DB_TABLES_BASIC / DB_TABLES_PRO）。
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <form className="row gap" onSubmit={createShard} style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label className="field">
          <span className="small muted">类型</span>
          <select className="input" value={kind} onChange={(event) => setKind(event.target.value as TableKind)}>
            {TABLE_KINDS.map((item) => (
              <option key={item} value={item}>
                {tableKindLabel(item)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="small muted">库名（可留空，自动生成）</span>
          <input
            className="input"
            value={newName}
            maxLength={60}
            placeholder="varysheet-tables-basic-20260101-abcd"
            onChange={(event) => setNewName(event.target.value)}
            style={{ width: 240 }}
          />
        </label>
        <label className="field">
          <span className="small muted">备注（可留空）</span>
          <input
            className="input"
            value={newNote}
            maxLength={200}
            placeholder="例如：基础表格第二片"
            onChange={(event) => setNewNote(event.target.value)}
            style={{ width: 180 }}
          />
        </label>
        <button className="btn primary" type="submit" disabled={!d1Ready || Boolean(busy)}>
          {busy === '新建' ? '新建中…' : '新建分片库'}
        </button>
        <button type="button" className="btn ghost" disabled={!d1Ready || Boolean(busy)} onClick={() => void listCandidates()}>
          {busy === '列出库' ? '读取中…' : '挂载已有的库'}
        </button>
      </form>

      {candidates ? (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>账号下的 D1 库</th>
                <th>大小</th>
                <th>表数</th>
                <th>创建时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((item) => (
                <tr key={item.uuid}>
                  <td>
                    <div className="user-name">{item.name}</div>
                    <div className="small muted">{item.uuid}</div>
                  </td>
                  <td className="small muted">{bytesText(item.fileSize)}</td>
                  <td className="small muted">{countText(item.numTables)}</td>
                  <td className="small muted">{item.createdAt ? item.createdAt.slice(0, 19).replace('T', ' ') : '—'}</td>
                  <td>
                    {item.mounted ? (
                      <span className="small muted">已挂载</span>
                    ) : (
                      <button
                        type="button"
                        className="btn ghost small"
                        disabled={Boolean(busy)}
                        onClick={() => void mountShard(item)}
                      >
                        挂载为{tableKindLabel(kind)}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {candidates.length === 0 ? (
                <tr>
                  <td colSpan={5} className="muted small">
                    账号下没有可用的 D1 库：先在 Cloudflare 控制台或 `wrangler d1 create` 建一个再回来挂载。
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}
