/**
 * 记录备注（评论）+ @提醒私信的读写。
 *
 * 备注只能新增，不能修改 / 删除：这里没有 update / delete 语句，
 * `routes/notes.ts` 也只暴露一个 POST。
 * 备注里 @ 到的人会在收件箱里收到一条私信（`note_mentions`），读掉之后未读数 -1。
 *
 * 存储拆分之后（见 shards.ts）：
 *   - `notes` 跟着记录走，在**表格所在的分片**里；
 *   - `note_mentions` 是「按人」查的私信流，留在**用户库**，里面冗余了 database_id / record_id；
 *   - 用户名在用户库，跨库没有 JOIN，所以作者 / @对象的显示名是「两次查询 + JS 合并」补上的。
 */
import { FIELD_META, formatValueForDisplay } from '../shared/fields';
import type {
  CellValue,
  InboxMessage,
  Member,
  NoteMention,
  Property,
  RecordNote,
  RowValues,
} from '../shared/types';
import { parseJsonObject, sqlNullableString, sqlNumber, sqlString, type SqlRow } from './http';
import { propertyFromRow } from './mappers';
import { groupDatabaseShards } from './shards';
import type { Env } from './types';

/** 分片绑定参数，永远不超过 D1 / SQLite 的变量上限 */
const CHUNK = 100;
/** 收件箱一次最多返回多少条未读私信（红点数字仍按实际未读数） */
export const INBOX_LIMIT = 50;

/**
 * 可以被 @ 的人里角色越高越靠前。
 * 同一个人可能既被邀请成成员、又被定向分享，去重时保留权限更高的角色。
 */
const ROLE_RANK: Record<Member['role'], number> = { owner: 3, editor: 2, viewer: 1 };

function sliceList<T>(items: T[], size = CHUNK): T[][] {
  const slices: T[][] = [];
  for (let index = 0; index < items.length; index += size) slices.push(items.slice(index, index + size));
  return slices;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

/** 用户库里的账号信息：邮箱是显示名的兜底，别的地方（成员列表）还要用原始值。 */
export interface UserContact {
  email: string;
  name: string;
}

/** 用户库里的 `users`：一批 id → 联系方式（查不到的 id 不返回）。跨库查询，单独抽出来复用。 */
export async function loadUserContacts(
  env: Env,
  userIds: readonly (string | null)[],
): Promise<Map<string, UserContact>> {
  const contacts = new Map<string, UserContact>();
  const ids = [...new Set(userIds.map((id) => id ?? '').filter(Boolean))];
  for (const slice of sliceList(ids)) {
    const { results } = await env.DB.prepare(
      `SELECT id, name, email FROM users WHERE id IN (${placeholders(slice.length)})`,
    )
      .bind(...slice)
      .all<SqlRow>();
    for (const row of results ?? []) {
      contacts.set(sqlString(row, 'id'), {
        email: sqlString(row, 'email'),
        name: sqlString(row, 'name'),
      });
    }
  }
  return contacts;
}

/** 显示名：昵称优先，没填昵称就用邮箱；账号已经注销时给一句占位文案。 */
export function displayName(contact: UserContact | undefined, fallback = '已注销用户'): string {
  if (!contact) return fallback;
  return contact.name || contact.email || fallback;
}

function noteFromRow(row: SqlRow): RecordNote {
  const authorId = sqlNullableString(row, 'author_id');
  return {
    id: sqlString(row, 'id'),
    databaseId: sqlString(row, 'database_id'),
    recordId: sqlString(row, 'record_id'),
    body: sqlString(row, 'body'),
    authorId,
    // 作者名要回用户库查（跨库），先留空，loadNotes 里补上
    authorName: '',
    mentions: [],
    createdAt: sqlNumber(row, 'created_at'),
  };
}

/**
 * 备注 + 它们的 @对象，按 `createdAt` 升序。
 * 只查传入的记录 id，看不到的记录不会泄露。
 *
 * `db` 是这些记录所在的分片（记录都在同一张表里），备注也从它读；
 * @提醒（`note_mentions`）与用户名在用户库，需要额外两次查询。
 */
export async function loadNotes(env: Env, db: D1Database, recordIds: string[]): Promise<RecordNote[]> {
  const ids = [...new Set(recordIds)].filter(Boolean);
  if (!ids.length) return [];

  const notes: RecordNote[] = [];
  for (const slice of sliceList(ids)) {
    const { results } = await db
      .prepare(
        `SELECT * FROM notes
          WHERE record_id IN (${placeholders(slice.length)})
          ORDER BY created_at ASC`,
      )
      .bind(...slice)
      .all<SqlRow>();
    for (const row of results ?? []) notes.push(noteFromRow(row));
  }
  if (!notes.length) return notes;

  const mentionRows: SqlRow[] = [];
  for (const slice of sliceList(notes.map((note) => note.id))) {
    const { results } = await env.DB.prepare(
      `SELECT note_id, user_id FROM note_mentions WHERE note_id IN (${placeholders(slice.length)})`,
    )
      .bind(...slice)
      .all<SqlRow>();
    mentionRows.push(...(results ?? []));
  }

  const contacts = await loadUserContacts(env, [
    ...notes.map((note) => note.authorId),
    ...mentionRows.map((row) => sqlString(row, 'user_id')),
  ]);
  for (const note of notes) note.authorName = displayName(note.authorId ? contacts.get(note.authorId) : undefined);

  const mentions = new Map<string, NoteMention[]>();
  for (const row of mentionRows) {
    const noteId = sqlString(row, 'note_id');
    const userId = sqlString(row, 'user_id');
    const list = mentions.get(noteId) ?? [];
    list.push({ userId, name: displayName(contacts.get(userId), '未知用户') });
    mentions.set(noteId, list);
  }
  for (const note of notes) note.mentions = mentions.get(note.id) ?? [];

  // 分片查询后再统一排序，保证跨分片也是时间升序
  notes.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return notes;
}

/**
 * 可以被 @ 的人：所有者 + 表格成员 + 视图定向分享的访客。
 *
 * 三种身份都在表格分片里（`db`），用户名要回用户库补 —— 所以是先查身份、再查账号。
 */
export async function mentionableUsers(env: Env, db: D1Database, databaseId: string): Promise<Member[]> {
  const { results } = await db
    .prepare(
      `SELECT d.owner_id AS user_id, 'owner' AS role, d.created_at AS created_at
         FROM databases d WHERE d.id = ?
        UNION ALL
       SELECT m.user_id, m.role, m.created_at
         FROM database_members m WHERE m.database_id = ?
        UNION ALL
       SELECT vs.user_id, vs.role, vs.created_at
         FROM view_shares vs WHERE vs.database_id = ?`,
    )
    .bind(databaseId, databaseId, databaseId)
    .all<SqlRow>();

  const identities = results ?? [];
  const contacts = await loadUserContacts(
    env,
    identities.map((row) => sqlString(row, 'user_id')),
  );

  const byUser = new Map<string, Member>();
  for (const row of identities) {
    const userId = sqlString(row, 'user_id');
    if (!userId) continue;
    const raw = sqlString(row, 'role');
    const role: Member['role'] = raw === 'owner' || raw === 'editor' ? raw : 'viewer';
    const seen = byUser.get(userId);
    if (seen && ROLE_RANK[seen.role] >= ROLE_RANK[role]) continue;
    const contact = contacts.get(userId);
    byUser.set(userId, {
      // 合成的成员 id：前端只把它当成 @ 候选，不会拿去改角色 / 移除成员
      id: `mention:${userId}`,
      databaseId,
      userId,
      email: contact?.email ?? '',
      name: contact?.name ?? '',
      role,
      createdAt: sqlNumber(row, 'created_at'),
    });
  }

  return [...byUser.values()].sort(
    (a, b) =>
      ROLE_RANK[b.role] - ROLE_RANK[a.role] || (a.name || a.email).localeCompare(b.name || b.email),
  );
}

/**
 * 可以被 @ 的人（{@link mentionableUsers}）的 id 集合，供添加备注时校验。
 * 前端候选名单与服务端校验用的是同一份数据，因此所有者和各个被分享者之间可以互相 @。
 */
export async function mentionableUserIds(env: Env, db: D1Database, databaseId: string): Promise<Set<string>> {
  return new Set((await mentionableUsers(env, db, databaseId)).map((member) => member.userId));
}

/**
 * 未读私信条数（就是红点里的数字）。
 *
 * 私信在用户库、表格数据在分片，跨库没法 JOIN，所以这里只按人统计；表格 / 记录被删掉时
 * 对应的私信会被一并删除（见 routes/databases.ts 与 routes/records.ts），统计不会虚高。
 */
export async function unreadMentionCount(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS total FROM note_mentions WHERE user_id = ? AND read_at IS NULL',
  )
    .bind(userId)
    .first<SqlRow>();
  return sqlNumber(row ?? {}, 'total');
}

/** 表格的「标题字段」：第一个文本字段，没有文本字段时退回第一个非计算字段。 */
async function loadTitleProperties(env: Env, databaseIds: string[]): Promise<Map<string, Property>> {
  const grouped = new Map<string, Property[]>();
  // 表格可能分散在不同分片：先按分片分组，再逐分片查（归属探测有缓存）
  const shards = await groupDatabaseShards(env, databaseIds);
  for (const group of shards.values()) {
    for (const slice of sliceList(group.databaseIds)) {
      const { results } = await group.db
        .prepare(
          `SELECT * FROM properties
            WHERE database_id IN (${placeholders(slice.length)})
            ORDER BY database_id ASC, position ASC, created_at ASC`,
        )
        .bind(...slice)
        .all<SqlRow>();
      for (const row of results ?? []) {
        const property = propertyFromRow(row);
        const list = grouped.get(property.databaseId) ?? [];
        list.push(property);
        grouped.set(property.databaseId, list);
      }
    }
  }

  const titles = new Map<string, Property>();
  for (const [databaseId, list] of grouped) {
    const property =
      list.find((item) => item.type === 'text') ?? list.find((item) => !FIELD_META[item.type].computed) ?? list[0];
    if (property) titles.set(databaseId, property);
  }
  return titles;
}

/** 收件箱列表里显示的记录标题（表格可能不止一个，需要按 database_id 分别解析）。 */
export async function loadRecordTitles(
  env: Env,
  records: { databaseId: string; recordId: string; values: RowValues }[],
): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  if (!records.length) return titles;
  const properties = await loadTitleProperties(
    env,
    records.map((record) => record.databaseId),
  );
  for (const record of records) {
    const property = properties.get(record.databaseId);
    if (!property) continue;
    titles.set(
      `${record.databaseId}:${record.recordId}`,
      formatValueForDisplay(property.type, record.values[property.id] as CellValue | undefined, property.config),
    );
  }
  return titles;
}

/** 在一个分片里按 id 列表查一把（IN 列表分批，`sql` 是「按占位符个数生成」的回调）。 */
async function queryIn(db: D1Database, sql: (bindCount: number) => string, ids: readonly string[]): Promise<SqlRow[]> {
  const out: SqlRow[] = [];
  for (const slice of sliceList([...ids])) {
    const { results } = await db
      .prepare(sql(slice.length))
      .bind(...slice)
      .all<SqlRow>();
    out.push(...(results ?? []));
  }
  return out;
}

/**
 * 当前用户的未读私信（按时间倒序），供收件箱面板展示。
 *
 * 私信按人查（用户库），表名 / 记录值 / 备注正文都在表格分片里，跨库没有 JOIN，
 * 所以是「私信行 → 按表格分组 → 逐分片补齐 → 在 JS 里合并」。
 */
export async function loadInboxMessages(env: Env, userId: string): Promise<InboxMessage[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, note_id, database_id, record_id, created_at
       FROM note_mentions
      WHERE user_id = ? AND read_at IS NULL
      ORDER BY created_at DESC
      LIMIT ?`,
  )
    .bind(userId, INBOX_LIMIT)
    .all<SqlRow>();

  const rows = results ?? [];
  if (!rows.length) return [];

  const byDatabase = new Map<string, SqlRow[]>();
  for (const row of rows) {
    const databaseId = sqlString(row, 'database_id');
    const list = byDatabase.get(databaseId) ?? [];
    list.push(row);
    byDatabase.set(databaseId, list);
  }

  const databases = new Map<string, SqlRow>();
  const records = new Map<string, RowValues>();
  const notes = new Map<string, { body: string; authorId: string | null }>();

  const shards = await groupDatabaseShards(env, [...byDatabase.keys()]);
  for (const group of shards.values()) {
    const mentions = group.databaseIds.flatMap((databaseId) => byDatabase.get(databaseId) ?? []);
    const recordIds = [...new Set(mentions.map((row) => sqlString(row, 'record_id')))];
    const noteIds = [...new Set(mentions.map((row) => sqlString(row, 'note_id')))];
    const [databaseRows, recordRows, noteRows] = await Promise.all([
      queryIn(
        group.db,
        (count) => `SELECT id, name, icon FROM databases WHERE id IN (${placeholders(count)})`,
        group.databaseIds,
      ),
      queryIn(
        group.db,
        (count) => `SELECT id, "values" AS record_values FROM records WHERE id IN (${placeholders(count)})`,
        recordIds,
      ),
      queryIn(
        group.db,
        (count) => `SELECT id, body, author_id FROM notes WHERE id IN (${placeholders(count)})`,
        noteIds,
      ),
    ]);
    for (const row of databaseRows) databases.set(sqlString(row, 'id'), row);
    for (const row of recordRows) {
      records.set(sqlString(row, 'id'), parseJsonObject<RowValues>(row.record_values, {}));
    }
    for (const row of noteRows) {
      notes.set(sqlString(row, 'id'), { body: sqlString(row, 'body'), authorId: sqlNullableString(row, 'author_id') });
    }
  }

  const titles = await loadRecordTitles(
    env,
    rows.flatMap((row) => {
      const values = records.get(sqlString(row, 'record_id'));
      // 记录已经删掉的私信不再展示（后台清理任务会把它们一并删掉）
      if (!values) return [];
      return [{ databaseId: sqlString(row, 'database_id'), recordId: sqlString(row, 'record_id'), values }];
    }),
  );

  const contacts = await loadUserContacts(env, [...notes.values()].map((note) => note.authorId));

  const messages: InboxMessage[] = [];
  for (const row of rows) {
    const databaseId = sqlString(row, 'database_id');
    const recordId = sqlString(row, 'record_id');
    const note = notes.get(sqlString(row, 'note_id'));
    // 备注 / 记录 / 表格任一不见了就跳过（旧实现里这几个 JOIN 也会把行过滤掉）
    if (!note || !records.has(recordId) || !databases.has(databaseId)) continue;
    const database = databases.get(databaseId) ?? {};
    messages.push({
      id: sqlString(row, 'id'),
      noteId: sqlString(row, 'note_id'),
      databaseId,
      databaseName: sqlString(database, 'name'),
      databaseIcon: sqlString(database, 'icon', '📋'),
      recordId,
      recordTitle: titles.get(`${databaseId}:${recordId}`) ?? '',
      authorName: displayName(note.authorId ? contacts.get(note.authorId) : undefined),
      body: note.body,
      createdAt: sqlNumber(row, 'created_at'),
    });
  }
  return messages;
}
