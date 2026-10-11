/**
 * 站点品牌（名称 + 图标）在前端的落地：`<title>` 与 favicon 都跟着「后台 → 站点设置」走。
 *
 * 名称与图标地址有两个来源，内容都是同一份服务端数据：
 *   - `GET /api/session` 的 `appName` / `siteIconUrl`（登录后的会话里就有，见 App.tsx）；
 *   - `GET /api/branding`（未登录也能拿：登录页 / 邀请页 / 公开分享页，main.tsx 启动时先拉一次）。
 *
 * 管理员在后台改完名称或图标后会重新拉一次会话，于是标题与 favicon 立刻跟着变。
 */
import type { BrandingResponse } from '../shared/types';
import { api } from './api';

/** 站点名称的兜底值（与 `src/worker/settings.ts` 的默认值保持一致） */
export const DEFAULT_SITE_NAME = 'Varysheet';

/**
 * 登录页副标题的兜底值（与 `src/worker/settings.ts` 的 `DEFAULT_LOGIN_TAGLINE` 一致）：
 * 管理员没在「后台 → 站点设置」里改过时显示这句。
 */
export const DEFAULT_LOGIN_TAGLINE = '登录以继续你的表格';

/** favicon 用同一个 `<link rel="icon">` 元素反复更新；地址里的 `?v=` 由服务端带上，换图标即换地址。 */
function setFavicon(href: string | null): void {
  const existing = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  if (!href) {
    // 没上传过站点图标：不挂 favicon，浏览器用默认图标（也就不会每次去请求不存在的 favicon.ico）
    existing?.remove();
    return;
  }
  const link = existing ?? document.createElement('link');
  link.rel = 'icon';
  link.href = href;
  if (!existing) document.head.append(link);
}

/** 把站点名称 / 图标应用到 `<title>` 与 favicon（名称空着就用默认值）。 */
export function applyBranding(branding: { siteName?: string | null; iconUrl?: string | null }): void {
  const name = (branding.siteName ?? '').trim() || DEFAULT_SITE_NAME;
  document.title = name;
  setFavicon(branding.iconUrl ?? null);
}

/** 拉一次公开的品牌信息并应用；失败就保持现状（标题只是锦上添花，不能因此挡住渲染）。 */
export async function syncBrandingFromApi(): Promise<BrandingResponse | null> {
  try {
    const branding = await api.branding();
    applyBranding(branding);
    return branding;
  } catch {
    return null;
  }
}
