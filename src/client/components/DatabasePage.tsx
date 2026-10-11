/**
 * The database workspace: header (rename / share), view tabs, and the active
 * view body (table / board / gallery). Owns every mutation for one database.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createId, cellLockHint, cellLockKey, defaultFilterValueForType, defaultOperatorForType, isEmptyValue, sameCellValue } from '../../shared/fields';
import type {
  CellValue,
  DatabaseChanges,
  DatabaseDetail,
  FieldType,
  FileValue,
  Property,
  PropertyConfig,
  RecordNote,
  Role,
  RowRecord,
  SessionUser,
  ViewConfig,
  ViewDef,
  ViewShare,
} from '../../shared/types';
import { defaultViewConfig } from '../../shared/views';
import { conditionConjunction, groupFilterConditions, type Conjunction } from '../../shared/viewFilter';
import { capacityBlockedHint, capacityTooltip } from '../../shared/capacity';
import { slotExpiredHint } from '../../shared/quota';
import { tableKindCapacityText, tableKindMeta } from '../../shared/tableKind';
import { ApiError, api } from '../api';
import { useCellEditLocks } from '../lib/cellEditLocks';
import { applyView, groupRows, visibleProperties } from '../lib/viewEngine';
import { BoardView, GalleryView } from './CardViews';
import type { UserNames } from './Cell';
import { FilterPanel } from './FilterPanel';
import { Popover } from './Popover';
import { PropertyDialog } from './PropertyDialog';
import { RecordDialog } from './RecordDialog';
import { SharePanel } from './SharePanel';
import { TableGrid } from './TableGrid';
import { ViewBar, type NewViewInput } from './ViewBar';

const PAGE_SIZE = 100;
/** 记录卡片开着时的同步间隔：别人的备注 / 改动会自己出现在卡片上（单条记录接口，很轻） */
const OPEN_ROW_POLL_MS = 20_000;
/**
 * 表格的增量同步间隔（多人协作）：带着自己看过的版本号去问「比这新的改动有哪些」，
 * 别人改完单元格几秒内就会出现在这里，不用刷新页面。没有改动时接口只回一个版本号，
 * 很轻，所以可以比卡片同步更频繁一些。
 */
const LIVE_SYNC_POLL_MS = 5_000;
/** 别人改过的格子高亮多久（与 styles.css 里 cell-flash 动画的时长一致） */
const FLASH_MS = 1_800;

export type ToastFn = (message: string, kind?: 'info' | 'error') => void;

const ROLE_LABEL: Record<Role, string> = { owner: '所有者', editor: '可编辑', viewer: '可查看' };

interface DatabasePageProps {
  database: DatabaseDetail;
  me: SessionUser | null;
  onToast: ToastFn;
  /** refresh the sidebar after renames / deletes */
  onReloadList: () => void;
  /**
   * 从收件箱点开私信时带过来的位置：打开这条记录卡片并定位到那条备注。
   * 由本组件消费后调用 `onInboxTargetHandled` 清空（避免重复打开）。
   */
  inboxTarget?: { recordId: string; noteId: string } | null;
  onInboxTargetHandled: () => void;
  /** called after the database itself was deleted */
  onClose: () => void;
}

type PropertyDialogState = { mode: 'create'; afterId: string | null } | { mode: 'edit'; property: Property } | null;

export function DatabasePage({
  database,
  me,
  onToast,
  onReloadList,
  inboxTarget,
  onInboxTargetHandled,
  onClose,
}: DatabasePageProps) {
  const [detail, setDetail] = useState<DatabaseDetail>(database);
  const [rows, setRows] = useState<RowRecord[]>(database.rows);
  const [total, setTotal] = useState(database.total);
  const [hasMore, setHasMore] = useState(database.hasMore);
  const [activeViewId, setActiveViewId] = useState<string | null>(database.views[0]?.id ?? null);
  const [propertyDialog, setPropertyDialog] = useState<PropertyDialogState>(null);
  const [openRowId, setOpenRowId] = useState<string | null>(null);
  /** 从私信点进来时要定位（滚动 + 高亮）的备注 id */
  const [focusNoteId, setFocusNoteId] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareViewId, setShareViewId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState(database.name);
  const [loadingMore, setLoadingMore] = useState(false);
  /** 已经按顺序从服务端读过的行数：下一页从它往后取（本地增量合并进来的行不算，避免游标偏移） */
  const loadedCountRef = useRef(database.rows.length);
  /** 「加载更多」请求正在路上：state 更新是异步的，用它拦住同一帧里的重复触发 */
  const loadingMoreRef = useRef(false);
  /**
   * 单元格级「限制编辑」的判定器：只有分享时勾选了「限制编辑」的访问者才有内容 ——
   * 输入次数不限，但每次保存成功后要等 10 秒这一格才锁上（计时窗口，见
   * `CELL_EDIT_GRACE_MS`）；窗口内把内容清空等于没输入过。表格所有者 / 表格成员 /
   * 未勾选「限制编辑」的分享永远是空。
   */
  const cellGuard = useCellEditLocks(database);
  /**
   * 别人的改动刚落到本地、需要闪一下的格子（`记录 id:字段 id`）：
   * 让人一眼看出「哪一格有新数据」，FLASH_MS 之后自动清空。
   */
  const [flashCells, setFlashCells] = useState<ReadonlySet<string>>(() => new Set());
  /**
   * 增量同步游标：本地看过的最大改动版本号。第一次打开表格时取服务端下发的 `rev`，
   * 之后每次同步都推进到服务端返回的新版本号（请求时带 `?since=<rev>`）。
   */
  const revRef = useRef(database.rev ?? 0);
  /** 正在飞的本地写请求数：> 0 时轮询先不动本地数据，免得把刚改的值顶回去 */
  const pendingWrites = useRef(0);
  /** 高亮清理定时器（组件卸载时要清掉） */
  const flashTimer = useRef<number | null>(null);
  /**
   * 表格视图里勾选的记录 id。状态提到这里是因为批量操作栏（已选 N 条 / 复制 / 删除 /
   * 取消选择）显示在「＋ 新建筛选」后面，而不是表格上方。
   */
  const [selectedRowIds, setSelectedRowIds] = useState<string[]>([]);

  /**
   * `cellGuard.reset` 的引用是稳定的（内部只 setState），但整个 guard 对象的引用会随
   * 「10 秒计时窗口」变化而变。整表重置的 effect 因此只依赖 `database`：否则 guard 一抖，
   * 这里就会拿服务端首屏把本地已经加载进来的下一页顶掉（分页游标也跟着退回第一页）。
   */
  const resetCellGuard = cellGuard.reset;

  useEffect(() => {
    setDetail(database);
    setRows(database.rows);
    setTotal(database.total);
    setHasMore(database.hasMore);
    // 换表 / 整页重载：分页游标跟着服务端刚下发的第一页走
    loadedCountRef.current = database.rows.length;
    loadingMoreRef.current = false;
    resetCellGuard(database);
    setNameDraft(database.name);
    setSelectedRowIds([]);
    setFlashCells(new Set());
    // 换了一张表格 / 整个页面重新加载：增量同步的游标回到服务端刚下发的版本号
    revRef.current = database.rev ?? 0;
    setActiveViewId((prev) =>
      prev && database.views.some((view) => view.id === prev) ? prev : database.views[0]?.id ?? null,
    );
  }, [database, resetCellGuard]);

  const { properties, views, members } = detail;
  const role: Role = detail.role;
  /** 表格类型（基础 / 专业）：列数、视图数与容量上限都按它取 */
  const kindMeta = tableKindMeta(detail.kind);
  const canEdit = role === 'owner' || role === 'editor';
  const isOwner = role === 'owner';
  /** 仅通过视图定向分享获得的访问权（只能看到被分享的视图） */
  const viewScoped = detail.viewScoped;
  /** 字段 / 视图结构是否可改：只看访问权（表级锁定功能已移除） */
  const canEditStructure = canEdit && !viewScoped;
  /**
   * 列数 / 视图数到上限：把「＋」置灰并给一句人话（服务端同样会 403 `limit_exceeded`
   * 兜底）。只拦新增 —— 已超限的老表仍然能删字段 / 删视图把自己收拾回上限以内。
   *
   * 「＋ 新建视图」的三道闸（与服务端一一对应）：视图数上限、容量到上限、表格到期未续费。
   */
  const expiredHint = detail.slotExpired ? slotExpiredHint(detail.kind, detail.slotExpiresAt) : '';
  const viewLimitHint = `${kindMeta.label}最多 ${kindMeta.maxViews} 个视图（当前 ${views.length} 个）：删掉一些视图后再添加，或换成专业表格`;
  const canAddView =
    views.length < kindMeta.maxViews && !detail.slotExpired && !detail.capacity?.atCapacity;
  const addViewHint = detail.slotExpired
    ? expiredHint
    : detail.capacity?.atCapacity
      ? capacityBlockedHint(detail.capacity)
      : viewLimitHint;

  /**
   * 容量到上限后**只拦增长**：新建记录 / 复制记录 / 上传附件之前先在本地挡一下
   * （给一句人话，省掉一次必然失败的请求）；服务端同样会用 403 `capacity_exceeded`
   * 兜底，所以这里不是唯一防线。编辑、查询、删除已有记录都不受影响。
   */
  const blockedByCapacity = (): boolean => {
    const hint = detail.capacity ? capacityBlockedHint(detail.capacity) : '';
    if (!hint) return false;
    onToast(hint, 'error');
    return true;
  };

  /**
   * 表格到期未续费同样**只拦增长**：不能再新建 / 复制记录（服务端 403 `slot_expired` 兜底）。
   * 查看、编辑、删除、分享、导出照常 —— 数据都是用户自己的，不能因为到期就锁住。
   */
  const blockedByExpiry = (): boolean => {
    if (!expiredHint) return false;
    onToast(expiredHint, 'error');
    return true;
  };

  const users = useMemo<UserNames>(() => {
    // 行元数据（创建人 / 最后编辑人）里的用户可能只是被定向分享的访客，不在成员列表中
    const map: UserNames = { ...detail.people };
    for (const member of members) map[member.userId] = member.name || member.email;
    if (me) map[me.id] = me.name || me.email;
    return map;
  }, [detail.people, members, me]);

  const activeView: ViewDef | null = views.find((view) => view.id === activeViewId) ?? views[0] ?? null;
  /** 当前视图可改名 / 改配置 / 删除 */
  const viewEditable = canEditStructure && !!activeView && !activeView.locked;
  const filterCount = activeView?.config.filters?.conditions.length ?? 0;
  /**
   * 「＋ 新建筛选」后面的汇总文案：几个条件、几个「必须满足」块、块内几条「任意满足」。
   * 块与块之间是「且」，块里是「或」（命中任意一条即可），所以块数 + 任意满足条数 = 条件数。
   */
  const filterSummary = useMemo(() => {
    const filters = activeView?.config.filters;
    const conditions = filters?.conditions ?? [];
    if (!conditions.length) return '';
    const fallback: Conjunction = filters?.conjunction === 'or' ? 'or' : 'and';
    const blockCount = groupFilterConditions(conditions, fallback).length;
    const orCount = conditions.length - blockCount;
    if (!orCount) return `${conditions.length} 个条件（必须全部满足）`;
    return `${conditions.length} 个条件（${blockCount} 块必须满足 + 任意满足 ${orCount}）`;
  }, [activeView]);
  const shownProperties = activeView ? visibleProperties(properties, activeView.config) : properties;
  /** 筛选上下文：把「当前用户」解析为登录用户 */
  const filterContext = useMemo(() => ({ viewerId: me?.id ?? null }), [me]);
  const filtered = useMemo(
    () => (activeView ? applyView(properties, rows, activeView.config, filterContext) : rows),
    [properties, rows, activeView, filterContext],
  );
  /** 当前视图（应用筛选后）里被勾选的记录：供「＋ 新建筛选」后面的批量操作栏使用 */
  const selectedRows = useMemo(
    () => filtered.filter((row) => selectedRowIds.includes(row.id)),
    [filtered, selectedRowIds],
  );
  const groups = useMemo(
    () => (activeView ? groupRows(properties, filtered, activeView.config) : []),
    [properties, filtered, activeView],
  );
  const openRow = openRowId ? rows.find((row) => row.id === openRowId) ?? null : null;

  const fail = useCallback(
    (cause: unknown, fallback: string) => {
      onToast(cause instanceof ApiError ? cause.message : fallback, 'error');
    },
    [onToast],
  );

  /** Re-fetch the first page (used after structural changes). */
  const reload = useCallback(async () => {
    try {
      const next = await api.getDatabase(detail.id, { limit: PAGE_SIZE });
      setDetail(next);
      setRows(next.rows);
      setTotal(next.total);
      setHasMore(next.hasMore);
      loadedCountRef.current = next.rows.length;
      cellGuard.merge(next);
      // 整表重载后游标跟着新数据走（服务端是先给版本号再给数据，所以不会漏改动）
      revRef.current = next.rev ?? 0;
    } catch (cause) {
      fail(cause, '刷新失败');
    }
  }, [cellGuard, detail.id, fail]);

  const replaceRow = useCallback((record: RowRecord) => {
    setRows((prev) => {
      const exists = prev.some((row) => row.id === record.id);
      const next = exists ? prev.map((row) => (row.id === record.id ? record : row)) : [...prev, record];
      return next.sort((a, b) => a.position - b.position);
    });
  }, []);

  /* --------------------------------------------------------------- notes */

  /**
   * 备注里可以 @ 的人：服务端下发的可 @ 名单（所有者 + 成员 + 定向分享的访客）去掉自己
   * （自己不需要给自己发私信）。用服务端名单而不是本地 members，
   * 这样被定向分享的访客既能被 @、也能 @ 别人。
   */
  const mentionCandidates = useMemo(
    () => detail.mentionables.filter((member) => member.userId !== me?.id),
    [detail.mentionables, me],
  );

  /** 把服务端返回的备注并进本地状态（服务端返回的是按记录分组的完整备注列表） */
  const mergeNotes = useCallback((incoming: RecordNote[]) => {
    if (!incoming.length) return;
    setDetail((prev) => {
      const byRecord = new Map<string, RecordNote[]>();
      for (const note of incoming) {
        const list = byRecord.get(note.recordId) ?? [];
        list.push(note);
        byRecord.set(note.recordId, list);
      }
      return {
        ...prev,
        notes: [...prev.notes.filter((note) => !byRecord.has(note.recordId)), ...incoming],
      };
    });
  }, []);

  /**
   * 拉一条记录的最新状态（记录值 + 这条记录上的备注 + 已经用掉的格子）并合进本地缓存。
   *
   * 记录卡片打开 / 卡片开着时的定时刷新都走这里：只取一条记录，
   * 比整表分页轻得多，也不受「这条记录不在当前这一页」的限制。
   * 返回 false 表示这条记录已经被删除（或者已经没有访问权了）。
   */
  const syncRecord = useCallback(
    async (recordId: string): Promise<boolean> => {
      try {
        const fresh = await api.syncRecord(recordId);
        replaceRow(fresh.record);
        mergeNotes(fresh.notes);
        cellGuard.merge(fresh);
        return true;
      } catch (cause) {
        if (cause instanceof ApiError && cause.status === 404) return false;
        throw cause;
      }
    },
    [cellGuard, mergeNotes, replaceRow],
  );

  /**
   * 打开记录卡片：先用本地数据立刻渲染，再同步一次最新内容。
   * 这样别人刚加的备注 / 刚改的单元格不刷新页面也能看到（本地还没有这条记录时会被补进来）。
   */
  const openRecord = useCallback(
    (recordId: string) => {
      setOpenRowId(recordId);
      void syncRecord(recordId).catch(() => undefined);
    },
    [syncRecord],
  );

  /** 添加备注（只能新增，不能修改 / 删除）；@ 到的人会收到私信 */
  const addNote = async (row: RowRecord, body: string, mentions: string[]) => {
    const release = beginWrite();
    try {
      const result = await api.addNote(row.id, { body, mentions });
      mergeNotes(result.notes);
      const names = mentionCandidates
        .filter((member) => mentions.includes(member.userId))
        .map((member) => member.name || member.email);
      onToast(names.length ? `备注已添加，已提醒 ${names.join('、')}` : '备注已添加');
    } catch (cause) {
      fail(cause, '备注添加失败');
      // 抛回输入框：保留草稿并把错误显示在输入框旁边
      throw cause;
    } finally {
      release();
    }
  };

  /**
   * 收件箱私信：**先**把这条记录同步到最新，再打开记录卡片并定位到那条备注。
   *
   * 私信说的是「刚刚有人 @ 了你」，本地缓存里很可能还没有那条备注（卡片是打开表格时的
   * 快照），所以这里不能因为「记录已经在 rows 里」就直接打开——否则红点跳了、卡片内容
   * 还是旧的。同步只取这一条记录，不受分页限制（记录不在当前页也能打开）。
   */
  useEffect(() => {
    if (!inboxTarget) return;
    const { recordId, noteId } = inboxTarget;
    const locate = () => {
      setOpenRowId(recordId);
      setFocusNoteId(noteId);
      onInboxTargetHandled();
    };

    let cancelled = false;
    void syncRecord(recordId)
      .then((found) => {
        if (cancelled) return;
        locate();
        if (!found) onToast('这条私信对应的记录已被删除', 'error');
      })
      .catch((cause) => {
        if (cancelled) return;
        // 网络抖动时退回本地数据：至少把卡片打开，别让用户点了没反应
        locate();
        fail(cause, '同步这条私信的最新内容失败');
      });
    return () => {
      cancelled = true;
    };
  }, [inboxTarget, syncRecord, fail, onInboxTargetHandled, onToast]);

  /**
   * 记录卡片开着的时候定时同步 + 切回标签页时同步一次：
   * 别人在备注里 @ 你、或者改了这行数据，卡片内容会自己跟上，不用手动刷新。
   */
  useEffect(() => {
    if (!openRowId) return;
    const sync = () => {
      void syncRecord(openRowId).catch(() => undefined);
    };
    const timer = window.setInterval(sync, OPEN_ROW_POLL_MS);
    window.addEventListener('focus', sync);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', sync);
    };
  }, [openRowId, syncRecord]);

  /* ------------------------------------------------- live sync（协作同步） */

  /** 本地最新的一批行：增量合并时用它算「哪些格子变了」（不在 setState 里做副作用） */
  const rowsRef = useRef(rows);
  /** openRowId 的镜像：轮询回调里用它判断「打开着的记录是不是被别人删了」 */
  const openRowRef = useRef<string | null>(null);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);
  useEffect(() => {
    openRowRef.current = openRowId;
  }, [openRowId]);

  /**
   * 标记一次本地写请求（返回的 release 必须调用）。
   * 有写入在飞的时候轮询先跳过本地合并，免得把用户刚改的值顶回成旧值 ——
   * 写入结束后服务端自己也会记一条改动，下一轮同步自然会把权威值取回来。
   */
  const beginWrite = useCallback(() => {
    pendingWrites.current += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      pendingWrites.current = Math.max(0, pendingWrites.current - 1);
    };
  }, []);

  /** 别人改过的格子闪一下（同一格的连续改动只闪一次，够用了） */
  const flash = useCallback((keys: string[]) => {
    if (!keys.length) return;
    setFlashCells((prev) => {
      const next = new Set(prev);
      for (const key of keys) next.add(key);
      return next;
    });
    if (flashTimer.current) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => {
      setFlashCells(new Set());
      flashTimer.current = null;
    }, FLASH_MS);
  }, []);

  /** 卸载时清掉高亮定时器 */
  useEffect(
    () => () => {
      if (flashTimer.current) window.clearTimeout(flashTimer.current);
    },
    [],
  );


  /**
   * 把一轮增量改动合进本地状态：
   * 改过的行就地更新（并高亮真正变了的格子）、被删掉的行移除、
   * 新备注合并、顺带更新「限制编辑」用掉的格子和记录总数。
   */
  const applyChanges = useCallback(
    (changes: DatabaseChanges) => {
      const gone = new Set(changes.deleted);
      if (gone.size) {
        // 打开着的记录被别人删了：关掉卡片并说明一下
        if (openRowRef.current && gone.has(openRowRef.current)) {
          setOpenRowId(null);
          onToast('这条记录已被其他人删除');
        }
        setSelectedRowIds((prev) => prev.filter((id) => !gone.has(id)));
        setDetail((prev) => ({ ...prev, notes: prev.notes.filter((note) => !gone.has(note.recordId)) }));
      }

      if (gone.size || changes.rows.length) {
        // 一份合并结果同时处理「改过的行」与「删掉的行」，本地行缓存一次更新到位
        const byId = new Map(rowsRef.current.filter((row) => !gone.has(row.id)).map((row) => [row.id, row]));
        const changed: string[] = [];
        for (const record of changes.rows) {
          const before = byId.get(record.id);
          if (before) {
            // 只高亮真正变了的格子：值不同，或者原来的值被清空了
            for (const [propertyId, value] of Object.entries(record.values)) {
              if (!sameCellValue(before.values[propertyId], value)) {
                changed.push(cellLockKey(record.id, propertyId));
              }
            }
            for (const propertyId of Object.keys(before.values)) {
              if (!(propertyId in record.values)) changed.push(cellLockKey(record.id, propertyId));
            }
          }
          byId.set(record.id, record);
        }
        const next = [...byId.values()].sort((a, b) => a.position - b.position);
        rowsRef.current = next;
        setRows(next);
        if (changed.length) flash(changed);
      }

      // 别人的改动可能带来本地还没见过的用户（创建人 / 最后编辑人）
      if (Object.keys(changes.people).length) {
        setDetail((prev) => ({ ...prev, people: { ...prev.people, ...changes.people } }));
      }
      mergeNotes(changes.notes);
      // 别的访客锁上的格子 / 刚改过、还在 10 秒计时窗口内的格子
      cellGuard.merge(changes);
      setTotal(changes.total);
      setHasMore(loadedCountRef.current < changes.total);
    },
    [cellGuard, flash, mergeNotes, onToast],
  );

  /**
   * 增量同步：每隔几秒问一次服务端「比我看过的版本号新的是什么」
   * （改过的行 / 删掉的行 / 新备注），把别人的改动合进本地状态 ——
   * 所以另一个用户改完单元格，这边不刷新页面就能看到，变了的格子还会闪一下。
   *
   * - 标签页在后台、或者本地正在写入时先跳过，切回来（focus / visibilitychange）立刻补一次；
   * - 服务端回 `reset`（改动太多 / 日志已被清理）时整表重载一次，
   *   游标由 `reload()` 里的新数据接管。
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
        const changes = await api.changes(detail.id, revRef.current);
        if (cancelled) return;
        if (changes.reset) {
          await reload();
          return;
        }
        // 请求期间本地又开始写了：这一轮不改本地数据，也不推进游标
        if (pendingWrites.current > 0) return;
        revRef.current = changes.rev;
        applyChanges(changes);
      } catch {
        // 网络抖动：下一轮再试，不影响本地编辑
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
  }, [applyChanges, detail.id, reload]);


  /* ------------------------------------------------------------------- rows */

  /**
   * 取下一页（滚动到底时由 LoadMore 自动触发，见 components/LoadMore.tsx）。
   * 游标用 `loadedCountRef`（已经按顺序读过的服务端行数）而不是本地 `rows.length`：
   * 增量同步会把别人改过 / 新建的行合并进本地，行数比「读过的行数」多，
   * 直接拿它当 offset 会跳过中间还没读过的记录。
   */
  const loadMore = useCallback(async (): Promise<boolean> => {
    // 已经在飞 / 没有下一页：当作「不用再取」处理，哨兵不会因此进入失败退避
    if (loadingMoreRef.current || !hasMore) return true;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const page = await api.rows(detail.id, { limit: PAGE_SIZE, offset: loadedCountRef.current });
      loadedCountRef.current += page.rows.length;
      setRows((prev) => [...prev, ...page.rows.filter((row) => !prev.some((item) => item.id === row.id))]);
      setTotal(page.total);
      // 服务端没给出新行时（并发删除等）直接停住：免得自动加载反复请求同一页
      setHasMore(page.hasMore && page.rows.length > 0);
      cellGuard.merge(page);
      mergeNotes(page.notes);
      return true;
    } catch (cause) {
      fail(cause, '加载更多失败');
      // 返回 false：LoadMore 会退避之后再试，失败就立刻重试会变成请求风暴
      return false;
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [cellGuard, detail.id, fail, hasMore, mergeNotes]);

  const createRow = async (preset?: Record<string, CellValue>) => {
    if (!canEdit) return;
    if (blockedByExpiry()) return;
    if (blockedByCapacity()) return;
    const release = beginWrite();
    try {
      const result = await api.createRecord(detail.id, { values: { ...preset } });
      if (result.record) replaceRow(result.record);
      setTotal(result.total);
      onReloadList();
    } catch (cause) {
      fail(cause, '新建记录失败');
    } finally {
      release();
    }
  };

  const commitCell = async (row: RowRecord, property: Property, value: CellValue | undefined) => {
    if (!canEdit) return;
    if (property.locked) {
      onToast(`字段「${property.name}」已锁定，无法修改`, 'error');
      return;
    }
    const cellKey = cellLockKey(row.id, property.id);
    // 勾选了「限制编辑」的分享：保存过、10 秒计时窗口已过且这一格仍有内容就只读，
    // 这里再挡一次（例如在另一个标签页里刚改过同一个格子）
    if (cellGuard.isSpent(row.id, property.id)) {
      onToast(cellLockHint(property.name), 'error');
      return;
    }
    // 值没变就不发请求（与服务端的判断保持一致）
    if (sameCellValue(row.values[property.id], value)) return;
    // 这一轮写入在飞的时候，轮询先不要动本地数据（否则刚改的值会被顶回去）
    const release = beginWrite();
    // optimistic update, then replace with the authoritative record
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
      const result = await api.updateRecord(row.id, { values: { [property.id]: value ?? null } });
      if (result.record) replaceRow(result.record);
      // 只有勾选了「限制编辑」的访问者才受这个约束（输入次数不限，只看时间）：
      // - 填了内容：服务端下发的窗口截止时刻是权威值，本地再记一份好让 10 秒倒计时
      //   立刻开始（每保存一次就重新计时）
      // - 把内容清空：等于没输入过，这一格的计时窗口 / 只读状态一起撤销（服务端也已
      //   删掉记账），之后还能重新输入
      // （所有者 / 表格成员 / 未勾选的分享不受影响，可以反复修改）
      if (detail.limitCellEdits) {
        if (isEmptyValue(value)) cellGuard.clearCells(cellKey);
        else {
          cellGuard.merge(result);
          cellGuard.markEdited(cellKey);
        }
      }
    } catch (cause) {
      fail(cause, '保存失败');
      replaceRow(row);
      // 保存失败时把服务端的权威值再取一次：这一格在写入期间可能刚被别人改过
      void syncRecord(row.id).catch(() => undefined);
    } finally {
      release();
    }
  };

  const duplicateRows = async (targets: RowRecord[]) => {
    if (!canEdit || !targets.length) return;
    if (blockedByExpiry()) return;
    if (blockedByCapacity()) return;
    const release = beginWrite();
    try {
      const result = await api.duplicateRecords(
        detail.id,
        targets.map((row) => row.id),
      );
      setRows((prev) => [...prev, ...result.records].sort((a, b) => a.position - b.position));
      setTotal(result.total);
      onReloadList();
    } catch (cause) {
      fail(cause, '复制失败');
    } finally {
      release();
    }
  };

  const deleteRows = async (targets: RowRecord[]) => {
    if (!canEdit || !targets.length) return;
    const ids = new Set(targets.map((row) => row.id));
    const release = beginWrite();
    try {
      const result = await api.deleteRecords(detail.id, [...ids]);
      setRows((prev) => prev.filter((row) => !ids.has(row.id)));
      setTotal(result.total);
      if (openRowId && ids.has(openRowId)) setOpenRowId(null);
      onReloadList();
    } catch (cause) {
      fail(cause, '删除失败');
    } finally {
      release();
    }
  };

  const uploadFile = async (row: RowRecord, property: Property, file: File): Promise<FileValue> => {
    if (property.locked) throw new Error(`字段「${property.name}」已锁定，无法上传文件`);
    // 附件容量到上限：不能再往上堆新文件（表格页顶部的提示条里写了怎么恢复）
    if (detail.capacity?.atCapacity) throw new Error(capacityBlockedHint(detail.capacity));
    // 文件字段属于这个格子的值：勾选了「限制编辑」时保存过、10 秒计时窗口已过、
    // 这一格仍有内容的话也不允许再上传（服务端同样会拒绝）
    if (cellGuard.isSpent(row.id, property.id)) {
      throw new Error(cellLockHint(property.name));
    }
    const result = await api.uploadFile(file, {
      databaseId: detail.id,
      recordId: row.id,
      propertyId: property.id,
    });
    // 刚上传的文件立刻计入容量：刷新一次侧边栏进度条（新增 / 删除记录已经会刷）
    onReloadList();
    return result.file;
  };

  /* ------------------------------------------------------------------ views */

  const patchView = async (viewId: string, patch: { name?: string; config?: ViewConfig }) => {
    try {
      const result = await api.updateView(viewId, patch);
      setDetail((prev) => ({ ...prev, views: result.views }));
    } catch (cause) {
      fail(cause, '视图更新失败');
    }
  };

  const updateActiveConfig = (patch: Partial<ViewConfig>) => {
    if (!activeView || !viewEditable) return;
    void patchView(activeView.id, { config: { ...activeView.config, ...patch } });
  };

  /** 新建视图：自定义名称 + 筛选条件 + 可选定向分享（视图锁定入口已下线）。 */
  const createView = async (input: NewViewInput) => {
    if (!canEditStructure) return;
    try {
      const result = await api.createView(detail.id, {
        type: input.type,
        name: input.name || undefined,
        config: { ...defaultViewConfig(input.type), filters: input.filters },
      });
      setDetail((prev) => ({ ...prev, views: result.views }));
      setActiveViewId(result.viewId);

      if (input.share) {
        try {
          const shared = await api.createViewShare(detail.id, {
            viewId: result.viewId,
            email: input.share.email,
            role: input.share.role,
            limitEdits: input.share.limitEdits,
          });
          setDetail((prev) => ({ ...prev, viewShares: shared.viewShares }));
          onToast(
            input.share.limitEdits
              ? `视图已定向分享给 ${input.share.email}（限制编辑）`
              : `视图已定向分享给 ${input.share.email}`,
          );
        } catch (cause) {
          fail(cause, '视图分享失败');
        }
      }
      onReloadList();
    } catch (cause) {
      fail(cause, '新建视图失败');
    }
  };

  const renameView = (viewId: string, name: string) => {
    if (!viewEditable) return;
    void patchView(viewId, { name });
  };

  const deleteView = async (viewId: string) => {
    if (!viewEditable) return;
    try {
      const result = await api.deleteView(viewId);
      setDetail((prev) => ({ ...prev, views: result.views }));
      if (activeViewId === viewId) setActiveViewId(result.views[0]?.id ?? null);
    } catch (cause) {
      fail(cause, '删除视图失败');
    }
  };

  /**
   * 表头 ▾ 菜单里的「↑ 升序 / ↓ 降序」：视图里只保留**一条**排序规则。
   * 对某个字段排序会把之前其他字段（以及它自己旧的）排序规则整体替换掉，
   * 所以各个字段之间的升降序互不影响、也不会互相叠加成多键排序。
   */
  const addSortFor = (property: Property, direction: 'asc' | 'desc') => {
    if (!activeView || !viewEditable) return;
    updateActiveConfig({ sorts: [{ propertyId: property.id, direction }] });
  };

  const addFilterFor = (property: Property) => {
    if (!activeView || !viewEditable) return;
    const filters = activeView.config.filters;
    const conditions = filters?.conditions ?? [];
    const fallback: Conjunction = filters?.conjunction === 'or' ? 'or' : 'and';
    // 新条件沿用上一条的关系（第一条没有前一条，用「必须满足」）
    const previous = conditions[conditions.length - 1];
    void patchView(activeView.id, {
      config: {
        ...activeView.config,
        filters: {
          conjunction: fallback,
          conditions: [
            ...conditions,
            {
              id: createId(),
              propertyId: property.id,
              operator: defaultOperatorForType(property.type),
              // 人员类字段默认「当前用户」，加完就能看到自己创建的记录
              value: defaultFilterValueForType(property.type),
              conjunction: previous ? conditionConjunction(previous, fallback) : 'and',
            },
          ],
        },
      },
    });
  };

  const hideProperty = (property: Property) => {
    if (!activeView || !viewEditable) return;
    const visible = (activeView.config.visibleProperties ?? properties.map((item) => item.id)).filter(
      (id) => id !== property.id,
    );
    updateActiveConfig({ visibleProperties: visible });
  };

  /* ------------------------------------------------------------- properties */

  const insertPosition = (afterId: string | null): number | undefined => {
    if (!afterId) return undefined;
    const index = properties.findIndex((property) => property.id === afterId);
    if (index < 0) return undefined;
    const current = properties[index];
    const next = properties[index + 1];
    return next ? (current.position + next.position) / 2 : current.position + 1000;
  };

  const submitProperty = async (input: { name: string; type: FieldType; config: PropertyConfig }) => {
    const state = propertyDialog;
    if (state?.mode === 'edit') {
      const result = await api.updateProperty(state.property.id, input);
      setDetail((prev) => ({ ...prev, properties: result.properties }));
      if (result.migrated) await reload();
      return;
    }
    const afterId = state?.mode === 'create' ? state.afterId : null;
    const result = await api.createProperty(detail.id, {
      ...input,
      position: insertPosition(afterId),
    });
    setDetail((prev) => ({ ...prev, properties: result.properties }));
  };

  const deleteProperty = async (property: Property) => {
    if (!window.confirm(`删除字段「${property.name}」？该字段的所有数据都会被移除。`)) return;
    try {
      const result = await api.deleteProperty(property.id);
      setDetail((prev) => ({ ...prev, properties: result.properties }));
      await reload();
    } catch (cause) {
      fail(cause, '删除字段失败');
    }
  };

  const resizeProperty = async (property: Property, width: number) => {
    setDetail((prev) => ({
      ...prev,
      properties: prev.properties.map((item) => (item.id === property.id ? { ...item, width } : item)),
    }));
    try {
      const result = await api.updateProperty(property.id, { width });
      setDetail((prev) => ({ ...prev, properties: result.properties }));
    } catch (cause) {
      fail(cause, '调整列宽失败');
    }
  };

  /** ← / →（表头字段菜单）：与相邻的可见列交换 position，实现左右移动 */
  const moveProperty = async (property: Property, direction: 'left' | 'right') => {
    if (!canEditStructure) return;
    // 以「当前视图里能看到的列」为参照，隐藏列不参与移动
    const list = shownProperties.some((item) => item.id === property.id) ? shownProperties : properties;
    const index = list.findIndex((item) => item.id === property.id);
    const neighbour = index < 0 ? undefined : list[index + (direction === 'left' ? -1 : 1)];
    if (!neighbour) return;
    // position 是浮点索引，交换两列的值即可；两列 position 相同时给一个偏移
    const samePosition = property.position === neighbour.position;
    const nextPosition = neighbour.position + (samePosition ? (direction === 'left' ? -1 : 1) : 0);
    try {
      await api.updateProperty(property.id, { position: nextPosition });
      const result = await api.updateProperty(neighbour.id, { position: property.position });
      setDetail((prev) => ({ ...prev, properties: result.properties }));
    } catch (cause) {
      fail(cause, '调整列顺序失败');
      await reload();
    }
  };

  /** 🔒 锁定字段 / 🔓 解锁字段：锁定后该字段的所有记录只读 */
  const togglePropertyLock = async (property: Property, locked: boolean) => {
    if (!canEditStructure) return;
    try {
      const result = await api.updateProperty(property.id, { locked });
      setDetail((prev) => ({ ...prev, properties: result.properties }));
      onToast(
        locked ? `字段「${property.name}」已锁定，记录只能查看` : `字段「${property.name}」已解锁`,
      );
    } catch (cause) {
      fail(cause, locked ? '锁定字段失败' : '解锁字段失败');
    }
  };

  /* -------------------------------------------------------------- database */

  const renameDatabase = async (nextName: string) => {
    const name = nextName.trim();
    if (!name || name === detail.name) {
      setNameDraft(detail.name);
      return;
    }
    try {
      const next = await api.updateDatabase(detail.id, { name });
      setDetail((prev) => ({ ...prev, name: next.name }));
      onReloadList();
    } catch (cause) {
      setNameDraft(detail.name);
      fail(cause, '重命名失败');
    }
  };

  const changeIcon = async (icon: string) => {
    try {
      await api.updateDatabase(detail.id, { icon });
      setDetail((prev) => ({ ...prev, icon }));
      onReloadList();
    } catch (cause) {
      fail(cause, '图标更新失败');
    }
  };

  const deleteDatabase = async () => {
    // 名额口径（见 src/worker/slots.ts）：试用表格删掉会退还名额；
    // 基础 / 专业表格删掉则把名额一起带走（名额不退还，已付的钱也不退），这里先提醒一句
    const quotaNote =
      detail.kind === 'trial'
        ? '删除后会释放这个试用名额。'
        : '删除后这个名额不会退还（已购买的费用也不退）。';
    if (!window.confirm(`确定删除表格「${detail.name}」？此操作不可恢复。\n${quotaNote}`)) return;
    try {
      await api.deleteDatabase(detail.id);
      onReloadList();
      onClose();
    } catch (cause) {
      fail(cause, '删除表格失败');
    }
  };

  const applyViewShares = (next: ViewShare[]) => setDetail((prev) => ({ ...prev, viewShares: next }));

  /** 分享 / 取消分享一个视图之后：顺手刷新侧边栏（分享不再增减名额，见 shared/quota.ts） */
  const applyViewSharesAndReload = (next: ViewShare[]) => {
    applyViewShares(next);
    onReloadList();
  };

  /* ----------------------------------------------------------------- render */

  const boardGroupProperty = activeView?.config.groupBy
    ? properties.find((property) => property.id === activeView.config.groupBy) ?? null
    : null;

  return (
    <section className="workspace">
      {/* 定向分享的访客（viewScoped）只能看被分享的视图：隐藏「表格名称」这一整行顶部栏 */}
      {!viewScoped ? (
        <header className="topbar">
          <input
            className="icon-input"
            value={detail.icon}
            maxLength={4}
            title="图标"
            disabled={!canEdit}
            onChange={(event) => setDetail((prev) => ({ ...prev, icon: event.target.value }))}
            onBlur={(event) => void changeIcon(event.target.value.trim() || '📋')}
          />
          <input
            className="title-input"
            value={nameDraft}
            disabled={!canEdit}
            onChange={(event) => setNameDraft(event.target.value)}
            onBlur={() => void renameDatabase(nameDraft)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
            }}
          />
          <span className={`badge role-${role}`}>{ROLE_LABEL[role]}</span>
          {/* 表格类型徽标：基础 / 专业（悬停能看到容量与保留期口径） */}
          <span className={`kind-tag ${detail.kind}`} title={tableKindCapacityText(detail.kind)}>
            {kindMeta.shortLabel}
          </span>
          <span className="spacer" />
          <span className="small muted">{members.length} 位成员 · {total} 条记录 · {properties.length}/{kindMeta.maxProperties} 列</span>
          {isOwner ? (
            <button type="button" className="btn ghost small danger" onClick={() => void deleteDatabase()}>
              删除表格
            </button>
          ) : null}
        </header>
      ) : null}

      {/* 到期未续费：只拦增长 —— 表格照常打开、查询、编辑、删除，只是不能再加记录 / 视图 */}
      {expiredHint ? (
        <p className="capacity-notice" role="status">
          ⏳ {expiredHint}
        </p>
      ) : null}

      {/* 容量到上限：只拦增长 —— 表格照常打开、照常查询，新增 / 复制 / 上传都停用 */}
      {detail.capacity?.atCapacity ? (
        <p className="capacity-notice" role="status" title={capacityTooltip(detail.capacity)}>
          ⛔ {capacityBlockedHint(detail.capacity)}
        </p>
      ) : null}

      {activeView ? (
        <ViewBar
          views={views}
          active={activeView}
          properties={properties}
          users={users}
          canEdit={viewEditable}
          canManage={isOwner && !viewScoped}
          total={total}
          rowCount={filtered.length}
          onSelectView={(id) => {
            setActiveViewId(id);
            setSelectedRowIds([]);
          }}
          onCreateView={(input) => void createView(input)}
          onRenameView={renameView}
          onDeleteView={(id) => void deleteView(id)}
          onUpdateConfig={updateActiveConfig}
          onShareView={(id) => {
            setShareViewId(id);
            setShareOpen(true);
          }}
          canAddView={canAddView}
          addViewHint={addViewHint}
        />
      ) : null}

      <div className="view-body">
        {/* 定向分享的访客（viewScoped）看不到「＋ 新建筛选」这一整行 */}
        {activeView && !viewScoped ? (
          <div className="view-toolbar">
            <Popover
              label="＋ 新建筛选"
              title={
                viewEditable
                  ? '为该视图添加筛选条件：多个「必须满足」块之间是「且」，每个块里可以放多条「任意满足」'
                  : '当前视图不可修改筛选条件'
              }
              variant="primary"
              panelWidth={560}
              align="left"
              disabled={!viewEditable}
            >
              {() => (
                <FilterPanel
                  properties={properties}
                  users={users}
                  filters={activeView.config.filters}
                  canEdit={viewEditable}
                  onChange={(next) => updateActiveConfig({ filters: next })}
                />
              )}
            </Popover>
            {filterCount ? (
              <span className="small muted">{`${filterSummary} · 命中 ${filtered.length} 条`}</span>
            ) : null}
            {/* 勾选记录后的批量操作栏：跟在「＋ 新建筛选」后面（原来在表格上方） */}
            {selectedRows.length ? (
              <>
                <span className="small muted">已选 {selectedRows.length} 条</span>
                <button
                  type="button"
                  className="btn ghost small"
                  onClick={() => void duplicateRows(selectedRows)}
                >
                  复制
                </button>
                <button
                  type="button"
                  className="btn ghost small"
                  onClick={() => {
                    void deleteRows(selectedRows);
                    setSelectedRowIds([]);
                  }}
                >
                  删除
                </button>
                <button type="button" className="btn ghost small" onClick={() => setSelectedRowIds([])}>
                  取消选择
                </button>
              </>
            ) : null}
          </div>
        ) : null}
        {activeView?.type === 'board' ? (
          <BoardView
            properties={properties}
            groups={groups}
            users={users}
            hasMore={hasMore}
            loadingMore={loadingMore}
            onLoadMore={loadMore}
            view={activeView}
            canEdit={canEdit}
            onOpen={(row) => openRecord(row.id)}
            onCreateRow={(option) => {
              if (boardGroupProperty && option) void createRow({ [boardGroupProperty.id]: option });
              else void createRow();
            }}
            onMoveRow={(row, key) => {
              if (!boardGroupProperty) return;
              const group = groups.find((item) => item.key === key);
              if (!group) return;
              if (boardGroupProperty.type === 'checkbox') void commitCell(row, boardGroupProperty, key === 'true');
              else if (group.option) void commitCell(row, boardGroupProperty, group.option);
            }}
          />
        ) : activeView?.type === 'gallery' ? (
          <GalleryView
            properties={properties}
            rows={filtered}
            hasMore={hasMore}
            loadingMore={loadingMore}
            onLoadMore={loadMore}
            users={users}
            view={activeView}
            canEdit={canEdit}
            onOpen={(row) => openRecord(row.id)}
            onCreateRow={() => void createRow()}
          />
        ) : (
          /* sortRule 是当前生效的排序（视图里最多一条规则），表头据此显示 ↑ / ↓ */
          <TableGrid
            properties={shownProperties}
            rows={filtered}
            users={users}
            canEdit={canEdit}
            canEditStructure={canEditStructure}
            canEditView={viewEditable}
            selectable={!viewScoped}
            selectedIds={selectedRowIds}
            onSelectionChange={setSelectedRowIds}
            rowHeight={activeView?.config.rowHeight ?? 'short'}
            hasMore={hasMore}
            loadingMore={loadingMore}
            onLoadMore={loadMore}
            onCreateRow={() => void createRow()}
            onCommitCell={commitCell}
            uploadFile={uploadFile}
            sortRule={activeView?.config.sorts?.[0] ?? null}
            onAddProperty={(afterId) => setPropertyDialog({ mode: 'create', afterId })}
            onEditProperty={(property) => setPropertyDialog({ mode: 'edit', property })}
            onDeleteProperty={(property) => void deleteProperty(property)}
            onHideProperty={hideProperty}
            onMoveProperty={(property, direction) => void moveProperty(property, direction)}
            onTogglePropertyLock={(property, locked) => void togglePropertyLock(property, locked)}
            onResizeProperty={(property, width) => void resizeProperty(property, width)}
            onSortProperty={addSortFor}
            onFilterProperty={addFilterFor}
            cellGuard={cellGuard}
            flashCells={flashCells}
            onOpenRecord={(row) => openRecord(row.id)}
          />
        )}

        {!activeView ? (
          <div className="empty-state">
            <p>该表格还没有视图。</p>
          </div>
        ) : null}
      </div>

      {propertyDialog ? (
        <PropertyDialog
          property={propertyDialog.mode === 'edit' ? propertyDialog.property : null}
          onClose={() => setPropertyDialog(null)}
          onSubmit={submitProperty}
        />
      ) : null}

      {openRow ? (
        <RecordDialog
          properties={properties}
          row={openRow}
          users={users}
          canEdit={canEdit}
          notes={detail.notes.filter((note) => note.recordId === openRow.id)}
          mentionCandidates={mentionCandidates}
          focusNoteId={focusNoteId}
          onClose={() => {
            setOpenRowId(null);
            setFocusNoteId(null);
          }}
          onCommitCell={(property, value) => void commitCell(openRow, property, value)}
          uploadFile={(property, file) => uploadFile(openRow, property, file)}
          onAddNote={(body, mentions) => addNote(openRow, body, mentions)}
          cellGuard={cellGuard}
        />
      ) : null}

      {shareOpen ? (
        <SharePanel
          database={detail}
          canManage={isOwner && !viewScoped}
          focusViewId={shareViewId}
          onClose={() => {
            setShareOpen(false);
            setShareViewId(null);
          }}
          onToast={onToast}
          onViewShares={applyViewSharesAndReload}
        />
      ) : null}
    </section>
  );
}

