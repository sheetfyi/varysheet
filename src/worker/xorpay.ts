/**
 * XorPay 支付网关封装（https://xorpay.com）——配置判定 + 签名 + 下单 + 查单，不碰数据库。
 *
 * 官方文档：https://xorpay.com/doc/
 *   api.html / sign.html / native.html / alipay.html / notify.html / query.html / qr.html
 *
 * 配置来源（见 src/worker/settings.ts）：管理员在「后台 → 站点设置」里填的 appid / app secret 优先，
 * 环境变量 `XORPAY_AID` / `XORPAY_APP_SECRET` 兜底（本地开发与 CI 用后者）。
 * 两个都没有时 `xorpayConfigured()` 返回 false，购买走「自助直通」（见 src/worker/orders.ts）。
 *
 * 签名规则：把文档列出的参数**按顺序拼 value**（不带 key、不带分隔符、不加 `+`），
 * 末尾接上 app secret，整体 MD5 取小写。三个签名分别是：
 *   下单  md5(name + pay_type + price + order_id + notify_url + app_secret)
 *   回调  md5(aoid + order_id + pay_price + pay_time + app_secret)
 *   查单  md5(order_id + app_secret)
 */
import { DEFAULT_XORPAY_PAY_TYPES, asXorpayPayType, type XorpayPayType } from '../shared/xorpay';
import { badGateway } from './http';
import { md5Hex } from './md5';
import type { Env } from './types';

/** 下单时传给 XorPay 的过期秒数：120 分钟（与 shared/xorpay.ts 的 ORDER_TTL_MINUTES 一致） */
export const ORDER_TTL_SECONDS = 7200;

/** 代码里已经实现的支付通道全集（默认只开微信，见 shared/xorpay.ts） */
const ALL_PAY_TYPES: readonly XorpayPayType[] = ['native', 'alipay'];

/** 当前生效的收款配置 */
export interface XorpayConfig {
  /** 后台（或环境变量）里的 appid */
  aid: string;
  /** app secret，签名与验签都用它 */
  appSecret: string;
  /** 接口基址，默认 `https://xorpay.com` */
  apiBase: string;
  /** 开放的支付方式（默认只有 `native` = 微信扫码） */
  payTypes: XorpayPayType[];
}

/** 接口基址：`XORPAY_API_BASE` 可覆盖（本地联调指向 scripts/fake-xorpay.mjs） */
export function xorpayApiBase(env: Env): string {
  return (env.XORPAY_API_BASE?.trim() || 'https://xorpay.com').replace(/\/+$/, '');
}

/**
 * 开放的支付方式：默认只有微信扫码（`DEFAULT_XORPAY_PAY_TYPES`）。
 * 支付宝当面付的代码路径已经就绪，等 XorPay 开通支付宝渠道后用
 * `XORPAY_PAY_TYPES=alipay`（或 `native,alipay`）打开，不用改代码。
 */
export function enabledPayTypes(env: Env): XorpayPayType[] {
  const raw = env.XORPAY_PAY_TYPES?.trim();
  if (!raw) return [...DEFAULT_XORPAY_PAY_TYPES];
  const wanted = raw.split(',').map((item) => item.trim().toLowerCase());
  const picked = ALL_PAY_TYPES.filter((item) => wanted.includes(item));
  return picked.length ? picked : [...DEFAULT_XORPAY_PAY_TYPES];
}

/** 把「后台站点设置 + 环境变量」合成一份收款配置 */
export function xorpayConfigOf(
  env: Env,
  settings: { xorpayAid: string; xorpayAppSecret: string },
): XorpayConfig {
  return {
    aid: settings.xorpayAid.trim(),
    appSecret: settings.xorpayAppSecret.trim(),
    apiBase: xorpayApiBase(env),
    payTypes: enabledPayTypes(env),
  };
}

/** 是否已开通在线收款：appid + app secret 都配齐才算 */
export function xorpayConfigured(config: XorpayConfig): boolean {
  return config.aid !== '' && config.appSecret !== '';
}

/**
 * 回调地址：优先用 `PUBLIC_BASE_URL`（线上建议配成绑定的自定义域名），没配就退回当前请求的 origin。
 * 这个地址会写进 XorPay 的订单，必须公网可达（`*.workers.dev` 在国内不稳，见 DEPLOY.md）。
 */
export function notifyUrlOf(env: Env, request: Request): string {
  const base = env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, '') || new URL(request.url).origin;
  return `${base}/api/xorpay/notify`;
}

/** 分 → XorPay 要的「元」字符串：`1990` → `19.90` */
export function priceTextOf(amountCents: number): string {
  return (amountCents / 100).toFixed(2);
}

/** 「元」字符串 → 分：`"19.90"` → 1990；非法 / 负数返回 null */
export function priceCentsOf(text: unknown): number | null {
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

/** 下单签名（详见文件头注释） */
export function createOrderSign(
  config: XorpayConfig,
  input: { payType: XorpayPayType | string; name: string; price: string; orderId: string; notifyUrl: string },
): string {
  const { payType, name, price, orderId, notifyUrl } = input;
  return md5Hex(`${name}${asXorpayPayType(payType)}${price}${orderId}${notifyUrl}${config.appSecret}`);
}

/** 回调验签：aoid + order_id + pay_price + pay_time + app_secret */
export function notifySignOf(
  config: XorpayConfig,
  input: { aoid: string; orderId: string; payPrice: string; payTime: string },
): string {
  const { aoid, orderId, payPrice, payTime } = input;
  return md5Hex(`${aoid}${orderId}${payPrice}${payTime}${config.appSecret}`);
}

/** 查单签名：order_id + app_secret */
export function querySignOf(config: XorpayConfig, orderId: string): string {
  return md5Hex(`${orderId}${config.appSecret}`);
}

/** XorPay 的错误码 → 中文提示（排障与前端提示共用） */
const XORPAY_ERROR_TEXT: Record<string, string> = {
  missing_argument: '下单参数不完整',
  app_off: 'XorPay 账号被冻结',
  aid_not_exist: 'XorPay 的 appid 不对（检查「后台 → 站点设置」里填的值）',
  pay_type_error: '支付方式不支持（检查 XORPAY_PAY_TYPES）',
  sign_error: '签名错误（检查「后台 → 站点设置」里填的 app secret）',
  order_payed: '该订单已经支付过了',
  order_expire: '订单已过期，请重新下单',
  order_exist: '同一订单号提交了不同参数，请重新下单',
  wechat_api_error: '微信侧异常（可能账号被风控）',
  alipay_api_error: '支付宝侧异常（可能未完成签约或被风控）',
  no_contract: 'XorPay 账号尚未签约',
  no_alipay_contract: '支付宝尚未签约',
  fee_error: 'XorPay 账号余额不足（手续费扣款失败）',
  not_exist: '订单不存在',
};

export function xorpayErrorText(status: string, info = ''): string {
  const text = XORPAY_ERROR_TEXT[status] ?? `XorPay 返回 ${status}`;
  return info ? `${text}（${info}）` : text;
}

/** XorPay 返回的 JSON（`expire_in` / `expires_in` 两种写法都兼容） */
interface XorpayResponse {
  status?: unknown;
  aoid?: unknown;
  expire_in?: unknown;
  expires_in?: unknown;
  info?: unknown;
  msg?: unknown;
}

/** 下单失败时抛它：`status` 是 XorPay 的错误码，路由层据此给用户提示 */
export class XorpayRequestError extends Error {
  constructor(
    readonly status: string,
    readonly info = '',
  ) {
    super(xorpayErrorText(status, info));
    this.name = 'XorpayRequestError';
  }
}

async function parseXorpayJson(response: Response): Promise<XorpayResponse> {
  try {
    return (await response.json()) as XorpayResponse;
  } catch {
    throw badGateway('XorPay 返回的不是 JSON', 'xorpay_bad_response');
  }
}

function infoText(info: unknown): string {
  return typeof info === 'string' ? info : '';
}

function qrOf(info: unknown): string {
  if (info && typeof info === 'object' && !Array.isArray(info)) {
    const qr = (info as Record<string, unknown>).qr;
    if (typeof qr === 'string') return qr;
  }
  return '';
}

export interface XorpayCreatedOrder {
  /** XorPay 平台订单号 */
  aoid: string;
  /** 支付二维码内容（微信 `weixin://...` / 支付宝 `https://qr.alipay.com/...`） */
  qr: string;
  /** 订单过期秒数 */
  expireIn: number;
}

/**
 * 下单：POST {base}/api/pay/{aid}（表单编码）。
 * 我们的订单号 `orderId` 在 XorPay 侧做唯一键（同一个 order_id 换参数会返回 `order_exist`）。
 */
export async function xorpayCreateOrder(
  config: XorpayConfig,
  input: {
    payType: XorpayPayType | string;
    name: string;
    amountCents: number;
    orderId: string;
    orderUid?: string;
    more?: string;
    notifyUrl: string;
  },
): Promise<XorpayCreatedOrder> {
  const payType = asXorpayPayType(input.payType);
  const price = priceTextOf(input.amountCents);
  const body = new URLSearchParams();
  body.set('name', input.name);
  body.set('pay_type', payType);
  body.set('price', price);
  body.set('order_id', input.orderId);
  if (input.orderUid) body.set('order_uid', input.orderUid);
  if (input.more) body.set('more', input.more);
  body.set('notify_url', input.notifyUrl);
  body.set('expire', String(ORDER_TTL_SECONDS));
  body.set(
    'sign',
    createOrderSign(config, {
      payType,
      name: input.name,
      price,
      orderId: input.orderId,
      notifyUrl: input.notifyUrl,
    }),
  );

  let response: Response;
  try {
    response = await fetch(`${config.apiBase}/api/pay/${encodeURIComponent(config.aid)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (cause) {
    throw badGateway(`连不上 XorPay：${cause instanceof Error ? cause.message : '网络错误'}`, 'xorpay_unreachable');
  }
  const payload = await parseXorpayJson(response);
  const status = typeof payload.status === 'string' ? payload.status : '';
  if (status !== 'ok') {
    throw new XorpayRequestError(status || 'unknown', infoText(payload.info ?? payload.msg));
  }

  const qr = qrOf(payload.info);
  if (!qr) throw badGateway('XorPay 没有返回支付二维码', 'xorpay_no_qr');
  const expireIn = Number(payload.expire_in ?? payload.expires_in);
  return {
    aoid: typeof payload.aoid === 'string' ? payload.aoid : '',
    qr,
    expireIn: Number.isFinite(expireIn) && expireIn > 0 ? Math.trunc(expireIn) : ORDER_TTL_SECONDS,
  };
}

/**
 * 查单（按我们自己的订单号）：GET {base}/api/query2/{aid}?order_id=&sign=。
 * 返回 XorPay 的状态文本：not_exist / new / payed / fee_error / success / expire。
 * `payed` = 已支付但通知还没成功，`success` = 已支付且通知成功 —— 两者都代表钱到了。
 */
export async function xorpayQueryOrder(config: XorpayConfig, orderId: string): Promise<string> {
  const query = new URLSearchParams();
  query.set('order_id', orderId);
  query.set('sign', querySignOf(config, orderId));
  let response: Response;
  try {
    response = await fetch(`${config.apiBase}/api/query2/${encodeURIComponent(config.aid)}?${query}`, {
      signal: AbortSignal.timeout(10_000),
    });
  } catch (cause) {
    throw badGateway(`连不上 XorPay：${cause instanceof Error ? cause.message : '网络错误'}`, 'xorpay_unreachable');
  }
  const payload = await parseXorpayJson(response);
  return typeof payload.status === 'string' ? payload.status : '';
}
