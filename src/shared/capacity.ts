/**
 * 单表容量的展示口径：Worker 与前端共用。
 *
 * 这里只放纯函数（不读环境变量、不碰数据库），所以服务端能拿它拼错误文案、
 * 前端能拿它画侧边栏进度条。上限本身由 Worker 读环境变量得出，
 * 见 `src/worker/capacity.ts`；数据结构见 `types.ts` 的 `DatabaseCapacity`。
 *
 * 专业表格 `unlimited = true`（记录数 / 附件上限都是 0 = 不限），文案统一显示
 * 「不限」，永远不判满、进度条恒为正常档位。
 */
import { retentionText, tableKindMeta } from './tableKind';
import type { DatabaseCapacity } from './types';

/** 容量提示开始变色的占比：记录数 / 附件占用任一维度超过 80% 就转黄提醒 */
export const CAPACITY_WARN_RATIO = 0.8;

/** 专业表格（或上限为 0 的表）＝ 容量不限：进度条 / 文案都走「不限」分支 */
export function capacityUnlimited(capacity: DatabaseCapacity): boolean {
  if (capacity.unlimited) return true;
  return capacity.maxRecords <= 0 && capacity.maxStorageBytes <= 0;
}

/** 人类可读的容量：1024 → `1 KB`、1.5 MB、1 GB */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // 字节不带小数；上了 KB 之后按量级保留 0~2 位，避免出现 `1.0000000002 MB`
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${Number(value.toFixed(digits))} ${units[unit]}`;
}

/** 用量占上限的比例；上限配成 0 这类非法值时按 0 处理，不产生 NaN */
function ratioOf(used: number, max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 0;
  return Math.max(0, used) / max;
}

/** 记录数与附件占用里更紧张的那个占比（0~1；历史数据已超限时会 > 1，画条时再截断） */
export function capacityRatio(capacity: DatabaseCapacity): number {
  return Math.max(
    ratioOf(capacity.records, capacity.maxRecords),
    ratioOf(capacity.storageBytes, capacity.maxStorageBytes),
  );
}

/** 进度条宽度（百分比，保留一位小数，最大 100） */
export function capacityPercent(capacity: DatabaseCapacity): number {
  return Math.min(100, Math.round(capacityRatio(capacity) * 1000) / 10);
}

/** 进度条档位：`ok` 正常、`warn` 快满了（已用 >= 80%）、`full` 已到上限 */
export function capacityLevelOfRatio(ratio: number): 'ok' | 'warn' | 'full' {
  if (ratio >= 1) return 'full';
  return ratio >= CAPACITY_WARN_RATIO ? 'warn' : 'ok';
}

/** 一侧容量的可画状态（提示框里的两条小条各用一份；侧边栏硬盘图标只看整体档位） */
export interface CapacitySide {
  /** 已用占上限的比例（0~1；历史数据超过上限时会 > 1） */
  ratio: number;
  /** 剩余占上限的比例（0~1，到上限 / 超限都是 0）——进度条画的就是它 */
  remainingRatio: number;
  /** 剩余量：记录数是条数、附件是字节（到上限为 0） */
  remaining: number;
  /** 上限 */
  max: number;
  /** 这一侧自己的档位（另一侧满了不会把它染红） */
  level: 'ok' | 'warn' | 'full';
}

function sideOf(used: number, max: number): CapacitySide {
  const ratio = ratioOf(used, max);
  return {
    ratio,
    remainingRatio: Math.max(0, 1 - ratio),
    remaining: Math.max(0, max - used),
    max,
    level: capacityLevelOfRatio(ratio),
  };
}

/** 记录数那一侧（提示框里「记录」那条小条） */
export function capacityRecordsSide(capacity: DatabaseCapacity): CapacitySide {
  return sideOf(capacity.records, capacity.maxRecords);
}

/** 附件占用那一侧（提示框里「附件」那条小条） */
export function capacityStorageSide(capacity: DatabaseCapacity): CapacitySide {
  return sideOf(capacity.storageBytes, capacity.maxStorageBytes);
}

/** 用量明细（悬停提示的第一行 / 达到上限后的说明都用它） */
export function capacityUsageSummary(capacity: DatabaseCapacity): string {
  if (capacityUnlimited(capacity)) {
    return `记录 ${capacity.records} 条 · 附件 ${formatBytes(capacity.storageBytes)}（不限容量）`;
  }
  return `记录 ${capacity.records}/${capacity.maxRecords} 条 · 附件 ${formatBytes(capacity.storageBytes)}/${formatBytes(capacity.maxStorageBytes)}`;
}

/** 容量提示框里「记录」那一行：`已用 12 / 500 条 · 剩余 488 条`（不限容量时只报已用） */
export function capacityRecordsUsageText(capacity: DatabaseCapacity): string {
  if (capacityUnlimited(capacity)) return `已用 ${capacity.records} 条 · 不限`;
  return `已用 ${capacity.records} / ${capacity.maxRecords} 条 · 剩余 ${capacityRecordsSide(capacity).remaining} 条`;
}

/** 容量提示框里「附件」那一行：`已用 3.2 MB / 1 GB · 剩余 1016.8 MB`（不限容量时只报已用） */
export function capacityStorageUsageText(capacity: DatabaseCapacity): string {
  if (capacityUnlimited(capacity)) return `已用 ${formatBytes(capacity.storageBytes)} · 不限`;
  return `已用 ${formatBytes(capacity.storageBytes)} / ${formatBytes(capacity.maxStorageBytes)} · 剩余 ${formatBytes(
    capacityStorageSide(capacity).remaining,
  )}`;
}

/** 悬停提示：用量明细 + 当前档位的说明 */
export function capacityTooltip(capacity: DatabaseCapacity): string {
  const usage = capacityUsageSummary(capacity);
  if (capacityUnlimited(capacity)) {
    return `${usage}\n${tableKindMeta(capacity.kind).label}：记录、附件与存储时间都不限制`;
  }
  if (!capacity.atCapacity) {
    return `${usage}\n已用 ${capacityPercent(capacity)}%：到上限后只能查看和查询，新增记录 / 上传附件 / 新建视图会停用`;
  }
  return `${usage}\n${capacityBlockedHint(capacity)}`;
}

/**
 * 保留期提示：基础表格的「数据保留 1 年，超期自动清除」写在容量浮层里，
 * 专业表格返回空串（不限保留期，不用提示）。
 */
export function capacityRetentionHint(capacity: DatabaseCapacity): string {
  if (capacityUnlimited(capacity)) return '';
  const meta = tableKindMeta(capacity.kind);
  const days = capacity.retentionDays ?? meta.retentionDays;
  if (!Number.isFinite(days) || days <= 0) return '';
  return `${meta.label}的数据保留${retentionText(days)}：超过这个时间的记录与附件会被自动清除`;
}

/**
 * 达到上限后的说明句：表格页顶部的提示条、新建 / 复制 / 上传前的拦截都用它。
 * 没到上限时返回空串（调用方 `if (hint)` 即可）。
 */
export function capacityBlockedHint(capacity: DatabaseCapacity): string {
  if (!capacity.atCapacity) return '';
  const full: string[] = [];
  if (capacity.recordsFull) full.push(`记录 ${capacity.records}/${capacity.maxRecords} 条`);
  if (capacity.storageFull) {
    full.push(`附件 ${formatBytes(capacity.storageBytes)}/${formatBytes(capacity.maxStorageBytes)}`);
  }
  return `${tableKindMeta(capacity.kind).label}已达容量上限（${full.join(' · ')}）：只能查看和查询，新增记录、复制记录、上传附件与新建视图都已停用，删除一些数据后自动恢复`;
}
