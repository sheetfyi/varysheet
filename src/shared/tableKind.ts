/**
 * 表格类型：试用表格（trial）/ 基础表格（basic）/ 专业表格（pro）—— Worker 与前端共用的一份口径。
 *
 * 这里只放纯数据与纯函数（不读环境变量、不碰数据库）：服务端拿它决定容量 / 列数 /
 * 视图数上限与数据保留期，前端拿它渲染类型选择、对比说明与列表里的徽标。
 *
 * 三类的区别（容量与保留期的执行见 `src/worker/capacity.ts`、
 * `src/worker/retention.ts`）：
 *   容量     试用：100 条记录 / 0.5GB 附件   基础：500 条记录 / 1GB 附件   专业：不限
 *   存储时间 试用：半年（超期自动清除）        基础：1 年（超期自动清除）   专业：永久保留
 *   列数     试用：10 列                      基础：15 列                 专业：20 列
 *   视图数   试用：3 个                       基础：5 个                  专业：10 个
 *   购买价格 试用：免费（不单卖）              基础：9.9 元/月             专业：99.9 元/月
 *
 * 购买价格写成「每月单价（分）」放在 §TABLE_KIND_META 里。购买时长按「单位 × 数量」选：
 * 时长单位固定是「月」（`PURCHASE_UNIT_MONTHS`），时长数量可选 1 ~ 12 个
 * （`PURCHASE_MONTH_UNITS`），总月数 = 单位月数 × 数量（`purchaseMonthsOf`），
 * 金额 = 每月单价 × 购买数量 × 总月数（`purchaseAmountCents`）。
 *
 * 「不限」在数据里统一写成 0（`maxRecords <= 0` 即不限制），前端据此显示「不限」。
 */
import type { TableKind } from './types';

/** 一天的毫秒数（保留期换算用） */
export const DAY_MS = 24 * 60 * 60 * 1000;
const BYTES_PER_GB = 1024 * 1024 * 1024;
const BYTES_PER_MB = 1024 * 1024;

export interface TableKindMeta {
  kind: TableKind;
  /** 完整名称：试用表格 / 基础表格 / 专业表格 */
  label: string;
  /** 两三个字的短名：试用 / 基础 / 专业（列表徽标、下拉框用） */
  shortLabel: string;
  /** 一句话概括（类型选择旁边的说明） */
  summary: string;
  /** 记录数上限；0 = 不限 */
  maxRecords: number;
  /** 附件容量上限（字节）；0 = 不限 */
  maxStorageBytes: number;
  /** 数据保留期（天）；0 = 永久保留 */
  retentionDays: number;
  /** 字段（列）数上限 */
  maxProperties: number;
  /** 视图数上限 */
  maxViews: number;
  /** 每月单价（分）；0 = 这一类不单卖（试用表格是免费送的） */
  monthlyPriceCents: number;
}

export const TABLE_KIND_META: Record<TableKind, TableKindMeta> = {
  trial: {
    kind: 'trial',
    label: '试用表格',
    shortLabel: '试用',
    summary: '100 条记录 / 0.5GB 附件，数据保留半年，最多 10 列 / 3 个视图',
    maxRecords: 100,
    maxStorageBytes: 512 * BYTES_PER_MB, // 0.5GB
    retentionDays: 180, // 半年；超期的记录与附件会被定时任务清除
    maxProperties: 10,
    maxViews: 3,
    monthlyPriceCents: 0, // 免费送 1 个，不单卖
  },
  basic: {
    kind: 'basic',
    label: '基础表格',
    shortLabel: '基础',
    summary: '500 条记录 / 1GB 附件，数据保留 1 年，最多 15 列 / 5 个视图',
    maxRecords: 500,
    maxStorageBytes: 1024 * BYTES_PER_MB, // 1GB
    retentionDays: 365, // 一年；超过一年的记录与附件会被定时任务清除
    maxProperties: 15,
    maxViews: 5,
    monthlyPriceCents: 990, // 9.9 元/月
  },
  pro: {
    kind: 'pro',
    label: '专业表格',
    shortLabel: '专业',
    summary: '记录、附件与存储时间都不限，最多 20 列 / 10 个视图',
    maxRecords: 0,
    maxStorageBytes: 0,
    retentionDays: 0,
    maxProperties: 20,
    maxViews: 10,
    monthlyPriceCents: 9990, // 99.9 元/月
  },
};

/** 下拉框 / 说明弹窗里的类型顺序（新建表格时先给免费的试用表格） */
export const TABLE_KINDS: TableKind[] = ['trial', 'basic', 'pro'];

/**
 * 可以**购买**名额的类型（试用表格是免费送的、不卖）：
 * 额度弹窗的购买下拉框、`POST /api/quota/purchases` 的白名单都用它。
 */
export const BUYABLE_TABLE_KINDS: TableKind[] = ['basic', 'pro'];


/**
 * 列数 / 视图数到达上限时的错误码：建字段、建视图接口 403 用它，
 * 前端据此把提示写成「删掉一些再添加，或升级成专业表格」。
 */
export const TABLE_LIMIT_EXCEEDED = 'limit_exceeded';

/**
 * 任何来路不明的值都当成基础表格（老数据、老客户端都不会掉进「未知类型」）。
 * 注意 `trial` 是有效值：老部署里没有这类数据，但新写入的 trial 表必须原样读回来。
 */
export function asTableKind(value: unknown): TableKind {
  if (value === 'trial') return 'trial';
  return value === 'pro' ? 'pro' : 'basic';
}

export function tableKindMeta(kind: TableKind | string | null | undefined): TableKindMeta {
  return TABLE_KIND_META[asTableKind(kind)];
}

export function tableKindLabel(kind: TableKind | string | null | undefined): string {
  return tableKindMeta(kind).label;
}

/** 「1 年」「半年」「永久保留」「30 天」这类保留期文案 */
export function retentionText(days: number): string {
  if (!Number.isFinite(days) || days <= 0) return '永久保留';
  if (days === 365) return '1 年';
  if (days % 365 === 0) return `${days / 365} 年`;
  if (days === 180) return '半年';
  if (days % 30 === 0 && days < 365) return `${days / 30} 个月`;
  return `${Math.floor(days)} 天`;
}

/** 字节数 → `1GB` / `512MB` / `200KB` */
export function storageText(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '不限';
  if (bytes >= BYTES_PER_GB) return `${Math.round(bytes / BYTES_PER_GB)}GB`;
  if (bytes >= BYTES_PER_MB) return `${Math.round(bytes / BYTES_PER_MB)}MB`;
  return `${Math.round(bytes / 1024)}KB`;
}

/** 「500 条记录」/「不限」 */
export function recordsText(maxRecords: number): string {
  if (!Number.isFinite(maxRecords) || maxRecords <= 0) return '不限';
  return `${maxRecords} 条记录`;
}

/** 某个类型的一句话容量口径：列表徽标的悬停提示、类型选择都能用 */
export function tableKindCapacityText(kind: TableKind | string | null | undefined): string {
  const meta = tableKindMeta(kind);
  if (meta.maxRecords <= 0 && meta.maxStorageBytes <= 0) {
    return `${recordsText(meta.maxRecords)}、${storageText(meta.maxStorageBytes)}附件，数据${retentionText(meta.retentionDays)}`;
  }
  return `${recordsText(meta.maxRecords)} · ${storageText(meta.maxStorageBytes)}附件 · 数据保留${retentionText(meta.retentionDays)}`;
}

/* ------------------------------------------------------------ 购买价格与时长的口径 */

/**
 * 购买时长的**单位**：固定按「月」计价（1 个单位 = 1 个月）。
 * 说明弹窗里「时长单位」下拉就用它 —— 现在只放一个选项，以后要加「年」只在这里扩展。
 */
export const PURCHASE_UNIT_MONTHS = 1;

/**
 * 「时长单位」下拉的选项：`key` 给 React 当 key、`label` 是显示名、
 * `months` 是「一个单位等于几个月」。需求是时长以月为单位、多少个月由后面的
 * 「时长数量」选，所以现在只有「月」这一项。
 */
export const PURCHASE_UNITS: readonly { key: string; label: string; months: number }[] = [
  { key: 'month', label: '月', months: PURCHASE_UNIT_MONTHS },
];

/** 「时长数量」最多能选几个单位（单位是月 → 最多 12 个月，覆盖原来的「按年」） */
export const MAX_PURCHASE_MONTH_UNITS = 12;

/** 「时长数量」下拉的可选值：1 ~ 12 个（单位是月，所以就是 1 ~ 12 个月） */
export const PURCHASE_MONTH_UNITS: readonly number[] = Array.from(
  { length: MAX_PURCHASE_MONTH_UNITS },
  (_unused, index) => index + 1,
);

/** 服务端认可的**总时长**下限（月）：单位 × 数量至少 1 个月 */
export const MIN_PURCHASE_MONTHS = PURCHASE_UNIT_MONTHS;

/** 服务端认可的**总时长**上限（月）：1 个月 × 12 个 = 12 个月 */
export const MAX_PURCHASE_MONTHS = PURCHASE_UNIT_MONTHS * MAX_PURCHASE_MONTH_UNITS;

/** 总月数 = 时长单位（月）× 时长数量；说明弹窗与 `POST /api/quota/purchases` 共用这一条算式 */
export function purchaseMonthsOf(unitMonths: number, unitCount: number): number {
  const unit = Number.isFinite(unitMonths) ? Math.max(1, Math.trunc(unitMonths)) : PURCHASE_UNIT_MONTHS;
  const count = Number.isFinite(unitCount) ? Math.max(1, Math.trunc(unitCount)) : 1;
  return unit * count;
}

/** 总时长能不能买：整数且落在 1 ~ `MAX_PURCHASE_MONTHS` 个月之间（服务端白名单） */
export function isPurchasableMonths(months: number): boolean {
  return Number.isInteger(months) && months >= MIN_PURCHASE_MONTHS && months <= MAX_PURCHASE_MONTHS;
}

/** 某一类的每月单价（分）；0 = 不单卖（试用表格） */
export function tableKindMonthlyPriceCents(kind: TableKind | string | null | undefined): number {
  return tableKindMeta(kind).monthlyPriceCents;
}

/** 分 → `9.9 元` / `99 元` / `免费`（0 分） */
export function formatPriceCents(cents: number): string {
  if (!Number.isFinite(cents) || cents <= 0) return '免费';
  const yuan = cents / 100;
  return `${Number.isInteger(yuan) ? yuan : Number(yuan.toFixed(2))} 元`;
}

/** 「9.9 元/月」/「免费」（单价文案，对比表与购买区都用它） */
export function tableKindPriceText(kind: TableKind | string | null | undefined): string {
  const cents = tableKindMonthlyPriceCents(kind);
  return cents > 0 ? `${formatPriceCents(cents)}/月` : '免费';
}

/** 总时长文案：`1 个月` / `12 个月（一年）`（购买提示、下拉框选项都用它） */
export function purchaseMonthsLabel(months: number): string {
  if (!Number.isFinite(months)) return '时长未知';
  const value = Math.max(0, Math.trunc(months));
  return value === 12 ? '12 个月（一年）' : `${value} 个月`;
}

/** 一单金额（分）= 每月单价 × 数量 × 月数；试用表格（单价 0）恒为 0 */
export function purchaseAmountCents(
  kind: TableKind | string | null | undefined,
  count: number,
  months: number,
): number {
  const unit = tableKindMonthlyPriceCents(kind);
  if (unit <= 0) return 0;
  const safeCount = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
  const safeMonths = Number.isFinite(months) ? Math.max(0, Math.trunc(months)) : 0;
  return unit * safeCount * safeMonths;
}

/** 购买区的价格明细：`9.9 元/月 × 2 个 × 12 个月 = 237.6 元` */
export function purchasePriceText(
  kind: TableKind | string | null | undefined,
  count: number,
  months: number,
): string {
  const unit = tableKindMonthlyPriceCents(kind);
  const total = formatPriceCents(purchaseAmountCents(kind, count, months));
  if (unit <= 0) return `这一类不单卖：${total}`;
  const safeCount = Math.max(0, Math.trunc(count));
  const safeMonths = Math.max(0, Math.trunc(months));
  return `${formatPriceCents(unit)}/月 × ${safeCount} 个 × ${safeMonths} 个月 = ${total}`;
}

/** 对比表里的一行：试用表格 / 基础表格 / 专业表格各自怎么说 */
export interface TableKindFeature {
  label: string;
  trial: string;
  basic: string;
  pro: string;
}

/** 「试用 / 基础 / 专业表格功能区别」对比表：说明弹窗里按 TABLE_KINDS 顺序渲染 */
export const TABLE_KIND_FEATURES: TableKindFeature[] = [
  {
    label: '容量',
    trial: `${recordsText(TABLE_KIND_META.trial.maxRecords)} / ${storageText(TABLE_KIND_META.trial.maxStorageBytes)} 附件`,
    basic: `${recordsText(TABLE_KIND_META.basic.maxRecords)} / ${storageText(TABLE_KIND_META.basic.maxStorageBytes)} 附件`,
    pro: '不限',
  },
  {
    label: '存储时间',
    trial: `${retentionText(TABLE_KIND_META.trial.retentionDays)}（超期自动清除）`,
    basic: `${retentionText(TABLE_KIND_META.basic.retentionDays)}（超期自动清除）`,
    pro: retentionText(TABLE_KIND_META.pro.retentionDays),
  },
  {
    label: '列数',
    trial: `${TABLE_KIND_META.trial.maxProperties} 列`,
    basic: `${TABLE_KIND_META.basic.maxProperties} 列`,
    pro: `${TABLE_KIND_META.pro.maxProperties} 列`,
  },
  {
    label: '视图数',
    trial: `${TABLE_KIND_META.trial.maxViews} 个`,
    basic: `${TABLE_KIND_META.basic.maxViews} 个`,
    pro: `${TABLE_KIND_META.pro.maxViews} 个`,
  },
  {
    label: '名额来源',
    trial: '注册送 1 个，邀请新用户 +1（不能购买）',
    basic: '只能购买（分享不赠额）',
    pro: '只能购买（分享不赠额）',
  },
  {
    label: '价格',
    trial: '免费（注册就送 1 个）',
    basic: `${tableKindPriceText('basic')}，按时长购买（单位月 × 时长数量）`,
    pro: `${tableKindPriceText('pro')}，按时长购买（单位月 × 时长数量）`,
  },
];
