/**
 * /api/quota - 表格名额（按类型分开算：试用 / 基础 / 专业各自还能再添加几张）。
 *
 * 侧边栏「你有 N 个表格可添加」、说明弹窗与购买都用它，口径与 `src/shared/quota.ts`
 * 保持一致：
 *   - 已用 = 自己拥有的、未归档的、这一类型的表格数；
 *   - 赠额：只有试用表格有 —— 成功邀请新用户注册得到的赠额（`trial_table_grants`，
 *     每邀请一位新用户 +1）；基础表格与专业表格都没有赠额（**分享也不加**，只能购买）；
 *   - 已购买 = `table_purchases` 里这一类型的 count 之和（试用表格不卖，恒为 0）；
 *   - 默认名额：试用 1（新注册就送一张免费试用表）、基础 / 专业 0。
 *
 * 购买走订单（见 `src/worker/orders.ts` 与 docs/payment-xorpay.md）：
 *   - `POST /api/quota/orders`（推荐，前端在用）：body `{ kind, count, months, payType? }` →
 *     开通了收款就返回微信支付二维码（202 + `pay.qr`），等回调 / 查单确认后才加名额；
 *     没开通收款（后台「站点设置」里没填 XorPay appid / secret）则立刻到账（201 + `purchase`）；
 *   - `POST /api/quota/purchases`（老接口，保留兼容）：同一套逻辑的简写，响应结构一并保留。
 *
 * `months` 是**总时长**（时长单位「月」× 数量 1 ~ 12，或时长单位「年」× 数量 1 ~ 5 → 1 ~ 60 个月，
 * 见 shared/tableKind.ts 的 `purchaseMonthsOf` / `isPurchasableMonths`），
 * 金额按「每月单价 × 数量 × 总月数」算（基础 9.9 元/月、专业 99.9 元/月），服务端算价、客户端不作数。
 */
import { tableQuotaSetOf } from '../../shared/quota';
import type { TableQuotaSet } from '../../shared/types';
import { requireUser } from '../auth';
import { json, readJson, sqlNumber, type SqlRow } from '../http';
import { createOrderForUser, loadXorpayConfig, parsePurchaseInput } from '../orders';
import { xorpayConfigured } from '../xorpay';
import type { Env, RequestContext, Route } from '../types';
import { forEachShardSafe } from '../shards';
import { countInviteTrialGrants } from '../trialGrants';

/**
 * 分片里的名额统计列：`used_*` = 自己拥有的、未归档的这一类型表格数。
 * 分享（公开链接 / 视图定向分享 / 协作者）**不再**加名额，所以这里没有 `link_*` /
 * `view_*` / `member_*`；试用表格的赠额来自用户库的 `trial_table_grants`（每成功邀请
 * 一位新用户 +1），基础 / 专业表格的名额只能购买（口径见 shared/quota.ts）。
 */
const QUOTA_COUNT_COLUMNS = ['used_trial', 'used_basic', 'used_pro'] as const;

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
             WHERE owner_id = ? AND is_archived = 0 AND kind = 'pro') AS used_pro`,
      )
      .bind(userId, userId, userId)
      .first<SqlRow>();
    return row ?? {};
  });

  const counts: Record<(typeof QUOTA_COUNT_COLUMNS)[number], number> = {
    used_trial: 0,
    used_basic: 0,
    used_pro: 0,
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
      // 基础表格没有赠额：分享不再加名额（口径见 shared/quota.ts），名额只能购买
      used: counts.used_basic,
      shared: 0,
      purchased: sqlNumber(purchaseRow ?? {}, 'bought_basic'),
    },
    pro: {
      // 专业表格的名额也只看购买：分享不再 +1（口径见 shared/quota.ts）
      used: counts.used_pro,
      shared: 0,
      purchased: sqlNumber(purchaseRow ?? {}, 'bought_pro'),
    },
  });
}

async function quotaHandler(ctx: RequestContext): Promise<Response> {
  const user = await requireUser(ctx.request, ctx.env);
  const config = await loadXorpayConfig(ctx.env);
  return json({
    quota: await loadTableQuota(ctx.env, user.id),
    // 购买弹窗据此决定显示「微信扫码支付」还是「下单立即到账」（见 shared/types.ts 的 TableQuotaPayment）
    payment: { enabled: xorpayConfigured(config), methods: config.payTypes },
  });
}

/**
 * 老接口：`POST /api/quota/purchases`（body `{ kind, count, months, note? }`）。
 *
 * 接入支付之后它只是「下单」的简写，行为取决于有没有开通收款：
 *   - **没开通**（本地 / CI / 还在等 XorPay 审核）：与接入前逐字节一样 —— 立刻写流水、立刻加名额，
 *     返回 201 `{ quota, purchase }`；
 *   - **开通了**：返回 202 `{ quota, order, pay }`（`pay.qr` 是微信支付二维码），名额要等回调 /
 *     查单确认后才到账。前端已改走 `POST /api/quota/orders`，这里留着兼容老客户端与冒烟测试。
 */
async function purchaseHandler(ctx: RequestContext): Promise<Response> {
  const user = await requireUser(ctx.request, ctx.env);
  const body = await readJson(ctx.request);
  const input = parsePurchaseInput(body);
  const created = await createOrderForUser(ctx.env, user, input, {
    request: ctx.request,
    payType: body.payType,
  });
  return json(
    {
      quota: await loadTableQuota(ctx.env, user.id),
      purchase: created.purchase,
      order: created.order,
      pay: created.pay,
    },
    { status: created.purchase ? 201 : 202 },
  );
}

export const quotaRoutes: Route[] = [
  { method: 'GET', path: '/api/quota', handler: quotaHandler },
  { method: 'POST', path: '/api/quota/purchases', handler: purchaseHandler },
];

