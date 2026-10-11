/** /api/databases* - create / read / update tables, members and share links. */
import { QUOTA_EXCEEDED } from '../../shared/quota';
import { asTableKind, TABLE_KINDS, TABLE_LIMIT_EXCEEDED, tableKindLabel, tableKindMeta } from '../../shared/tableKind';
import { TEMPLATES, materializeTemplateProperties } from '../../shared/templates';
import type {
  DatabaseDetail,
  DatabaseSummary,
  Member,
  Property,
  Role,
  RowRecord,
  TableKind,
  ViewDef,
} from '../../shared/types';
import { rowMatchesView } from '../../shared/viewFilter';
import { defaultViewConfig } from '../../shared/views';
import { requireDatabaseAccess, type DatabaseAccess } from '../access';
import { requireUser } from '../auth';
import { loadSiteSettings, siteIconUrl } from '../settings';
import {
  capacityFromUsage,
  capacityLimits,
  DATABASE_USAGE_SELECT,
  loadDatabaseCapacity,
  usageFromRow,
} from '../capacity';
import { loadCellEditLocks, memberCellEditKey } from '../cellEdits';
import { headRev, loadChanges, logChanges } from '../changes';
import {
  asEnum,
  asFlag,
  asString,
  badRequest,
  conflict,
  forbidden,
  HttpError,
  json,
  newId,
  normalizeEmail,
  notFound,
  randomToken,
  readJson,
  sqlNumber,
  sqlString,
  type SqlRow,
} from '../http';
import { deliverViewInvite, issueViewInvite } from '../invites';
import { loadTableQuota } from './quota';
import { allocateSlot, loadSlotAllocations, recordSlotConsumption } from '../slots';
import {
  databaseSummaryFromRow,
  memberFromRow,
  propertyFromRow,
  recordFromRow,
  shareFromRow,
  viewFromRow,
  viewShareFromRow,
} from '../mappers';
import { loadNotes, loadUserContacts, mentionableUsers, type UserContact } from '../notes';
import { forEachShardSafe, pickShard, requireEntityShard, shardDb, tableDb } from '../shards';
import type { Env, RequestContext, Route } from '../types';

const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 1000;
/** how many rows a view-only share scans before applying the view filters */
const SCOPED_ROW_SCAN = 5000;

export function clampLimit(url: URL): number {
  const raw = Number(url.searchParams.get('limit'));
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.floor(raw), MAX_PAGE_SIZE);
}

export function clampOffset(url: URL): number {
  const raw = Number(url.searchParams.get('offset'));
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

/**
 * All databases the user owns, has been invited to or received a view share for.
 *
 * 表格数据在各个分片里：逐分片查一遍再合并（某个分片暂时不可用只会少几张表，不会 500）。
 * 表格名 / 视图名 / 用量都在分片内一次查完，只有 `owner_name` 要去用户库补 —— 跨库没有
 * JOIN，所以是「两次查询 + JS 合并」。
 */
export async function listDatabases(env: Env, userId: string): Promise<DatabaseSummary[]> {
  const scans = await forEachShardSafe(env, async (_shard, db) => {
    const [{ results }, { results: sharedRows }] = await Promise.all([
      db
        .prepare(
          `SELECT d.id, d.name, d.icon, d.kind, d.description, d.owner_id, d.is_locked, d.created_at, d.updated_at,
                  ${DATABASE_USAGE_SELECT},
                  CASE WHEN m.id IS NULL THEN 0 ELSE 1 END AS is_member,
                  CASE WHEN d.owner_id = ? THEN 'owner'
                       ELSE COALESCE(m.role, s.role, 'viewer') END AS role
             FROM databases d
             LEFT JOIN database_members m ON m.database_id = d.id AND m.user_id = ?
             LEFT JOIN (SELECT vs.database_id, MIN(vs.role) AS role FROM view_shares vs
                          WHERE vs.user_id = ? GROUP BY vs.database_id) s ON s.database_id = d.id
            WHERE d.is_archived = 0 AND (d.owner_id = ? OR m.id IS NOT NULL OR s.database_id IS NOT NULL)`,
        )
        .bind(userId, userId, userId, userId)
        .all<SqlRow>(),
      db
        .prepare(
          `SELECT vs.database_id, v.name AS view_name
             FROM view_shares vs JOIN views v ON v.id = vs.view_id
            WHERE vs.user_id = ?
            ORDER BY v.position ASC, vs.created_at ASC`,
        )
        .bind(userId)
        .all<SqlRow>(),
    ]);
    return { rows: results ?? [], sharedRows: sharedRows ?? [] };
  });

  const rows: SqlRow[] = [];
  const sharedViewNames = new Map<string, string[]>();
  for (const scan of scans) {
    if (!scan.value) continue;
    rows.push(...scan.value.rows);
    for (const row of scan.value.sharedRows) {
      const id = sqlString(row, 'database_id');
      const list = sharedViewNames.get(id) ?? [];
      list.push(sqlString(row, 'view_name'));
      sharedViewNames.set(id, list);
    }
  }
  // 同一张表只会落在一个分片里；原来的 SQL 排序（updated_at 倒序）在合并后重做
  rows.sort((a, b) => sqlNumber(b, 'updated_at') - sqlNumber(a, 'updated_at'));

  // owner_name 在用户库：跨库补一次
  const owners = await loadUserContacts(env, rows.map((row) => sqlString(row, 'owner_id')));
  for (const row of rows) {
    row.owner_name = ownerLabel(owners.get(sqlString(row, 'owner_id')));
  }
  // 表格的到期时间（续费窗口）也在用户库：一次读全自己在基础 / 专业分片上的表的时长
  const slotExpiresAt = await loadSlotAllocations(env, userId);

  return rows.map((row) => {
    const role = sqlString(row, 'role', 'viewer') as Role;
    // 容量上限按表格类型取：基础表格 500 条 / 1GB，专业表格不限（见 shared/tableKind.ts）
    const kind = asTableKind(sqlString(row, 'kind', 'basic'));
    // 结果集只包含「所有者 / 表格成员 / 视图定向分享」三种来源：
    // 既不是所有者也不是成员（且能查出来）就说明访问权只来自定向分享的视图。
    const viewScoped = role !== 'owner' && sqlNumber(row, 'is_member') !== 1;
    const summary = databaseSummaryFromRow(
      row,
      role,
      sharedViewNames.get(sqlString(row, 'id')) ?? [],
      viewScoped,
      // 记录数 + 附件占用：和表格在同一个查询里算出来，避免一张表一次往返
      capacityFromUsage(usageFromRow(row), capacityLimits(env, kind)),
    );
    // 只有自己拥有的基础 / 专业表格才有时长（续费窗口）：数据在用户库，这里在 JS 里合并
    if (role === 'owner' && kind !== 'trial') summary.slotExpiresAt = slotExpiresAt.get(summary.id) ?? 0;
    return summary;
  });
}

/** 用户库里查到的账号 → 表格列表上的「所有者」显示名（注销的账号给一句占位文案）。 */
export function ownerLabel(contact: UserContact | undefined): string {
  return contact ? contact.name || contact.email : '已注销用户';
}

/** Union of the fields that the given (shared) views expose. */
function scopedProperties(properties: Property[], views: ViewDef[]): Property[] {
  if (!views.some((view) => view.config.visibleProperties)) return properties;
  const allowed = new Set<string>();
  for (const view of views) {
    for (const propertyId of view.config.visibleProperties ?? []) allowed.add(propertyId);
  }
  return properties.filter((property) => allowed.has(property.id));
}

/** Rows a view-scoped member may see: the union of every view they were given. */
export async function visibleRecords(
  db: D1Database,
  databaseId: string,
  access: Pick<DatabaseAccess, 'viewIds' | 'userId'>,
  limit: number,
  offset: number,
): Promise<{ rows: RowRecord[]; total: number }> {
  if (!access.viewIds?.length) {
    const [rows, total] = await Promise.all([
      loadRecords(db, databaseId, limit, offset),
      countRecords(db, databaseId),
    ]);
    return { rows, total };
  }

  const [properties, views, scanned] = await Promise.all([
    loadProperties(db, databaseId),
    loadViews(db, databaseId, access.viewIds),
    loadRecords(db, databaseId, SCOPED_ROW_SCAN, 0),
  ]);
  if (!views.length) return { rows: [], total: 0 };

  const visibleProperties = scopedProperties(properties, views);
  // 定向分享里「当前用户」= 访问者
  const context = { viewerId: access.userId };
  const rows = scanned.filter((row) =>
    views.some((view) => rowMatchesView(visibleProperties, row, view.config, context)),
  );
  return { rows: rows.slice(offset, offset + limit), total: rows.length };
}

/** 表格的字段（`db` = 表格所在的分片）。 */
export async function loadProperties(db: D1Database, databaseId: string): Promise<Property[]> {
  const { results } = await db
    .prepare('SELECT * FROM properties WHERE database_id = ? ORDER BY position ASC, created_at ASC')
    .bind(databaseId)
    .all<SqlRow>();
  return (results ?? []).map(propertyFromRow);
}

/** 表格的视图（`db` = 表格所在的分片）。 */
export async function loadViews(db: D1Database, databaseId: string, viewIds?: string[] | null): Promise<ViewDef[]> {
  const { results } = await db
    .prepare('SELECT * FROM views WHERE database_id = ? ORDER BY position ASC, created_at ASC')
    .bind(databaseId)
    .all<SqlRow>();
  const views = (results ?? []).map(viewFromRow);
  if (!viewIds?.length) return views;
  return views.filter((view) => viewIds.includes(view.id));
}

export async function loadRecords(
  db: D1Database,
  databaseId: string,
  limit: number,
  offset: number,
): Promise<RowRecord[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM records
        WHERE database_id = ? AND is_archived = 0
        ORDER BY position ASC, created_at ASC
        LIMIT ? OFFSET ?`,
    )
    .bind(databaseId, limit, offset)
    .all<SqlRow>();
  return (results ?? []).map(recordFromRow);
}

/** Single row by id (used by the record endpoints to echo the stored state). */
export async function loadRecord(db: D1Database, recordId: string): Promise<RowRecord | null> {
  const row = await db
    .prepare('SELECT * FROM records WHERE id = ? AND is_archived = 0')
    .bind(recordId)
    .first<SqlRow>();
  return row ? recordFromRow(row) : null;
}

/**
 * 行元数据（created_by / updated_by）里出现过的用户 id → 显示名。
 *
 * 「创建人 / 最后编辑人」字段的取值来自行元数据而不是 values，且被定向分享（视图分享）
 * 的访问者并不是 database_members 成员，因此不能只靠 members 解析姓名。
 * 只解析当前这一页记录里真实出现过的 id，不会泄露看不到的记录。
 */
export async function loadPeopleNames(env: Env, rows: RowRecord[]): Promise<Record<string, string>> {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.createdBy) ids.add(row.createdBy);
    if (row.updatedBy) ids.add(row.updatedBy);
  }
  if (!ids.size) return {};

  const all = [...ids];
  // 分片绑定参数，永远不超过 D1 / SQLite 的变量上限
  const CHUNK = 100;
  const names: Record<string, string> = {};
  for (let index = 0; index < all.length; index += CHUNK) {
    const slice = all.slice(index, index + CHUNK);
    const { results } = await env.DB.prepare(
      `SELECT id, name, email FROM users WHERE id IN (${slice.map(() => '?').join(', ')})`,
    )
      .bind(...slice)
      .all<SqlRow>();
    for (const row of results ?? []) {
      names[sqlString(row, 'id')] = sqlString(row, 'name') || sqlString(row, 'email');
    }
  }
  return names;
}

export interface CreateDatabaseOptions {
  name: string;
  icon: string;
  description: string;
  templateId: string;
  /** 表格类型：基础表格 / 专业表格（名额与容量 / 列数 / 视图数上限都按它算） */
  kind: TableKind;
}

export async function createDatabase(
  env: Env,
  userId: string,
  options: CreateDatabaseOptions,
): Promise<{ databaseId: string; properties: Property[]; views: ViewDef[]; db: D1Database }> {
  const databaseId = newId();
  const now = Date.now();
  const defs = materializeTemplateProperties(options.templateId, () => newId());

  // 新表格落在哪个分片：按表格类型（基础 / 专业）挑一个当前最空的（见 shards.ts 的 pickShard）
  const db = shardDb(env, await pickShard(env, options.kind));

  const statements = [
    db.prepare(
      `INSERT INTO databases (id, owner_id, name, icon, description, kind, is_archived, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    ).bind(databaseId, userId, options.name, options.icon, options.description, options.kind, now, now),
  ];

  defs.forEach((def, index) => {
    statements.push(
      db.prepare(
        `INSERT INTO properties (id, database_id, name, type, config, position, width, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        newId(),
        databaseId,
        def.name,
        def.type,
        JSON.stringify(def.config),
        (index + 1) * 1000,
        def.width,
        now,
        now,
      ),
    );
  });

  statements.push(
    db.prepare(
      `INSERT INTO views (id, database_id, name, type, config, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      newId(),
      databaseId,
      '全部数据',
      'table',
      JSON.stringify(defaultViewConfig('table')),
      1000,
      now,
      now,
    ),
  );

  await db.batch(statements);

  const properties = await loadProperties(db, databaseId);

  // templates that ship a status/select field also get a board view
  const groupProperty = properties.find((p) => p.type === 'status' || p.type === 'select');
  if (groupProperty) {
    const config = defaultViewConfig('board');
    config.groupBy = groupProperty.id;
    const viewId = newId();
    await db
      .prepare(
        `INSERT INTO views (id, database_id, name, type, config, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(viewId, databaseId, '看板视图', 'board', JSON.stringify(config), 2000, now, now)
      .run();
  }

  return {
    databaseId,
    properties,
    views: await loadViews(db, databaseId),
    db,
  };
}

export async function countRecords(db: D1Database, databaseId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS total FROM records WHERE database_id = ? AND is_archived = 0')
    .bind(databaseId)
    .first<SqlRow>();
  return sqlNumber(row ?? {}, 'total');
}

/**
 * 表格的所有者 + 成员（所有者排第一，id 是虚拟的 `owner:<databaseId>`，见成员路由）。
 *
 * 成员表在分片里，但成员的邮箱 / 昵称在用户库：跨库没有 JOIN，查完再在 JS 里合并。
 */
export async function loadMembers(env: Env, db: D1Database, databaseId: string): Promise<Member[]> {
  const [ownerRow, { results }] = await Promise.all([
    db.prepare('SELECT owner_id, created_at FROM databases WHERE id = ?').bind(databaseId).first<SqlRow>(),
    db
      .prepare('SELECT * FROM database_members WHERE database_id = ? ORDER BY created_at ASC')
      .bind(databaseId)
      .all<SqlRow>(),
  ]);

  const memberRows = results ?? [];
  const contacts = await loadUserContacts(env, [
    ownerRow ? sqlString(ownerRow, 'owner_id') : null,
    ...memberRows.map((row) => sqlString(row, 'user_id')),
  ]);

  const members = memberRows.map((row) => {
    const member = memberFromRow(row);
    const contact = contacts.get(member.userId);
    return contact ? { ...member, email: contact.email || member.email, name: contact.name || member.name } : member;
  });
  if (!ownerRow) return members;

  // The owner is not stored in database_members but is always listed first
  // (their id is a virtual "owner:<databaseId>" handled by the member routes).
  const ownerId = sqlString(ownerRow, 'owner_id');
  const owner = contacts.get(ownerId);
  return [
    {
      id: ownerMemberId(databaseId),
      databaseId,
      userId: ownerId,
      email: owner?.email ?? '',
      name: owner?.name ?? '',
      role: 'owner',
      createdAt: sqlNumber(ownerRow, 'created_at'),
    },
    ...members,
  ];
}

/** Virtual member id of the table owner (see loadMembers). */
export function ownerMemberId(databaseId: string): string {
  return `owner:${databaseId}`;
}

/** True for the virtual owner entry returned by {@link loadMembers}. */
function isOwnerMemberId(memberId: string): boolean {
  return memberId.startsWith('owner:');
}

export async function loadShares(db: D1Database, databaseId: string) {
  const { results } = await db
    .prepare(
      'SELECT * FROM shares WHERE database_id = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC',
    )
    .bind(databaseId, Date.now())
    .all<SqlRow>();
  return (results ?? []).map(shareFromRow);
}

/**
 * Every view (定向分享) handed to an individual user, newest view first.
 * 被分享者的邮箱 / 昵称在用户库：分片查出记录后跨库补一次。
 */
export async function loadViewShares(env: Env, db: D1Database, databaseId: string) {
  const { results } = await db
    .prepare(
      `SELECT vs.*, v.name AS view_name, v.position AS view_position
         FROM view_shares vs
         JOIN views v ON v.id = vs.view_id
        WHERE vs.database_id = ?
        ORDER BY v.position ASC, vs.created_at ASC`,
    )
    .bind(databaseId)
    .all<SqlRow>();
  const rows = results ?? [];
  const contacts = await loadUserContacts(env, rows.map((row) => sqlString(row, 'user_id')));
  return rows.map((row) => {
    const share = viewShareFromRow(row);
    const contact = contacts.get(share.userId);
    if (!contact) return share;
    return { ...share, email: contact.email || share.email, name: contact.name || share.name };
  });
}

/**
 * 表格详情（`GET /api/databases/:id` 及各个写接口的响应）。
 *
 * `db` 是表格所在的分片（访问检查已经把它钉好，或新建表格时拿到的那个）；
 * `env` 用来读容量上限与站点设置。
 */
export async function buildDatabaseDetail(
  env: Env,
  db: D1Database,
  databaseId: string,
  access: Pick<DatabaseAccess, 'role' | 'viewIds' | 'userId' | 'limitCellEdits'>,
  url: URL,
): Promise<DatabaseDetail> {
  const row = await db
    .prepare('SELECT * FROM databases WHERE id = ? AND is_archived = 0')
    .bind(databaseId)
    .first<SqlRow>();
  if (!row) throw notFound('表格不存在');
  // 表格类型：容量上限、保留期提示与前端徽标都按它走
  const kind = asTableKind(sqlString(row, 'kind', 'basic'));

  // 增量同步的起点：**先**读版本号、再读数据（写入顺序是「先数据、后日志」，
  // 见 worker/changes.ts 的文件头），客户端拿它当游标就不会漏掉任何改动
  const rev = await headRev(db);

  const limit = clampLimit(url);
  const offset = clampOffset(url);
  const scoped = Boolean(access.viewIds?.length);
  const [allProperties, allViews, page, members, shares, viewShares, mentionables] = await Promise.all([
    loadProperties(db, databaseId),
    loadViews(db, databaseId),
    visibleRecords(db, databaseId, access, limit, offset),
    loadMembers(env, db, databaseId),
    loadShares(db, databaseId),
    loadViewShares(env, db, databaseId),
    // 备注输入框里的 @ 候选：所有者 + 表格成员 + 定向分享的访客
    mentionableUsers(env, db, databaseId),
  ]);

  const views = scoped ? allViews.filter((view) => access.viewIds?.includes(view.id)) : allViews;
  const properties = scoped ? scopedProperties(allProperties, views) : allProperties;
  // 「创建人 / 最后编辑人」取自行元数据，可能指向并非成员的定向分享用户
  const people = await loadPeopleNames(env, page.rows);
  // 勾选了「限制编辑」的访问者的单元格锁定状态（其它人恒为空 —— 不受限制）：
  // 计时窗口已过、又仍有内容的格子只读，窗口内的格子（cellEditGrace）还能再改
  const cellLocks = await loadCellEditLocks(
    db,
    databaseId,
    memberCellEditKey(access),
    page.rows.map((item) => item.id),
  );
  // 当前页记录上的备注（只能新增，不能修改 / 删除）
  const notes = await loadNotes(
    env,
    db,
    page.rows.map((item) => item.id),
  );
  // 单表容量用量：表格页顶部据此显示「已满，只能查看」的提示条（专业表格不限容量）
  const capacity = await loadDatabaseCapacity(env, db, databaseId, kind);

  return {
    id: databaseId,
    name: sqlString(row, 'name'),
    icon: sqlString(row, 'icon', '📋'),
    kind,
    description: sqlString(row, 'description'),
    ownerId: sqlString(row, 'owner_id'),
    role: access.role,
    capacity,
    // 表级锁定已移除：字段保留（客户端类型仍需要它），恒为 false
    locked: false,
    viewScoped: scoped,
    createdAt: sqlNumber(row, 'created_at'),
    updatedAt: sqlNumber(row, 'updated_at'),
    rev,
    properties,
    views,
    members,
    shares,
    viewShares,
    // 备注里可以 @ 的人（所有者 + 成员 + 定向分享的访客）
    mentionables,
    rows: page.rows,
    total: page.total,
    hasMore: offset + page.rows.length < page.total,
    people,
    // 已经锁上的格子 + 还在 10 秒计时窗口内的格子
    ...cellLocks,
    notes,
    // 分享时勾选的「限制编辑」：前端据此把锁上的格子标成只读
    limitCellEdits: access.limitCellEdits,
  };
}

/** Synthetic access object for the just-created table of `ownerId`. */
export function ownerAccess(db: D1Database, databaseId: string, ownerId: string): DatabaseAccess {
  return {
    databaseId,
    db,
    ownerId,
    userId: ownerId,
    role: 'owner',
    viewIds: null,
    limitCellEdits: false,
  };
}

/** 记一次「表格被改过」（`updated_at` 是表格列表的排序依据，也和分片同库）。 */
export async function touchDatabase(db: D1Database, databaseId: string): Promise<void> {
  await db.prepare('UPDATE databases SET updated_at = ? WHERE id = ?').bind(Date.now(), databaseId).run();
}

export { TEMPLATES };

/* ------------------------------------------------------------------ routes */

async function listHandler(ctx: RequestContext): Promise<Response> {
  const user = await requireUser(ctx.request, ctx.env);
  // 站点名称 / 图标由「后台 → 站点设置」决定（跟着表格列表一起下发，前端不用再单独请求）
  const [databases, settings] = await Promise.all([listDatabases(ctx.env, user.id), loadSiteSettings(ctx.env)]);
  return json({
    databases,
    user,
    maxUploadMb: Number(ctx.env.MAX_UPLOAD_MB ?? 25),
    appName: settings.siteName,
    siteIconUrl: siteIconUrl(settings),
  });
}

async function createHandler(ctx: RequestContext): Promise<Response> {
  const user = await requireUser(ctx.request, ctx.env);
  const body = await readJson(ctx.request);
  const name = asString(body.name, '表格名称', { required: true, max: 120 });
  const icon = asString(body.icon, '图标', { max: 8 }) || '📋';
  const description = asString(body.description, '描述', { max: 500 });
  const templateId = asString(body.templateId, '模板', { max: 40 }) || 'blank';
  // 表格类型：老客户端不传就当基础表格
  const kind = asEnum(body.kind ?? 'basic', TABLE_KINDS, '表格类型');
  const template = TEMPLATES.find((item) => item.id === templateId);
  if (!template) throw notFound('模板不存在');
  // 模板自带的列数也不能超过这一类型的上限（基础 15 列 / 专业 20 列）
  const meta = tableKindMeta(kind);
  if (template.properties.length > meta.maxProperties) {
    throw badRequest(
      `${meta.label}最多 ${meta.maxProperties} 列，模板「${template.name}」有 ${template.properties.length} 列`,
      TABLE_LIMIT_EXCEEDED,
    );
  }

  // 名额：三类表格各算各的，这一类用完了就得先补名额再建表。
  // 名额口径见 src/shared/quota.ts（新注册账号默认 0 个基础 / 专业名额，送 1 个试用名额）：
  //   试用表格不卖，只能靠邀请新用户注册 +1（见 worker/trialGrants.ts）；
  //   基础表格没有赠额（分享也不加），只能购买；
  //   专业表格也没有赠额（分享不再 +1），只能购买。
  const quota = await loadTableQuota(ctx.env, user.id);
  if (quota[kind].remaining <= 0) {
    const replenish =
      kind === 'trial'
        ? '每成功邀请一位新用户注册可以 +1（试用表格不能购买）'
        : '只能购买名额（分享不增加名额）';
    throw forbidden(
      `${tableKindLabel(kind)}名额已用完（共 ${quota[kind].total} 个）：${replenish}`,
      QUOTA_EXCEEDED,
    );
  }

  const created = await createDatabase(ctx.env, user.id, { name, icon, description, templateId, kind });
  // 基础 / 专业表格自带时长：按该类型最近一次购买的时长起算（剩余不到一周时清单里会出现「续费」）
  await allocateSlot(ctx.env, { userId: user.id, databaseId: created.databaseId, kind });
  const access = ownerAccess(created.db, created.databaseId, user.id);
  return json(await buildDatabaseDetail(ctx.env, created.db, created.databaseId, access, ctx.url), {
    status: 201,
  });
}

async function detailHandler(ctx: RequestContext): Promise<Response> {
  const user = await requireUser(ctx.request, ctx.env);
  const access = await requireDatabaseAccess(ctx, ctx.params.id, user, 'view');
  return json(await buildDatabaseDetail(ctx.env, tableDb(ctx), ctx.params.id, access, ctx.url));
}

/**
 * 增量同步（多人协作）：只返回「比客户端手上的版本号新」的改动 ——
 * 改过的行 + 删掉的行 + 新备注 + 已用掉的格子，前端据此就地更新单元格，
 * 不用刷新页面，也不用整表重拉。
 *
 * `reset` 为 true 时前端整表重载一次（改动太多 / 日志已被清理）。
 */
async function changesHandler(ctx: RequestContext): Promise<Response> {
  const user = await requireUser(ctx.request, ctx.env);
  const access = await requireDatabaseAccess(ctx, ctx.params.id, user, 'view');
  const since = Number(ctx.url.searchParams.get('since') ?? 0);
  const changes = await loadChanges(
    ctx.env,
    tableDb(ctx),
    ctx.params.id,
    {
      editorKey: memberCellEditKey(access),
      viewIds: access.viewIds,
      viewerId: access.userId,
    },
    since,
  );
  return json(changes);
}

async function recordsPageHandler(ctx: RequestContext): Promise<Response> {
  const user = await requireUser(ctx.request, ctx.env);
  const access = await requireDatabaseAccess(ctx, ctx.params.id, user, 'view');
  const db = tableDb(ctx);
  const limit = clampLimit(ctx.url);
  const offset = clampOffset(ctx.url);
  const { rows, total } = await visibleRecords(db, ctx.params.id, access, limit, offset);
  // 计时窗口已过且仍有内容的格子 + 还在 10 秒窗口内的格子（不受限制的访问者恒为空）
  const cellLocks = await loadCellEditLocks(
    db,
    ctx.params.id,
    memberCellEditKey(access),
    rows.map((row) => row.id),
  );
  // 「加载更多」拿到的这一页记录上的备注（备注只增不改，前端可以放心合并）
  const notes = await loadNotes(
    ctx.env,
    db,
    rows.map((row) => row.id),
  );
  return json({ rows, total, hasMore: offset + rows.length < total, ...cellLocks, notes });
}

async function updateHandler(ctx: RequestContext): Promise<Response> {
  const user = await requireUser(ctx.request, ctx.env);
  const access = await requireDatabaseAccess(ctx, ctx.params.id, user, 'edit');
  const db = tableDb(ctx);
  const body = await readJson(ctx.request);
  const fields: string[] = [];
  const values: unknown[] = [];

  if (body.name !== undefined) {
    fields.push('name = ?');
    values.push(asString(body.name, '表格名称', { required: true, max: 120 }));
  }
  if (body.icon !== undefined) {
    fields.push('icon = ?');
    values.push(asString(body.icon, '图标', { max: 8 }));
  }
  if (body.description !== undefined) {
    fields.push('description = ?');
    values.push(asString(body.description, '描述', { max: 500 }));
  }
  // body.locked 已被忽略：表级锁定功能已移除（老的客户端传参不再有任何效果）
  if (!fields.length) return json(await buildDatabaseDetail(ctx.env, db, ctx.params.id, access, ctx.url));

  fields.push('updated_at = ?');
  values.push(Date.now(), ctx.params.id);
  await db.prepare(`UPDATE databases SET ${fields.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();
  // 表格改名 / 换图标 / 改描述：别人的页面跟着整表刷新一次
  await logChanges(db, ctx.params.id, 'schema');
  return json(await buildDatabaseDetail(ctx.env, db, ctx.params.id, access, ctx.url));
}

async function deleteHandler(ctx: RequestContext): Promise<Response> {
  const user = await requireUser(ctx.request, ctx.env);
  await requireDatabaseAccess(ctx, ctx.params.id, user, 'manage');
  const db = tableDb(ctx);

  // 删表要把名额一起带走（基础 / 专业表格不退还，见 worker/slots.ts）：先记下类型与所有者
  const meta = await db
    .prepare('SELECT owner_id, kind FROM databases WHERE id = ?')
    .bind(ctx.params.id)
    .first<SqlRow>();

  // purge the uploaded blobs from R2 before dropping the metadata
  const { results } = await db
    .prepare('SELECT r2_key FROM files WHERE database_id = ?')
    .bind(ctx.params.id)
    .all<SqlRow>();
  const keys = (results ?? []).map((row) => sqlString(row, 'r2_key')).filter(Boolean);
  for (let i = 0; i < keys.length; i += 100) {
    await ctx.env.BUCKET.delete(keys.slice(i, i + 100));
  }

  await db.prepare('DELETE FROM databases WHERE id = ?').bind(ctx.params.id).run();
  // 记一笔「这个名额被带走了」：试用表格不记账（删掉照旧退还名额）
  if (meta && sqlString(meta, 'owner_id') === user.id) {
    await recordSlotConsumption(ctx.env, {
      userId: user.id,
      databaseId: ctx.params.id,
      kind: sqlString(meta, 'kind', 'basic'),
    });
  }
  return json({ ok: true });
}

/** 成员 id → 它的表格 + 访问权（成员表在分片里，所以先探分片再校验权限）。 */
async function accessForMember(ctx: RequestContext, memberId: string) {
  const handle = await requireEntityShard(ctx.env, 'database_members', 'id', memberId, '成员不存在');
  const row = await handle.db
    .prepare('SELECT database_id FROM database_members WHERE id = ?')
    .bind(memberId)
    .first<SqlRow>();
  if (!row) throw notFound('成员不存在');
  const databaseId = sqlString(row, 'database_id');
  const user = await requireUser(ctx.request, ctx.env);
  const access = await requireDatabaseAccess(ctx, databaseId, user, 'manage');
  return { databaseId, access };
}

async function addMemberHandler(ctx: RequestContext): Promise<Response> {
  const user = await requireUser(ctx.request, ctx.env);
  const access = await requireDatabaseAccess(ctx, ctx.params.id, user, 'manage');
  const db = tableDb(ctx);
  const body = await readJson(ctx.request);
  const email = normalizeEmail(body.email);
  const role = asEnum(body.role ?? 'editor', ['editor', 'viewer'] as const, '角色');

  const target = await ctx.env.DB.prepare('SELECT id, email, name FROM users WHERE email = ?')
    .bind(email)
    .first<SqlRow>();
  if (!target) throw notFound('该邮箱尚未注册，请先让对方注册账号');

  const targetId = sqlString(target, 'id');
  if (targetId === access.ownerId) throw conflict('所有者已经拥有该表格');

  await db.prepare(
    `INSERT INTO database_members (id, database_id, user_id, role, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (database_id, user_id) DO UPDATE SET role = excluded.role`,
  )
    .bind(newId(), ctx.params.id, targetId, role, Date.now())
    .run();

  await touchDatabase(db, ctx.params.id);
  // 成员列表变了（备注 @ 名单 / 侧边栏也会跟着变）
  await logChanges(db, ctx.params.id, 'schema');
  return json({ members: await loadMembers(ctx.env, db, ctx.params.id) });
}

async function updateMemberHandler(ctx: RequestContext): Promise<Response> {
  if (isOwnerMemberId(ctx.params.id)) throw badRequest('不能修改所有者的权限');
  const { databaseId, access } = await accessForMember(ctx, ctx.params.id);
  const db = tableDb(ctx);
  const body = await readJson(ctx.request);
  const role = asEnum(body.role, ['editor', 'viewer'] as const, '角色');
  await db.prepare(
    `UPDATE database_members SET role = ? WHERE id = ? AND database_id = ?`,
  )
    .bind(role, ctx.params.id, databaseId)
    .run();
  await logChanges(db, databaseId, 'schema');
  return json({ members: await loadMembers(ctx.env, db, databaseId), role: access.role });
}

async function removeMemberHandler(ctx: RequestContext): Promise<Response> {
  if (isOwnerMemberId(ctx.params.id)) throw badRequest('不能移除所有者');
  const { databaseId } = await accessForMember(ctx, ctx.params.id);
  const db = tableDb(ctx);
  await db.prepare('DELETE FROM database_members WHERE id = ? AND database_id = ?')
    .bind(ctx.params.id, databaseId)
    .run();
  await logChanges(db, databaseId, 'schema');
  return json({ members: await loadMembers(ctx.env, db, databaseId) });
}

async function createShareHandler(ctx: RequestContext): Promise<Response> {
  const user = await requireUser(ctx.request, ctx.env);
  await requireDatabaseAccess(ctx, ctx.params.id, user, 'edit');
  const db = tableDb(ctx);
  const body = await readJson(ctx.request);
  const permission = asEnum(body.permission ?? 'view', ['view', 'edit'] as const, '权限');
  // 「限制编辑」：只对可编辑链接有意义（只读链接本来就不能改）
  const limitEdits = permission === 'edit' && asFlag(body.limitEdits);
  const days = Number(body.expiresInDays ?? 0);
  const expiresAt = Number.isFinite(days) && days > 0 ? Date.now() + days * 86_400_000 : null;

  const token = randomToken(24);
  await db.prepare(
    `INSERT INTO shares (id, database_id, token, permission, limit_edits, created_by, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(newId(), ctx.params.id, token, permission, limitEdits ? 1 : 0, user.id, expiresAt, Date.now())
    .run();

  await logChanges(db, ctx.params.id, 'schema');
  return json({ shares: await loadShares(db, ctx.params.id) }, { status: 201 });
}

async function deleteShareHandler(ctx: RequestContext): Promise<Response> {
  const user = await requireUser(ctx.request, ctx.env);
  const handle = await requireEntityShard(ctx.env, 'shares', 'id', ctx.params.id, '分享链接不存在');
  const row = await handle.db
    .prepare('SELECT database_id FROM shares WHERE id = ?')
    .bind(ctx.params.id)
    .first<SqlRow>();
  if (!row) throw notFound('分享链接不存在');
  const databaseId = sqlString(row, 'database_id');
  await requireDatabaseAccess(ctx, databaseId, user, 'edit');
  const db = tableDb(ctx);
  await db.prepare('DELETE FROM shares WHERE id = ?').bind(ctx.params.id).run();
  await logChanges(db, databaseId, 'schema');
  return json({ shares: await loadShares(db, databaseId) });
}

/**
 * 视图定向分享：把一个视图（含它的筛选与可见字段）分享给某个账号。
 *
 * 目标邮箱还没注册时不再直接报错：
 *   - 不带 `invite` → 404 `email_not_registered`，前端据此弹确认框问「要不要发邀请链接」；
 *   - 带 `invite: true` → 生成一条邀请（`invites` 表）并把 `/invite/<token>` 链接发到对方邮箱，
 *     对方填昵称 + 密码即完成注册（见 routes/invites.ts），注册后自动获得这条视图分享。
 */
async function createViewShareHandler(ctx: RequestContext): Promise<Response> {
  const user = await requireUser(ctx.request, ctx.env);
  const access = await requireDatabaseAccess(ctx, ctx.params.id, user, 'manage');
  const db = tableDb(ctx);
  const body = await readJson(ctx.request);
  const viewId = asString(body.viewId, '视图', { required: true, max: 64 });
  const role = asEnum(body.role ?? 'viewer', ['viewer', 'editor'] as const, '角色');
  // 「限制编辑」：只对可编辑分享有意义（只读分享本来就不能改）
  const limitEdits = role === 'editor' && asFlag(body.limitEdits);
  const email = normalizeEmail(body.email);
  const inviteRequested = asFlag(body.invite);

  const view = await db.prepare('SELECT id FROM views WHERE id = ? AND database_id = ?')
    .bind(viewId, ctx.params.id)
    .first<SqlRow>();
  if (!view) throw notFound('视图不存在');

  const target = await ctx.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<SqlRow>();
  if (!target) {
    // 邮箱还没注册：先让前端确认「是否发送邀请链接」，确认后带 invite: true 再来一次
    if (!inviteRequested) {
      throw new HttpError(404, 'email_not_registered', '该邮箱还没有注册账号，可以邀请对方注册后再分享');
    }
    const invite = await issueViewInvite(db, {
      email,
      databaseId: ctx.params.id,
      viewId,
      role,
      limitEdits,
      invitedBy: user.id,
    });
    // 发信失败会删掉这条邀请并抛 502；成功 / 回显才返回
    const deliveredInvite = await deliverViewInvite(ctx.env, db, invite, ctx.url.origin);
    return json(
      { viewShares: await loadViewShares(ctx.env, db, ctx.params.id), invite: deliveredInvite },
      { status: 201 },
    );
  }

  const targetId = sqlString(target, 'id');
  if (targetId === access.ownerId) throw conflict('所有者已经拥有该表格');

  await db.prepare(
    `INSERT INTO view_shares (id, database_id, view_id, user_id, role, limit_edits, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (view_id, user_id) DO UPDATE SET role = excluded.role, limit_edits = excluded.limit_edits`,
  )
    .bind(
      newId(),
      ctx.params.id,
      viewId,
      targetId,
      role,
      limitEdits ? 1 : 0,
      user.id,
      Date.now(),
    )
    .run();

  await touchDatabase(db, ctx.params.id);
  await logChanges(db, ctx.params.id, 'schema');
  return json({ viewShares: await loadViewShares(ctx.env, db, ctx.params.id) }, { status: 201 });
}

async function deleteViewShareHandler(ctx: RequestContext): Promise<Response> {
  const user = await requireUser(ctx.request, ctx.env);
  const handle = await requireEntityShard(ctx.env, 'view_shares', 'id', ctx.params.id, '视图分享不存在');
  const row = await handle.db
    .prepare('SELECT database_id FROM view_shares WHERE id = ?')
    .bind(ctx.params.id)
    .first<SqlRow>();
  if (!row) throw notFound('视图分享不存在');
  const databaseId = sqlString(row, 'database_id');
  await requireDatabaseAccess(ctx, databaseId, user, 'manage');
  const db = tableDb(ctx);
  await db.prepare('DELETE FROM view_shares WHERE id = ?').bind(ctx.params.id).run();
  await logChanges(db, databaseId, 'schema');
  return json({ viewShares: await loadViewShares(ctx.env, db, databaseId) });
}

export const databaseRoutes: Route[] = [
  { method: 'GET', path: '/api/databases', handler: listHandler },
  { method: 'POST', path: '/api/databases', handler: createHandler },
  { method: 'GET', path: '/api/databases/:id', handler: detailHandler },
  { method: 'GET', path: '/api/databases/:id/changes', handler: changesHandler },
  { method: 'PATCH', path: '/api/databases/:id', handler: updateHandler },
  { method: 'DELETE', path: '/api/databases/:id', handler: deleteHandler },
  { method: 'GET', path: '/api/databases/:id/records', handler: recordsPageHandler },
  { method: 'POST', path: '/api/databases/:id/members', handler: addMemberHandler },
  { method: 'PATCH', path: '/api/members/:id', handler: updateMemberHandler },
  { method: 'DELETE', path: '/api/members/:id', handler: removeMemberHandler },
  { method: 'POST', path: '/api/databases/:id/shares', handler: createShareHandler },
  { method: 'DELETE', path: '/api/shares/:id', handler: deleteShareHandler },
  { method: 'POST', path: '/api/databases/:id/view-shares', handler: createViewShareHandler },
  { method: 'DELETE', path: '/api/view-shares/:id', handler: deleteViewShareHandler },
];




