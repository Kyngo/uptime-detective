/**
 * End-to-end test: the REAL Uptime Detective server (spawned with `tsx`) talking
 * to the mock Telegram Bot API (`scripts/mock-telegram-server.mjs`).
 *
 * What is covered:
 *  - bot startup: getMe / setMyCommands / long polling with the instance token
 *  - allow-list gating: unknown Telegram user gets "not authorized", cannot mutate
 *  - `/start` welcome for a bootstrapped admin (TELEGRAM_ADMIN_USER_IDS)
 *  - `/add` one-shot creates a monitor row in SQLite
 *  - `/status` reports that monitor
 *  - `/remove` requires the inline confirmation; the callback actually deletes
 *  - self `/deny` is refused
 *  - `/mute all` persists a global mute row
 *  - `/ping` against a closed port replies with a failure and persists nothing
 *  - REST API security: token never returned/logged, env-managed token rejected,
 *    Mini App initData HMAC validation (valid / tampered / stale / not allowed),
 *    shadow user cannot password-login, webapp auth is rate limited.
 *
 * The spawned server uses a throw-away SQLite DB in /tmp; the real `data/` DB
 * and `.env` are never touched.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMockTelegramServer } from '../../../scripts/mock-telegram-server.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(TEST_DIR, '..', '..');
const REPO_ROOT = path.resolve(SERVER_DIR, '..');

const BOT_TOKEN = '123456789:TESTTOKEN';
const ADMIN_TG_ID = 42;
const UNKNOWN_TG_ID = 99;
const CLOSED_TARGET = 'http://127.0.0.1:1';
const DB_PATH = path.join('/tmp', `ud-e2e-${process.pid}-${Date.now()}.db`);
const BOT_USERNAME = 'uptime_detective_mock_bot';

const SERVER_LOG_LIMIT = 200_000;

let mock: any;
let child: ChildProcess | undefined;
let childExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
let serverLog = '';
let serverBaseUrl = '';
let db: Database.Database | undefined;

// === Generic helpers ===

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendServerLog(chunk: Buffer | string): void {
  serverLog += String(chunk);
  if (serverLog.length > SERVER_LOG_LIMIT) serverLog = serverLog.slice(-SERVER_LOG_LIMIT);
}

function serverDebugInfo(): string {
  return `\n--- server stdout/stderr ---\n${serverLog || '(empty)'}\n--- child exit: ${JSON.stringify(childExit)}`;
}

function assertServerAlive(): void {
  if (childExit) {
    throw new Error(`Server process exited early: ${JSON.stringify(childExit)}${serverDebugInfo()}`);
  }
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = createNetServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address();
      if (!address || typeof address === 'string') {
        socket.close();
        reject(new Error('Could not determine a free port'));
        return;
      }
      const { port } = address;
      socket.close(() => resolve(port));
    });
  });
}

function resolveTsxCli(): string | null {
  const candidates = [
    path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    path.join(SERVER_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function waitForServerReady(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no attempt yet';
  while (Date.now() < deadline) {
    assertServerAlive();
    try {
      const response = await fetch(`${serverBaseUrl}/api/v1/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
      lastError = `health returned HTTP ${response.status}`;
    } catch (error: any) {
      lastError = error?.message ?? String(error);
    }
    await sleep(200);
  }
  throw new Error(`Server did not become healthy within ${timeoutMs}ms (${lastError})${serverDebugInfo()}`);
}

// === Mock Bot API control helpers (over HTTP control endpoints) ===

async function mockCalls(method?: string): Promise<any[]> {
  const url = method ? `${mock.url}/__mock/calls?method=${encodeURIComponent(method)}` : `${mock.url}/__mock/calls`;
  const response = await fetch(url);
  const body = (await response.json()) as any;
  return body.calls as any[];
}

async function mockCallCount(method: string): Promise<number> {
  return (await mockCalls(method)).length;
}

async function enqueueUpdate(update: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${mock.url}/__mock/updates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  });
  if (!response.ok) throw new Error(`Failed to enqueue mock update: HTTP ${response.status}`);
}

/** Wait until a call of `method` (after `baseline`) matches `matcher`. */
async function waitForCall(
  method: string,
  matcher: (call: any) => boolean,
  opts: { baseline?: number; timeout?: number; label?: string } = {}
): Promise<any> {
  const baseline = opts.baseline ?? 0;
  const timeout = opts.timeout ?? 15_000;
  const deadline = Date.now() + timeout;
  let seen = baseline;
  while (Date.now() < deadline) {
    assertServerAlive();
    const calls = await mockCalls(method);
    seen = calls.length;
    const match = calls.slice(baseline).find((call) => matcher(call));
    if (match) return match;
    await sleep(100);
  }
  throw new Error(
    `Timed out after ${timeout}ms waiting for ${opts.label ?? method} ` +
      `(baseline ${baseline}, total ${seen})${serverDebugInfo()}`
  );
}

function callChatId(call: any): number | string | undefined {
  const raw = call?.params?.chat_id;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string' && /^-?\d+$/.test(raw)) return Number(raw);
  return raw;
}

function callText(call: any): string {
  return String(call?.params?.text ?? '');
}

/** Wait for a `sendMessage` reply to a chat whose text matches `pattern`. */
async function waitForReply(
  chatId: number | string,
  pattern: RegExp,
  opts: { baseline: number; timeout?: number; label?: string }
): Promise<any> {
  return waitForCall(
    'sendMessage',
    (call) => callChatId(call) === chatId && pattern.test(callText(call)),
    { baseline: opts.baseline, timeout: opts.timeout, label: opts.label ?? `reply ${pattern} to ${chatId}` }
  );
}

// === Telegram update builders ===

let fakeMessageId = 1;
let fakeCallbackId = 1;

function telegramUser(id: number, username?: string) {
  return { id, is_bot: false, first_name: `QA-${id}`, ...(username ? { username } : {}) };
}

function userMessageUpdate(text: string, userId: number = ADMIN_TG_ID): Record<string, unknown> {
  return {
    message: {
      message_id: fakeMessageId++,
      from: telegramUser(userId, userId === ADMIN_TG_ID ? 'qa_admin' : undefined),
      chat: { id: userId, type: 'private', first_name: `QA-${userId}` },
      date: Math.floor(Date.now() / 1000),
      text,
    },
  };
}

async function sendUserMessage(text: string, userId: number = ADMIN_TG_ID): Promise<void> {
  await enqueueUpdate(userMessageUpdate(text, userId));
}

/** Build a callback_query update for a previously recorded bot message. */
function callbackUpdate(data: string, sentMessage: any, userId: number = ADMIN_TG_ID): Record<string, unknown> {
  return {
    callback_query: {
      id: `qa-cb-${fakeCallbackId++}`,
      from: telegramUser(userId, userId === ADMIN_TG_ID ? 'qa_admin' : undefined),
      message: {
        message_id: sentMessage?.result?.message_id ?? 0,
        from: { id: 123456789, is_bot: true, first_name: 'Uptime Detective (mock)', username: BOT_USERNAME },
        chat: { id: sentMessage?.result?.chat?.id ?? userId, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: callText(sentMessage),
      },
      chat_instance: 'qa-chat-instance',
      data,
    },
  };
}

function inlineButtons(call: any): any[] {
  const markup = call?.params?.reply_markup;
  const rows = markup?.inline_keyboard;
  return Array.isArray(rows) ? (rows as any[]).flat() : [];
}

// === DB helpers (read-only copy of the spawned server's SQLite DB) ===

function dbAll<T = any>(sql: string, ...params: any[]): T[] {
  try {
    return (db as Database.Database).prepare(sql).all(...params) as T[];
  } catch {
    return [];
  }
}

function dbGet<T = any>(sql: string, ...params: any[]): T | undefined {
  try {
    return (db as Database.Database).prepare(sql).get(...params) as T | undefined;
  } catch {
    return undefined;
  }
}

async function waitForDb<T>(
  read: () => T | null | undefined | false,
  label: string,
  timeoutMs = 15_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastValue: any;
  while (Date.now() < deadline) {
    assertServerAlive();
    const value = read();
    lastValue = value;
    if (value) return value as T;
    await sleep(100);
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for DB condition: ${label} (last=${JSON.stringify(lastValue)})` +
      serverDebugInfo()
  );
}

function getMonitors(): any[] {
  return dbAll('SELECT * FROM monitors ORDER BY id ASC');
}

function getMonitorByName(name: string): any | undefined {
  return dbGet('SELECT * FROM monitors WHERE name = ?', name);
}

function countChecks(): number {
  return dbGet<{ count: number }>('SELECT COUNT(*) AS count FROM checks')?.count ?? 0;
}

/** Create a monitor through the bot one-shot `/add` command and wait for the row. */
async function createMonitorViaBot(name: string): Promise<any> {
  await sendUserMessage(`/add http ${CLOSED_TARGET}/${name} ${name}`, ADMIN_TG_ID);
  return waitForDb(() => getMonitorByName(name), `monitor ${name} created via /add`);
}

/** Send `/remove <id>` and return the confirmation message call (with its keyboard). */
async function requestRemoval(monitor: any): Promise<any> {
  const baseline = await mockCallCount('sendMessage');
  await sendUserMessage(`/remove ${monitor.id}`, ADMIN_TG_ID);
  return waitForReply(ADMIN_TG_ID, new RegExp(`#${monitor.id}\\b`), {
    baseline,
    label: `/remove confirmation for #${monitor.id}`,
  });
}

/** Click the confirm or cancel button of a `/remove` confirmation as a given user. */
async function clickRemoveButton(
  confirmation: any,
  prefix: 'rm:' | 'rmx:',
  userId: number = ADMIN_TG_ID
): Promise<string> {
  const button = inlineButtons(confirmation).find(
    (candidate) => typeof candidate.callback_data === 'string' && candidate.callback_data.startsWith(prefix)
  );
  if (!button) throw new Error(`No ${prefix} button on the confirmation keyboard`);
  await enqueueUpdate(callbackUpdate(button.callback_data, confirmation, userId));
  return button.callback_data;
}

// === Telegram Mini App initData signing (mirrors Telegram's documented scheme) ===

function signInitData(
  user: Record<string, unknown>,
  botToken: string = BOT_TOKEN,
  authDate: number = Math.floor(Date.now() / 1000)
): string {
  const params = new URLSearchParams();
  params.set('auth_date', String(authDate));
  params.set('query_id', 'AAHdF6IQAAAAAN0Xoha');
  params.set('user', JSON.stringify(user));

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken, 'utf8').digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString, 'utf8').digest('hex');
  params.set('hash', hash);
  return params.toString();
}

const adminTelegramUser = {
  id: ADMIN_TG_ID,
  first_name: 'QA',
  last_name: 'Admin',
  username: 'qa_admin',
  language_code: 'en',
};

// === Test suite ===

describe('Telegram bot E2E (real server + mock Bot API)', () => {
  beforeAll(async () => {
    const tsxCli = resolveTsxCli();
    if (!tsxCli) throw new Error('tsx CLI not found — run the test with the repo node_modules installed');

    mock = await startMockTelegramServer();
    const appPort = await findFreePort();
    serverBaseUrl = `http://127.0.0.1:${appPort}`;

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: String(appPort),
      HOST: '127.0.0.1',
      NODE_ENV: 'development',
      JWT_SECRET: 'qa-e2e-secret-not-for-production',
      SESSION_EXPIRY: '7d',
      DB_PATH,
      // The instance-wide bot under test:
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_BOT_ENABLED: 'true',
      TELEGRAM_API_BASE_URL: mock.url,
      TELEGRAM_ADMIN_USER_IDS: String(ADMIN_TG_ID),
      TELEGRAM_WEBAPP_URL: '',
      TELEGRAM_WEBAPP_AUTH_MAX_AGE: '86400',
      ALLOW_PRIVATE_IPS: 'true',
      APP_URL: '',
    };

    child = spawn(process.execPath, [tsxCli, 'src/index.ts'], {
      cwd: SERVER_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', appendServerLog);
    child.stderr?.on('data', appendServerLog);
    child.on('exit', (code, signal) => {
      childExit = { code, signal };
    });

    await waitForServerReady();

    // Read-only connection to the spawned server's throw-away DB.
    db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 5000');

    // The bot start sequence must have happened: getMe + setMyCommands + polling.
    await waitForCall('getMe', () => true, { timeout: 20_000, label: 'getMe (bot startup)' });
    await waitForCall('setMyCommands', () => true, { timeout: 20_000, label: 'setMyCommands (bot startup)' });
    await waitForCall('getUpdates', () => true, { timeout: 20_000, label: 'getUpdates (long polling)' });

    // The bootstrap allow list (TELEGRAM_ADMIN_USER_IDS=42) must be applied before we test.
    await waitForDb(
      () => dbGet('SELECT * FROM telegram_users WHERE telegram_user_id = ? AND is_allowed = 1', ADMIN_TG_ID),
      'bootstrap admin 42 allowed'
    );
  }, 120_000);

  afterAll(async () => {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    if (child && !childExit) {
      child.kill('SIGTERM');
      const exited = await Promise.race([
        new Promise<boolean>((resolve) => child?.once('exit', () => resolve(true))),
        sleep(8_000).then(() => false),
      ]);
      if (!exited) child.kill('SIGKILL');
    }
    try {
      await mock?.close();
    } catch {
      /* ignore */
    }
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        rmSync(`${DB_PATH}${suffix}`, { force: true });
      } catch {
        /* ignore */
      }
    }
  }, 30_000);

  it('starts the bot with the instance-wide token and registers its command list', async () => {
    const meCalls = await mockCalls('getMe');
    expect(meCalls.length).toBeGreaterThanOrEqual(1);
    // Every Bot API call must use the instance-wide token from env.
    for (const method of ['getMe', 'setMyCommands', 'getUpdates']) {
      const calls = await mockCalls(method);
      expect(calls.length, `${method} should be called`).toBeGreaterThanOrEqual(1);
      for (const call of calls) expect(call.token).toBe(BOT_TOKEN);
    }
    const setMyCommands = await mockCalls('setMyCommands');
    expect(Array.isArray(setMyCommands[0]?.params?.commands)).toBe(true);
    expect(setMyCommands[0].params.commands.length).toBeGreaterThan(5);
    expect(serverLog).not.toContain(BOT_TOKEN);
  }, 30_000);

  it('rejects an unknown Telegram user and does not create anything', async () => {
    const monitorsBefore = getMonitors().length;

    // /start is always answered: it shows the numeric ID and the access state.
    const startBaseline = await mockCallCount('sendMessage');
    await sendUserMessage('/start', UNKNOWN_TG_ID);
    const startReply = await waitForReply(UNKNOWN_TG_ID, /(not allowed|not authorized)/i, {
      baseline: startBaseline,
      label: '/start reply to unknown user 99',
    });
    expect(callText(startReply)).toContain(String(UNKNOWN_TG_ID));

    // Any other command from an unknown user gets the "Not authorized" notice
    // with its ID — and must never execute.
    const commandBaseline = await mockCallCount('sendMessage');
    await sendUserMessage('/add http http://127.0.0.1:1/should-not-exist Unknown-Monitor', UNKNOWN_TG_ID);
    const unauthorized = await waitForReply(UNKNOWN_TG_ID, /not authorized/i, {
      baseline: commandBaseline,
      label: 'not-authorized reply to unknown user 99',
    });
    expect(callText(unauthorized)).toContain(String(UNKNOWN_TG_ID));

    // User is tracked as pending but not allowed, and no monitor was created.
    const row = await waitForDb(
      () => dbGet('SELECT * FROM telegram_users WHERE telegram_user_id = ?', UNKNOWN_TG_ID),
      `telegram_users row for ${UNKNOWN_TG_ID}`
    );
    expect(Number(row.is_allowed)).toBe(0);
    expect(getMonitors().length).toBe(monitorsBefore);
    expect(getMonitorByName('Unknown-Monitor')).toBeFalsy();
  }, 40_000);

  it('welcomes the bootstrapped admin on /start', async () => {
    const baseline = await mockCallCount('sendMessage');
    await sendUserMessage('/start', ADMIN_TG_ID);
    const reply = await waitForReply(ADMIN_TG_ID, /welcome/i, {
      baseline,
      label: 'welcome reply to admin 42',
    });
    expect(callText(reply)).toContain(String(ADMIN_TG_ID));
  }, 30_000);

  it('/add one-shot creates a monitor row', async () => {
    const baseline = await mockCallCount('sendMessage');
    await sendUserMessage('/add http http://127.0.0.1:1/e2e E2E-Monitor', ADMIN_TG_ID);

    const monitor = await waitForDb(() => getMonitorByName('E2E-Monitor'), 'monitor E2E-Monitor created');
    expect(monitor.type).toBe('http');
    expect(monitor.target).toBe('http://127.0.0.1:1/e2e');
    expect(Number(monitor.active)).toBe(1);

    const confirmation = await waitForReply(ADMIN_TG_ID, /(created|added|monitor)/i, {
      baseline,
      label: '/add confirmation reply',
    });
    expect(callText(confirmation)).toContain('E2E-Monitor');
  }, 30_000);

  it('/status reply contains the created monitor', async () => {
    const monitor = getMonitorByName('E2E-Monitor');
    expect(monitor).toBeTruthy();

    const baseline = await mockCallCount('sendMessage');
    await sendUserMessage('/status', ADMIN_TG_ID);
    const reply = await waitForReply(ADMIN_TG_ID, new RegExp(`#${monitor.id}\\b`), {
      baseline,
      label: `/status reply containing #${monitor.id}`,
    });
    expect(callText(reply)).toContain('E2E-Monitor');
  }, 30_000);

  it('/remove asks for confirmation, then the callback deletes the monitor', async () => {
    const monitor = getMonitorByName('E2E-Monitor');
    expect(monitor).toBeTruthy();

    const baseline = await mockCallCount('sendMessage');
    await sendUserMessage(`/remove ${monitor.id}`, ADMIN_TG_ID);

    const confirmation = await waitForReply(ADMIN_TG_ID, new RegExp(`#${monitor.id}\\b`), {
      baseline,
      label: '/remove confirmation message',
    });

    // Confirmation keyboard with a delete callback is required.
    const buttons = inlineButtons(confirmation);
    expect(buttons.length).toBeGreaterThan(0);
    const deleteButton = buttons.find(
      (button) => typeof button.callback_data === 'string' && button.callback_data.startsWith('rm:')
    );
    expect(deleteButton, 'inline keyboard must contain an rm:<id>:<nonce> callback').toBeTruthy();

    // Nothing is deleted before the callback.
    expect(getMonitorByName('E2E-Monitor')).toBeTruthy();

    await enqueueUpdate(callbackUpdate(deleteButton.callback_data, confirmation, ADMIN_TG_ID));

    await waitForDb(() => (getMonitorByName('E2E-Monitor') ? null : true), 'monitor deleted after callback');

    // The callback was always answered.
    await waitForCall(
      'answerCallbackQuery',
      (call) => String(call.params?.callback_query_id ?? '').length > 0,
      { timeout: 10_000, label: 'answerCallbackQuery after delete callback' }
    );

    // A replayed callback must not resurrect the monitor or crash the bot.
    const replay = callbackUpdate(deleteButton.callback_data, confirmation, ADMIN_TG_ID);
    await enqueueUpdate(replay);
    await sleep(750);
    expect(getMonitorByName('E2E-Monitor')).toBeFalsy();
    expect(serverLog).not.toMatch(/Failed to handle update .* (TypeError|ReferenceError)/);
  }, 40_000);

  it('refuses self-denial', async () => {
    const baseline = await mockCallCount('sendMessage');
    await sendUserMessage(`/deny ${ADMIN_TG_ID}`, ADMIN_TG_ID);
    const reply = await waitForReply(ADMIN_TG_ID, /cannot deny yourself/i, {
      baseline,
      label: 'self-deny refusal',
    });
    expect(callText(reply)).toMatch(/cannot deny yourself/i);

    const row = dbGet('SELECT * FROM telegram_users WHERE telegram_user_id = ?', ADMIN_TG_ID);
    expect(Number(row.is_allowed)).toBe(1);
  }, 30_000);

  it('/mute all persists a global mute row', async () => {
    const baseline = await mockCallCount('sendMessage');
    await sendUserMessage('/mute all 1h', ADMIN_TG_ID);

    const mute = await waitForDb(
      () => dbGet("SELECT * FROM monitor_mutes WHERE monitor_id IS NULL ORDER BY id DESC LIMIT 1"),
      'global mute row created by /mute all 1h'
    );
    const until = Date.parse(String(mute.muted_until).includes('T') ? String(mute.muted_until) : `${mute.muted_until}Z`);
    expect(until).toBeGreaterThan(Date.now() + 55 * 60_000);
    expect(until).toBeLessThan(Date.now() + 65 * 60_000);

    await waitForReply(ADMIN_TG_ID, /(muted|mute)/i, { baseline, label: '/mute reply' });
    // Mute suppresses notifications only; checks are unaffected (dispatcher unit
    // test covers suppression, this asserts the persisted state used by it).
  }, 30_000);

  it('/ping a closed port replies with a failure and persists nothing', async () => {
    const checksBefore = countChecks();
    const monitorsBefore = getMonitors().length;

    const baseline = await mockCallCount('sendMessage');
    await sendUserMessage(`/ping ${CLOSED_TARGET}`, ADMIN_TG_ID);

    const failureReply = await waitForReply(ADMIN_TG_ID, /(down|refused|failed|unreachable|error)/i, {
      baseline,
      timeout: 25_000,
      label: '/ping failure reply',
    });
    expect(callText(failureReply).length).toBeGreaterThan(0);

    await sleep(500);
    expect(getMonitors().length).toBe(monitorsBefore);
    expect(countChecks()).toBe(checksBefore);
  }, 40_000);

  it('/unmute all clears the global mute', async () => {
    const baseline = await mockCallCount('sendMessage');
    await sendUserMessage('/unmute all', ADMIN_TG_ID);
    await waitForReply(ADMIN_TG_ID, /cleared/i, { baseline, label: '/unmute all reply' });
    await waitForDb(
      () => (dbAll('SELECT * FROM monitor_mutes').length === 0 ? true : null),
      'all mute rows removed by /unmute all'
    );
  }, 30_000);

  it('allow-list gating also applies to callback queries', async () => {
    const monitor = await createMonitorViaBot('Guarded-Monitor');
    const confirmation = await requestRemoval(monitor);

    // Unknown user clicks the delete button: the callback is answered but the
    // command is never executed (monitor must survive).
    const answersBaseline = await mockCallCount('answerCallbackQuery');
    await clickRemoveButton(confirmation, 'rm:', UNKNOWN_TG_ID);
    await waitForCall(
      'answerCallbackQuery',
      (call) => /not authorized/i.test(String(call.params?.text ?? '')),
      { baseline: answersBaseline, label: 'not-authorized callback alert' }
    );
    await sleep(500);
    expect(getMonitorByName('Guarded-Monitor')).toBeTruthy();

    // The rightful owner's still-valid confirmation button works.
    await clickRemoveButton(confirmation, 'rm:', ADMIN_TG_ID);
    await waitForDb(
      () => (getMonitorByName('Guarded-Monitor') ? null : true),
      'monitor deleted by its owner after a foreign callback attempt'
    );
  }, 40_000);

  it('/remove Cancel keeps the monitor, and a later confirmation deletes it', async () => {
    const monitor = await createMonitorViaBot('Cancel-Monitor');
    const confirmation = await requestRemoval(monitor);

    await clickRemoveButton(confirmation, 'rmx:', ADMIN_TG_ID);
    await waitForCall('editMessageText', (call) => /cancelled/i.test(callText(call)), {
      timeout: 10_000,
      label: 'deletion-cancelled message',
    });
    await sleep(500);
    expect(getMonitorByName('Cancel-Monitor')).toBeTruthy();

    // Clean up through the normal confirmation flow.
    const secondConfirmation = await requestRemoval(monitor);
    await clickRemoveButton(secondConfirmation, 'rm:', ADMIN_TG_ID);
    await waitForDb(
      () => (getMonitorByName('Cancel-Monitor') ? null : true),
      'monitor deleted by the second confirmation flow'
    );
  }, 40_000);

  it('handles ambiguous and injection-like monitor references without crashing', async () => {
    const first = await createMonitorViaBot('Ambiguous-Api-1');
    const second = await createMonitorViaBot('Ambiguous-Api-2');

    // Ambiguous substring → candidate list, never an exception.
    const ambiguousBaseline = await mockCallCount('sendMessage');
    await sendUserMessage('/info Ambiguous', ADMIN_TG_ID);
    const ambiguousReply = await waitForReply(ADMIN_TG_ID, /multiple monitors match/i, {
      baseline: ambiguousBaseline,
      label: 'ambiguous reference candidate list',
    });
    expect(callText(ambiguousReply)).toContain('Ambiguous-Api-1');
    expect(callText(ambiguousReply)).toContain('Ambiguous-Api-2');

    // SQL-injection-shaped reference is treated as a plain name (prepared statement).
    const hostileBaseline = await mockCallCount('sendMessage');
    await sendUserMessage("/info ' OR 1=1; DROP TABLE monitors;--", ADMIN_TG_ID);
    const hostileReply = await waitForReply(ADMIN_TG_ID, /(monitor not found|multiple monitors match)/i, {
      baseline: hostileBaseline,
      label: 'injection-like reference reply',
    });
    expect(callText(hostileReply)).toBeTruthy();
    // Table intact, both monitors still present, bot still alive.
    expect(getMonitorByName('Ambiguous-Api-1')).toBeTruthy();
    expect(getMonitorByName('Ambiguous-Api-2')).toBeTruthy();
    expect(getMonitors().length).toBeGreaterThanOrEqual(2);

    // Clean up both monitors through the confirmation flow.
    for (const monitor of [first, second]) {
      const confirmation = await requestRemoval(monitor);
      await clickRemoveButton(confirmation, 'rm:', ADMIN_TG_ID);
      await waitForDb(
        () => (getMonitorByName(monitor.name) ? null : true),
        `monitor ${monitor.name} deleted in cleanup`
      );
    }
  }, 60_000);

  it('handles multi-word monitor names across pause/resume/mute/unmute/edit/remove', async () => {
    // Create with a quoted multi-word name through the one-shot /add.
    await sendUserMessage(`/add http ${CLOSED_TARGET}/my-cool-api "My Cool API"`, ADMIN_TG_ID);
    const monitor = await waitForDb(
      () => getMonitorByName('My Cool API'),
      'monitor "My Cool API" created via /add'
    );

    // /pause + /resume resolve the unquoted multi-word name.
    await sendUserMessage('/pause My Cool API', ADMIN_TG_ID);
    await waitForDb(
      () => (Number(getMonitorByName('My Cool API')?.active) === 0 ? true : null),
      '/pause My Cool API set active=0'
    );
    await sendUserMessage('/resume My Cool API', ADMIN_TG_ID);
    await waitForDb(
      () => (Number(getMonitorByName('My Cool API')?.active) === 1 ? true : null),
      '/resume My Cool API set active=1'
    );

    // /mute My Cool API 1h — last token is the duration, the rest is the name.
    const muteBaseline = await mockCallCount('sendMessage');
    await sendUserMessage('/mute My Cool API 1h', ADMIN_TG_ID);
    await waitForReply(ADMIN_TG_ID, /muted/i, { baseline: muteBaseline, label: '/mute multi-word reply' });
    const mute = await waitForDb(
      () => dbGet('SELECT * FROM monitor_mutes WHERE monitor_id = ? ORDER BY id DESC LIMIT 1', monitor.id),
      'per-monitor mute for the multi-word monitor'
    );
    expect(Number(mute.monitor_id)).toBe(Number(monitor.id));

    // /unmute My Cool API removes it.
    await sendUserMessage('/unmute My Cool API', ADMIN_TG_ID);
    await waitForDb(
      () => (dbGet('SELECT * FROM monitor_mutes WHERE monitor_id = ?', monitor.id) ? null : true),
      'per-monitor mute removed by /unmute'
    );

    // /edit <multi-word name> <new target>.
    await sendUserMessage(`/edit My Cool API ${CLOSED_TARGET}/my-cool-api-v2`, ADMIN_TG_ID);
    await waitForDb(
      () => (getMonitorByName('My Cool API')?.target === `${CLOSED_TARGET}/my-cool-api-v2` ? true : null),
      '/edit multi-word monitor target updated'
    );

    // /remove <multi-word name> + confirmation callback.
    const confirmation = await requestRemoval(monitor);
    await clickRemoveButton(confirmation, 'rm:', ADMIN_TG_ID);
    await waitForDb(
      () => (getMonitorByName('My Cool API') ? null : true),
      'multi-word monitor deleted through the confirmation flow'
    );
    // /unmute all re-check with a clean table.
    await sendUserMessage('/unmute all', ADMIN_TG_ID);
    await waitForDb(
      () => (dbAll('SELECT * FROM monitor_mutes').length === 0 ? true : null),
      'no mutes remain after final /unmute all'
    );
  }, 60_000);

  // === REST API + Mini App security (same spawned server) ===

  let adminToken = '';

  it('REST: never returns or logs the bot token', async () => {
    const setupResponse = await fetch(`${serverBaseUrl}/api/v1/setup/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'qaadmin', password: 'qa-password-123' }),
    });
    expect(setupResponse.status).toBe(200);
    const setup = (await setupResponse.json()) as any;
    adminToken = setup.token;
    expect(adminToken).toBeTruthy();

    const configResponse = await fetch(`${serverBaseUrl}/api/v1/telegram/config`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(configResponse.status).toBe(200);
    const config = (await configResponse.json()) as any;

    expect(config.bot_token_set).toBe(true);
    expect(config.token_source).toBe('env');
    expect(config.bot_username).toBe(BOT_USERNAME);
    expect(config.api_base_url).toBe(mock.url);
    expect(JSON.stringify(config)).not.toContain(BOT_TOKEN);
    expect(config.bot_token_hint).toBeTruthy();
    expect(String(config.bot_token_hint)).not.toContain('TESTTOKEN');
    expect(serverLog).not.toContain(BOT_TOKEN);
  }, 30_000);

  it('REST: rejects changing an env-managed token and unauthenticated access', async () => {
    const anonymous = await fetch(`${serverBaseUrl}/api/v1/telegram/config`);
    expect(anonymous.status).toBe(401);

    const response = await fetch(`${serverBaseUrl}/api/v1/telegram/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ bot_token: '987654321:NEWTOKENNEWTOKENNEWTOKEN' }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as any;
    expect(String(body.error)).toMatch(/environment/i);
  }, 30_000);

  it('REST: lists the allow list and can allow/deny a user', async () => {
    const usersResponse = await fetch(`${serverBaseUrl}/api/v1/telegram/users`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(usersResponse.status).toBe(200);
    const users = (await usersResponse.json()) as any[];
    const admin = users.find((user) => user.telegram_user_id === ADMIN_TG_ID);
    expect(admin?.is_allowed).toBe(true);

    const allowResponse = await fetch(`${serverBaseUrl}/api/v1/telegram/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ telegram_user_id: 777, username: 'qa_pending' }),
    });
    expect(allowResponse.status).toBe(200);
    const allowed = (await allowResponse.json()) as any;
    expect(allowed.is_allowed).toBe(true);

    const denyResponse = await fetch(`${serverBaseUrl}/api/v1/telegram/users/777`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(denyResponse.status).toBe(200);
    const denied = (await denyResponse.json()) as any;
    expect(denied.user.is_allowed).toBe(false);
  }, 30_000);

  it('REST: sends a test message with the instance bot', async () => {
    const baseline = await mockCallCount('sendMessage');
    const response = await fetch(`${serverBaseUrl}/api/v1/telegram/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ chat_id: ADMIN_TG_ID }),
    });
    expect(response.status).toBe(200);

    const call = await waitForCall(
      'sendMessage',
      (candidate) => callChatId(candidate) === ADMIN_TG_ID && /test message/i.test(callText(candidate)),
      { baseline, label: 'test message sent by POST /telegram/test' }
    );
    expect(call.token).toBe(BOT_TOKEN);
  }, 30_000);

  it('REST: restarts the bot and keeps polling', async () => {
    const getMeBaseline = await mockCallCount('getMe');
    const response = await fetch(`${serverBaseUrl}/api/v1/telegram/restart`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(response.status).toBe(200);
    const status = (await response.json()) as any;
    expect(status.running).toBe(true);
    expect(status.bot_username).toBe(BOT_USERNAME);
    await waitForCall('getMe', () => true, {
      baseline: getMeBaseline,
      timeout: 20_000,
      label: 'getMe after bot restart',
    });
  }, 40_000);

  it('Mini App: a valid signed initData returns a working JWT', async () => {
    const initData = signInitData(adminTelegramUser);
    const response = await fetch(`${serverBaseUrl}/api/v1/telegram/webapp/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ init_data: initData }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.token).toBeTruthy();
    expect(body.telegram_user).toMatchObject({ id: ADMIN_TG_ID });
    expect(body.user.username).toMatch(/^tg_42/);
    expect(body.user.role).toBe('admin');

    // The issued JWT is a working session token for the normal API.
    const configResponse = await fetch(`${serverBaseUrl}/api/v1/telegram/config`, {
      headers: { Authorization: `Bearer ${body.token}` },
    });
    expect(configResponse.status).toBe(200);
  }, 30_000);

  it('Mini App: rejects malformed initData with 400', async () => {
    // Missing init_data entirely.
    const missing = await fetch(`${serverBaseUrl}/api/v1/telegram/webapp/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(400);

    // Malformed payloads are client errors (400): no hash, garbage, empty hash.
    // (A well-formed payload with a wrong hash is a 401 "invalid signature".)
    for (const initData of [
      'auth_date=1700000000&user=%7B%22id%22%3A42%7D',
      'not-a-query-string',
      'hash=&auth_date=1700000000',
    ]) {
      const response = await fetch(`${serverBaseUrl}/api/v1/telegram/webapp/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ init_data: initData }),
      });
      expect(response.status, `init_data=${initData}`).toBe(400);
    }
  }, 30_000);

  it('Mini App: rejects a tampered signature', async () => {
    const params = new URLSearchParams(signInitData(adminTelegramUser));
    params.set('hash', 'f'.repeat(64));
    const response = await fetch(`${serverBaseUrl}/api/v1/telegram/webapp/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ init_data: params.toString() }),
    });
    expect(response.status).toBe(401);
  }, 30_000);

  it('Mini App: rejects stale/future auth_date and disallowed users', async () => {
    const stale = signInitData(adminTelegramUser, BOT_TOKEN, Math.floor(Date.now() / 1000) - 90_000);
    const staleResponse = await fetch(`${serverBaseUrl}/api/v1/telegram/webapp/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ init_data: stale }),
    });
    expect(staleResponse.status).toBe(401);
    expect(String(((await staleResponse.json()) as any).error)).toMatch(/expired/i);

    const future = signInitData(adminTelegramUser, BOT_TOKEN, Math.floor(Date.now() / 1000) + 3_600);
    const futureResponse = await fetch(`${serverBaseUrl}/api/v1/telegram/webapp/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ init_data: future }),
    });
    expect(futureResponse.status).toBe(401);
    expect(String(((await futureResponse.json()) as any).error)).toMatch(/future/i);

    // User 99 is tracked but not allowed → 403, even with a valid signature.
    const notAllowed = signInitData({ id: UNKNOWN_TG_ID, first_name: 'Nope', username: 'nope' });
    const forbiddenResponse = await fetch(`${serverBaseUrl}/api/v1/telegram/webapp/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ init_data: notAllowed }),
    });
    expect(forbiddenResponse.status).toBe(403);
  }, 30_000);

  it('Mini App: a shadow user cannot password-login', async () => {
    const response = await fetch(`${serverBaseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'tg_42', password: 'anything' }),
    });
    expect(response.status).toBe(401);
  }, 30_000);

  it('Mini App: webapp auth endpoint is rate limited', async () => {
    let sawTooManyRequests = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await fetch(`${serverBaseUrl}/api/v1/telegram/webapp/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ init_data: 'auth_date=0' }),
      });
      if (response.status === 429) {
        sawTooManyRequests = true;
        break;
      }
    }
    expect(sawTooManyRequests, 'expected HTTP 429 after exceeding the webapp auth rate limit').toBe(true);
  }, 60_000);

  it('never writes the bot token to the server log', async () => {
    expect(serverLog).not.toContain(BOT_TOKEN);
    // Also ensure the token is not present in the config-related log lines.
    expect(serverLog).not.toMatch(/bot\d{5,}:[A-Za-z0-9_-]{20,}/);
  }, 10_000);
});
