/**
 * Worker environment bindings (see wrangler.jsonc).
 *
 * 存储拆成了「用户库 + 若干表格分片库」（见 src/worker/shards.ts）：
 *   DB                 用户库：账号 / 会话 / 站点设置 / 购买记录 / @提醒 / 分片注册表
 *   DB_TABLES_TRIAL    表格分片（试用表格），绑定式访问，最快
 *   DB_TABLES_BASIC    表格分片（基础表格），绑定式访问，最快
 *   DB_TABLES_PRO      表格分片（专业表格），绑定式访问，最快
 * 管理员在后台**动态新建**的备用分片没法加绑定，改用 Cloudflare D1 HTTP 接口访问，
 * 需要下面两个 secret：
 *   CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN（Account > D1 > Edit 权限）
 */
export interface Env {
  DB: D1Database;
  /** 试用表格主分片（可选：没绑定就只用注册表里登记的分片） */
  DB_TABLES_TRIAL?: D1Database;
  /** 基础表格主分片（可选：没绑定就只用注册表里登记的分片） */
  DB_TABLES_BASIC?: D1Database;
  /** 专业表格主分片（可选） */
  DB_TABLES_PRO?: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  /** Cloudflare 账号 ID（管理员后台新建 / 挂载备用分片时用） */
  CLOUDFLARE_ACCOUNT_ID?: string;
  /** Cloudflare API Token（需要 Account > D1 > Edit 权限） */
  CLOUDFLARE_API_TOKEN?: string;
  /** Cloudflare API 基址，默认 https://api.cloudflare.com/client/v4（本地调试可覆盖） */
  D1_API_BASE?: string;
  /** 站点名称（品牌）的兜底值；管理员可在「后台 → 站点设置」里覆盖（存在 D1 settings 表） */
  APP_NAME?: string;
  /**
   * 部署批次标识：CI 用 `wrangler deploy --var BUILD_ID=<commit sha>` 注入，手动 / 本地部署没有。
   * `/api/health` 会把它作为 `build` 返回，线上冒烟测试靠它确认「新版本真的在服务」——
   * 紧贴 `wrangler deploy` 启动时边缘还有几秒在跑上一版（见 .github/workflows/deploy.yml）。
   */
  BUILD_ID?: string;
  MAX_UPLOAD_MB?: string;
  /** 单张表格的记录数上限（默认 500）：到上限后只能查看 / 查询，不再接受新增；只作用于基础表格 */
  MAX_DATABASE_RECORDS?: string;
  /** 单张表格的附件总容量上限，单位 MB（默认 1024 = 1GB）；只作用于基础表格 */
  MAX_DATABASE_STORAGE_MB?: string;
  /** 试用表格的记录数上限（默认 100，见 shared/tableKind.ts） */
  TRIAL_MAX_DATABASE_RECORDS?: string;
  /** 试用表格的附件总容量上限，单位 MB（默认 512 = 0.5GB） */
  TRIAL_MAX_DATABASE_STORAGE_MB?: string;
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
  /**
   * 试用表格的数据保留期（天，默认 180 = 半年）：超过这个时间的记录与附件会被定时
   * 任务自动清除（见 src/worker/retention.ts）；设成 0 表示关闭试用表格的自动清除。
   */
  TRIAL_TABLE_RETENTION_DAYS?: string;
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
  /**
   * 本次请求涉及的表格分片库（表格 / 字段 / 记录 / 视图 / 分享 / 备注 / 附件都在这里）。
   *
   * 由访问检查（`requireDatabaseAccess` / `accessForXxx`）顺手填好：一张表格的所有数据
   * 都在同一个分片里，所以做完一次访问检查之后，路由里统一用 `tableDb(ctx)` 读到底，
   * 不用每次都去猜「这条数据在哪个库」。没有先做访问检查就调用 `tableDb(ctx)` 会抛 500。
   */
  db?: D1Database;
}

export type RouteHandler = (ctx: RequestContext) => Promise<Response> | Response;

export interface Route {
  method: string;
  /** e.g. `/api/databases/:id/records` */
  path: string;
  handler: RouteHandler;
}
