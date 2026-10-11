/**
 * /api/quota - 表格名额（按类型分开算：试用 / 基础 / 专业各自还能再添加几张）。
 *
 * 侧边栏「你有 N 个基础表格可」、说明弹窗与购买都用它，口径与 `src/shared/quota.ts`
 * 保持一致：
 *   - 已用 = 自己拥有的、未归档的、这一类型的表格数；
 *   - 赠额：基础 / 专业 = 这一类型的表格被分享出去的次数（视图定向分享 + 公开链接 +
 *     协作者，各算一次）；试用 = 成功邀请新用户注册得到的赠额（`trial_table_grants`，
 *     每邀请一位新用户 +1）；
 *   - 已购买 = `table_purchases` 里这一类型的 count 之和（试用表格不卖，恒为 0）；
 *   - 默认名额：试用 1（新注册就送一张免费试用表）、基础 / 专业 0。
 *
 * 购买走 `POST /api/quota/purchases`（body `{ kind, count }`）：写一条流水并**立刻**
 * 生效 —— 买几个就多几个可添加的表格。支付网关还没接入，渠道先记 `self-serve`，
 * 见 migrations/control/0011_table_kinds_and_purchases.sql 的说明。
 */
import { MAX_PURCHASE_COUNT, tableQuotaSetOf } from '../../shared/quota';
import { BUYABLE_TABLE_KINDS } from '../../shared/tableKind';
import type { TableKind, TablePurchase, TableQuotaSet } from '../../shared/types';
import { requireUser } from '../auth';
import {
  asEnum,
  asNumberValue,
  asString,
  badRequest,
  json,
  newId,
  readJson,
  sqlNumber,
  type SqlRow,
} from '../http';
import type { Env, RequestContext, Route } from '../types';
import { forEachShardSafe } from '../shards';
import { countInviteTrialGrants } from '../trialGrants';

/**
 * 一次购买只认「可以买的类型」（试用表格是免费送的不卖，见 shared/tableKind.ts）：
 * 写库前先卡住，库里不会出现第三种值。
 */
const PURCHASE_KINDS = BUYABLE_TABLE_KINDS;

/**
 * 分片里的名额统计列：`used_*`（自己拥有）/ `link_*`（公开链接）/ `view_*` / `member_*`。
 * 公开链接 / 视图定向分享 / 协作者只给基础与专业表格加名额，所以试用只有 `used_trial`
 * 一列 —— 它的赠额来自用户库的 `trial_table_grants`（每成功邀请一位新用户 +1）。
 */
const QUOTA_COUNT_COLUMNS = [
  'used_trial',
  'used_basic',
  'used_pro',
  'link_basic',
  'link_pro',
  'view_basic',
  'view_pro',
  'member_basic',
  'member_pro',
] as const;

/**
 * 算一个账号当前的名额（会话下发、`/api/quota` 与购买响应共用）。
 *
 * 存储拆分之后数据不在一个库里：表格侧的统计逐分片算再相加（某个分片暂时不可用
 * 只会少算几张表），购买流水仍然在用户库的 `table_purchases`。
 */
export async function loadTableQuota(env: Env, userId: string): Promise<TableQuotaSet> {
  const scans = await forEachShardSafe(env, async (_shard, db) => {
    const row = await db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM databases
             WHERE owner_id = ? AND is_archived = 0 AND kind = 'trial') AS used_trial,
           (SELECT COUNT(*) FROM databases
             WHERE owner_id = ? AND is_archived = 0 AND kind = 'basic') AS used_basic,
           (SELECT COUNT(*) FROM databases
             WHERE owner_id = ? AND is_archived = 0 AND kind = 'pro') AS used_pro,
           (SELECT COUNT(*) FROM shares s JOIN databases d ON d.id = s.database_id
             WHERE d.owner_id = ? AND d.is_archived = 0 AND d.kind = 'basic') AS link_basic,
           (SELECT COUNT(*) FROM shares s JOIN databases d ON d.id = s.database_id
             WHERE d.owner_id = ? AND d.is_archived = 0 AND d.kind = 'pro') AS link_pro,
           (SELECT COUNT(*) FROM view_shares v JOIN databases d ON d.id = v.database_id
             WHERE d.owner_id = ? AND d.is_archived = 0 AND d.kind = 'basic') AS view_basic,
           (SELECT COUNT(*) FROM view_shares v JOIN databases d ON d.id = v.database_id
             WHERE d.owner_id = ? AND d.is_archived = 0 AND d.kind = 'pro') AS view_pro,
           (SELECT COUNT(*) FROM database_members m JOIN databases d ON d.id = m.database_id
             WHERE d.owner_id = ? AND d.is_archived = 0 AND d.kind = 'basic') AS member_basic,
           (SELECT COUNT(*) FROM database_members m JOIN databases d ON d.id = m.database_id
             WHERE d.owner_id = ? AND d.is_archived = 0 AND d.kind = 'pro') AS member_pro`,
      )
      .bind(userId, userId, userId, userId, userId, userId, userId, userId, userId)
      .first<SqlRow>();
    return row ?? {};
  });

  const counts: Record<(typeof QUOTA_COUNT_COLUMNS)[number], number> = {
    used_trial: 0,
    used_basic: 0,
    used_pro: 0,
    link_basic: 0,
    link_pro: 0,
    view_basic: 0,
    view_pro: 0,
    member_basic: 0,
    member_pro: 0,
  };
  for (const scan of scans) {
    if (!scan.value) continue;
    for (const column of QUOTA_COUNT_COLUMNS) counts[column] += sqlNumber(scan.value, column);
  }

  const [purchaseRow, invitedGrants] = await Promise.all([
    env.DB.prepare(
      `SELECT
         (SELECT COALESCE(SUM(p.count), 0) FROM table_purchases p
           WHERE p.user_id = ? AND p.kind = 'basic') AS bought_basic,
         (SELECT COALESCE(SUM(p.count), 0) FROM table_purchases p
           WHERE p.user_id = ? AND p.kind = 'pro') AS bought_pro`,
    )
      .bind(userId, userId)
      .first<SqlRow>(),
    // 试用名额的赠额在用户库：每成功邀请一位新用户注册写一行（见 worker/trialGrants.ts）
    countInviteTrialGrants(env, userId),
  ]);

  return tableQuotaSetOf({
    trial: {
      // 注册送的那 1 个由 shared/quota.ts 的 BASE_TABLE_QUOTA 直接给出，不在这张流水表里
      used: counts.used_trial,
      shared: invitedGrants,
      purchased: 0,
    },
    basic: {
      used: counts.used_basic,
      shared: counts.link_basic + counts.view_basic + counts.member_basic,
      purchased: sqlNumber(purchaseRow ?? {}, 'bought_basic'),
    },
    pro: {
      used: counts.used_pro,
      shared: counts.link_pro + counts.view_pro + counts.member_pro,
      purchased: sqlNumber(purchaseRow ?? {}, 'bought_pro'),
    },
  });
}

async function quotaHandler(ctx: RequestContext): Promise<Response> {
  const user = await requireUser(ctx.request, ctx.env);
  return json({ quota: await loadTableQuota(ctx.env, user.id) });
}

/**
 * 购买表格名额：写一条购买流水 + 立刻加名额，响应里带上最新的完整名额。
 * 支付还没接入，所以现在没有「金额 / 支付凭证」这一步，`channel` 记 `self-serve`。
 */
async function purchaseHandler(ctx: RequestContext): Promise<Response> {
  const user = await requireUser(ctx.request, ctx.env);
  const body = await readJson(ctx.request);

  const kind: TableKind = asEnum(body.kind ?? 'basic', PURCHASE_KINDS, '表格类型');
  const count = Math.floor(asNumberValue(body.count ?? 1, '购买数量'));
  if (count < 1) throw badRequest('购买数量至少 1 个');
  if (count > MAX_PURCHASE_COUNT) throw badRequest(`一次最多购买 ${MAX_PURCHASE_COUNT} 个名额`);
  const note = asString(body.note, '备注', { max: 200 });

  const purchase: TablePurchase = {
    id: newId(),
    userId: user.id,
    kind,
    count,
    channel: 'self-serve',
    note,
    createdAt: Date.now(),
  };

  await ctx.env.DB.prepare(
    `INSERT INTO table_purchases (id, user_id, kind, count, channel, note, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      purchase.id,
      purchase.userId,
      purchase.kind,
      purchase.count,
      purchase.channel,
      purchase.note,
      user.id,
      purchase.createdAt,
    )
    .run();

  return json({ quota: await loadTableQuota(ctx.env, user.id), purchase }, { status: 201 });
}

export const quotaRoutes: Route[] = [
  { method: 'GET', path: '/api/quota', handler: quotaHandler },
  { method: 'POST', path: '/api/quota/purchases', handler: purchaseHandler },
];

