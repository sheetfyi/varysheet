/**
 * 表格名额的支付订单：下单、交付（写 `table_purchases` 加名额）、查单兜底与自愈。
 *
 * 三种情形：
 *   1) 没开通收款（后台「站点设置」里没填 XorPay appid / app secret，环境变量也没有）= **自助直通**：
 *      下单即交付，`channel = 'self-serve'`（本地开发 / CI / 资质审核期都走这条，行为与接入前一致）；
 *   2) 开通了：下单写 pending 订单 + 调网关拿微信支付二维码，等回调（或主动查单）再交付；
 *   3) 管理员赠额：直接交付，`channel = 'admin-grant'`（客服补偿 / 活动赠送 / 线上冒烟测试建表用）。
 *
 * 幂等：交付前先做一次「状态守卫」更新
 *   UPDATE table_orders SET status='paid' WHERE id=? AND status<>'paid'
 * 只有 changes > 0 的那一次才继续写名额；`table_purchases.order_id` 上的部分唯一索引是第二道闸。
 *
 * 这里不导入任何 `routes/*`（避免循环依赖）：需要最新名额时由路由层自己调 `loadTableQuota()`。
 */
import { MAX_PURCHASE_COUNT } from '../shared/quota';
import {
  BUYABLE_TABLE_KINDS,
  MAX_PURCHASE_MONTHS,
  MIN_PURCHASE_MONTHS,
  isPurchasableMonths,
  purchaseAmountCents,
  purchaseMonthsLabel,
  tableKindLabel,
} from '../shared/tableKind';
import {
  MAX_ORDER_AMOUNT_CENTS,
  ORDER_TTL_MINUTES,
  asXorpayPayType,
  xorpayPayTypeLabel,
  type TableOrderStatus,
  type XorpayPayType,
} from '../shared/xorpay';
import type { TableKind, TableOrder, TablePurchase } from '../shared/types';
import {
  asEnum,
  asNumberValue,
  asString,
  badRequest,
  newId,
  sqlNumber,
  sqlString,
  type SqlRow,
} from './http';
import { loadSiteSettings } from './settings';
import {
  notifyUrlOf,
  xorpayConfigured,
  xorpayConfigOf,
  xorpayCreateOrder,
  xorpayQueryOrder,
  XorpayRequestError,
  type XorpayConfig,
} from './xorpay';
import type { AuthedUser, Env } from './types';

/** 可以买的类型（试用表格是免费送的、不单卖，见 shared/tableKind.ts） */
const PURCHASE_KINDS = BUYABLE_TABLE_KINDS;

/** 读取当前生效的收款配置（后台「站点设置」优先，环境变量兜底） */
export async function loadXorpayConfig(env: Env): Promise<XorpayConfig> {
  return xorpayConfigOf(env, await loadSiteSettings(env));
}

/** 一次购买的参数（说明弹窗里选好的：类型 / 数量 / 总时长 + 可选备注） */
export interface PurchaseInput {
  kind: TableKind;
  count: number;
  months: number;
  note: string;
}

/**
 * 校验一次购买的参数 —— 与接入支付之前的 `purchaseHandler` **逐字一致**
 * （冒烟测试里的 400 断言依赖这些边界：试用表格 400、数量 1 ~ 10、总月数白名单）。
 */
export function parsePurchaseInput(body: Record<string, unknown>): PurchaseInput {
  const kind: TableKind = asEnum(body.kind ?? 'basic', PURCHASE_KINDS, '表格类型');
  const count = Math.floor(asNumberValue(body.count ?? 1, '购买数量'));
  if (count < 1) throw badRequest('购买数量至少 1 个');
  if (count > MAX_PURCHASE_COUNT) throw badRequest(`一次最多购买 ${MAX_PURCHASE_COUNT} 个名额`);
  const months = Math.floor(asNumberValue(body.months ?? 1, '购买时长'));
  if (!isPurchasableMonths(months)) {
    throw badRequest(
      `购买时长只能选 ${MIN_PURCHASE_MONTHS} ~ 12 个月（时长单位「月」× 时长数量 1 ~ 12），或 12 / 24 / 36 / 48 / ${MAX_PURCHASE_MONTHS} 个月（时长单位「年」× 时长数量 1 ~ 5）`,
    );
  }
  const note = asString(body.note, '备注', { max: 200 });
  return { kind, count, months, note };
}

/** 数据库行 → `TableOrder` */
export function orderOf(row: SqlRow): TableOrder {
  const paidAt = sqlNumber(row, 'paid_at', 0);
  return {
    id: sqlString(row, 'id'),
    userId: sqlString(row, 'user_id'),
    kind: sqlString(row, 'kind', 'basic') as TableKind,
    count: sqlNumber(row, 'count', 1),
    months: sqlNumber(row, 'months', 1),
    amountCents: sqlNumber(row, 'amount_cents'),
    paidCents: sqlNumber(row, 'paid_cents'),
    status: sqlString(row, 'status', 'pending') as TableOrderStatus,
    payType: sqlString(row, 'pay_type') as XorpayPayType | '',
    channel: sqlString(row, 'channel'),
    aoid: sqlString(row, 'aoid'),
    qr: sqlString(row, 'qr'),
    expiresAt: sqlNumber(row, 'expires_at'),
    paidAt: paidAt > 0 ? paidAt : null,
    createdAt: sqlNumber(row, 'created_at'),
  };
}

const ORDER_COLUMNS = `id, user_id, kind, count, months, amount_cents, paid_cents, status, pay_type,
  channel, aoid, qr, purchase_id, expires_at, paid_at, created_at`;

/** 按订单号读一行（`userId` 传了就顺带校验归属，防止越权看别人的订单） */
export async function loadOrderRow(env: Env, orderId: string, userId?: string): Promise<SqlRow | null> {
  const statement = userId
    ? env.DB.prepare(`SELECT ${ORDER_COLUMNS} FROM table_orders WHERE id = ? AND user_id = ?`).bind(orderId, userId)
    : env.DB.prepare(`SELECT ${ORDER_COLUMNS} FROM table_orders WHERE id = ?`).bind(orderId);
  return (await statement.first<SqlRow>()) ?? null;
}

/** 订单号 = 主键：`vs` 前缀 + 32 位十六进制（同时作为 XorPay 的 order_id，平台侧要求唯一） */
function newOrderId(): string {
  return `vs${newId().replace(/-/g, '')}`;
}

/** 写一条购买流水（名额的真正来源），返回流水 id */
async function insertPurchase(
  env: Env,
  input: {
    userId: string;
    kind: TableKind;
    count: number;
    months: number;
    amountCents: number;
    channel: string;
    note: string;
    createdBy: string;
    orderId?: string;
    createdAt: number;
  },
): Promise<string> {
  const id = newId();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO table_purchases
       (id, user_id, kind, count, months, amount_cents, channel, note, created_by, created_at, order_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      input.userId,
      input.kind,
      input.count,
      input.months,
      input.amountCents,
      input.channel,
      input.note,
      input.createdBy,
      input.createdAt,
      input.orderId ?? '',
    )
    .run();
  return id;
}

export interface CreatedOrder {
  order: TableOrder;
  /** 自助直通 / 赠额时立刻写好的流水；走支付时是 null（等回调到账） */
  purchase: TablePurchase | null;
  /** 走支付时给前端的支付信息（二维码内容） */
  pay: { payType: XorpayPayType; qr: string } | null;
  /** 这一单是不是「开通了收款」下的单（前端据此决定显示二维码还是直接提示到账） */
  paymentEnabled: boolean;
}

/**
 * 下单：服务端算价 → 写订单 →（开通了收款）调 XorPay 拿微信支付二维码。
 * 没开通收款时退化成「自助直通」：立刻交付名额并把流水一起返回。
 */
export async function createOrderForUser(
  env: Env,
  user: AuthedUser,
  input: PurchaseInput,
  options: { request: Request; payType?: unknown; config?: XorpayConfig },
): Promise<CreatedOrder> {
  const amountCents = purchaseAmountCents(input.kind, input.count, input.months);
  if (amountCents <= 0) throw badRequest('这一类表格不单卖（试用表格是免费赠送的）');
  const now = Date.now();
  const orderId = newOrderId();
  const config = options.config ?? (await loadXorpayConfig(env));

  // ---- 情形 1：没开通收款 → 自助直通（与接入前完全一致：立刻写流水、立刻加名额）----
  if (!xorpayConfigured(config)) {
    await env.DB.prepare(
      `INSERT INTO table_orders
         (id, user_id, kind, count, months, amount_cents, paid_cents, status, pay_type, channel,
          aoid, qr, transaction_id, buyer, notify_raw, purchase_id, expires_at, paid_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'paid', '', 'self-serve', '', '', '', '', '', '', 0, ?, ?, ?)`,
    )
      .bind(orderId, user.id, input.kind, input.count, input.months, amountCents, amountCents, now, now, now)
      .run();
    const purchaseId = await insertPurchase(env, {
      userId: user.id,
      kind: input.kind,
      count: input.count,
      months: input.months,
      amountCents,
      channel: 'self-serve',
      note: input.note,
      createdBy: user.id,
      orderId,
      createdAt: now,
    });
    await env.DB.prepare('UPDATE table_orders SET purchase_id = ?, updated_at = ? WHERE id = ?')
      .bind(purchaseId, Date.now(), orderId)
      .run();
    const row = await loadOrderRow(env, orderId, user.id);
    return {
      order: orderOf(row ?? {}),
      purchase: {
        id: purchaseId,
        userId: user.id,
        kind: input.kind,
        count: input.count,
        months: input.months,
        amountCents,
        channel: 'self-serve',
        note: input.note,
        createdAt: now,
      },
      pay: null,
      paymentEnabled: false,
    };
  }

  // ---- 情形 2：开通了收款 → 写 pending 订单 + 调网关拿二维码，等回调交付 ----
  const payTypes = config.payTypes;
  const payType: XorpayPayType = asXorpayPayType(
    options.payType === undefined || options.payType === '' ? payTypes[0] : options.payType,
  );
  if (!payTypes.includes(payType)) {
    throw badRequest(`${xorpayPayTypeLabel(payType)}支付暂不可用，请换一种支付方式`, 'pay_type_unavailable');
  }
  if (amountCents > MAX_ORDER_AMOUNT_CENTS) {
    // 渠道有单笔限额（支付宝当面付个人单笔 ¥1000，取它当统一上限），别把用户送到支付页再失败
    throw badRequest(
      `单笔最多 ${MAX_ORDER_AMOUNT_CENTS / 100} 元（${xorpayPayTypeLabel(payType)}单笔限额），请减少数量或时长后分多笔购买`,
      'order_amount_too_large',
    );
  }

  const expiresAt = now + ORDER_TTL_MINUTES * 60 * 1000;
  await env.DB.prepare(
    `INSERT INTO table_orders
       (id, user_id, kind, count, months, amount_cents, status, pay_type, channel, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 'xorpay', ?, ?, ?)`,
  )
    .bind(orderId, user.id, input.kind, input.count, input.months, amountCents, payType, expiresAt, now, now)
    .run();

  try {
    const created = await xorpayCreateOrder(config, {
      payType,
      // 商品名会显示在微信的账单上，写清楚「买了什么」
      name: `${tableKindLabel(input.kind)}名额 × ${input.count}（${purchaseMonthsLabel(input.months)}）`,
      amountCents,
      orderId,
      // order_uid 是可选参数，用来在 XorPay 后台看清是谁下的单
      orderUid: user.email,
      more: `${input.kind}:${input.count}:${input.months}`,
      notifyUrl: notifyUrlOf(env, options.request),
    });
    await env.DB.prepare('UPDATE table_orders SET aoid = ?, qr = ?, expires_at = ?, updated_at = ? WHERE id = ?')
      .bind(created.aoid, created.qr, now + created.expireIn * 1000, Date.now(), orderId)
      .run();
    const row = await loadOrderRow(env, orderId, user.id);
    return { order: orderOf(row ?? {}), purchase: null, pay: { payType, qr: created.qr }, paymentEnabled: true };
  } catch (error) {
    // 下单失败：订单标成 canceled 并把错误文本留在 notify_raw 里（不删，方便排障）
    const message =
      error instanceof XorpayRequestError
        ? `${error.status} ${error.message}`
        : error instanceof Error
          ? error.message
          : 'unknown';
    await env.DB.prepare(`UPDATE table_orders SET status = 'canceled', notify_raw = ?, updated_at = ? WHERE id = ?`)
      .bind(message.slice(0, 500), Date.now(), orderId)
      .run();
    throw error;
  }
}

/**
 * 交付一张订单：状态守卫 → 写购买流水 → 回写 purchase_id。
 * 返回 true = 这一次真的交付了；false = 已经交付过（重复回调 / 并发调用）。
 */
export async function deliverOrder(
  env: Env,
  order: TableOrder,
  paid: {
    paidCents: number;
    transactionId?: string;
    buyer?: string;
    notifyRaw?: string;
    /** notify = 回调确认；query = 主动查单确认 */
    source: 'notify' | 'query';
  },
): Promise<boolean> {
  const now = Date.now();
  const guard = await env.DB.prepare(
    `UPDATE table_orders
        SET status = 'paid', paid_cents = ?, transaction_id = ?, buyer = ?, notify_raw = ?, paid_at = ?, updated_at = ?
      WHERE id = ? AND status <> 'paid'`,
  )
    .bind(
      paid.paidCents,
      paid.transactionId ?? '',
      paid.buyer ?? '',
      (paid.notifyRaw ?? '').slice(0, 500),
      now,
      now,
      order.id,
    )
    .run();
  // 只有把 pending / expired / canceled 改成 paid 的那一次（changes = 1）才继续交付
  if (Number(guard.meta?.changes ?? 0) === 0) return false;

  const channel =
    order.channel === 'self-serve' || order.channel === 'admin-grant'
      ? order.channel
      : `${order.channel || 'xorpay'}:${order.payType || 'native'}`;
  const purchaseId = await insertPurchase(env, {
    userId: order.userId,
    kind: order.kind,
    count: order.count,
    months: order.months,
    amountCents: order.amountCents,
    channel,
    note: paid.source === 'notify' ? '支付到账（XorPay 回调）' : '支付到账（主动查单确认）',
    createdBy: order.userId,
    orderId: order.id,
    createdAt: now,
  });
  await env.DB.prepare('UPDATE table_orders SET purchase_id = ?, updated_at = ? WHERE id = ?')
    .bind(purchaseId, now, order.id)
    .run();
  return true;
}

/** 自愈：订单已经是 paid 但没记 purchase_id（上次写入中途失败）→ 补一条流水 */
async function healPaidOrder(env: Env, row: SqlRow): Promise<void> {
  if (sqlString(row, 'status') !== 'paid' || sqlString(row, 'purchase_id') !== '') return;
  const order = orderOf(row);
  const existing = await env.DB.prepare('SELECT id FROM table_purchases WHERE order_id = ?')
    .bind(order.id)
    .first<SqlRow>();
  const purchaseId = existing
    ? sqlString(existing, 'id')
    : await insertPurchase(env, {
        userId: order.userId,
        kind: order.kind,
        count: order.count,
        months: order.months,
        amountCents: order.amountCents,
        channel:
          order.channel === 'self-serve'
            ? 'self-serve'
            : `${order.channel || 'xorpay'}:${order.payType || 'native'}`,
        note: '支付到账（补记）',
        createdBy: order.userId,
        orderId: order.id,
        createdAt: Date.now(),
      });
  await env.DB.prepare('UPDATE table_orders SET purchase_id = ?, updated_at = ? WHERE id = ?')
    .bind(purchaseId, Date.now(), order.id)
    .run();
}

/** 待支付订单超时 → expired（只在还是 pending 时改，不会覆盖 paid） */
async function markExpired(env: Env, orderId: string): Promise<void> {
  await env.DB.prepare(`UPDATE table_orders SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending'`)
    .bind(Date.now(), orderId)
    .run();
}

/**
 * 查单兜底：前端轮询 / 用户手动刷新时打一次 XorPay，
 * 回调因为网络原因丢了也能自己把名额补上（`payed` = 已支付但通知还没成功，一样交付）。
 */
export async function syncOrderWithGateway(env: Env, row: SqlRow, config: XorpayConfig): Promise<SqlRow> {
  const order = orderOf(row);

  // ① 已经交付过：顺手做一次自愈（防止「状态改了、流水没写成」）
  if (order.status === 'paid') {
    await healPaidOrder(env, row);
    return (await loadOrderRow(env, order.id)) ?? row;
  }
  if (order.status !== 'pending' || !xorpayConfigured(config)) return row;

  // ② 主动查单
  const status = await xorpayQueryOrder(config, order.id);
  if (status === 'success' || status === 'payed') {
    // 查单接口不返回金额（金额在下单时就锁定，且同一个 order_id 不能改金额），
    // 所以这里按订单金额交付，并在流水里写明来源是「主动查单确认」。
    await deliverOrder(env, order, { paidCents: order.amountCents, source: 'query' });
  } else if (status === 'expire' || status === 'not_exist' || status === 'new') {
    if (Date.now() >= order.expiresAt) {
      // 网关那边还没付款、我们这边的有效期也过了 → 标记过期（要买会重新下单）
      await markExpired(env, order.id);
    }
  }
  return (await loadOrderRow(env, order.id)) ?? row;
}

export interface NotifyInput {
  orderId: string;
  aoid: string;
  /** 实付金额（分）；`null` = 回调里的 pay_price 解析失败 */
  paidCents: number | null;
  transactionId: string;
  buyer: string;
  /** 回调原文（截断保存，排障用） */
  raw: string;
}

export type NotifyOutcome = 'delivered' | 'duplicate' | 'amount_mismatch' | 'unknown_order';

/**
 * 处理一次支付回调：金额核对 → 交付（幂等）。
 * 金额不符**不交付**、标记 `amount_mismatch` 等人工（防止「付 0.01 元拿 10 个名额」）。
 */
export async function deliverFromNotify(env: Env, input: NotifyInput): Promise<NotifyOutcome> {
  const row = await loadOrderRow(env, input.orderId);
  if (!row) return 'unknown_order';
  const order = orderOf(row);

  if (input.paidCents === null || input.paidCents !== order.amountCents) {
    await env.DB.prepare(
      `UPDATE table_orders
          SET status = 'amount_mismatch', paid_cents = ?, aoid = ?, notify_raw = ?, updated_at = ?
        WHERE id = ?`,
    )
      .bind(input.paidCents ?? 0, input.aoid, input.raw.slice(0, 500), Date.now(), input.orderId)
      .run();
    console.error(`[xorpay] 金额不符：order=${input.orderId} expected=${order.amountCents} paid=${input.paidCents}`);
    return 'amount_mismatch';
  }

  if (order.status === 'paid') {
    // 重复回调（XorPay 通知失败会重试 6 次）：只刷新回调痕迹，不再交付
    await env.DB.prepare(
      `UPDATE table_orders SET aoid = ?, transaction_id = ?, buyer = ?, notify_raw = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(input.aoid, input.transactionId, input.buyer, input.raw.slice(0, 500), Date.now(), input.orderId)
      .run();
    return 'duplicate';
  }

  // 钱已到账就给名额：订单即使已经 canceled / expired 也一样交付
  const delivered = await deliverOrder(env, order, {
    paidCents: input.paidCents,
    transactionId: input.transactionId,
    buyer: input.buyer,
    notifyRaw: input.raw,
    source: 'notify',
  });
  return delivered ? 'delivered' : 'duplicate';
}

/**
 * 管理员赠额：跳过支付直接写一条流水（客服补偿 / 活动赠送；
 * 线上开通收款后，冒烟测试也靠它给测试账号发建表名额，见 docs/payment-xorpay.md §8）。
 */
export async function grantQuota(
  env: Env,
  input: { userId: string; kind: TableKind; count: number; months: number; note: string; createdBy: string },
): Promise<TablePurchase> {
  const amountCents = purchaseAmountCents(input.kind, input.count, input.months);
  const now = Date.now();
  const id = await insertPurchase(env, {
    userId: input.userId,
    kind: input.kind,
    count: input.count,
    months: input.months,
    amountCents,
    channel: 'admin-grant',
    note: input.note,
    createdBy: input.createdBy,
    createdAt: now,
  });
  return {
    id,
    userId: input.userId,
    kind: input.kind,
    count: input.count,
    months: input.months,
    amountCents,
    channel: 'admin-grant',
    note: input.note,
    createdAt: now,
  };
}

