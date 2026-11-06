/**
 * Unit tests for the Telegram long-polling bot runtime (bot.ts).
 *
 * The Bot API and the command layer are mocked, so no network calls are made.
 * Each test gets a fresh copy of the bot module (and therefore fresh runtime
 * state) via `vi.resetModules()`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { TelegramUpdate } from '../../src/services/telegram/types.js';

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
    getUpdates: vi.fn(),
    deleteWebhook: vi.fn(),
    setMyCommands: vi.fn(),
    setChatMenuButton: vi.fn(),
    sendMessage: vi.fn(),
  };
});

vi.mock('../../src/services/telegram/commands/index.js', () => ({
  BOT_COMMANDS: [
    { command: 'start', description: 'Start the bot' },
    { command: 'status', description: 'Show status' },
  ],
  handleTelegramUpdate: vi.fn(async () => {}),
}));

const BOT_TOKEN = '123456789:AAFakeTokenForTests_1234567890';

const ENV_KEYS = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_BOT_ENABLED',
  'TELEGRAM_WEBAPP_URL',
  'TELEGRAM_API_BASE_URL',
  'TELEGRAM_ADMIN_USER_IDS',
] as const;
const originalEnv: Record<string, string | undefined> = {};

let bot: typeof import('../../src/services/telegram/bot.js');
let api: any;
let commands: any;

async function loadModules(): Promise<void> {
  vi.resetModules();
  api = await import('../../src/services/telegram/api.js');
  commands = await import('../../src/services/telegram/commands/index.js');
  bot = await import('../../src/services/telegram/bot.js');
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

function configureBot(options: { enabled?: string; token?: string; webappUrl?: string } = {}): void {
  setSetting('telegram_bot_token', options.token ?? BOT_TOKEN);
  setSetting('telegram_bot_enabled', options.enabled ?? '1');
  setSetting('telegram_webapp_url', options.webappUrl ?? null);
  setSetting('telegram_bot_username', null);
}

/** A `getUpdates` promise that stays pending until the polling loop is aborted. */
function pendingGetUpdates(options: any): Promise<TelegramUpdate[]> {
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

function makeUpdate(updateId: number, text = '/status'): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: 42, type: 'private' },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      date: Math.floor(Date.now() / 1000),
      text,
    },
  };
}

function defaultMocks(): void {
  api.getMe.mockResolvedValue({
    id: 1,
    is_bot: true,
    first_name: 'Uptime',
    username: 'uptime_bot',
  });
  api.setMyCommands.mockResolvedValue(true);
  api.setChatMenuButton.mockResolvedValue(true);
  api.deleteWebhook.mockResolvedValue(true);
  api.getUpdates.mockImplementation((options: any) => pendingGetUpdates(options));
  commands.handleTelegramUpdate.mockResolvedValue(undefined);
}

describe('Telegram bot runtime', () => {
  beforeAll(() => {
    for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
    for (const key of ENV_KEYS) delete process.env[key];

    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    testDb.exec(`
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now'))
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

  beforeEach(async () => {
    testDb.exec('DELETE FROM settings; DELETE FROM telegram_users;');
    await loadModules();
    // Mock factories are cached across `vi.resetModules()`, so reset call
    // history and implementations explicitly before each test.
    vi.resetAllMocks();
    defaultMocks();
    configureBot();
  });

  afterEach(async () => {
    await bot.stopTelegramBot();
    vi.useRealTimers();
  });

  it('has no side effects on import and reports a stopped status', () => {
    const status = bot.getTelegramBotStatus();

    expect(api.getMe).not.toHaveBeenCalled();
    expect(api.getUpdates).not.toHaveBeenCalled();
    expect(status.running).toBe(false);
    expect(status.started_at).toBeNull();
    expect(status.last_error).toBeNull();
    expect(status.updates_processed).toBe(0);
    expect(status.configured).toBe(true);
    expect(status.enabled).toBe(true);
    expect(status.token_source).toBe('settings');
  });

  it('is a no-op when no bot token is configured', async () => {
    testDb.exec('DELETE FROM settings');

    await bot.startTelegramBot();

    expect(api.getMe).not.toHaveBeenCalled();
    const status = bot.getTelegramBotStatus();
    expect(status.running).toBe(false);
    expect(status.configured).toBe(false);
    expect(status.enabled).toBe(false);
  });

  it('is a no-op when the bot is disabled', async () => {
    configureBot({ enabled: '0' });

    await bot.startTelegramBot();

    expect(api.getMe).not.toHaveBeenCalled();
    expect(bot.getTelegramBotStatus().running).toBe(false);
    expect(bot.getTelegramBotStatus().enabled).toBe(false);
  });

  it('starts polling, registers commands and exposes the runtime status', async () => {
    await bot.startTelegramBot();

    expect(api.getMe).toHaveBeenCalledTimes(1);
    expect(api.getMe.mock.calls[0][0]).toMatchObject({ token: BOT_TOKEN });
    expect(api.setMyCommands).toHaveBeenCalledWith(
      commands.BOT_COMMANDS,
      expect.objectContaining({ token: BOT_TOKEN })
    );
    expect(api.setChatMenuButton).not.toHaveBeenCalled();

    const status = bot.getTelegramBotStatus();
    expect(status.running).toBe(true);
    expect(status.bot_username).toBe('uptime_bot');
    expect(status.started_at).toEqual(expect.any(String));
    expect(status.configured).toBe(true);

    // The getMe username is persisted so the web UI can show it while stopped.
    const usernameSetting = testDb
      .prepare("SELECT value FROM settings WHERE key = 'telegram_bot_username'")
      .get() as { value: string };
    expect(usernameSetting.value).toBe('uptime_bot');

    await bot.stopTelegramBot();
    expect(bot.getTelegramBotStatus().running).toBe(false);
    expect(bot.getTelegramBotStatus().started_at).toBeNull();
  });

  it('registers the Mini App menu button when a web app URL is configured', async () => {
    configureBot({ webappUrl: 'https://uptime.example.com/telegram' });

    await bot.startTelegramBot();

    expect(api.setChatMenuButton).toHaveBeenCalledTimes(1);
    expect(api.setChatMenuButton).toHaveBeenCalledWith(
      {
        type: 'web_app',
        text: 'Open Uptime Detective',
        web_app: { url: 'https://uptime.example.com/telegram' },
      },
      expect.objectContaining({ token: BOT_TOKEN })
    );
  });

  it('processes updates, advances the offset and counts them', async () => {
    const first = makeUpdate(100, '/status');
    const second = makeUpdate(101, '/help');
    api.getUpdates
      .mockImplementationOnce(async () => [first, second])
      .mockImplementation((options: any) => pendingGetUpdates(options));

    await bot.startTelegramBot();

    await vi.waitFor(() => {
      expect(bot.getTelegramBotStatus().updates_processed).toBe(2);
    });
    expect(commands.handleTelegramUpdate).toHaveBeenCalledTimes(2);
    expect(commands.handleTelegramUpdate).toHaveBeenNthCalledWith(1, first);
    expect(commands.handleTelegramUpdate).toHaveBeenNthCalledWith(2, second);

    await vi.waitFor(() => {
      expect(api.getUpdates.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    // Next poll asks for updates after update_id 101.
    expect(api.getUpdates.mock.calls[1][0]).toMatchObject({
      offset: 102,
      timeout: 25,
      allowed_updates: ['message', 'callback_query'],
    });
  });

  it('keeps polling when a single update handler fails', async () => {
    commands.handleTelegramUpdate.mockRejectedValueOnce(new Error('handler exploded'));
    api.getUpdates
      .mockImplementationOnce(async () => [makeUpdate(7)])
      .mockImplementation((options: any) => pendingGetUpdates(options));

    await bot.startTelegramBot();

    await vi.waitFor(() => {
      expect(bot.getTelegramBotStatus().updates_processed).toBe(1);
      expect(api.getUpdates.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    expect(bot.getTelegramBotStatus().running).toBe(true);
  });

  it('records a startup failure without throwing', async () => {
    api.getMe.mockRejectedValueOnce(new api.TelegramApiError('Unauthorized', 401));

    await expect(bot.startTelegramBot()).resolves.toBeUndefined();

    const status = bot.getTelegramBotStatus();
    expect(status.running).toBe(false);
    expect(status.started_at).toBeNull();
    expect(status.last_error).toContain('Unauthorized');
    expect(api.getUpdates).not.toHaveBeenCalled();
  });

  it('start and stop are idempotent', async () => {
    await bot.startTelegramBot();
    await bot.startTelegramBot();
    expect(api.getMe).toHaveBeenCalledTimes(1);
    expect(bot.getTelegramBotStatus().running).toBe(true);

    await bot.stopTelegramBot();
    await expect(bot.stopTelegramBot()).resolves.toBeUndefined();
    expect(bot.getTelegramBotStatus().running).toBe(false);
  });

  it('restartTelegramBot stops and starts again, returning the fresh status', async () => {
    await bot.startTelegramBot();

    const status = await bot.restartTelegramBot();

    expect(api.getMe).toHaveBeenCalledTimes(2);
    expect(status.running).toBe(true);
    expect(status.bot_username).toBe('uptime_bot');
    expect(status.started_at).toEqual(expect.any(String));
  });

  it('retries with backoff after an API error and clears last_error on success', async () => {
    api.getUpdates
      .mockRejectedValueOnce(new api.TelegramApiError('Temporary failure', 500))
      .mockResolvedValueOnce([])
      .mockImplementation((options: any) => pendingGetUpdates(options));

    await bot.startTelegramBot();

    await vi.waitFor(() => {
      expect(bot.getTelegramBotStatus().last_error).toContain('Temporary failure');
    });
    // The first retry waits 1s, then succeeds and clears the error.
    await vi.waitFor(
      () => {
        expect(bot.getTelegramBotStatus().last_error).toBeNull();
      },
      { timeout: 3_000 }
    );
    expect(bot.getTelegramBotStatus().running).toBe(true);
  });

  it('deletes the webhook once on a 409 conflict and resumes polling', async () => {
    api.getUpdates
      .mockRejectedValueOnce(
        new api.TelegramApiError('Conflict: terminated by other getUpdates request', 409)
      )
      .mockResolvedValueOnce([])
      .mockImplementation((options: any) => pendingGetUpdates(options));

    await bot.startTelegramBot();

    await vi.waitFor(() => {
      expect(api.deleteWebhook).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(bot.getTelegramBotStatus().last_error).toBeNull();
    });
    expect(bot.getTelegramBotStatus().running).toBe(true);
  });

  it('reports a clear error when a 409 conflict persists (webhook deleted only once)', async () => {
    api.getUpdates.mockImplementation(async () => {
      throw new api.TelegramApiError('Conflict: terminated by other getUpdates request', 409);
    });

    await bot.startTelegramBot();

    await vi.waitFor(
      () => {
        expect(api.deleteWebhook).toHaveBeenCalledTimes(1);
        expect(bot.getTelegramBotStatus().last_error).toContain('another bot instance');
      },
      { timeout: 3_000 }
    );
    expect(bot.getTelegramBotStatus().running).toBe(true);
  });

  it('handleTelegramUpdate delegates to the command layer and swallows errors', async () => {
    const update = makeUpdate(11);

    await bot.handleTelegramUpdate(update);
    expect(commands.handleTelegramUpdate).toHaveBeenCalledWith(update);

    commands.handleTelegramUpdate.mockRejectedValueOnce(new Error('boom'));
    await expect(bot.handleTelegramUpdate(update)).resolves.toBeUndefined();
  });
});
