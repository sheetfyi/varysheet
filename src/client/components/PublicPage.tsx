/**
 * Read-only (or editable, when the share link allows it) public view of a
 * database. Reached through `/share/:token`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FIELD_META, cellLockHint, cellLockKey, isEmptyValue, sameCellValue } from '../../shared/fields';
import { capacityBlockedHint, capacityTooltip } from '../../shared/capacity';
import { slotExpiredHint } from '../../shared/quota';
import type { CellValue, DatabaseChanges, Property, PublicDatabaseResponse, RowRecord } from '../../shared/types';
import { ApiError, publicApi } from '../api';
import { useCellEditLocks } from '../lib/cellEditLocks';
import { applyView, visibleProperties } from '../lib/viewEngine';
import { CellEditor, CellView, useCloseOnOutsideClick, type UserNames } from './Cell';

/** 增量同步间隔：别人改的格子 / 新建、删除的记录，不刷新页面也会出现在这里 */
const LIVE_SYNC_POLL_MS = 5_000;

interface PublicPageProps {
  token: string;
}

export function PublicPage({ token }: PublicPageProps) {
  const [payload, setPayload] = useState<PublicDatabaseResponse | null>(null);
  const [rows, setRows] = useState<RowRecord[]>([]);
  const [error, setError] = useState('');
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ rowId: string; propertyId: string } | null>(null);
  /**
   * 单元格级「限制编辑」的判定器。只有创建链接时勾选了「限制编辑」才有内容：
   * 输入次数不限，但每次保存后要等 10 秒这一格才会锁上（计时窗口，窗口内想改多少遍
   * 都行，每次保存重新计时）；窗口一到、并且这一格仍有内容时就只能查看。
   */
  const cellGuard = useCellEditLocks();

  // 点击单元格以外的任意位置即退出输入（日期 / 文件字段自动保存，没有「确认」按钮）
  useCloseOnOutsideClick(editing !== null, () => setEditing(null));

  /**
   * 本地最新的一批行（增量合并基于它）与增量同步游标（看过的最大改动版本号）。
   */
  const rowsRef = useRef<RowRecord[]>([]);
  const revRef = useRef(0);
  /** 正在飞的本地写请求数：> 0 时轮询先不动本地数据 */
  const pendingWrites = useRef(0);

  /** 整表加载（首次打开、以及服务端说增量已不可靠时） */
  const loadAll = useCallback(async () => {
    const data = await publicApi.database(token, { limit: 200 });
    setPayload(data);
    setRows(data.rows);
    cellGuard.reset(data);
    setActiveViewId(data.views[0]?.id ?? null);
    revRef.current = data.rev ?? 0;
    setError('');
  }, [cellGuard, token]);

  useEffect(() => {
    let cancelled = false;
    loadAll().catch((cause) => {
      if (!cancelled) setError(cause instanceof ApiError ? cause.message : '分享链接无效或已过期');
    });
    return () => {
      cancelled = true;
    };
  }, [loadAll]);

  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  /** 把一轮增量改动合进本地状态：改过的行就地更新、被删掉的行移除、总数跟着变 */
  const applyChanges = useCallback((changes: DatabaseChanges) => {
    const gone = new Set(changes.deleted);
    if (gone.size) {
      setEditing((prev) => (prev && gone.has(prev.rowId) ? null : prev));
      setRows((prev) => prev.filter((row) => !gone.has(row.id)));
    }
    if (changes.rows.length) {
      const byId = new Map(rowsRef.current.map((row) => [row.id, row]));
      for (const record of changes.rows) byId.set(record.id, record);
      setRows([...byId.values()].sort((a, b) => a.position - b.position));
    }
    // 别的访客锁上的格子 / 刚改过、还在 10 秒计时窗口内的格子
    cellGuard.merge(changes);
    setPayload((prev) => (prev ? { ...prev, total: changes.total } : prev));
  }, [cellGuard]);

  /**
   * 增量同步：每隔几秒问一次服务端「比我看过的版本号新的是什么」。
   * 表格协作者（或同一条链接的其他访客）改完单元格，这边不刷新页面就能看到。
   */
  useEffect(() => {
    let cancelled = false;
    let running = false;

    const tick = async () => {
      if (cancelled || running) return;
      if (document.visibilityState !== 'visible') return;
      if (pendingWrites.current > 0) return;
      running = true;
      try {
        const changes = await publicApi.changes(token, revRef.current);
        if (cancelled) return;
        if (changes.reset) {
          await loadAll();
          return;
        }
        if (pendingWrites.current > 0) return;
        revRef.current = changes.rev;
        applyChanges(changes);
      } catch {
        // 网络抖动：下一轮再试
      } finally {
        running = false;
      }
    };

    const timer = window.setInterval(() => void tick(), LIVE_SYNC_POLL_MS);
    const wake = () => void tick();
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', wake);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', wake);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [applyChanges, loadAll, token]);

  const permission = payload?.database.permission ?? 'view';
  const canEdit = permission === 'edit';
  /** 创建链接时勾选了「限制编辑」：输入不限次数，保存后 10 秒这一格才锁上 */
  const limitEdits = payload?.database.limitEdits === true;
  const properties = payload?.properties ?? [];
  const activeView = useMemo(
    () => payload?.views.find((view) => view.id === activeViewId) ?? payload?.views[0] ?? null,
    [payload, activeViewId],
  );
  const columns = activeView ? visibleProperties(properties, activeView.config) : properties;
  /** 公开链接里没有登录用户，「当前用户」= 表格所有者 */
  const filterContext = useMemo(() => ({ viewerId: payload?.database.ownerId ?? null }), [payload]);
  /** 行元数据里的用户 id → 显示名（公开链接里也能看到「创建人」） */
  const users = useMemo<UserNames>(() => {
    const map: UserNames = { ...(payload?.people ?? {}) };
    const owner = payload?.database;
    if (owner && !map[owner.ownerId]) map[owner.ownerId] = owner.ownerName || '表格所有者';
    return map;
  }, [payload]);
  const filtered = useMemo(
    () => (activeView ? applyView(properties, rows, activeView.config, filterContext) : rows),
    [properties, rows, activeView, filterContext],
  );

  /** 标记一次本地写请求（返回的 release 必须调用）：写入在飞时轮询先不合并远端改动 */
  const beginWrite = useCallback(() => {
    pendingWrites.current += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      pendingWrites.current = Math.max(0, pendingWrites.current - 1);
    };
  }, []);

  const commitCell = useCallback(
    async (row: RowRecord, property: Property, value: CellValue | undefined) => {
      if (!canEdit) return;
      const cellKey = cellLockKey(row.id, property.id);
      // 勾选了「限制编辑」的链接：保存过、10 秒计时窗口已过且这一格仍有内容就只读，
      // 这里再挡一次（例如在另一个标签页里改过）
      if (cellGuard.isSpent(row.id, property.id)) {
        setError(cellLockHint(property.name));
        return;
      }
      // 值没变就不发请求（与服务端的判断保持一致）
      if (sameCellValue(row.values[property.id], value)) return;
      const release = beginWrite();
      setRows((prev) =>
        prev.map((item) => {
          if (item.id !== row.id) return item;
          const values = { ...item.values };
          if (value === undefined) delete values[property.id];
          else values[property.id] = value;
          return { ...item, values };
        }),
      );
      try {
        const result = await publicApi.updateRecord(token, row.id, { [property.id]: value ?? null });
        if (result.record) {
          setRows((prev) => prev.map((item) => (item.id === result.record!.id ? result.record! : item)));
        }
        if (limitEdits) {
          if (isEmptyValue(value)) {
            // 清空 = 没输入过：本地把这一格的计时窗口 / 只读状态一起撤销
            cellGuard.clearCells(cellKey);
          } else {
            // 服务端下发的窗口截止时刻是权威值；本地也立刻记上，好让 10 秒倒计时马上开始
            cellGuard.merge(result);
            cellGuard.markEdited(cellKey);
          }
        }
      } catch (cause) {
        setError(cause instanceof ApiError ? cause.message : '保存失败');
        setRows((prev) => prev.map((item) => (item.id === row.id ? row : item)));
      } finally {
        release();
      }
    },
    [beginWrite, canEdit, cellGuard, limitEdits, token],
  );

  const createRow = useCallback(async () => {
    if (!canEdit) return;
    // 到期未续费（基础 / 专业表格）：这张表只能查看和编辑，不能再新增记录
    const expiredHintNow = payload?.database.slotExpired
      ? slotExpiredHint(payload.database.capacity?.kind, payload.database.slotExpiresAt)
      : '';
    if (expiredHintNow) {
      setError(expiredHintNow);
      return;
    }
    // 容量到上限后只拦增长：本地先给一句人话，服务端也会用 403 capacity_exceeded 挡下
    const hint = payload?.database.capacity ? capacityBlockedHint(payload.database.capacity) : '';
    if (hint) {
      setError(hint);
      return;
    }
    const release = beginWrite();
    try {
      const result = await publicApi.createRecord(token, {});
      if (result.record) setRows((prev) => [...prev, result.record!]);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '新建失败');
    } finally {
      release();
    }
  }, [beginWrite, canEdit, payload, token]);

  const deleteRow = useCallback(
    async (row: RowRecord) => {
      if (!canEdit) return;
      const release = beginWrite();
      try {
        await publicApi.deleteRecord(token, row.id);
        setRows((prev) => prev.filter((item) => item.id !== row.id));
      } catch (cause) {
        setError(cause instanceof ApiError ? cause.message : '删除失败');
      } finally {
        release();
      }
    },
    [beginWrite, canEdit, token],
  );


  if (error && !payload) {
    return (
      <div className="centered">
        <div className="empty-state">
          <h2>无法打开分享链接</h2>
          <p className="error">{error}</p>
        </div>
      </div>
    );
  }

  if (!payload) {
    return (
      <div className="centered">
        <p className="muted">正在载入…</p>
      </div>
    );
  }

  // 容量到上限（记录数或附件）/ 到期未续费：这张表只剩「查看和编辑」了
  const capacity = payload.database.capacity;
  const capacityHint = capacity ? capacityBlockedHint(capacity) : '';
  const capacityTip = capacity ? capacityTooltip(capacity) : '';
  const expiredHint = payload.database.slotExpired
    ? slotExpiredHint(capacity?.kind, payload.database.slotExpiresAt)
    : '';

  return (
    <div className="public-page">
      <header className="topbar">
        <span className="icon-input readonly">{payload.database.icon || '📋'}</span>
        <span className="title-static">{payload.database.name}</span>
        <span className={`badge ${canEdit ? 'role-editor' : 'role-viewer'}`}>{canEdit ? '可编辑' : '只读'}</span>
        <span className="spacer" />
        <span className="small muted">
          {filtered.length} / {payload.total} 条记录
        </span>
      </header>

      {payload.database.description ? <p className="muted small share-desc">{payload.database.description}</p> : null}
      {canEdit && limitEdits ? (
        <p className="muted small share-desc">该链接已开启「限制编辑」：输入不限次数，但每次保存后 10 秒内还能继续修改，之后该格子只能查看（把内容清空则视为没有输入，不受限制）。</p>
      ) : null}
      {error ? <p className="error small share-desc">{error}</p> : null}
      {expiredHint ? (
        <p className="capacity-notice" role="status">
          ⏳ {expiredHint}
        </p>
      ) : null}
      {capacityHint ? (
        <p className="capacity-notice" role="status" title={capacityTip}>
          ⛔ {capacityHint}
        </p>
      ) : null}

      {payload.views.length > 1 ? (
        <div className="viewbar">
          {payload.views.map((view) => (
            <button
              key={view.id}
              type="button"
              className={`tab${view.id === (activeView?.id ?? '') ? ' active' : ''}`}
              onClick={() => setActiveViewId(view.id)}
            >
              {view.name}
            </button>
          ))}
        </div>
      ) : null}

      <div className="grid-wrap">
        {canEdit ? (
          <div className="grid-toolbar">
            <button
              type="button"
              className="btn primary small"
              onClick={() => void createRow()}
              disabled={Boolean(capacity?.atCapacity || expiredHint)}
              title={expiredHint || capacityHint || undefined}
            >
              ＋ 新建记录
            </button>
          </div>
        ) : null}

        <table className="grid">
          <thead>
            <tr>
              {columns.map((property) => (
                <th key={property.id}>
                  <div className="head">
                    <span className="name" title={FIELD_META[property.type].label}>
                      {property.name}
                    </span>
                  </div>
                </th>
              ))}
              {canEdit ? <th className="add-col" /> : null}
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => (
              <tr key={row.id}>
                {columns.map((property) => {
                  const isEditing = editing?.rowId === row.id && editing.propertyId === property.id;
                  const editable = canEdit && !FIELD_META[property.type].computed && !property.locked;
                  return (
                    <td
                      key={property.id}
                      className="cell cell-view-cell row-height-short"
                      data-editing-cell={isEditing ? 'true' : undefined}
                    >
                      {isEditing ? (
                        <CellEditor
                          property={property}
                          value={row.values[property.id]}
                          onCommit={(value) => {
                            setEditing(null);
                            void commitCell(row, property, value);
                          }}
                          onAutoSave={(value) => void commitCell(row, property, value)}
                          onCancel={() => setEditing(null)}
                        />
                      ) : (
                        <CellView
                          property={property}
                          row={row}
                          users={users}
                          editable={editable}
                          spent={cellGuard.isSpent(row.id, property.id)}
                          graceMsLeft={cellGuard.graceLeftMs(row.id, property.id)}
                          onEdit={() => setEditing({ rowId: row.id, propertyId: property.id })}
                          onQuickChange={(value) => void commitCell(row, property, value)}
                        />
                      )}
                    </td>
                  );
                })}
                {canEdit ? (
                  <td className="cell">
                    <button type="button" className="icon-btn" title="删除记录" onClick={() => void deleteRow(row)}>
                      🗑
                    </button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>

        {!filtered.length ? (
          <div className="empty-state">
            <p>还没有记录</p>
            {canEdit ? (
              <button type="button" className="btn primary" onClick={() => void createRow()}>
                创建第一条记录
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
