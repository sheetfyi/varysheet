// 本机（国内网络）直连 *.workers.dev 会被拦，需要走系统代理；而 Node 的 fetch（undici）
// 默认不读 HTTP(S)_PROXY，于是 `BASE_URL=https://... node scripts/smoke-test.mjs`
// 会一直卡在第一个请求上（不报错，就是等）。这个文件给原生 fetch 注入一个 ProxyAgent
// dispatcher，保留原生 FormData / Blob 等行为。
//
// 用法（PowerShell，先确认系统代理端口，例如 127.0.0.1:10809）：
//   $env:HTTPS_PROXY = 'http://127.0.0.1:10809'
//   $env:BASE_URL    = 'https://varysheet.<subdomain>.workers.dev'
//   node --import "file:///<仓库路径>/tools/online-smoke-proxy.mjs" scripts/smoke-test.mjs
//
// 说明：GitHub Actions 里不需要（CI 跑在墙外，直连即可）。
import { ProxyAgent } from 'undici';

const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
if (proxy) {
  const dispatcher = new ProxyAgent(proxy);
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => nativeFetch(input, { ...init, dispatcher });
  console.log(`[online-smoke-proxy] fetch 走代理 ${proxy}`);
} else {
  console.log('[online-smoke-proxy] 未设置 HTTPS_PROXY / HTTP_PROXY，按直连处理');
}
