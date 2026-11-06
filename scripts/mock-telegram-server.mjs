#!/usr/bin/env node
/**
 * Mock Telegram Bot API server for Uptime Detective E2E tests.
 *
 * Implements just enough of the Bot API for the instance-wide bot runtime:
 *   POST /bot<token>/<method>   — fake Bot API endpoint (all methods below)
 *   GET  /__mock/health         — liveness probe
 *   GET  /__mock/calls          — recorded calls, `?method=<name>` filter
 *   GET  /__mock/state          — calls + queued updates + counters
 *   POST /__mock/calls/clear    — clear recorded calls
 *   POST /__mock/updates        — enqueue update object / array / { updates: [] }
 *   POST /__mock/reset          — clear calls and queued updates
 *
 * No dependencies: plain `node:http`. Two ways to use it:
 *   1. In-process: `const mock = await startMockTelegramServer(); mock.url`
 *   2. Standalone: `node scripts/mock-telegram-server.mjs` (prints
 *      `MOCK_TELEGRAM_URL=http://127.0.0.1:<port>` on stdout, honours MOCK_PORT).
 *
 * Bot API behaviour modelled after the real service:
 *  - `getUpdates` long-polls: it holds the HTTP request until an update is
 *    queued or `timeout` seconds pass (capped at 50s). Updates are only
 *    confirmed (dropped) when a later call passes a higher `offset`.
 *  - `sendMessage` / `editMessageText` return a synthetic message with a
 *    monotonically increasing `message_id` and an echo of `chat`/`text`.
 *  - Every call is recorded in memory (method, token, params, result) so
 *    tests can assert on the exact Bot API traffic.
 *
 * The test file that consumes this lives at
 * `server/tests/integration/telegram-bot-e2e.test.ts`.
 */
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

export const MOCK_BOT_IDENTITY = {
  id: 123456789,
  is_bot: true,
  first_name: 'Uptime Detective (mock)',
  username: 'uptime_detective_mock_bot',
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
};

/** Methods whose `result` is simply `true`. */
const BOOLEAN_METHODS = new Set([
  'deleteWebhook',
  'setWebhook',
  'setMyCommands',
  'deleteMyCommands',
  'setChatMenuButton',
  'answerCallbackQuery',
  'deleteMessage',
  'sendChatAction',
]);

const MAX_LONG_POLL_SECONDS = 50;

function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readJsonBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(new Error(`invalid JSON body: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

function syntheticChat(chatId) {
  const numeric = Number(chatId);
  if (Number.isFinite(numeric) && String(numeric) === String(chatId)) {
    return { id: numeric, type: 'private', first_name: 'Test User', username: 'test_user' };
  }
  return { id: 0, type: 'private', username: String(chatId) };
}

/**
 * Create (but do not start) a mock Bot API server instance.
 * Call `listen()` before use. Prefer `startMockTelegramServer()`.
 */
export function createMockTelegramServer(options = {}) {
  const calls = [];
  /** Updates waiting to be delivered. */
  let queuedUpdates = [];
  let nextUpdateId = options.startUpdateId ?? 1000;
  let nextMessageId = options.startMessageId ?? 500;
  let closed = false;

  /** What getMe returns. Override for token-validation tests. */
  const botIdentity = { ...MOCK_BOT_IDENTITY, ...(options.botIdentity ?? {}) };
  /** Tokens the mock rejects with 401 (simulates invalid candidate token). */
  const rejectedTokens = new Set(options.rejectedTokens ?? []);
  /** When set, every Bot API call fails with this error (rate-limit tests). */
  let forcedError = null;

  const changeWaiters = new Set();
  function notifyChange() {
    for (const waiter of [...changeWaiters]) {
      changeWaiters.delete(waiter);
      waiter();
    }
  }
  function waitForChange(timeoutMs) {
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        changeWaiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, Math.max(0, timeoutMs));
      changeWaiters.add(finish);
    });
  }

  function recordCall(method, token, params) {
    const record = {
      method,
      token,
      params,
      at: new Date().toISOString(),
      result: undefined,
      error: undefined,
    };
    calls.push(record);
    notifyChange();
    return record;
  }

  function confirmUpdates(offset) {
    if (typeof offset === 'number' && Number.isFinite(offset) && offset > 0) {
      queuedUpdates = queuedUpdates.filter((update) => update.update_id >= offset);
    }
  }

  function matchingUpdates(offset, limit) {
    const from = typeof offset === 'number' && Number.isFinite(offset) && offset > 0 ? offset : -Infinity;
    return queuedUpdates.filter((update) => update.update_id >= from).slice(0, limit);
  }

  function addUpdate(update, assignedIds = []) {
    if (!update || typeof update !== 'object') {
      throw new Error('update must be an object');
    }
    const next = { ...update };
    if (typeof next.update_id !== 'number') {
      next.update_id = nextUpdateId++;
    } else if (next.update_id >= nextUpdateId) {
      nextUpdateId = next.update_id + 1;
    }
    queuedUpdates.push(next);
    assignedIds.push(next.update_id);
    notifyChange();
    return next;
  }

  function addUpdates(body) {
    const assignedIds = [];
    const input = Array.isArray(body) ? body : Array.isArray(body?.updates) ? body.updates : [body];
    const added = input.map((update) => addUpdate(update, assignedIds));
    return { updates: added, update_ids: assignedIds };
  }

  function newMessage(chatId, text, extra = {}) {
    const messageId = nextMessageId++;
    const chat = syntheticChat(chatId);
    return {
      message_id: messageId,
      from: { id: botIdentity.id, is_bot: true, first_name: botIdentity.first_name, username: botIdentity.username },
      chat,
      date: Math.floor(Date.now() / 1000),
      text,
      ...extra,
    };
  }

  async function handleBotApi(method, token, params, res) {
    const record = recordCall(method, token, params);

    if (forcedError) {
      record.error = forcedError;
      writeJson(res, forcedError.error_code ?? 400, {
        ok: false,
        error_code: forcedError.error_code ?? 400,
        description: forcedError.description ?? 'Forced mock error',
        ...(forcedError.parameters ? { parameters: forcedError.parameters } : {}),
      });
      return;
    }

    if (rejectedTokens.has(token)) {
      record.error = { error_code: 401, description: 'Unauthorized' };
      writeJson(res, 401, { ok: false, error_code: 401, description: 'Unauthorized' });
      return;
    }

    switch (method) {
      case 'getMe': {
        record.result = { ...botIdentity };
        writeJson(res, 200, { ok: true, result: record.result });
        return;
      }

      case 'getUpdates': {
        let offset = Number(params?.offset ?? 0);
        if (!Number.isFinite(offset)) offset = 0;
        const limit = Math.max(1, Math.min(Number(params?.limit ?? 100) || 100, 100));
        const timeoutSeconds = Math.max(0, Math.min(Number(params?.timeout ?? 0) || 0, MAX_LONG_POLL_SECONDS));
        const deadline = Date.now() + timeoutSeconds * 1000;

        // A higher offset confirms (drops) previously delivered updates.
        confirmUpdates(offset);

        let updates = matchingUpdates(offset, limit);
        while (updates.length === 0 && !closed && !res.writableEnded && Date.now() < deadline) {
          await waitForChange(Math.min(250, Math.max(0, deadline - Date.now())));
          if (res.writableEnded) break;
          updates = matchingUpdates(offset, limit);
        }

        record.result = updates;
        if (!res.writableEnded) writeJson(res, 200, { ok: true, result: updates });
        return;
      }

      case 'sendMessage':
      case 'editMessageText': {
        const chatId = params?.chat_id ?? params?.inline_message_id ?? 0;
        record.result = newMessage(chatId, params?.text ?? '', {
          ...(params?.parse_mode ? {} : {}),
        });
        writeJson(res, 200, { ok: true, result: record.result });
        return;
      }

      default: {
        if (BOOLEAN_METHODS.has(method)) {
          record.result = true;
          writeJson(res, 200, { ok: true, result: true });
          return;
        }
        record.error = { error_code: 404, description: `Not Found: ${method}` };
        writeJson(res, 404, { ok: false, error_code: 404, description: `Not Found: ${method}` });
      }
    }
  }

  function getCalls(method, token) {
    return calls.filter(
      (call) => (method === undefined || call.method === method) && (token === undefined || call.token === token)
    );
  }

  async function waitUntil(predicate, timeoutMs = 10_000, label = 'condition') {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = predicate();
      if (value) return value;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
      }
      await waitForChange(Math.min(100, Math.max(0, deadline - Date.now())));
    }
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname;

      // === Control endpoints (test-only) ===
      if (path === '/__mock/health' && req.method === 'GET') {
        writeJson(res, 200, { ok: true });
        return;
      }

      if (path === '/__mock/calls' && req.method === 'GET') {
        const method = url.searchParams.get('method') ?? undefined;
        const token = url.searchParams.get('token') ?? undefined;
        writeJson(res, 200, { ok: true, calls: getCalls(method, token) });
        return;
      }

      if (path === '/__mock/calls/clear' && req.method === 'POST') {
        calls.length = 0;
        writeJson(res, 200, { ok: true });
        return;
      }

      if (path === '/__mock/state' && req.method === 'GET') {
        writeJson(res, 200, {
          ok: true,
          calls,
          queued_updates: queuedUpdates,
          next_update_id: nextUpdateId,
          next_message_id: nextMessageId,
          getMe_called: calls.some((call) => call.method === 'getMe'),
        });
        return;
      }

      if (path === '/__mock/updates' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const added = addUpdates(body);
        writeJson(res, 200, { ok: true, ...added });
        return;
      }

      if (path === '/__mock/reset' && req.method === 'POST') {
        calls.length = 0;
        queuedUpdates = [];
        forcedError = null;
        writeJson(res, 200, { ok: true });
        return;
      }

      // Test hook: force the next Bot API calls to fail (429 / 500 backoff tests).
      if (path === '/__mock/force-error' && req.method === 'POST') {
        forcedError = (await readJsonBody(req)) ?? null;
        if (!forcedError || Object.keys(forcedError).length === 0) forcedError = null;
        writeJson(res, 200, { ok: true, forced_error: forcedError });
        return;
      }

      // === Fake Bot API ===
      const botApiMatch = path.match(/^\/bot([^/]+)\/([A-Za-z0-9_]+)$/);
      if (botApiMatch && req.method === 'POST') {
        const [, token, method] = botApiMatch;
        const params = await readJsonBody(req);
        await handleBotApi(method, token, params, res);
        return;
      }

      writeJson(res, 404, { ok: false, error_code: 404, description: `Not Found: ${req.method} ${path}` });
    } catch (err) {
      if (!res.writableEnded) {
        writeJson(res, 500, { ok: false, error_code: 500, description: `Mock server error: ${err.message}` });
      }
    }
  });

  // Track sockets so close() can force-close in-flight long polls.
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  function listen(port = 0, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        const address = server.address();
        resolve({
          port: address.port,
          host,
          url: `http://${host}:${address.port}`,
        });
      });
    });
  }

  function close() {
    closed = true;
    notifyChange();
    return new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
      // Safety net: never hang test teardown.
      setTimeout(resolve, 1000).unref?.();
    });
  }

  return {
    server,
    listen,
    close,
    // in-process helpers
    getCalls,
    addUpdate,
    addUpdates,
    waitUntil,
    clearCalls: () => {
      calls.length = 0;
    },
    reset: () => {
      calls.length = 0;
      queuedUpdates = [];
      forcedError = null;
    },
    setForcedError: (error) => {
      forcedError = error;
    },
    getQueuedUpdates: () => [...queuedUpdates],
    getBotIdentity: () => ({ ...botIdentity }),
  };
}

/** Create, start and return a mock Bot API server bound to 127.0.0.1:<port>. */
export async function startMockTelegramServer(options = {}) {
  const mock = createMockTelegramServer(options);
  const address = await mock.listen(options.port ?? 0, options.host ?? '127.0.0.1');
  return {
    ...mock,
    port: address.port,
    host: address.host,
    url: address.url,
    apiBaseUrl: address.url,
  };
}

const isDirectRun = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;

if (isDirectRun) {
  const port = Number(process.env.MOCK_PORT ?? 0) || 0;
  const mock = await startMockTelegramServer({ port });
  console.log(`MOCK_TELEGRAM_URL=${mock.url}`);
  console.log(`MOCK_TELEGRAM_BOT_TOKEN=${process.env.MOCK_BOT_TOKEN ?? '123456789:TESTTOKEN'}`);
  const shutdown = async () => {
    await mock.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
