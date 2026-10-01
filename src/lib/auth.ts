import type { SessionUser, Sql } from '../types';

// Cloudflare Workers caps PBKDF2 at 100k iterations.
const PBKDF2_ITERATIONS = 100_000;
export const SESSION_COOKIE = 'ev_session';
export const SESSION_DAYS = 30;

const enc = new TextEncoder();

function toB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));
}

function toHex(bytes: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toB64(salt)}$${toB64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iter, salt, hash] = stored.split('$');
  if (scheme !== 'pbkdf2' || !iter || !salt || !hash) return false;
  const actual = await pbkdf2(password, fromB64(salt), Number(iter));
  return timingSafeEqual(actual, fromB64(hash));
}

export function randomToken(bytes = 32): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(input: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(input)));
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

export async function createSession(sql: Sql, userId: number): Promise<string> {
  const token = randomToken();
  await sql`
    INSERT INTO sessions (token_hash, user_id, expires_at)
    VALUES (${await sha256Hex(token)}, ${userId}, now() + make_interval(days => ${SESSION_DAYS}))`;
  return token;
}

export async function getSessionUser(sql: Sql, token: string): Promise<SessionUser | null> {
  const rows = await sql`
    SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ${await sha256Hex(token)} AND s.expires_at > now()`;
  const row = rows[0];
  return row ? { id: Number(row.id), email: row.email } : null;
}

export async function deleteSession(sql: Sql, token: string): Promise<void> {
  await sql`DELETE FROM sessions WHERE token_hash = ${await sha256Hex(token)}`;
}
