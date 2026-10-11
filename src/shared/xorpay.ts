/**
 * XorPay 收款的口径：支付方式、单笔限额与订单状态文案（前端 / Worker 共用）。
 *
 * 字段名与签名规则来自官方文档 https://xorpay.com/doc/ （api.html / sign.html / notify.html）：
 *   下单   POST /api/pay/{aid}      sign = md5(name + pay_type + price + order_id + notify_url + app_secret)
 *   回调   POST 到你传的 notify_url  sign = md5(aoid + order_id + pay_price + pay_time + app_secret)
 *   查单   GET  /api/query2/{aid}?order_id=&sign=   sign = md5(order_id + app_secret)
 * 都是「纯 value 顺序拼接 + app secret，MD5 后小写」。
 *
 * 配置来源：管理员在「后台 → 站点设置」里填 appid / app secret（存在 D1 的 `settings` 表），
 * 环境变量 `XORPAY_AID` / `XORPAY_APP_SECRET` 作为兜底（本地开发 / CI / 老部署）。
 * 两者都没有时购买走「自助直通」（下单即到账，不产生真实收款，见 src/worker/orders.ts）。
 */
import { formatPriceCents } from './tableKind';

/** 代码支持的支付方式：微信 NATIVE 扫码 / 支付宝当面付（都是「服务端下单拿二维码」） */
export const XORPAY_PAY_TYPES = ['native', 'alipay'] as const;
export type XorpayPayType = (typeof XORPAY_PAY_TYPES)[number];

/**
 * 默认开启的支付方式：**只开微信**（NATIVE 扫码）。
 * 支付宝当面付的代码路径已经准备好，等 XorPay 那边开通了支付宝渠道，
 * 用环境变量 `XORPAY_PAY_TYPES=alipay`（或 `native,alipay`）就能打开，不用改代码。
 */
export const DEFAULT_XORPAY_PAY_TYPES: readonly XorpayPayType[] = ['native'];

/** 任何来路不明的值都当「微信扫码」（老客户端 / 脏数据都不会掉进未知通道） */
export function asXorpayPayType(value: unknown): XorpayPayType {
  return value === 'alipay' ? 'alipay' : 'native';
}

/** 「微信」「支付宝」——购买区与订单状态文案用它 */
export function xorpayPayTypeLabel(payType: XorpayPayType | string | null | undefined): string {
  return asXorpayPayType(payType) === 'alipay' ? '支付宝' : '微信';
}

/**
 * 单笔订单金额上限（分）= ¥1000。
 * 取「支付宝当面付个人单笔限额 ¥1000」这个最小的渠道限额当统一上限（微信单笔其实能到 ¥20000）：
 * 两条通道共用一个上限最省事，也不会出现「微信能付、支付宝付不了」。
 * 本仓库最高组合是 ¥59,940（专业 ¥99.9/月 × 10 个 × 60 个月），必须拆单。
 */
export const MAX_ORDER_AMOUNT_CENTS = 100_000;

/** 订单有效期（分钟）：与下单接口传的 expire 保持一致（XorPay 默认 7200 秒） */
export const ORDER_TTL_MINUTES = 120;

/** 订单状态：pending 待到账 / paid 已交付 / expired 已过期 / canceled 已取消 / amount_mismatch 金额不符（待人工） */
export type TableOrderStatus = 'pending' | 'paid' | 'expired' | 'canceled' | 'amount_mismatch';

/** 订单状态文案（购买弹窗与订单提示都用它） */
export function orderStatusText(status: TableOrderStatus | string): string {
  switch (status) {
    case 'paid':
      return '已支付，名额已到账';
    case 'expired':
      return '已过期（超时未支付），重新下单即可';
    case 'canceled':
      return '已取消';
    case 'amount_mismatch':
      return '实付金额与订单不一致，请联系客服人工处理';
    default:
      return '等待支付';
  }
}

/** 金额超上限时给用户的一句话（不超限返回空串） */
export function orderAmountHint(amountCents: number, payType: XorpayPayType | string): string {
  if (!Number.isFinite(amountCents) || amountCents <= MAX_ORDER_AMOUNT_CENTS) return '';
  return `单笔最多 ${formatPriceCents(MAX_ORDER_AMOUNT_CENTS)}（${xorpayPayTypeLabel(payType)}单笔限额），请减少数量或时长，分多笔购买`;
}

/** 二维码图片地址：XorPay 自带生成接口（GET https://xorpay.com/qr?data=内容 → 返回图片） */
export const XORPAY_QR_IMAGE_BASE = 'https://xorpay.com/qr';

/** 把支付二维码内容包成可直接放进 <img src> 的地址 */
export function xorpayQrImageUrl(qr: string): string {
  return `${XORPAY_QR_IMAGE_BASE}?data=${encodeURIComponent(qr)}`;
}

/** 手机浏览器里点「用支付宝打开」时的深链（支付宝当面付只有这条通道能拉起 App） */
export function xorpayAlipayDeepLink(qr: string): string {
  return `alipays://platformapi/startapp?appId=20000067&url=${encodeURIComponent(qr)}`;
}
