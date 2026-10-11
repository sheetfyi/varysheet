/** Password hashing (PBKDF2-SHA256 via WebCrypto) and cookie based sessions. */
import {
  base64UrlDecode,
  base64UrlEncode,
  forbidden,
  getCookie,
  newId,
  randomToken,
  serializeCookie,
  sha256Hex,
  sqlNumber,
  sqlString,
  unauthorized,
  type SqlRow,
} from './http';
import type { SessionToken } from '../shared/types';
import type { AuthedUser, Env } from './types';

export const SESSION_COOKIE = 'cn_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_ITERATIONS = 100_000;

function iterationsFrom(env: Env): number {
  const raw = (env as unknown as Record<string, unknown>).PASSWORD_ITERATIONS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 10_000 ? parsed : DEFAULT_ITERATIONS;
}

/* -------------------------------------------------------------- passwords */

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256,
  );
  return new Uint8Array(bits);
}

/** Format: `pbkdf2$sha256$<iterations>$<saltB64>$<hashB64>` */
export async function hashPassword(password: string, env: Env): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const iterations = iterationsFrom(env);
  const hash = await derive(password, salt, iterations);
  return ['pbkdf2', 'sha256', String(iterations), toBase64(salt), toBase64(hash)].join('$');
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 5 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[2]);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;
  try {
    const hash = await derive(password, fromBase64(parts[3]), iterations);
    return constantTimeEqual(toBase64(hash), parts[4]);
  } catch {
    return false;
  }
}

export function validatePasswordStrength(password: string): string | null {
  if (password.length < 8) return '密码至少需要 8 个字符';
  if (password.length > 200) return '密码过长';
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return '密码需同时包含字母和数字';
  return null;
}

/** 临时密码用的字符集：大小写字母 + 数字，去掉了容易看错的 I l 1 O 0 */
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

function randomIndex(max: number): number {
  const buffer = new Uint32Array(1);
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  let value = 0;
  do {
    crypto.getRandomValues(buffer);
    value = buffer[0] ?? 0;
  } while (value >= limit);
  return value % max;
}

/**
 * 生成一个满足强度要求（含字母与数字）的临时密码，用于「管理员重置密码」与
 * 登录页的「找回密码」（用户自己忘了密码时系统发一封新的临时密码给他）。
 */
export function generatePassword(length = 12): string {
  let password = '';
  for (let index = 0; index < length; index += 1) password += PASSWORD_ALPHABET[randomIndex(PASSWORD_ALPHABET.length)];
  if (!/\d/.test(password)) {
    const digit = String(randomIndex(10));
    const at = randomIndex(password.length);
    password = `${password.slice(0, at)}${digit}${password.slice(at + 1)}`;
  }
  return password;
}

/* --------------------------------------------------------------- sessions */

export async function createSession(
  env: Env,
  userId: string,
): Promise<{ token: string; expiresAt: number }> {
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(newId(), userId, tokenHash, now, expiresAt, now)
    .run();
  return { token, expiresAt };
}

export async function destroySession(env: Env, token: string): Promise<void> {
  const tokenHash = await sha256Hex(token);
  await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
}

/**
 * 这次请求携带的会话令牌：优先 HttpOnly cookie，其次 `Authorization: Bearer <token>`。
 *
 * 手机浏览器（无痕模式、「阻止所有 Cookie」、部分 App 内嵌浏览器）会把 `Set-Cookie`
 * 丢掉，表现为「登录接口返回 200，但下一个请求就变成未登录」——页面会闪一下又回到
 * 登录页。这种环境里客户端会把登录响应里的令牌存在本地，并用 `Authorization` 头带上，
 * 所以服务端两种来源都要认（cookie 优先，保持原有行为不变）。
 */
export function sessionTokenFrom(request: Request): string | null {
  const cookie = getCookie(request, SESSION_COOKIE);
  if (cookie) return cookie;
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

/**
 * 这个请求要不要把会话令牌放进响应体。
 *
 * 默认会话只走 HttpOnly cookie；上面那些会把 `Set-Cookie` 丢掉的环境里，前端会带
 * `tokenInBody: true` 再登一次，把令牌存在本地并由 `Authorization` 头带上。
 * 令牌按需下发，正常浏览器拿不到，安全性不受影响。
 */
export function wantsTokenInBody(body: Record<string, unknown>): boolean {
  return body.tokenInBody === true;
}

/** 会话令牌的响应体形态（只在客户端要求时下发）。 */
export function sessionTokenPayload(session: { token: string; expiresAt: number }): SessionToken {
  return { token: session.token, expiresAt: session.expiresAt };
}

export async function getCurrentUser(request: Request, env: Env): Promise<AuthedUser | null> {
  const token = sessionTokenFrom(request);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT s.id AS session_id, s.expires_at, u.id, u.email, u.name, u.is_admin
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
  )
    .bind(tokenHash)
    .first<SqlRow>();
  if (!row) return null;
  const expiresAt = sqlNumber(row, 'expires_at');
  if (!expiresAt || expiresAt < Date.now()) {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sqlString(row, 'session_id')).run();
    return null;
  }
  return {
    id: sqlString(row, 'id'),
    email: sqlString(row, 'email'),
    name: sqlString(row, 'name'),
    isAdmin: sqlNumber(row, 'is_admin') === 1,
  };
}

export async function requireUser(request: Request, env: Env): Promise<AuthedUser> {
  const user = await getCurrentUser(request, env);
  if (!user) throw unauthorized();
  return user;
}

/** 管理员才有权限的接口（`users.is_admin = 1`）。 */
export async function requireAdmin(request: Request, env: Env): Promise<AuthedUser> {
  const user = await requireUser(request, env);
  if (!user.isAdmin) throw forbidden('只有管理员可以访问用户管理');
  return user;
}

/**
 * 这次请求是不是走的安全协议（决定会话 cookie 要不要带 `Secure`）。
 *
 * `Secure` 的 cookie 在 http 页面上会被浏览器**直接丢弃**（`localhost` 是特例，
 * 所以本机开发时看不出问题）—— 手机通过局域网 IP（`http://192.168.x.x:...`）
 * 访问时就会「登录接口返回 200，但会话没保存下来」，看起来像登录失败。
 * 所以只有 https（含反向代理透传的 `x-forwarded-proto`）才加 `Secure`。
 */
export function isSecureRequest(request: Request): boolean {
  if (new URL(request.url).protocol === 'https:') return true;
  return (request.headers.get('x-forwarded-proto') ?? '').toLowerCase().startsWith('https');
}

export function sessionCookie(token: string, secure = true): string {
  return serializeCookie(SESSION_COOKIE, token, {
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
    httpOnly: true,
    secure,
    sameSite: 'Lax',
  });
}

export function clearedSessionCookie(secure = true): string {
  return serializeCookie(SESSION_COOKIE, '', { maxAge: 0, httpOnly: true, secure, sameSite: 'Lax' });
}

/** 当前请求的会话令牌哈希（改密码时用来「保留自己、踢掉其它设备」）。 */
export async function currentSessionHash(request: Request): Promise<string | null> {
  const token = sessionTokenFrom(request);
  return token ? sha256Hex(token) : null;
}

/* ---------------------------------------------------------------- helpers */

export function assertSignupAllowed(env: Env): void {
  const allow = (env.ALLOW_SIGNUP ?? 'true').toLowerCase();
  if (allow === 'false') throw forbidden('注册功能已关闭，请联系管理员');
}

/** House-keeping: drop expired sessions (called from the worker entry point). */
export async function purgeExpiredSessions(env: Env): Promise<void> {
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(Date.now()).run();
}


export { base64UrlDecode, base64UrlEncode };
