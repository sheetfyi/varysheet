/**
 * 临时诊断脚本（不属于产品代码）：模拟「浏览器拿不到会话 Cookie」的手机环境，
 * 验证「登录后不会被打回登录页」。
 *
 * 做法：本地起一个反向代理，转发时**丢掉响应里的 `Set-Cookie`** —— 这正是无痕模式 /
 * 「阻止所有 Cookie」/ 部分 App 内嵌浏览器的表现：登录接口返回 200，但下一个请求已经是未登录。
 * 然后让真实浏览器（Edge / Chrome）以 390x844 手机视口走一遍登录流程：
 *
 *   修复前：闪一下内容页 → 立刻回到登录页（“登录后闪退”）
 *   修复后：自动改用响应体里的令牌 + `Authorization: Bearer`，稳定停在内容页
 *
 * 用法：node tools/mobile-check/nocookie-login.mjs <browser.exe> <targetUrl> <email> <password>
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [browserPath, target, email, password] = process.argv.slice(2);
if (!browserPath || !target || !email || !password) {
  console.error('用法：node nocookie-login.mjs <browser.exe> <targetUrl> <email> <password>');
  process.exit(2);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// 安全网：卡住就别无限等（正常一轮 30 秒内跑完）
setTimeout(() => {
  console.error('watchdog 超时（120s），强制退出');
  process.exit(3);
}, 120000).unref();
const results = [];
const record = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
};

/** 转发到 `target` 的代理：响应里的 Set-Cookie 一律丢掉（浏览器因此永远存不下会话） */
function startCookieStrippingProxy() {
  const readBody = (req) =>
    new Promise((resolve) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks)));
    });
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', target);
      const headers = { ...req.headers };
      // 丢掉逐跳头部和内容协商头：让 Node 自己协商压缩，避免把浏览器声明却不支持
      // 的编码（如 zstd）原样转发导致响应体解不开。
      for (const key of ['host', 'connection', 'accept-encoding', 'content-length', 'transfer-encoding', 'if-none-match', 'if-modified-since']) {
        delete headers[key];
      }
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      const upstream = await fetch(url, {
        method: req.method,
        headers,
        body: hasBody ? await readBody(req) : undefined,
        redirect: 'manual',
      });
      const out = {};
      for (const [key, value] of upstream.headers) {
        const name = key.toLowerCase();
        // set-cookie 是关键：会话 cookie 到不了浏览器
        // content-encoding / content-length：Node 的 fetch 已经把响应体解压过了，
        // 原样转发会让浏览器按“压缩后的长度”截断，页面直接白屏。
        if (name === 'set-cookie' || name === 'content-encoding' || name === 'content-length' || name === 'transfer-encoding') {
          continue;
        }
        out[key] = value;
      }
      const body = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, { ...out, 'content-length': String(body.byteLength) });
      res.end(body);
      if (process.env.PROXY_DEBUG) console.error(`${req.method} ${req.url} -> ${upstream.status} ${body.byteLength}B`);
    } catch (cause) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`proxy error: ${cause}`);
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const proxy = await startCookieStrippingProxy();
const url = `http://127.0.0.1:${proxy.address().port}/`;
console.log(`代理 ${url}  ->  ${target}（Set-Cookie 已剥离）`);

const profile = await mkdtemp(join(tmpdir(), 'cn-nocookie-'));
const browser = spawn(
  browserPath,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--window-size=390,844',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let devtoolsPort = '';
for (let i = 0; i < 120 && !devtoolsPort; i += 1) {
  await sleep(100);
  try {
    const text = await readFile(join(profile, 'DevToolsActivePort'), 'utf8');
    devtoolsPort = String(text.split('\n')[0]).trim();
  } catch {
    // 还没写出来
  }
}
if (process.env.PROXY_DEBUG) console.error(`stage: devtools port = ${devtoolsPort || '(none)'}`);
if (!devtoolsPort) {
  browser.kill();
  proxy.close();
  console.log('FAIL 无法启动浏览器调试端口');
  process.exit(1);
}

const list = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`)).json();
const page = list.find((item) => item.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const logs = [];

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});
if (process.env.PROXY_DEBUG) console.error('stage: CDP 已连接');

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  const done = pending.get(msg.id);
  if (done) {
    pending.delete(msg.id);
    done(msg);
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const details = msg.params.exceptionDetails;
    logs.push(`exception: ${details.exception?.description ?? details.text}`);
  } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    logs.push(`console.error: ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`);
  }
});

function send(method, params = {}) {
  seq += 1;
  const id = seq;
  return new Promise((resolve) => {
    // 加超时：CDP 偶发不回包时不要卡死整个脚本
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ timeout: true });
    }, 15000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (res.result?.exceptionDetails) return `<<exception ${res.result.exceptionDetails.text}>>`;
  return res.result?.result?.value;
}

/** 截图存到本目录，方便肉眼确认「停在内容页」还是「被打回登录页」 */
async function shot(name) {
  const res = await send('Page.captureScreenshot', { format: 'png' });
  if (process.env.PROXY_DEBUG) console.error(`stage: screenshot ${name} -> ${res.result?.data ? 'ok' : JSON.stringify(res).slice(0, 120)}`);
  if (!res.result?.data) return;
  await writeFile(join(import.meta.dirname, `nocookie-${name}.png`), Buffer.from(res.result.data, 'base64'));
}

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 2,
  mobile: true,
  screenWidth: 390,
  screenHeight: 844,
});
await send('Page.navigate', { url });
let booted = '';
for (let i = 0; i < 60 && !booted; i += 1) {
  await sleep(250);
  booted = await evaluate(
    `document.querySelector('.auth-card') ? 'login' : (document.querySelector('.app-shell') ? 'app' : '')`,
  );
}
if (process.env.PROXY_DEBUG) console.error(`stage: booted = ${booted || '(nothing)'}`);
await shot('before-login');
record('打开页面时显示登录页', booted === 'login', booted || '页面没有渲染出登录页 / 工作区');
if (booted !== 'login') {
  console.log(`    debug href=${await evaluate(`location.href`)} html=${await evaluate(`document.documentElement.outerHTML.length`)}`);
}

const fill = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return 'missing';
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return el.value;
})()`;

await evaluate(fill('.auth-card input[type="email"], .auth-card input[autocomplete="email"]', email));
await evaluate(fill('.auth-card input[type="password"]', password));
await sleep(200);
const clicked = await evaluate(
  `(() => { const b = document.querySelector('.auth-card button[type=submit]'); if (!b) return 'missing'; b.click(); return 'clicked'; })()`,
);
record('提交登录表单', clicked === 'clicked', String(clicked));

let landed = false;
for (let i = 0; i < 60 && !landed; i += 1) {
  await sleep(250);
  landed = (await evaluate(`!!document.querySelector('.app-shell')`)) === true;
}
record('登录后停在内容页（工作区出现）', landed);

// 再等 3 秒，确认没有被「打回登录页」
await sleep(3000);
await shot('after-login');
const cookie = await evaluate(`document.cookie`);
record('浏览器里确实没有会话 cookie', cookie === '', String(cookie));
record(
  '3 秒后仍在内容页（没有闪退回登录页）',
  (await evaluate(`!!document.querySelector('.app-shell') && !document.querySelector('.auth-card')`)) === true,
);
const token = await evaluate(`window.localStorage.getItem('varysheet.session-token')`);
record('客户端把令牌存到了本地（cookie 兜底生效）', typeof token === 'string' && token.length > 20);
record(
  '本地令牌通过 Authorization 头能认证',
  (await evaluate(
    `fetch('/api/session', { headers: { authorization: 'Bearer ' + window.localStorage.getItem('varysheet.session-token') } })
       .then((r) => r.json()).then((d) => (d.user && d.user.email) || null)`,
  )) === email,
);

console.log(
  `\n${results.every(Boolean) ? 'RESULT: PASS' : 'RESULT: FAIL'}  (${results.filter(Boolean).length}/${results.length} 项)`,
);
if (logs.length) console.log('页面错误:\n  ' + logs.slice(0, 5).join('\n  '));

ws.close();
browser.kill();
proxy.close();
await sleep(300);
await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });


