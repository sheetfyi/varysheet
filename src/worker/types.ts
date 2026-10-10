/** Worker environment bindings (see wrangler.jsonc). */
export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  /** 站点名称（品牌）的兜底值；管理员可在「后台 → 站点设置」里覆盖（存在 D1 settings 表） */
  APP_NAME?: string;
  MAX_UPLOAD_MB?: string;
  /** 单张表格的记录数上限（默认 500）：到上限后只能查看 / 查询，不再接受新增 */
  MAX_DATABASE_RECORDS?: string;
  /** 单张表格的附件总容量上限，单位 MB（默认 1024 = 1GB） */
  MAX_DATABASE_STORAGE_MB?: string;
  ALLOW_SIGNUP?: string;
  /**
   * Resend API Key（secret，`npx wrangler secret put RESEND_API_KEY`）；
   * 也可以在「后台 → 站点设置」里直接填（那边优先），两边都没有则注册确认码直接回显
   */
  RESEND_API_KEY?: string;
  /** 发件人，例如 `Varysheet <admin@varysheet.com>`；也可以在「后台 → 站点设置」里改（那边优先） */
  RESEND_FROM_EMAIL?: string;
  /** 超级管理员的登录邮箱：登录时会被自动创建 / 提升为管理员；兜底值可在「后台 → 站点设置」里改 */
  ADMIN_EMAIL?: string;
  /** 超级管理员初始密码（只用于「首次创建账号」；已存在时不会覆盖，除非 ADMIN_RESET_PASSWORD=true） */
  ADMIN_PASSWORD?: string;
  /** 设为 "true" 时用 ADMIN_PASSWORD 强制同步管理员密码（改完记得去掉） */
  ADMIN_RESET_PASSWORD?: string;
  /** 逗号分隔：这些域名的邮箱不真的发信，直接把确认码回显在响应里（给自动化测试用） */
  AUTH_ECHO_CODE_DOMAINS?: string;
  /** 确认码有效期（分钟），默认 15 */
  AUTH_CODE_TTL_MINUTES?: string;
  /**
   * 基础表格的数据保留期（天，默认 365）：超过这个时间的记录与附件会被定时任务
   * 自动清除（见 src/worker/retention.ts）。专业表格永远不受影响；设成 0 表示关闭
   * 自动清除（只建议本地调试用）。
   */
  BASIC_TABLE_RETENTION_DAYS?: string;
}

export interface AuthedUser {
  id: string;
  email: string;
  name: string;
  /** 管理员：可以访问 /api/admin/* */
  isAdmin: boolean;
}

export type AccessLevel = 'view' | 'edit' | 'manage';

export interface RequestContext {
  request: Request;
  env: Env;
  url: URL;
  params: Record<string, string>;
  user: AuthedUser | null;
}

export type RouteHandler = (ctx: RequestContext) => Promise<Response> | Response;

export interface Route {
  method: string;
  /** e.g. `/api/databases/:id/records` */
  path: string;
  handler: RouteHandler;
}
