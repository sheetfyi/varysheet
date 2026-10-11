import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  capacityBlockedHint,
  capacityLevelOfRatio,
  capacityRatio,
  capacityRecordsSide,
  capacityRecordsUsageText,
  capacityRetentionHint,
  capacityStorageSide,
  capacityStorageUsageText,
  capacityTooltip,
  capacityUnlimited,
  capacityUsageSummary,
} from '../../shared/capacity';
import {
  MAX_PURCHASE_COUNT,
  quotaSetFromUsed,
  TABLE_QUOTA_RULES,
  tableQuotaHasRoom,
  tableQuotaRemaining,
  tableQuotaSummary,
} from '../../shared/quota';
import {
  BUYABLE_TABLE_KINDS,
  DEFAULT_PURCHASE_UNIT,
  PURCHASE_UNITS,
  TABLE_KIND_FEATURES,
  TABLE_KINDS,
  asPurchaseUnitKey,
  asTableKind,
  purchaseMonthsOf,
  purchasePriceText,
  purchaseUnitCountLabel,
  purchaseUnitCounts,
  purchaseUnitOf,
  tableKindCapacityText,
  tableKindMeta,
} from '../../shared/tableKind';
import type { PurchaseUnitKey } from '../../shared/tableKind';
import type {
  DatabaseCapacity,
  DatabaseSummary,
  InboxMessage,
  SessionUser,
  TableKind,
  TableQuotaSet,
} from '../../shared/types';
import { ApiError } from '../api';
import type { AdminSection } from './AdminPanel';
import { InboxButton } from './InboxButton';
import { Modal } from './Modal';
import { SiteMark } from './SiteMark';
import { UserChip } from './UserChip';

interface SidebarProps {
  appName: string;
  /** 站点图标（管理员上传过才有），跟在站点名称前面显示 */
  siteIconUrl: string | null;
  user: SessionUser | null;
  databases: DatabaseSummary[];
  /** 表格名额（试用 / 基础 / 专业各自还能再添加几张）：会话里与 `GET /api/quota` 下发 */
  quota: TableQuotaSet | null;
  activeId: string | null;
  /** 未读私信（收件箱左上角图标 + 红点数字） */
  inbox: InboxMessage[];
  inboxUnread: number;
  /** 是否展开（手机上是一个抽屉浮层） */
  open: boolean;
  /** 窄屏时用 ✕ 收起抽屉，而不是桌面端的 «（按钮样式见 styles.css 的 .collapse-btn） */
  narrow: boolean;
  onSelect: (id: string) => void;
  /** 新建表格：带上类型（试用表格 / 基础表格 / 专业表格），名额按类型扣 */
  onCreate: (input: { name: string; kind: TableKind }) => Promise<void>;
  /** 收起侧边栏（手机端会同时移除遮罩层） */
  onClose: () => void;
  onLogout: () => void;
  /** 打开「修改密码」弹窗 */
  onChangePassword: () => void;
  /** 当前主区域停在后台的哪一页：'users' 用户管理 / 'system' 系统管理 / null 表格页（管理员才有） */
  adminView: AdminSection | null;
  /** 打开后台的某一页（用户管理 / 系统管理，仅 `user.isAdmin` 时入口可见） */
  onOpenAdmin: (section: AdminSection) => void;
  /** 展开收件箱前刷新一次 */
  onInboxRefresh: () => void;
  /** 点开一条私信：已读 + 打开记录卡片并定位到那条备注 */
  onInboxSelect: (message: InboxMessage) => void;
  /** 购买表格名额（说明弹窗里的「购买」）：由 App 调接口、刷新名额并弹提示 */
  onBuyQuota: (input: { kind: TableKind; count: number; months: number }) => Promise<void>;
}

/** 容量浮层的宽度（与侧边栏同宽；窄屏按视口夹取，不会横向溢出） */
const CAPACITY_PANEL_WIDTH = 248;
/** 浮层离容量条 / 视口边缘的距离 */
const CAPACITY_PANEL_GAP = 8;
const CAPACITY_PANEL_MARGIN = 8;

/** 把坐标夹进 [min, max]；max 比 min 还小时以 min 为准（窄屏也不会算出负值） */
function clampToViewport(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * 容量明细浮层：记录 / 附件各自的「已用 / 上限 / 剩余」+ 剩余条。
 *
 * 专业表格（不限容量）两侧都显示「不限」；试用 / 基础表格在下面多一行「数据保留
 * 半年 / 1 年，超期自动清除」的说明。原来的「扩容」按钮已按需求移除（名额改走
 * 「表格数量说明」弹窗里的购买 / 分享）。
 *
 * 用 `createPortal` 挂到 body 上，两个原因：
 *   1. 侧边栏列表是滚动容器（`overflow: auto`），浮层放在行内会被裁掉；
 *   2. 手机上侧边栏抽屉是用 `transform` 滑入的，祖先带 transform 时里面的
 *      `position: fixed` 会改成相对抽屉定位 —— 只有挂在 body 上两处才都准。
 */
function CapacityPanel({
  name,
  capacity,
  anchor,
  onClose,
}: {
  /** 表格名（浮层标题用） */
  name: string;
  capacity: DatabaseCapacity;
  /** 锚点：容量条本身，浮层按它的实时位置摆放 */
  anchor: HTMLElement;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // 贴在容量条右侧、纵向对齐，再整体夹进视口；滚动或改窗口大小时跟着重算
  useLayoutEffect(() => {
    const place = () => {
      const box = panel.current;
      // 这一行被重新渲染没了（表格被删 / 列表刷新）：把浮层收起来，别悬在半空
      if (!box || !document.body.contains(anchor)) {
        onClose();
        return;
      }
      const rect = anchor.getBoundingClientRect();
      const left = clampToViewport(
        rect.right + CAPACITY_PANEL_GAP,
        CAPACITY_PANEL_MARGIN,
        window.innerWidth - box.offsetWidth - CAPACITY_PANEL_MARGIN,
      );
      const top = clampToViewport(
        rect.top + rect.height / 2 - box.offsetHeight / 2,
        CAPACITY_PANEL_MARGIN,
        window.innerHeight - box.offsetHeight - CAPACITY_PANEL_MARGIN,
      );
      setPos((prev) => (prev && prev.left === left && prev.top === top ? prev : { left, top }));
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchor, onClose]);

  // 点浮层外面 / 按 Esc 收起（点容量条本身不算「外面」，开合交给容量条的点击处理）
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panel.current?.contains(target) || anchor.contains(target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchor, onClose]);

  const records = capacityRecordsSide(capacity);
  const storage = capacityStorageSide(capacity);
  // 基础表格的保留期说明（专业表格返回空串，不用提示）
  const retention = capacityRetentionHint(capacity);
  return createPortal(
    <div
      ref={panel}
      className="capacity-pop"
      role="dialog"
      aria-label={`「${name}」容量使用情况`}
      style={{
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        width: CAPACITY_PANEL_WIDTH,
        // 量完位置再显示，避免先闪一下再跳到锚点旁边
        visibility: pos ? 'visible' : 'hidden',
      }}
      /* 浮层虽然在 body 上，React 事件仍按组件树冒泡：不拦一下会连带选中这一行表格 */
      onClick={(event) => event.stopPropagation()}
    >
      <div className="capacity-pop-title">
        <span className="capacity-pop-name" title={name}>
          {name}
        </span>
        {/* 表格类型：试用 / 基础 / 专业，鼠标悬停能看这一类的容量口径 */}
        <span
          className={`kind-tag ${capacity.kind}`}
          title={tableKindCapacityText(capacity.kind)}
        >
          {tableKindMeta(capacity.kind).shortLabel}
        </span>
        {capacity.atCapacity ? <span className="capacity-full-tag">已满</span> : null}
      </div>

      <div className="capacity-pop-item">
        <div className="capacity-pop-head">
          <span className="capacity-pop-label">记录</span>
          <span className="capacity-pop-value">{capacityRecordsUsageText(capacity)}</span>
        </div>
        <span className="capacity-pop-bar">
          <span className={`capacity-pop-fill ${records.level}`} style={{ width: `${records.remainingRatio * 100}%` }} />
        </span>
      </div>

      <div className="capacity-pop-item">
        <div className="capacity-pop-head">
          <span className="capacity-pop-label">附件</span>
          <span className="capacity-pop-value">{capacityStorageUsageText(capacity)}</span>
        </div>
        <span className="capacity-pop-bar">
          <span className={`capacity-pop-fill ${storage.level}`} style={{ width: `${storage.remainingRatio * 100}%` }} />
        </span>
      </div>

      {retention ? (
        <p className="capacity-pop-note" title={retention}>
          {retention}
        </p>
      ) : null}

      <p className={`capacity-pop-note${capacity.atCapacity ? ' danger' : ''}`}>
        {capacity.atCapacity
          ? capacityBlockedHint(capacity)
          : capacityUnlimited(capacity)
            ? `${tableKindMeta(capacity.kind).label}：容量与存储时间都不限制`
            : '到上限后只能查看和查询：新增记录、复制记录与上传附件都会停用，删掉一些数据就能恢复'}
      </p>
    </div>,
    document.body,
  );
}

/**
 * 列表里的「试用 / 基础 / 专业」徽标：同时也是这张表的**容量入口**。
 *
 * 按需求去掉了行尾的硬盘图标（💾），改由徽标承担：点一下弹出容量明细
 * （见 `CapacityPanel`），悬停仍是 `title` 里的一行提示。容量富余时就是普通徽标；
 * 记录 / 附件任一维度用掉 80% 起底色转浅黄、到上限转浅红，并在行尾再挂一个
 * 「已满」标签，具体用到多少在浮层里看。
 *
 * 这里只负责显示，拦增长由服务端（403 `capacity_exceeded`）和表格页负责。
 */
function KindCapacityTag({
  name,
  kind,
  capacity,
}: {
  name: string;
  kind: TableKind;
  /** 老标签页里可能是升级前拉到的旧会话数据（没有 capacity 字段），此时退回不可点的纯徽标 */
  capacity?: DatabaseCapacity;
}) {
  // 浮层锚点：存元素本身，滚动时按它的实时位置重算（hook 得放在下面的提前 return 之前）
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const close = useCallback(() => setAnchor(null), []);
  const meta = tableKindMeta(kind);

  if (!capacity) {
    return (
      <span className={`kind-tag ${kind}`} title={tableKindCapacityText(kind)}>
        {meta.shortLabel}
      </span>
    );
  }

  // 徽标底色按「更紧张的那一侧」判档：记录或附件任一维度吃紧都要能看出来
  const level = capacityLevelOfRatio(capacityRatio(capacity));

  /** 点 / 回车徽标：展开明细，再点一次收起（拦掉冒泡，别顺带切换表格） */
  const toggle = (event: React.SyntheticEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setAnchor(anchor ? null : event.currentTarget);
  };

  return (
    <>
      <span
        className={`kind-tag ${kind} capacity-entry ${level}${anchor ? ' open' : ''}`}
        role="button"
        tabIndex={0}
        aria-haspopup="dialog"
        aria-expanded={anchor !== null}
        aria-label={`${meta.label}容量：${capacityUsageSummary(capacity)}，点开查看明细`}
        title={capacityTooltip(capacity)}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') toggle(event);
        }}
      >
        {meta.shortLabel}
      </span>
      {capacity.atCapacity ? <span className="capacity-full-tag">已满</span> : null}
      {anchor ? (
        <CapacityPanel name={name} capacity={capacity} anchor={anchor} onClose={close} />
      ) : null}
    </>
  );
}

/**
 * 「表格数量说明」弹窗：讲清名额规则（三类分开算、试用靠邀请新用户 +1、基础 / 专业都只能
 * 购买）+ 购买入口（类型 / 时长单位 / 时长数量 / 购买数量 + 价格明细），外加一张「试用表格 /
 * 基础表格 / 专业表格的功能区别（含价格）」对比表。
 *
 * 数量都是服务端下发的权威值（口径见 `src/shared/quota.ts`）。购买走 App 传进来的
 * `onBuy`（`POST /api/quota/purchases`），成功后会立刻刷新这里的数字。
 */
function QuotaDialog({
  quota,
  onClose,
  onBuy,
}: {
  quota: TableQuotaSet;
  onClose: () => void;
  onBuy: (input: { kind: TableKind; count: number; months: number }) => Promise<void>;
}) {
  const [kind, setKind] = useState<TableKind>('basic');
  const [count, setCount] = useState(1);
  /** 购买时长的**单位**：月（1 个单位 = 1 个月）或 年（1 个单位 = 12 个月，见 shared/tableKind.ts 的 `PURCHASE_UNITS`） */
  const [unitKey, setUnitKey] = useState<PurchaseUnitKey>(DEFAULT_PURCHASE_UNIT);
  /** 购买时长的**数量**（选几个单位）：月 → 1 ~ 12 个月，年 → 1 ~ 5 年 */
  const [unitCount, setUnitCount] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const meta = tableKindMeta(kind);
  /** 当前选中的时长单位：「时长数量」的可选范围与文案都跟着它走 */
  const unit = purchaseUnitOf(unitKey);
  /** 总购买时长（月）= 时长单位 × 时长数量；服务端按它算价（`purchaseMonthsOf`） */
  const months = purchaseMonthsOf(unitKey, unitCount);

  /** 换时长单位：数量夹回新单位的范围（比如「12 个月」切到「年」时会收成 5） */
  const changeUnit = (next: string) => {
    const target = purchaseUnitOf(asPurchaseUnitKey(next));
    setUnitKey(target.key);
    setUnitCount((current) => Math.min(Math.max(current, target.minUnits), target.maxUnits));
  };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await onBuy({ kind, count, months });
      onClose();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '购买失败，请稍后再试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="表格数量说明" onClose={onClose}>
      {TABLE_KINDS.map((item) =>
        quota[item] ? (
          <p className="small muted quota-current" key={item}>
            {tableQuotaSummary(quota[item])}
          </p>
        ) : null,
      )}

      <ul className="quota-rule-list">
        {TABLE_QUOTA_RULES.map((rule) => (
          <li key={rule}>{rule}</li>
        ))}
      </ul>

      {/* 三类表格的功能区别：容量 / 存储时间 / 列数 / 视图数 */}
      <table className="quota-kind-table">
        <thead>
          <tr>
            <th scope="col">功能</th>
            {TABLE_KINDS.map((item) => (
              <th scope="col" key={item}>
                {tableKindMeta(item).label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {TABLE_KIND_FEATURES.map((feature) => (
            <tr key={feature.label}>
              <th scope="row">{feature.label}</th>
              {TABLE_KINDS.map((item) => (
                <td key={item}>{feature[item]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      <div className="quota-buy">
        <label className="field">
          <span>表格类型</span>
          {/* 试用表格是免费送的、不卖，所以这里只列可以购买的两类 */}
          <select
            className="input"
            value={kind}
            onChange={(event) => setKind(asTableKind(event.target.value))}
          >
            {BUYABLE_TABLE_KINDS.map((item) => (
              <option key={item} value={item}>
                {tableKindMeta(item).label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>时长单位</span>
          {/* 购买时长按「单位 × 数量」算：月（1 个月）或 年（12 个月），见 shared/tableKind.ts 的 PURCHASE_UNITS */}
          <select className="input" value={unitKey} onChange={(event) => changeUnit(event.target.value)}>
            {PURCHASE_UNITS.map((item) => (
              <option key={item.key} value={item.key}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>时长数量</span>
          {/* 选几个单位：月 → 1 ~ 12 个月；年 → 1 ~ 5 年（12 ~ 60 个月） */}
          <select className="input" value={unitCount} onChange={(event) => setUnitCount(Number(event.target.value))}>
            {purchaseUnitCounts(unit).map((value) => (
              <option key={value} value={value}>
                {purchaseUnitCountLabel(unit, value)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>购买数量</span>
          <select className="input" value={count} onChange={(event) => setCount(Number(event.target.value))}>
            {Array.from({ length: MAX_PURCHASE_COUNT }, (_, index) => index + 1).map((value) => (
              <option key={value} value={value}>
                {value} 个表格
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn primary" disabled={busy} onClick={() => void submit()}>
          {busy ? '购买中…' : '购买'}
        </button>
      </div>

      {/* 价格明细：`9.9 元/月 × 2 个 × 12 个月 = 237.6 元` */}
      <p className="quota-price">价格：{purchasePriceText(kind, count, months)}</p>

      {/* 一句话收尾：买完的效果 + 支付口径（细则都在上面的规则列表里，不再重复） */}
      <p className="small muted">
        买几个就多几个可添加的{meta.label}名额（{tableKindCapacityText(kind)}）；点「购买」立即生效并记一条流水，支付尚未接入。
      </p>
      {error ? <p className="error small">{error}</p> : null}
    </Modal>
  );
}

/**
 * 「你有 N 个表格可」里那个可点的数字：N 是**试用 / 基础 / 专业三类名额的合计**，
 * 点开都是同一个「表格数量说明」弹窗（弹窗里再按类型给出各自的「已用 x/y，还剩几个」）。
 * 只是一个可点的小按钮 + 一段无障碍说明，没有别的状态。
 */
function QuotaCountButton({ remaining, onOpen }: { remaining: number; onOpen: () => void }) {
  return (
    <button
      type="button"
      className="quota-count"
      title="表格数量规则与购买"
      aria-label={`还可以添加 ${remaining} 个表格（试用 / 基础 / 专业合计），点击查看数量说明`}
      onClick={onOpen}
    >
      {remaining}
    </button>
  );
}

export function Sidebar({
  appName,
  siteIconUrl,
  user,
  databases,
  quota,
  activeId,
  inbox,
  inboxUnread,
  open,
  narrow,
  onSelect,
  onCreate,
  onClose,
  onLogout,
  onChangePassword,
  adminView,
  onOpenAdmin,
  onInboxRefresh,
  onInboxSelect,
  onBuyQuota,
}: SidebarProps) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  /**
   * 新建表格的类型（试用 / 基础 / 专业表格）：名额按类型扣。
   * 默认给免费的试用表格 —— 新账号只有 1 个试用名额，基础 / 专业都要购买。
   */
  const [kind, setKind] = useState<TableKind>('trial');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** 「表格数量说明」弹窗：点「你有 N 个表格可以添加」里的 N 打开 */
  const [quotaOpen, setQuotaOpen] = useState(false);
  /** 只通过视图定向分享拿到的表格：只出现在「分享表格」里，不再混进「我的表格」 */
  const sharedDatabases = databases.filter((database) => database.viewScoped);
  const myDatabases = databases.filter((database) => !database.viewScoped);
  /**
   * 名额：优先用服务端下发的权威值（试用 / 基础 / 专业三类）；万一还没拿到（离线 /
   * 接口偶发失败），就按「每类已有表格数」本地兜底，别让那三行文案空着或让侧边栏崩掉。
   */
  const quotaView =
    quota?.trial && quota?.basic && quota?.pro
      ? quota
      : // 兜底：老响应（或还没拿到数据）里没有三类名额，就按「已有表格数」显示，别让侧边栏崩掉
        quotaSetFromUsed({
          trial: myDatabases.filter((database) => database.kind === 'trial').length,
          basic: myDatabases.filter((database) => database.kind === 'basic').length,
          pro: myDatabases.filter((database) => database.kind === 'pro').length,
        });
  /** 三类名额合计还能再添加几个：侧边栏显示的 N（试用 + 基础 + 专业），也是「添加」是否可点的依据 */
  const addableTotal = tableQuotaRemaining(quotaView);
  /** 三类名额都空了（合计剩余 0）才把「添加」按钮置灰：还能邀请新用户注册或购买名额 */
  const addDisabled = addableTotal <= 0;
  /** 当前选中的类型没有名额了：创建按钮置灰，提示先邀请（试用）/ 购买（基础 / 专业） */
  const kindHasRoom = tableQuotaHasRoom(quotaView, kind);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      await onCreate({ name: name.trim(), kind });
      setName('');
      setCreating(false);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '创建失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside
      className={`sidebar${open ? ' open' : ''}`}
      aria-hidden={!open}
      /* 收起时侧边栏滑出屏外，禁止键盘 Tab 聚焦到看不见的按钮 */
      inert={open ? undefined : true}
    >
      <div className="sidebar-head">
        <SiteMark appName={appName} siteIconUrl={siteIconUrl} className="brand" />
        {/* 左上角的收件箱：红点里的数字是未读私信条数 */}
        <InboxButton
          messages={inbox}
          unread={inboxUnread}
          onRefresh={onInboxRefresh}
          onSelect={onInboxSelect}
        />
        <span className="spacer" />
        <button
          type="button"
          className="icon-btn collapse-btn"
          title="收起侧边栏"
          aria-label="收起侧边栏"
          onClick={onClose}
        >
          {narrow ? '✕' : '«'}
        </button>
      </div>

      {/* 「添加表格」区（在「我的表格」上方）：名额说明 + 添加按钮 + 新建表单 */}
      <div className="sidebar-add">
        {/* 名额说明与「添加」按钮同一行：数字是试用 / 基础 / 专业三类名额的合计 */}
        <div className="sidebar-add-row">
          <p className="sidebar-add-note">
            你有
            <QuotaCountButton remaining={addableTotal} onOpen={() => setQuotaOpen(true)} />
            个表格可
          </p>
          <button
            type="button"
            className="btn primary small sidebar-add-btn"
            title={
              addDisabled ? '名额已用完，点数字看看规则与购买' : creating ? '收起新建表格表单' : '新建表格'
            }
            disabled={addDisabled}
            onClick={() => setCreating((prev) => !prev)}
          >
            添加
          </button>
        </div>

        {/* 新建表格固定落成空白表格（只有「名称」字段），不再让用户挑模板 */}
        {creating && !addDisabled ? (
          <form onSubmit={submit} className="sidebar-add-form">
            <label className="field">
              <span>表格名称</span>
              <input
                className="input"
                value={name}
                autoFocus
                onChange={(event) => setName(event.target.value)}
                placeholder="例如：项目排期"
              />
            </label>
            <label className="field">
              <span>表格类型</span>
              <select
                className="input"
                value={kind}
                onChange={(event) => setKind(asTableKind(event.target.value))}
              >
                {TABLE_KINDS.map((item) => (
                  <option key={item} value={item} disabled={!tableQuotaHasRoom(quotaView, item)}>
                    {tableKindMeta(item).label}（剩 {quotaView[item].remaining} 个名额）
                  </option>
                ))}
              </select>
            </label>
            <p className="small muted">{tableKindCapacityText(kind)}</p>
            {error ? <p className="error small">{error}</p> : null}
            <div className="row gap">
              <button
                className="btn primary small"
                type="submit"
                disabled={busy || !name.trim() || !kindHasRoom}
              >
                {busy ? '创建中…' : '创建'}
              </button>
              <button className="btn ghost small" type="button" onClick={() => setCreating(false)}>
                取消
              </button>
            </div>
          </form>
        ) : null}
      </div>

      <div className="sidebar-section">
        <div className="row">
          <span>我的表格</span>
          <span className="spacer" />
          <span className="small muted">{myDatabases.length ? myDatabases.length : ''}</span>
        </div>
      </div>

      <div className="sidebar-list">
        {myDatabases.length ? (
          myDatabases.map((database) => (
            <button
              key={database.id}
              type="button"
              className={`sidebar-item${database.id === activeId ? ' active' : ''}`}
              onClick={() => onSelect(database.id)}
              title={database.name}
            >
              <span>{database.icon || '📋'}</span>
              <span className="label">{database.name}</span>
              {/* 类型徽标兼容量入口：点它弹出「记录 / 附件」明细（原来的硬盘图标已按需求去掉） */}
              <KindCapacityTag name={database.name} kind={database.kind} capacity={database.capacity} />
              {database.locked ? (
                <span className="small muted" title="结构已锁定">
                  🔒
                </span>
              ) : null}
              {database.role !== 'owner' ? (
                <span className="small muted">{database.role === 'editor' ? '协作' : '只读'}</span>
              ) : null}
            </button>
          ))
        ) : (
          <p className="small muted" style={{ padding: '0 12px' }}>
            还没有表格，点上方「添加」新建。
          </p>
        )}
      </div>

      <div className="sidebar-section">
        <div className="row">
          <span>分享表格</span>
          <span className="spacer" />
          <span className="small muted">{sharedDatabases.length ? sharedDatabases.length : ''}</span>
        </div>
      </div>

      <div className="sidebar-list shared">
        {sharedDatabases.length ? (
          sharedDatabases.map((database) => (
            <button
              key={`shared-${database.id}`}
              type="button"
              className={`sidebar-item${database.id === activeId ? ' active' : ''}`}
              onClick={() => onSelect(database.id)}
              title={
                database.sharedViewNames.length
                  ? `分享视图：${database.sharedViewNames.join('、')}`
                  : database.name
              }
            >
              <span>🔗</span>
              <span className="label">{database.name}</span>
            </button>
          ))
        ) : (
          <p className="small muted" style={{ padding: '0 12px' }}>
            暂无他人分享给你的视图。
          </p>
        )}
      </div>

      {user?.isAdmin ? (
        <>
          <div className="sidebar-section">
            <div className="row">
              <span>管理</span>
            </div>
          </div>
          <div className="sidebar-list">
            {/* 「用户管理」（注册账号）在前，「系统管理」（站点设置 / 存储分片）紧跟其后 */}
            <button
              type="button"
              className={`sidebar-item${adminView === 'users' ? ' active' : ''}`}
              title="用户管理：注册账号的昵称 / 邮箱 / 密码 / 删除"
              onClick={() => onOpenAdmin('users')}
            >
              <span>👥</span>
              <span className="label">用户管理</span>
            </button>
            <button
              type="button"
              className={`sidebar-item${adminView === 'system' ? ' active' : ''}`}
              title="系统管理：站点设置与存储分片"
              onClick={() => onOpenAdmin('system')}
            >
              <span>⚙️</span>
              <span className="label">系统管理</span>
            </button>
          </div>
        </>
      ) : null}

      {quotaOpen ? (
        <QuotaDialog quota={quotaView} onClose={() => setQuotaOpen(false)} onBuy={onBuyQuota} />
      ) : null}

      <div className="sidebar-foot">
        <div className="row gap">
          <UserChip user={user} onLogout={onLogout} onChangePassword={onChangePassword} />
        </div>
      </div>
    </aside>
  );
}
