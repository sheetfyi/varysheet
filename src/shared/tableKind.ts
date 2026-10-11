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
 *   列数     试用：10 列                      基础：10 列                 专业：20 列
 *   视图数   试用：3 个                       基础：3 个                  专业：10 个
 *   购买价格 试用：免费（不单卖）              基础：9.9 元/月             专业：99.9 元/月
 *
 * 购买价格写成「每月单价（分）」放在 §TABLE_KIND_META 里，购买时可以按月（1 个月）
 * 或按年（12 个月）买，金额 = 单价 × 数量 × 月数，见 §purchaseAmountCents。
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
    summary: '500 条记录 / 1GB 附件，数据保留 1 年，最多 10 列 / 3 个视图',
    maxRecords: 500,
    maxStorageBytes: 1024 * BYTES_PER_MB, // 1GB
    retentionDays: 365, // 一年；超过一年的记录与附件会被定时任务清除
    maxProperties: 10,
    maxViews: 3,
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
 * 购买时长可选项（月）：按月买 1 个月、按年买 12 个月。
 * 说明弹窗的时长下拉框、`POST /api/quota/purchases` 的白名单都用它。
 */
export const PURCHASE_MONTHS: readonly number[] = [1, 12];

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

/** 「按月（1 个月）」/「按年（12 个月）」 */
export function purchaseMonthsLabel(months: number): string {
  if (months === 12) return '按年（12 个月）';
  if (months === 1) return '按月（1 个月）';
  return `${months} 个月`;
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
    pro: '分享 +1 / 购买',
  },
  {
    label: '价格',
    trial: '免费（注册就送 1 个）',
    basic: `${tableKindPriceText('basic')}，可按月 / 按年购买`,
    pro: `${tableKindPriceText('pro')}，可按月 / 按年购买`,
  },
];
