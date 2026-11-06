/**
 * Thin Telegram Bot API HTTP client (fetch based, no external dependencies).
 *
 * The client is intentionally credential-explicit: callers may pass a token
 * (used to validate a candidate token before saving it) or let it resolve the
 * configured instance bot token.
 */
import type { TelegramMessage, TelegramUpdate } from './types.js';
import { getTelegramConfig } from './config.js';

export class TelegramApiError extends Error {
  code: number;
  description: string;
  retry_after?: number;

  constructor(description: string, code = 0, retry_after?: number) {
    super(description);
    this.name = 'TelegramApiError';
    this.code = code;
    this.description = description;
    this.retry_after = retry_after;
  }
}

export interface TelegramApiOptions {
  token?: string;
  baseUrl?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface TelegramApiEnvelope<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

function resolveOptions(options: TelegramApiOptions = {}): { token: string; baseUrl: string } {
  const config = getTelegramConfig();
  const token = options.token ?? config.bot_token;
  if (!token) {
    throw new TelegramApiError('Telegram bot is not configured', 0);
  }
  const baseUrl = (options.baseUrl ?? config.api_base_url ?? 'https://api.telegram.org').replace(/\/+$/, '');
  return { token, baseUrl };
}

/**
 * Call an arbitrary Bot API method and return its `result`.
 */
export async function telegramApiCall<T>(
  method: string,
  params: Record<string, unknown> = {},
  options: TelegramApiOptions = {}
): Promise<T> {
  const { token, baseUrl } = resolveOptions(options);
  const signal = options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 12_000);
  const url = `${baseUrl}/bot${token}/${method}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal,
    });
  } catch (err: any) {
    if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
      throw new TelegramApiError(`Telegram API request timed out (${method})`);
    }
    throw new TelegramApiError(`Telegram API request failed (${method}): ${err?.message || 'network error'}`);
  }

  const body = (await response.json().catch(() => null)) as TelegramApiEnvelope<T> | null;

  if (!response.ok || !body?.ok) {
    throw new TelegramApiError(
      body?.description || `Telegram API error: HTTP ${response.status}`,
      body?.error_code ?? response.status,
      body?.parameters?.retry_after
    );
  }

  return body.result as T;
}

// === Common methods ===

export interface TelegramBotIdentity {
  id: number;
  is_bot: boolean;
  first_name: string;
  username: string;
}

export function getMe(options: TelegramApiOptions = {}): Promise<TelegramBotIdentity> {
  return telegramApiCall<TelegramBotIdentity>('getMe', {}, options);
}

export interface GetUpdatesOptions extends TelegramApiOptions {
  offset?: number;
  timeout?: number;
  limit?: number;
  allowed_updates?: string[];
}

export function getUpdates(options: GetUpdatesOptions = {}): Promise<TelegramUpdate[]> {
  const timeout = options.timeout ?? 25;
  return telegramApiCall<TelegramUpdate[]>(
    'getUpdates',
    {
      offset: options.offset,
      timeout,
      limit: options.limit,
      allowed_updates: options.allowed_updates,
    },
    { token: options.token, baseUrl: options.baseUrl, signal: options.signal, timeoutMs: (timeout + 15) * 1000 }
  );
}

export function deleteWebhook(options: TelegramApiOptions & { drop_pending_updates?: boolean } = {}): Promise<boolean> {
  return telegramApiCall<boolean>('deleteWebhook', { drop_pending_updates: options.drop_pending_updates }, options);
}

export function setMyCommands(
  commands: { command: string; description: string }[],
  options: TelegramApiOptions = {}
): Promise<boolean> {
  return telegramApiCall<boolean>('setMyCommands', { commands }, options);
}

export function setChatMenuButton(menuButton: unknown, options: TelegramApiOptions = {}): Promise<boolean> {
  return telegramApiCall<boolean>('setChatMenuButton', { menu_button: menuButton }, options);
}

export interface SendMessageParams {
  chat_id: number | string;
  text: string;
  parse_mode?: 'HTML' | 'MarkdownV2';
  reply_markup?: unknown;
  disable_web_page_preview?: boolean;
  disable_notification?: boolean;
  message_thread_id?: number;
}

export function sendMessage(params: SendMessageParams, options: TelegramApiOptions = {}): Promise<TelegramMessage> {
  return telegramApiCall<TelegramMessage>('sendMessage', params as unknown as Record<string, unknown>, options);
}

export interface EditMessageTextParams {
  chat_id?: number | string;
  message_id?: number;
  inline_message_id?: string;
  text: string;
  parse_mode?: 'HTML' | 'MarkdownV2';
  reply_markup?: unknown;
  disable_web_page_preview?: boolean;
}

export function editMessageText(
  params: EditMessageTextParams,
  options: TelegramApiOptions = {}
): Promise<TelegramMessage> {
  return telegramApiCall<TelegramMessage>('editMessageText', params as unknown as Record<string, unknown>, options);
}

export interface AnswerCallbackQueryParams {
  callback_query_id: string;
  text?: string;
  show_alert?: boolean;
  url?: string;
  cache_time?: number;
}

export function answerCallbackQuery(
  params: AnswerCallbackQueryParams,
  options: TelegramApiOptions = {}
): Promise<boolean> {
  return telegramApiCall<boolean>('answerCallbackQuery', params as unknown as Record<string, unknown>, options);
}

export function deleteMessage(
  params: { chat_id: number | string; message_id: number },
  options: TelegramApiOptions = {}
): Promise<boolean> {
  return telegramApiCall<boolean>('deleteMessage', params, options);
}
