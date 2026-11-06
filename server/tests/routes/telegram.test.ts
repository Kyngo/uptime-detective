/**
 * Integration tests for the Telegram REST API (`routes/telegram.ts`).
 *
 * Uses an in-memory SQLite database and a mocked Bot API client — no network
 * calls are made. Covers config masking, token validation before persisting,
 * env-managed tokens, restart/test endpoints, allow-list CRUD and the public
 * Mini App auth endpoint (with signatures generated with the documented
 * Telegram algorithm).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import Database from 'better-sqlite3';

let testDb: Database.Database;

vi.mock('../../src/db/connection.js', () => ({
  getDb: () => testDb,
}));

vi.mock('../../src/services/telegram/api.js', () => {
  class TelegramApiError extends Error {
    code: number;
    description: string;
    retry_after?: number;
    constructor(description = '', code = 0, retry_after?: number) {
      super(description);
      this.name = 'TelegramApiError';
      this.code = code;
      this.description = description;
      this.retry_after = retry_after;
    }
  }

  return {
    TelegramApiError,
    getMe: vi.fn(),
    getUpdates: vi.fn((options: any) => pendingGetUpdates(options)),
    deleteWebhook: vi.fn(),
    setMyCommands: vi.fn(),
    setChatMenuButton: vi.fn(),
    sendMessage: vi.fn(),
  };
});

/** A `getUpdates` promise that stays pending until the polling loop is aborted. */
function pendingGetUpdates(options: any): Promise<never[]> {
  return new Promise((_resolve, reject) => {
    const signal: AbortSignal | undefined = options?.signal;
    if (!signal) return;
    const abort = () => reject(new Error('aborted'));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}

vi.mock('../../src/services/telegram/commands/index.js', () => ({
  BOT_COMMANDS: [{ command: 'start', description: 'Start the bot' }],
  handleTelegramUpdate: vi.fn(async () => {}),
}));

import * as telegramApi from '../../src/services/telegram/api.js';
import { telegramRouter } from '../../src/routes/telegram.js';
import { stopTelegramBot } from '../../src/services/telegram/bot.js';
import { signToken } from '../../src/middleware/auth.js';

const api: any = telegramApi;
const BOT_TOKEN = '123456789:AAFakeTokenForTests_1234567890';
const ENV_KEYS = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_BOT_ENABLED',
  'TELEGRAM_WEBAPP_URL',
  'TELEGRAM_API_BASE_URL',
  'TELEGRAM_WEBAPP_AUTH_MAX_AGE',
] as const;
const originalEnv: Record<string, string | undefined> = {};

let app: express.Express;
let adminToken: string;
let viewerToken: string;

function createTestApp(): express.Express {
  const testApp = express();
  testApp.use(express.json());
  testApp.use('/api/v1/telegram', telegramRouter);
  return testApp;
}

function setSetting(key: string, value: string | null): void {
  if (value === null) {
    testDb.prepare('DELETE FROM settings WHERE key = ?').run(key);
    return;
  }
  testDb
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(key, value);
}

function configureBotSettings(options: { enabled?: string; webappUrl?: string } = {}): void {
  setSetting('telegram_bot_token', BOT_TOKEN);
  setSetting('telegram_bot_enabled', options.enabled ?? '1');
  setSetting('telegram_webapp_url', options.webappUrl ?? null);
}

function buildInitData(
  fields: Record<string, string>,
  botToken = BOT_TOKEN
): string {
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

function initDataFor(user: Record<string, unknown>, authDateOffset = 0): string {
  return buildInitData({
    auth_date: String(Math.floor(Date.now() / 1000) + authDateOffset),
    query_id: 'AAExampleQueryId',
    user: JSON.stringify(user),
  });
}

function allowUser(id: number, chatId: number | null = null, username: string | null = null): void {
  testDb
    .prepare(
      'INSERT INTO telegram_users (telegram_user_id, chat_id, username, is_allowed) VALUES (?, ?, ?, 1)'
    )
    .run(id, chatId, username);
}

describe('Telegram routes', () => {
  beforeAll(() => {
    for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
    for (const key of ENV_KEYS) delete process.env[key];

    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    testDb.pragma('foreign_keys = ON');
    testDb.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT DEFAULT 'admin' CHECK(role IN ('admin', 'viewer')),
        api_token TEXT UNIQUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL
      );
      CREATE TABLE monitors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        target TEXT NOT NULL,
        active INTEGER DEFAULT 1,
        group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL
      );
      CREATE TABLE notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        config JSON NOT NULL DEFAULT '{}',
        is_default INTEGER DEFAULT 0
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
      CREATE TABLE monitor_mutes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        monitor_id INTEGER REFERENCES monitors(id) ON DELETE CASCADE,
        muted_until DATETIME NOT NULL,
        muted_by TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    app = createTestApp();
    adminToken = signToken({ id: 1, username: 'admin', role: 'admin' });
    viewerToken = signToken({ id: 2, username: 'viewer', role: 'viewer' });
  });

  afterAll(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    testDb.close();
  });

  beforeEach(() => {
    testDb.exec(
      'DELETE FROM users; DELETE FROM settings; DELETE FROM telegram_users; DELETE FROM monitor_mutes; DELETE FROM notifications; DELETE FROM monitors;'
    );
    testDb
      .prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'admin', 'x', 'admin')")
      .run();
    testDb
      .prepare("INSERT INTO users (id, username, password_hash, role) VALUES (2, 'viewer', 'x', 'viewer')")
      .run();

    for (const key of ENV_KEYS) delete process.env[key];
    vi.resetAllMocks();
    api.getUpdates.mockImplementation((options: any) => pendingGetUpdates(options));
    api.getMe.mockResolvedValue({
      id: 1,
      is_bot: true,
      first_name: 'Uptime',
      username: 'uptime_bot',
    });
    api.setMyCommands.mockResolvedValue(true);
    api.setChatMenuButton.mockResolvedValue(true);
    api.deleteWebhook.mockResolvedValue(true);
    api.sendMessage.mockResolvedValue({ message_id: 99 });
  });

  afterEach(async () => {
    await stopTelegramBot();
  });

  describe('authentication', () => {
    it('rejects unauthenticated requests to protected routes', async () => {
      const res = await request(app).get('/api/v1/telegram/config');
      expect(res.status).toBe(401);

      const users = await request(app).get('/api/v1/telegram/users');
      expect(users.status).toBe(401);
    });

    it('requires admin for config, restart, test and user mutations', async () => {
      const putConfig = await request(app)
        .put('/api/v1/telegram/config')
        .set('Authorization', `Bearer ${viewerToken}`)
        .send({ enabled: true });
      expect(putConfig.status).toBe(403);

      const restart = await request(app)
        .post('/api/v1/telegram/restart')
        .set('Authorization', `Bearer ${viewerToken}`);
      expect(restart.status).toBe(403);

      const testMessage = await request(app)
        .post('/api/v1/telegram/test')
        .set('Authorization', `Bearer ${viewerToken}`)
        .send({ chat_id: 1 });
      expect(testMessage.status).toBe(403);

      const addUser = await request(app)
        .post('/api/v1/telegram/users')
        .set('Authorization', `Bearer ${viewerToken}`)
        .send({ telegram_user_id: 42 });
      expect(addUser.status).toBe(403);
    });
  });

  describe('GET /api/v1/telegram/config', () => {
    it('returns a masked settings object when unconfigured', async () => {
      const res = await request(app)
        .get('/api/v1/telegram/config')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        enabled: false,
        bot_token_set: false,
        bot_token_hint: null,
        bot_username: null,
        webapp_url: null,
        api_base_url: 'https://api.telegram.org',
        token_source: 'none',
      });
      expect(res.body.status).toMatchObject({
        configured: false,
        enabled: false,
        running: false,
        started_at: null,
        last_error: null,
        updates_processed: 0,
        token_source: 'none',
      });
      expect(res.body).not.toHaveProperty('bot_token');
    });

    it('never includes the full token', async () => {
      configureBotSettings();

      const res = await request(app)
        .get('/api/v1/telegram/config')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.bot_token_set).toBe(true);
      expect(res.body.bot_token_hint).toContain('…');
      expect(res.body.bot_token_hint).not.toBe(BOT_TOKEN);
      expect(JSON.stringify(res.body)).not.toContain(BOT_TOKEN);
    });
  });

  describe('PUT /api/v1/telegram/config', () => {
    it('rejects invalid tokens after validating them with getMe (without persisting)', async () => {
      api.getMe.mockRejectedValueOnce(new api.TelegramApiError('Unauthorized', 401));

      const res = await request(app)
        .put('/api/v1/telegram/config')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ bot_token: BOT_TOKEN, enabled: true });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid bot token');
      expect(api.getMe).toHaveBeenCalledWith(expect.objectContaining({ token: BOT_TOKEN }));

      const stored = testDb
        .prepare("SELECT value FROM settings WHERE key = 'telegram_bot_token'")
        .get() as { value: string } | undefined;
      expect(stored).toBeUndefined();
    });

    it('rejects token changes when the token is managed by the environment', async () => {
      process.env.TELEGRAM_BOT_TOKEN = '999999999:EnvironmentManagedToken_123456';

      const res = await request(app)
        .put('/api/v1/telegram/config')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ bot_token: BOT_TOKEN });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('environment variable');
      expect(api.getMe).not.toHaveBeenCalled();
      delete process.env.TELEGRAM_BOT_TOKEN;
    });

    it('validates, persists and applies a valid token', async () => {
      api.getMe.mockResolvedValueOnce({
        id: 7,
        is_bot: true,
        first_name: 'Uptime',
        username: 'uptime_bot',
      });

      const res = await request(app)
        .put('/api/v1/telegram/config')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          bot_token: BOT_TOKEN,
          enabled: true,
          webapp_url: 'https://uptime.example.com/telegram',
        });

      expect(res.status).toBe(200);
      expect(res.body.bot_token_set).toBe(true);
      expect(res.body.enabled).toBe(true);
      expect(res.body.webapp_url).toBe('https://uptime.example.com/telegram');
      expect(res.body.bot_username).toBe('uptime_bot');
      expect(res.body.status.running).toBe(true);
      expect(res.body.status.bot_username).toBe('uptime_bot');
      expect(JSON.stringify(res.body)).not.toContain(BOT_TOKEN);

      const stored = testDb
        .prepare("SELECT value FROM settings WHERE key = 'telegram_bot_token'")
        .get() as { value: string };
      expect(stored.value).toBe(BOT_TOKEN);
      expect(api.getMe).toHaveBeenCalledWith(expect.objectContaining({ token: BOT_TOKEN }));

      // Restart registers commands and the Mini App menu button.
      expect(api.setMyCommands).toHaveBeenCalled();
      expect(api.setChatMenuButton).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'web_app',
          web_app: { url: 'https://uptime.example.com/telegram' },
        }),
        expect.anything()
      );
    });

    it('rejects a non-https web app URL', async () => {
      configureBotSettings();

      const res = await request(app)
        .put('/api/v1/telegram/config')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ webapp_url: 'http://uptime.example.com/telegram' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('https://');
    });

    it('clears the token when bot_token is an empty string', async () => {
      configureBotSettings();

      const res = await request(app)
        .put('/api/v1/telegram/config')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ bot_token: '' });

      expect(res.status).toBe(200);
      expect(res.body.bot_token_set).toBe(false);
      expect(res.body.status.running).toBe(false);
      const stored = testDb
        .prepare("SELECT value FROM settings WHERE key = 'telegram_bot_token'")
        .get() as { value: string } | undefined;
      expect(stored).toBeUndefined();
    });
  });

  describe('POST /api/v1/telegram/restart', () => {
    it('restarts the bot and returns the fresh status', async () => {
      configureBotSettings();

      const res = await request(app)
        .post('/api/v1/telegram/restart')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        configured: true,
        enabled: true,
        running: true,
        bot_username: 'uptime_bot',
        token_source: 'settings',
      });
      expect(res.body.started_at).toEqual(expect.any(String));
      expect(JSON.stringify(res.body)).not.toContain(BOT_TOKEN);
    });
  });

  describe('POST /api/v1/telegram/test', () => {
    it('returns 400 when the bot is not configured', async () => {
      const res = await request(app)
        .post('/api/v1/telegram/test')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('not configured');
      expect(api.sendMessage).not.toHaveBeenCalled();
    });

    it('returns 400 when no allowed user has a chat id', async () => {
      configureBotSettings();

      const res = await request(app)
        .post('/api/v1/telegram/test')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('chat id');
    });

    it('sends the test message to the first allowed user with a chat id', async () => {
      configureBotSettings();
      allowUser(42, 4242, 'alice_tg');

      const res = await request(app)
        .post('/api/v1/telegram/test')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('Test message sent');
      expect(api.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ chat_id: 4242 }),
        expect.objectContaining({ token: BOT_TOKEN })
      );
    });

    it('accepts an explicit chat_id', async () => {
      configureBotSettings();

      const res = await request(app)
        .post('/api/v1/telegram/test')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ chat_id: '-1001234567890' });

      expect(res.status).toBe(200);
      expect(api.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ chat_id: '-1001234567890' }),
        expect.anything()
      );
    });

    it('returns an error when Telegram rejects the test message', async () => {
      configureBotSettings();
      api.sendMessage.mockRejectedValueOnce(
        new api.TelegramApiError('Bad Request: chat not found', 400)
      );

      const res = await request(app)
        .post('/api/v1/telegram/test')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ chat_id: 1 });

      expect(res.status).toBe(502);
      expect(res.body.error).toContain('chat not found');
    });
  });

  describe('allow list CRUD', () => {
    it('GET /users returns the allow list', async () => {
      allowUser(42, 4242, 'alice_tg');

      const res = await request(app)
        .get('/api/v1/telegram/users')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({
        telegram_user_id: 42,
        chat_id: 4242,
        username: 'alice_tg',
        is_allowed: true,
      });
    });

    it('POST /users validates the id and allows the user', async () => {
      const invalid = await request(app)
        .post('/api/v1/telegram/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ telegram_user_id: 'nope' });
      expect(invalid.status).toBe(400);

      const res = await request(app)
        .post('/api/v1/telegram/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ telegram_user_id: 42, username: 'alice_tg' });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        telegram_user_id: 42,
        username: 'alice_tg',
        is_allowed: true,
        allowed_by: 1,
      });
    });

    it('PUT /users/:id toggles the allow flag', async () => {
      allowUser(42);

      const deny = await request(app)
        .put('/api/v1/telegram/users/42')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ is_allowed: false });
      expect(deny.status).toBe(200);
      expect(deny.body.is_allowed).toBe(false);

      const allow = await request(app)
        .put('/api/v1/telegram/users/42')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ is_allowed: true });
      expect(allow.status).toBe(200);
      expect(allow.body.is_allowed).toBe(true);
    });

    it('PUT /users/:id handles unknown users and bad payloads', async () => {
      const unknown = await request(app)
        .put('/api/v1/telegram/users/999')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ is_allowed: true });
      expect(unknown.status).toBe(404);

      allowUser(42);
      const badBody = await request(app)
        .put('/api/v1/telegram/users/42')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ is_allowed: 'yes' });
      expect(badBody.status).toBe(400);
    });

    it('DELETE /users/:id denies the user but keeps the row', async () => {
      allowUser(42, 4242, 'alice_tg');

      const res = await request(app)
        .delete('/api/v1/telegram/users/42')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('denied');
      expect(res.body.user.is_allowed).toBe(false);
      const row = testDb
        .prepare('SELECT is_allowed FROM telegram_users WHERE telegram_user_id = 42')
        .get() as { is_allowed: number };
      expect(row.is_allowed).toBe(0);
    });

    it('DELETE /users/:id returns 404 for unknown users', async () => {
      const res = await request(app)
        .delete('/api/v1/telegram/users/999')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/v1/telegram/webapp/auth (public)', () => {
    const telegramUser = { id: 42, first_name: 'Alice', username: 'alice_tg', language_code: 'en' };

    it('authenticates an allowed Telegram user without an Authorization header', async () => {
      configureBotSettings();
      allowUser(42, null, 'alice_tg');

      const res = await request(app)
        .post('/api/v1/telegram/webapp/auth')
        .send({ init_data: initDataFor(telegramUser) });

      expect(res.status).toBe(200);
      expect(res.body.token).toBeTruthy();
      expect(res.body.user).toMatchObject({ username: 'tg_42', role: 'admin' });
      expect(res.body.telegram_user).toEqual({ id: 42, username: 'alice_tg' });

      const decoded = jwt.verify(
        res.body.token,
        process.env.JWT_SECRET || 'dev-secret-change-me'
      ) as any;
      expect(decoded.id).toBe(res.body.user.id);
      expect(decoded.role).toBe('admin');
    });

    it('returns 400 when init_data is missing', async () => {
      configureBotSettings();
      const res = await request(app).post('/api/v1/telegram/webapp/auth').send({});
      expect(res.status).toBe(400);
    });

    it('returns 401 for a tampered signature', async () => {
      configureBotSettings();
      const params = new URLSearchParams(initDataFor(telegramUser));
      params.set('hash', 'a'.repeat(64));

      const res = await request(app)
        .post('/api/v1/telegram/webapp/auth')
        .send({ init_data: params.toString() });

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('signature');
    });

    it('returns 401 for expired auth_date', async () => {
      configureBotSettings();
      allowUser(42);

      const res = await request(app)
        .post('/api/v1/telegram/webapp/auth')
        .send({ init_data: initDataFor(telegramUser, -86_401) });

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('expired');
    });

    it('returns 403 for a valid signature from a non-allowed Telegram user', async () => {
      configureBotSettings();

      const res = await request(app)
        .post('/api/v1/telegram/webapp/auth')
        .send({ init_data: initDataFor(telegramUser) });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('not allowed');
    });

    it('returns 503 when the bot is not configured', async () => {
      const res = await request(app)
        .post('/api/v1/telegram/webapp/auth')
        .send({ init_data: initDataFor(telegramUser) });

      expect(res.status).toBe(503);
    });
  });
});
