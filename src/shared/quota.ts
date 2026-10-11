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

/** 名额规则：侧边栏的说明弹窗原样展示，改口径时只改这里 */
export const TABLE_QUOTA_RULES: string[] = [
  '表格分三类：试用表格 / 基础表格 / 专业表格，三边的名额分开计算。',
  `新注册账号送 ${BASE_TABLE_QUOTA.trial} 个试用表格（100 条记录 / 0.5GB 附件 / 数据保留半年）；每成功邀请一位新用户注册再 +${INVITE_TRIAL_TABLE_QUOTA} 个。试用表格不单卖。`,
  `基础表格没有赠送名额（分享也不增加）：只能购买，${tableKindPriceText('basic')}，买几个就多几个可添加的基础表格。`,
  `专业表格同样没有赠送名额（分享也不增加）：只能购买，${tableKindPriceText('pro')}，买几个就多几个可添加的专业表格。`,
  `购买时按时长买：先选时长单位（「月」1 个月 / 「年」12 个月），再选时长数量（月 1 ~ 12 个、年 1 ~ 5 个），总时长 ${MIN_PURCHASE_MONTHS} ~ ${MAX_PURCHASE_MONTHS} 个月；金额 = 每月单价 × 购买数量 × 总月数。`,
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

/** 说明弹窗里的一行现状：`基础表格：已添加 2 个 · 共 3 个名额 · 还剩 1 个` */
export function tableQuotaSummary(quota: TableQuota): string {
  return `${tableKindLabel(quota.kind)}：已添加 ${quota.used} 个 · 共 ${quota.total} 个名额 · 还剩 ${quota.remaining} 个`;
}

/** 三类合计还能再添加几个：侧边栏「添加」按钮是否可点、名额用完的提示用它 */
export function tableQuotaRemaining(quota: TableQuotaSet): number {
  return (quota.trial?.remaining ?? 0) + countOf(quota.basic?.remaining) + countOf(quota.pro?.remaining);
}

/** 某一类还有没有名额（新建表格表单据此把选项标灰） */
export function tableQuotaHasRoom(quota: TableQuotaSet, kind: TableKind | string | null | undefined): boolean {
  return (quota[asTableKind(kind)]?.remaining ?? 0) > 0;
}

