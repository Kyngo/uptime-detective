/**
 * Integration-style tests for the Telegram bot commands.
 *
 * The real foundation services run against an in-memory SQLite database; only
 * the network (Telegram Bot API), the scheduler and the outbound checker
 * functions are mocked. No network access, no real timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

let testDb: Database.Database;

vi.mock('../../src/db/connection.js', () => ({
  getDb: () => testDb,
}));

const apiMock = vi.hoisted(() => ({
  sendMessage: vi.fn(async () => ({})),
  editMessageText: vi.fn(async () => ({})),
  answerCallbackQuery: vi.fn(async () => true),
}));
vi.mock('../../src/services/telegram/api.js', () => apiMock);

const schedulerMock = vi.hoisted(() => ({
  startMonitorJob: vi.fn(),
  stopMonitorJob: vi.fn(),
  updateMonitorJob: vi.fn(),
  startAllMonitors: vi.fn(),
  stopAllMonitors: vi.fn(),
  getRunningJobCount: vi.fn(() => 0),
}));
vi.mock('../../src/services/scheduler.js', () => schedulerMock);

vi.mock('../../src/socket.js', () => ({
  getIO: () => {
    throw new Error('Socket.IO not initialized');
  },
}));

const executeCheckMock = vi.hoisted(() => vi.fn(async (_monitor: unknown) => undefined));
vi.mock('../../src/services/checker/index.js', () => ({ executeCheck: executeCheckMock }));

const checkerMocks = vi.hoisted(() => ({
  performHttpCheck: vi.fn(async () => ({ status: 1, response_time: 42, status_code: 200, message: null })),
  performTcpCheck: vi.fn(async () => ({ status: 1, response_time: 12, status_code: null, message: 'Connected' })),
  performDnsCheck: vi.fn(async () => ({ status: 1, response_time: 15, status_code: null, message: 'Resolved: 1.2.3.4' })),
  performTlsCheck: vi.fn(async () => ({ status: 1, response_time: 24, status_code: null, message: 'Expires in 30d' })),
  performIcmpCheck: vi.fn(async () => ({ status: 1, response_time: 8, status_code: null, message: null })),
  isPrivateIp: vi.fn(() => false),
}));
vi.mock('../../src/services/checker/http.js', () => ({
  performHttpCheck: checkerMocks.performHttpCheck,
  isPrivateIp: checkerMocks.isPrivateIp,
}));
vi.mock('../../src/services/checker/tcp.js', () => ({ performTcpCheck: checkerMocks.performTcpCheck }));
vi.mock('../../src/services/checker/dns.js', () => ({ performDnsCheck: checkerMocks.performDnsCheck }));
vi.mock('../../src/services/checker/tls.js', () => ({ performTlsCheck: checkerMocks.performTlsCheck }));
vi.mock('../../src/services/checker/icmp.js', () => ({ performIcmpCheck: checkerMocks.performIcmpCheck }));

import {
  BOT_COMMANDS,
  handleTelegramUpdate,
  resetCommandState,
} from '../../src/services/telegram/commands/index.js';
import { parseCommandText, tokenizeArgs } from '../../src/services/telegram/commands/refs.js';
import { muteMonitor } from '../../src/services/mutes.js';
import type { TelegramUpdate, TelegramUserInfo } from '../../src/services/telegram/types.js';

// === Fixtures ===

const ALICE: TelegramUserInfo = { id: 42, is_bot: false, first_name: 'Alice', username: 'alice' };
const BOB: TelegramUserInfo = { id: 43, is_bot: false, first_name: 'Bob', username: 'bob' };
const CAROL: TelegramUserInfo = { id: 99, is_bot: false, first_name: 'Carol', username: 'carol' };

const MONITORS_SCHEMA = `
  CREATE TABLE groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    description TEXT,
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE monitors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('http', 'icmp', 'dns', 'tls', 'tcp', 'heartbeat')),
    target TEXT NOT NULL,
    interval INTEGER DEFAULT 60,
    timeout INTEGER DEFAULT 10000,
    retries INTEGER DEFAULT 1,
    retry_interval INTEGER DEFAULT 30,
    config JSON DEFAULT '{}',
    group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
    tags JSON DEFAULT '[]',
    active INTEGER DEFAULT 1,
    heartbeat_token TEXT UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    status INTEGER NOT NULL,
    response_time INTEGER,
    status_code INTEGER,
    message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    started_at DATETIME NOT NULL,
    resolved_at DATETIME,
    duration_seconds INTEGER,
    cause TEXT
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`;

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(MONITORS_SCHEMA);
  return db;
}

interface MonitorSeed {
  id: number;
  name: string;
  type: string;
  target: string;
  group_id?: number | null;
  active?: number;
  heartbeat_token?: string | null;
  interval?: number;
}

function insertMonitor(db: Database.Database, seed: MonitorSeed): void {
  db.prepare(`
    INSERT INTO monitors (id, name, type, target, interval, timeout, retries, retry_interval, config, group_id, tags, active, heartbeat_token)
    VALUES (?, ?, ?, ?, ?, 10000, 1, 30, '{}', ?, '[]', ?, ?)
  `).run(
    seed.id,
    seed.name,
    seed.type,
    seed.target,
    seed.interval ?? 60,
    seed.group_id ?? null,
    seed.active ?? 1,
    seed.heartbeat_token ?? null
  );
}

/** A monitor whose name contains spaces (multi-word reference tests). */
function insertMultiWordMonitor(): void {
  insertMonitor(testDb, {
    id: 400,
    name: 'My Cool API',
    type: 'http',
    target: 'https://cool.example.com',
  });
}

function seedFixtures(db: Database.Database): void {
  db.prepare("INSERT INTO groups (id, name, slug) VALUES (1, 'Production', 'production')").run();
  db.prepare("INSERT INTO groups (id, name, slug) VALUES (2, 'Internal', 'internal')").run();

  insertMonitor(db, { id: 1, name: 'Main API', type: 'http', target: 'https://api.example.com/health', group_id: 1 });
  insertMonitor(db, { id: 2, name: 'Database', type: 'tcp', target: 'db.example.com:5432', group_id: 1 });
  insertMonitor(db, { id: 3, name: 'API Docs', type: 'http', target: 'https://docs.example.com', active: 0 });
  insertMonitor(db, {
    id: 10,
    name: 'Heartbeat',
    type: 'heartbeat',
    target: 'backup-job',
    heartbeat_token: 'tok123',
  });

  db.prepare("INSERT INTO checks (monitor_id, status, response_time, status_code) VALUES (1, 1, 120, 200)").run();
  db.prepare("INSERT INTO checks (monitor_id, status, response_time, status_code, message) VALUES (2, 0, NULL, NULL, 'Connection refused')").run();
  db.prepare("INSERT INTO checks (monitor_id, status, response_time, status_code) VALUES (3, 1, 55, 200)").run();

  db.prepare(
    "INSERT INTO incidents (monitor_id, started_at, cause) VALUES (2, datetime('now', '-10 minutes'), 'Connection refused')"
  ).run();

  db.prepare(`
    INSERT INTO telegram_users (telegram_user_id, chat_id, username, first_name, is_allowed, last_seen_at)
    VALUES (42, 42, 'alice', 'Alice', 1, datetime('now', '-3 minutes'))
  `).run();
  db.prepare(`
    INSERT INTO telegram_users (telegram_user_id, chat_id, username, first_name, is_allowed, last_seen_at)
    VALUES (43, 43, 'bob', 'Bob', 1, datetime('now', '-1 hour'))
  `).run();
  db.prepare(`
    INSERT INTO telegram_users (telegram_user_id, chat_id, username, first_name, is_allowed, last_seen_at)
    VALUES (99, 99, 'carol', 'Carol', 0, datetime('now', '-2 hours'))
  `).run();

  db.prepare("INSERT INTO settings (key, value) VALUES ('telegram_webapp_url', 'https://status.example.com')").run();
}

// === Update factories ===

let updateCounter = 0;

function messageUpdate(
  text: string,
  options: { user?: TelegramUserInfo; replyTo?: TelegramUserInfo } = {}
): TelegramUpdate {
  updateCounter++;
  const user = options.user ?? ALICE;
  const message: any = {
    message_id: 100 + updateCounter,
    from: user,
    chat: { id: user.id, type: 'private' },
    date: 1_700_000_000 + updateCounter,
    text,
  };
  if (options.replyTo) {
    message.reply_to_message = {
      message_id: 90,
      from: options.replyTo,
      chat: { id: options.replyTo.id, type: 'private' },
      date: 1_700_000_000,
      text: 'hello',
    };
  }
  return { update_id: updateCounter, message };
}

function callbackUpdate(
  data: string,
  options: { user?: TelegramUserInfo; messageId?: number } = {}
): TelegramUpdate {
  updateCounter++;
  const user = options.user ?? ALICE;
  return {
    update_id: updateCounter,
    callback_query: {
      id: `cb-${updateCounter}`,
      from: user,
      chat_instance: 'chat-instance',
      data,
      message: {
        message_id: options.messageId ?? 500,
        from: { id: 7, is_bot: true, first_name: 'Bot', username: 'uptime_bot' },
        chat: { id: user.id, type: 'private' },
        date: 1_700_000_000,
        text: 'prompt',
      },
    },
  } as TelegramUpdate;
}

// === Outgoing message helpers ===

function callbacksOf(markup: any): string[] {
  if (!markup || !Array.isArray(markup.inline_keyboard)) return [];
  return markup.inline_keyboard
    .flatMap((row: any[]) => row.map((button) => button.callback_data))
    .filter((data: unknown): data is string => typeof data === 'string');
}

function lastSendPayload(): any {
  const calls = apiMock.sendMessage.mock.calls;
  return calls.length > 0 ? calls[calls.length - 1][0] : null;
}

function lastSendText(): string {
  return lastSendPayload()?.text ?? '';
}

function lastSendCallbacks(): string[] {
  return callbacksOf(lastSendPayload()?.reply_markup);
}

function lastEditPayload(): any {
  const calls = apiMock.editMessageText.mock.calls;
  return calls.length > 0 ? calls[calls.length - 1][0] : null;
}

function lastEditText(): string {
  return lastEditPayload()?.text ?? '';
}

function lastEditCallbacks(): string[] {
  return callbacksOf(lastEditPayload()?.reply_markup);
}

function allSentText(): string {
  return apiMock.sendMessage.mock.calls.map((call: any[]) => call[0]?.text ?? '').join('\n');
}

function allEditedText(): string {
  return apiMock.editMessageText.mock.calls.map((call: any[]) => call[0]?.text ?? '').join('\n');
}

function dbMonitor(id: number): any {
  return testDb.prepare('SELECT * FROM monitors WHERE id = ?').get(id);
}

function dbTelegramUser(id: number): any {
  return testDb.prepare('SELECT * FROM telegram_users WHERE telegram_user_id = ?').get(id);
}

function countRows(table: string): number {
  return (testDb.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

// === Setup ===

beforeEach(() => {
  testDb?.close();
  testDb = createDb();
  seedFixtures(testDb);
  updateCounter = 0;

  vi.clearAllMocks();
  apiMock.sendMessage.mockResolvedValue({});
  apiMock.editMessageText.mockResolvedValue({});
  apiMock.answerCallbackQuery.mockResolvedValue(true);
  executeCheckMock.mockResolvedValue(undefined);
  checkerMocks.performHttpCheck.mockResolvedValue({ status: 1, response_time: 42, status_code: 200, message: null });
  checkerMocks.performTcpCheck.mockResolvedValue({ status: 1, response_time: 12, status_code: null, message: 'Connected' });
  checkerMocks.performDnsCheck.mockResolvedValue({ status: 1, response_time: 15, status_code: null, message: 'Resolved: 1.2.3.4' });
  checkerMocks.performTlsCheck.mockResolvedValue({ status: 1, response_time: 24, status_code: null, message: 'Expires in 30d' });
  checkerMocks.performIcmpCheck.mockResolvedValue({ status: 1, response_time: 8, status_code: null, message: null });

  resetCommandState();
  vi.unstubAllEnvs();
  vi.stubEnv('TELEGRAM_BOT_TOKEN', '');
  vi.stubEnv('TELEGRAM_WEBAPP_URL', '');
  vi.stubEnv('TELEGRAM_ADMIN_USER_IDS', '');
  vi.stubEnv('APP_URL', '');
  // The /ping SSRF guard is covered by its own test file; these command tests
  // must not perform real DNS lookups for their fixture hostnames.
  vi.stubEnv('ALLOW_PRIVATE_IPS', 'true');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  testDb?.close();
});

// === Tests ===

describe('command parsing helpers', () => {
  it('parses commands, bot suffixes and quoted arguments', () => {
    expect(parseCommandText('/status')).toEqual({ command: 'status', args: '', tokens: [] });
    expect(parseCommandText('/Add@UptimeBot http://x "My API" group:1')?.command).toBe('add');
    expect(parseCommandText('/Add@UptimeBot http://x "My API" group:1')?.tokens).toEqual([
      'http://x',
      'My API',
      'group:1',
    ]);
    expect(parseCommandText('hello bot')).toBeNull();
  });

  it('tokenizes quoted names and escapes', () => {
    expect(tokenizeArgs(`http://x "My API" group:2`)).toEqual(['http://x', 'My API', 'group:2']);
    expect(tokenizeArgs(`http://x 'Single API'`)).toEqual(['http://x', 'Single API']);
    expect(tokenizeArgs('')).toEqual([]);
  });
});

describe('allow-list gating', () => {
  it('records unknown users and replies once per five minutes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    await handleTelegramUpdate(messageUpdate('/status', { user: CAROL }));
    expect(dbTelegramUser(99)?.is_allowed).toBe(0);
    expect(apiMock.sendMessage).toHaveBeenCalledTimes(1);
    expect(lastSendText()).toContain('Not authorized');
    expect(lastSendText()).toContain('99');

    await handleTelegramUpdate(messageUpdate('/status', { user: CAROL }));
    expect(apiMock.sendMessage).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5 * 60_000 + 1_000);
    await handleTelegramUpdate(messageUpdate('/status', { user: CAROL }));
    expect(apiMock.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('never executes commands for unknown users', async () => {
    await handleTelegramUpdate(messageUpdate('/remove 1', { user: CAROL }));

    expect(dbMonitor(1)).toBeTruthy();
    expect(allSentText()).toContain('Not authorized');
    expect(allSentText()).not.toContain('Delete monitor');
  });

  it('always answers /start with the user id and access hint', async () => {
    await handleTelegramUpdate(messageUpdate('/start', { user: CAROL }));

    expect(lastSendText()).toContain('Welcome');
    expect(lastSendText()).toContain('99');
    expect(lastSendText()).toContain('Ask an instance admin to allow');
    expect(dbTelegramUser(99)).toBeTruthy();
  });

  it('answers non-allowed callback queries with an alert and runs nothing', async () => {
    await handleTelegramUpdate(callbackUpdate('st:1', { user: CAROL }));

    expect(apiMock.answerCallbackQuery).toHaveBeenCalledTimes(1);
    const answer = apiMock.answerCallbackQuery.mock.calls[0][0] as any;
    expect(answer.text).toBe('Not authorized');
    expect(answer.show_alert).toBe(true);
    expect(apiMock.editMessageText).not.toHaveBeenCalled();
    expect(dbTelegramUser(99)).toBeTruthy();
  });

  it('answers callback queries before acting', async () => {
    await handleTelegramUpdate(callbackUpdate('st:0'));

    expect(apiMock.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(apiMock.editMessageText).toHaveBeenCalledTimes(1);
    const answerOrder = apiMock.answerCallbackQuery.mock.invocationCallOrder[0];
    const editOrder = apiMock.editMessageText.mock.invocationCallOrder[0];
    expect(answerOrder).toBeLessThan(editOrder);
  });

  it('ignores updates without a message or callback query', async () => {
    await expect(handleTelegramUpdate({ update_id: 1 })).resolves.toBeUndefined();
    expect(apiMock.sendMessage).not.toHaveBeenCalled();
  });

  it('answers unknown plain text with a /help hint', async () => {
    await handleTelegramUpdate(messageUpdate('hello'));

    expect(lastSendText()).toContain('Use /help');
  });
});

describe('/start, /help and /whoami', () => {
  it('/start welcomes allowed users', async () => {
    await handleTelegramUpdate(messageUpdate('/start'));

    const text = lastSendText();
    expect(text).toContain('Welcome');
    expect(text).toContain('42');
    expect(text).toContain('allowed');
    expect(text).toContain('/help');
  });

  it('/help lists every bot command', async () => {
    await handleTelegramUpdate(messageUpdate('/help'));

    const text = lastSendText();
    for (const entry of BOT_COMMANDS) {
      expect(text).toContain(`/${entry.command}`);
    }
    expect(BOT_COMMANDS.map((entry) => entry.command)).toContain('remove');
  });

  it('/whoami shows the caller identity', async () => {
    await handleTelegramUpdate(messageUpdate('/whoami'));

    const text = lastSendText();
    expect(text).toContain('42');
    expect(text).toContain('@alice');
    expect(text).toContain('allowed');
  });

  it('replies to unknown commands', async () => {
    await handleTelegramUpdate(messageUpdate('/nope'));

    expect(lastSendText()).toContain('Unknown command');
  });
});

describe('/status', () => {
  it('shows status counts and the monitor list', async () => {
    await handleTelegramUpdate(messageUpdate('/status'));

    const text = lastSendText();
    expect(text).toContain('Monitor status');
    expect(text).toContain('Total 4');
    expect(text).toContain('🟢 2');
    expect(text).toContain('🔴 1');
    expect(text).toContain('⚪ 1');
    expect(text).toContain('⏸ 1');
    expect(text).toContain('#1');
    expect(text).toContain('Main API');
    expect(lastSendCallbacks()).toEqual([]);
  });

  it('paginates 10 monitors per page via st:<page> callbacks', async () => {
    for (let index = 1; index <= 8; index++) {
      insertMonitor(testDb, { id: 100 + index, name: `Extra ${index}`, type: 'http', target: `https://extra${index}.example.com` });
    }

    await handleTelegramUpdate(messageUpdate('/status'));
    expect(lastSendText()).toContain('Page 1/2');
    expect(lastSendCallbacks()).toContain('st:1');

    await handleTelegramUpdate(callbackUpdate('st:1'));
    expect(lastEditText()).toContain('Page 2/2');
    expect(lastEditCallbacks()).toContain('st:0');
  });

  it('marks muted monitors', async () => {
    muteMonitor(1, 60 * 60_000, 'test');

    await handleTelegramUpdate(messageUpdate('/status'));

    expect(lastSendText()).toContain('🔇');
  });
});

describe('/info', () => {
  it('shows full details for a monitor id', async () => {
    await handleTelegramUpdate(messageUpdate('/info 1'));

    const text = lastSendText();
    expect(text).toContain('Main API');
    expect(text).toContain('#1');
    expect(text).toContain('https://api.example.com/health');
    expect(text).toContain('Group: Production');
    expect(text).toContain('🟢 UP');
    expect(text).toContain('120ms');
    expect(text).toContain('24h uptime');
    expect(text).toContain('Last incident: none');
  });

  it('shows the open incident and last check for a down monitor', async () => {
    await handleTelegramUpdate(messageUpdate('/info #2'));

    const text = lastSendText();
    expect(text).toContain('🔴 DOWN');
    expect(text).toContain('Connection refused');
    expect(text).toContain('Last incident');
  });

  it('shows the heartbeat URL for heartbeat monitors', async () => {
    await handleTelegramUpdate(messageUpdate('/info 10'));

    expect(lastSendText()).toContain('Heartbeat URL');
    expect(lastSendText()).toContain('/api/v1/heartbeat/tok123');
  });

  it('shows the mute state', async () => {
    muteMonitor(1, 2 * 60 * 60_000, 'test');

    await handleTelegramUpdate(messageUpdate('/info 1'));

    expect(lastSendText()).toContain('Mute: 🔇');
    expect(lastSendText()).toContain('2h');
  });

  it('reports missing monitors', async () => {
    await handleTelegramUpdate(messageUpdate('/info 999'));

    expect(lastSendText()).toContain('Monitor not found');
  });

  it('lists up to 10 candidates for ambiguous names', async () => {
    await handleTelegramUpdate(messageUpdate('/info api'));

    const text = lastSendText();
    expect(text).toContain('Multiple monitors match');
    expect(text).toContain('#1');
    expect(text).toContain('#3');
    expect(text).toContain('Main API');
  });

  it('resolves exact names case-insensitively', async () => {
    await handleTelegramUpdate(messageUpdate('/info main api'));

    expect(lastSendText()).toContain('Main API');
    expect(lastSendText()).not.toContain('Multiple monitors match');
  });

  it('shows usage without arguments', async () => {
    await handleTelegramUpdate(messageUpdate('/info'));

    expect(lastSendText()).toContain('Usage: /info');
  });
});

describe('/add', () => {
  it('creates a monitor in one shot', async () => {
    await handleTelegramUpdate(messageUpdate('/add http https://new.example.com "My New API" group:1'));

    expect(lastSendText()).toContain('Monitor created');
    const created = testDb
      .prepare('SELECT * FROM monitors WHERE name = ?')
      .get('My New API') as any;
    expect(created).toBeTruthy();
    expect(created.type).toBe('http');
    expect(created.target).toBe('https://new.example.com');
    expect(created.group_id).toBe(1);
    expect(schedulerMock.startMonitorJob).toHaveBeenCalled();
  });

  it('derives the default name from the target', async () => {
    await handleTelegramUpdate(messageUpdate('/add dns example.com'));

    const created = testDb.prepare("SELECT * FROM monitors WHERE type = 'dns'").get() as any;
    expect(created).toBeTruthy();
    expect(created.name).toBe('example.com');
  });

  it('accepts a group name in the one-shot form', async () => {
    await handleTelegramUpdate(messageUpdate('/add tcp db2.example.com:6379 Cache group:Production'));

    const created = testDb.prepare("SELECT * FROM monitors WHERE name = 'Cache'").get() as any;
    expect(created).toBeTruthy();
    expect(created.type).toBe('tcp');
    expect(created.target).toBe('db2.example.com:6379');
    expect(created.group_id).toBe(1);
  });

  it('rejects invalid targets and types', async () => {
    await handleTelegramUpdate(messageUpdate('/add http not-a-url'));
    expect(lastSendText()).toContain('valid http');

    await handleTelegramUpdate(messageUpdate('/add ftp example.com'));
    expect(lastSendText()).toContain('Unknown monitor type');
    expect(countRows('monitors')).toBe(4);
  });

  it('walks the interactive wizard to create a monitor', async () => {
    await handleTelegramUpdate(messageUpdate('/add'));
    expect(lastSendText()).toContain('Add monitor');
    expect(lastSendCallbacks()).toContain('add:type:http');

    await handleTelegramUpdate(callbackUpdate('add:type:http'));
    expect(lastEditText()).toContain('Send the URL to check');
    expect(lastEditPayload()?.reply_markup?.force_reply).toBe(true);

    await handleTelegramUpdate(messageUpdate('https://wizard.example.com'));
    expect(lastSendText()).toContain('Send a name');

    await handleTelegramUpdate(messageUpdate('Wizard Monitor'));
    expect(lastSendText()).toContain('Choose a group');
    expect(lastSendCallbacks()).toContain('add:group:1');
    expect(lastSendCallbacks()).toContain('add:group:none');

    await handleTelegramUpdate(callbackUpdate('add:group:1'));
    expect(lastEditText()).toContain('Choose the check interval');
    expect(lastEditCallbacks()).toContain('add:interval:60');

    await handleTelegramUpdate(callbackUpdate('add:interval:300'));
    expect(lastEditText()).toContain('Monitor created');

    const created = testDb.prepare('SELECT * FROM monitors WHERE name = ?').get('Wizard Monitor') as any;
    expect(created).toBeTruthy();
    expect(created.interval).toBe(300);
    expect(created.group_id).toBe(1);
  });

  it('accepts - as the wizard name and uses the target', async () => {
    await handleTelegramUpdate(messageUpdate('/add'));
    await handleTelegramUpdate(callbackUpdate('add:type:icmp'));
    await handleTelegramUpdate(messageUpdate('example.org'));
    await handleTelegramUpdate(messageUpdate('-'));
    await handleTelegramUpdate(callbackUpdate('add:group:none'));
    await handleTelegramUpdate(callbackUpdate('add:interval:60'));

    const created = testDb.prepare("SELECT * FROM monitors WHERE type = 'icmp' AND target = 'example.org'").get() as any;
    expect(created).toBeTruthy();
    expect(created.name).toBe('example.org');
    expect(created.group_id).toBeNull();
  });

  it('rejects callback steps after the wizard expired', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    await handleTelegramUpdate(messageUpdate('/add'));
    vi.advanceTimersByTime(2 * 60_000 + 1_000);

    await handleTelegramUpdate(callbackUpdate('add:type:http'));
    expect(lastEditText().toLowerCase()).toContain('expired');
    expect(countRows('monitors')).toBe(4);
  });
});

describe('/edit', () => {
  it('updates the target directly when given on the command line', async () => {
    await handleTelegramUpdate(messageUpdate('/edit 1 https://changed.example.com'));

    expect(lastSendText()).toContain('Updated target');
    expect(lastSendText()).toContain('https://changed.example.com');
    expect(dbMonitor(1).target).toBe('https://changed.example.com');
    expect(schedulerMock.updateMonitorJob).toHaveBeenCalled();
  });

  it('waits for the new target when it is not given', async () => {
    await handleTelegramUpdate(messageUpdate('/edit #1'));
    expect(lastSendPayload()?.reply_markup?.force_reply).toBe(true);

    await handleTelegramUpdate(messageUpdate('https://edited.example.com'));
    expect(lastSendText()).toContain('Updated target');
    expect(dbMonitor(1).target).toBe('https://edited.example.com');
  });

  it('validates the new target for the monitor type', async () => {
    await handleTelegramUpdate(messageUpdate('/edit 2 https://not-a-tcp-target'));

    expect(lastSendText()).toContain('host:port');
    expect(dbMonitor(2).target).toBe('db.example.com:5432');
  });
});

describe('/remove', () => {
  it('asks for confirmation and deletes only after the button press', async () => {
    await handleTelegramUpdate(messageUpdate('/remove 1'));
    expect(lastSendText()).toContain('Delete monitor?');
    expect(dbMonitor(1)).toBeTruthy();

    const callbacks = lastSendCallbacks();
    const deleteButton = callbacks.find((data) => data.startsWith('rm:1:'));
    expect(deleteButton).toBeTruthy();

    await handleTelegramUpdate(callbackUpdate(deleteButton!));
    expect(lastEditText()).toContain('Deleted');
    expect(dbMonitor(1)).toBeUndefined();
    expect(schedulerMock.stopMonitorJob).toHaveBeenCalledWith(1);
  });

  it('cancels deletion without removing the monitor', async () => {
    await handleTelegramUpdate(messageUpdate('/remove 2'));
    const cancelButton = lastSendCallbacks().find((data) => data.startsWith('rmx:'));
    expect(cancelButton).toBeTruthy();

    await handleTelegramUpdate(callbackUpdate(cancelButton!));
    expect(lastEditText()).toContain('cancelled');
    expect(dbMonitor(2)).toBeTruthy();
  });

  it('is a single-use confirmation', async () => {
    await handleTelegramUpdate(messageUpdate('/remove 1'));
    const deleteButton = lastSendCallbacks().find((data) => data.startsWith('rm:1:'))!;

    await handleTelegramUpdate(callbackUpdate(deleteButton));
    await handleTelegramUpdate(callbackUpdate(deleteButton));

    expect(lastEditText()).toContain('expired');
  });

  it('expires after 120 seconds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    await handleTelegramUpdate(messageUpdate('/remove 1'));
    const deleteButton = lastSendCallbacks().find((data) => data.startsWith('rm:1:'))!;

    vi.advanceTimersByTime(120_000 + 1_000);
    await handleTelegramUpdate(callbackUpdate(deleteButton));

    expect(lastEditText()).toContain('expired');
    expect(dbMonitor(1)).toBeTruthy();
  });

  it('requires an argument', async () => {
    await handleTelegramUpdate(messageUpdate('/remove'));

    expect(lastSendText()).toContain('Usage: /remove');
  });
});

describe('/mute and /unmute', () => {
  it('mutes a monitor for an explicit duration', async () => {
    await handleTelegramUpdate(messageUpdate('/mute #1 1h'));

    expect(lastSendText()).toContain('Muted');
    expect(lastSendText()).toContain('1h');
    const mute = testDb.prepare('SELECT * FROM monitor_mutes WHERE monitor_id = 1').get() as any;
    expect(mute).toBeTruthy();
    expect(mute.muted_by).toBe('tg:42');
  });

  it('offers an inline duration keyboard when no duration is given', async () => {
    await handleTelegramUpdate(messageUpdate('/mute 1'));
    expect(lastSendText()).toContain('For how long');
    expect(lastSendCallbacks()).toContain('mt:1:900');
    expect(lastSendCallbacks()).toContain('mt:1:86400');

    await handleTelegramUpdate(callbackUpdate('mt:1:3600'));
    expect(lastEditText()).toContain('Muted');
    expect(testDb.prepare('SELECT * FROM monitor_mutes WHERE monitor_id = 1').get()).toBeTruthy();
  });

  it('mutes all monitors', async () => {
    await handleTelegramUpdate(messageUpdate('/mute all 15m'));

    expect(lastSendText()).toContain('all monitors');
    const mute = testDb.prepare('SELECT * FROM monitor_mutes WHERE monitor_id IS NULL').get() as any;
    expect(mute).toBeTruthy();
  });

  it('mutes all monitors from the inline duration keyboard', async () => {
    await handleTelegramUpdate(messageUpdate('/mute all'));
    expect(lastSendCallbacks()).toContain('mt:all:900');

    await handleTelegramUpdate(callbackUpdate('mt:all:900'));

    expect(lastEditText()).toContain('all monitors');
    expect(testDb.prepare('SELECT * FROM monitor_mutes WHERE monitor_id IS NULL').get()).toBeTruthy();
  });

  it('rejects invalid durations', async () => {
    await handleTelegramUpdate(messageUpdate('/mute 1 nonsense'));

    expect(lastSendText()).toContain('Invalid duration');
    expect(countRows('monitor_mutes')).toBe(0);
  });

  it('unmutes a single monitor', async () => {
    await handleTelegramUpdate(messageUpdate('/mute 1 1h'));
    await handleTelegramUpdate(messageUpdate('/unmute 1'));

    expect(lastSendText()).toContain('Unmuted');
    expect(countRows('monitor_mutes')).toBe(0);
  });

  it('reports when a monitor is not muted', async () => {
    await handleTelegramUpdate(messageUpdate('/unmute 1'));

    expect(lastSendText()).toContain('not muted');
  });

  it('unmutes everything with /unmute all', async () => {
    muteMonitor(1, 60 * 60_000, 'test');
    muteMonitor(2, 60 * 60_000, 'test');
    muteMonitor(null, 60 * 60_000, 'test');

    await handleTelegramUpdate(messageUpdate('/unmute all'));

    expect(lastSendText()).toContain('Cleared 3');
    expect(countRows('monitor_mutes')).toBe(0);
  });
});

describe('/pause and /resume', () => {
  it('pauses and resumes a monitor', async () => {
    await handleTelegramUpdate(messageUpdate('/pause 1'));
    expect(lastSendText()).toContain('Paused');
    expect(dbMonitor(1).active).toBe(0);

    await handleTelegramUpdate(messageUpdate('/resume 1'));
    expect(lastSendText()).toContain('Resumed');
    expect(dbMonitor(1).active).toBe(1);
  });
});

describe('/restart', () => {
  it('runs a check immediately for one monitor', async () => {
    await handleTelegramUpdate(messageUpdate('/restart 1'));

    expect(executeCheckMock).toHaveBeenCalledTimes(1);
    expect(executeCheckMock.mock.calls[0][0]).toMatchObject({ id: 1, name: 'Main API' });
    expect(schedulerMock.stopMonitorJob).toHaveBeenCalledWith(1);
    expect(schedulerMock.startMonitorJob).toHaveBeenCalled();
    expect(lastSendText()).toContain('Ran checks for 1 monitor');
  });

  it('defaults to all active monitors', async () => {
    await handleTelegramUpdate(messageUpdate('/restart'));

    expect(executeCheckMock).toHaveBeenCalledTimes(3); // monitors 1, 2 and 10 are active
    expect(lastSendText()).toContain('Ran checks for 3 monitors');
  });

  it('reports failures without throwing', async () => {
    executeCheckMock.mockRejectedValueOnce(new Error('checker exploded'));

    await handleTelegramUpdate(messageUpdate('/restart'));

    expect(lastSendText()).toContain('Failures');
    expect(lastSendText()).toContain('checker exploded');
  });
});

describe('/ping', () => {
  it('runs an HTTP check without writing to the database', async () => {
    const monitorsBefore = countRows('monitors');
    const checksBefore = countRows('checks');

    await handleTelegramUpdate(messageUpdate('/ping https://example.com'));

    expect(checkerMocks.performHttpCheck).toHaveBeenCalledTimes(1);
    const text = lastSendText();
    expect(text).toContain('One-off check');
    expect(text).toContain('🟢 UP');
    expect(text).toContain('200');
    expect(countRows('monitors')).toBe(monitorsBefore);
    expect(countRows('checks')).toBe(checksBefore);
    expect(executeCheckMock).not.toHaveBeenCalled();
  });

  it('routes tcp, tls, dns and icmp targets to the right checker', async () => {
    await handleTelegramUpdate(messageUpdate('/ping db.example.com:5432'));
    expect(checkerMocks.performTcpCheck).toHaveBeenCalledTimes(1);
    resetCommandState(); // avoid the 3s rate limit between pings

    await handleTelegramUpdate(messageUpdate('/ping tls://example.com:443'));
    expect(checkerMocks.performTlsCheck).toHaveBeenCalledTimes(1);
    resetCommandState();

    await handleTelegramUpdate(messageUpdate('/ping dns://example.com'));
    expect(checkerMocks.performDnsCheck).toHaveBeenCalledTimes(1);
    resetCommandState();

    await handleTelegramUpdate(messageUpdate('/ping example.com'));
    expect(checkerMocks.performIcmpCheck).toHaveBeenCalledTimes(1);
  });

  it('reports failed checks', async () => {
    checkerMocks.performHttpCheck.mockResolvedValueOnce({
      status: 0,
      response_time: 90,
      status_code: 503,
      message: 'Service Unavailable',
    });

    await handleTelegramUpdate(messageUpdate('/ping https://down.example.com'));

    const text = lastSendText();
    expect(text).toContain('🔴 DOWN');
    expect(text).toContain('503');
    expect(text).toContain('Service Unavailable');
  });

  it('rate limits to one ping per 3 seconds per user', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    await handleTelegramUpdate(messageUpdate('/ping https://example.com'));
    expect(lastSendText()).toContain('One-off check');

    await handleTelegramUpdate(messageUpdate('/ping https://example.com'));
    expect(lastSendText()).toContain('Slow down');

    vi.advanceTimersByTime(3_000 + 100);
    await handleTelegramUpdate(messageUpdate('/ping https://example.com'));
    expect(lastSendText()).toContain('One-off check');
    expect(checkerMocks.performHttpCheck).toHaveBeenCalledTimes(2);
  });

  it('shows usage without a target', async () => {
    await handleTelegramUpdate(messageUpdate('/ping'));

    expect(lastSendText()).toContain('Usage: /ping');
  });
});

describe('/allow, /deny and /users', () => {
  it('allows a user by id', async () => {
    await handleTelegramUpdate(messageUpdate('/allow 555'));

    expect(lastSendText()).toContain('Allowed');
    expect(lastSendText()).toContain('555');
    const record = dbTelegramUser(555);
    expect(record.is_allowed).toBe(1);
    expect(record.allowed_by).toBe(42);
  });

  it('allows a user by replying to their message', async () => {
    await handleTelegramUpdate(messageUpdate('/allow', { replyTo: { id: 556, is_bot: false, first_name: 'Dan' } }));

    expect(lastSendText()).toContain('556');
    expect(dbTelegramUser(556).is_allowed).toBe(1);
  });

  it('denies another user', async () => {
    await handleTelegramUpdate(messageUpdate('/deny 43'));

    expect(lastSendText()).toContain('Denied');
    expect(dbTelegramUser(43).is_allowed).toBe(0);
  });

  it('refuses self-denial', async () => {
    await handleTelegramUpdate(messageUpdate('/deny 42'));

    expect(lastSendText()).toContain('cannot deny yourself');
    expect(dbTelegramUser(42).is_allowed).toBe(1);
  });

  it('reports users that never talked to the bot', async () => {
    await handleTelegramUpdate(messageUpdate('/deny 777'));

    expect(lastSendText()).toContain('never talked');
  });

  it('/users lists allowed users and pending requests', async () => {
    await handleTelegramUpdate(messageUpdate('/users'));

    const text = lastSendText();
    expect(text).toContain('Allowed (2)');
    expect(text).toContain('alice');
    expect(text).toContain('Pending requests: 1');
    expect(text).toContain('99');
  });
});

describe('/groups', () => {
  it('lists groups with monitor counts', async () => {
    await handleTelegramUpdate(messageUpdate('/groups'));

    const text = lastSendText();
    expect(text).toContain('Production');
    expect(text).toContain('2 monitors');
    expect(text).toContain('Internal');
    expect(text).toContain('0 monitors');
  });
});

describe('/app', () => {
  it('sends a web_app button when configured', async () => {
    await handleTelegramUpdate(messageUpdate('/app'));

    const markup = lastSendPayload()?.reply_markup;
    expect(markup.inline_keyboard[0][0].web_app.url).toBe('https://status.example.com');
    expect(lastSendText()).toContain('Mini App');
  });

  it('explains when no web app URL is configured', async () => {
    testDb.prepare("DELETE FROM settings WHERE key = 'telegram_webapp_url'").run();

    await handleTelegramUpdate(messageUpdate('/app'));

    expect(lastSendText()).toContain('not configured');
  });
});

describe('/cancel and pending state', () => {
  it('clears the pending wizard', async () => {
    await handleTelegramUpdate(messageUpdate('/add'));
    await handleTelegramUpdate(messageUpdate('/cancel'));
    expect(lastSendText()).toContain('cancelled');

    // The next plain text is no longer consumed by the wizard.
    await handleTelegramUpdate(messageUpdate('https://example.com'));
    expect(lastSendText()).toContain('Use /help');
  });

  it('new commands abandon a half-finished wizard', async () => {
    await handleTelegramUpdate(messageUpdate('/add'));
    await handleTelegramUpdate(callbackUpdate('add:type:http'));
    await handleTelegramUpdate(messageUpdate('/status'));

    expect(lastSendText()).toContain('Monitor status');
  });

  it('reminds users to press the buttons while a delete confirmation is pending', async () => {
    await handleTelegramUpdate(messageUpdate('/remove 1'));
    await handleTelegramUpdate(messageUpdate('yes please'));

    expect(lastSendText()).toContain('Press');
  });
});

describe('multi-word monitor names', () => {
  beforeEach(() => {
    insertMultiWordMonitor();
  });

  it('/remove accepts an unquoted multi-word name', async () => {
    await handleTelegramUpdate(messageUpdate('/remove My Cool API'));

    expect(lastSendText()).toContain('Delete monitor?');
    expect(lastSendText()).toContain('My Cool API');
    const deleteButton = lastSendCallbacks().find((data) => data.startsWith('rm:400:'));
    expect(deleteButton).toBeTruthy();

    await handleTelegramUpdate(callbackUpdate(deleteButton!));
    expect(dbMonitor(400)).toBeUndefined();
  });

  it('/pause and /resume accept an unquoted multi-word name', async () => {
    await handleTelegramUpdate(messageUpdate('/pause My Cool API'));
    expect(lastSendText()).toContain('Paused');
    expect(dbMonitor(400).active).toBe(0);

    await handleTelegramUpdate(messageUpdate('/resume My Cool API'));
    expect(lastSendText()).toContain('Resumed');
    expect(dbMonitor(400).active).toBe(1);
  });

  it('/mute accepts an unquoted multi-word name with a duration', async () => {
    await handleTelegramUpdate(messageUpdate('/mute My Cool API 1h'));

    expect(lastSendText()).toContain('Muted');
    expect(testDb.prepare('SELECT * FROM monitor_mutes WHERE monitor_id = 400').get()).toBeTruthy();
  });

  it('/mute accepts an unquoted multi-word name without a duration', async () => {
    await handleTelegramUpdate(messageUpdate('/mute My Cool API'));

    expect(lastSendText()).toContain('For how long');
    expect(lastSendCallbacks()).toContain('mt:400:900');
  });

  it('/unmute accepts an unquoted multi-word name', async () => {
    muteMonitor(400, 60 * 60_000, 'test');

    await handleTelegramUpdate(messageUpdate('/unmute My Cool API'));

    expect(lastSendText()).toContain('Unmuted');
    expect(countRows('monitor_mutes')).toBe(0);
  });

  it('/edit accepts an unquoted multi-word name and a target', async () => {
    await handleTelegramUpdate(messageUpdate('/edit My Cool API https://changed.example.com'));

    expect(lastSendText()).toContain('Updated target');
    expect(dbMonitor(400).target).toBe('https://changed.example.com');
  });

  it('/edit treats the whole input as the reference when the last word is no target', async () => {
    await handleTelegramUpdate(messageUpdate('/edit My Cool API'));

    expect(lastSendPayload()?.reply_markup?.force_reply).toBe(true);
    await handleTelegramUpdate(messageUpdate('https://edited.example.com'));
    expect(dbMonitor(400).target).toBe('https://edited.example.com');
  });

  it('keeps quoted names working', async () => {
    await handleTelegramUpdate(messageUpdate('/remove "My Cool API"'));

    expect(lastSendText()).toContain('My Cool API');
    expect(lastSendCallbacks().some((data) => data.startsWith('rm:400:'))).toBe(true);
  });

  it('keeps /mute all working', async () => {
    await handleTelegramUpdate(messageUpdate('/mute all 1h'));

    expect(lastSendText()).toContain('all monitors');
    expect(testDb.prepare('SELECT * FROM monitor_mutes WHERE monitor_id IS NULL').get()).toBeTruthy();
  });

  it('keeps numeric ids and #ids working', async () => {
    await handleTelegramUpdate(messageUpdate('/mute 2 1h'));
    expect(testDb.prepare('SELECT * FROM monitor_mutes WHERE monitor_id = 2').get()).toBeTruthy();

    await handleTelegramUpdate(messageUpdate('/unmute #2'));
    expect(testDb.prepare('SELECT * FROM monitor_mutes WHERE monitor_id = 2').get()).toBeFalsy();
  });

  it('keeps /edit with an id and target working', async () => {
    await handleTelegramUpdate(messageUpdate('/edit 2 db.example.com:6543'));

    expect(dbMonitor(2).target).toBe('db.example.com:6543');
  });
});

describe('robustness', () => {
  it('turns unexpected errors into an ❌ reply instead of throwing', async () => {
    apiMock.sendMessage.mockRejectedValueOnce(new Error('network down'));

    await expect(handleTelegramUpdate(messageUpdate('/status'))).resolves.toBeUndefined();
  });

  it('rejects unknown callback actions gracefully', async () => {
    await handleTelegramUpdate(callbackUpdate('zz:1'));

    expect(allEditedText()).toContain('Unknown or expired action');
  });

  it('does not escape HTML in names and targets (escapes them instead)', async () => {
    testDb.prepare("UPDATE monitors SET name = '<b>evil</b>' WHERE id = 1").run();

    await handleTelegramUpdate(messageUpdate('/info 1'));

    expect(lastSendText()).toContain('&lt;b&gt;evil&lt;/b&gt;');
    expect(lastSendText()).not.toContain('<b>evil</b>');
  });
});
