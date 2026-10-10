/**
 * /api/admin/shards* —— 后台「存储分片」（仅超级管理员）。
 *
 * 表格数据按类型分散在若干 D1 分片库里（见 src/worker/shards.ts、docs/storage.md），
 * 库快满时管理员在这里新建 / 挂载新的分片。接口：
 *
 *   GET    /api/admin/shards            分片总览（用量 + 每片的表格 / 记录 / 附件数 + 小结）
 *   POST   /api/admin/shards            新建一个 D1 库并挂载成分片（body `{ kind, name?, note? }`）
 *   POST   /api/admin/shards/mount      挂载一个**已经存在**的 D1 库（body `{ databaseId, kind, ... }`）
 *   GET    /api/admin/shards/databases  账号下的 D1 库列表（挑一个来挂载）
 *   PATCH  /api/admin/shards/:id        改名 / 备注 / 启停 / 绑定名
 *   DELETE /api/admin/shards/:id        从注册表里摘掉（**不动** D1 库里的数据）
 *   POST   /api/admin/shards/refresh    去 Cloudflare 读一遍所有分片的用量
 *
 * 「新建 / 挂载 / 刷新用量」都要调 Cloudflare API，需要 `CLOUDFLARE_ACCOUNT_ID` +
 * `CLOUDFLARE_API_TOKEN`（Account > D1 > Edit）；没配时返回 501 并给出配置提示，
 * 只有「列表」永远可用（注册表为空时回退到 wrangler.jsonc 里绑定的主分片）。
 */
import type {
  AdminAccountDatabase,
  AdminAccountDatabasesResponse,
  AdminShard,
  AdminShardCounts,
  AdminShardsResponse,
  AdminShardSummary,
  TableKind,
} from '../../shared/types';
import { TABLE_KINDS, asTableKind } from '../../shared/tableKind';
import { requireAdmin } from '../auth';
import { asEnum, asString, badRequest, json, readJson, sqlNumber, type SqlRow } from '../http';
import { D1_DATABASE_LIMIT_BYTES } from '../shardSchema';
import {
  accountDatabases,
  createShardDatabase,
  d1ApiConfigured,
  listShards,
  mountExistingShard,
  refreshAllShardUsage,
  removeShard,
  requireD1Credentials,
  shardDb,
  shardOverviews,
  updateShard,
  type ShardOverview,
} from '../shards';
import type { Env, RequestContext, Route } from '../types';

/** 每片的表格 / 记录 / 附件数（尽力而为：库被删 / 网络抖动时各项为 null） */
async function shardCounts(env: Env, overview: ShardOverview): Promise<AdminShardCounts> {
  const empty: AdminShardCounts = { databases: null, records: null, files: null, fileBytes: null };
  try {
    const row = await shardDb(env, overview.shard)
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM databases) AS databases,
           (SELECT COUNT(*) FROM records WHERE is_archived = 0) AS records,
           (SELECT COUNT(*) FROM files) AS files,
           (SELECT COALESCE(SUM(size), 0) FROM files) AS file_bytes`,
      )
      .first<SqlRow>();
    if (!row) return empty;
    return {
      databases: sqlNumber(row, 'databases'),
      records: sqlNumber(row, 'records'),
      files: sqlNumber(row, 'files'),
      fileBytes: sqlNumber(row, 'file_bytes'),
    };
  } catch (error) {
    console.warn(`读分片 ${overview.shard.name} 的明细失败：`, error);
    return empty;
  }
}

function toAdminShard(overview: ShardOverview, counts: AdminShardCounts): AdminShard {
  return {
    id: overview.shard.id,
    name: overview.shard.name,
    kind: overview.shard.kind,
    databaseId: overview.shard.databaseId,
    transport: overview.transport,
    binding: overview.shard.binding,
    note: overview.shard.note,
    isActive: overview.shard.isActive,
    manageable: overview.manageable,
    usedBytes: overview.usage.usedBytes,
    limitBytes: overview.usage.limitBytes,
    ratio: overview.usage.ratio,
    nearLimit: overview.usage.nearLimit,
    checkedAt: overview.shard.checkedAt,
    createdAt: overview.shard.createdAt,
    updatedAt: overview.shard.updatedAt,
    ...counts,
  };
}

/** 全部读得到才算总数（有一个分片读不到就返回 null，免得给出偏小的数字） */
function sumOrNull(values: (number | null)[]): number | null {
  if (!values.length || values.some((value) => value === null)) return null;
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

/** 后台页面要的全部数据：逐片明细 + 总量小结 */
async function shardsPayload(env: Env): Promise<AdminShardsResponse> {
  const overviews = await shardOverviews(env);
  const shards = await Promise.all(
    overviews.map(async (overview) => toAdminShard(overview, await shardCounts(env, overview))),
  );

  const summary: AdminShardSummary = {
    shards: shards.length,
    activeShards: shards.filter((shard) => shard.isActive).length,
    nearLimit: shards.filter((shard) => shard.isActive && shard.nearLimit).length,
    usedBytes: shards.reduce((sum, shard) => sum + (shard.usedBytes ?? 0), 0),
    limitBytes: D1_DATABASE_LIMIT_BYTES,
    unknownUsage: shards.filter((shard) => shard.usedBytes === null).length,
    databases: sumOrNull(shards.map((shard) => shard.databases)),
    records: sumOrNull(shards.map((shard) => shard.records)),
    files: sumOrNull(shards.map((shard) => shard.files)),
    fileBytes: sumOrNull(shards.map((shard) => shard.fileBytes)),
    d1ApiConfigured: d1ApiConfigured(env),
  };
  return { shards, summary };
}

async function listShardsHandler(ctx: RequestContext): Promise<Response> {
  await requireAdmin(ctx.request, ctx.env);
  return json(await shardsPayload(ctx.env));
}

/** 新建一个 D1 库 + 执行建表脚本 + 登记成分片（需要 Cloudflare API 凭据）。 */
async function createShardHandler(ctx: RequestContext): Promise<Response> {
  await requireAdmin(ctx.request, ctx.env);
  const body = await readJson(ctx.request);
  const kind = asTableKind(asEnum(body.kind ?? 'basic', TABLE_KINDS, '表格类型') as TableKind);
  const name = asString(body.name, '分片名称', { max: 60 });
  const note = asString(body.note, '备注', { max: 200 });

  const shard = await createShardDatabase(ctx.env, { kind, name, note });
  return json({ ...(await shardsPayload(ctx.env)), shard: { id: shard.id, name: shard.name } }, { status: 201 });
}

/** 挂载一个已经存在的 D1 库（先在 wrangler.jsonc 里加绑定、或手动建过库）。 */
async function mountShardHandler(ctx: RequestContext): Promise<Response> {
  await requireAdmin(ctx.request, ctx.env);
  const body = await readJson(ctx.request);
  const databaseId = asString(body.databaseId, 'database_id', { required: true, max: 64 });
  const kind = asTableKind(asEnum(body.kind ?? 'basic', TABLE_KINDS, '表格类型') as TableKind);
  const name = asString(body.name, '分片名称', { max: 60 });
  const note = asString(body.note, '备注', { max: 200 });
  const binding = asString(body.binding, '绑定名', { max: 40 });

  // 库里的表还没建过的话，`mountExistingShard` 会先执行一遍建表脚本（幂等）
  const shard = await mountExistingShard(ctx.env, { databaseId, kind, name, note, binding: binding || null });
  return json({ ...(await shardsPayload(ctx.env)), shard: { id: shard.id, name: shard.name } }, { status: 201 });
}

/** 改名 / 备注 / 启停 / 绑定名（启停立刻生效：停用的分片不再参与路由）。 */
async function updateShardHandler(ctx: RequestContext): Promise<Response> {
  await requireAdmin(ctx.request, ctx.env);
  const body = await readJson(ctx.request);
  const patch: { name?: string; note?: string; binding?: string | null; isActive?: boolean } = {};
  if (body.name !== undefined) patch.name = asString(body.name, '分片名称', { required: true, max: 60 });
  if (body.note !== undefined) patch.note = asString(body.note, '备注', { max: 200 });
  if (body.binding !== undefined) patch.binding = asString(body.binding, '绑定名', { max: 40 }) || null;
  if (body.isActive !== undefined) patch.isActive = body.isActive === true || body.isActive === 1;
  if (!Object.keys(patch).length) throw badRequest('没有需要保存的修改');

  await updateShard(ctx.env, ctx.params.id ?? '', patch);
  return json(await shardsPayload(ctx.env));
}

/** 从注册表里摘掉（D1 库与里面的数据保持原样，删库请去 Cloudflare 控制台）。 */
async function removeShardHandler(ctx: RequestContext): Promise<Response> {
  await requireAdmin(ctx.request, ctx.env);
  await removeShard(ctx.env, ctx.params.id ?? '');
  return json(await shardsPayload(ctx.env));
}

/** 去 Cloudflare 读一遍所有分片的用量（写回注册表，页面立刻能看到新数字）。 */
async function refreshShardsHandler(ctx: RequestContext): Promise<Response> {
  await requireAdmin(ctx.request, ctx.env);
  const refreshed = await refreshAllShardUsage(ctx.env);
  const failed = refreshed.filter((shard) => shard.databaseId && shard.checkedAt === null).length;
  return json({ ...(await shardsPayload(ctx.env)), refreshed: refreshed.length, failed });
}

/** 账号下的 D1 库（挂载现成的库时用来挑；没配凭据就是 501 + 配置提示）。 */
async function accountDatabasesHandler(ctx: RequestContext): Promise<Response> {
  await requireAdmin(ctx.request, ctx.env);
  requireD1Credentials(ctx.env);
  const [remote, mounted] = await Promise.all([
    accountDatabases(ctx.env),
    listShards(ctx.env, { refresh: true }),
  ]);
  const mountedIds = new Set(mounted.map((shard) => shard.databaseId).filter(Boolean));
  const databases: AdminAccountDatabase[] = remote.map((info) => ({
    uuid: info.uuid,
    name: info.name,
    fileSize: info.fileSize,
    numTables: info.numTables,
    createdAt: info.createdAt,
    mounted: mountedIds.has(info.uuid),
  }));
  const payload: AdminAccountDatabasesResponse = { databases };
  return json(payload);
}

export const shardRoutes: Route[] = [
  { method: 'GET', path: '/api/admin/shards', handler: listShardsHandler },
  { method: 'POST', path: '/api/admin/shards', handler: createShardHandler },
  { method: 'POST', path: '/api/admin/shards/mount', handler: mountShardHandler },
  { method: 'GET', path: '/api/admin/shards/databases', handler: accountDatabasesHandler },
  { method: 'POST', path: '/api/admin/shards/refresh', handler: refreshShardsHandler },
  { method: 'PATCH', path: '/api/admin/shards/:id', handler: updateShardHandler },
  { method: 'DELETE', path: '/api/admin/shards/:id', handler: removeShardHandler },
];
