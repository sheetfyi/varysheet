#!/usr/bin/env node
/**
 * Static sanity check for the Worker route table.
 *
 * Verifies that:
 *   - every `{ method, path, handler }` entry points at a function that is
 *     actually defined in the same file
 *   - no two routes share the same method + shape (`:param` becomes a wildcard)
 *   - paths are absolute (`/api/...`) and use `:name` for parameters
 *
 * Run with:  npm run check:routes
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const routesDir = resolve(here, '..', 'src', 'worker', 'routes');

const ROUTE_RE = /\{\s*method:\s*'([A-Z_]+)'\s*,\s*path:\s*'([^']+)'\s*,\s*handler:\s*([A-Za-z0-9_$]+)\s*\}/g;
const DEF_RE = /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g;
const CONST_FN_RE = /(?:^|\n)\s*(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*[:=]/g;

/** `/api/records/:id` -> `/api/records/*` so parameter names may differ. */
function shape(path) {
  return path.replace(/:[A-Za-z0-9_]+/g, '*');
}

const problems = [];
const rows = [];
const seen = new Map();

for (const file of readdirSync(routesDir).filter((name) => name.endsWith('.ts')).sort()) {
  const source = readFileSync(join(routesDir, file), 'utf8');

  const defined = new Set();
  for (const regex of [DEF_RE, CONST_FN_RE]) {
    regex.lastIndex = 0;
    let found;
    while ((found = regex.exec(source)) !== null) defined.add(found[1]);
  }

  let match;
  ROUTE_RE.lastIndex = 0;
  while ((match = ROUTE_RE.exec(source)) !== null) {
    const [, method, path, handler] = match;
    rows.push({ file, method, path, handler });

    if (!path.startsWith('/')) problems.push(`${file}: path must start with "/" (got ${path})`);
    if (path.length > 1 && path.endsWith('/')) problems.push(`${file}: path must not end with "/" (got ${path})`);
    if (!defined.has(handler)) problems.push(`${file}: handler ${handler}() is not defined in this file`);

    const key = `${method} ${shape(path)}`;
    const previous = seen.get(key);
    if (previous) problems.push(`duplicate route ${method} ${path} (${file}) vs ${previous.path} (${previous.file})`);
    else seen.set(key, { file, path });
  }

  if (!source.includes('export const') || !source.includes('Routes: Route[]')) {
    problems.push(`${file}: does not export a "*Routes: Route[]" array`);
  }
}

if (!rows.length) problems.push('no routes found - did the route syntax change?');

const order = { GET: 0, POST: 1, PATCH: 2, PUT: 3, DELETE: 4 };
rows.sort((a, b) => {
  const byPath = a.path.localeCompare(b.path);
  if (byPath !== 0) return byPath;
  return (order[a.method] ?? 9) - (order[b.method] ?? 9);
});

const width = Math.max(...rows.map((row) => row.method.length));
console.log(`Varysheet API surface - ${rows.length} routes\n`);
for (const row of rows) {
  console.log(`  ${row.method.padEnd(width)}  ${row.path.padEnd(44)} ${row.file}`);
}

// public, unauthenticated endpoints should never be nested under a table id
const publicPaths = rows.filter((row) => row.path.startsWith('/api/public/'));
console.log(`\n  public endpoints: ${publicPaths.length ? publicPaths.map((r) => r.path).join(', ') : 'none'}`);

if (problems.length) {
  console.error('\nRoute problems:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log('\nOK: no duplicate routes, all handlers defined.');
