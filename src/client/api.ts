/**
 * Thin typed wrapper around the Varysheet JSON API.
 * Session handling relies on the HttpOnly cookie, hence `credentials: 'same-origin'`.
 *
 * 另有一层兜底：Cookie 存不下来的浏览器（无痕模式、「阻止所有 Cookie」、部分 App 内嵌
 * 浏览器）里，登录接口虽然返回 200，下一个请求却已经是未登录 —— 表现就是「登录后闪一下
 * 又回到登录页」。这种环境下服务端会把令牌放进响应体（请求时带 `tokenInBody: true`），
 * 由这里保存在本地并通过 `Authorization: Bearer` 头带上，见 `readSessionToken`。
 */
import type {
  AdminAccountDatabasesResponse,
  AdminDeleteUsersResponse,
  AdminPasswordResetResponse,
  AdminSettings,
  AdminSettingsResponse,
  AdminShardsResponse,
  AdminUserListResponse,
  BrandingResponse,
  CellEditLocks,
  DatabaseChanges,
  DatabaseDetail,
  DatabaseSummary,
  FieldType,
  GuideResponse,
  InboxResponse,
  InviteAcceptResponse,
  InviteDetail,
  LoginResponse,
  PasswordResetRequested,
  Property,
  PropertyConfig,
  PublicDatabaseResponse,
  RecordNote,
  RegistrationPending,
  RowRecord,
  RowValues,
  SessionUser,
  TableKind,
  TableOrder,
  TablePurchase,
  TableQuotaPayment,
  TableQuotaSet,
  VerifyRegistrationResponse,
  ViewConfig,
  ViewDef,
  ViewShareCreatedResponse,
  ViewType,
} from '../shared/types';
import type { XorpayPayType } from '../shared/xorpay';

export interface SessionPayload {
  user: SessionUser | null;
  databases: DatabaseSummary[];
  /** 表格名额（试用 / 基础 / 专业各自还能加几张）：登录后侧边栏直接就有数字可用 */
  quota: TableQuotaSet | null;
  maxUploadMb: number;
  appName: string;
  /** 站点图标地址（管理员上传过才有），侧边栏 / 顶部条 / 登录页的标识区用 */
  siteIconUrl: string | null;
  /** 登录页副标题（管理员在「后台 → 站点设置」里改），未登录时登录卡片用它 */
  loginTagline: string;
}

export interface RecordsPage extends CellEditLocks {
  rows: RowRecord[];
  total: number;
  hasMore: boolean;
  /** 这一页记录上的备注（备注只增不改，可以直接合并进本地列表） */
  notes: RecordNote[];
}

/** 单条记录的最新状态：记录卡片打开 / 定时同步用（比整表分页轻） */
export interface RecordSync extends CellEditLocks {
  record: RowRecord;
  /** 这条记录上的备注，按 `createdAt` 升序 */
  notes: RecordNote[];
}

/**
 * 下单响应（`POST /api/quota/orders`）：
 *   - `purchase` 有值 = 还没开通收款，已经到账（201）；
 *   - `pay.qr` 有值 = 开通了收款，等扫码付款（202）。
 */
export interface QuotaOrderResponse {
  order: TableOrder;
  purchase: TablePurchase | null;
  /** 走支付时的支付信息（二维码内容）；没开通收款时为 null */
  pay: { payType: XorpayPayType; qr: string } | null;
  /** 站点是否已开通在线收款 */
  paymentEnabled: boolean;
  quota: TableQuotaSet;
}

/** 查单响应（`GET /api/quota/orders/:id`）：前端每 3 秒轮询一次，到账后自己关掉二维码 */
export interface QuotaOrderStatus {
  order: TableOrder;
  /** 状态中文文案，见 shared/xorpay.ts 的 `orderStatusText()` */
  statusText: string;
  quota: TableQuotaSet;
}

export interface UploadResult {
  file: { id: string; name: string; size: number; mime: string };
  url: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  form?: FormData;
  signal?: AbortSignal;
}

/**
 * 本地会话令牌的存储键。
 *
 * 正常情况下会话完全由 HttpOnly cookie 承载，这里什么都不存；只有服务端在响应体里
 * 下发了令牌（客户端主动带 `tokenInBody: true`）时才用得上。
 */
const SESSION_TOKEN_KEY = 'varysheet.session-token';
/** 品牌改名前的旧键（读到就迁到新键，老用户的令牌不会丢） */
const LEGACY_SESSION_TOKEN_KEYS = ['qafield.session-token'];
let memoryToken: string | null = null;

/** 读取本地会话令牌（无痕 / 隐私模式下 localStorage 不可用，退化为内存）。 */
export function readSessionToken(): string | null {
  try {
    const current = window.localStorage.getItem(SESSION_TOKEN_KEY);
    if (current) return current;
    for (const legacyKey of LEGACY_SESSION_TOKEN_KEYS) {
      const legacy = window.localStorage.getItem(legacyKey);
      if (!legacy) continue;
      window.localStorage.setItem(SESSION_TOKEN_KEY, legacy);
      window.localStorage.removeItem(legacyKey);
      return legacy;
    }
    return memoryToken;
  } catch {
    return memoryToken;
  }
}

/** 保存会话令牌；传 `null` 清除（退出登录、会话被服务端判定失效时调用）。 */
export function setSessionToken(token: string | null): void {
  memoryToken = token;
  try {
    if (token === null) window.localStorage.removeItem(SESSION_TOKEN_KEY);
    else window.localStorage.setItem(SESSION_TOKEN_KEY, token);
    for (const legacyKey of LEGACY_SESSION_TOKEN_KEYS) window.localStorage.removeItem(legacyKey);
  } catch {
    // localStorage 直接抛异常也无所谓：令牌留在内存里，本次会话依然可用
  }
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const init: RequestInit = {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    signal: options.signal,
  };
  if (options.form) {
    init.body = options.form;
  } else if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
    init.headers = { 'content-type': 'application/json' };
  }
  // cookie 丢了也不怕：本地令牌通过 Authorization 头继续带着（服务端两种都认）
  const token = readSessionToken();
  if (token) {
    init.headers = { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` };
  }

  const response = await fetch(path, init);
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const envelope = payload as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(
      response.status,
      envelope?.error?.code ?? 'request_failed',
      envelope?.error?.message ?? `请求失败（${response.status}）`,
    );
  }
  return payload as T;
}

const json = <T,>(path: string, method: string, body?: unknown, signal?: AbortSignal): Promise<T> =>
  request<T>(path, { method, body, signal });

export const api = {
  session: (signal?: AbortSignal) => json<SessionPayload>('/api/session', 'GET', undefined, signal),
  /** 公开的品牌信息（站点名称 / 图标）：登录页、页面标题与 favicon 用，不需要登录 */
  branding: () => json<BrandingResponse>('/api/branding', 'GET'),
  /**
   * 公开的「系统使用说明 + 系统规则与内容合规条款」（`GET /api/guide`）：
   * 注册页要展示条款正文并让人勾选，侧边栏「?」圆点用它显示使用说明。
   */
  guide: () => json<GuideResponse>('/api/guide', 'GET'),
  /**
   * 注册第一步：只登记待确认的注册并发确认码，账号要等 `verifyRegistration` 之后才存在。
   * `acceptedTerms` 是注册时那个「我已阅读并同意《系统规则与内容合规条款》」的勾选，
   * 必须为 true（服务端会拦，见 `routes/auth.ts`）。
   */
  register: (body: { email: string; password: string; name: string; acceptedTerms: boolean }) =>
    json<RegistrationPending>('/api/auth/register', 'POST', body),
  /** 注册第二步：填确认码，成功即返回已登录用户 */
  verifyRegistration: (body: { email: string; code: string; tokenInBody?: boolean }) =>
    json<VerifyRegistrationResponse>('/api/auth/register/verify', 'POST', body),
  /** 重新发送注册确认码（同一邮箱 60 秒一次） */
  resendRegistrationCode: (body: { email: string }) =>
    json<RegistrationPending>('/api/auth/register/resend', 'POST', body),
  /**
   * 登录。`tokenInBody: true` 时响应体里会多带一个会话令牌，供 Cookie 存不下来的
   * 浏览器兜底（见文件头部说明），正常调用不需要它。
   */
  login: (body: { email: string; password: string; tokenInBody?: boolean }) =>
    json<LoginResponse>('/api/auth/login', 'POST', body),
  /** 退出登录：服务端作废会话，同时清掉本地的兜底令牌 */
  logout: async () => {
    try {
      return await json<{ ok: true }>('/api/auth/logout', 'POST');
    } finally {
      setSessionToken(null);
    }
  },
  /** 登录后自助改密码（其它设备的会话会立即失效） */
  changePassword: (body: { currentPassword: string; newPassword: string }) =>
    json<{ ok: true; sessionsRevoked: boolean }>('/api/auth/password', 'POST', body),

  /**
   * 找回密码（登录页「忘记密码？找回密码」）：系统生成一个**临时密码**换掉旧密码、
   * 作废该账号的全部会话，并把新密码邮件发给本人（口径与管理端重置密码一致）。
   *
   * 邮箱不存在时服务端返回 404 `email_not_found`，提示文案就是
   * 「这个邮箱不存在，请确认是否正确！」（直接展示 `ApiError.message`）；
   * 没配邮件服务或收件人是保留测试域时，临时密码会回显在 `devPassword` 里。
   */
  requestPasswordReset: (body: { email: string }) =>
    json<PasswordResetRequested>('/api/auth/password-reset', 'POST', body),

  /* -------------------------------------------------------------- 管理后台 */
  adminListUsers: (params?: { search?: string; limit?: number; offset?: number }) => {
    const query = new URLSearchParams();
    if (params?.search) query.set('search', params.search);
    if (params?.limit !== undefined) query.set('limit', String(params.limit));
    if (params?.offset !== undefined) query.set('offset', String(params.offset));
    const suffix = query.toString() ? `?${query}` : '';
    return json<AdminUserListResponse>(`/api/admin/users${suffix}`, 'GET');
  },
  adminUpdateUser: (id: string, body: { name?: string; email?: string }) =>
    json<{ user: AdminUserListResponse['users'][number]; updatedSelf: boolean }>(
      `/api/admin/users/${encodeURIComponent(id)}`,
      'PATCH',
      body,
    ),
  adminResetUserPassword: (id: string, body: { password?: string } = {}) =>
    json<AdminPasswordResetResponse>(`/api/admin/users/${encodeURIComponent(id)}/password`, 'POST', body),
  /** 批量删除账号：连同他拥有的表格（记录 / 备注 / 上传文件）一起清理 */
  adminDeleteUsers: (ids: string[]) =>
    json<AdminDeleteUsersResponse>('/api/admin/users/delete', 'POST', { ids }),

  /**
   * 「后台 → 站点设置」当前值：站点名称 / 图标 / 管理员邮箱 / Resend 密钥（只回传掩码）与发件人。
   * 保存后的三个接口都会连带返回最新的 `branding`，前端据此立刻刷新页面标题与 favicon。
   */
  adminSettings: () => json<{ settings: AdminSettings }>('/api/admin/settings', 'GET'),
  /** 保存站点设置；字段留空表示「清掉数据库里的值」，退回 Worker secret / 默认值 */
  adminUpdateSettings: (body: {
    siteName?: string;
    adminEmail?: string;
    resendApiKey?: string;
    resendFromEmail?: string;
    /** 登录页副标题（留空 = 清掉数据库里的值，退回默认文案） */
    loginTagline?: string;
    /** 系统规则与内容合规条款（留空 = 退回代码默认文案） */
    termsContent?: string;
    /** 系统使用说明（留空 = 退回代码默认文案） */
    guideContent?: string;
    /** XorPay 收款（表格名额购买）：填好 appid + app secret 就立刻开启微信扫码下单 */
    xorpayAid?: string;
    xorpayAppSecret?: string;
  }) => json<AdminSettingsResponse>('/api/admin/settings', 'PATCH', body),
  /** 上传 / 替换站点图标（multipart 的 `file` 字段） */
  adminUploadSiteIcon: (file: File) => {
    const form = new FormData();
    form.set('file', file);
    return request<AdminSettingsResponse>('/api/admin/settings/icon', { method: 'POST', form });
  },
  /** 移除站点图标（退回内置的默认标识） */
  adminDeleteSiteIcon: () => json<AdminSettingsResponse>('/api/admin/settings/icon', 'DELETE'),

  /**
   * 「后台 → 存储分片」：表格数据分散在若干 D1 分片库里（见 docs/storage.md），
   * 快满时在这里新建 / 挂载新的分片。新建、挂载与刷新用量都要 Cloudflare API 凭据
   * （`CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`），没配时接口返回 501。
   */
  adminShards: () => json<AdminShardsResponse>('/api/admin/shards', 'GET'),
  /** 新建一个 D1 库并挂载成分片（库名不填时按类型 + 日期自动生成） */
  adminCreateShard: (body: { kind: TableKind; name?: string; note?: string }) =>
    json<AdminShardsResponse>('/api/admin/shards', 'POST', body),
  /** 挂载一个已经存在的 D1 库（会先执行一遍建表脚本，幂等） */
  adminMountShard: (body: { databaseId: string; kind: TableKind; name?: string; note?: string; binding?: string }) =>
    json<AdminShardsResponse>('/api/admin/shards/mount', 'POST', body),
  /** 账号下的 D1 库（挂载现成的库时用来挑） */
  adminAccountDatabases: () => json<AdminAccountDatabasesResponse>('/api/admin/shards/databases', 'GET'),
  /** 去 Cloudflare 读一遍所有分片的用量并写回注册表 */
  adminRefreshShards: () =>
    json<AdminShardsResponse & { refreshed: number; failed: number }>('/api/admin/shards/refresh', 'POST', {}),
  /** 改名 / 备注 / 启停 / 绑定名 */
  adminUpdateShard: (id: string, body: { name?: string; note?: string; isActive?: boolean; binding?: string }) =>
    json<AdminShardsResponse>(`/api/admin/shards/${encodeURIComponent(id)}`, 'PATCH', body),
  /** 从注册表里摘掉这个分片（**不动** D1 库里的数据） */
  adminRemoveShard: (id: string) => json<AdminShardsResponse>(`/api/admin/shards/${encodeURIComponent(id)}`, 'DELETE'),

  /** 受邀人打开邀请链接：邀请信息（表格 / 视图 / 邀请人），无需登录 */
  invite: (token: string) => json<{ invite: InviteDetail }>(`/api/invites/${encodeURIComponent(token)}`, 'GET'),
  /** 接受邀请：填昵称 + 密码即完成注册，并直接登录（自动获得该视图分享） */
  acceptInvite: (token: string, body: { name: string; password: string; acceptedTerms: boolean; tokenInBody?: boolean }) =>
    json<InviteAcceptResponse>(`/api/invites/${encodeURIComponent(token)}/accept`, 'POST', body),

  /**
   * 表格名额（试用 / 基础 / 专业各自还能加几张）+ 收款是否已开通。
   * 侧边栏的数字、数量说明弹窗（据此决定显示「微信扫码支付」还是「下单立即到账」）都用它。
   */
  quota: () => json<{ quota: TableQuotaSet; payment: TableQuotaPayment }>('/api/quota', 'GET'),
  /**
   * 购买表格名额（老接口，保留兼容；前端已改走 `createQuotaOrder`）：
   * 没开通收款时立刻写一条购买流水并加名额（201 + `purchase`）；开通了收款则返回
   * 202 + `pay.qr`（微信支付二维码），名额要等付款到账。
   * 基础 9.9 元/月、专业 99.9 元/月：`months` 是**总购买时长**
   * （时长单位「月」× 数量 1 ~ 12，或时长单位「年」× 数量 1 ~ 5 → 1 ~ 60 个月，
   * 见 shared/tableKind.ts 的 `purchaseMonthsOf` / `isPurchasableMonths`），
   * 金额由服务端按「每月单价 × 数量 × 月数」算好写进流水。
   */
  purchaseQuota: (body: { kind: TableKind; count: number; months: number; note?: string }) =>
    json<{ quota: TableQuotaSet; purchase: TablePurchase | null; order: TableOrder; pay: { payType: XorpayPayType; qr: string } | null }>(
      '/api/quota/purchases',
      'POST',
      body,
    ),
  /**
   * 下单买名额（购买弹窗走这条）：
   *   - 已开通收款（后台「站点设置」里填了 XorPay appid + app secret）：202 + `pay.qr`，
   *     要等回调 / 查单确认后名额才到账；
   *   - 没开通（本地开发 / CI）：201 + `purchase`，立刻到账。
   * 带 `databaseId` 时是**续费**某张基础 / 专业表格（不新增名额，只延长这张表的时长）。
   */
  createQuotaOrder: (body: {
    kind: TableKind;
    count: number;
    months: number;
    payType?: XorpayPayType;
    note?: string;
    /** 续费哪张表格（表格清单里的「续费」按钮带上它）；不传 = 普通购买 */
    databaseId?: string;
  }) => json<QuotaOrderResponse>('/api/quota/orders', 'POST', body),
  /** 查一张订单（服务端会顺带向 XorPay 兜底查一次：回调丢了也能补到账） */
  quotaOrder: (id: string) => json<QuotaOrderStatus>(`/api/quota/orders/${encodeURIComponent(id)}`, 'GET'),
  listDatabases: () => json<{ databases: DatabaseSummary[] }>('/api/databases', 'GET'),
  createDatabase: (body: { name: string; kind?: TableKind; icon?: string; description?: string; templateId?: string }) =>
    json<DatabaseDetail>('/api/databases', 'POST', body),
  getDatabase: (id: string, params?: { limit?: number; offset?: number }) => {
    const query = new URLSearchParams();
    if (params?.limit !== undefined) query.set('limit', String(params.limit));
    if (params?.offset !== undefined) query.set('offset', String(params.offset));
    const suffix = query.toString() ? `?${query}` : '';
    return json<DatabaseDetail>(`/api/databases/${id}${suffix}`, 'GET');
  },
  updateDatabase: (id: string, body: { name?: string; icon?: string; description?: string }) =>
    json<DatabaseDetail>(`/api/databases/${id}`, 'PATCH', body),
  deleteDatabase: (id: string) => json<{ ok: true }>(`/api/databases/${id}`, 'DELETE'),
  rows: (id: string, params: { limit?: number; offset?: number }) => {
    const query = new URLSearchParams();
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.offset !== undefined) query.set('offset', String(params.offset));
    return json<RecordsPage>(`/api/databases/${id}/records?${query}`, 'GET');
  },

  /**
   * 增量同步：只取「比 `since` 新的改动」（改过的行 / 删掉的行 / 新备注 / 已用掉的格子）。
   * 表格页开着的时候每隔几秒轮询一次，别人改的单元格不用刷新页面就会出现。
   */
  changes: (id: string, since: number) =>
    json<DatabaseChanges>(`/api/databases/${id}/changes?since=${Math.max(0, Math.floor(since))}`, 'GET'),

  createProperty: (
    databaseId: string,
    body: { name: string; type: FieldType; config?: PropertyConfig; width?: number; position?: number; locked?: boolean },
  ) => json<{ properties: Property[]; propertyId: string }>(`/api/databases/${databaseId}/properties`, 'POST', body),
  updateProperty: (
    id: string,
    body: {
      name?: string;
      type?: FieldType;
      config?: PropertyConfig;
      width?: number;
      position?: number;
      locked?: boolean;
    },
  ) => json<{ property: Property; properties: Property[]; migrated: number }>(`/api/properties/${id}`, 'PATCH', body),
  deleteProperty: (id: string) => json<{ properties: Property[] }>(`/api/properties/${id}`, 'DELETE'),

  createRecord: (databaseId: string, body: { values?: RowValues; afterId?: string | null }) =>
    json<{ record: RowRecord | null; total: number }>(`/api/databases/${databaseId}/records`, 'POST', body),
  bulkCreateRecords: (databaseId: string, body: { records: RowValues[]; afterId?: string | null }) =>
    json<{ records: RowRecord[]; total: number }>(`/api/databases/${databaseId}/records/bulk`, 'POST', body),
  duplicateRecords: (databaseId: string, recordIds: string[]) =>
    json<{ records: RowRecord[]; total: number }>(`/api/databases/${databaseId}/records/duplicate`, 'POST', {
      recordIds,
    }),
  deleteRecords: (databaseId: string, recordIds: string[]) =>
    json<{ deleted: number; total: number }>(`/api/databases/${databaseId}/records/delete`, 'POST', { recordIds }),
  /**
   * 保存一个单元格 / 一整行。受限访问者（勾了「限制编辑」的分享）的响应里还会带上
   * 这一行的锁定状态：`cellEditGrace` 给出本次改动的格子 10 秒计时窗口的截止时刻，
   * 客户端据此显示「还能再改几秒」。
   */
  updateRecord: (id: string, body: { values?: RowValues; position?: number }) =>
    json<{ record: RowRecord | null; total: number } & CellEditLocks>(`/api/records/${id}`, 'PATCH', body),
  deleteRecord: (id: string) => json<{ ok: true; total: number }>(`/api/records/${id}`, 'DELETE'),

  /**
   * 单条记录的最新状态（值 + 备注 + 已用掉的格子）。
   * 记录卡片打开时用它刷新：别人刚加的备注 / 刚改的值会立刻出现在卡片上。
   */
  syncRecord: (recordId: string) => json<RecordSync>(`/api/records/${recordId}`, 'GET'),

  /** 添加备注（备注只能新增，不能修改 / 删除） */
  addNote: (recordId: string, body: { body: string; mentions?: string[] }) =>
    json<{ notes: RecordNote[] }>(`/api/records/${recordId}/notes`, 'POST', body),

  /** 收件箱：别人在备注里 @ 我留下的私信（未读） */
  inbox: (signal?: AbortSignal) => json<InboxResponse>('/api/inbox', 'GET', undefined, signal),
  /** 点开一条私信 → 已读（未读数 -1） */
  readInboxMessage: (mentionId: string) =>
    json<{ unread: number }>(`/api/inbox/${encodeURIComponent(mentionId)}/read`, 'POST'),

  createView: (
    databaseId: string,
    body: { name?: string; type: ViewType; config?: ViewConfig; copyOfViewId?: string; locked?: boolean },
  ) => json<{ views: ViewDef[]; viewId: string }>(`/api/databases/${databaseId}/views`, 'POST', body),
  updateView: (id: string, body: { name?: string; type?: ViewType; config?: ViewConfig; locked?: boolean; position?: number }) =>
    json<{ views: ViewDef[] }>(`/api/views/${id}`, 'PATCH', body),
  deleteView: (id: string) => json<{ views: ViewDef[] }>(`/api/views/${id}`, 'DELETE'),

  /**
   * 视图定向分享。目标邮箱还没注册时返回 404 `email_not_registered`（前端弹确认框），
   * 带 `invite: true` 再调一次则改为发送邀请链接，响应的 `invite` 里带上投递结果。
   */
  createViewShare: (
    databaseId: string,
    body: { viewId: string; email: string; role: 'editor' | 'viewer'; limitEdits?: boolean; invite?: boolean },
  ) => json<ViewShareCreatedResponse>(`/api/databases/${databaseId}/view-shares`, 'POST', body),
  deleteViewShare: (id: string) =>
    json<{ viewShares: DatabaseDetail['viewShares'] }>(`/api/view-shares/${id}`, 'DELETE'),

  addMember: (databaseId: string, body: { email: string; role: 'editor' | 'viewer' }) =>
    json<{ members: DatabaseDetail['members'] }>(`/api/databases/${databaseId}/members`, 'POST', body),
  updateMember: (id: string, role: 'editor' | 'viewer') =>
    json<{ members: DatabaseDetail['members'] }>(`/api/members/${id}`, 'PATCH', { role }),
  removeMember: (id: string) => json<{ members: DatabaseDetail['members'] }>(`/api/members/${id}`, 'DELETE'),

  createShare: (databaseId: string, body: { permission: 'view' | 'edit'; expiresInDays?: number; limitEdits?: boolean }) =>
    json<{ shares: DatabaseDetail['shares'] }>(`/api/databases/${databaseId}/shares`, 'POST', body),
  deleteShare: (id: string) => json<{ shares: DatabaseDetail['shares'] }>(`/api/shares/${id}`, 'DELETE'),

  uploadFile: (
    file: File,
    target: { databaseId?: string; recordId?: string; propertyId?: string; token?: string },
  ) => {
    const form = new FormData();
    form.set('file', file);
    for (const [key, value] of Object.entries(target)) {
      if (value) form.set(key, value);
    }
    return request<UploadResult>('/api/files', { method: 'POST', form });
  },
  fileUrl: (id: string, download = false) => `/api/files/${id}${download ? '?download=1' : ''}`,
};

export const publicApi = {
  database: (token: string, params?: { limit?: number; offset?: number }) => {
    const query = new URLSearchParams();
    if (params?.limit !== undefined) query.set('limit', String(params.limit));
    if (params?.offset !== undefined) query.set('offset', String(params.offset));
    const suffix = query.toString() ? `?${query}` : '';
    return json<PublicDatabaseResponse>(`/api/public/${encodeURIComponent(token)}${suffix}`, 'GET');
  },
  /** 公开链接页的增量同步（同一套增量逻辑，只是访问权来自分享 token） */
  changes: (token: string, since: number) =>
    json<DatabaseChanges>(
      `/api/public/${encodeURIComponent(token)}/changes?since=${Math.max(0, Math.floor(since))}`,
      'GET',
    ),
  createRecord: (token: string, values: RowValues) =>
    json<{ record: RowRecord | null }>(`/api/public/${encodeURIComponent(token)}/records`, 'POST', { values }),
  /** 公开链接页保存单元格：响应里的 `cellEditGrace` 给出 10 秒计时窗口的截止时刻 */
  updateRecord: (token: string, recordId: string, values: RowValues) =>
    json<{ record: RowRecord | null } & CellEditLocks>(
      `/api/public/${encodeURIComponent(token)}/records/${recordId}`,
      'PATCH',
      { values },
    ),
  deleteRecord: (token: string, recordId: string) =>
    json<{ ok: true }>(`/api/public/${encodeURIComponent(token)}/records/${recordId}`, 'DELETE'),
};
