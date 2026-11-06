/**
 * Unit tests for the Telegram Bot API HTTP client (fetch is mocked).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const configState = vi.hoisted(() => ({
  enabled: true,
  bot_token: '123456789:TESTTOKEN' as string | null,
  bot_username: 'testbot' as string | null,
  webapp_url: null as string | null,
  api_base_url: 'https://api.test',
  token_source: 'settings' as const,
}));

vi.mock('../../src/services/telegram/config.js', () => ({
  getTelegramConfig: () => ({ ...configState }),
}));

import {
  TelegramApiError,
  answerCallbackQuery,
  deleteMessage,
  editMessageText,
  getMe,
  getUpdates,
  sendMessage,
  telegramApiCall,
} from '../../src/services/telegram/api.js';

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Telegram Bot API client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    configState.bot_token = '123456789:TESTTOKEN';
    configState.api_base_url = 'https://api.test';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls the configured API base with the configured token', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, result: { message_id: 7, chat: { id: 1, type: 'private' }, date: 0 } }));

    const message = await sendMessage({ chat_id: 1, text: 'hello' });

    expect(message.message_id).toBe(7);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.test/bot123456789:TESTTOKEN/sendMessage');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toMatchObject({ chat_id: 1, text: 'hello' });
  });

  it('allows overriding the token (candidate token validation)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, result: { id: 1, is_bot: true, first_name: 'Bot', username: 'candidate_bot' } }));

    const me = await getMe({ token: '999:CANDIDATE' });

    expect(me.username).toBe('candidate_bot');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.test/bot999:CANDIDATE/getMe');
  });

  it('throws TelegramApiError for API errors', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }, 400));

    await expect(sendMessage({ chat_id: 1, text: 'x' })).rejects.toMatchObject({
      name: 'TelegramApiError',
      code: 400,
      description: 'Bad Request: chat not found',
    });
  });

  it('exposes retry_after for rate limits', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 30 } }, 429)
    );

    const error = await sendMessage({ chat_id: 1, text: 'x' }).catch((err) => err);
    expect(error).toBeInstanceOf(TelegramApiError);
    expect(error.retry_after).toBe(30);
  });

  it('throws when no token is configured', async () => {
    configState.bot_token = null;
    await expect(telegramApiCall('getMe')).rejects.toThrow(/not configured/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends long-polling getUpdates with a long timeout', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, result: [] }));

    await getUpdates({ offset: 10, timeout: 25 });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/getUpdates');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ offset: 10, timeout: 25 });
    expect(init.signal).toBeDefined();
  });

  it('calls auxiliary methods', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ ok: true, result: true })));

    await answerCallbackQuery({ callback_query_id: 'cb', text: 'ok' });
    await deleteMessage({ chat_id: 1, message_id: 2 });
    await editMessageText({ chat_id: 1, message_id: 2, text: 'edited' });

    expect(fetchMock.mock.calls.map((call) => (call[0] as string).split('/').pop())).toEqual([
      'answerCallbackQuery',
      'deleteMessage',
      'editMessageText',
    ]);
  });
});
