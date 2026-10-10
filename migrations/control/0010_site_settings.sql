-- Varysheet - 站点设置（D1 / SQLite）
-- Applied with:  npx wrangler d1 migrations apply cloudnotion-db --local|--remote
--
-- 管理员在「后台 → 站点设置」里能改的东西都放这张表（键值对）：
--   site_name             站点名称（前端标题 / 侧边栏品牌 / 邮件标题）
--   site_icon_mime        站点图标的 MIME（图标本身存在 R2 的 site/branding-icon）
--   site_icon_updated_at  图标最后上传时间，同时也是图标 URL 的破缓存版本号
--   resend_api_key        Resend 发信密钥（留空则回落到 Worker secret / 不发信）
--   resend_from_email     发件人，例如 Varysheet <admin@varysheet.com>
--
-- 读取顺序是「数据库里的值 → 环境变量 / secret → 代码默认值」（见 src/worker/settings.ts），
-- 所以升级前用 `wrangler secret` / .dev.vars 配好的老部署不用改，迁移完照常工作。
-- 表不存在或某一行没有时都按「没配」处理，因此没跑迁移的老库也能启动。

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
