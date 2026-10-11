/**
 * Shared data model types - used by both the Worker (API) and the client (SPA).
 */
import type { TableOrderStatus, XorpayPayType } from './xorpay';

/* ------------------------------------------------------------------ fields */

export type FieldType =
  | 'text'
  | 'number'
  | 'select'
  | 'multi_select'
  | 'status'
  | 'date'
  | 'checkbox'
  | 'url'
  | 'email'
  | 'phone'
  | 'files'
  | 'created_time'
  | 'updated_time'
  | 'created_by'
  | 'updated_by';

export type OptionColor =
  | 'default'
  | 'gray'
  | 'brown'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'blue'
  | 'purple'
  | 'pink'
  | 'red';

export interface SelectOption {
  id: string;
  name: string;
  color: OptionColor;
}

export type NumberFormat = 'plain' | 'comma' | 'percent' | 'currency';
export type DateFormat = 'YYYY-MM-DD' | 'DD/MM/YYYY' | 'MMM D, YYYY' | 'YYYY年M月D日';

/** Per-type settings, persisted as JSON on the property record. */
export interface PropertyConfig {
  /** select / multi_select / status */
  options?: SelectOption[];
  /** number */
  format?: NumberFormat;
  currency?: string;
  precision?: number;
  /** date / created_time / updated_time */
  dateFormat?: DateFormat;
  includeTime?: boolean;
}

export interface Property {
  id: string;
  databaseId: string;
  name: string;
  type: FieldType;
  config: PropertyConfig;
  position: number;
  width: number;
  /** 字段锁定：锁定后该字段的所有记录只读（不能编辑 / 上传），内容照常显示 */
  locked: boolean;
  createdAt: number;
  updatedAt: number;
}

/* -------------------------------------------------------------------- rows */

export interface DateValue {
  /** ISO date (`YYYY-MM-DD`) or ISO datetime string */
  start: string;
  end?: string | null;
  /** true when the value carries a time part */
  includeTime?: boolean;
}

export interface FileValue {
  id: string;
  name: string;
  size: number;
  mime: string;
}

export type CellValue =
  | string
  | number
  | boolean
  | null
  | string[]
  | DateValue
  | FileValue[]
  | SelectOption
  | SelectOption[];

export type RowValues = Record<string, CellValue>;

export interface RowRecord {
  id: string;
  databaseId: string;
  values: RowValues;
  position: number;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: number;
  updatedAt: number;
}

/* ------------------------------------------------------------------- views */

export type ViewType = 'table' | 'board' | 'gallery';

export type FilterOperator =
  | 'contains'
  | 'not_contains'
  | 'is'
  | 'is_not'
  | 'is_empty'
  | 'is_not_empty'
  | 'eq'
  | 'neq'
  | 'gt'
  | 'lt'
  | 'gte'
  | 'lte'
  | 'before'
  | 'after'
  | 'on_or_before'
  | 'on_or_after'
  | 'is_true'
  | 'is_false';

export interface FilterCondition {
  id: string;
  propertyId: string;
  operator: FilterOperator;
  value?: string | number | boolean | string[] | null;
  /**
   * 这条条件与前一条的关系：`and` = 这条**另起一个「必须满足」块**（与前面的块取交集），
   * `or` = 这条与**同一块**里前面的条件是「任意满足」（命中任意一条即可）。
   * 省略时退回视图级的 {@link Filters.conjunction}（老视图 / 老接口的数据兼容）。
   * 求值见 shared/viewFilter.ts 的 groupFilterConditions / filterRows。
   */
  conjunction?: 'and' | 'or';
}

export interface Filters {
  /**
   * 视图级关系：只对**没有** {@link FilterCondition.conjunction} 的条件生效（老视图兼容）。
   * 界面上每条条件都可选「必须满足 / 任意满足」：多个「必须满足」块之间是「且」，
   * 每个块里的多条「任意满足」是「或」。
   */
  conjunction: 'and' | 'or';
  conditions: FilterCondition[];
}

export interface SortRule {
  propertyId: string;
  direction: 'asc' | 'desc';
}

export interface ViewConfig {
  filters: Filters;
  sorts: SortRule[];
  /** property id used to group rows (board view / table grouping) */
  groupBy?: string | null;
  /** null = all properties visible */
  visibleProperties?: string[] | null;
  rowHeight?: 'short' | 'medium' | 'tall';
  cardSize?: 'small' | 'medium' | 'large';
  cardPreviewPropertyId?: string | null;
}

export interface ViewDef {
  id: string;
  databaseId: string;
  name: string;
  type: ViewType;
  config: ViewConfig;
  /** locked views cannot be renamed / reconfigured / deleted */
  locked: boolean;
  position: number;
  createdAt: number;
  updatedAt: number;
}

/* ------------------------------------------------------- sharing / members */

export type Role = 'owner' | 'editor' | 'viewer';

export interface Member {
  id: string;
  databaseId: string;
  userId: string;
  email: string;
  name: string;
  role: Role;
  createdAt: number;
}

export interface Share {
  id: string;
  databaseId: string;
  token: string;
  permission: 'view' | 'edit';
  /**
   * 创建链接时勾选的「限制编辑」：可编辑链接的访客输入不限次数，
   * 但每次保存后要等 10 秒这一格才会锁上（清空则视为没输入过）。
   * 只读链接恒为 false（本来就不能改）。
   */
  limitEdits: boolean;
  createdAt: number;
  expiresAt: number | null;
}

/** A single view (its filters + visible fields) shared with one registered user. */
export interface ViewShare {
  id: string;
  databaseId: string;
  viewId: string;
  viewName: string;
  userId: string;
  email: string;
  name: string;
  role: Role;
  /**
   * 分享时勾选的「限制编辑」：被分享者（role = 'editor'）输入不限次数，
   * 但每次保存后要等 10 秒这一格才会锁上（清空则视为没输入过）。
   * 可查看的分享恒为 false（本来就不能改）。
   */
  limitEdits: boolean;
  createdAt: number;
}

/* ---------------------------------------------------------------- notes */

/** 备注里被 @ 到的人（备注正文里的 `@名字` 与它一一对应）。 */
export interface NoteMention {
  userId: string;
  name: string;
}

/**
 * 一条记录备注（评论）。备注只能新增，不能修改 / 删除。
 */
export interface RecordNote {
  id: string;
  databaseId: string;
  recordId: string;
  body: string;
  authorId: string | null;
  authorName: string;
  /** 备注里 @ 到的人；会给每人各发一条私信 */
  mentions: NoteMention[];
  createdAt: number;
}

/**
 * 收件箱里的一条私信：别人在备注里 @ 了你。
 * 点开后 `read_at` 被写入，未读数 -1；归零后红点消失。
 */
export interface InboxMessage {
  id: string;
  noteId: string;
  databaseId: string;
  databaseName: string;
  databaseIcon: string;
  recordId: string;
  /** 记录标题（表格第一个文本字段的值），用于在列表里识别记录 */
  recordTitle: string;
  authorName: string;
  /** 备注正文（列表里截断显示） */
  body: string;
  createdAt: number;
}

export interface InboxResponse {
  /** 未读私信，按时间倒序（点开即从列表里消失） */
  messages: InboxMessage[];
  /** 未读私信条数，就是红点里的数字 */
  unread: number;
}

/* --------------------------------------------------------------- cell lock */

/**
 * 单元格级「限制编辑」的当前状态：只读的格子 + 还在计时窗口内的格子。
 *
 * 只有勾选了「限制编辑」的访问者（公开分享链接 / 视图定向分享）才有内容：
 * - 每次保存成功都会开始 / 刷新 10 秒计时窗口（`CELL_EDIT_GRACE_MS`），窗口内想改
 *   多少遍都行；
 * - 窗口一过，只要这一格还有内容就只读（列进 `lockedCells`），只能请表格所有者代改；
 * - 窗口内把内容清空 = 没输入过：这两个列表里都不会出现这一格。
 *
 * 表格所有者、表格成员、以及没勾选「限制编辑」的分享拿到的永远是空的。
 */
export interface CellEditLocks {
  /** 保存过、计时窗口已过、且现在仍有内容的格子（只读）：键为 `记录 id:字段 id` */
  lockedCells: string[];
  /**
   * 还在 10 秒计时窗口内的格子：键为 `记录 id:字段 id`，值为窗口截止时刻（epoch ms）。
   * 客户端据此倒计时（窗口一到该格自动变只读）；服务端始终是权威判断。
   */
  cellEditGrace: Record<string, number>;
}

/* -------------------------------------------------------------- databases */

/**
 * 表格类型：试用表格（`trial`）/ 基础表格（`basic`）/ 专业表格（`pro`）。
 *
 * 三类的区别（口径见 `src/shared/tableKind.ts`）：
 *   容量     试用：100 条记录 / 0.5GB 附件   基础：500 条记录 / 1GB 附件   专业：不限
 *   存储时间 试用：半年（超期自动清除）        基础：1 年（超期自动清除）    专业：永久保留
 *   列数     试用：10 列                      基础：15 列                 专业：20 列
 *   视图数   试用：3 个                       基础：5 个                  专业：10 个
 * 名额也按类型分开算（见下面的 `TableQuotaSet`）。
 */
export type TableKind = 'trial' | 'basic' | 'pro';

/**
 * 单表容量用量（记录条数 + 附件占用），随会话与表格详情一起下发。
 *
 * 上限按「表」计算（见 `src/worker/capacity.ts`）：基础表格默认 500 条记录 / 1GB
 * 附件（可用 `MAX_DATABASE_RECORDS` / `MAX_DATABASE_STORAGE_MB` 覆盖），专业表格
 * 不限。到上限后**只拦增长**：新建记录、批量新建、复制记录、上传附件会被 403
 * `capacity_exceeded` 挡回去；查看、搜索、筛选、分页、增量同步、修改与删除
 * 已有记录都不受影响（清理掉一些数据后立刻又能新增）。
 */
export interface DatabaseCapacity {
  /** 表格类型：基础表格有容量与保留期上限，专业表格都不限 */
  kind: TableKind;
  /** true = 专业表格：记录数 / 附件 / 存储时间都不限制 */
  unlimited: boolean;
  /** 数据保留期（天）；0 = 永久保留（专业表格）。基础表格默认 365 天，超期自动清除 */
  retentionDays: number;
  /** 该表的有效记录数（不含软删除归档的行） */
  records: number;
  /** 记录数上限；`unlimited` 为 true 时是 0（= 不限） */
  maxRecords: number;
  /** 该表所有附件的大小之和（`files.size`） */
  storageBytes: number;
  /** 附件上限（字节）；`unlimited` 为 true 时是 0（= 不限） */
  maxStorageBytes: number;
  /** 记录数已达上限：不能再新建 / 批量新建 / 复制记录（专业表格恒为 false） */
  recordsFull: boolean;
  /** 附件已达上限：不能再上传附件（专业表格恒为 false） */
  storageFull: boolean;
  /** 任一维度到上限 = 这张表不能再增长（进度条转红 + 表格页显示只读提示） */
  atCapacity: boolean;
}

/**
 * 表格名额：这个账号在**某一种**表格上还能再添加几张（侧边栏「你有 N 个基础表格可」）。
 *
 * 口径（计算见 `src/shared/quota.ts`，服务端在 `GET /api/quota` 里下发）：
 *   - 试用表格：新注册账号就送 1 个（一人一张免费试用表，见 `BASE_TABLE_QUOTA`）；
 *     每成功邀请一位**新用户**注册再多 1 个（`trial_table_grants` 表），不单卖；
 *   - 基础表格：没有赠送名额（**分享也不加**），只能购买（9.9 元/月）；
 *   - 专业表格：同样没有赠送名额（**分享也不加**），只能购买（99.9 元/月）。
 * 购买时长按「单位 × 数量」选：时长单位「月」（1 个月）或「年」（12 个月），时长数量月 1 ~ 12 个 /
 * 年 1 ~ 5 个（总月数 = 单位月数 × 数量，1 ~ 60 个月）。
 * 「已用」= 自己拥有的、未归档的这一类型表格数 **+ 被删掉时把名额带走的基础 / 专业表格数**
 * （删表不退还名额，见 `src/worker/slots.ts`）；别人分享给你的表不算，试用表格删掉会退还。
 */
export interface TableQuota {
  /** 这一份名额属于哪一类表格 */
  kind: TableKind;
  /** 已用掉的名额（未归档的表格 + 删表带走的名额，不含归档） */
  used: number;
  /**
   * 赠额：
   *   - 试用表格：成功邀请新用户注册得到的赠额（每邀请一位新用户 +1，见 `trial_table_grants`）；
   *   - 基础 / 专业表格：恒为 0（分享不赠额，名额只能购买）。
   */
  shared: number;
  /** 这一类通过购买得到的名额（`table_purchases` 里同类型的 count 之和；试用表格恒为 0） */
  purchased: number;
  /** 总名额 = 默认（试用 1 / 其它 0）+ 赠额（只有试用表格有，来自邀请新用户）+ 已购买 */
  total: number;
  /** 还能再添加几张（用完为 0，不会出现负数） */
  remaining: number;
}

/** 三类表格各自的名额：`GET /api/quota`、会话下发与购买响应都用它 */
export interface TableQuotaSet {
  trial: TableQuota;
  basic: TableQuota;
  pro: TableQuota;
}

/**
 * 表格名额的「支付可用性」：`GET /api/quota` 随名额一起下发，
 * 购买弹窗据此决定显示「微信扫码支付」还是「下单立即到账（自助直通）」。
 *
 * 判定见 `src/worker/xorpay.ts` 的 `xorpayConfigOf()`：管理员在「后台 → 站点设置」里
 * 填好 XorPay 的 appid + app secret（或环境变量里有）就算已开通。
 */
export interface TableQuotaPayment {
  /** 是否已开通在线收款；false = 购买走自助直通（下单即到账，不产生真实收款） */
  enabled: boolean;
  /** 当前开放的支付方式（默认只有 `native` = 微信扫码；支付宝用环境变量开） */
  methods: XorpayPayType[];
}

/**
 * 一条购买记录（`table_purchases` 表）—— 名额的真正来源。
 *
 * 接入 XorPay 之后，管理员在「后台 → 站点设置」里填好收款信息就自动开启下单：
 *   1) 下单：服务端算价 → 写一行 `table_orders`（pending）→ 调 XorPay 拿微信支付二维码；
 *   2) 用户扫码付款；
 *   3) 回调（或前端轮询触发的主动查单）验签 + 金额核对通过后，才写这里的流水并加名额。
 * 没配收款信息时是**自助直通**：下单即到账，`channel = 'self-serve'`（本地开发 / CI 用）。
 *
 * 价格口径见 `src/shared/tableKind.ts`：基础表格 9.9 元/月、专业表格 99.9 元/月，
 * 购买时长按「单位 × 数量」选（单位「月」配 1 ~ 12 个，或单位「年」配 1 ~ 5 个），
 * `amountCents` = 每月单价 × 购买数量 × 总月数。
 */
export interface TablePurchase {
  id: string;
  userId: string;
  kind: TableKind;
  /** 这次买了几个名额 */
  count: number;
  /** 总购买时长（月）= 时长单位（1 / 12 个月）× 时长数量（月 1 ~ 12 / 年 1 ~ 5，见 `tableKind.ts` 的 `purchaseMonthsOf`） */
  months: number;
  /** 这一单的金额（分） */
  amountCents: number;
  /** 渠道：`self-serve`（自助直通）/ `xorpay:native`（微信扫码支付）/ `admin-grant`（管理员赠额） */
  channel: string;
  /**
   * 续费的是哪张表（`table_slot_allocations.database_id`）。
   * 空串 = 这一笔是**新增名额**；非空 = 给这张基础 / 专业表格续时长（名额统计会跳过它）。
   */
  databaseId: string;
  note: string;
  createdAt: number;
}

/**
 * 一张支付订单（`table_orders` 表，见 migrations/control/0016_table_orders.sql）。
 *
 * 下单时冻结金额与名额参数，支付确认（XorPay 回调 / 主动查单）后才写 `table_purchases` 并加名额。
 * 没配收款信息时是「自助直通」：下单即 `status = 'paid'`（`payType` 空串、`channel = 'self-serve'`）。
 */
export interface TableOrder {
  /** 订单号（同时是传给 XorPay 的 `order_id`，也是弹窗里显示给用户的订单号） */
  id: string;
  userId: string;
  kind: TableKind;
  /** 这一单买几个名额 */
  count: number;
  /** 总时长（月），口径同 `TablePurchase.months` */
  months: number;
  /** 应付金额（分），服务端算好冻结在这一行 */
  amountCents: number;
  /**
   * 这一单是给哪张表续费（空串 = 普通购买，交付时新增名额；
   * 非空 = 交付时给这张表续时长，不新增名额，见 `src/worker/slots.ts`）。
   */
  databaseId: string;
  /** 实收金额（分），回调对账用 */
  paidCents: number;
  status: TableOrderStatus;
  /** `native`（微信扫码）/ `alipay`（支付宝当面付）/ `''`（自助直通，没走支付） */
  payType: XorpayPayType | '';
  /** `xorpay` | `self-serve`（交付时以 `channel:payType` 写进 `table_purchases.channel`） */
  channel: string;
  /** XorPay 平台订单号 */
  aoid: string;
  /** 支付二维码内容（前端用 `xorpayQrImageUrl()` 画图） */
  qr: string;
  /** 订单过期时刻（毫秒） */
  expiresAt: number;
  /** 支付确认时刻（毫秒），未支付为 null */
  paidAt: number | null;
  createdAt: number;
}

export interface DatabaseSummary {
  id: string;
  name: string;
  icon: string;
  /** 表格类型：基础表格 / 专业表格（侧边栏列表里的徽标） */
  kind: TableKind;
  description: string;
  ownerId: string;
  ownerName?: string;
  role: Role;
  /** 表级锁定功能已移除，恒为 false（保留字段以兼容旧数据 / 旧客户端） */
  locked: boolean;
  /** true when access comes from view shares only - 「分享表格」而不是「我的表格」 */
  viewScoped: boolean;
  /** names of the views that were shared with the current user (定向分享) */
  sharedViewNames: string[];
  createdAt: number;
  updatedAt: number;
  rowCount?: number;
  /** 单表容量用量：侧边栏里每张表后面的进度条 */
  capacity: DatabaseCapacity;
  /**
   * 自己拥有的基础 / 专业表格的到期时刻（毫秒）；0 / 缺失 = 没有时长记录（老表或试用表格）。
   * 剩余不到 `SLOT_RENEW_WINDOW_DAYS` 天时，清单里这张表后面会出现「续费」（见 `shared/quota.ts`）。
   */
  slotExpiresAt?: number;
  /**
   * 这张表是不是「到期未续费」（见 `shared/quota.ts` 的 `slotExpired()`）：
   * true 时清单里加一个「已到期」标记，表格页只拦增长（不能再加记录 / 视图）。
   */
  slotExpired?: boolean;
}

export interface DatabaseDetail extends CellEditLocks {
  /** 单表容量用量：表格页顶部的只读提示 / 新建前的拦截 */
  capacity: DatabaseCapacity;
  /**
   * 这张表的到期时刻（毫秒）：基础 / 专业表格才有（试用表格没有时长，恒为 0）。
   * 老表格（没有时长记录）按该类型最近一笔购买兜底，和清单里显示的口径一致。
   */
  slotExpiresAt: number;
  /** 到期未续费：只拦增长（不能再加记录 / 视图），其他功能照常（见 `shared/quota.ts`） */
  slotExpired: boolean;
  id: string;
  name: string;
  icon: string;
  /** 表格类型：基础表格 / 专业表格（容量与列数 / 视图数上限都按它取） */
  kind: TableKind;
  description: string;
  ownerId: string;
  role: Role;
  /** 表级锁定功能已移除，恒为 false（保留字段以兼容旧数据 / 旧客户端） */
  locked: boolean;
  /** true when access comes from view shares only - rows/views are scoped */
  viewScoped: boolean;
  createdAt: number;
  updatedAt: number;
  /**
   * 服务端当前的改动版本号（多人协作增量同步的游标）。
   * 打开表格时先记下它，之后每隔几秒带 `?since=<rev>` 轮询
   * `GET /api/databases/:id/changes`，只拿别人刚改的格子 / 刚加的备注。
   */
  rev: number;
  properties: Property[];
  views: ViewDef[];
  members: Member[];
  shares: Share[];
  viewShares: ViewShare[];
  /**
   * 可以被 @ 提醒的人：表格所有者 + 表格成员 + 定向分享的访客。
   * 备注输入框的 @ 候选名单和后端校验用的是同一份数据，
   * 所以所有者和各个被分享者之间都能互相 @（公开链接的匿名访客没有身份，不在此列）。
   */
  mentionables: Member[];
  rows: RowRecord[];
  total: number;
  hasMore: boolean;
  /**
   * 当前这一页记录上的备注（评论），按 `createdAt` 升序。
   * 备注只能新增，不能修改 / 删除（服务端没有对应的接口）。
   */
  notes: RecordNote[];
  /** 当前访问者是否受「限制编辑」约束（输入不限次数，保存后 10 秒这一格才锁上） */
  limitCellEdits: boolean;
  /**
   * 记录元数据（创建人 / 最后编辑人）里出现过的用户 id → 显示名。
   * 定向分享的访问者不是表格成员，只有这份映射才能显示「创建人」的姓名。
   */
  people: Record<string, string>;
}

/**
 * 增量同步的返回体：自客户端手上的 `rev` 之后的改动。
 *
 * 前端在表格页开着的时候每隔几秒轮询一次（`?since=<rev>`），
 * 只把「有更新的单元格 / 新记录 / 被删掉的行 / 新备注」合并进本地状态，
 * 所以别人改数据不用刷新页面就能看到，也不用整表重拉。
 */
export interface DatabaseChanges extends CellEditLocks {
  /** 服务端当前的版本号：下次请求带上它，就只看更新的改动 */
  rev: number;
  /**
   * true = 攒了太多改动（或日志已被清理），这一轮不带增量，
   * 客户端应该整表重载一次并以新数据的 `rev` 作为游标。
   */
  reset: boolean;
  /** 值 / 顺序有变化的记录（已删掉的不在其中） */
  rows: RowRecord[];
  /** 被删除的记录 id */
  deleted: string[];
  /** 这些记录上新加的备注（备注只增不改，可以直接合并） */
  notes: RecordNote[];
  /** 行元数据里出现过的用户 id → 显示名（别人的改动可能带来本地没有的姓名） */
  people: Record<string, string>;
  /** 表格当前的记录总数 */
  total: number;
}

/* ----------------------------------------------------------------- users */

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  /** 管理员（超级用户）：客户端据此显示「用户管理」入口 */
  isAdmin: boolean;
}

/**
 * 会话令牌。默认只通过 HttpOnly cookie 下发；只有客户端在登录请求里带
 * `tokenInBody: true` 时才会出现在响应体里 —— 手机浏览器（无痕模式、被拦截的
 * Cookie、部分 App 内嵌浏览器）会把 `Set-Cookie` 丢掉，这时客户端把令牌存在本地
 * 并由 `Authorization: Bearer` 头带上，服务端两种都认。
 */
export interface SessionToken {
  token: string;
  expiresAt: number;
}

/**
 * 注册第一步（`POST /api/auth/register`）的响应：账号还没建好，等用户填确认码。
 * `devCode` 只在「邮件服务未配置」或「收件人是保留测试域」时出现，方便本地开发 / 自动化测试。
 */
export interface RegistrationPending {
  pending: true;
  email: string;
  /** 确认码有效期（分钟） */
  ttlMinutes: number;
  /** 距离过期还有多少秒 */
  expiresInSeconds: number;
  /** 是否真的把确认码发出去了 */
  emailDelivered: boolean;
  /** 仅在没发信时返回：把确认码直接回显出来 */
  devCode?: string;
}

/** 管理员用户列表里的一行（GET /api/admin/users）。 */
export interface AdminUser {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
  createdAt: number;
  updatedAt: number;
  /** 自己拥有的表格数 */
  databaseCount: number;
  /** 被邀请协作的表格数 */
  sharedCount: number;
  /** 最近一次会话时间（从没登录过则为 null） */
  lastSeenAt: number | null;
}

export interface AdminUserListResponse {
  users: AdminUser[];
  total: number;
  limit: number;
  offset: number;
  search: string;
}

/**
 * 公开的品牌信息：`GET /api/branding`（未登录也能拿，用于页面标题 / favicon / 登录页）。
 * 站点名称 / 图标由管理员在「后台 → 站点设置」里改，登录后也会随 `/api/session` 一起下发。
 */
export interface BrandingResponse {
  siteName: string;
  /** 站点图标地址（没上传过就是 null） */
  iconUrl: string | null;
  /** 设置最后修改时间（毫秒），作为图标地址的破缓存版本号 */
  updatedAt: number;
  /**
   * 登录页的副标题（管理员在「后台 → 站点设置」里改；空 = 用默认文案）。
   * 登录页「登录 / 注册」两种模式的说明文字都用它，见 `components/AuthPage.tsx`。
   */
  loginTagline: string;
}

/** 后台「站点设置」：`GET /api/admin/settings`（Resend 密钥只回传掩码，完整值不出服务端）。 */
export interface AdminSettings {
  siteName: string;
  iconUrl: string | null;
  hasIcon: boolean;
  /** 登录页副标题（管理员在这里改，保存后登录页立刻跟着变；空 = 用代码默认值） */
  loginTagline: string;
  /** 登录页副标题是否就是代码里的默认值（数据库里没配） */
  loginTaglineIsDefault: boolean;
  /** 生效中的超级管理员邮箱（该邮箱登录 / 带会话访问时会被自动提升为管理员） */
  adminEmail: string;
  /** 管理员邮箱是否来自 Worker 环境变量 / secret（数据库里没配） */
  adminEmailFromEnv: boolean;
  /** 密钥的掩码，例如 `re_ab…wxyz` */
  resolvedResendApiKey: string;
  resendApiKeyConfigured: boolean;
  /** 密钥是否来自 Worker secret / .dev.vars（数据库里没配） */
  resendApiKeyFromEnv: boolean;
  resendFromEmail: string;
  /**
   * XorPay 收款（表格名额购买）。管理员在这里填好 appid + app secret 就**立刻开启下单**，
   * 不用重新部署；环境变量 `XORPAY_AID` / `XORPAY_APP_SECRET` 作为兜底。
   */
  xorpayAid: string;
  /** 密钥的掩码（完整值不回传，前端只在「手动改过」时才提交新值） */
  resolvedXorpayAppSecret: string;
  /** 是否已开通在线收款（appid + 密钥都齐）—— false 时购买走「自助直通」（下单即到账） */
  xorpayConfigured: boolean;
  /** 密钥是否来自 Worker secret / .dev.vars（数据库里没配） */
  xorpayAppSecretFromEnv: boolean;
  /** 当前开放的支付方式（默认只有 `native` = 微信扫码） */
  xorpayPayTypes: XorpayPayType[];
  /** 代码里的默认值（前端提示「当前用的是默认值」时用） */
  defaults: { siteName: string; adminEmail: string; resendFromEmail: string; loginTagline: string };
  /** `settings` 表里最后修改时间（0 = 表里什么都没有） */
  updatedAt: number;
}

/** 保存站点设置的响应：`PATCH /api/admin/settings`、图标上传 / 删除都用它。 */
export interface AdminSettingsResponse {
  settings: AdminSettings;
  branding: BrandingResponse;
}

/* --------------------------------------------------------- 后台「存储分片」 */

/** 分片库里某一片的用量明细（读不到时各项为 null，页面显示「用量未知」） */
export interface AdminShardCounts {
  /** 这一片上的表格数 */
  databases: number | null;
  /** 有效记录数（同 `records.is_archived = 0`） */
  records: number | null;
  /** 附件数 */
  files: number | null;
  /** 附件合计字节数 */
  fileBytes: number | null;
}

/** 一个分片库的运行时状态：`GET /api/admin/shards` */
export interface AdminShard extends AdminShardCounts {
  id: string;
  name: string;
  kind: TableKind;
  /** Cloudflare D1 的 database_id（绑定兜底分片没有这个值） */
  databaseId: string;
  /** 走 Worker 绑定（快）还是 Cloudflare HTTP 接口（慢） */
  transport: 'binding' | 'http';
  binding: string | null;
  note: string;
  isActive: boolean;
  /** 有 database_id 才能在 Cloudflare 上管（读用量 / 建表 / 后续维护） */
  manageable: boolean;
  /** Cloudflare 报的库大小（字节）；没读到为 null */
  usedBytes: number | null;
  /** 单个 D1 库的硬上限（10GB） */
  limitBytes: number;
  /** 已用比例（0~1）；读不到用量时按 0 算 */
  ratio: number;
  /** 超过告警比例（默认 85%）：该准备新建分片了 */
  nearLimit: boolean;
  checkedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** 分片总览（后台页面顶部的小结） */
export interface AdminShardSummary extends AdminShardCounts {
  shards: number;
  activeShards: number;
  /** 已经接近上限、需要准备新库的分片数 */
  nearLimit: number;
  /** 所有分片已用空间之和（只统计读得到用量的） */
  usedBytes: number;
  /** 单个分片上限（10GB），和表格页的容量条同一个口径 */
  limitBytes: number;
  /** 有多少个分片读不到用量（Cloudflare 没配 / 库被删） */
  unknownUsage: number;
  /** Cloudflare D1 的凭据是否配好（没配就没法新建 / 挂载库、也刷不了用量） */
  d1ApiConfigured: boolean;
}

/** `GET /api/admin/shards` 以及各个写接口的响应（写完顺手把最新总览回给前端） */
export interface AdminShardsResponse {
  shards: AdminShard[];
  summary: AdminShardSummary;
}

/** Cloudflare 账号下的一个 D1 库（「挂载现成的库」时给管理员挑） */
export interface AdminAccountDatabase {
  uuid: string;
  name: string;
  fileSize: number | null;
  numTables: number | null;
  createdAt: string | null;
  /** 已经登记在 `database_shards` 里了 */
  mounted: boolean;
}

export interface AdminAccountDatabasesResponse {
  databases: AdminAccountDatabase[];
}

/** 管理员重置密码的响应：`password` 是新的（临时）密码，直接展示给管理员。 */
export interface AdminPasswordResetResponse {
  ok: true;
  user: { id: string; email: string; name: string };
  password: string;
  /** 是否已经把新密码邮件发给了用户 */
  emailed: boolean;
  /** 该用户的所有会话是否已被清理 */
  sessionsRevoked: boolean;
  /** 重置的是不是管理员自己的账号（自己的会话也会失效，需要重新登录） */
  resetSelf: boolean;
}

/**
 * 视图分享邀请的状态：`POST /api/databases/:id/view-shares` 带 `invite: true`
 * （目标邮箱还没注册）时返回，前端据此提示「邀请已发出」或展示回显的链接。
 */
export interface ViewInviteInfo {
  email: string;
  role: 'viewer' | 'editor';
  limitEdits: boolean;
  /** 邀请链接的过期时间（毫秒时间戳） */
  expiresAt: number;
  /** 邀请链接有效期（天） */
  ttlDays: number;
  /** 是否真的把邀请邮件发出去了 */
  emailDelivered: boolean;
  /** 仅在没发信时返回（未配置邮件服务 / 收件人是保留测试域）：把链接直接回显出来 */
  inviteUrl?: string;
}

/** `GET /api/invites/:token`：受邀人打开邀请链接看到的信息（无需登录）。 */
export interface InviteDetail {
  email: string;
  role: 'viewer' | 'editor';
  limitEdits: boolean;
  databaseName: string;
  viewName: string;
  inviterName: string;
  expiresAt: number;
  expiresInSeconds: number;
  appName: string;
  /** 站点图标地址（管理员上传过才有），登录页 / 邀请页的标题区用 */
  siteIconUrl: string | null;
}

/**
 * `POST /api/invites/:token/accept`：填昵称 + 密码完成注册，
 * 自动获得这条视图分享并直接登录（返回的 cookie 已经是新账号的会话）。
 */
export interface InviteAcceptResponse {
  user: SessionUser;
  databaseId: string;
  viewId: string;
  /** 见 `SessionToken`：只有客户端带 `tokenInBody: true` 时才会带上 */
  session?: SessionToken;
}

/** 登录 / 注册确认的响应（`session` 同样只在要求 `tokenInBody` 时出现）。 */
export interface LoginResponse {
  user: SessionUser;
  session?: SessionToken;
}

export interface VerifyRegistrationResponse {
  user: SessionUser;
  emailVerified: true;
  session?: SessionToken;
}

/** 管理员批量删除用户的结果（`POST /api/admin/users/delete`）。 */
export interface AdminDeleteUsersResponse {
  ok: true;
  /** 真的删掉的账号 */
  deleted: { id: string; email: string; name: string }[];
  /** 没删的（账号不存在 / 是管理员 / 选择的正是自己） */
  skipped: { id: string; email: string; reason: string }[];
  /** 连带删除的表格数（表格里的记录 / 备注 / 上传文件一并清理） */
  databaseCount: number;
}

/** 视图定向分享的创建结果：`invite` 只在「邀请未注册邮箱」时出现。 */
export interface ViewShareCreatedResponse {
  viewShares: ViewShare[];
  invite?: ViewInviteInfo;
}


/* -------------------------------------------------------------- transport */

export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}

export interface AuthResponse {
  user: SessionUser;
}

export interface DatabaseListResponse {
  databases: DatabaseSummary[];
  user: SessionUser;
  maxUploadMb: number;
  /** 站点名称（品牌） */
  appName: string;
  /** 站点图标地址（没上传过就是 null） */
  siteIconUrl: string | null;
}

export interface PublicDatabaseResponse extends CellEditLocks {
  database: {
    id: string;
    name: string;
    icon: string;
    description: string;
    permission: 'view' | 'edit';
    /** 创建链接时勾选的「限制编辑」：输入不限次数，保存后 10 秒这一格才锁上 */
    limitEdits: boolean;
    /** 表格所有者（公开链接里「当前用户」筛选解析为这个人） */
    ownerId: string;
    ownerName: string;
    /** 单表容量用量：公开链接页到上限后同样只能查看 */
    capacity: DatabaseCapacity;
    /** 到期时刻（毫秒）：基础 / 专业表格才有；0 = 没有时长（试用表格 / 老表） */
    slotExpiresAt: number;
    /** 到期未续费：公开链接页也不能再新增记录（编辑 / 删除照常） */
    slotExpired: boolean;
  };
  properties: Property[];
  views: ViewDef[];
  rows: RowRecord[];
  total: number;
  hasMore: boolean;
  /**
   * 服务端当前的改动版本号（增量同步游标）：公开链接页也每隔几秒带
   * `?since=<rev>` 轮询 `/api/public/:token/changes`，别人改的格子自己出现。
   */
  rev: number;
  /** 记录元数据（创建人 / 最后编辑人）里出现过的用户 id → 显示名 */
  people: Record<string, string>;
}
