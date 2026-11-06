/**
 * Telegram Mini App authentication.
 *
 * Telegram hands the Mini App a URL-encoded `initData` string that is signed
 * with the bot token. This module validates that signature (per Telegram's
 * documented HMAC-SHA256 scheme) and exchanges it for a normal Uptime Detective
 * JWT, using an auto-created shadow `users` row for the Telegram account.
 *
 * Security notes:
 *  - The HMAC comparison is constant time (`crypto.timingSafeEqual`).
 *  - `initData` ages out (default 24h) to limit replay of stolen payloads.
 *  - Only Telegram users present in the bot allow list get a token.
 */
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import type { TelegramWebAppAuthResponse, UserRole } from '@uptime-detective/shared';
import { getDb } from '../../db/connection.js';
import { signToken } from '../../middleware/auth.js';
import { getTelegramConfig } from './config.js';
import { isTelegramUserAllowed, trackTelegramUser } from './allowlist.js';
import type { TelegramUserInfo } from './types.js';

export class TelegramWebAppAuthError extends Error {
  status: number;

  constructor(message: string, status = 401) {
    super(message);
    this.name = 'TelegramWebAppAuthError';
    this.status = status;
  }
}

export type TelegramInitDataValidation =
  | { ok: true; user: TelegramUserInfo; authDate: number }
  | { ok: false; error: string };

const DEFAULT_AUTH_MAX_AGE_SECONDS = 86_400;
const MAX_CLOCK_SKEW_SECONDS = 300;

interface ShadowUserRow {
  id: number;
  username: string;
  role: UserRole;
}

/** Maximum accepted age of `initData`, in seconds (`TELEGRAM_WEBAPP_AUTH_MAX_AGE`). */
export function getWebAppAuthMaxAgeSeconds(): number {
  const raw = Number(process.env.TELEGRAM_WEBAPP_AUTH_MAX_AGE);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_AUTH_MAX_AGE_SECONDS;
  return Math.floor(raw);
}

function hmacSha256Hex(key: Buffer | string, message: string): string {
  return crypto.createHmac('sha256', key).update(message, 'utf8').digest('hex');
}

/** Constant-time comparison of two hex-encoded digests. */
function timingSafeHexEqual(computedHex: string, providedHex: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(providedHex)) return false;
  const computed = Buffer.from(computedHex, 'hex');
  const provided = Buffer.from(providedHex, 'hex');
  if (computed.length !== provided.length) return false;
  return crypto.timingSafeEqual(computed, provided);
}

/**
 * Validate a Telegram Mini App `initData` query string against the bot token.
 * Returns the parsed user on success and a short human-readable error otherwise.
 */
export function validateTelegramInitData(
  initData: string,
  botToken: string
): TelegramInitDataValidation {
  if (!initData || typeof initData !== 'string' || initData.trim() === '') {
    return { ok: false, error: 'Missing Telegram init data' };
  }
  if (!botToken) {
    return { ok: false, error: 'Telegram bot token is not configured' };
  }

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return { ok: false, error: 'Malformed Telegram init data' };
  }

  const providedHash = params.get('hash');
  if (!providedHash) {
    return { ok: false, error: 'Telegram init data is missing the hash' };
  }

  // data_check_string = every field except hash, sorted by key, "key=value" joined by "\n".
  const pairs: [string, string][] = [];
  for (const [key, value] of params.entries()) {
    if (key !== 'hash') pairs.push([key, value]);
  }
  if (pairs.length === 0) {
    return { ok: false, error: 'Malformed Telegram init data' };
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const dataCheckString = pairs.map(([key, value]) => `${key}=${value}`).join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken, 'utf8').digest();
  const computedHash = hmacSha256Hex(secretKey, dataCheckString);
  if (!timingSafeHexEqual(computedHash, providedHash)) {
    return { ok: false, error: 'Invalid Telegram init data signature' };
  }

  const authDateRaw = params.get('auth_date');
  if (!authDateRaw || !/^\d+$/.test(authDateRaw)) {
    return { ok: false, error: 'Telegram init data is missing auth_date' };
  }
  const authDate = Number(authDateRaw);
  const now = Math.floor(Date.now() / 1000);
  if (authDate > now + MAX_CLOCK_SKEW_SECONDS) {
    return { ok: false, error: 'Telegram init data auth_date is in the future' };
  }
  if (now - authDate > getWebAppAuthMaxAgeSeconds()) {
    return { ok: false, error: 'Telegram init data has expired' };
  }

  const userRaw = params.get('user');
  if (!userRaw) {
    return { ok: false, error: 'Telegram init data is missing the user' };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(userRaw);
  } catch {
    return { ok: false, error: 'Telegram init data has an invalid user payload' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Telegram init data has an invalid user payload' };
  }

  const id = Number(parsed.id);
  if (!Number.isInteger(id) || id <= 0) {
    return { ok: false, error: 'Telegram init data has an invalid user id' };
  }
  if (parsed.is_bot === true) {
    return { ok: false, error: 'Telegram bot accounts are not allowed' };
  }

  const user: TelegramUserInfo = {
    id,
    is_bot: false,
    first_name: typeof parsed.first_name === 'string' ? parsed.first_name : '',
  };
  if (typeof parsed.last_name === 'string') user.last_name = parsed.last_name;
  if (typeof parsed.username === 'string') user.username = parsed.username;
  if (typeof parsed.language_code === 'string') user.language_code = parsed.language_code;

  return { ok: true, user, authDate };
}

/**
 * Find the local shadow user for a Telegram account: `tg_<id>` (or a previously
 * suffixed variant if the base username was taken by another row).
 */
function findShadowUser(telegramUserId: number): ShadowUserRow | null {
  const db = getDb();
  const base = `tg_${telegramUserId}`;
  const exact = db
    .prepare('SELECT id, username, role FROM users WHERE username = ?')
    .get(base) as ShadowUserRow | undefined;
  if (exact) return exact;

  const suffixed = db
    .prepare("SELECT id, username, role FROM users WHERE username LIKE ? ESCAPE '\\' ORDER BY id ASC LIMIT 1")
    .get(`tg\\_${telegramUserId}\\_%`) as ShadowUserRow | undefined;
  return suffixed ?? null;
}

/**
 * Create (or return) the local admin user used by a Telegram Mini App session.
 * The random password hash keeps password login impossible for shadow users.
 */
async function getOrCreateShadowUser(telegramUserId: number): Promise<ShadowUserRow> {
  const existing = findShadowUser(telegramUserId);
  if (existing) return existing;

  const db = getDb();
  const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
  const base = `tg_${telegramUserId}`;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const username =
      attempt === 0 ? base : `${base}_${crypto.randomBytes(3).toString('hex')}`;
    try {
      const result = db
        .prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')")
        .run(username, passwordHash);
      return { id: Number(result.lastInsertRowid), username, role: 'admin' };
    } catch (err: any) {
      const message = String(err?.message ?? '');
      if (!/UNIQUE constraint failed/i.test(message)) {
        throw new TelegramWebAppAuthError('Could not create a local user for the Telegram account', 500);
      }
      // A concurrent request may have created it — reuse that row if so.
      const reuse = db
        .prepare('SELECT id, username, role FROM users WHERE username = ?')
        .get(username) as ShadowUserRow | undefined;
      if (reuse) return reuse;
    }
  }

  throw new TelegramWebAppAuthError('Could not create a local user for the Telegram account', 500);
}

/**
 * Authenticate a Telegram Mini App session from its `initData`.
 * Throws `TelegramWebAppAuthError` (400 malformed / 401 invalid / 403 not allowed).
 */
export async function authenticateTelegramWebApp(
  initData: string
): Promise<TelegramWebAppAuthResponse> {
  const config = getTelegramConfig();
  if (!config.bot_token) {
    throw new TelegramWebAppAuthError(
      'Telegram bot is not configured on this instance',
      503
    );
  }

  const validation = validateTelegramInitData(initData, config.bot_token);
  if (!validation.ok) {
    // Malformed payloads are a client error (400); a well-formed payload with a
    // bad signature or stale auth_date is an authentication failure (401).
    const malformed =
      validation.error === 'Missing Telegram init data' ||
      validation.error === 'Malformed Telegram init data' ||
      validation.error.includes('missing the hash') ||
      validation.error.includes('missing auth_date') ||
      validation.error.includes('missing the user') ||
      validation.error.includes('invalid user payload') ||
      validation.error.includes('invalid user id');
    throw new TelegramWebAppAuthError(validation.error, malformed ? 400 : 401);
  }

  const telegramUser = validation.user;
  trackTelegramUser(telegramUser);

  if (!isTelegramUserAllowed(telegramUser.id)) {
    throw new TelegramWebAppAuthError(
      'Telegram user is not allowed. Ask an instance admin to allow your account.',
      403
    );
  }

  const localUser = await getOrCreateShadowUser(telegramUser.id);
  const token = signToken({ id: localUser.id, username: localUser.username, role: localUser.role });

  return {
    token,
    user: {
      id: localUser.id,
      username: localUser.username,
      role: localUser.role,
    },
    telegram_user: {
      id: telegramUser.id,
      username: telegramUser.username ?? null,
    },
  };
}
