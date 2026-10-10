/**
 * /api/branding* —— 站点外观（公开接口，不需要登录）。
 *
 *   GET /api/branding        站点名称 + 图标地址（页面标题 / favicon / 登录页用）
 *   GET /api/branding/icon   站点图标本体（管理员在「后台 → 站点设置」里上传）
 *
 * 名称与图标存在 D1 的 `settings` 表 + R2，没上传过图标时 `iconUrl` 是 null，
 * 前端会退回内置的默认标识。图标地址带 `?v=<updated_at>`，因此这里可以放心用长期强缓存：
 * 管理员换图标后地址会跟着变，浏览器自然拿到新的。
 */
import { json, notFound } from '../http';
import { brandingPayload, loadSiteIcon, loadSiteSettings } from '../settings';
import type { RequestContext, Route } from '../types';

/** 站点名称 + 图标地址；未登录也能拿（登录页要在登录前就显示品牌）。 */
async function brandingHandler(ctx: RequestContext): Promise<Response> {
  const settings = await loadSiteSettings(ctx.env);
  return json(brandingPayload(settings));
}

/** 图标本体（没上传过就是 404，前端自然回退到默认标识）。 */
async function iconHandler(ctx: RequestContext): Promise<Response> {
  const settings = await loadSiteSettings(ctx.env);
  const icon = await loadSiteIcon(ctx.env, settings);
  if (!icon) throw notFound('站点图标未设置');

  if ((ctx.request.headers.get('if-none-match') ?? '') === icon.etag) {
    return new Response(null, { status: 304, headers: { etag: icon.etag } });
  }

  return new Response(icon.body, {
    headers: {
      'content-type': icon.mime,
      'content-length': String(icon.size),
      etag: icon.etag,
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
}

export const brandingRoutes: Route[] = [
  { method: 'GET', path: '/api/branding', handler: brandingHandler },
  { method: 'GET', path: '/api/branding/icon', handler: iconHandler },
];
