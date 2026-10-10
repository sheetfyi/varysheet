/**
 * 走 Cloudflare HTTP API 的 D1 客户端。
 *
 * 为什么需要它：表格数据按「分片（shard）」拆到多个 D1 数据库里（见 `shards.ts`），
 * 主分片可以在 `wrangler.jsonc` 里绑成 `env.DB_TABLES_*` 直接用绑定访问；但**动态
 * 新建**的备用分片没法在运行时加绑定，只能按 `database_id` 走 Cloudflare 的 D1
 * REST 接口：
 *
 *   POST /accounts/:account_id/d1/database/:database_id/query
 *   body: { sql, params }              —— 单条语句
 *   body: { batch: [{ sql, params }] } —— 一批语句（同一个库，按顺序执行）
 *   返回: { success, result: [{ results, meta, success }], errors }
 *
 * 这里把 REST 接口包成和 `D1Database` 一样的形状（`prepare().bind().first()/all()/run()`
 * 与 `batch()`），所以业务代码拿到的分片库和 `env.DB` 用起来完全一致。
 *
 * 另外还提供账号级的库管理（新建 / 查询用量 / 列举），供管理员「新建备用库」用。
 */
import { HttpError } from './http';

/** 默认 API 基址（可用 D1_API_BASE 覆盖，本地调试 / 走代理时用得上） */
const API_BASE = 'https://api.cloudflare.com/client/v4';

/**
 * 访问 D1 HTTP 接口需要的凭据：
 *   CLOUDFLARE_ACCOUNT_ID  账号 ID（与 wrangler 的 CLOUDFLARE_ACCOUNT_ID 同值）
 *   CLOUDFLARE_API_TOKEN   API Token，需要 Account > D1 > Edit 权限
 * 两者缺一就没法访问绑定之外的分片库（绑定上的主分片不受影响）。
 */
export interface D1Credentials {
  accountId: string;
  token: string;
  baseUrl: string;
}

/** 从 Worker 环境里取凭据；没配齐返回 null（调用方决定是报错还是降级）。 */
export function d1Credentials(env: {
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  D1_API_BASE?: string;
}): D1Credentials | null {
  const accountId = (env.CLOUDFLARE_ACCOUNT_ID ?? '').trim();
  const token = (env.CLOUDFLARE_API_TOKEN ?? '').trim();
  if (!accountId || !token) return null;
  return { accountId, token, baseUrl: (env.D1_API_BASE ?? '').trim() || API_BASE };
}

/** 没配凭据时的统一报错文案（管理员页面上直接展示这句话） */
export const D1_CREDENTIALS_HINT =
  '没有配置 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID，无法访问绑定之外的分片库：' +
  '`npx wrangler secret put CLOUDFLARE_API_TOKEN`、`npx wrangler secret put CLOUDFLARE_ACCOUNT_ID`' +
  '（Token 需要 Account > D1 > Edit 权限），本地开发写进 .dev.vars';

interface CloudflareEnvelope<T> {
  success?: boolean;
  result?: T | null;
  errors?: Array<{ code?: number; message?: string }> | null;
  messages?: unknown[] | null;
}

/** 把 Cloudflare 的 errors 数组拼成一句人话 */
function describeErrors(envelope: CloudflareEnvelope<unknown>, status: number): string {
  const messages = (envelope.errors ?? [])
    .map((item) => (item?.message ?? '').trim())
    .filter(Boolean);
  const detail = messages.length ? messages.join('；') : `HTTP ${status}`;
  if (status === 401 || status === 403) {
    return `${detail}（请确认 CLOUDFLARE_API_TOKEN 有效，且带 Account > D1 > Edit 权限）`;
  }
  return detail;
}

/**
 * 调一次 Cloudflare API。网络抖动 / 5xx 会重试一次（4xx 是权限或参数问题，重试没意义）。
 */
async function callApi<T>(
  credentials: D1Credentials,
  path: string,
  init: RequestInit = {},
  attempts = 2,
): Promise<T> {
  let lastError: unknown = new Error('D1 接口调用失败');
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`${credentials.baseUrl}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${credentials.token}`,
          'content-type': 'application/json',
          ...(init.headers ?? {}),
        },
      });
      const text = await response.text();
      let envelope: CloudflareEnvelope<T> | null = null;
      try {
        envelope = text ? (JSON.parse(text) as CloudflareEnvelope<T>) : null;
      } catch {
        envelope = null;
      }
      if (!envelope) {
        throw new HttpError(502, 'd1_api_error', `D1 接口返回了非 JSON 内容（HTTP ${response.status}）`);
      }
      if (!response.ok || envelope.success === false) {
        throw new HttpError(
          502,
          'd1_api_error',
          `D1 接口调用失败：${describeErrors(envelope, response.status)}`,
        );
      }
      return envelope.result as T;
    } catch (error) {
      lastError = error;
      if (error instanceof HttpError && error.status < 500) throw error;
      if (attempt + 1 < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('D1 接口调用失败');
}

/* ------------------------------------------------------------ D1Database 形状 */

/** REST 接口里单条语句的返回（`result[i]`） */
interface RestResult {
  results?: unknown[] | null;
  success?: boolean;
  meta?: Record<string, unknown> | null;
}

/** `meta` 在绑定 API 里是必有的，REST 接口偶尔省略：给个全 0 的兜底 */
function metaOf(raw: Record<string, unknown> | null | undefined): D1Result['meta'] {
  return {
    duration: 0,
    size_after: 0,
    rows_read: 0,
    rows_written: 0,
    last_row_id: 0,
    changed_db: false,
    changes: 0,
    ...(raw ?? {}),
  } as unknown as D1Result['meta'];
}

/** 一条待执行的语句：`bind()` 之后就是 `{ sql, params }` */
interface StatementPayload {
  sql: string;
  params: unknown[];
}

/**
 * 远端语句：与 `D1PreparedStatement` 同名同参，实现了业务用到的
 * `bind / first / all / run`（没用过 raw，就不实现）。
 */
class RestStatement {
  constructor(
    private readonly send: (payload: StatementPayload) => Promise<RestResult>,
    private readonly sql: string,
    private readonly params: unknown[] = [],
  ) {}

  bind(...values: unknown[]): RestStatement {
    return new RestStatement(this.send, this.sql, values);
  }

  async first<T = unknown>(colName?: string): Promise<T | null> {
    const row = (await this.execute()).results?.[0];
    if (row === undefined || row === null) return null;
    if (typeof colName === 'string') return (row as Record<string, unknown>)[colName] as T;
    return row as T;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const result = await this.execute();
    return { results: (result.results ?? []) as T[], success: true, meta: metaOf(result.meta) };
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const result = await this.execute();
    return { results: [] as T[], success: true, meta: metaOf(result.meta) };
  }

  /** 供 batch 用：把这条语句摊平成 REST 的 `{ sql, params }` */
  payload(): StatementPayload {
    return { sql: this.sql, params: this.params };
  }

  private async execute(): Promise<RestResult> {
    return this.send(this.payload());
  }
}

function queryPath(credentials: D1Credentials, databaseId: string): string {
  return `/accounts/${credentials.accountId}/d1/database/${encodeURIComponent(databaseId)}/query`;
}

/**
 * 按 `database_id` 打开一个远端 D1 库，返回与 `D1Database` 形状一致的对象。
 *
 * 注意：每次查询都是一次公网 HTTP 往返，比绑定访问慢不少，
 * 所以主分片尽量用绑定（`env.DB_TABLES_*`），只有备用分片才走这里。
 */
export function remoteD1(credentials: D1Credentials, databaseId: string): D1Database {
  const path = queryPath(credentials, databaseId);

  const send = async (payload: StatementPayload): Promise<RestResult> => {
    const results = await callApi<RestResult[]>(credentials, path, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const first = Array.isArray(results) ? results[0] : null;
    if (!first) throw new HttpError(502, 'd1_api_error', 'D1 接口没有返回语句结果');
    return first;
  };

  const database = {
    prepare(sql: string): D1PreparedStatement {
      return new RestStatement(send, sql) as unknown as D1PreparedStatement;
    },
    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      const batch = statements.map((statement) => {
        const rest = statement as unknown as RestStatement;
        if (typeof rest?.payload !== 'function') {
          // 批处理必须落在同一个库里：混着不同分片的语句是调用方的 bug
          throw new HttpError(500, 'shard_batch_mixed', '批处理里的语句来自不同的数据库，无法合并执行');
        }
        return rest.payload();
      });
      if (!batch.length) return [];
      const results = await callApi<RestResult[]>(credentials, path, {
        method: 'POST',
        body: JSON.stringify({ batch }),
      });
      return (Array.isArray(results) ? results : []).map((item) => ({
        results: (item?.results ?? []) as T[],
        success: true,
        meta: metaOf(item?.meta),
      }));
    },
  };

  return database as unknown as D1Database;
}

/* ------------------------------------------------------- 账号级的库管理 API */

export interface RemoteDatabaseInfo {
  uuid: string;
  name: string;
  /** 库的已用空间（字节）；Cloudflare 偶尔不返回，取不到就是 null */
  fileSize: number | null;
  numTables: number | null;
  createdAt: string | null;
}

function infoFrom(raw: Record<string, unknown>): RemoteDatabaseInfo {
  const fileSize = Number(raw.file_size ?? NaN);
  const numTables = Number(raw.num_tables ?? NaN);
  return {
    uuid: String(raw.uuid ?? ''),
    name: String(raw.name ?? ''),
    fileSize: Number.isFinite(fileSize) ? fileSize : null,
    numTables: Number.isFinite(numTables) ? numTables : null,
    createdAt: typeof raw.created_at === 'string' ? raw.created_at : null,
  };
}

/** 查一个库的信息（用量看 `fileSize`）。 */
export async function fetchRemoteDatabaseInfo(
  credentials: D1Credentials,
  databaseId: string,
): Promise<RemoteDatabaseInfo> {
  const result = await callApi<Record<string, unknown>>(
    credentials,
    `/accounts/${credentials.accountId}/d1/database/${encodeURIComponent(databaseId)}`,
  );
  return infoFrom(result ?? {});
}

/** 列出账号下的所有 D1 库（管理员页面上挑现成的库挂载用）。 */
export async function listRemoteDatabases(credentials: D1Credentials): Promise<RemoteDatabaseInfo[]> {
  const result = await callApi<unknown>(credentials, `/accounts/${credentials.accountId}/d1/database`);
  const rows = Array.isArray(result)
    ? result
    : ((result as { databases?: unknown[] } | null)?.databases ?? []);
  return rows.map((row) => infoFrom((row ?? {}) as Record<string, unknown>));
}

/** 新建一个 D1 库，返回它的 uuid 与名称。 */
export async function createRemoteDatabase(
  credentials: D1Credentials,
  name: string,
): Promise<RemoteDatabaseInfo> {
  const result = await callApi<Record<string, unknown>>(
    credentials,
    `/accounts/${credentials.accountId}/d1/database`,
    { method: 'POST', body: JSON.stringify({ name }) },
  );
  const info = infoFrom(result ?? {});
  if (!info.uuid) throw new HttpError(502, 'd1_api_error', '新建 D1 库成功但没拿到 database_id');
  return info;
}

/**
 * 在一个库里按顺序执行一批 SQL 语句（分批下发，避免一次请求体过大）。
 * 建库脚本写的是 `CREATE TABLE IF NOT EXISTS`，所以重复执行是安全的。
 */
export async function applySqlStatements(
  database: D1Database,
  statements: readonly string[],
  batchSize = 10,
): Promise<void> {
  for (let index = 0; index < statements.length; index += batchSize) {
    const slice = statements.slice(index, index + batchSize);
    await database.batch(slice.map((sql) => database.prepare(sql)));
  }
}
