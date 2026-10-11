/**
 * 支付路由：
 *   POST /api/quota/orders       下单（开通收款时返回微信支付二维码；没开通则立即交付）
 *   GET  /api/quota/orders/:id   查单（顺带向 XorPay 兜底查询 + 自愈，前端每 3 秒轮询它）
 *   POST /api/xorpay/notify      XorPay 异步回调（验签 + 金额核对 + 幂等交付，必须回 200）
 *
 * 回调是**匿名**请求（XorPay 服务器直连，没有 Cookie），所以它自己验签、不要求登录；
 * 另外两条仍是登录用户接口（`requireUser`）。返回给回调的响应必须是纯文本 + HTTP 200，
 * 否则 XorPay 会按 1/2/4/16/64/300 分钟重试 6 次（notify.html）。
 */
import { orderStatusText } from '../../shared/xorpay';
import { requireUser } from '../auth';
import { json, notFound, readJson, type SqlRow } from '../http';
import {
  createOrderForUser,
  deliverFromNotify,
  loadOrderRow,
  loadXorpayConfig,
  orderOf,
  parsePurchaseInput,
  syncOrderWithGateway,
} from '../orders';
import { notifySignOf, priceCentsOf, xorpayConfigured } from '../xorpay';
import type { RequestContext, Route } from '../types';
import { loadTableQuota } from './quota';

/** 下单：201 = 没开通收款、已经到账（带 `purchase`）；202 = 待支付（带 `pay.qr`） */
async function createOrderHandler(ctx: RequestContext): Promise<Response> {
  const user = await requireUser(ctx.request, ctx.env);
  const body = await readJson(ctx.request);
  const input = parsePurchaseInput(body);
  const config = await loadXorpayConfig(ctx.env);
  const created = await createOrderForUser(ctx.env, user, input, {
    request: ctx.request,
    payType: body.payType,
    config,
  });
  return json(
    {
      order: created.order,
      purchase: created.purchase,
      pay: created.pay,
      /** 是否已开通在线收款：前端据此显示「扫码支付」还是「已到账」 */
      paymentEnabled: created.paymentEnabled,
      quota: await loadTableQuota(ctx.env, user.id),
    },
    { status: created.purchase ? 201 : 202 },
  );
}

/** 查单：先看库里，再（开通了收款时）向 XorPay 兜底查一次 + 交付/过期，返回最新状态 */
async function orderStatusHandler(ctx: RequestContext): Promise<Response> {
  const user = await requireUser(ctx.request, ctx.env);
  const row = await loadOrderRow(ctx.env, ctx.params.id ?? '', user.id);
  if (!row) throw notFound('订单不存在');

  let fresh: SqlRow = row;
  try {
    fresh = await syncOrderWithGateway(ctx.env, row, await loadXorpayConfig(ctx.env));
  } catch (error) {
    // 查单只是兜底：网关不通 / 被风控时不要把轮询整个打失败，返回库里最新的状态即可
    console.warn('[xorpay] 查单失败：', error instanceof Error ? error.message : error);
  }
  const order = orderOf(fresh);
  return json({
    order,
    statusText: orderStatusText(order.status),
    quota: await loadTableQuota(ctx.env, user.id),
  });
}

/** 回调只认状态码与文本内容：回纯文本（`ok` / `success` 都算成功），别回 JSON */
function textResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

/** 回调里的 `detail` 是 JSON 文本（`transaction_id` / `bank_type` / `buyer`） */
function parseDetail(raw: string): { transactionId: string; buyer: string } {
  if (!raw) return { transactionId: '', buyer: '' };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      transactionId: typeof parsed.transaction_id === 'string' ? parsed.transaction_id : '',
      buyer: typeof parsed.buyer === 'string' ? parsed.buyer : '',
    };
  } catch {
    return { transactionId: '', buyer: '' };
  }
}

/** 把回调原文拼成一条可读记录（去掉 sign，截断保存） */
function notifyRawOf(form: FormData): string {
  const parts: string[] = [];
  form.forEach((value, key) => {
    if (key !== 'sign') parts.push(`${key}=${String(value)}`);
  });
  return parts.join('&');
}

async function notifyHandler(ctx: RequestContext): Promise<Response> {
  const config = await loadXorpayConfig(ctx.env);
  // 没开通收款就没人会回调我们：当成 404，避免被误触发
  if (!xorpayConfigured(config)) return textResponse('payment not configured', 404);

  const contentType = ctx.request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/x-www-form-urlencoded')) {
    return textResponse('bad content type', 400);
  }

  let form: FormData;
  try {
    form = await ctx.request.formData();
  } catch {
    return textResponse('bad form body', 400);
  }
  const read = (key: string) => {
    const value = form.get(key);
    return typeof value === 'string' ? value : '';
  };

  const aoid = read('aoid');
  const orderId = read('order_id');
  const payPrice = read('pay_price');
  const payTime = read('pay_time');
  const sign = read('sign').toLowerCase();
  if (!aoid || !orderId || !payPrice || !payTime || !sign) return textResponse('missing argument', 400);

  // 验签：md5(aoid + order_id + pay_price + pay_time + app_secret)
  const expected = notifySignOf(config, { aoid, orderId, payPrice, payTime });
  if (expected !== sign) {
    console.error(`[xorpay] 回调验签失败：order=${orderId} sign=${sign}`);
    return textResponse('sign error', 400);
  }

  const detail = parseDetail(read('detail'));
  const outcome = await deliverFromNotify(ctx.env, {
    orderId,
    aoid,
    paidCents: priceCentsOf(payPrice),
    transactionId: detail.transactionId,
    buyer: detail.buyer,
    raw: notifyRawOf(form),
  });

  if (outcome === 'unknown_order') {
    // 签名对得上但订单不在本库（换过数据库 / 人工测试）→ 回 200 停止重试，人工对账
    console.error(`[xorpay] 回调里的订单不存在：${orderId}`);
    return textResponse('unknown order', 200);
  }
  // delivered / duplicate / amount_mismatch 都回 200：
  // 金额不符是永久性错误，重试 6 次也没用，靠日志与后台订单表人工处理。
  return textResponse('success', 200);
}

export const paymentRoutes: Route[] = [
  { method: 'POST', path: '/api/quota/orders', handler: createOrderHandler },
  { method: 'GET', path: '/api/quota/orders/:id', handler: orderStatusHandler },
  { method: 'POST', path: '/api/xorpay/notify', handler: notifyHandler },
];
