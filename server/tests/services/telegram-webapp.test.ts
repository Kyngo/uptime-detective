/**
 * Unit tests for Telegram Mini App authentication (webapp.ts).
 *
 * The initData signatures are generated in the test with the documented
 * Telegram algorithm (`HMAC_SHA256("WebAppData", bot_token)` → HMAC over the
 * sorted data-check string), so these are real valid/invalid HMAC vectors and
 * not self-fulfilling mocks.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import Database from 'better-sqlite3';

let testDb: Database.Database;

vi.mock('../../src/db/connection.js', () => ({
  getDb: () => testDb,
}));

import {
  authenticateTelegramWebApp,
  TelegramWebAppAuthError,
  validateTelegramInitData,
} from '../../src/services/telegram/webapp.js';

const BOT_TOKEN = '123456789:AAFakeTokenForTests_1234567890';

const ENV_KEYS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBAPP_AUTH_MAX_AGE', 'TELEGRAM_API_BASE_URL'] as const;
const originalEnv: Record<string, string | undefined> = {};

function currentAuthDate(offsetSeconds = 0): string {
  return String(Math.floor(Date.now() / 1000) + offsetSeconds);
}

/** Build a Telegram-style signed initData query string. */
function buildInitData(fields: Record<string, string>, botToken = BOT_TOKEN): string {
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const params = new URLSearchParams(fields);
  params.set('hash', hash);
  return params.toString();
}

function initDataFor(
  overrides: Record<string, string> = {},
  user: Record<string, unknown> = {
    id: 42,
    first_name: 'Alice',
    last_name: 'Example',
    username: 'alice_tg',
    language_code: 'en',
  }
): string {
  return buildInitData({
    auth_date: currentAuthDate(),
    query_id: 'AAExampleQueryId',
    user: JSON.stringify(user),
    ...overrides,
  });
}

function allowTelegramId(id: number, username: string | null = null): void {
  testDb
    .prepare('INSERT INTO telegram_users (telegram_user_id, username, is_allowed) VALUES (?, ?, 1)')
    .run(id, username);
}

async function captureAuthError(initData: string): Promise<TelegramWebAppAuthError> {
  try {
    await authenticateTelegramWebApp(initData);
  } catch (error) {
    return error as TelegramWebAppAuthError;
  }
  throw new Error('Expected authenticateTelegramWebApp to reject');
}

describe('Telegram Mini App authentication', () => {
  beforeAll(() => {
    for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_WEBAPP_AUTH_MAX_AGE;
    delete process.env.TELEGRAM_API_BASE_URL;

    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    testDb.pragma('foreign_keys = ON');
    testDb.exec(`
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT DEFAULT 'admin' CHECK(role IN ('admin', 'viewer')),
        api_token TEXT UNIQUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE telegram_users (
        telegram_user_id INTEGER PRIMARY KEY,
        chat_id INTEGER,
        username TEXT,
        first_name TEXT,
        last_name TEXT,
        is_allowed INTEGER NOT NULL DEFAULT 0,
        allowed_by INTEGER,
        last_seen_at DATETIME,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
  });

  afterAll(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    testDb.close();
  });

  beforeEach(() => {
    testDb.exec('DELETE FROM users; DELETE FROM telegram_users; DELETE FROM settings;');
    delete process.env.TELEGRAM_WEBAPP_AUTH_MAX_AGE;
    testDb
      .prepare("INSERT INTO settings (key, value) VALUES ('telegram_bot_token', ?)")
      .run(BOT_TOKEN);
  });

  describe('validateTelegramInitData', () => {
    it('accepts a correctly signed payload and returns the Telegram user', () => {
      const result = validateTelegramInitData(initDataFor(), BOT_TOKEN);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.user.id).toBe(42);
      expect(result.user.username).toBe('alice_tg');
      expect(result.user.is_bot).toBe(false);
      expect(result.authDate).toBeGreaterThan(0);
    });

    it('rejects a tampered hash', () => {
      const params = new URLSearchParams(initDataFor());
      params.set('hash', '0'.repeat(64));
      const result = validateTelegramInitData(params.toString(), BOT_TOKEN);

      expect(result).toEqual({ ok: false, error: 'Invalid Telegram init data signature' });
    });

    it('rejects a payload whose fields were modified after signing', () => {
      const params = new URLSearchParams(initDataFor());
      params.set('user', JSON.stringify({ id: 99, first_name: 'Mallory', is_bot: false }));
      const result = validateTelegramInitData(params.toString(), BOT_TOKEN);

      expect(result.ok).toBe(false);
    });

    it('rejects a signature produced with a different bot token', () => {
      const result = validateTelegramInitData(
        initDataFor({}, { id: 42, first_name: 'Alice' }),
        '987654321:OtherToken_abcdefghijklmnop'
      );
      // Signature was generated with BOT_TOKEN, validated against another token.
      expect(result.ok).toBe(false);
    });

    it('rejects a malformed hash that is not a hex digest', () => {
      const params = new URLSearchParams(initDataFor());
      params.set('hash', 'not-a-hex-digest');
      const result = validateTelegramInitData(params.toString(), BOT_TOKEN);

      expect(result).toEqual({ ok: false, error: 'Invalid Telegram init data signature' });
    });

    it('rejects a missing hash', () => {
      const params = new URLSearchParams(initDataFor());
      params.delete('hash');
      const result = validateTelegramInitData(params.toString(), BOT_TOKEN);

      expect(result).toEqual({ ok: false, error: 'Telegram init data is missing the hash' });
    });

    it('rejects a missing auth_date', () => {
      const signed = buildInitData({
        user: JSON.stringify({ id: 42, first_name: 'Alice' }),
      });
      const result = validateTelegramInitData(signed, BOT_TOKEN);

      expect(result).toEqual({ ok: false, error: 'Telegram init data is missing auth_date' });
    });

    it('rejects expired init data (default 24h max age)', () => {
      const result = validateTelegramInitData(
        initDataFor({ auth_date: currentAuthDate(-86_401) }),
        BOT_TOKEN
      );

      expect(result).toEqual({ ok: false, error: 'Telegram init data has expired' });
    });

    it('honours TELEGRAM_WEBAPP_AUTH_MAX_AGE', () => {
      process.env.TELEGRAM_WEBAPP_AUTH_MAX_AGE = '60';

      const fresh = validateTelegramInitData(initDataFor({ auth_date: currentAuthDate(-30) }), BOT_TOKEN);
      expect(fresh.ok).toBe(true);

      const stale = validateTelegramInitData(initDataFor({ auth_date: currentAuthDate(-120) }), BOT_TOKEN);
      expect(stale).toEqual({ ok: false, error: 'Telegram init data has expired' });
    });

    it('rejects a non-numeric Telegram user id', () => {
      const result = validateTelegramInitData(
        initDataFor({}, { id: 'forty-two', first_name: 'Alice' }),
        BOT_TOKEN
      );

      expect(result).toEqual({ ok: false, error: 'Telegram init data has an invalid user id' });
    });

    it('rejects bot accounts', () => {
      const result = validateTelegramInitData(
        initDataFor({}, { id: 42, first_name: 'SomeBot', is_bot: true }),
        BOT_TOKEN
      );

      expect(result).toEqual({ ok: false, error: 'Telegram bot accounts are not allowed' });
    });

    it('rejects a missing user payload', () => {
      const signed = buildInitData({ auth_date: currentAuthDate() });
      const result = validateTelegramInitData(signed, BOT_TOKEN);

      expect(result).toEqual({ ok: false, error: 'Telegram init data is missing the user' });
    });

    it('rejects empty init data', () => {
      expect(validateTelegramInitData('', BOT_TOKEN)).toEqual({
        ok: false,
        error: 'Missing Telegram init data',
      });
    });
  });

  describe('authenticateTelegramWebApp', () => {
    it('issues a JWT and creates an admin shadow user for an allowed Telegram user', async () => {
      allowTelegramId(42, 'alice_tg');

      const response = await authenticateTelegramWebApp(initDataFor());

      expect(response.token).toBeTruthy();
      expect(response.telegram_user).toEqual({ id: 42, username: 'alice_tg' });
      expect(response.user.username).toBe('tg_42');
      expect(response.user.role).toBe('admin');

      const decoded = jwt.verify(response.token, process.env.JWT_SECRET || 'dev-secret-change-me') as any;
      expect(decoded.id).toBe(response.user.id);
      expect(decoded.username).toBe('tg_42');
      expect(decoded.role).toBe('admin');

      const shadow = testDb
        .prepare('SELECT * FROM users WHERE id = ?')
        .get(response.user.id) as any;
      expect(shadow.username).toBe('tg_42');
      expect(shadow.role).toBe('admin');
      expect(shadow.api_token).toBeNull();
      expect(shadow.password_hash).toMatch(/^\$2[aby]\$/);
    });

    it('reuses the existing shadow user on repeated logins', async () => {
      allowTelegramId(42, 'alice_tg');

      const first = await authenticateTelegramWebApp(initDataFor());
      const second = await authenticateTelegramWebApp(initDataFor());

      expect(second.user.id).toBe(first.user.id);
      const count = testDb.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number };
      expect(count.count).toBe(1);
    });

    it('rejects a valid signature from a Telegram user who is not allowed (403)', async () => {
      const error = await captureAuthError(initDataFor());

      expect(error).toBeInstanceOf(TelegramWebAppAuthError);
      expect(error.status).toBe(403);
      expect(error.message).toContain('not allowed');
      // The user is tracked as pending, but no local admin is created.
      const count = testDb.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number };
      expect(count.count).toBe(0);
      const tracked = testDb
        .prepare('SELECT is_allowed FROM telegram_users WHERE telegram_user_id = ?')
        .get(42) as { is_allowed: number } | undefined;
      expect(tracked?.is_allowed).toBe(0);
    });

    it('rejects a tampered signature (401)', async () => {
      allowTelegramId(42, 'alice_tg');
      const params = new URLSearchParams(initDataFor());
      params.set('hash', 'f'.repeat(64));

      const error = await captureAuthError(params.toString());
      expect(error.status).toBe(401);
      expect(error.message).toContain('signature');
    });

    it('rejects expired init data (401)', async () => {
      allowTelegramId(42, 'alice_tg');

      const error = await captureAuthError(initDataFor({ auth_date: currentAuthDate(-86_401) }));
      expect(error.status).toBe(401);
      expect(error.message).toContain('expired');
    });

    it('rejects when the instance bot is not configured (503)', async () => {
      testDb.exec('DELETE FROM settings');

      const error = await captureAuthError(initDataFor());
      expect(error).toBeInstanceOf(TelegramWebAppAuthError);
      expect(error.status).toBe(503);
    });
  });
});
