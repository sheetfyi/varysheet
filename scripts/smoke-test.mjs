#!/usr/bin/env node
/**
 * End-to-end smoke test for Varysheet.
 *
 * Runs against a live Worker - either `npm run dev` / `npm run preview`
 * (http://127.0.0.1:8787) or a deployed URL:
 *
 *   node scripts/smoke-test.mjs
 *   BASE_URL=https://varysheet.example.workers.dev node scripts/smoke-test.mjs
 *
 * It registers throw-away accounts and walks the critical path: two-step
 * signup (email code) -> session -> create table -> add field -> records
 * (create/update/duplicate/delete) -> views -> share links -> public read +
 * edit -> members -> notes + @mention inbox -> view invites (邀请未注册邮箱)
 * -> password change -> admin panel (含批量删除账号) -> file upload ->
 * capacity limits (记录数 / 附件到上限后只拦增长) ->
 * cleanup. Exit code is 1 when any check fails.
 *
 * Signup needs the 6-digit code that the API emails out. To keep this runnable
 * unattended, `POST /api/auth/register` echoes it back as `devCode` whenever
 * RESEND_API_KEY is missing or the recipient domain is listed in
 * AUTH_ECHO_CODE_DOMAINS (example.com & co.), and that is what this script
 * uses. Point it at a target that really sends email to a non-test domain and
 * the signup section fails fast with an explanation.
 *
 * The admin section signs in with ADMIN_EMAIL / ADMIN_PASSWORD (defaults below
 * match the throw-away admin that CI writes into .dev.vars). When those
 * credentials do not exist on the target, the admin checks are skipped - not
 * failed - so the script stays usable against production. The one destructive
 * admin check (resetting your own password) only runs for disposable test
 * admins on the reserved example.* domains; set SMOKE_ADMIN_SELF_RESET=1 to
 * force it.
 */
const BASE = (process.env.BASE_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const PASSWORD = process.env.SMOKE_PASSWORD ?? 'Smoke1test';
/** 同步注册后的新密码（改密码那一段用） */
const NEW_PASSWORD = process.env.SMOKE_NEW_PASSWORD ?? 'Smoke2test';
/** 超级管理员（本地 e2e 由 CI 写进 .dev.vars；线上没配就跳过管理员断言） */
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL ?? 'admin@example.com').trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'Smoke1admin';
/**
 * 「重置自己密码」那段会改密码并踢掉当前会话，所以只对用完即弃的测试管理员跑
 * （`@example.com|org|net` 这类保留测试域）。线上用真实 ADMIN_EMAIL 时自动跳过，
 * 免得把真实管理员的密码重置回 Secret 值、还顺手把他踢下线。
 * 想强制跑：SMOKE_ADMIN_SELF_RESET=1。
 */
const DISPOSABLE_ADMIN =
  /@example\.(com|org|net)$/i.test(ADMIN_EMAIL) || process.env.SMOKE_ADMIN_SELF_RESET === '1';

let cookie = '';
const checks = [];

function section(title) {
  console.log(`\n${title}`);
}

function check(name, ok, detail = '') {
  checks.push({ name, ok });
  if (ok) console.log(`  ok   ${name}${detail ? `  (${detail})` : ''}`);
  else console.error(`  FAIL ${name}${detail ? `  (${detail})` : ''}`);
  return ok;
}

function storeCookies(response) {
  const raw =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean);
  for (const item of raw) {
    const pair = String(item).split(';')[0];
    if (pair) cookie = pair;
  }
}

async function call(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.cookie !== false && cookie) headers.cookie = cookie;

  let body;
  if (options.form) {
    body = options.form;
  } else if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  const response = await fetch(`${BASE}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body,
    redirect: 'manual',
  });
  if (options.cookie !== false) storeCookies(response);

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { status: response.status, ok: response.ok, data, headers: response.headers };
}

async function waitForServer(attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return true;
    } catch {
      // server not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function textOf(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * 两步注册：`POST /api/auth/register` 只登记「待确认的注册」并发出 6 位确认码（202），
 * 把确认码填回 `/api/auth/register/verify` 才真正建账号（201，并自动登录）。
 * 响应的 `devCode` 只在「没配邮件服务 / 收件人是保留测试域」时出现，
 * 所以拿不到它时返回 `verified: null`，由调用方决定怎么报错。
 */
async function registerAccount({ email, name, password = PASSWORD, keepSession = false }) {
  const started = await call('/api/auth/register', {
    cookie: keepSession,
    method: 'POST',
    body: { email, password, name },
  });
  const code = typeof started.data?.devCode === 'string' ? started.data.devCode : '';
  const verified = code
    ? await call('/api/auth/register/verify', {
        cookie: keepSession,
        method: 'POST',
        body: { email, code },
      })
    : null;
  return { started, verified, code, email };
}

/** 与 `src/shared/fields.ts` 的 `CELL_EDIT_GRACE_MS` 保持一致：单元格「限制编辑」的 10 秒计时窗口 */
const CELL_EDIT_GRACE_MS = 10_000;

/** 等一次单元格计时窗口过期（多留 1.2 秒余量，避免边界抖动） */
function waitForGraceWindow() {
  return new Promise((resolve) => setTimeout(resolve, CELL_EDIT_GRACE_MS + 1_200));
}

async function main() {
  section(`Varysheet smoke test -> ${BASE}`);
  const alive = await waitForServer();
  if (!check('worker reachable (/api/health)', alive)) {
    console.error('\nStart the worker first: npm run dev');
    process.exitCode = 1;
    return;
  }

  const health = await call('/api/health');
  check('health payload', health.data?.ok === true, `${health.data?.app ?? ''}`);

  // ---------------------------------------------------------------- account
  section('account');
  const email = `smoke+${Date.now()}@example.com`;

  // 第一步：只提交注册信息 -> 202 + 确认码（保留测试域会回显在 devCode 里）
  const pending = await call('/api/auth/register', {
    method: 'POST',
    body: { email, password: PASSWORD, name: 'Smoke Tester' },
  });
  if (pending.status === 403) console.error('   (signup is disabled: ALLOW_SIGNUP="false")');
  check(
    'register asks for an email code',
    pending.status === 202 && pending.data?.pending === true,
    `status=${pending.status}`,
  );
  check(
    'signup code has a sane TTL',
    Number(pending.data?.ttlMinutes) >= 1 && Number(pending.data?.expiresInSeconds) > 0,
    `ttl=${pending.data?.ttlMinutes}min`,
  );
  if (!check('signup code is echoed for reserved test domains', /^\d{6}$/.test(String(pending.data?.devCode ?? '')), `devCode=${pending.data?.devCode ?? ''}`)) {
    console.error('   (the API did not echo the code: use a reserved test domain, or set AUTH_ECHO_CODE_DOMAINS on the target)');
    process.exitCode = 1;
    return;
  }

  // 确认之前这个邮箱还不能登录，users 表里也不该有它
  const unconfirmed = await call('/api/auth/login', {
    cookie: false,
    method: 'POST',
    body: { email, password: PASSWORD },
  });
  check('an unconfirmed signup cannot log in', unconfirmed.status === 401, `status=${unconfirmed.status}`);

  // 同一邮箱 60 秒内重复提交会被限流
  const tooSoon = await call('/api/auth/register', {
    cookie: false,
    method: 'POST',
    body: { email, password: PASSWORD, name: 'Smoke Tester' },
  });
  check('signup is throttled (60s cooldown)', tooSoon.status === 429, `status=${tooSoon.status}`);

  const wrongCode = await call('/api/auth/register/verify', {
    cookie: false,
    method: 'POST',
    body: { email, code: pending.data.devCode === '000000' ? '111111' : '000000' },
  });
  check(
    'a wrong code is rejected',
    wrongCode.status === 400 && wrongCode.data?.error?.code === 'code_mismatch',
    `status=${wrongCode.status} code=${wrongCode.data?.error?.code ?? ''}`,
  );

  const registered = await call('/api/auth/register/verify', {
    method: 'POST',
    body: { email, code: pending.data.devCode },
  });
  if (!check('register', registered.status === 201 && registered.data?.user?.email === email, `status=${registered.status}`)) {
    process.exitCode = 1;
    return;
  }
  check('signup confirms the email', registered.data?.emailVerified === true);

  const replayed = await call('/api/auth/register/verify', {
    method: 'POST',
    body: { email, code: pending.data.devCode },
  });
  check('a used code cannot be replayed', replayed.status === 400, `status=${replayed.status}`);

  const takenEmail = await call('/api/auth/register', {
    method: 'POST',
    body: { email, password: PASSWORD, name: 'Copy Cat' },
  });
  check('a registered email cannot sign up again', takenEmail.status === 409, `status=${takenEmail.status}`);

  const session = await call('/api/session');
  const starterCount = session.data?.databases?.length ?? 0;
  check('session carries the new user', session.data?.user?.email === email);
  check('session exposes the admin flag', registered.data?.user?.isAdmin === false);
  // 新账号从空白开始：不再自动生成「我的第一个表格」
  check('a new account has no starter table', starterCount === 0, `${starterCount} table(s)`);
  check('session exposes app meta', typeof session.data?.appName === 'string' && typeof session.data?.maxUploadMb === 'number');

  // 表格名额：新账号默认 0 个（原来送 1 个基础表格，已取消）。后面的段落都要建表，
  // 这里先买一批基础名额 + 1 个专业名额（主测试表是专业表格），免得每段都撞 403。
  const freshQuota = await call('/api/quota');
  check(
    'a new account gets no free table slots',
    freshQuota.status === 200 &&
      freshQuota.data?.quota?.basic?.total === 0 &&
      freshQuota.data?.quota?.basic?.remaining === 0 &&
      freshQuota.data?.quota?.pro?.remaining === 0,
    `basic=${JSON.stringify(freshQuota.data?.quota?.basic)} pro=${JSON.stringify(freshQuota.data?.quota?.pro)}`,
  );
  const bootstrapSlots = await call('/api/quota/purchases', {
    method: 'POST',
    body: { kind: 'basic', count: 10 },
  });
  check(
    'buying basic table slots works out of the box',
    bootstrapSlots.status === 201 &&
      bootstrapSlots.data?.purchase?.kind === 'basic' &&
      bootstrapSlots.data?.purchase?.count === 10 &&
      bootstrapSlots.data?.quota?.basic?.purchased === 10 &&
      bootstrapSlots.data?.quota?.basic?.remaining === 10,
    `purchased=${bootstrapSlots.data?.quota?.basic?.purchased} remaining=${bootstrapSlots.data?.quota?.basic?.remaining}`,
  );
  // 主测试表是专业表格，再买 1 个专业名额（「名额不够」的 403 在 table quota 一段验）
  const bootstrapPro = await call('/api/quota/purchases', { method: 'POST', body: { kind: 'pro', count: 1 } });
  check(
    'buying pro table slots works out of the box',
    bootstrapPro.status === 201 &&
      bootstrapPro.data?.quota?.pro?.purchased === 1 &&
      bootstrapPro.data?.quota?.pro?.remaining === 1,
    `purchased=${bootstrapPro.data?.quota?.pro?.purchased} remaining=${bootstrapPro.data?.quota?.pro?.remaining}`,
  );

  // ------------------------------- 会话兜底：Cookie 存不下来的手机浏览器（tokenInBody）
  section('session fallback (tokenInBody + Authorization)');
  const bearerEmail = `smoke+bearer+${Date.now()}@example.com`;
  const bearerAccount = await registerAccount({ email: bearerEmail, name: 'Bearer' });
  check(
    'register without cookie still works',
    bearerAccount.verified?.status === 201,
    `status=${bearerAccount.verified?.status ?? 'n/a'}`,
  );
  check('a normal login keeps the token out of the body', bearerAccount.verified?.data?.session === undefined);
  // 两个账号用同一个密码，这里只校验「不带 tokenInBody 时不下发令牌」
  const plainLogin = await call('/api/auth/login', {
    cookie: false,
    method: 'POST',
    body: { email, password: PASSWORD },
  });
  check('login (no tokenInBody) returns no session token', plainLogin.data?.session === undefined);
  check('login still sets the session cookie', /cn_session=/.test(plainLogin.headers.get('set-cookie') ?? ''));

  const tokenLogin = await call('/api/auth/login', {
    cookie: false,
    method: 'POST',
    body: { email, password: PASSWORD, tokenInBody: true },
  });
  const bearerToken = tokenLogin.data?.session?.token;
  check(
    'login with tokenInBody returns a session token',
    typeof bearerToken === 'string' && bearerToken.length > 20 && typeof tokenLogin.data?.session?.expiresAt === 'number',
  );

  const bearerSession = await call('/api/session', {
    cookie: false,
    headers: { authorization: `Bearer ${bearerToken}` },
  });
  check(
    'Authorization: Bearer alone authenticates /api/session',
    bearerSession.status === 200 && bearerSession.data?.user?.email === email,
    `status=${bearerSession.status}`,
  );

  const bogusSession = await call('/api/session', { cookie: false, headers: { authorization: 'Bearer not-a-real-token' } });
  check(
    'a bogus bearer token is treated as signed out',
    bogusSession.status === 200 && bogusSession.data?.user === null,
    `status=${bogusSession.status}`,
  );

  const bearerLogout = await call('/api/auth/logout', {
    cookie: false,
    headers: { authorization: `Bearer ${bearerToken}` },
    method: 'POST',
  });
  check('logout works with a bearer token', bearerLogout.status === 200 && bearerLogout.data?.ok === true);
  const bearerAfterLogout = await call('/api/session', {
    cookie: false,
    headers: { authorization: `Bearer ${bearerToken}` },
  });
  check('the bearer token is revoked by logout', bearerAfterLogout.data?.user === null);

  // ------------------------------------------------------------- table + fields
  section('tables and fields');
  // 这张主测试表用**专业表格**：后面几段会往它上面加 6 个视图、十个左右字段，
  // 基础表格的 3 视图 / 10 列上限放不下（基础表格的上限在「table quota」一段专门验证）。
  const created = await call('/api/databases', {
    method: 'POST',
    body: { name: 'Smoke 表格', templateId: 'task', kind: 'pro' },
  });
  const databaseId = created.data?.id;
  if (!check('create table from template', created.status === 201 && Boolean(databaseId), `status=${created.status}`)) {
    process.exitCode = 1;
    return;
  }
  check('template fields materialised', (created.data?.properties?.length ?? 0) >= 4, `${created.data?.properties?.length ?? 0} fields`);
  check(
    'default view created',
    (created.data?.views ?? []).some((view) => view.type === 'table'),
    `${created.data?.views?.length ?? 0} view(s): ${(created.data?.views ?? []).map((view) => view.type).join('/')}`,
  );
  check('role is owner', created.data?.role === 'owner', textOf(created.data?.role));
  check('members include the owner', (created.data?.members?.length ?? 0) === 1);

  // 新建表格不再让用户挑模板：不传 templateId 时应当落成「空白表格」（只有一个「名称」字段）
  const blankTable = await call('/api/databases', { method: 'POST', body: { name: '空白表格' } });
  const blankFields = blankTable.data?.properties ?? [];
  check(
    'table created without templateId is blank',
    blankTable.status === 201 && blankFields.length === 1 && blankFields[0]?.name === '名称',
    `status=${blankTable.status} fields=${blankFields.map((property) => property.name).join('/')}`,
  );
  if (blankTable.data?.id) {
    const removedBlank = await call(`/api/databases/${blankTable.data.id}`, { method: 'DELETE' });
    check('cleanup the blank table', removedBlank.status === 200, `status=${removedBlank.status}`);
  }

  const titleProperty = (created.data.properties ?? []).find((property) => property.type === 'text');
  const statusProperty = (created.data.properties ?? []).find((property) => property.type === 'select');
  const checkProperty = (created.data.properties ?? []).find((property) => property.type === 'checkbox');
  // 任务模板里的「状态」是 status 类型字段：新建记录默认落到「录入中」
  const stateProperty = (created.data.properties ?? []).find((property) => property.type === 'status');

  const added = await call(`/api/databases/${databaseId}/properties`, {
    method: 'POST',
    body: { name: '数量', type: 'number', config: { format: 'plain', precision: 0 } },
  });
  const numberProperty = (added.data?.properties ?? []).find((property) => property.name === '数量');
  check('add number field', Boolean(numberProperty), `fields=${added.data?.properties?.length ?? 0}`);

  const renamed = await call(`/api/properties/${numberProperty?.id}`, {
    method: 'PATCH',
    body: { name: '数量(件)' },
  });
  check(
    'rename field',
    (renamed.data?.properties ?? []).some((property) => property.name === '数量(件)'),
  );
  check('field width persisted', (renamed.data?.properties ?? []).some((property) => property.width > 0));

  // ------------------------------------------------------------------ records
  section('records');
  const first = await call(`/api/databases/${databaseId}/records`, {
    method: 'POST',
    body: { values: { [titleProperty.id]: '第一条记录', [numberProperty?.id]: 3 } },
  });
  const firstId = first.data?.record?.id;
  check('create record', first.status === 201 && Boolean(firstId), `status=${first.status}`);

  const listed = await call(`/api/databases/${databaseId}/rows?limit=50`);
  check('list rows', listed.data?.total === 1 && listed.data?.rows?.length === 1, `total=${listed.data?.total}`);

  const patched = await call(`/api/records/${firstId}`, {
    method: 'PATCH',
    body: { values: { [titleProperty.id]: '第一条记录（改）', [numberProperty?.id]: 5 } },
  });
  check(
    'update record',
    patched.data?.record?.values?.[titleProperty.id] === '第一条记录（改）',
    textOf(patched.data?.record?.values?.[numberProperty?.id]),
  );

  const bulk = await call(`/api/databases/${databaseId}/records/bulk`, {
    method: 'POST',
    body: { records: [{ [titleProperty.id]: '批量 A' }, { [titleProperty.id]: '批量 B' }] },
  });
  check('bulk create', bulk.status === 201 && (bulk.data?.records?.length ?? 0) === 2, `total=${bulk.data?.total}`);
  if (statusProperty && checkProperty) {
    const statusOption = statusProperty.config?.options?.[0];
    const flags = await call(`/api/records/${firstId}`, {
      method: 'PATCH',
      body: { values: { [statusProperty.id]: statusOption?.name, [checkProperty.id]: true } },
    });
    const values = flags.data?.record?.values ?? {};
    check(
      'select + checkbox round-trip',
      values[statusProperty.id]?.name === statusOption?.name && values[checkProperty.id] === true,
      textOf(values[checkProperty.id]),
    );
  }

  const duplicated = await call(`/api/databases/${databaseId}/records/duplicate`, {
    method: 'POST',
    body: { recordIds: [firstId] },
  });
  check('duplicate record', duplicated.status === 201 && (duplicated.data?.records?.length ?? 0) === 1);

  const bulkDelete = await call(`/api/databases/${databaseId}/records/delete`, {
    method: 'POST',
    body: { recordIds: (bulk.data?.records ?? []).map((record) => record.id) },
  });
  check('bulk delete', bulkDelete.data?.deleted === 2, `total=${bulkDelete.data?.total}`);

  // -------------------------------------------- 状态默认值（新建 → 录入中）
  section('status defaults (录入中)');
  const rowsWithStatus = await call(`/api/databases/${databaseId}/rows?limit=50`);
  const firstRow = (rowsWithStatus.data?.rows ?? []).find((row) => row.id === firstId);
  check(
    'new record defaults its status field to 录入中',
    Boolean(stateProperty) && firstRow?.values?.[stateProperty.id]?.name === '录入中',
    `status=${textOf(firstRow?.values?.[stateProperty?.id])}`,
  );

  const detailWithStatus = await call(`/api/databases/${databaseId}`);
  const statusWithDefault = (detailWithStatus.data?.properties ?? []).find((property) => property.id === stateProperty?.id);
  check(
    '「录入中」is appended to the status field options',
    (statusWithDefault?.config?.options ?? []).some((option) => option.name === '录入中'),
    `options=${textOf((statusWithDefault?.config?.options ?? []).map((option) => option.name))}`,
  );

  const explicitStatus = await call(`/api/databases/${databaseId}/records`, {
    method: 'POST',
    body: { values: { [titleProperty.id]: '显式状态', [stateProperty?.id]: '进行中' } },
  });
  check(
    'an explicitly provided status value is kept',
    explicitStatus.data?.record?.values?.[stateProperty?.id]?.name === '进行中',
    `status=${textOf(explicitStatus.data?.record?.values?.[stateProperty?.id])}`,
  );
  const explicitStatusId = explicitStatus.data?.record?.id;
  if (explicitStatusId) {
    const explicitRemoved = await call(`/api/records/${explicitStatusId}`, { method: 'DELETE' });
    check('cleanup the explicit status row', explicitRemoved.data?.ok === true, `status=${explicitRemoved.status}`);
  }

  // -------------------------------------------------------------------- views
  section('views');
  const baseView = (created.data.views ?? [])[0];
  const newView = await call(`/api/databases/${databaseId}/views`, {
    method: 'POST',
    body: { name: '看板', type: 'board', config: { groupBy: statusProperty?.id } },
  });
  const boardViewId = newView.data?.viewId;
  check('create board view', newView.status === 201 && Boolean(boardViewId), `status=${newView.status}`);

  // 前端「＋ 新建视图」不再传 type：后端应当默认落成表格视图
  const defaultTypeView = await call(`/api/databases/${databaseId}/views`, {
    method: 'POST',
    body: { name: '默认类型视图' },
  });
  const defaultTypeRow = (defaultTypeView.data?.views ?? []).find(
    (view) => view.id === defaultTypeView.data?.viewId,
  );
  check(
    'view created without a type stays a table view',
    defaultTypeView.status === 201 && defaultTypeRow?.type === 'table',
    `status=${defaultTypeView.status} type=${defaultTypeRow?.type}`,
  );
  if (defaultTypeRow) {
    const removedDefaultType = await call(`/api/views/${defaultTypeRow.id}`, { method: 'DELETE' });
    check('delete the default type view', removedDefaultType.status === 200, `status=${removedDefaultType.status}`);
  }

  // 「必须满足」块：第 1 条是块头（不写关系），第 2 条用 conjunction: 'and' 另起一块
  const patchedView = await call(`/api/views/${baseView.id}`, {
    method: 'PATCH',
    body: {
      config: {
        filters: {
          conjunction: 'and',
          conditions: [
            { propertyId: titleProperty.id, operator: 'contains', value: '第一条' },
            { propertyId: titleProperty.id, operator: 'is_not_empty', conjunction: 'and' },
          ],
        },
      },
    },
  });
  const savedConditions = patchedView.data?.views?.find((view) => view.id === baseView.id)?.config?.filters?.conditions ?? [];
  check('save view filters', savedConditions.length === 2, JSON.stringify(savedConditions));
  check(
    'save per-condition conjunction',
    savedConditions[0]?.conjunction === undefined && savedConditions[1]?.conjunction === 'and',
    JSON.stringify(savedConditions.map((condition) => condition.conjunction)),
  );

  // a view created from the "＋ 新建视图" form carries name + multi conditions + lock
  const lockedView = await call(`/api/databases/${databaseId}/views`, {
    method: 'POST',
    body: {
      name: '锁定视图',
      type: 'table',
      config: {
        filters: {
          conjunction: 'or',
          conditions: [
            { propertyId: titleProperty.id, operator: 'contains', value: '第一' },
            { propertyId: titleProperty.id, operator: 'is_not_empty', conjunction: 'or' },
          ],
        },
      },
      locked: true,
    },
  });
  const lockedViewId = lockedView.data?.viewId;
  const lockedRow = (lockedView.data?.views ?? []).find((view) => view.id === lockedViewId);
  check(
    'create locked view with multi-condition filters',
    lockedView.status === 201 &&
      lockedRow?.name === '锁定视图' &&
      lockedRow?.locked === true &&
      lockedRow?.config?.filters?.conjunction === 'or' &&
      lockedRow?.config?.filters?.conditions?.[1]?.conjunction === 'or' &&
      (lockedRow?.config?.filters?.conditions ?? []).length === 2,
    `status=${lockedView.status} locked=${lockedRow?.locked} conditions=${lockedRow?.config?.filters?.conditions?.length ?? 0}`,
  );

  const renameLocked = await call(`/api/views/${lockedViewId}`, { method: 'PATCH', body: { name: '不允许改名' } });
  check(
    'locked view rejects rename',
    renameLocked.status === 403,
    `status=${renameLocked.status} err=${renameLocked.data?.error?.message ?? ''}`,
  );

  const unlockView = await call(`/api/views/${lockedViewId}`, { method: 'PATCH', body: { locked: false } });
  const unlockedRow = (unlockView.data?.views ?? []).find((view) => view.id === lockedViewId);
  check('unlock view', unlockView.status === 200 && unlockedRow?.locked === false, `status=${unlockView.status}`);

  const deleteLocked = await call(`/api/views/${lockedViewId}`, { method: 'DELETE' });
  check(
    'delete the previously locked view',
    deleteLocked.status === 200 && (deleteLocked.data?.views ?? []).every((view) => view.id !== lockedViewId),
    `status=${deleteLocked.status}`,
  );

  // ----------------------------- 表级锁定已移除（locked 参数被忽略，结构始终可改）
  section('table lock removed');
  const ignoredLock = await call(`/api/databases/${databaseId}`, {
    method: 'PATCH',
    body: { locked: true },
  });
  check(
    'table lock parameter is ignored',
    ignoredLock.status === 200 && ignoredLock.data?.locked === false,
    `status=${ignoredLock.status} locked=${ignoredLock.data?.locked}`,
  );

  const probeField = await call(`/api/databases/${databaseId}/properties`, {
    method: 'POST',
    body: { name: '锁定参数已忽略', type: 'text' },
  });
  check(
    'structure stays editable after locked=true',
    probeField.status === 201,
    `status=${probeField.status}`,
  );

  const probeProperty = (probeField.data?.properties ?? []).find(
    (property) => property.name === '锁定参数已忽略',
  );
  const removedProbe = probeProperty
    ? await call(`/api/properties/${probeProperty.id}`, { method: 'DELETE' })
    : null;
  check('cleanup the probe field', removedProbe === null || removedProbe.status === 200, `status=${removedProbe?.status}`);

  const viewsBefore = (patchedView.data?.views ?? []).length;
  const removedView = await call(`/api/views/${boardViewId}`, { method: 'DELETE' });
  check(
    'delete view',
    Array.isArray(removedView.data?.views) &&
      removedView.data.views.length === viewsBefore - 1 &&
      removedView.data.views.every((view) => view.id !== boardViewId),
    `viewId=${boardViewId} views=${viewsBefore}->${removedView.data?.views?.length ?? 0} status=${removedView.status} err=${removedView.data?.error?.message ?? ''}`,
  );

  // ------------------------------------------------ 字段锁定 + 列移动
  section('field lock + column order');
  const lockedField = await call(`/api/properties/${titleProperty.id}`, {
    method: 'PATCH',
    body: { locked: true },
  });
  check(
    'lock a field',
    lockedField.status === 200 &&
      lockedField.data?.property?.locked === true &&
      (lockedField.data?.properties ?? []).some(
        (property) => property.id === titleProperty.id && property.locked === true,
      ),
    `status=${lockedField.status}`,
  );

  const blockedCell = await call(`/api/records/${firstId}`, {
    method: 'PATCH',
    body: { values: { [titleProperty.id]: '锁定后不应写入' } },
  });
  check('locked field refuses a cell update', blockedCell.status === 400, `status=${blockedCell.status}`);

  const afterBlocked = await call(`/api/databases/${databaseId}/rows?limit=50`);
  check(
    'locked field keeps its stored value',
    (afterBlocked.data?.rows ?? []).find((row) => row.id === firstId)?.values?.[titleProperty.id] ===
      '第一条记录（改）',
  );

  const otherCell = await call(`/api/records/${firstId}`, {
    method: 'PATCH',
    body: { values: { [numberProperty?.id]: 11 } },
  });
  check('unlocked fields stay editable', otherCell.status === 200, `status=${otherCell.status}`);

  const lockedForm = new FormData();
  lockedForm.set('file', new Blob(['locked'], { type: 'text/plain' }), 'locked.txt');
  lockedForm.set('databaseId', databaseId);
  lockedForm.set('recordId', firstId);
  lockedForm.set('propertyId', titleProperty.id);
  const blockedUpload = await call('/api/files', { method: 'POST', form: lockedForm });
  check('locked field refuses uploads', blockedUpload.status === 403, `status=${blockedUpload.status}`);

  // ← / →：交换相邻两列的 position 即可调整顺序
  const [firstField, secondField] = renamed.data?.properties ?? [];
  await call(`/api/properties/${firstField.id}`, { method: 'PATCH', body: { position: secondField.position } });
  const swapped = await call(`/api/properties/${secondField.id}`, {
    method: 'PATCH',
    body: { position: firstField.position },
  });
  const swappedOrder = (swapped.data?.properties ?? []).map((property) => property.id);
  check(
    'move column left/right swaps the order',
    swappedOrder[0] === secondField.id && swappedOrder[1] === firstField.id,
    swappedOrder.slice(0, 2).join(' -> '),
  );

  const unlockedField = await call(`/api/properties/${titleProperty.id}`, {
    method: 'PATCH',
    body: { locked: false },
  });
  const restored = await call(`/api/records/${firstId}`, {
    method: 'PATCH',
    body: { values: { [titleProperty.id]: '第一条记录（改）' } },
  });
  check(
    'unlock a field restores editing',
    unlockedField.data?.property?.locked === false && restored.status === 200,
    `status=${restored.status}`,
  );

  // ------------------------------------------------------------ sharing
  section('sharing');
  const shareView = await call(`/api/databases/${databaseId}/shares`, {
    method: 'POST',
    body: { permission: 'view', expiresInDays: 7 },
  });
  const viewToken = (shareView.data?.shares ?? [])[0]?.token;
  check('create read-only link', Boolean(viewToken), `shares=${shareView.data?.shares?.length ?? 0}`);

  const shareEdit = await call(`/api/databases/${databaseId}/shares`, {
    method: 'POST',
    body: { permission: 'edit', limitEdits: true },
  });
  const editShareRow = (shareEdit.data?.shares ?? []).find((share) => share.permission === 'edit');
  const editToken = editShareRow?.token;
  check(
    'create editable link with 限制编辑',
    Boolean(editToken) && editShareRow?.limitEdits === true,
    `limitEdits=${editShareRow?.limitEdits}`,
  );

  const publicRead = await call(`/api/public/${viewToken}`, { cookie: false });
  check(
    'public read without a session',
    publicRead.data?.database?.permission === 'view' &&
      publicRead.data?.database?.limitEdits === false &&
      (publicRead.data?.rows?.length ?? 0) >= 1,
    `rows=${publicRead.data?.rows?.length ?? 0} limitEdits=${publicRead.data?.database?.limitEdits}`,
  );

  const publicWrite = await call(`/api/public/${viewToken}/records`, {
    method: 'POST',
    cookie: false,
    body: { values: { [titleProperty.id]: '只读链接不应写入' } },
  });
  check('read-only link refuses writes', publicWrite.status === 403, `status=${publicWrite.status}`);

  const publicEdit = await call(`/api/public/${editToken}/records`, {
    method: 'POST',
    cookie: false,
    body: { values: { [titleProperty.id]: '来自公开链接' } },
  });
  const publicRecordId = publicEdit.data?.record?.id;
  check('editable link creates a row', publicEdit.status === 201 && Boolean(publicRecordId), `status=${publicEdit.status}`);

  const publicPatch = await call(`/api/public/${editToken}/records/${publicRecordId}`, {
    method: 'PATCH',
    cookie: false,
    body: { values: { [titleProperty.id]: '公开链接已更新' } },
  });
  check('editable link updates a row', publicPatch.data?.record?.values?.[titleProperty.id] === '公开链接已更新');

  // 输入次数不限：第一次保存成功后的 10 秒内想改多少遍都行（计时窗口）
  const publicSecondEdit = await call(`/api/public/${editToken}/records/${publicRecordId}`, {
    method: 'PATCH',
    cookie: false,
    body: { values: { [titleProperty.id]: '窗口内改回来' } },
  });
  check(
    'a cell stays editable inside the 10s grace window',
    publicSecondEdit.status === 200 &&
      publicSecondEdit.data?.record?.values?.[titleProperty.id] === '窗口内改回来',
    `status=${publicSecondEdit.status} err=${publicSecondEdit.data?.error?.message ?? ''}`,
  );
  check(
    'the PATCH payload opens a window instead of locking the cell',
    Number(publicSecondEdit.data?.cellEditGrace?.[`${publicRecordId}:${titleProperty.id}`]) > Date.now() &&
      (publicSecondEdit.data?.lockedCells ?? []).length === 0,
    `cellEditGrace=${textOf(publicSecondEdit.data?.cellEditGrace)} lockedCells=${textOf(publicSecondEdit.data?.lockedCells)}`,
  );

  // 每次保存都把窗口重新起算：最后一次保存之后等满 10 秒再改就该被拒
  await waitForGraceWindow();
  const publicAfterGraceEdit = await call(`/api/public/${editToken}/records/${publicRecordId}`, {
    method: 'PATCH',
    cookie: false,
    body: { values: { [titleProperty.id]: '窗口已过，应被拒绝' } },
  });
  check(
    'once the grace window closes the same cell is refused',
    publicAfterGraceEdit.status === 403,
    `status=${publicAfterGraceEdit.status} err=${publicAfterGraceEdit.data?.error?.message ?? ''}`,
  );

  // 提交的值没变不算改动（这一格已经锁上了也算 noop 保存，一样放行）
  const publicNoopEdit = await call(`/api/public/${editToken}/records/${publicRecordId}`, {
    method: 'PATCH',
    cookie: false,
    body: { values: { [titleProperty.id]: '窗口内改回来' } },
  });
  check(
    'an unchanged value is a noop even on a locked cell',
    publicNoopEdit.status === 200,
    `status=${publicNoopEdit.status} err=${publicNoopEdit.data?.error?.message ?? ''}`,
  );

  const publicOtherCell = await call(`/api/public/${editToken}/records/${publicRecordId}`, {
    method: 'PATCH',
    cookie: false,
    body: { values: { [numberProperty?.id]: 11 } },
  });
  check(
    'a different cell is still editable',
    publicOtherCell.status === 200 && publicOtherCell.data?.record?.values?.[numberProperty?.id] === 11,
    `status=${publicOtherCell.status} err=${publicOtherCell.data?.error?.message ?? ''}`,
  );

  const publicAfterEdits = await call(`/api/public/${editToken}`, { cookie: false });
  const lockedAfterEdits = publicAfterEdits.data?.lockedCells ?? [];
  const graceAfterEdits = publicAfterEdits.data?.cellEditGrace ?? {};
  check(
    'the public payload locks the spent cell and keeps the fresh one in its window',
    lockedAfterEdits.includes(`${publicRecordId}:${titleProperty.id}`) &&
      Number(graceAfterEdits[`${publicRecordId}:${numberProperty?.id}`]) > Date.now() &&
      !Object.keys(graceAfterEdits).includes(`${publicRecordId}:${titleProperty.id}`),
    `lockedCells=${textOf(lockedAfterEdits)} cellEditGrace=${textOf(Object.keys(graceAfterEdits))}`,
  );

  // 已经锁上的格子：连「清空」都不允许（清空会让它重新变成可编辑，等于绕过限制）
  const clearLockedCell = await call(`/api/public/${editToken}/records/${publicRecordId}`, {
    method: 'PATCH',
    cookie: false,
    body: { values: { [titleProperty.id]: null } },
  });
  check(
    'a locked cell cannot even be cleared',
    clearLockedCell.status === 403,
    `status=${clearLockedCell.status} err=${clearLockedCell.data?.error?.message ?? ''}`,
  );

  // 输入次数不限：同一个格子（还在窗口内）可以反复改，每次保存都把窗口重新起算
  const repeatStatuses = [];
  for (let round = 1; round <= 3; round += 1) {
    // eslint-disable-next-line no-await-in-loop
    const repeat = await call(`/api/public/${editToken}/records/${publicRecordId}`, {
      method: 'PATCH',
      cookie: false,
      body: { values: { [numberProperty?.id]: round } },
    });
    repeatStatuses.push(repeat.status);
    if (round === 3) {
      check(
        'the last save of a repeatedly edited cell opens a fresh window',
        repeat.status === 200 &&
          repeat.data?.record?.values?.[numberProperty?.id] === 3 &&
          Number(repeat.data?.cellEditGrace?.[`${publicRecordId}:${numberProperty?.id}`]) > Date.now() &&
          !(repeat.data?.lockedCells ?? []).includes(`${publicRecordId}:${numberProperty?.id}`),
        `status=${repeat.status} cellEditGrace=${textOf(repeat.data?.cellEditGrace)} lockedCells=${textOf(repeat.data?.lockedCells)}`,
      );
    }
  }
  check(
    'a limited cell may be edited repeatedly inside the window',
    repeatStatuses.length === 3 && repeatStatuses.every((status) => status === 200),
    `statuses=${repeatStatuses.join(',')}`,
  );

  // 窗口内把内容清空 = 没输入过：记账被删掉（这一格不再出现在任何锁定列表里）
  const clearCellInsideWindow = await call(`/api/public/${editToken}/records/${publicRecordId}`, {
    method: 'PATCH',
    cookie: false,
    body: { values: { [numberProperty?.id]: null } },
  });
  check(
    'clearing the cell inside the window is allowed',
    clearCellInsideWindow.status === 200,
    `status=${clearCellInsideWindow.status} err=${clearCellInsideWindow.data?.error?.message ?? ''}`,
  );
  const afterClear = await call(`/api/public/${editToken}`, { cookie: false });
  check(
    'a cleared cell drops its bookkeeping entirely',
    !Object.keys(afterClear.data?.cellEditGrace ?? {}).includes(`${publicRecordId}:${numberProperty?.id}`) &&
      !(afterClear.data?.lockedCells ?? []).includes(`${publicRecordId}:${numberProperty?.id}`),
    `cellEditGrace=${textOf(Object.keys(afterClear.data?.cellEditGrace ?? {}))} lockedCells=${textOf(afterClear.data?.lockedCells)}`,
  );

  // 清空之后马上重新输入也不受限：窗口从这一刻重新开始
  const refillCell = await call(`/api/public/${editToken}/records/${publicRecordId}`, {
    method: 'PATCH',
    cookie: false,
    body: { values: { [numberProperty?.id]: 42 } },
  });
  check(
    'a cell cleared inside the window can be filled again',
    refillCell.status === 200 && refillCell.data?.record?.values?.[numberProperty?.id] === 42,
    `status=${refillCell.status} err=${refillCell.data?.error?.message ?? ''}`,
  );
  check(
    'the refilled cell starts a new window instead of locking',
    Number(refillCell.data?.cellEditGrace?.[`${publicRecordId}:${numberProperty?.id}`]) > Date.now() &&
      !(refillCell.data?.lockedCells ?? []).includes(`${publicRecordId}:${numberProperty?.id}`),
    `cellEditGrace=${textOf(refillCell.data?.cellEditGrace)} lockedCells=${textOf(refillCell.data?.lockedCells)}`,
  );

  // 没勾选「限制编辑」的可编辑链接：同一个格子可以反复修改，也不会有锁定标记
  const shareIdsBeforeFree = new Set((shareEdit.data?.shares ?? []).map((item) => item.id));
  const freeLink = await call(`/api/databases/${databaseId}/shares`, {
    method: 'POST',
    body: { permission: 'edit' },
  });
  const freeShare = (freeLink.data?.shares ?? []).find((item) => !shareIdsBeforeFree.has(item.id));
  check(
    'an editable link without 限制编辑',
    freeLink.status === 201 && freeShare?.permission === 'edit' && freeShare?.limitEdits === false,
    `limitEdits=${freeShare?.limitEdits}`,
  );

  const freeFirstEdit = await call(`/api/public/${freeShare?.token}/records/${publicRecordId}`, {
    method: 'PATCH',
    cookie: false,
    body: { values: { [titleProperty.id]: '不限制编辑（第一次）' } },
  });
  const freeSecondEdit = await call(`/api/public/${freeShare?.token}/records/${publicRecordId}`, {
    method: 'PATCH',
    cookie: false,
    body: { values: { [titleProperty.id]: '不限制编辑（第二次）' } },
  });
  check(
    'the same cell stays editable when 限制编辑 is off',
    freeFirstEdit.status === 200 &&
      freeSecondEdit.status === 200 &&
      freeSecondEdit.data?.record?.values?.[titleProperty.id] === '不限制编辑（第二次）',
    `first=${freeFirstEdit.status} second=${freeSecondEdit.status} err=${freeSecondEdit.data?.error?.message ?? ''}`,
  );

  const freePayload = await call(`/api/public/${freeShare?.token}`, { cookie: false });
  check(
    'an unlimited edit link reports no locked cells and no grace window',
    freePayload.data?.database?.limitEdits === false &&
      (freePayload.data?.lockedCells ?? []).length === 0 &&
      Object.keys(freePayload.data?.cellEditGrace ?? {}).length === 0,
    `limitEdits=${freePayload.data?.database?.limitEdits} lockedCells=${textOf(freePayload.data?.lockedCells)} cellEditGrace=${textOf(freePayload.data?.cellEditGrace)}`,
  );

  if (freeShare) {
    const removedFreeLink = await call(`/api/shares/${freeShare.id}`, { method: 'DELETE' });
    check(
      'cleanup the unlimited edit link',
      removedFreeLink.status === 200 && (removedFreeLink.data?.shares ?? []).every((item) => item.id !== freeShare.id),
      `status=${removedFreeLink.status}`,
    );
  }

  // 换一条编辑链接：同一个格子重新开始计时（记账按链接区分归属）
  const shareIdsBefore = new Set((shareEdit.data?.shares ?? []).map((item) => item.id));
  if (freeShare) shareIdsBefore.add(freeShare.id);
  const shareEdit2 = await call(`/api/databases/${databaseId}/shares`, {
    method: 'POST',
    body: { permission: 'edit', limitEdits: true },
  });
  const editShare2 = (shareEdit2.data?.shares ?? []).find((item) => !shareIdsBefore.has(item.id));
  const secondLinkEdit = await call(`/api/public/${editShare2?.token}/records/${publicRecordId}`, {
    method: 'PATCH',
    cookie: false,
    body: { values: { [titleProperty.id]: '另一条链接还能改一次' } },
  });
  check(
    'another edit link tracks the same cell on its own',
    secondLinkEdit.status === 200,
    `status=${secondLinkEdit.status} err=${secondLinkEdit.data?.error?.message ?? ''}`,
  );

  // 表格所有者不受「限制编辑」约束，也看不到锁定标记
  const ownerEditsSpentCell = await call(`/api/records/${publicRecordId}`, {
    method: 'PATCH',
    body: { values: { [titleProperty.id]: '所有者不受限制' } },
  });
  check(
    'the owner may edit a spent cell',
    ownerEditsSpentCell.status === 200 && ownerEditsSpentCell.data?.record?.values?.[titleProperty.id] === '所有者不受限制',
    `status=${ownerEditsSpentCell.status}`,
  );
  const ownerRows = await call(`/api/databases/${databaseId}/rows?limit=50`);
  check(
    'the owner sees no locked cells',
    Array.isArray(ownerRows.data?.lockedCells) && ownerRows.data.lockedCells.length === 0,
    `lockedCells=${textOf(ownerRows.data?.lockedCells)}`,
  );

  if (editShare2) {
    const removedSecondLink = await call(`/api/shares/${editShare2.id}`, { method: 'DELETE' });
    check(
      'cleanup the second edit link',
      (removedSecondLink.data?.shares ?? []).length === 2,
      `shares=${removedSecondLink.data?.shares?.length ?? 0}`,
    );
  }

  const publicDelete = await call(`/api/public/${editToken}/records/${publicRecordId}`, {
    method: 'DELETE',
    cookie: false,
  });
  check('editable link deletes a row', publicDelete.data?.ok === true);

  const badToken = await call('/api/public/not-a-real-token', { cookie: false });
  check('unknown share token is rejected', badToken.status === 404, `status=${badToken.status}`);


  // ------------------------------------------------------------------ members
  section('members');
  // members can only be invited once they have an account, so create one first
  const memberEmail = `smoke-member+${Date.now()}@example.com`;
  const collaboratorSignup = await registerAccount({ email: memberEmail, name: 'Smoke Collaborator' });
  const collaborator = collaboratorSignup.verified;
  check(
    'second account for collaboration',
    collaborator?.status === 201 && collaborator.data?.user?.email === memberEmail,
    `status=${collaborator?.status ?? collaboratorSignup.started.status}`,
  );

  const invited = await call(`/api/databases/${databaseId}/members`, {
    method: 'POST',
    body: { email: memberEmail, role: 'viewer' },
  });
  const member = (invited.data?.members ?? []).find((item) => item.email === memberEmail);
  check(
    'invite member by email',
    invited.status === 200 && member?.role === 'viewer',
    `members=${invited.data?.members?.length ?? 0} err=${invited.data?.error?.message ?? ''}`,
  );

  const promoted = await call(`/api/members/${member?.id}`, { method: 'PATCH', body: { role: 'editor' } });
  check(
    'change member role',
    (promoted.data?.members ?? []).some((item) => item.email === memberEmail && item.role === 'editor'),
    `status=${promoted.status}`,
  );

  const ownerEntry = (promoted.data?.members ?? []).find((item) => item.role === 'owner');
  check('members list the owner', Boolean(ownerEntry));
  if (ownerEntry) {
    const ownerEdit = await call(`/api/members/${ownerEntry.id}`, { method: 'PATCH', body: { role: 'editor' } });
    check('owner role cannot be changed', ownerEdit.status === 400, `status=${ownerEdit.status}`);
  }

  // ------------------------------------------------ notes + @提醒私信（收件箱）
  section('notes + inbox');
  const notesMemberId = collaborator.data?.user?.id;
  const notesOwnerCookie = cookie;

  const anonNote = await call(`/api/records/${firstId}/notes`, {
    cookie: false,
    method: 'POST',
    body: { body: '匿名备注' },
  });
  check('anonymous visitors cannot add notes', anonNote.status === 401, `status=${anonNote.status}`);

  const mentioned = await call(`/api/records/${firstId}/notes`, {
    method: 'POST',
    body: { body: '这行数据请你确认一下 @Smoke Collaborator', mentions: [notesMemberId] },
  });
  const mentionedNote = (mentioned.data?.notes ?? []).find((note) => note.body.includes('@Smoke Collaborator'));
  check(
    'add a note with an @mention',
    mentioned.status === 201 &&
      mentionedNote?.authorName === 'Smoke Tester' &&
      mentionedNote?.mentions?.length === 1 &&
      mentionedNote.mentions[0].userId === notesMemberId,
    `status=${mentioned.status} notes=${mentioned.data?.notes?.length ?? 0} mentions=${mentionedNote?.mentions?.length ?? 0}`,
  );

  const selfNote = await call(`/api/records/${firstId}/notes`, {
    method: 'POST',
    body: { body: '只给自己看的备注 @Smoke Tester', mentions: [registered.data?.user?.id, 'user-not-here'] },
  });
  const selfNotes = selfNote.data?.notes ?? [];
  const selfNoteRow = selfNotes[selfNotes.length - 1];
  check(
    'nobody is messaged for @自己 / @表格外的人',
    selfNote.status === 201 && (selfNoteRow?.mentions ?? []).length === 0,
    `mentions=${selfNoteRow?.mentions?.length ?? 0}`,
  );
  check('notes come back with the record', selfNotes.length === 2, `notes=${selfNotes.length}`);

  const notesDetail = await call(`/api/databases/${databaseId}`);
  check(
    'database detail carries the notes',
    (notesDetail.data?.notes ?? []).some((note) => note.id === mentionedNote?.id),
    `notes=${notesDetail.data?.notes?.length ?? 0}`,
  );

  const notesRows = await call(`/api/databases/${databaseId}/rows?limit=50`);
  check(
    'paged rows carry the notes of their records',
    (notesRows.data?.notes ?? []).some((note) => note.id === mentionedNote?.id),
    `notes=${notesRows.data?.notes?.length ?? 0}`,
  );

  // 单条记录同步（记录卡片打开时刷新用）：一条记录 = 值 + 备注 + 已用掉的格子
  const recordDetail = (notesDetail.data?.rows ?? []).find((row) => row.id === firstId);
  const synced = await call(`/api/records/${firstId}`);
  check(
    'a single record can be synced on its own',
    synced.status === 200 &&
      synced.data?.record?.id === firstId &&
      synced.data?.record?.values?.[titleProperty.id] === recordDetail?.values?.[titleProperty.id] &&
      Array.isArray(synced.data?.lockedCells) &&
      synced.data.lockedCells.length === 0 &&
      (synced.data?.notes ?? []).some((note) => note.id === mentionedNote?.id),
    `status=${synced.status} notes=${synced.data?.notes?.length ?? 0}`,
  );

  const syncedMissing = await call('/api/records/record-does-not-exist');
  const syncedAnon = await call(`/api/records/${firstId}`, { cookie: false });
  check(
    'syncing a record needs a session and a real record',
    syncedMissing.status === 404 && syncedAnon.status === 401,
    `missing=${syncedMissing.status} anon=${syncedAnon.status}`,
  );

  // 备注只增不改：没有修改 / 删除备注的接口（路径存在但方法不允许）
  const editNote = await call(`/api/records/${firstId}/notes`, { method: 'PATCH', body: { body: '改一下' } });
  const dropNote = await call(`/api/records/${firstId}/notes`, { method: 'DELETE' });
  check(
    'notes cannot be edited or deleted',
    editNote.status === 405 && dropNote.status === 405,
    `patch=${editNote.status} delete=${dropNote.status}`,
  );

  const ownerInbox = await call('/api/inbox');
  check(
    'the author never messages themselves',
    ownerInbox.data?.unread === 0 && (ownerInbox.data?.messages ?? []).length === 0,
    `unread=${ownerInbox.data?.unread ?? 0}`,
  );

  await call('/api/auth/login', { method: 'POST', body: { email: memberEmail, password: PASSWORD } });
  const memberInbox = await call('/api/inbox');
  const inboxRow = (memberInbox.data?.messages ?? []).find((item) => item.noteId === mentionedNote?.id);
  const firstTitle = (notesDetail.data?.rows ?? []).find((row) => row.id === firstId)?.values?.[titleProperty.id];
  check(
    'the mentioned member gets an inbox message',
    memberInbox.status === 200 && memberInbox.data?.unread === 1 && Boolean(inboxRow),
    `unread=${memberInbox.data?.unread ?? 0} messages=${memberInbox.data?.messages?.length ?? 0}`,
  );
  check(
    'the inbox message points back at the record',
    inboxRow?.databaseId === databaseId &&
      inboxRow?.recordId === firstId &&
      inboxRow?.authorName === 'Smoke Tester' &&
      inboxRow?.recordTitle === firstTitle &&
      Boolean(inboxRow?.databaseName),
    `title=${textOf(inboxRow?.recordTitle ?? '')}`,
  );

  // 私信说的「有人 @ 了你」必须能在这条记录的同步结果里看到（这就是卡片点开时的内容）
  const memberSynced = await call(`/api/records/${firstId}`);
  check(
    'the mentioned member syncs the fresh note with the record',
    memberSynced.status === 200 &&
      (memberSynced.data?.notes ?? []).some((note) => note.id === mentionedNote?.id),
    `status=${memberSynced.status} notes=${memberSynced.data?.notes?.length ?? 0}`,
  );

  const anonInbox = await call('/api/inbox', { cookie: false });
  check('the inbox needs a session', anonInbox.status === 401, `status=${anonInbox.status}`);

  const consumed = await call(`/api/inbox/${inboxRow?.id}/read`, { method: 'POST' });
  check(
    'opening a message marks it read',
    consumed.status === 200 && consumed.data?.unread === 0,
    `unread=${consumed.data?.unread ?? ''}`,
  );
  const afterRead = await call('/api/inbox');
  check(
    'the inbox is empty once everything is read',
    afterRead.data?.unread === 0 && (afterRead.data?.messages ?? []).length === 0,
    `messages=${afterRead.data?.messages?.length ?? 0}`,
  );

  cookie = notesOwnerCookie;
  const notMine = await call(`/api/inbox/${inboxRow?.id}/read`, { method: 'POST' });
  check('another account cannot read my message', notMine.status === 404, `status=${notMine.status}`);

  const removedMember = await call(`/api/members/${member?.id}`, { method: 'DELETE' });
  check(
    'remove member',
    removedMember.data?.members?.length === 1 && (removedMember.data?.members ?? []).every((item) => item.role === 'owner'),
    `members=${removedMember.data?.members?.length ?? 0}`,
  );

  const revoked = await call(`/api/shares/${shareView.data.shares[0].id}`, { method: 'DELETE' });
  check('revoke share link', Array.isArray(revoked.data?.shares) && revoked.data.shares.length === 1);

  // ------------------------------------------------------------- view shares
  section('view shares');
  const viewShare = await call(`/api/databases/${databaseId}/view-shares`, {
    method: 'POST',
    body: { viewId: baseView.id, email: memberEmail, role: 'viewer' },
  });
  const viewShareRow = (viewShare.data?.viewShares ?? []).find((item) => item.email === memberEmail);
  check(
    'share a single view with a member',
    viewShare.status === 201 &&
      viewShareRow?.viewId === baseView.id &&
      viewShareRow?.viewName === baseView.name &&
      viewShareRow?.role === 'viewer',
    `status=${viewShare.status} viewShares=${viewShare.data?.viewShares?.length ?? 0} err=${viewShare.data?.error?.message ?? ''}`,
  );

  const unknownViewShare = await call(`/api/databases/${databaseId}/view-shares`, {
    method: 'POST',
    body: { viewId: baseView.id, email: `nobody+${Date.now()}@example.com`, role: 'viewer' },
  });
  check('view share needs a registered account', unknownViewShare.status === 404, `status=${unknownViewShare.status}`);

  const missingViewShare = await call(`/api/databases/${databaseId}/view-shares`, {
    method: 'POST',
    body: { viewId: 'view-not-found', email: memberEmail, role: 'viewer' },
  });
  check('view share needs an existing view', missingViewShare.status === 404, `status=${missingViewShare.status}`);

  const detailWithViewShare = await call(`/api/databases/${databaseId}`);
  check(
    'database detail exposes view shares',
    (detailWithViewShare.data?.viewShares ?? []).some((item) => item.id === viewShareRow?.id),
    `viewShares=${detailWithViewShare.data?.viewShares?.length ?? 0}`,
  );

  // 可 @ 名单覆盖「定向分享的访客」：所有者能 @ 到被分享者（哪怕对方不是表格成员）
  const mentionables = detailWithViewShare.data?.mentionables ?? [];
  check(
    'the @ candidate list covers view-share guests',
    mentionables.some((item) => item.userId === notesMemberId),
    `mentionables=${mentionables.length}`,
  );

  const ownerToGuest = await call(`/api/records/${firstId}/notes`, {
    method: 'POST',
    body: { body: '定向分享的视图也请看一下 @Smoke Collaborator', mentions: [notesMemberId] },
  });
  const ownerToGuestNote = (ownerToGuest.data?.notes ?? []).find((note) =>
    note.body.startsWith('定向分享的视图也请看一下'),
  );
  check(
    'the owner can @ a view-share guest',
    ownerToGuest.status === 201 &&
      (ownerToGuestNote?.mentions ?? []).some((item) => item.userId === notesMemberId),
    `status=${ownerToGuest.status} mentions=${ownerToGuestNote?.mentions?.length ?? 0}`,
  );

  const removeViewShare = await call(`/api/view-shares/${viewShareRow?.id}`, { method: 'DELETE' });
  check(
    'revoke view share',
    removeViewShare.status === 200 && (removeViewShare.data?.viewShares ?? []).every((item) => item.id !== viewShareRow?.id),
    `status=${removeViewShare.status} err=${removeViewShare.data?.error?.message ?? ''}`,
  );

  // a view-scoped guest only sees the shared view and cannot touch the structure
  const ownerCookie = cookie;
  const reShareView = await call(`/api/databases/${databaseId}/view-shares`, {
    method: 'POST',
    body: { viewId: baseView.id, email: memberEmail, role: 'viewer' },
  });
  check('re-share the view with the member', reShareView.status === 201, `status=${reShareView.status}`);

  const guestLogin = await call('/api/auth/login', {
    method: 'POST',
    body: { email: memberEmail, password: PASSWORD },
  });
  check('login as the shared member', guestLogin.status === 200, `status=${guestLogin.status}`);

  const scoped = await call(`/api/databases/${databaseId}`);
  check(
    'view scoped guest sees only the shared view',
    scoped.status === 200 &&
      scoped.data?.viewScoped === true &&
      (scoped.data?.views ?? []).length === 1 &&
      scoped.data.views[0].id === baseView.id &&
      Array.isArray(scoped.data?.rows),
    `status=${scoped.status} views=${scoped.data?.views?.length ?? 0} rows=${scoped.data?.rows?.length ?? 0}`,
  );

  // 列表接口也要标出「被分享」：前端据此把表格放进侧边栏的「分享表格」而不是「我的表格」
  const guestList = await call('/api/databases');
  const guestRow = (guestList.data?.databases ?? []).find((item) => item.id === databaseId);
  check(
    'view scoped guest list flags the table as shared',
    guestRow?.viewScoped === true && (guestRow?.sharedViewNames ?? []).includes(baseView.name),
    `viewScoped=${guestRow?.viewScoped} views=${JSON.stringify(guestRow?.sharedViewNames ?? [])}`,
  );

  const guestSession = await call('/api/session');
  const sessionRow = (guestSession.data?.databases ?? []).find((item) => item.id === databaseId);
  check('session list flags the shared table too', sessionRow?.viewScoped === true, `viewScoped=${sessionRow?.viewScoped}`);

  const scopedWrite = await call(`/api/databases/${databaseId}/records`, { method: 'POST', body: { values: {} } });
  check('view scoped viewer cannot write', scopedWrite.status === 403, `status=${scopedWrite.status}`);

  const scopedStructure = await call(`/api/databases/${databaseId}/properties`, {
    method: 'POST',
    body: { name: '越权字段', type: 'text' },
  });
  check('view scoped viewer cannot change the structure', scopedStructure.status === 403, `status=${scopedStructure.status}`);

  // 反向：被定向分享的访客也能 @ 所有者（备注 @ 不再是表格成员的专属能力）
  const guestVisibleRecordId = (scoped.data?.rows ?? [])[0]?.id ?? firstId;
  const guestToOwner = await call(`/api/records/${guestVisibleRecordId}/notes`, {
    method: 'POST',
    body: { body: '收到，这边也确认了 @Smoke Tester', mentions: [registered.data?.user?.id] },
  });
  const guestToOwnerNote = (guestToOwner.data?.notes ?? []).find((note) =>
    note.body.startsWith('收到，这边也确认了'),
  );
  check(
    'a view-share guest can @ the owner',
    guestToOwner.status === 201 &&
      (guestToOwnerNote?.mentions ?? []).some((item) => item.userId === registered.data?.user?.id),
    `status=${guestToOwner.status} mentions=${guestToOwnerNote?.mentions?.length ?? 0}`,
  );

  cookie = ownerCookie;
  const ownerFromGuest = await call('/api/inbox');
  check(
    'the owner gets an inbox message from the view-share guest',
    (ownerFromGuest.data?.messages ?? []).some((item) => item.noteId === guestToOwnerNote?.id),
    `messages=${ownerFromGuest.data?.messages?.length ?? 0}`,
  );

  // promote the same share to editor: the guest may then edit the shared view's rows
  cookie = ownerCookie;
  await call(`/api/databases/${databaseId}/view-shares`, {
    method: 'POST',
    body: { viewId: baseView.id, email: memberEmail, role: 'editor' },
  });
  await call('/api/auth/login', { method: 'POST', body: { email: memberEmail, password: PASSWORD } });
  const guestRecord = await call(`/api/databases/${databaseId}/records`, {
    method: 'POST',
    body: { values: { [titleProperty.id]: '视图分享写入' } },
  });
  check('editor view share may write', guestRecord.status === 201, `status=${guestRecord.status}`);
  if (guestRecord.data?.record?.id) await call(`/api/records/${guestRecord.data.record.id}`, { method: 'DELETE' });
  cookie = ownerCookie;
  const ownerList = await call('/api/databases');
  const ownerRow = (ownerList.data?.databases ?? []).find((item) => item.id === databaseId);
  check('own table is not flagged as shared', ownerRow?.viewScoped === false, `viewScoped=${ownerRow?.viewScoped}`);
  const cleanupViewShare = await call(`/api/view-shares/${(reShareView.data?.viewShares ?? [])[0]?.id}`, { method: 'DELETE' });
  check('cleanup the view share', cleanupViewShare.status === 200, `status=${cleanupViewShare.status}`);

  // ------------------------------------------------------- 邀请未注册邮箱
  section('view invites (邀请未注册邮箱)');
  const inviteeEmail = `invitee+${Date.now()}@example.com`;
  const invitePassword = 'Invite1pass';

  // 1) 不带 invite：服务端只回「该邮箱还没注册」，前端据此弹确认框
  const needsInvite = await call(`/api/databases/${databaseId}/view-shares`, {
    method: 'POST',
    body: { viewId: baseView.id, email: inviteeEmail, role: 'viewer' },
  });
  check(
    'sharing with an unregistered email asks for confirmation',
    needsInvite.status === 404 && needsInvite.data?.error?.code === 'email_not_registered',
    `status=${needsInvite.status} code=${needsInvite.data?.error?.code ?? ''}`,
  );

  // 2) invite: true：创建邀请并发邀请链接（测试域不发信，直接把链接回显出来）
  const invitedShare = await call(`/api/databases/${databaseId}/view-shares`, {
    method: 'POST',
    body: { viewId: baseView.id, email: inviteeEmail, role: 'editor', limitEdits: true, invite: true },
  });
  const inviteUrl =
    typeof invitedShare.data?.invite?.inviteUrl === 'string' ? invitedShare.data.invite.inviteUrl : '';
  const inviteToken = /\/invite\/([^/?#]+)/.exec(inviteUrl)?.[1] ?? '';
  check(
    'sharing with an unregistered email sends an invite',
    invitedShare.status === 201 && Boolean(inviteToken) && invitedShare.data?.invite?.emailDelivered === false,
    `status=${invitedShare.status} token=${inviteToken ? 'yes' : 'no'} delivered=${invitedShare.data?.invite?.emailDelivered}`,
  );
  check(
    'an invite is not a view share until accepted',
    (invitedShare.data?.viewShares ?? []).every((item) => item.email !== inviteeEmail),
    `viewShares=${invitedShare.data?.viewShares?.length ?? 0}`,
  );

  // 3) 受邀人打开邀请链接（无需登录）
  const inviteDetail = await call(`/api/invites/${inviteToken}`, { cookie: false });
  check(
    'the invite link shows the shared view',
    inviteDetail.status === 200 &&
      inviteDetail.data?.invite?.email === inviteeEmail &&
      inviteDetail.data?.invite?.viewName === baseView.name &&
      inviteDetail.data?.invite?.role === 'editor',
    `status=${inviteDetail.status} view=${inviteDetail.data?.invite?.viewName ?? ''}`,
  );
  const badInvite = await call('/api/invites/not-a-real-token', { cookie: false });
  check('an unknown invite token is a 404', badInvite.status === 404, `status=${badInvite.status}`);

  const weakInviteAccept = await call(`/api/invites/${inviteToken}/accept`, {
    method: 'POST',
    body: { name: '受邀人', password: 'short' },
  });
  check('the invited signup enforces the password rules', weakInviteAccept.status === 400, `status=${weakInviteAccept.status}`);

  // 4) 填昵称 + 密码完成注册：直接拿到会话（cookie 换成新账号）
  const accepted = await call(`/api/invites/${inviteToken}/accept`, {
    method: 'POST',
    body: { name: '受邀同事', password: invitePassword },
  });
  check(
    'accepting the invite registers the account',
    accepted.status === 201 && accepted.data?.user?.email === inviteeEmail && accepted.data?.user?.name === '受邀同事',
    `status=${accepted.status} err=${accepted.data?.error?.message ?? ''}`,
  );
  const inviteeSession = await call('/api/session');
  const inviteeTables = inviteeSession.data?.databases ?? [];
  check(
    'the invited account only has the shared table',
    inviteeSession.data?.user?.email === inviteeEmail &&
      inviteeTables.length === 1 &&
      inviteeTables[0]?.viewScoped === true,
    `tables=${inviteeTables.length} viewScoped=${inviteeTables[0]?.viewScoped}`,
  );
  const inviteeDetail = await call(`/api/databases/${databaseId}`);
  check(
    'the invited account sees only the shared view',
    inviteeDetail.status === 200 &&
      (inviteeDetail.data?.views ?? []).length === 1 &&
      inviteeDetail.data.views[0]?.id === baseView.id,
    `status=${inviteeDetail.status} views=${inviteeDetail.data?.views?.length ?? 0}`,
  );
  const inviteeWrite = await call(`/api/databases/${databaseId}/records`, { method: 'POST', body: { values: {} } });
  check('the invited editor may write', inviteeWrite.status === 201, `status=${inviteeWrite.status}`);
  if (inviteeWrite.data?.record?.id) await call(`/api/records/${inviteeWrite.data.record.id}`, { method: 'DELETE' });

  const replayedInvite = await call(`/api/invites/${inviteToken}/accept`, {
    cookie: false,
    method: 'POST',
    body: { name: '再来一次', password: invitePassword },
  });
  check('an accepted invite cannot be replayed', replayedInvite.status === 409, `status=${replayedInvite.status}`);

  const inviteeLogin = await call('/api/auth/login', {
    cookie: false,
    method: 'POST',
    body: { email: inviteeEmail, password: invitePassword },
  });
  check('the invited account can log in', inviteeLogin.status === 200, `status=${inviteeLogin.status}`);

  // 接受之后，所有者这边才真的多出一条视图分享
  cookie = ownerCookie;
  const ownerAfterInvite = await call(`/api/databases/${databaseId}`);
  const acceptedShare = (ownerAfterInvite.data?.viewShares ?? []).find((item) => item.email === inviteeEmail);
  check(
    'the accepted invite becomes a view share',
    acceptedShare?.role === 'editor' && acceptedShare?.limitEdits === true,
    `role=${acceptedShare?.role ?? ''} limitEdits=${acceptedShare?.limitEdits ?? ''}`,
  );

  // ------------------------------------------------- 人员类筛选（当前用户）
  section('people filters (当前用户)');
  const peopleField = await call(`/api/databases/${databaseId}/properties`, {
    method: 'POST',
    body: { name: '创建人', type: 'created_by' },
  });
  const createdByProperty = (peopleField.data?.properties ?? []).find((property) => property.type === 'created_by');
  check(
    'add a 创建人 field',
    peopleField.status === 201 && Boolean(createdByProperty),
    `status=${peopleField.status}`,
  );

  const ownerId = registered.data?.user?.id;
  const memberId = collaborator.data?.user?.id;

  const meView = await call(`/api/databases/${databaseId}/views`, {
    method: 'POST',
    body: {
      name: '我创建的',
      type: 'table',
      config: {
        filters: {
          conjunction: 'and',
          conditions: [{ propertyId: createdByProperty?.id, operator: 'is', value: '@me' }],
        },
      },
    },
  });
  const meViewId = meView.data?.viewId;
  const meCondition = ((meView.data?.views ?? []).find((view) => view.id === meViewId)?.config?.filters?.conditions ?? [])[0];
  check(
    'view keeps the 「当前用户」condition',
    meView.status === 201 && meCondition?.value === '@me' && meCondition?.operator === 'is',
    `status=${meView.status} value=${meCondition?.value}`,
  );

  const meShare = await call(`/api/databases/${databaseId}/view-shares`, {
    method: 'POST',
    body: { viewId: meViewId, email: memberEmail, role: 'viewer' },
  });
  check('share the 「当前用户」view with the member', meShare.status === 201, `status=${meShare.status}`);

  await call('/api/auth/login', { method: 'POST', body: { email: memberEmail, password: PASSWORD } });
  const guestMeView = await call(`/api/databases/${databaseId}`);
  check(
    '@me resolves to the visitor, not the table owner',
    guestMeView.status === 200 && (guestMeView.data?.rows ?? []).length === 0,
    `status=${guestMeView.status} rows=${guestMeView.data?.rows?.length ?? 0}`,
  );

  // promote the same share so the guest may add a row of their own
  // 「限制编辑」在分享时勾选：勾上之后被分享者每个格子只有一次输入机会
  cookie = ownerCookie;
  const meEditorShare = await call(`/api/databases/${databaseId}/view-shares`, {
    method: 'POST',
    body: { viewId: meViewId, email: memberEmail, role: 'editor', limitEdits: true },
  });
  const meEditorRow = (meEditorShare.data?.viewShares ?? []).find((item) => item.email === memberEmail);
  check(
    'promote the 「当前用户」view share to editor（限制编辑）',
    meEditorShare.status === 201 && meEditorRow?.role === 'editor' && meEditorRow?.limitEdits === true,
    `status=${meEditorShare.status} limitEdits=${meEditorRow?.limitEdits}`,
  );

  await call('/api/auth/login', { method: 'POST', body: { email: memberEmail, password: PASSWORD } });
  const mine = await call(`/api/databases/${databaseId}/records`, {
    method: 'POST',
    body: { values: { [titleProperty.id]: '@me 自建记录' } },
  });
  const mineId = mine.data?.record?.id;
  check('guest writes through the shared view', mine.status === 201 && Boolean(mineId), `status=${mine.status}`);

  const guestMine = await call(`/api/databases/${databaseId}`);
  const mineRow = (guestMine.data?.rows ?? []).find((row) => row.id === mineId);
  check(
    '「当前用户」view shows exactly the visitor own row',
    (guestMine.data?.rows ?? []).length === 1 && mineRow?.createdBy === memberId,
    `rows=${guestMine.data?.rows?.length ?? 0} createdBy=${mineRow?.createdBy ?? ''} member=${memberId ?? ''}`,
  );

  // 共享出来的 editor（视图定向分享）勾了「限制编辑」时输入次数不限，
  // 但每次保存后 10 秒这一格才锁上（计时窗口），窗口一过就只能查看
  const guestCellEdit = await call(`/api/records/${mineId}`, {
    method: 'PATCH',
    body: { values: { [titleProperty.id]: '@me 自建记录（改）' } },
  });
  check(
    'a shared editor may edit a cell',
    guestCellEdit.status === 200,
    `status=${guestCellEdit.status} err=${guestCellEdit.data?.error?.message ?? ''}`,
  );

  const guestCellEditAgain = await call(`/api/records/${mineId}`, {
    method: 'PATCH',
    body: { values: { [titleProperty.id]: '@me 自建记录（窗口内改回来）' } },
  });
  check(
    'a shared editor may keep editing the cell inside the grace window',
    guestCellEditAgain.status === 200 &&
      guestCellEditAgain.data?.record?.values?.[titleProperty.id] === '@me 自建记录（窗口内改回来）' &&
      Number(guestCellEditAgain.data?.cellEditGrace?.[`${mineId}:${titleProperty.id}`]) > Date.now(),
    `status=${guestCellEditAgain.status} err=${guestCellEditAgain.data?.error?.message ?? ''}`,
  );

  // 窗口一过这一格只读：再改被拒，列表里也列进 lockedCells
  await waitForGraceWindow();
  const guestCellEditExpired = await call(`/api/records/${mineId}`, {
    method: 'PATCH',
    body: { values: { [titleProperty.id]: '@me 自建记录（窗口已过）' } },
  });
  check(
    'a shared editor cannot edit the same cell twice after the window closed',
    guestCellEditExpired.status === 403,
    `status=${guestCellEditExpired.status} err=${guestCellEditExpired.data?.error?.message ?? ''}`,
  );

  const guestRows = await call(`/api/databases/${databaseId}/rows?limit=50`);
  const guestGraceKeys = Object.keys(guestRows.data?.cellEditGrace ?? {});
  check(
    'the guest rows payload marks the locked cell',
    (guestRows.data?.lockedCells ?? []).includes(`${mineId}:${titleProperty.id}`) &&
      !guestGraceKeys.includes(`${mineId}:${titleProperty.id}`),
    `lockedCells=${textOf(guestRows.data?.lockedCells)} cellEditGrace=${textOf(guestGraceKeys)}`,
  );

  check(
    'the guest detail reports the 限制编辑 flag',
    guestMine.data?.limitCellEdits === true,
    `limitCellEdits=${guestMine.data?.limitCellEdits}`,
  );

  // 同一个视图 + 同一个账号重新分享，这次不勾「限制编辑」：限制立刻取消
  cookie = ownerCookie;
  const relaxedShare = await call(`/api/databases/${databaseId}/view-shares`, {
    method: 'POST',
    body: { viewId: meViewId, email: memberEmail, role: 'editor' },
  });
  const relaxedRow = (relaxedShare.data?.viewShares ?? []).find((item) => item.email === memberEmail);
  check(
    'turn 限制编辑 off for the same view share',
    relaxedShare.status === 201 && relaxedRow?.role === 'editor' && relaxedRow?.limitEdits === false,
    `status=${relaxedShare.status} limitEdits=${relaxedRow?.limitEdits}`,
  );

  await call('/api/auth/login', { method: 'POST', body: { email: memberEmail, password: PASSWORD } });
  const relaxedDetail = await call(`/api/databases/${databaseId}`);
  check(
    'the guest is no longer restricted',
    relaxedDetail.data?.limitCellEdits === false && (relaxedDetail.data?.lockedCells ?? []).length === 0,
    `limitCellEdits=${relaxedDetail.data?.limitCellEdits} lockedCells=${textOf(relaxedDetail.data?.lockedCells)}`,
  );

  const guestCellEditThird = await call(`/api/records/${mineId}`, {
    method: 'PATCH',
    body: { values: { [titleProperty.id]: '@me 自建记录（不限制编辑后）' } },
  });
  check(
    'without 限制编辑 the guest may edit the same cell again',
    guestCellEditThird.status === 200,
    `status=${guestCellEditThird.status} err=${guestCellEditThird.data?.error?.message ?? ''}`,
  );

  // 「不是当前用户」= 别人创建的记录（表格所有者创建的那条依然在）
  cookie = ownerCookie;
  const othersView = await call(`/api/databases/${databaseId}/views`, {
    method: 'POST',
    body: {
      name: '别人创建的',
      type: 'table',
      config: {
        filters: {
          conjunction: 'and',
          conditions: [{ propertyId: createdByProperty?.id, operator: 'is_not', value: '@me' }],
        },
      },
    },
  });
  const othersShare = await call(`/api/databases/${databaseId}/view-shares`, {
    method: 'POST',
    body: { viewId: othersView.data?.viewId, email: memberEmail, role: 'viewer' },
  });
  check('share the 「不是当前用户」view', othersShare.status === 201, `status=${othersShare.status}`);

  await call('/api/auth/login', { method: 'POST', body: { email: memberEmail, password: PASSWORD } });
  const guestOthers = await call(`/api/databases/${databaseId}`);
  const othersRows = guestOthers.data?.rows ?? [];
  check(
    '「不是当前用户」keeps the rows created by others',
    othersRows.length >= 2 && othersRows.some((row) => row.id === firstId && row.createdBy === ownerId),
    `rows=${othersRows.length} ownerRows=${othersRows.filter((row) => row.createdBy === ownerId).length}`,
  );

  check(
    'shared user resolves names for rows created by others',
    guestOthers.data?.people?.[ownerId] === 'Smoke Tester',
    `name=${guestOthers.data?.people?.[ownerId] ?? ''}`,
  );

  cookie = ownerCookie;
  const peopleShares = othersShare.data?.viewShares ?? [];
  let revokedPeopleShares = 0;
  for (const item of peopleShares) {
    const removed = await call(`/api/view-shares/${item.id}`, { method: 'DELETE' });
    if (removed.status === 200) revokedPeopleShares += 1;
  }
  check(
    'revoke the people filter view shares',
    peopleShares.length > 0 && revokedPeopleShares === peopleShares.length,
    `${revokedPeopleShares}/${peopleShares.length} view share(s)`,
  );

  // ----------------------------------- 创建人姓名解析（被分享但非成员的访问者）
  section('creator names (创建人)');
  const ownerDetail = await call(`/api/databases/${databaseId}`);
  const sharedRow = (ownerDetail.data?.rows ?? []).find((row) => row.id === mineId);
  check(
    'the shared user is not a table member',
    (ownerDetail.data?.members ?? []).every((item) => item.userId !== memberId),
    `members=${ownerDetail.data?.members?.length ?? 0}`,
  );
  check(
    'owner resolves the name of a row a shared user created',
    sharedRow?.createdBy === memberId && ownerDetail.data?.people?.[memberId] === 'Smoke Collaborator',
    `createdBy=${sharedRow?.createdBy ?? ''} name=${ownerDetail.data?.people?.[memberId] ?? ''}`,
  );
  check(
    'owner rows resolve the owner name',
    ownerDetail.data?.people?.[ownerId] === 'Smoke Tester',
    `name=${ownerDetail.data?.people?.[ownerId] ?? ''}`,
  );

  const sharesBefore = new Set(
    ((await call(`/api/databases/${databaseId}/shares`)).data?.shares ?? []).map((item) => item.id),
  );
  const namesShare = await call(`/api/databases/${databaseId}/shares`, {
    method: 'POST',
    body: { permission: 'view' },
  });
  const namesToken = (namesShare.data?.shares ?? []).find((item) => !sharesBefore.has(item.id))?.token;
  const publicNames = await call(`/api/public/${namesToken}`, { cookie: false });
  check(
    'public payload resolves creator names',
    Boolean(namesToken) &&
      publicNames.data?.people?.[memberId] === 'Smoke Collaborator' &&
      publicNames.data?.people?.[ownerId] === 'Smoke Tester',
    `owner=${publicNames.data?.people?.[ownerId] ?? ''} guest=${publicNames.data?.people?.[memberId] ?? ''}`,
  );

  // ------------------------------------------------------- live sync（多人协作）
  section('live sync (增量同步)');
  // 打开表格时下发的 `rev` 就是客户端一开始的游标
  const detailWithRev = await call(`/api/databases/${databaseId}`);
  check(
    'table detail carries the version cursor',
    typeof detailWithRev.data?.rev === 'number',
    `rev=${detailWithRev.data?.rev}`,
  );

  // 第一次请求（游标 0）要能拿到一个可用的版本号：客户端就是拿它当起点的
  const syncStart = await call(`/api/databases/${databaseId}/changes?since=0`);
  check(
    'changes starts with a version cursor',
    syncStart.status === 200 &&
      typeof syncStart.data?.rev === 'number' &&
      Array.isArray(syncStart.data?.rows) &&
      Array.isArray(syncStart.data?.deleted),
    `rev=${syncStart.data?.rev}`,
  );

  let syncCursor = syncStart.data?.rev ?? 0;
  const liveRow = await call(`/api/databases/${databaseId}/records`, {
    method: 'POST',
    body: { values: { [titleProperty.id]: '实时同步测试' } },
  });
  const liveRowId = liveRow.data?.record?.id;
  check('create row for live sync', liveRow.status === 201 && Boolean(liveRowId));

  const createdDelta = await call(`/api/databases/${databaseId}/changes?since=${syncCursor}`);
  check(
    'new row lands in the delta',
    createdDelta.data?.reset === false &&
      (createdDelta.data?.rows ?? []).some((row) => row.id === liveRowId) &&
      createdDelta.data?.rev > syncCursor,
    `rev=${createdDelta.data?.rev}`,
  );

  syncCursor = createdDelta.data?.rev ?? syncCursor;
  await call(`/api/records/${liveRowId}`, {
    method: 'PATCH',
    body: { values: { [titleProperty.id]: '实时同步测试（改）' } },
  });
  const patchedDelta = await call(`/api/databases/${databaseId}/changes?since=${syncCursor}`);
  const patchedRow = (patchedDelta.data?.rows ?? []).find((row) => row.id === liveRowId);
  check(
    'updated cell lands in the delta',
    patchedDelta.data?.reset === false && patchedRow?.values?.[titleProperty.id] === '实时同步测试（改）',
    `${patchedRow?.values?.[titleProperty.id] ?? '(none)'}`,
  );

  syncCursor = patchedDelta.data?.rev ?? syncCursor;
  await call(`/api/records/${liveRowId}/notes`, { method: 'POST', body: { body: '实时同步备注' } });
  const noteDelta = await call(`/api/databases/${databaseId}/changes?since=${syncCursor}`);
  check(
    'new note lands in the delta',
    noteDelta.data?.reset === false && (noteDelta.data?.notes ?? []).some((note) => note.recordId === liveRowId),
  );

  syncCursor = noteDelta.data?.rev ?? syncCursor;
  const idleDelta = await call(`/api/databases/${databaseId}/changes?since=${syncCursor}`);
  check(
    'idle delta stays empty',
    idleDelta.data?.reset === false &&
      (idleDelta.data?.rows ?? []).length === 0 &&
      (idleDelta.data?.deleted ?? []).length === 0 &&
      idleDelta.data?.rev >= syncCursor,
    `rev=${idleDelta.data?.rev}`,
  );

  syncCursor = idleDelta.data?.rev ?? syncCursor;
  await call(`/api/records/${liveRowId}`, { method: 'DELETE' });
  const deletedDelta = await call(`/api/databases/${databaseId}/changes?since=${syncCursor}`);
  check(
    'deleted row lands in the delta',
    deletedDelta.data?.reset === false &&
      (deletedDelta.data?.deleted ?? []).includes(liveRowId) &&
      !(deletedDelta.data?.rows ?? []).some((row) => row.id === liveRowId),
  );

  // 结构改动（字段改名 / 视图配置）会让客户端整表重载：reset=true
  syncCursor = deletedDelta.data?.rev ?? syncCursor;
  await call(`/api/properties/${titleProperty.id}`, {
    method: 'PATCH',
    body: { name: `${titleProperty.name} ✓` },
  });
  const schemaDelta = await call(`/api/databases/${databaseId}/changes?since=${syncCursor}`);
  check('structural change asks for a reload', schemaDelta.data?.reset === true, `reset=${schemaDelta.data?.reset}`);

  // 客户端收到 reset 后会整表重载一次，并以新详情里的 rev 作为新游标：
  // 之后应该又能正常拿到增量（字段名改回去也是一次结构改动，所以先改回再取游标）
  await call(`/api/properties/${titleProperty.id}`, { method: 'PATCH', body: { name: titleProperty.name } });
  const reloadedDetail = await call(`/api/databases/${databaseId}`);
  const healthyDelta = await call(`/api/databases/${databaseId}/changes?since=${reloadedDetail.data?.rev ?? 0}`);
  check(
    'delta is healthy again after the reload',
    typeof reloadedDetail.data?.rev === 'number' && healthyDelta.data?.reset === false,
    `reset=${healthyDelta.data?.reset}`,
  );

  // 公开链接一侧也在轮询同一个增量接口（表格里的改动会出现在公开页上）
  const publicSync = await call(`/api/public/${editToken}/changes?since=0`, { cookie: false });
  check(
    'public changes endpoint',
    publicSync.status === 200 && typeof publicSync.data?.rev === 'number',
    `rev=${publicSync.data?.rev}`,
  );

  const publicLive = await call(`/api/databases/${databaseId}/records`, {
    method: 'POST',
    body: { values: { [titleProperty.id]: '公开页也能看到' } },
  });
  const publicLiveId = publicLive.data?.record?.id;
  const publicDelta = await call(`/api/public/${editToken}/changes?since=${publicSync.data?.rev ?? 0}`, {
    cookie: false,
  });
  check(
    'table edit reaches the public page',
    (publicDelta.data?.rows ?? []).some((row) => row.id === publicLiveId),
    `${(publicDelta.data?.rows ?? []).length} row(s)`,
  );
  if (publicLiveId) await call(`/api/records/${publicLiveId}`, { method: 'DELETE' });

  const syncAnon = await call(`/api/databases/${databaseId}/changes`, { cookie: false });
  check('changes requires a session', syncAnon.status === 401, `status=${syncAnon.status}`);
  const syncGone = await call('/api/databases/database-does-not-exist/changes');
  check('changes 404 for an unknown table', syncGone.status === 404, `status=${syncGone.status}`);
  const syncBadToken = await call('/api/public/not-a-real-token/changes', { cookie: false });
  check('public changes 404 for a bad token', syncBadToken.status === 404, `status=${syncBadToken.status}`);


  // -------------------------------------------------------------------- files
  section('files');
  const form = new FormData();
  form.set('file', new Blob(['varysheet smoke test'], { type: 'text/plain' }), 'smoke.txt');
  form.set('databaseId', databaseId);
  const uploaded = await call('/api/files', { method: 'POST', form });
  const fileId = uploaded.data?.file?.id;
  check('upload file to R2', uploaded.status === 201 && Boolean(fileId), `status=${uploaded.status}`);

  if (fileId) {
    const download = await fetch(`${BASE}/api/files/${fileId}`, { headers: { cookie } });
    const text = await download.text();
    check('download file', download.ok && text === 'varysheet smoke test', `status=${download.status}`);
  }

  // ---------------------------------------------------------------- capacity
  // 单表容量：记录数（默认 500）/ 附件占用（默认 1GB）到上限后**只拦增长** ——
  // 新建记录、批量新建、复制记录、上传附件会被 403 capacity_exceeded 挡下；
  // 查看、查询、编辑已有记录、删除记录都照常。上限从接口读，本地与线上跑同一套断言。
  section('capacity limits (只拦增长)');
  const capSession = await call('/api/session');
  const capSummary = (capSession.data?.databases ?? []).find((item) => item.id === databaseId);
  const cap = capSummary?.capacity;
  check(
    'session exposes per-table capacity',
    typeof cap?.maxRecords === 'number' &&
      typeof cap?.maxStorageBytes === 'number' &&
      cap?.atCapacity === false &&
      // 主测试表是专业表格：容量与保留时间都不限（基础表格的 500 条 / 1GB 在下面那张临时表上验）
      cap?.unlimited === true,
    `records=${cap?.records}/${cap?.maxRecords} unlimited=${cap?.unlimited === true} storage=${cap?.storageBytes}`,
  );
  const capRows = await call(`/api/databases/${databaseId}/rows?limit=1`);
  check(
    'record usage matches the table',
    cap?.records === capRows.data?.total,
    `capacity=${cap?.records} rows=${capRows.data?.total}`,
  );
  check('storage usage counts uploaded attachments', (cap?.storageBytes ?? 0) > 0, `${cap?.storageBytes} bytes`);
  const capDetail = await call(`/api/databases/${databaseId}`);
  check(
    'table detail exposes the same capacity',
    capDetail.data?.capacity?.maxRecords === cap?.maxRecords && capDetail.data?.capacity?.atCapacity === false,
    `maxRecords=${capDetail.data?.capacity?.maxRecords} atCapacity=${capDetail.data?.capacity?.atCapacity}`,
  );

  // 专门用来把「已满」这个状态跑出来的临时表格（默认 = 基础表格）：上限从它自己的
  // 容量快照里读，然后按 maxRecords 灌满（一次 200 行，和批量接口的上限一致）。
  const capTable = await call('/api/databases', { method: 'POST', body: { name: 'Smoke 容量表' } });
  const capTableId = capTable.data?.id;
  const capFieldId = (capTable.data?.properties ?? [])[0]?.id;
  const maxRecords = capTable.data?.capacity?.maxRecords ?? 0;
  check(
    'a basic table reports the record / storage / retention limits',
    capTable.data?.capacity?.kind === 'basic' &&
      capTable.data?.capacity?.unlimited === false &&
      maxRecords > 0 &&
      (capTable.data?.capacity?.retentionDays ?? 0) > 0,
    `maxRecords=${maxRecords} retentionDays=${capTable.data?.capacity?.retentionDays} unlimited=${capTable.data?.capacity?.unlimited}`,
  );
  if (
    check(
      'temp table for the capacity checks',
      Boolean(capTableId && capFieldId) && maxRecords > 0 && maxRecords <= 2000,
      `status=${capTable.status} maxRecords=${maxRecords}`,
    )
  ) {
    let filled = 0;
    while (filled < maxRecords) {
      const batch = Math.min(200, maxRecords - filled);
      const created = await call(`/api/databases/${capTableId}/records/bulk`, {
        method: 'POST',
        body: {
          records: Array.from({ length: batch }, (_, index) => ({ [capFieldId]: `容量 ${filled + index + 1}` })),
        },
      });
      if (created.status !== 201) break;
      filled += batch;
    }
    check('fill the temp table up to the limit', filled === maxRecords, `${filled}/${maxRecords} 行`);

    const fullDetail = await call(`/api/databases/${capTableId}`);
    check(
      'capacity reports the table as full',
      fullDetail.data?.capacity?.atCapacity === true && fullDetail.data?.capacity?.recordsFull === true,
      `atCapacity=${fullDetail.data?.capacity?.atCapacity} records=${fullDetail.data?.capacity?.records}/${maxRecords}`,
    );

    const overLimit = await call(`/api/databases/${capTableId}/records`, {
      method: 'POST',
      body: { values: { [capFieldId]: '超限' } },
    });
    check(
      'creating a record past the limit is rejected',
      overLimit.status === 403 && overLimit.data?.error?.code === 'capacity_exceeded',
      `status=${overLimit.status} code=${overLimit.data?.error?.code ?? ''}`,
    );

    const overBulk = await call(`/api/databases/${capTableId}/records/bulk`, {
      method: 'POST',
      body: { records: [{ [capFieldId]: '超限 A' }, { [capFieldId]: '超限 B' }] },
    });
    check(
      'bulk creating past the limit is rejected',
      overBulk.status === 403 && overBulk.data?.error?.code === 'capacity_exceeded',
      `status=${overBulk.status} code=${overBulk.data?.error?.code ?? ''}`,
    );

    const fullRows = await call(`/api/databases/${capTableId}/rows?limit=1`);
    const fullRowId = fullRows.data?.rows?.[0]?.id;

    const overCopy = await call(`/api/databases/${capTableId}/records/duplicate`, {
      method: 'POST',
      body: { recordIds: [fullRowId ?? 'missing'] },
    });
    check(
      'duplicating past the limit is rejected',
      overCopy.status === 403 && overCopy.data?.error?.code === 'capacity_exceeded',
      `status=${overCopy.status} code=${overCopy.data?.error?.code ?? ''}`,
    );

    const blockedUpload = new FormData();
    blockedUpload.set('file', new Blob(['capacity'], { type: 'text/plain' }), 'capacity.txt');
    blockedUpload.set('databaseId', capTableId);
    const rejectedUpload = await call('/api/files', { method: 'POST', form: blockedUpload });
    check(
      'uploading an attachment to a full table is rejected',
      rejectedUpload.status === 403 && rejectedUpload.data?.error?.code === 'capacity_exceeded',
      `status=${rejectedUpload.status} code=${rejectedUpload.data?.error?.code ?? ''}`,
    );

    // 「只拦增长」：满了以后编辑 / 删除依旧可用（不然数据永远清理不出来）
    const stillEditable = await call(`/api/records/${fullRowId}`, {
      method: 'PATCH',
      body: { values: { [capFieldId]: '满了也能改' } },
    });
    check(
      'editing an existing record is still allowed when full',
      stillEditable.status === 200 && stillEditable.data?.record?.values?.[capFieldId] === '满了也能改',
      `status=${stillEditable.status}`,
    );

    const freed = await call(`/api/records/${fullRowId}`, { method: 'DELETE' });
    check('deleting a record is still allowed when full', freed.data?.ok === true, `status=${freed.status}`);

    const refilled = await call(`/api/databases/${capTableId}/records`, {
      method: 'POST',
      body: { values: { [capFieldId]: '腾出空间后又能新建' } },
    });
    const afterFree = await call(`/api/databases/${capTableId}`);
    // 删掉 1 行后新建成功（刚刚好又填回上限，所以 atCapacity 会重新变回 true）
    check(
      'the table accepts new records again after freeing space',
      refilled.status === 201 && afterFree.data?.capacity?.records === maxRecords,
      `status=${refilled.status} records=${afterFree.data?.capacity?.records}/${maxRecords}`,
    );

    const removedCapTable = await call(`/api/databases/${capTableId}`, { method: 'DELETE' });
    check('cleanup the capacity table', removedCapTable.data?.ok === true, `status=${removedCapTable.status}`);
  }

  // -------------------------------------------- 表格名额（GET /api/quota）
  section('table quota (表格名额)');
  const quotaBefore = await call('/api/quota');
  const beforeQuota = quotaBefore.data?.quota;
  check(
    'the owner can read both table quotas',
    quotaBefore.status === 200 &&
      typeof beforeQuota?.basic?.remaining === 'number' &&
      typeof beforeQuota?.pro?.remaining === 'number' &&
      // 没有默认名额：总名额 = 分享得到的 + 购买来的
      beforeQuota?.basic?.total === (beforeQuota?.basic?.shared ?? 0) + (beforeQuota?.basic?.purchased ?? 0) &&
      beforeQuota?.pro?.total === (beforeQuota?.pro?.shared ?? 0) + (beforeQuota?.pro?.purchased ?? 0) &&
      beforeQuota?.basic?.remaining === Math.max(0, (beforeQuota?.basic?.total ?? 0) - (beforeQuota?.basic?.used ?? 0)),
    `basic=${JSON.stringify(beforeQuota?.basic)} pro=${JSON.stringify(beforeQuota?.pro)}`,
  );

  // 名额用光的账号建不了表：用一个全新账号验（它 0 名额，这张表本身也建不出来）
  const noSlotEmail = `smoke+noslot+${Date.now()}@example.com`;
  const noSlotAccount = await registerAccount({ email: noSlotEmail, name: 'No Slot' });
  // 注册那两步不带 cookie，所以这里显式登录成新账号（会换掉当前 cookie）
  const noSlotLogin = await call('/api/auth/login', {
    method: 'POST',
    body: { email: noSlotEmail, password: PASSWORD },
  });
  const noSlotQuota = (await call('/api/quota')).data?.quota;
  const noSlotTable = await call('/api/databases', {
    method: 'POST',
    body: { name: '没名额的表', kind: 'basic' },
  });
  check(
    'an account without any slot cannot create a table',
    noSlotAccount.verified?.status === 201 &&
      noSlotLogin.status === 200 &&
      noSlotQuota?.basic?.remaining === 0 &&
      noSlotTable.status === 403 &&
      noSlotTable.data?.error?.code === 'quota_exceeded',
    `register=${noSlotAccount.verified?.status} status=${noSlotTable.status} code=${noSlotTable.data?.error?.code ?? ''}`,
  );
  // 上面的注册把 cookie 换成了新账号：登录回主测试账号继续后面的断言
  const backToMain = await call('/api/auth/login', {
    method: 'POST',
    body: { email, password: PASSWORD },
  });
  const quotaBack = (await call('/api/quota')).data?.quota;
  check(
    'the main account gets its slots back after switching back',
    backToMain.status === 200 &&
      quotaBack?.basic?.remaining === beforeQuota?.basic?.remaining &&
      quotaBack?.pro?.remaining === beforeQuota?.pro?.remaining,
    `basic=${quotaBack?.basic?.remaining} pro=${quotaBack?.pro?.remaining}`,
  );

  // 买 2 个专业表格名额：买几个就多几个（买完立刻可以建专业表）
  const proPurchase = await call('/api/quota/purchases', {
    method: 'POST',
    body: { kind: 'pro', count: 2 },
  });
  check(
    'buying pro table slots adds exactly that many',
    proPurchase.status === 201 &&
      proPurchase.data?.quota?.pro?.purchased === (beforeQuota?.pro?.purchased ?? 0) + 2 &&
      proPurchase.data?.quota?.pro?.total === (beforeQuota?.pro?.total ?? 0) + 2 &&
      proPurchase.data?.quota?.pro?.remaining === (beforeQuota?.pro?.remaining ?? 0) + 2,
    `purchased=${proPurchase.data?.quota?.pro?.purchased} total=${proPurchase.data?.quota?.pro?.total} remaining=${proPurchase.data?.quota?.pro?.remaining}`,
  );

  const quotaTable = await call('/api/databases', { method: 'POST', body: { name: '名额测试表' } });
  const afterCreate = (await call('/api/quota')).data?.quota;
  check(
    'adding a basic table spends one basic slot',
    quotaTable.status === 201 &&
      quotaTable.data?.kind === 'basic' &&
      afterCreate?.basic?.used === (beforeQuota?.basic?.used ?? 0) + 1 &&
      afterCreate?.basic?.remaining === (beforeQuota?.basic?.remaining ?? 0) - 1,
    `used=${beforeQuota?.basic?.used}->${afterCreate?.basic?.used} remaining=${beforeQuota?.basic?.remaining}->${afterCreate?.basic?.remaining}`,
  );

  // 容量口径：基础表格 500 条 / 1GB / 保留一年；专业表格三个维度都不限
  const basicCapacity = quotaTable.data?.capacity;
  check(
    'a basic table keeps the record / storage / retention limits',
    basicCapacity?.kind === 'basic' &&
      basicCapacity?.unlimited === false &&
      basicCapacity?.maxRecords === maxRecords &&
      basicCapacity?.retentionDays === 365,
    `maxRecords=${basicCapacity?.maxRecords} retentionDays=${basicCapacity?.retentionDays}`,
  );

  const proTable = await call('/api/databases', {
    method: 'POST',
    body: { name: '专业容量表', kind: 'pro' },
  });
  const proCapacity = proTable.data?.capacity;
  check(
    'a pro table reports unlimited capacity and no retention',
    proTable.status === 201 &&
      proTable.data?.kind === 'pro' &&
      proCapacity?.unlimited === true &&
      proCapacity?.maxRecords === 0 &&
      proCapacity?.maxStorageBytes === 0 &&
      proCapacity?.retentionDays === 0 &&
      proCapacity?.recordsFull === false &&
      proCapacity?.storageFull === false &&
      proCapacity?.atCapacity === false,
    `unlimited=${proCapacity?.unlimited} maxRecords=${proCapacity?.maxRecords} retentionDays=${proCapacity?.retentionDays}`,
  );

  // 分享出去一次（公开链接）就多一个**同类型**的可添加名额
  const beforeShare = (await call('/api/quota')).data?.quota;
  const quotaShare = await call(`/api/databases/${quotaTable.data?.id}/shares`, {
    method: 'POST',
    body: { permission: 'view' },
  });
  const afterShare = (await call('/api/quota')).data?.quota;
  check(
    'sharing a basic table grants one more basic slot',
    quotaShare.status === 201 &&
      afterShare?.basic?.shared === (beforeShare?.basic?.shared ?? 0) + 1 &&
      afterShare?.basic?.total === (beforeShare?.basic?.total ?? 0) + 1 &&
      afterShare?.basic?.remaining === (beforeShare?.basic?.remaining ?? 0) + 1 &&
      // 分享基础表格不会动到专业表格的名额
      afterShare?.pro?.remaining === beforeShare?.pro?.remaining,
    `status=${quotaShare.status} shared=${beforeShare?.basic?.shared}->${afterShare?.basic?.shared} remaining=${beforeShare?.basic?.remaining}->${afterShare?.basic?.remaining}`,
  );

  // 列数上限：基础表格 10 列、专业表格 20 列（空白表自带「名称」一列，只拦新增）
  const addColumn = (databaseId, name) =>
    call(`/api/databases/${databaseId}/properties`, { method: 'POST', body: { name, type: 'text' } });
  const fillColumns = async (databaseId, already, limit) => {
    let columns = already;
    while (columns < limit) {
      const added = await addColumn(databaseId, `列 ${columns + 1}`);
      if (added.status !== 201) return { columns, blocked: added };
      columns += 1;
    }
    const blocked = await addColumn(databaseId, `列 ${columns + 1}`);
    return { columns, blocked };
  };

  const basicColumns = await fillColumns(quotaTable.data?.id, (quotaTable.data?.properties ?? []).length, 10);
  check(
    'a basic table stops at 10 columns',
    basicColumns.columns === 10 &&
      basicColumns.blocked?.status === 403 &&
      basicColumns.blocked?.data?.error?.code === 'limit_exceeded',
    `columns=${basicColumns.columns} status=${basicColumns.blocked?.status} code=${basicColumns.blocked?.data?.error?.code ?? ''}`,
  );

  const proColumns = await fillColumns(proTable.data?.id, (proTable.data?.properties ?? []).length, 20);
  check(
    'a pro table stops at 20 columns',
    proColumns.columns === 20 &&
      proColumns.blocked?.status === 403 &&
      proColumns.blocked?.data?.error?.code === 'limit_exceeded',
    `columns=${proColumns.columns} status=${proColumns.blocked?.status} code=${proColumns.blocked?.data?.error?.code ?? ''}`,
  );

  // 视图数上限：基础表格 3 个、专业表格 10 个（新建表格自带 1 个「全部数据」）
  const addView = (databaseId, name) =>
    call(`/api/databases/${databaseId}/views`, { method: 'POST', body: { type: 'table', name } });
  const fillViews = async (databaseId, already, limit) => {
    let views = already;
    while (views < limit) {
      const added = await addView(databaseId, `视图 ${views + 1}`);
      if (added.status !== 201) return { views, blocked: added };
      views += 1;
    }
    const blocked = await addView(databaseId, `视图 ${views + 1}`);
    return { views, blocked };
  };

  const basicViews = await fillViews(quotaTable.data?.id, (quotaTable.data?.views ?? []).length, 3);
  check(
    'a basic table stops at 3 views',
    basicViews.views === 3 &&
      basicViews.blocked?.status === 403 &&
      basicViews.blocked?.data?.error?.code === 'limit_exceeded',
    `views=${basicViews.views} status=${basicViews.blocked?.status} code=${basicViews.blocked?.data?.error?.code ?? ''}`,
  );

  const proViews = await fillViews(proTable.data?.id, (proTable.data?.views ?? []).length, 10);
  check(
    'a pro table stops at 10 views',
    proViews.views === 10 &&
      proViews.blocked?.status === 403 &&
      proViews.blocked?.data?.error?.code === 'limit_exceeded',
    `views=${proViews.views} status=${proViews.blocked?.status} code=${proViews.blocked?.data?.error?.code ?? ''}`,
  );

  // 清理：删掉分享链接与这两张测试表，别给后面的段落留下干扰
  await call(`/api/shares/${(quotaShare.data?.shares ?? [])[0]?.id}`, { method: 'DELETE' });
  const removedProTable = await call(`/api/databases/${proTable.data?.id}`, { method: 'DELETE' });
  const removedQuotaTable = await call(`/api/databases/${quotaTable.data?.id}`, { method: 'DELETE' });
  const settledQuota = (await call('/api/quota')).data?.quota;
  check(
    'removing the test tables and the link restores the quota',
    removedProTable.data?.ok === true &&
      removedQuotaTable.data?.ok === true &&
      settledQuota?.basic?.used === beforeQuota?.basic?.used &&
      settledQuota?.basic?.shared === beforeQuota?.basic?.shared &&
      settledQuota?.pro?.used === beforeQuota?.pro?.used,
    `basic=${JSON.stringify(settledQuota?.basic)} pro=${JSON.stringify(settledQuota?.pro)}`,
  );

  // ------------------------------------------------------------------ cleanup
  // ------------------------------------------------- 改密码（登录后自助修改）
  section('password change');
  const otherLogin = await call('/api/auth/login', {
    cookie: false,
    method: 'POST',
    body: { email, password: PASSWORD },
  });
  const otherCookie = String(otherLogin.headers.get('set-cookie') ?? '').split(';')[0];
  check(
    'a second device can sign in',
    otherLogin.status === 200 && Boolean(otherCookie),
    `status=${otherLogin.status}`,
  );

  const wrongCurrent = await call('/api/auth/password', {
    method: 'POST',
    body: { currentPassword: 'NotMyPassword1', newPassword: NEW_PASSWORD },
  });
  check(
    'changing the password needs the current one',
    wrongCurrent.status === 400 && wrongCurrent.data?.error?.code === 'wrong_password',
    `status=${wrongCurrent.status} code=${wrongCurrent.data?.error?.code ?? ''}`,
  );

  const samePassword = await call('/api/auth/password', {
    method: 'POST',
    body: { currentPassword: PASSWORD, newPassword: PASSWORD },
  });
  check('the new password must differ from the old one', samePassword.status === 400, `status=${samePassword.status}`);

  const weakPassword = await call('/api/auth/password', {
    method: 'POST',
    body: { currentPassword: PASSWORD, newPassword: 'short' },
  });
  check('the new password must be strong enough', weakPassword.status === 400, `status=${weakPassword.status}`);

  const changed = await call('/api/auth/password', {
    method: 'POST',
    body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
  });
  check(
    'change the password',
    changed.status === 200 && changed.data?.ok === true && changed.data?.sessionsRevoked === true,
    `status=${changed.status}`,
  );

  const evicted = await call('/api/session', { cookie: false, headers: { cookie: otherCookie } });
  check('changing the password logs other devices out', evicted.data?.user === null, `user=${evicted.data?.user ?? 'null'}`);

  const stillHere = await call('/api/session');
  check('the current device stays signed in', stillHere.data?.user?.email === email);

  const oldPassword = await call('/api/auth/login', {
    cookie: false,
    method: 'POST',
    body: { email, password: PASSWORD },
  });
  check('the old password stops working', oldPassword.status === 401, `status=${oldPassword.status}`);

  const newLogin = await call('/api/auth/login', {
    method: 'POST',
    body: { email, password: NEW_PASSWORD },
  });
  check(
    'the new password works',
    newLogin.status === 200 && newLogin.data?.user?.email === email,
    `status=${newLogin.status}`,
  );

  // --------------------------------------------- 用户管理（超级管理员 / 超级用户）
  section('admin panel');
  const ownerSession = cookie;
  const adminLogin = await call('/api/auth/login', {
    cookie: false,
    method: 'POST',
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  if (adminLogin.status === 401) {
    console.log(`  skip  admin checks  (no admin account for ${ADMIN_EMAIL} on this target)`);
  } else {
    const adminCookie = String(adminLogin.headers.get('set-cookie') ?? '').split(';')[0];
    /** 以管理员身份发请求，不碰全局 cookie（它还是上一位登录用户的会话） */
    const asAdmin = (path, options = {}) =>
      call(path, { ...options, cookie: false, headers: { cookie: adminCookie, ...(options.headers ?? {}) } });

    check('the configured admin can sign in', adminLogin.data?.user?.isAdmin === true, `status=${adminLogin.status}`);

    const anonList = await call('/api/admin/users', { cookie: false });
    check('the user list needs a session', anonList.status === 401, `status=${anonList.status}`);

    const asOwner = await call('/api/admin/users', { cookie: false, headers: { cookie: ownerSession } });
    check('a normal account is not an admin', asOwner.status === 403, `status=${asOwner.status}`);

    const list = await asAdmin(`/api/admin/users?search=${encodeURIComponent(email)}`);
    const smokeUser = (list.data?.users ?? []).find((item) => item.email === email);
    check(
      'searching by email finds the account',
      list.status === 200 && Boolean(smokeUser),
      `status=${list.status} total=${list.data?.total ?? ''} matches=${(list.data?.users ?? []).length}`,
    );
    check(
      'the user list carries counters + last seen',
      typeof smokeUser?.databaseCount === 'number' && typeof smokeUser?.sharedCount === 'number' && typeof smokeUser?.lastSeenAt === 'number',
      `tables=${smokeUser?.databaseCount ?? ''} shared=${smokeUser?.sharedCount ?? ''} lastSeen=${smokeUser?.lastSeenAt ? 'yes' : 'no'}`,
    );

    const memberList = await asAdmin(`/api/admin/users?search=${encodeURIComponent(memberEmail)}`);
    const memberUser = (memberList.data?.users ?? []).find((item) => item.email === memberEmail);
    const adminList = await asAdmin(`/api/admin/users?search=${encodeURIComponent(ADMIN_EMAIL)}`);
    const adminRow = (adminList.data?.users ?? []).find((item) => item.email === ADMIN_EMAIL);
    check(
      'the admin sees every registered user',
      Boolean(memberUser) && Boolean(adminRow),
      `member=${memberUser ? 'yes' : 'no'} admin=${adminRow ? 'yes' : 'no'}`,
    );
    check('the admin is flagged in the list', adminRow?.isAdmin === true, `isAdmin=${adminRow?.isAdmin ?? ''}`);

    const renamed = smokeUser
      ? await asAdmin(`/api/admin/users/${smokeUser.id}`, {
          method: 'PATCH',
          body: { name: 'Smoke Tester（管理员改名）' },
        })
      : { status: 0, data: null };
    check(
      'edit a user profile',
      renamed.status === 200 && renamed.data?.user?.name === 'Smoke Tester（管理员改名）',
      `status=${renamed.status} name=${renamed.data?.user?.name ?? ''}`,
    );

    const clashingEmail = smokeUser
      ? await asAdmin(`/api/admin/users/${smokeUser.id}`, { method: 'PATCH', body: { email: memberEmail } })
      : { status: 0, data: null };
    check('an email already in use is rejected', clashingEmail.status === 409, `status=${clashingEmail.status}`);

    const unknownUser = await asAdmin('/api/admin/users/does-not-exist', { method: 'PATCH', body: { name: 'nobody' } });
    check('editing an unknown user is a 404', unknownUser.status === 404, `status=${unknownUser.status}`);

    // 重置别人的密码：新密码回显给管理员（测试域不发信），对方所有会话作废
    const reset = memberUser
      ? await asAdmin(`/api/admin/users/${memberUser.id}/password`, { method: 'POST', body: {} })
      : { status: 0, data: null };
    const tempPassword = typeof reset.data?.password === 'string' ? reset.data.password : '';
    check(
      'reset another user password',
      reset.status === 200 &&
        tempPassword.length >= 8 &&
        /[A-Za-z]/.test(tempPassword) &&
        /\d/.test(tempPassword) &&
        reset.data?.sessionsRevoked === true,
      `status=${reset.status} chars=${tempPassword.length}`,
    );
    check('the reset password is echoed for test domains', reset.data?.emailed === false, `emailed=${reset.data?.emailed}`);

    const memberLogin = await call('/api/auth/login', {
      cookie: false,
      method: 'POST',
      body: { email: memberEmail, password: tempPassword },
    });
    check('the member signs in with the temporary password', memberLogin.status === 200, `status=${memberLogin.status}`);

    const deadMemberPassword = await call('/api/auth/login', {
      cookie: false,
      method: 'POST',
      body: { email: memberEmail, password: PASSWORD },
    });
    check("the member's old password stops working", deadMemberPassword.status === 401, `status=${deadMemberPassword.status}`);

    const unknownReset = await asAdmin('/api/admin/users/does-not-exist/password', { method: 'POST', body: {} });
    check('resetting an unknown user is a 404', unknownReset.status === 404, `status=${unknownReset.status}`);

    // 批量删除：把「邀请注册」那个测试账号删掉（顺便验证级联清理）
    const deleteList = await asAdmin(`/api/admin/users?search=${encodeURIComponent(inviteeEmail)}`);
    const inviteeRow = (deleteList.data?.users ?? []).find((item) => item.email === inviteeEmail);
    const deleteResult = inviteeRow
      ? await asAdmin('/api/admin/users/delete', { method: 'POST', body: { ids: [inviteeRow.id] } })
      : { status: 0, data: null };
    check(
      'the admin can delete a registered user',
      deleteResult.status === 200 && deleteResult.data?.deleted?.length === 1,
      `status=${deleteResult.status} deleted=${deleteResult.data?.deleted?.length ?? 0}`,
    );
    const afterDelete = await asAdmin(`/api/admin/users?search=${encodeURIComponent(inviteeEmail)}`);
    check(
      'the deleted user is gone from the list',
      (afterDelete.data?.users ?? []).length === 0,
      `matches=${(afterDelete.data?.users ?? []).length}`,
    );
    const deletedLogin = await call('/api/auth/login', {
      cookie: false,
      method: 'POST',
      body: { email: inviteeEmail, password: invitePassword },
    });
    check('a deleted user can no longer sign in', deletedLogin.status === 401, `status=${deletedLogin.status}`);

    // 自己的账号 / 不存在的账号：跳过而不是报错
    const adminIdForDelete = adminLogin.data?.user?.id;
    const selfDelete = adminIdForDelete
      ? await asAdmin('/api/admin/users/delete', { method: 'POST', body: { ids: [adminIdForDelete] } })
      : { status: 0, data: null };
    check(
      'the admin cannot delete their own account',
      selfDelete.status === 200 &&
        selfDelete.data?.deleted?.length === 0 &&
        String(selfDelete.data?.skipped?.[0]?.reason ?? '').includes('自己'),
      `deleted=${selfDelete.data?.deleted?.length ?? 0} reason=${selfDelete.data?.skipped?.[0]?.reason ?? ''}`,
    );
    const emptyDelete = await asAdmin('/api/admin/users/delete', { method: 'POST', body: { ids: [] } });
    check('deleting nothing is a 400', emptyDelete.status === 400, `status=${emptyDelete.status}`);
    const unknownDelete = await asAdmin('/api/admin/users/delete', { method: 'POST', body: { ids: ['does-not-exist'] } });
    check(
      'deleting an unknown account is reported as skipped',
      unknownDelete.status === 200 && unknownDelete.data?.skipped?.length === 1,
      `status=${unknownDelete.status} skipped=${unknownDelete.data?.skipped?.length ?? 0}`,
    );

    // 给自己重置：连自己当前的会话也一起作废，必须重新登录
    // 只有测试管理员才真做 —— 真实管理员会被改密码（回写成 Secret 值）并踢下线
    const adminId = adminLogin.data?.user?.id;
    if (!DISPOSABLE_ADMIN) {
      console.log(`  skip  self reset  (${ADMIN_EMAIL} 不是测试管理员，不动它的密码)`);
    } else {
      const selfReset = adminId
        ? await asAdmin(`/api/admin/users/${adminId}/password`, { method: 'POST', body: { password: ADMIN_PASSWORD } })
        : { status: 0, data: null };
      check(
        'resetting your own password is flagged',
        selfReset.status === 200 && selfReset.data?.resetSelf === true,
        `status=${selfReset.status}`,
      );
      const afterSelfReset = await asAdmin('/api/session');
      check('the self reset revokes the admin session', afterSelfReset.data?.user === null);
    }
  }
  cookie = ownerSession;

  section('cleanup');
  const deletedDatabase = await call(`/api/databases/${databaseId}`, { method: 'DELETE' });
  check('delete table', deletedDatabase.data?.ok === true);

  const finalSession = await call('/api/session');
  check(
    'table list no longer contains it',
    (finalSession.data?.databases ?? []).every((item) => item.id !== databaseId),
    `${finalSession.data?.databases?.length ?? 0} table(s) left`,
  );

  const loggedOut = await call('/api/auth/logout', { method: 'POST' });
  check('logout', loggedOut.data?.ok === true);
  const afterLogout = await call('/api/session');
  check('session cleared', afterLogout.data?.user === null);

  const failed = checks.filter((item) => !item.ok);
  console.log(`\n${'-'.repeat(52)}`);
  console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) {
    console.error('failing checks:');
    for (const item of failed) console.error(`  - ${item.name}`);
  }
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => {
  console.error('\nsmoke test crashed:', error);
  process.exitCode = 1;
});


