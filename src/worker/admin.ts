/**
 * 超级管理员账号的引导 + 用户列表查询。
 *
 * 管理员邮箱来自后台「站点设置」（`settings.admin_email`）或环境变量（`ADMIN_EMAIL`），
 * 两者都没有时用默认的 `admin@varysheet.com`（见 worker/settings.ts 的 DEFAULT_ADMIN_EMAIL）。
 * 启动阶段不需要任何初始化动作：每次登录（以及带会话的 /api/session）都会调一次
 * `ensureAdminUser`，每个 isolate 只真正跑一次。
 *   - 该邮箱的账号不存在 → 用 `ADMIN_PASSWORD` 直接创建（已带 `is_admin = 1`）；
 *   - 已存在 → 提升为管理员；
 *   - `ADMIN_RESET_PASSWORD=true` 时用 `ADMIN_PASSWORD` 覆盖密码（改完记得去掉这个变量）。
 *
 * 密码只用于「首次创建」，之后请在界面上用「改密码」自行更换。
 */
import { hashPassword, validatePasswordStrength, verifyPassword } from './auth';
import { EMAIL_PATTERN, newId, sqlNullableNumber, sqlNumber, sqlString, type SqlRow } from './http';
import { DEFAULT_ADMIN_EMAIL } from './settings';
import { forEachShardSafe } from './shards';
import type { AdminUser } from '../shared/types';
import type { Env } from './types';

/** 用户列表一次最多返回多少条 */
const MAX_PAGE_SIZE = 100;

/**
 * 生效的管理员邮箱：优先用调用方传来的（后台里改过的设置），
 * 其次环境变量 `ADMIN_EMAIL`，最后默认 `admin@varysheet.com`（不合法就当没配）。
 */
export function adminEmailFrom(env: Env, override?: string): string | null {
  const email = (override ?? env.ADMIN_EMAIL ?? '').trim().toLowerCase() || DEFAULT_ADMIN_EMAIL;
  return EMAIL_PATTERN.test(email) ? email : null;
}

let bootstrap: { email: string; promise: Promise<void> } | null = null;

/** 让配置的管理员邮箱对应的账号成为管理员（幂等；失败只记日志，不影响正常登录）。 */
export function ensureAdminUser(env: Env, email?: string): Promise<void> {
  const resolved = adminEmailFrom(env, email);
  if (!resolved) return Promise.resolve();
  if (bootstrap?.email === resolved) return bootstrap.promise;

  const promise = bootstrapAdmin(env, resolved).catch((error) => {
    console.error('管理员账号引导失败:', error);
    if (bootstrap?.email === resolved) bootstrap = null; // 下次请求再试
  });
  bootstrap = { email: resolved, promise };
  return promise;
}

async function bootstrapAdmin(env: Env, email: string): Promise<void> {
  const desiredPassword = (env.ADMIN_PASSWORD ?? '').trim();
  const forceReset = (env.ADMIN_RESET_PASSWORD ?? '').toLowerCase() === 'true';
  const now = Date.now();

  const row = await env.DB.prepare('SELECT id, password_hash, is_admin FROM users WHERE email = ?')
    .bind(email)
    .first<SqlRow>();

  if (!row) {
    if (!desiredPassword) {
      console.warn(`管理员邮箱 ${email} 还没有账号，且未配置 ADMIN_PASSWORD，跳过自动创建`);
      return;
    }
    const problem = validatePasswordStrength(desiredPassword);
    if (problem) {
      console.warn(`ADMIN_PASSWORD 不符合密码要求（${problem}），跳过自动创建`);
      return;
    }
    await env.DB.prepare(
      `INSERT INTO users (id, email, name, password_hash, created_at, updated_at, is_admin)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
    )
      .bind(newId(), email, '管理员', await hashPassword(desiredPassword, env), now, now)
      .run();
    console.log(`已创建超级管理员账号 ${email}`);
    return;
  }

  const id = sqlString(row, 'id');
  if (sqlNumber(row, 'is_admin') !== 1) {
    await env.DB.prepare('UPDATE users SET is_admin = 1, updated_at = ? WHERE id = ?').bind(now, id).run();
    console.log(`已把 ${email} 提升为超级管理员`);
  }

  if (!forceReset || !desiredPassword) return;
  const problem = validatePasswordStrength(desiredPassword);
  if (problem) {
    console.warn(`ADMIN_PASSWORD 不符合密码要求（${problem}），跳过密码同步`);
    return;
  }
  if (await verifyPassword(desiredPassword, sqlString(row, 'password_hash'))) return;
  await env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .bind(await hashPassword(desiredPassword, env), now, id)
    .run();
  console.log(`已按 ADMIN_PASSWORD 重置 ${email} 的密码（ADMIN_RESET_PASSWORD=true）`);
}

/* ------------------------------------------------------------ 用户列表查询 */

/** 列表里每个用户的「活跃度」：表格数 / 被分享数在分片里，最近活跃时间在用户库。 */
interface AdminUserCounts {
  databaseCount: number;
  sharedCount: number;
  lastSeenAt: number | null;
}

function adminUserFromRow(row: SqlRow, counts?: AdminUserCounts): AdminUser {
  return {
    id: sqlString(row, 'id'),
    email: sqlString(row, 'email'),
    name: sqlString(row, 'name'),
    isAdmin: sqlNumber(row, 'is_admin') === 1,
    createdAt: sqlNumber(row, 'created_at'),
    updatedAt: sqlNumber(row, 'updated_at'),
    databaseCount: counts?.databaseCount ?? 0,
    sharedCount: counts?.sharedCount ?? 0,
    lastSeenAt: counts?.lastSeenAt ?? null,
  };
}

function chunksOf<T>(items: T[], size: number): T[][] {
  const slices: T[][] = [];
  for (let index = 0; index < items.length; index += size) slices.push(items.slice(index, index + size));
  return slices;
}

function inClause(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

/**
 * 补上「这个用户有几张表 / 被分享了几张表 / 最近什么时候来过」。
 *
 * 存储拆分之后这些数据不在同一个库里：表格数与成员身份逐分片统计（某个分片不可用时
 * 按 0 算，不拖垮整个用户列表），会话仍然在用户库。
 */
async function userActivityCounts(env: Env, ids: string[]): Promise<Map<string, AdminUserCounts>> {
  const counts = new Map<string, AdminUserCounts>();
  const unique = [...new Set(ids)];
  for (const id of unique) counts.set(id, { databaseCount: 0, sharedCount: 0, lastSeenAt: null });
  if (!unique.length) return counts;

  const scans = await forEachShardSafe(env, async (_shard, db) => {
    const owned = new Map<string, number>();
    const shared = new Map<string, number>();
    for (const slice of chunksOf(unique, DELETE_CHUNK)) {
      const holes = inClause(slice.length);
      const [ownedRows, sharedRows] = await Promise.all([
        db
          .prepare(
            `SELECT owner_id AS user_id, COUNT(*) AS total FROM databases
              WHERE owner_id IN (${holes}) GROUP BY owner_id`,
          )
          .bind(...slice)
          .all<SqlRow>(),
        db
          .prepare(
            `SELECT user_id, COUNT(*) AS total FROM database_members
              WHERE user_id IN (${holes}) GROUP BY user_id`,
          )
          .bind(...slice)
          .all<SqlRow>(),
      ]);
      for (const row of ownedRows.results ?? []) owned.set(sqlString(row, 'user_id'), sqlNumber(row, 'total'));
      for (const row of sharedRows.results ?? []) shared.set(sqlString(row, 'user_id'), sqlNumber(row, 'total'));
    }
    return { owned, shared };
  });

  for (const scan of scans) {
    if (!scan.value) continue;
    for (const [id, total] of scan.value.owned) {
      const entry = counts.get(id);
      if (entry) entry.databaseCount += total;
    }
    for (const [id, total] of scan.value.shared) {
      const entry = counts.get(id);
      if (entry) entry.sharedCount += total;
    }
  }

  for (const slice of chunksOf(unique, DELETE_CHUNK)) {
    const { results } = await env.DB.prepare(
      `SELECT user_id, MAX(last_seen_at) AS last_seen_at FROM sessions
        WHERE user_id IN (${inClause(slice.length)}) GROUP BY user_id`,
    )
      .bind(...slice)
      .all<SqlRow>();
    for (const row of results ?? []) {
      const entry = counts.get(sqlString(row, 'user_id'));
      if (entry) entry.lastSeenAt = sqlNullableNumber(row, 'last_seen_at');
    }
  }

  return counts;
}

/** 全部注册用户（可按昵称 / 邮箱搜索），管理员页面用。 */
export async function loadAdminUsers(
  env: Env,
  options: { search?: string; limit?: number; offset?: number } = {},
): Promise<{ users: AdminUser[]; total: number }> {
  const search = (options.search ?? '').trim().slice(0, 60);
  const limit = Math.min(Math.max(Math.floor(options.limit ?? 50), 1), MAX_PAGE_SIZE);
  const offset = Math.max(Math.floor(options.offset ?? 0), 0);

  const filter = search ? 'WHERE (u.email LIKE ? OR u.name LIKE ?)' : '';
  const like = `%${search}%`;
  const binds = search ? [like, like] : [];

  const [countRow, { results }] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS total FROM users u ${filter}`)
      .bind(...binds)
      .first<SqlRow>(),
    env.DB.prepare(
      `SELECT u.id, u.email, u.name, u.is_admin, u.created_at, u.updated_at
         FROM users u
         ${filter}
        ORDER BY u.created_at DESC
        LIMIT ? OFFSET ?`,
    )
      .bind(...binds, limit, offset)
      .all<SqlRow>(),
  ]);

  const rows = results ?? [];
  // 表格数 / 被分享数在分片里：用户行先出来，活跃度再补上
  const counts = await userActivityCounts(env, rows.map((row) => sqlString(row, 'id')));
  return {
    users: rows.map((row) => adminUserFromRow(row, counts.get(sqlString(row, 'id')))),
    total: sqlNumber(countRow ?? {}, 'total'),
  };
}

/** 单个用户（`PATCH /api/admin/users/:id` 的响应）。 */
export async function loadAdminUser(env: Env, userId: string): Promise<AdminUser | null> {
  const row = await env.DB.prepare(
    'SELECT id, email, name, is_admin, created_at, updated_at FROM users WHERE id = ?',
  )
    .bind(userId)
    .first<SqlRow>();
  if (!row) return null;
  const counts = await userActivityCounts(env, [userId]);
  return adminUserFromRow(row, counts.get(userId));
}

/* ------------------------------------------------------------ 删除注册账号 */

/** 一次请求最多删除多少个账号 */
export const MAX_DELETE_USERS = 100;
/** 绑定参数 / IN 列表的分片大小 */
const DELETE_CHUNK = 100;

export interface AdminDeleteUsersResult {
  deleted: { id: string; email: string; name: string }[];
  skipped: { id: string; email: string; reason: string }[];
  /** 连带删除的表格数 */
  databaseCount: number;
}

/**
 * 删除一批注册账号（「用户管理」里的批量删除）。
 *
 * 删除是彻底的：账号自己拥有的表格（连同里面的记录 / 备注 / 字段 / 视图 /
 * 分享链接）以及 R2 里的上传文件一起清掉；在别人表格里的成员身份、定向分享、
 * 私信、会话也一并移除。
 *
 * 以下情况跳过（放在 `skipped` 里返回，不算失败）：
 *   - 账号不存在；
 *   - `users.is_admin = 1`：管理员账号需要先把 is_admin 改回 0；
 *   - 传进来的正是操作者自己：避免把自己删掉后失去用户管理入口。
 */
export async function deleteAdminUsers(
  env: Env,
  ids: string[],
  actorId: string,
): Promise<AdminDeleteUsersResult> {
  const unique = [...new Set(ids.map((id) => String(id).trim()).filter(Boolean))].slice(0, MAX_DELETE_USERS);
  const result: AdminDeleteUsersResult = { deleted: [], skipped: [], databaseCount: 0 };
  if (!unique.length) return result;

  const found: SqlRow[] = [];
  for (let index = 0; index < unique.length; index += DELETE_CHUNK) {
    const slice = unique.slice(index, index + DELETE_CHUNK);
    const { results } = await env.DB.prepare(
      `SELECT id, email, name, is_admin FROM users WHERE id IN (${slice.map(() => '?').join(', ')})`,
    )
      .bind(...slice)
      .all<SqlRow>();
    found.push(...(results ?? []));
  }
  const byId = new Map(found.map((row) => [sqlString(row, 'id'), row]));

  for (const id of unique) {
    const row = byId.get(id);
    if (!row) {
      result.skipped.push({ id, email: '', reason: '账号不存在' });
      continue;
    }
    const email = sqlString(row, 'email');
    const name = sqlString(row, 'name');
    if (id === actorId) {
      result.skipped.push({ id, email, reason: '不能删除自己的账号' });
      continue;
    }
    if (sqlNumber(row, 'is_admin') === 1) {
      result.skipped.push({ id, email, reason: '管理员账号不能删除（请先取消管理员）' });
      continue;
    }

    // 先记下这个账号的表格里上传过的文件，元数据删掉后就查不到了
    // 表格数据在分片里：先逐分片把要删的 R2 key / 表格数捞出来，再逐分片级联删除
    const scans = await forEachShardSafe(env, async (_shard, db) => {
      const [fileRows, countRow] = await Promise.all([
        db
          .prepare(
            'SELECT f.r2_key AS r2_key FROM files f JOIN databases d ON d.id = f.database_id WHERE d.owner_id = ?',
          )
          .bind(id)
          .all<SqlRow>(),
        db.prepare('SELECT COUNT(*) AS total FROM databases WHERE owner_id = ?').bind(id).first<SqlRow>(),
      ]);

      await db.batch([
        // 自己拥有的表格：记录 / 字段 / 视图 / 分享 / 备注 / 文件元数据由外键级联清理
        db.prepare('DELETE FROM databases WHERE owner_id = ?').bind(id),
        // 在别人表格里的身份：成员 / 定向分享 / 「限制编辑」记录 / 还没接受的邀请
        db.prepare('DELETE FROM database_members WHERE user_id = ?').bind(id),
        db.prepare('DELETE FROM view_shares WHERE user_id = ?').bind(id),
        db.prepare('DELETE FROM cell_edits WHERE editor_key = ?').bind(`user:${id}`),
        db.prepare('DELETE FROM invites WHERE email = ? AND accepted_at IS NULL').bind(email),
      ]);

      return {
        keys: (fileRows.results ?? []).map((item) => sqlString(item, 'r2_key')).filter(Boolean),
        databases: sqlNumber(countRow ?? {}, 'total'),
      };
    });

    // 有分片没删成功就先不动账号本身：下次重试还能把剩下的数据清干净
    const failed = scans.filter((scan) => scan.error);
    if (failed.length) {
      result.skipped.push({
        id,
        email,
        reason: `有 ${failed.length} 个表格分片不可用，未能清理该账号的表格数据，请稍后重试`,
      });
      continue;
    }

    // 账号本体 / 会话 / 私信在用户库
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id),
      env.DB.prepare('DELETE FROM note_mentions WHERE user_id = ?').bind(id),
      env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id),
    ]);

    // 最后把 R2 里的上传文件删掉（删不掉也不影响账号已经被删除）
    const keys = scans.flatMap((scan) => scan.value?.keys ?? []);
    for (let index = 0; index < keys.length; index += DELETE_CHUNK) {
      await env.BUCKET.delete(keys.slice(index, index + DELETE_CHUNK));
    }

    result.deleted.push({ id, email, name });
    result.databaseCount += scans.reduce((sum, scan) => sum + (scan.value?.databases ?? 0), 0);
  }

  return result;
}
