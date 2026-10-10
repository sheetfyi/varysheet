/**
 * 表格名额（「还能再添加几张表格」）的规则与计算：Worker 与前端共用。
 *
 * 名额**按表格类型分开算**：基础表格名额只能用来加基础表格，专业表格名额只能用来加
 * 专业表格（类型口径见 `tableKind.ts`）。这里只放纯函数（不读环境变量、不碰数据库）：
 * 服务端拿它算 `/api/quota`，前端拿它兜底显示与文案。数据结构见 `types.ts` 的
 * `TableQuota` / `TableQuotaSet`。
 */
import { asTableKind, tableKindLabel } from './tableKind';
import type { TableKind, TableQuota, TableQuotaSet } from './types';

/** 新注册账号的默认表格名额：0 个（原来默认送 1 个基础表格，已取消） */
export const BASE_TABLE_QUOTA = 0;

/** 每分享一次表格（视图定向分享 / 公开链接 / 协作者）就能多添加 1 个同类型表格 */
export const SHARE_TABLE_QUOTA = 1;

/** 一次购买最多能选的数量（说明弹窗里的购买下拉框） */
export const MAX_PURCHASE_COUNT = 10;

/** 名额用完时的错误码：建表接口 403 用它，前端据此把提示写成「去分享 / 去购买」 */
export const QUOTA_EXCEEDED = 'quota_exceeded';

/** 名额规则的三句话：侧边栏的说明弹窗原样展示，改口径时只改这里 */
export const TABLE_QUOTA_RULES: string[] = [
  '表格分两类：基础表格 / 专业表格，两边的名额分开计算。',
  `新注册账号没有默认名额：每分享一次表格（视图定向分享 / 公开链接 / 协作者），对应类型的可添加数量就 +${SHARE_TABLE_QUOTA}。`,
  '也可以直接购买名额：买几个就多几个可添加的表格，购买时可选基础表格 / 专业表格。',
];

function countOf(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

/** 按「已用 / 已分享 / 已购买」算某一类的总名额与剩余可添加数量 */
export function tableQuotaOf(input: {
  kind: TableKind;
  used: number;
  shared: number;
  purchased?: number;
}): TableQuota {
  const used = countOf(input.used);
  const shared = countOf(input.shared);
  const purchased = countOf(input.purchased);
  const total = BASE_TABLE_QUOTA + shared + purchased;
  return { kind: input.kind, used, shared, purchased, total, remaining: Math.max(0, total - used) };
}

/** 两类各自的「已用 / 已分享 / 已购买（可选）」→ 完整名额 */
export function tableQuotaSetOf(input: {
  basic: { used: number; shared: number; purchased?: number };
  pro: { used: number; shared: number; purchased?: number };
}): TableQuotaSet {
  return {
    basic: tableQuotaOf({ kind: 'basic', ...input.basic }),
    pro: tableQuotaOf({ kind: 'pro', ...input.pro }),
  };
}

/** 只知道每类已用几张表时的兜底名额（接口还没返回时先按「已用」显示，别空着） */
export function quotaSetFromUsed(used: { basic: number; pro: number }): TableQuotaSet {
  return tableQuotaSetOf({
    basic: { used: used.basic, shared: 0 },
    pro: { used: used.pro, shared: 0 },
  });
}

/** 说明弹窗里的一行现状：`基础表格：已添加 2 个 · 共 3 个名额 · 还剩 1 个` */
export function tableQuotaSummary(quota: TableQuota): string {
  return `${tableKindLabel(quota.kind)}：已添加 ${quota.used} 个 · 共 ${quota.total} 个名额 · 还剩 ${quota.remaining} 个`;
}

/** 两类合计还能再添加几个：侧边栏「添加」按钮是否可点、名额用完的提示用它 */
export function tableQuotaRemaining(quota: TableQuotaSet): number {
  return countOf(quota.basic.remaining) + countOf(quota.pro.remaining);
}

/** 某一类还有没有名额（新建表格表单据此把选项标灰） */
export function tableQuotaHasRoom(quota: TableQuotaSet, kind: TableKind | string | null | undefined): boolean {
  return quota[asTableKind(kind)].remaining > 0;
}

