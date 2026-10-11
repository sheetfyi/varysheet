/**
 * /api/guide —— 系统使用说明 + 系统规则与内容合规条款（公开接口，不需要登录）。
 *
 *   GET /api/guide   两份正文（标题 / 内容 / 版本指纹 / 是否默认文案）
 *
 * 为什么是公开的：注册页在**提交之前**就要展示条款正文并让用户勾选「已了解系统的规则和
 * 内容合规的要求」；侧边栏「改密码」左侧的黄色「?」圆点也用同一份数据（登录后可见）。
 * 正文存在 D1 的 `settings` 表里（管理员在「后台 → 系统管理」里改），没改过就用
 * `src/shared/policy.ts` 里的默认文案。两份都不是敏感信息。
 */
import { json } from '../http';
import { guidePayload, loadSiteSettings } from '../settings';
import type { RequestContext, Route } from '../types';

async function guideHandler(ctx: RequestContext): Promise<Response> {
  return json(guidePayload(await loadSiteSettings(ctx.env)));
}

export const guideRoutes: Route[] = [{ method: 'GET', path: '/api/guide', handler: guideHandler }];
