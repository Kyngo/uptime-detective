/**
 * Self-test for the mock Telegram Bot API harness used by the E2E suite.
 *
 * Keeps the harness honest (path routing, long polling, call recording) and
 * verifies it can be imported from the server test project.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { startMockTelegramServer } from '../../../scripts/mock-telegram-server.mjs';

const TOKEN = '123456789:TESTTOKEN';

async function botApi(mockUrl: string, method: string, params: Record<string, unknown> = {}, token = TOKEN) {
  const response = await fetch(`${mockUrl}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  return response.json() as Promise<any>;
}

describe('mock Telegram Bot API server', () => {
  let mock: any;

  afterEach(async () => {
    await mock?.close();
  });

  it('answers getMe and records calls', async () => {
    mock = await startMockTelegramServer();

    const body = await botApi(mock.url, 'getMe');
    expect(body.ok).toBe(true);
    expect(body.result.username).toBe('uptime_detective_mock_bot');

    // Control endpoint exposes the recorded call including the token used.
    const callsResponse = await fetch(`${mock.url}/__mock/calls?method=getMe`);
    const { calls } = (await callsResponse.json()) as any;
    expect(calls).toHaveLength(1);
    expect(calls[0].token).toBe(TOKEN);
    expect(mock.getCalls('getMe')).toHaveLength(1);
  });

  it('delivers queued updates and honours the offset confirmation semantics', async () => {
    mock = await startMockTelegramServer();

    const enqueued = await mock.addUpdates({
      message: {
        message_id: 1,
        from: { id: 42, is_bot: false, first_name: 'A' },
        chat: { id: 42, type: 'private' },
        date: 1,
        text: '/start',
      },
    });
    expect(enqueued.update_ids).toHaveLength(1);

    const first = await botApi(mock.url, 'getUpdates', { offset: 0, timeout: 0 });
    expect(first.result).toHaveLength(1);
    expect(first.result[0].message.text).toBe('/start');

    // Same update is returned again until a higher offset confirms it.
    const again = await botApi(mock.url, 'getUpdates', { offset: 0, timeout: 0 });
    expect(again.result).toHaveLength(1);

    const confirmed = await botApi(mock.url, 'getUpdates', {
      offset: first.result[0].update_id + 1,
      timeout: 0,
    });
    expect(confirmed.result).toHaveLength(0);
    expect(mock.getQueuedUpdates()).toHaveLength(0);
  });

  it('long-polls until an update is enqueued or the timeout expires', async () => {
    mock = await startMockTelegramServer();

    const startedAt = Date.now();
    const poll = botApi(mock.url, 'getUpdates', { offset: 0, timeout: 5 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await mock.addUpdate({
      message: {
        message_id: 2,
        from: { id: 42, is_bot: false, first_name: 'A' },
        chat: { id: 42, type: 'private' },
        date: 1,
        text: '/status',
      },
    });

    const body = await poll;
    expect(body.result).toHaveLength(1);
    expect(Date.now() - startedAt).toBeLessThan(3000);
  });

  it('returns synthetic messages for sendMessage and editMessageText', async () => {
    mock = await startMockTelegramServer();

    const sent = await botApi(mock.url, 'sendMessage', { chat_id: 42, text: 'hello' });
    expect(sent.ok).toBe(true);
    expect(sent.result.message_id).toBeGreaterThan(0);
    expect(sent.result.chat.id).toBe(42);
    expect(sent.result.text).toBe('hello');

    const edited = await botApi(mock.url, 'editMessageText', {
      chat_id: 42,
      message_id: sent.result.message_id,
      text: 'edited',
    });
    expect(edited.result.text).toBe('edited');
  });

  it('rejects unknown Bot API methods with a Telegram-style error', async () => {
    mock = await startMockTelegramServer();
    const response = await fetch(`${mock.url}/bot${TOKEN}/notAMethod`, { method: 'POST' });
    expect(response.status).toBe(404);
    const body = (await response.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.error_code).toBe(404);
  });

  it('control endpoint accepts an update through HTTP', async () => {
    mock = await startMockTelegramServer();
    const response = await fetch(`${mock.url}/__mock/updates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callback_query: {
          id: 'cb-1',
          from: { id: 42, is_bot: false, first_name: 'A' },
          chat_instance: 'ci',
          data: 'rm:1:nonce',
        },
      }),
    });
    const body = (await response.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.update_ids).toHaveLength(1);

    const stateResponse = await fetch(`${mock.url}/__mock/state`);
    const state = (await stateResponse.json()) as any;
    expect(state.queued_updates).toHaveLength(1);
  });
});
