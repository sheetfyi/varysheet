#!/usr/bin/env node
/**
 * 本地假 XorPay：在没有真实商户号（或不想真收钱）时，把「下单 → 扫码 → 回调 → 到账」整条链路跑通。
 *
 * 用法：
 *   1) `.dev.vars` 里加（XorPay 的配置优先取后台「站点设置」，环境变量是兜底，正好给本地用）：
 *        XORPAY_AID=fake_aid
 *        XORPAY_APP_SECRET=fake_secret
 *        XORPAY_API_BASE=http://127.0.0.1:8788
 *   2) 终端 A：node scripts/fake-xorpay.mjs   （或 npm run fake:xorpay）
 *   3) 终端 B：npm run dev                    （Worker 在 http://127.0.0.1:8787）
 *   4) 打开应用 → 侧边栏点「你有 N 个表格可」的数字 → 选好参数 → 点「去支付（微信扫码）」
 *      会拿到一张假二维码（内容是 weixin://wxpay/bizpayurl?pr=FAKE-xxx，扫不出来是正常的）
 *   5) 模拟用户付款（这一步会真的回调到你的 Worker）：
 *        curl.exe -X POST http://127.0.0.1:8788/__pay/<订单号>
 *      弹窗里的二维码会在 3 秒内自动消失、名额到账。
 *
 * 这个假网关也顺手覆盖几个边界：签名校验（sign 不对就报 sign_error）、
 * 查单接口（把订单标成已支付但不回调，就能验证「回调丢了靠轮询补到账」）。
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = Number(process.env.FAKE_XORPAY_PORT ?? 8788);
const APP_SECRET = process.env.FAKE_XORPAY_SECRET ?? 'fake_secret';
const md5 = (text) => createHash('md5').update(text, 'utf8').digest('hex');

/** order_id → 订单 */
const orders = new Map();

function readForm(request) {
  return new Promise((resolve) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => resolve(new URLSearchParams(raw)));
  });
}

function sendJson(response, payload) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`);

  // 下单：POST /api/pay/{aid}
  if (request.method === 'POST' && url.pathname.startsWith('/api/pay/')) {
    const form = await readForm(request);
    const orderId = form.get('order_id') ?? '';
    const expected = md5(
      `${form.get('name')}${form.get('pay_type')}${form.get('price')}${orderId}${form.get('notify_url')}${APP_SECRET}`,
    );
    if (form.get('sign') !== expected) return sendJson(response, { status: 'sign_error' });
    const aoid = randomUUID().replace(/-/g, '');
    orders.set(orderId, {
      aoid,
      price: form.get('price'),
      notifyUrl: form.get('notify_url') ?? '',
      paid: false,
    });
    console.log(`[fake-xorpay] 下单 ${orderId} ¥${form.get('price')} (${form.get('pay_type')})`);
    return sendJson(response, {
      status: 'ok',
      aoid,
      expire_in: 7200,
      info: { qr: `weixin://wxpay/bizpayurl?pr=FAKE-${aoid.slice(0, 12)}` },
    });
  }

  // 查单：GET /api/query2/{aid}?order_id=&sign=
  if (request.method === 'GET' && url.pathname.startsWith('/api/query2/')) {
    const orderId = url.searchParams.get('order_id') ?? '';
    if (url.searchParams.get('sign') !== md5(`${orderId}${APP_SECRET}`)) {
      return sendJson(response, { status: 'sign_error' });
    }
    const order = orders.get(orderId);
    return sendJson(response, { status: order ? (order.paid ? 'success' : 'new') : 'not_exist' });
  }

  // 模拟付款：POST /__pay/{order_id} → 标记已支付 + 按官方格式回调
  if (request.method === 'POST' && url.pathname.startsWith('/__pay/')) {
    const orderId = url.pathname.slice('/__pay/'.length);
    const order = orders.get(orderId);
    if (!order) {
      response.writeHead(404).end('unknown order');
      return;
    }
    order.paid = true;
    const payTime = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const payload = new URLSearchParams({
      aoid: order.aoid,
      order_id: orderId,
      pay_price: order.price ?? '0.00',
      pay_time: payTime,
      more: '',
      detail: JSON.stringify({
        transaction_id: `FAKE${order.aoid.slice(0, 8)}`,
        bank_type: 'FAKE',
        buyer: 'fake@example.com',
      }),
    });
    payload.set('sign', md5(`${order.aoid}${orderId}${order.price}${payTime}${APP_SECRET}`));
    const notified = await fetch(order.notifyUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: payload,
    })
      .then((res) => `${res.status} ${res.statusText}`)
      .catch((error) => `failed: ${error.message}`);
    console.log(`[fake-xorpay] 回调 ${order.notifyUrl} → ${notified}`);
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(`paid ${orderId} (${notified})\n`);
    return;
  }

  // 只标记已支付、不发回调：用来验证「回调丢了，前端轮询也能把名额补上」
  if (request.method === 'POST' && url.pathname.startsWith('/__pay-quiet/')) {
    const orderId = url.pathname.slice('/__pay-quiet/'.length);
    const order = orders.get(orderId);
    if (!order) {
      response.writeHead(404).end('unknown order');
      return;
    }
    order.paid = true;
    console.log(`[fake-xorpay] 静默标记已支付 ${orderId}（不发回调，靠查单兜底）`);
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(`quiet-paid ${orderId}\n`);
    return;
  }

  response.writeHead(404, { 'content-type': 'text/plain' });
  response.end('fake xorpay: POST /api/pay/{aid} | GET /api/query2/{aid} | POST /__pay/{order_id} | POST /__pay-quiet/{order_id}\n');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[fake-xorpay] http://127.0.0.1:${PORT}（app secret: ${APP_SECRET}）`);
});
