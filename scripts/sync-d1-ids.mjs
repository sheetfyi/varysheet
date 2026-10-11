#!/usr/bin/env node
// 把 wrangler.jsonc 里 D1 库的 database_id 对齐到「当前账户」：
//   1. 优先用环境变量覆盖：D1_DATABASE_ID / D1_TABLES_TRIAL_ID / D1_TABLES_BASIC_ID /
//      D1_TABLES_PRO_ID（CI 里由仓库 Secrets 提供，见 DEPLOY.md 6.3）
//   2. 其次按「库名」在本账户里查：database_id 会随账户变，库名才是不变的身份，
//      所以换账户 / 重新建库后只要跑一次这个脚本就能修好
//   3. 本账户里没有这个名字的库、且带了 --create 时，调 `wrangler d1 create` 现建一个
//
// 用法：
//   node scripts/sync-d1-ids.mjs                  # 按库名回填 wrangler.jsonc
//   node scripts/sync-d1-ids.mjs --create         # 缺库就建（需要 Account > D1 > Edit）
//   node scripts/sync-d1-ids.mjs --check          # 只检查、不写文件（需要改时退出码 1）
//   node scripts/sync-d1-ids.mjs --list d1.json   # 离线：读一份 `wrangler d1 list --json` 的结果
//   node scripts/sync-d1-ids.mjs --config x.jsonc # 指定要改的配置文件（默认 wrangler.jsonc）
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** 绑定名 -> 可覆盖它的环境变量（CI Secrets / 本地环境变量） */
const ENV_OVERRIDES = {
  DB: 'D1_DATABASE_ID',
  DB_TABLES_TRIAL: 'D1_TABLES_TRIAL_ID',
  DB_TABLES_BASIC: 'D1_TABLES_BASIC_ID',
  DB_TABLES_PRO: 'D1_TABLES_PRO_ID',
};

function parseArgs(argv) {
  const flags = { config: 'wrangler.jsonc', create: false, check: false, list: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--create') flags.create = true;
    else if (arg === '--check') flags.check = true;
    else if (arg === '--config') flags.config = argv[(i += 1)] ?? '';
    else if (arg === '--list') flags.list = argv[(i += 1)] ?? '';
    else throw new Error(`未知参数：${arg}（可用：--create --check --config <file> --list <file>）`);
  }
  return flags;
}

function wrangler(args) {
  return execFileSync('npx', ['wrangler', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
}

/** 从 wrangler.jsonc 里抠出 d1_databases 的每个绑定（扁平对象，不会有嵌套大括号）。 */
function parseBindings(text) {
  const bindings = [];
  const blockRe = /\{[^{}]*"binding"\s*:\s*"([^"]+)"[^{}]*\}/g;
  for (const match of text.matchAll(blockRe)) {
    const block = match[0];
    if (!/"database_name"\s*:/.test(block) || !/"database_id"\s*:/.test(block)) continue;
    bindings.push({
      binding: match[1],
      name: /"database_name"\s*:\s*"([^"]*)"/.exec(block)?.[1] ?? '',
      id: /"database_id"\s*:\s*"([^"]*)"/.exec(block)?.[1] ?? '',
    });
  }
  return bindings;
}

const pickId = (row) => (typeof (row?.uuid ?? row?.id ?? row?.database_id) === 'string' ? row.uuid ?? row.id ?? row.database_id : '');
const pickName = (row) => (typeof (row?.name ?? row?.database_name) === 'string' ? row.name ?? row.database_name : '');

/** 账户下的 D1 库列表（name -> uuid） */
function loadAccountDatabases(flags) {
  let raw;
  if (flags.list) {
    raw = readFileSync(flags.list, 'utf8');
  } else {
    try {
      raw = wrangler(['d1', 'list', '--json']);
    } catch (error) {
      const detail = `${error.stdout ?? ''}${error.stderr ?? ''}`;
      if (/10000|Authentication error|9109|Unauthorized/i.test(detail)) {
        throw new Error('CLOUDFLARE_API_TOKEN 缺少 Account > D1 > Edit 权限（wrangler d1 list 被拒），见 DEPLOY.md 6.1');
      }
      throw new Error(`wrangler d1 list 失败：${detail.trim().split('\n').slice(-3).join(' / ')}`);
    }
  }
  const parsed = JSON.parse(raw);
  const rows = Array.isArray(parsed) ? parsed : (parsed.result ?? []);
  const byName = new Map();
  for (const row of rows) {
    const name = pickName(row);
    const id = pickId(row);
    if (name && id) byName.set(name, id);
  }
  return byName;
}

/** 现建一个库；同名库已存在时返回 existed（调用方再查一次拿 id） */
function createDatabase(name) {
  let output = '';
  try {
    output = wrangler(['d1', 'create', name]);
  } catch (error) {
    const detail = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    if (/already exists|10013/i.test(detail)) return { id: '', existed: true };
    throw new Error(`wrangler d1 create ${name} 失败：${detail.trim().split('\n').slice(-3).join(' / ')}`);
  }
  const id = /database_id"?\s*[=:]\s*"?([0-9a-fA-F-]{36})/.exec(output)?.[1] ?? '';
  if (!id) throw new Error(`已创建 ${name}，但没能从输出里读出 database_id，请手工回填 wrangler.jsonc`);
  return { id, existed: false };
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  const text = readFileSync(flags.config, 'utf8');
  const bindings = parseBindings(text);
  if (!bindings.length) throw new Error(`${flags.config} 里没找到 d1_databases 绑定`);

  let accountDatabases = null;
  const plan = [];
  for (const item of bindings) {
    const envName = ENV_OVERRIDES[item.binding] ?? '';
    const override = envName ? (process.env[envName] ?? '').trim() : '';
    let next = item.id;
    let source = '保持原值';
    let status = '';

    if (override) {
      if (!UUID_RE.test(override)) throw new Error(`${envName} 不是 8-4-4-4-12 形式的 UUID：${override}`);
      next = override;
      source = envName;
    } else {
      accountDatabases ??= loadAccountDatabases(flags);
      if (accountDatabases.get(item.name)) {
        next = accountDatabases.get(item.name);
        source = '账户里同名库';
      } else if (flags.create) {
        const created = createDatabase(item.name);
        if (created.id) {
          accountDatabases.set(item.name, created.id);
          next = created.id;
          source = '新建';
        } else {
          // 同名库其实已存在（并发 / 重跑），重新查一次拿 id
          accountDatabases = loadAccountDatabases(flags);
          next = accountDatabases.get(item.name) ?? item.id;
          source = '账户里同名库';
        }
      } else {
        status = '⚠️ 账户里没有这个库（加 --create 现建）';
      }
    }

    if (!status) status = next === item.id ? '✅ 已一致' : '✅ 已回填';
    plan.push({ ...item, next, source, status });
  }

  const width = Math.max(...plan.map((item) => item.name.length));
  for (const item of plan) {
    console.log(
      `${item.name.padEnd(width)}  ${item.binding.padEnd(16)} ${item.status}  ` +
        `(${item.id || '空'} -> ${item.next || '空'}${item.source === '保持原值' ? '' : ` · ${item.source}`})`,
    );
  }

  const changed = plan.filter((item) => item.next && item.next !== item.id);
  if (!changed.length) {
    console.log('无需改动。');
    return;
  }
  if (flags.check) {
    console.error(`\n有 ${changed.length} 个 database_id 需要更新：node scripts/sync-d1-ids.mjs`);
    process.exitCode = 1;
    return;
  }
  let out = text;
  for (const item of changed) {
    const re = new RegExp(`\\{[^{}]*"binding"\\s*:\\s*"${item.binding}"[^{}]*\\}`);
    out = out.replace(re, (block) => block.replace(/"database_id"\s*:\s*"[^"]*"/, `"database_id": "${item.next}"`));
  }
  writeFileSync(flags.config, out);
  console.log(`\n已更新 ${flags.config}（${changed.length} 个 database_id）。`);
}

try {
  main();
} catch (error) {
  console.error(`✖ ${error.message}`);
  process.exitCode = 1;
}
