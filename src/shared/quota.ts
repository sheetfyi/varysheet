/**
 * 表格名额（「还能再添加几张表格」）的规则与计算：Worker 与前端共用。
 *
 * 名额**按表格类型分开算**：试用名额只能用来加试用表格，基础名额只能用来加基础表格，
 * 专业名额只能用来加专业表格（类型口径见 `tableKind.ts`）。这里只放纯函数（不读环境
 * 变量、不碰数据库）：服务端拿它算 `/api/quota`，前端拿它兜底显示与文案。数据结构见
 * `types.ts` 的 `TableQuota` / `TableQuotaSet`。
 *
 * 三类名额的来源（2026-10 口径）：
 *   试用 新注册账号送 1 个（一人一张免费试用表）+ 每成功邀请一位新用户注册 +1，不单卖；
 *   基础 没有赠送（**分享也不加**）：只能购买，9.9 元/月；
 *   专业 同样没有赠送（**分享也不加**）：只能购买，99.9 元/月。
 * 购买时长按「单位 × 数量」选：单位是「月」（1 个月）或「年」（12 个月），后面再选时长数量
 * （月 1 ~ 12 个、年 1 ~ 5 个），总月数 = 单位月数 × 数量（`tableKind.ts` 的 `PURCHASE_UNITS` /
 * `purchaseMonthsOf`）；服务端只认 `PURCHASE_MONTH_OPTIONS` 里那几档月数。
 */
import {
  DAY_MS,
  MAX_PURCHASE_MONTHS,
  MIN_PURCHASE_MONTHS,
  asTableKind,
  tableKindLabel,
  tableKindPriceText,
} from './tableKind';
import type { TableKind, TableQuota, TableQuotaSet } from './types';

/**
 * 新注册账号就有的默认名额：试用表格送 1 个（一人一张免费试用表），基础 / 专业 0 个
 * （原来默认送 1 个基础表格，已取消）。
 */
export const BASE_TABLE_QUOTA: Record<TableKind, number> = { trial: 1, basic: 0, pro: 0 };

/** 每成功邀请一位新用户注册（对方真的注册成功），试用表格名额 +1 */
export const INVITE_TRIAL_TABLE_QUOTA = 1;

/** 一次购买最多能选的数量（说明弹窗里的购买下拉框） */
export const MAX_PURCHASE_COUNT = 10;

/** 名额用完时的错误码：建表接口 403 用它，前端据此把提示写成「去邀请新用户 / 去购买」 */
export const QUOTA_EXCEEDED = 'quota_exceeded';

/**
 * 表格时长到期（基础 / 专业表格没续费）时的错误码：新增记录 / 新增视图的接口 403 用它，
 * 前端据此把提示写成「续费后恢复」。到期本身不锁表 —— 查看、编辑、删除、导出、分享都照常。
 */
export const SLOT_EXPIRED = 'slot_expired';

/**
 * 「续费」按钮出现的窗口（天）：基础 / 专业表格的剩余时长不多于这么多天时，
 * 表格清单里这张表后面会出现「续费」（见 `src/worker/slots.ts` 的 `table_slot_allocations`）。
 */
export const SLOT_RENEW_WINDOW_DAYS = 7;

/**
 * 从某个时刻起往后推若干个月（只用 UTC 字段算，避开本地时区差异）。
 * 月末的进位按「不越过月底」处理：1 月 31 日 + 1 个月 = 2 月 28/29 日（与常见订阅口径一致）。
 */
export function addMonths(at: number, months: number, fallback = Date.now()): number {
  const base = Number.isFinite(at) && at > 0 ? at : fallback;
  const count = Number.isFinite(months) ? Math.trunc(months) : 0;
  const date = new Date(base);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + count);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.getTime();
}

/**
 * 这张表该不该显示「续费」：有时长记录（`expiresAt > 0`）且剩余不超过
 * `SLOT_RENEW_WINDOW_DAYS` 天（已经过期同样算 —— 过期的表更要续）。
 */
export function slotRenewable(expiresAt: number, now = Date.now()): boolean {
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return false;
  return expiresAt - now <= SLOT_RENEW_WINDOW_DAYS * DAY_MS;
}

/** 「有效期至 2026-11-11（还剩 23 天）」/「有效期至 2026-11-11（已过期）」：清单里悬停提示用 */
export function slotExpiryText(expiresAt: number, now = Date.now()): string {
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return '';
  const date = new Date(expiresAt).toISOString().slice(0, 10);
  const days = Math.ceil((expiresAt - now) / DAY_MS);
  return `有效期至 ${date}（${days > 0 ? `还剩 ${days} 天` : '已过期'}）`;
}

/** 到期时刻的日期（`2026-11-11`）；没有时长 / 非法值返回空串 */
export function slotExpiryDate(expiresAt: number): string {
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return '';
  return new Date(expiresAt).toISOString().slice(0, 10);
}

/**
 * 这张表**已经到期且还没续费**：有时长记录（`expiresAt > 0`）且到期时刻已经过去。
 * 没有时长记录（`expiresAt = 0`：试用表格、从没买过、老表兜底也查不到）恒为 false ——
 * 「没时长」不等于「到期」，不能把这种表当成过期锁住。
 *
 * 到期后**只拦增长**：不能再添加记录 / 视图，编辑、删除、查询、导出统统照常
 * （见 `src/worker/slots.ts` 的 `assertSlotActive()`）。
 */
export function slotExpired(expiresAt: number, now = Date.now()): boolean {
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return false;
  return expiresAt <= now;
}

/**
 * 到期后的提示句：表格页顶部的提示条、新增记录 / 新增视图前的拦截、服务端的 403 都用它。
 * 只说「什么不能做 + 怎么恢复」，不吓唬人（数据都在）。
 */
export function slotExpiredHint(kind: TableKind | string | null | undefined, expiresAt: number): string {
  const date = slotExpiryDate(expiresAt);
  const label = tableKindLabel(kind);
  const day = date ? `已于 ${date} 到期` : '已到期';
  return `${label}${day}（未续费）：仍可查看、编辑、删除与分享数据，但不能再添加记录或视图，续费后立即恢复`;
}

/**
 * 名额规则：侧边栏的说明弹窗原样展示，改口径时只改这里。
 *
 * 文案要求「一行一条、能扫读」：每条只说一件事，容量 / 保留期这类细节交给下面的对比表，
 * 这里不再重复（弹窗里的其它句子同理）。
 */
export const TABLE_QUOTA_RULES: string[] = [
  '名额分三类独立计算：试用表格、基础表格、专业表格。',
  `试用表格：注册送 ${BASE_TABLE_QUOTA.trial} 个，每邀请一位新用户注册 +${INVITE_TRIAL_TABLE_QUOTA} 个，不出售；删掉试用表格会把名额还回来。`,
  `基础表格：无赠送，只能购买，${tableKindPriceText('basic')}；分享不增加名额。`,
  `专业表格：无赠送，只能购买，${tableKindPriceText('pro')}；分享不增加名额。`,
  '基础表格与专业表格：删掉表格会把那个名额一起带走（名额不退还，已付的钱也不退）。',
  `购买时长 = 单位（月 1 个月 / 年 12 个月）× 数量（月 1 ~ 12，年 1 ~ 5），总时长 ${MIN_PURCHASE_MONTHS} ~ ${MAX_PURCHASE_MONTHS} 个月；金额 = 月单价 × 表格数量 × 总月数。`,
  `基础表格与专业表格自带时长（从建表时的购买时长起算）：剩余不到 ${SLOT_RENEW_WINDOW_DAYS} 天时表格清单里会出现「续费」，续费和购买同价、同样走扫码支付。`,
  '基础表格与专业表格到期没续费时数据都还在（查看、编辑、删除、分享照常），但不能添加新记录、也不能加新视图；续费后立即恢复。',
];

function countOf(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

/** 按「已用 / 赠额（现在只有试用表格的邀请赠额）/ 已购买」算某一类的总名额与剩余可添加数量 */
export function tableQuotaOf(input: {
  kind: TableKind;
  used: number;
  shared: number;
  purchased?: number;
}): TableQuota {
  const kind = asTableKind(input.kind);
  const used = countOf(input.used);
  const shared = countOf(input.shared);
  const purchased = countOf(input.purchased);
  const total = BASE_TABLE_QUOTA[kind] + shared + purchased;
  return { kind, used, shared, purchased, total, remaining: Math.max(0, total - used) };
}

/** 三类各自的「已用 / 赠额（只有试用表格有，来自邀请新用户）/ 已购买（可选）」→ 完整名额 */
export function tableQuotaSetOf(input: {
  trial: { used: number; shared: number; purchased?: number };
  basic: { used: number; shared: number; purchased?: number };
  pro: { used: number; shared: number; purchased?: number };
}): TableQuotaSet {
  return {
    trial: tableQuotaOf({ kind: 'trial', ...input.trial }),
    basic: tableQuotaOf({ kind: 'basic', ...input.basic }),
    pro: tableQuotaOf({ kind: 'pro', ...input.pro }),
  };
}

/** 只知道每类已用几张表时的兜底名额（接口还没返回时先按「已用」显示，别空着） */
export function quotaSetFromUsed(used: { trial: number; basic: number; pro: number }): TableQuotaSet {
  return tableQuotaSetOf({
    trial: { used: used.trial, shared: 0 },
    basic: { used: used.basic, shared: 0 },
    pro: { used: used.pro, shared: 0 },
  });
}

/** 说明弹窗里的一行现状：`基础表格：已用 2/3，还剩 1 个` */
export function tableQuotaSummary(quota: TableQuota): string {
  return `${tableKindLabel(quota.kind)}：已用 ${quota.used}/${quota.total}，还剩 ${quota.remaining} 个`;
}

/** 三类合计还能再添加几个：侧边栏「添加」按钮是否可点、名额用完的提示用它 */
export function tableQuotaRemaining(quota: TableQuotaSet): number {
  return (quota.trial?.remaining ?? 0) + countOf(quota.basic?.remaining) + countOf(quota.pro?.remaining);
}

/** 某一类还有没有名额（新建表格表单据此把选项标灰） */
export function tableQuotaHasRoom(quota: TableQuotaSet, kind: TableKind | string | null | undefined): boolean {
  return (quota[asTableKind(kind)]?.remaining ?? 0) > 0;
}

